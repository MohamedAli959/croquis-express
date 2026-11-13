"use strict";
/*
 * API de « Nous Deux », l'appli privée de Dali & Rahma.
 *
 * Accès protégé par un code secret (choisi à la première ouverture, stocké haché).
 * Le téléphone envoie le code dans l'en-tête « X-Code » et la personne dans « who ».
 *
 * Clés Redis (permanentes) :
 *   nd:auth          {salt, hash} du code secret
 *   nd:cfg           hash   réglages (devise)
 *   nd:notes         hash   id -> petit mot
 *   nd:moods         hash   personne -> humeur
 *   nd:dates         hash   id -> date importante
 *   nd:items         hash   id -> élément de liste
 *   nd:exps          hash   id -> dépense
 *   nd:qa            hash   "AAAA-MM-JJ:personne" -> réponse à la question du jour
 *   nd:fail:IP       compteur d'essais de code ratés (15 min)
 */
const crypto = require("crypto");
const { fail, db, hobj, send, readBody, sendError } = require("./_lib.js");

const PEOPLE = { dali: "Dali", rahma: "Rahma" };
const START = "2025-09-15";
const LISTS = ["courses", "films", "restos", "soirees", "voyages", "cadeaux"];
const CURRENCIES = ["€", "DT", "$", "£", "CHF", "MAD"];

const QUESTIONS = [
  "Quel est ton souvenir préféré de nous deux ?",
  "Qu'est-ce qui t'a plu chez moi la première fois ?",
  "Quel serait notre voyage de rêve ?",
  "Quelle petite habitude de l'autre te fait craquer ?",
  "Quelle chanson te fait penser à nous ?",
  "Si on partait demain en week-end, ce serait où ?",
  "Quel est le plus beau compliment qu'on t'ait fait ?",
  "Qu'est-ce qui te fait rire chez moi ?",
  "Quel plat aimerais-tu qu'on cuisine ensemble ?",
  "Quelle est ta journée parfaite avec moi ?",
  "Qu'est-ce que tu aimerais qu'on fasse plus souvent ?",
  "De quoi es-tu le/la plus fier·e cette année ?",
  "Quel film voudrais-tu revoir avec moi ?",
  "Quel est ton rêve le plus fou ?",
  "Qu'est-ce qui te rassure quand tu as une mauvaise journée ?",
  "Quel moment de notre histoire aimerais-tu revivre ?",
  "Où nous vois-tu dans 5 ans ?",
  "Quel surnom aimerais-tu que je te donne ?",
  "Quelle est la chose la plus romantique qu'on ait faite ?",
  "Quel petit geste de ma part te fait le plus plaisir ?",
  "Quel animal serais-je, selon toi ? Pourquoi ?",
  "Qu'est-ce que tu as appris grâce à moi ?",
  "Quel est ton plus beau souvenir d'enfance ?",
  "Quelle activité aimerais-tu qu'on essaie ensemble ?",
  "Quel est le meilleur repas qu'on ait partagé ?",
  "Qu'est-ce qui te stresse en ce moment ? Comment puis-je t'aider ?",
  "Quelle est ta façon préférée de recevoir de l'amour ?",
  "Quel est ton endroit préféré où on est allés ensemble ?",
  "Si tu pouvais me faire découvrir une chose, ce serait quoi ?",
  "Quelle tradition aimerais-tu qu'on crée à deux ?",
  "Quel est le plus beau cadeau que tu aies reçu ?",
  "Qu'est-ce qui te rend heureux/heureuse en ce moment ?",
  "Quel est ton talent caché ?",
  "Quelle est la chose la plus folle que tu aimerais faire avec moi ?",
  "Raconte-moi un rêve que tu as fait récemment.",
  "Quel pays aimerais-tu absolument visiter avec moi ?",
  "Qu'est-ce que tu préfères dans nos soirées à deux ?",
  "Quelle qualité admires-tu le plus chez moi ?",
  "Quel est ton plus gros fou rire avec moi ?",
  "Quelle serait la maison de nos rêves ?",
  "Qu'est-ce qui t'a surpris·e chez moi en apprenant à me connaître ?",
  "Quel est le moment où tu t'es dit « c'est elle / c'est lui » ?",
  "Si on écrivait un livre sur nous, quel serait son titre ?",
  "Quel petit plaisir simple te rend heureux/heureuse ?",
  "Qu'aimerais-tu qu'on accomplisse ensemble cette année ?",
  "Quel est ton dessert préféré ?",
  "Qu'est-ce qui te manque le plus quand on n'est pas ensemble ?",
  "Quel est ton plus grand défi en ce moment ?",
  "Quelle est la plus belle déclaration que tu voudrais entendre ?",
  "Si on avait une journée sans téléphone, on ferait quoi ?",
  "Quel est le meilleur conseil qu'on t'ait donné ?",
  "Quelle odeur te fait penser à moi ?",
  "Quel serait notre rendez-vous idéal ?",
  "Qu'est-ce que tu aimerais apprendre cette année ?",
  "Quelle est la chose que tu n'oses pas me demander ?",
  "Qu'est-ce qui te fait te sentir aimé·e ?",
  "Quel est le plus beau paysage que tu aies vu ?",
  "Quelle chanson mettrais-tu pour notre première danse ?",
  "Quel souvenir de nous te fait sourire à chaque fois ?",
  "Qu'est-ce que tu voudrais me dire aujourd'hui ?",
];

/* ================= Outils ================= */
const K = {
  auth: "nd:auth", cfg: "nd:cfg", notes: "nd:notes", moods: "nd:moods", dates: "nd:dates",
  items: "nd:items", exps: "nd:exps", qa: "nd:qa", fail: ip => `nd:fail:${ip}`,
};
const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
const txt = (s, max) => String(s || "").trim().replace(/\s+/g, " ").slice(0, max);
const isDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d || "") && !isNaN(Date.parse(d));
const hashCode = (salt, code) => crypto.createHash("sha256").update(salt + ":" + String(code).trim().toLowerCase()).digest("hex");
const ipOf = req => String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "local").split(",")[0].trim().slice(0, 64);
const parseHash = h => Object.values(hobj(h)).map(v => { try { return JSON.parse(v); } catch (e) { return null; } }).filter(Boolean);

function questionFor(day) {
  const n = Math.floor((Date.parse(day) - Date.parse(START)) / 86400000);
  return QUESTIONS[((n % QUESTIONS.length) + QUESTIONS.length) % QUESTIONS.length];
}

/* ================= Lecture de toutes les données ================= */
async function loadAll(req, code) {
  const [auth, fails, cfg, notes, moods, dates, items, exps, qa] = await db([
    ["GET", K.auth], ["GET", K.fail(ipOf(req))],
    ["HGETALL", K.cfg], ["HGETALL", K.notes], ["HGETALL", K.moods], ["HGETALL", K.dates],
    ["HGETALL", K.items], ["HGETALL", K.exps], ["HGETALL", K.qa],
  ]);
  if (!auth) fail(409, "SETUP");
  if (Number(fails) >= 10) fail(429, "Trop d'essais ratés. Réessaie dans 15 minutes.");
  const a = JSON.parse(auth);
  const h = hashCode(a.salt, code || "");
  if (!crypto.timingSafeEqual(Buffer.from(h), Buffer.from(a.hash))) {
    const [n] = await db([["INCR", K.fail(ipOf(req))]]);
    if (n === 1) await db([["EXPIRE", K.fail(ipOf(req)), 900]]);
    fail(401, "Code secret incorrect.");
  }
  return { cfg: hobj(cfg), notes: parseHash(notes), moods: hobj(moods), dates: parseHash(dates), items: parseHash(items), exps: parseHash(exps), qa: hobj(qa) };
}

function view(d, who, day) {
  const other = who === "dali" ? "rahma" : "dali";
  const moods = {};
  for (const p in PEOPLE) if (d.moods[p]) moods[p] = JSON.parse(d.moods[p]);
  // Question du jour : la réponse de l'autre n'est visible qu'après avoir répondu
  const mine = d.qa[`${day}:${who}`] || null;
  const theirs = d.qa[`${day}:${other}`] || null;
  const history = [];
  const days = new Set(Object.keys(d.qa).map(k => k.split(":")[0]));
  for (const dd of [...days].sort().reverse()) {
    if (dd === day) continue;
    if (d.qa[`${dd}:dali`] && d.qa[`${dd}:rahma`]) history.push({ day: dd, q: questionFor(dd), dali: d.qa[`${dd}:dali`], rahma: d.qa[`${dd}:rahma`] });
    if (history.length >= 30) break;
  }
  return {
    people: PEOPLE, start: START, lists: LISTS,
    currency: d.cfg.currency || "€",
    notes: d.notes.sort((a, b) => b.t - a.t).slice(0, 200),
    moods,
    dates: d.dates.sort((a, b) => a.date.localeCompare(b.date)),
    items: d.items.filter(i => i.list !== "cadeaux" || i.by === who).sort((a, b) => a.t - b.t), // idées cadeaux : secrètes
    exps: d.exps.sort((a, b) => b.t - a.t),
    qa: { day, question: questionFor(day), mine, theirs: mine ? theirs : null, theirAnswered: !!theirs, history },
    now: Date.now(),
  };
}

/* ================= Actions ================= */
const ACTIONS = {
  "note.add": async (b) => {
    const text = String(b.text || "").trim().slice(0, 1000);
    if (!text) fail(400, "Écris un petit mot.");
    const n = { id: newId(), from: b.who, text, t: Date.now(), read: false, heart: false };
    await db([["HSET", K.notes, n.id, JSON.stringify(n)]]);
  },
  "note.read": async (b, d) => {
    const cmds = d.notes.filter(n => n.from !== b.who && !n.read).map(n => ["HSET", K.notes, n.id, JSON.stringify({ ...n, read: true })]);
    if (cmds.length) await db(cmds);
  },
  "note.heart": async (b, d) => {
    const n = d.notes.find(x => x.id === b.id);
    if (n && n.from !== b.who) await db([["HSET", K.notes, n.id, JSON.stringify({ ...n, heart: !n.heart })]]);
  },
  "note.del": async (b, d) => {
    const n = d.notes.find(x => x.id === b.id);
    if (n && n.from === b.who) await db([["HDEL", K.notes, n.id]]);
  },

  "mood.set": async (b) => {
    const emoji = txt(b.emoji, 8);
    if (!emoji) fail(400, "Choisis une humeur.");
    await db([["HSET", K.moods, b.who, JSON.stringify({ emoji, text: txt(b.text, 80), t: Date.now() })]]);
  },

  "date.add": async (b) => {
    const title = txt(b.title, 60);
    if (!title || !isDay(b.date)) fail(400, "Donne un nom et une date.");
    const x = { id: newId(), title, date: b.date, yearly: b.yearly !== false, by: b.who, t: Date.now() };
    await db([["HSET", K.dates, x.id, JSON.stringify(x)]]);
  },
  "date.del": async (b) => { await db([["HDEL", K.dates, String(b.id)]]); },

  "item.add": async (b) => {
    const text = txt(b.text, 120);
    if (!text || !LISTS.includes(b.list)) fail(400, "Écris quelque chose.");
    const x = { id: newId(), list: b.list, text, done: false, by: b.who, t: Date.now() };
    await db([["HSET", K.items, x.id, JSON.stringify(x)]]);
  },
  "item.toggle": async (b, d) => {
    const x = d.items.find(i => i.id === b.id);
    if (x && (x.list !== "cadeaux" || x.by === b.who)) await db([["HSET", K.items, x.id, JSON.stringify({ ...x, done: !x.done })]]);
  },
  "item.del": async (b, d) => {
    const x = d.items.find(i => i.id === b.id);
    if (x && (x.list !== "cadeaux" || x.by === b.who)) await db([["HDEL", K.items, x.id]]);
  },
  "item.clear": async (b, d) => {
    const cmds = d.items.filter(i => i.list === b.list && i.done && (i.list !== "cadeaux" || i.by === b.who)).map(i => ["HDEL", K.items, i.id]);
    if (cmds.length) await db(cmds);
  },

  "exp.add": async (b) => {
    const title = txt(b.title, 60) || "Dépense";
    const amount = Math.round(Number(String(b.amount).replace(",", ".")) * 100) / 100;
    if (!(amount > 0 && amount < 1e6)) fail(400, "Montant invalide.");
    if (!PEOPLE[b.payer]) fail(400, "Qui a payé ?");
    if (!["half", "full"].includes(b.split)) fail(400, "Répartition invalide.");
    const x = { id: newId(), title, amount, payer: b.payer, split: b.split, settle: !!b.settle, by: b.who, t: Date.now() };
    await db([["HSET", K.exps, x.id, JSON.stringify(x)]]);
  },
  "exp.del": async (b) => { await db([["HDEL", K.exps, String(b.id)]]); },

  "qa.answer": async (b) => {
    if (!isDay(b.day)) fail(400, "Date invalide.");
    const text = String(b.text || "").trim().slice(0, 600);
    if (!text) fail(400, "Écris ta réponse.");
    await db([["HSET", K.qa, `${b.day}:${b.who}`, text]]);
  },

  "cfg.currency": async (b) => {
    if (!CURRENCIES.includes(b.currency)) fail(400, "Devise inconnue.");
    await db([["HSET", K.cfg, "currency", b.currency]]);
  },
};

/* ================= HTTP ================= */
module.exports = async function handler(req, res) {
  try {
    const q = Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
    const code = req.headers["x-code"];

    // L'appli a-t-elle déjà un code secret ?
    if (req.method === "GET" && q.status) {
      const [auth] = await db([["GET", K.auth]]);
      return send(res, 200, { configured: !!auth, people: PEOPLE });
    }

    const b = req.method === "POST" ? await readBody(req) : q;
    const who = b.who;
    const day = isDay(b.day) ? b.day : new Date().toISOString().slice(0, 10);

    // Première ouverture : on choisit le code secret
    if (req.method === "POST" && b.action === "setup") {
      const c = String(b.code || "").trim();
      if (c.length < 4) fail(400, "Le code doit faire au moins 4 caractères.");
      const salt = crypto.randomBytes(16).toString("hex");
      const [ok] = await db([["SET", K.auth, JSON.stringify({ salt, hash: hashCode(salt, c) }), "NX"]]);
      if (ok !== "OK") fail(409, "Le code secret a déjà été choisi.");
      return send(res, 200, { ok: true });
    }

    if (req.method !== "GET" && req.method !== "POST") fail(405, "Méthode non autorisée.");
    let d = await loadAll(req, code);
    if (!PEOPLE[who]) return send(res, 200, { ok: true, people: PEOPLE }); // code bon, personne pas encore choisie

    if (req.method === "POST") {
      const fn = ACTIONS[b.action];
      if (!fn) fail(400, "Action inconnue.");
      await fn(b, d);
      d = await loadAll(req, code);
    }
    return send(res, 200, view(d, who, day));
  } catch (e) {
    if (e.status === 409 && e.message === "SETUP") return send(res, 409, { error: "SETUP" });
    return sendError(res, e);
  }
};

module.exports.questionFor = questionFor;
