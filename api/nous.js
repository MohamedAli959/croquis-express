"use strict";
/*
 * API de « Nous Deux », l'appli privée de Dali & Rahma.
 *
 * Accès protégé par un code secret (choisi à la première ouverture, stocké haché).
 * Le téléphone envoie le code dans l'en-tête « X-Code » et la personne dans « who ».
 *
 * Clés Redis (permanentes) :
 *   nd:auth          {salt, hash} du code secret
 *   nd:vapid         clés VAPID pour les notifications push (générées automatiquement)
 *   nd:subs          hash   "personne:empreinte" -> abonnement push
 *   nd:cfg           hash   réglages (devise, date des retrouvailles)
 *   nd:tz            hash   personne -> fuseau horaire de son téléphone
 *   nd:notes         hash   id -> petit mot
 *   nd:moods         hash   personne -> humeur
 *   nd:dates         hash   id -> date importante
 *   nd:mem           hash   id -> souvenir (photo + légende)
 *   nd:mnotes        hash   id -> petit mot écrit sur un souvenir
 *   nd:photo:ID      photo JPEG (base64)      nd:thumb:ID   miniature
 *   nd:exps          hash   id -> dépense
 *   nd:qa            hash   "AAAA-MM-JJ:personne" -> réponse à la question du jour
 *   nd:fail:IP       compteur d'essais de code ratés (15 min)
 */
const crypto = require("crypto");
const { fail, db, hobj, send, readBody, sendError } = require("./_lib.js");
let webpush = null;
try { webpush = require("web-push"); } catch (e) { /* notifications désactivées si la bibliothèque manque */ }

const PEOPLE = { dali: "Dali", rahma: "Rahma" };
const START = "2025-09-15";
const CURRENCIES = ["€", "DT", "$", "£", "CHF", "MAD"];
const MAX_PHOTO = 950000, MAX_THUMB = 200000; // tailles max en base64

const QUESTIONS = [
  "Quel est ton souvenir préféré de nous deux ?",
  "Qu'est-ce qui t'a plu chez moi la première fois ?",
  "Quel serait notre voyage de rêve ?",
  "Quelle petite habitude de l'autre te fait craquer ?",
  "Quelle chanson te fait penser à nous ?",
  "Quand on se retrouvera, quelle est la première chose que tu veux faire ?",
  "Quel est le plus beau compliment qu'on t'ait fait ?",
  "Qu'est-ce qui te fait rire chez moi ?",
  "Quel plat aimerais-tu qu'on cuisine ensemble ?",
  "Quelle est ta journée parfaite avec moi ?",
  "Qu'est-ce qui t'aide le plus à supporter la distance ?",
  "De quoi es-tu le/la plus fier·e cette année ?",
  "Quel film voudrais-tu qu'on regarde en même temps, chacun de son côté ?",
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
  "Quel est le meilleur moment qu'on ait passé ensemble en vrai ?",
  "Qu'est-ce qui te stresse en ce moment ? Comment puis-je t'aider ?",
  "Quelle est ta façon préférée de recevoir de l'amour ?",
  "Quel est ton endroit préféré où on est allés ensemble ?",
  "Si tu pouvais me faire découvrir une chose, ce serait quoi ?",
  "Quelle tradition aimerais-tu qu'on crée à deux, même à distance ?",
  "Quel est le plus beau cadeau que tu aies reçu ?",
  "Qu'est-ce qui te rend heureux/heureuse en ce moment ?",
  "Quel est ton talent caché ?",
  "Quelle est la chose la plus folle que tu aimerais faire avec moi ?",
  "Raconte-moi un rêve que tu as fait récemment.",
  "Quel pays aimerais-tu absolument visiter avec moi ?",
  "Qu'est-ce que tu préfères dans nos appels ?",
  "Quelle qualité admires-tu le plus chez moi ?",
  "Quel est ton plus gros fou rire avec moi ?",
  "Quelle serait la maison de nos rêves ?",
  "Qu'est-ce qui t'a surpris·e chez moi en apprenant à me connaître ?",
  "Quel est le moment où tu t'es dit « c'est elle / c'est lui » ?",
  "Si on écrivait un livre sur nous, quel serait son titre ?",
  "Quel petit plaisir simple te rend heureux/heureuse ?",
  "Qu'aimerais-tu qu'on accomplisse ensemble cette année ?",
  "Qu'est-ce qui te manque le plus chez moi en ce moment ?",
  "Quel est ton plus grand défi en ce moment ?",
  "Quelle est la plus belle déclaration que tu voudrais entendre ?",
  "Comment imagines-tu le jour où on ne sera plus à distance ?",
  "Quel est le meilleur conseil qu'on t'ait donné ?",
  "Quelle odeur te fait penser à moi ?",
  "Quel serait notre rendez-vous idéal pour nos retrouvailles ?",
  "Qu'est-ce que tu aimerais apprendre cette année ?",
  "Quelle est la chose que tu n'oses pas me demander ?",
  "Qu'est-ce qui te fait te sentir aimé·e, même de loin ?",
  "Quel est le plus beau paysage que tu aies vu ?",
  "Quelle chanson mettrais-tu pour notre première danse ?",
  "Quel souvenir de nous te fait sourire à chaque fois ?",
  "Qu'est-ce que tu voudrais me dire aujourd'hui ?",
  "Quelle photo de nous préfères-tu, et pourquoi ?",
];

/* ================= Outils ================= */
const K = {
  auth: "nd:auth", vapid: "nd:vapid", subs: "nd:subs", cfg: "nd:cfg", tz: "nd:tz",
  notes: "nd:notes", moods: "nd:moods", dates: "nd:dates", mem: "nd:mem", mnotes: "nd:mnotes",
  photo: id => `nd:photo:${id}`, thumb: id => `nd:thumb:${id}`,
  exps: "nd:exps", qa: "nd:qa", fail: ip => `nd:fail:${ip}`,
};
const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
const txt = (s, max) => String(s || "").trim().replace(/\s+/g, " ").slice(0, max);
const longTxt = (s, max) => String(s || "").trim().slice(0, max);
const isDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d || "") && !isNaN(Date.parse(d));
const hashCode = (salt, code) => crypto.createHash("sha256").update(salt + ":" + String(code).trim().toLowerCase()).digest("hex");
const photoToken = (authHash, id) => crypto.createHash("sha256").update("photo:" + authHash + ":" + id).digest("hex").slice(0, 24);
const ipOf = req => String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "local").split(",")[0].trim().slice(0, 64);
const parseHash = h => Object.values(hobj(h)).map(v => { try { return JSON.parse(v); } catch (e) { return null; } }).filter(Boolean);
const otherOf = who => (who === "dali" ? "rahma" : "dali");
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function questionFor(day) {
  const n = Math.floor((Date.parse(day) - Date.parse(START)) / 86400000);
  return QUESTIONS[((n % QUESTIONS.length) + QUESTIONS.length) % QUESTIONS.length];
}

/* ================= Notifications push ================= */
async function vapidKeys() {
  const [v] = await db([["GET", K.vapid]]);
  if (v) return JSON.parse(v);
  const keys = webpush.generateVAPIDKeys();
  const [ok] = await db([["SET", K.vapid, JSON.stringify(keys), "NX"]]);
  if (ok === "OK") return keys;
  const [again] = await db([["GET", K.vapid]]);
  return JSON.parse(again);
}

async function notify(req, to, payload) {
  if (!webpush) return { sent: 0 };
  const [raw] = await db([["HGETALL", K.subs]]);
  const subs = Object.entries(hobj(raw)).filter(([k]) => k.startsWith(to + ":"));
  if (!subs.length) return { sent: 0 };
  const keys = await vapidKeys();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  const opts = { vapidDetails: { subject: `https://${host}`, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 86400, urgency: "high" };
  let sent = 0;
  const dead = [];
  await Promise.all(subs.map(async ([field, sub]) => {
    try { await webpush.sendNotification(JSON.parse(sub), JSON.stringify(payload), opts); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) dead.push(field); else console.error("push", e.statusCode, e.body || e.message); }
  }));
  if (dead.length) await db(dead.map(f => ["HDEL", K.subs, f]));
  return { sent };
}

/* ================= Lecture de toutes les données ================= */
async function loadAll(req, code) {
  const [auth, fails, cfg, tz, notes, moods, dates, mem, mnotes, exps, qa, subs] = await db([
    ["GET", K.auth], ["GET", K.fail(ipOf(req))],
    ["HGETALL", K.cfg], ["HGETALL", K.tz], ["HGETALL", K.notes], ["HGETALL", K.moods], ["HGETALL", K.dates],
    ["HGETALL", K.mem], ["HGETALL", K.mnotes], ["HGETALL", K.exps], ["HGETALL", K.qa], ["HGETALL", K.subs],
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
  return {
    authHash: a.hash, cfg: hobj(cfg), tz: hobj(tz), notes: parseHash(notes), moods: hobj(moods), dates: parseHash(dates),
    mem: parseHash(mem), mnotes: parseHash(mnotes), exps: parseHash(exps), qa: hobj(qa),
    subs: Object.keys(hobj(subs)),
  };
}

function view(d, who, day) {
  const other = otherOf(who);
  const moods = {};
  for (const p in PEOPLE) if (d.moods[p]) { try { moods[p] = JSON.parse(d.moods[p]); } catch (e) {} }
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
  const memories = d.mem
    .map(m => ({
      ...m,
      tk: photoToken(d.authHash, m.id),
      notes: d.mnotes.filter(n => n.mem === m.id).sort((a, b) => a.t - b.t),
    }))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.t - a.t);
  return {
    people: PEOPLE, start: START,
    currency: d.cfg.currency || "€",
    reunion: d.cfg.reunion || null,
    tz: d.tz,
    notes: d.notes.sort((a, b) => b.t - a.t).slice(0, 300),
    moods,
    dates: d.dates.sort((a, b) => a.date.localeCompare(b.date)),
    memories,
    exps: d.exps.sort((a, b) => b.t - a.t),
    qa: { day, question: questionFor(day), mine, theirs: mine ? theirs : null, theirAnswered: !!theirs, history },
    push: { available: !!webpush, mine: d.subs.filter(k => k.startsWith(who + ":")).length, theirs: d.subs.filter(k => k.startsWith(other + ":")).length },
    now: Date.now(),
  };
}

/* ================= Actions ================= */
const ACTIONS = {
  "note.add": async (b, d, req) => {
    const text = longTxt(b.text, 1000);
    if (!text) fail(400, "Écris un petit mot.");
    const n = { id: newId(), from: b.who, text, t: Date.now(), read: false, heart: false };
    await db([["HSET", K.notes, n.id, JSON.stringify(n)]]);
    return notify(req, otherOf(b.who), { title: `💌 ${PEOPLE[b.who]}`, body: short(text, 160), tag: "note-" + n.id, url: "/?tab=notes" });
  },
  "note.read": async (b, d) => {
    const cmds = d.notes.filter(n => n.from !== b.who && !n.read).map(n => ["HSET", K.notes, n.id, JSON.stringify({ ...n, read: true })]);
    if (cmds.length) await db(cmds);
  },
  "note.heart": async (b, d, req) => {
    const n = d.notes.find(x => x.id === b.id);
    if (!n || n.from === b.who) return;
    await db([["HSET", K.notes, n.id, JSON.stringify({ ...n, heart: !n.heart })]]);
    if (!n.heart) return notify(req, n.from, { title: `❤️ ${PEOPLE[b.who]} a adoré ton mot`, body: short(n.text, 120), tag: "heart-" + n.id, url: "/?tab=notes" });
  },
  "note.del": async (b, d) => {
    const n = d.notes.find(x => x.id === b.id);
    if (n && n.from === b.who) await db([["HDEL", K.notes, n.id]]);
  },

  "mood.set": async (b, d, req) => {
    const emoji = txt(b.emoji, 8), label = txt(b.label, 40), text = txt(b.text, 120);
    if (!emoji) fail(400, "Choisis une humeur.");
    await db([["HSET", K.moods, b.who, JSON.stringify({ emoji, label, text, t: Date.now() })]]);
    return notify(req, otherOf(b.who), {
      title: `${emoji} ${PEOPLE[b.who]}${label ? " · " + label : ""}`,
      body: text || "Nouvelle humeur partagée",
      tag: "mood-" + b.who, url: "/",
    });
  },

  "date.add": async (b) => {
    const title = txt(b.title, 60);
    if (!title || !isDay(b.date)) fail(400, "Donne un nom et une date.");
    const x = { id: newId(), title, date: b.date, yearly: b.yearly !== false, by: b.who, t: Date.now() };
    await db([["HSET", K.dates, x.id, JSON.stringify(x)]]);
  },
  "date.del": async (b) => { await db([["HDEL", K.dates, String(b.id)]]); },

  "reunion.set": async (b, d, req) => {
    if (b.date && !isDay(b.date)) fail(400, "Date invalide.");
    await db([b.date ? ["HSET", K.cfg, "reunion", b.date] : ["HDEL", K.cfg, "reunion"]]);
    if (b.date) return notify(req, otherOf(b.who), { title: "✈️ Date des retrouvailles", body: `${PEOPLE[b.who]} a noté nos retrouvailles le ${b.date.split("-").reverse().join("/")}`, tag: "reunion", url: "/" });
  },

  "mem.add": async (b, d, req) => {
    const photo = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.photo || ""));
    const thumb = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.thumb || ""));
    if (!photo || !thumb) fail(400, "Photo invalide.");
    if (photo[1].length > MAX_PHOTO || thumb[1].length > MAX_THUMB) fail(413, "Photo trop lourde.");
    const m = { id: newId(), by: b.who, caption: longTxt(b.caption, 300), date: isDay(b.date) ? b.date : new Date().toISOString().slice(0, 10), w: +b.w || 0, h: +b.h || 0, t: Date.now() };
    await db([["SET", K.photo(m.id), photo[1]]]);
    await db([["SET", K.thumb(m.id), thumb[1]]]);
    await db([["HSET", K.mem, m.id, JSON.stringify(m)]]);
    return notify(req, otherOf(b.who), { title: `📸 ${PEOPLE[b.who]} a ajouté un souvenir`, body: m.caption || "Viens voir 💕", tag: "mem-" + m.id, url: "/?tab=memories&m=" + m.id });
  },
  "mem.caption": async (b, d) => {
    const m = d.mem.find(x => x.id === b.id);
    if (m) await db([["HSET", K.mem, m.id, JSON.stringify({ ...m, caption: longTxt(b.caption, 300) })]]);
  },
  "mem.del": async (b, d) => {
    const m = d.mem.find(x => x.id === b.id);
    if (!m) return;
    const notes = d.mnotes.filter(n => n.mem === m.id).map(n => ["HDEL", K.mnotes, n.id]);
    await db([["HDEL", K.mem, m.id], ["DEL", K.photo(m.id)], ["DEL", K.thumb(m.id)], ...notes]);
  },
  "mem.note": async (b, d, req) => {
    const m = d.mem.find(x => x.id === b.mem);
    const text = longTxt(b.text, 500);
    if (!m) fail(404, "Souvenir introuvable.");
    if (!text) fail(400, "Écris un petit mot.");
    const n = { id: newId(), mem: m.id, by: b.who, text, t: Date.now() };
    await db([["HSET", K.mnotes, n.id, JSON.stringify(n)]]);
    return notify(req, otherOf(b.who), { title: `💬 ${PEOPLE[b.who]} a écrit sur un souvenir`, body: short(text, 160), tag: "mnote-" + m.id, url: "/?tab=memories&m=" + m.id });
  },
  "mem.notedel": async (b, d) => {
    const n = d.mnotes.find(x => x.id === b.id);
    if (n && n.by === b.who) await db([["HDEL", K.mnotes, n.id]]);
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

  "qa.answer": async (b, d, req) => {
    if (!isDay(b.day)) fail(400, "Date invalide.");
    const text = longTxt(b.text, 600);
    if (!text) fail(400, "Écris ta réponse.");
    const first = !d.qa[`${b.day}:${b.who}`];
    await db([["HSET", K.qa, `${b.day}:${b.who}`, text]]);
    if (first) return notify(req, otherOf(b.who), { title: `❓ ${PEOPLE[b.who]} a répondu à la question du jour`, body: "Réponds à ton tour pour découvrir sa réponse 👀", tag: "qa-" + b.day, url: "/?tab=question" });
  },

  "cfg.currency": async (b) => {
    if (!CURRENCIES.includes(b.currency)) fail(400, "Devise inconnue.");
    await db([["HSET", K.cfg, "currency", b.currency]]);
  },

  "push.sub": async (b) => {
    const s = b.sub || {};
    if (typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) fail(400, "Abonnement invalide.");
    const fp = crypto.createHash("sha256").update(s.endpoint).digest("hex").slice(0, 16);
    // un même téléphone ne doit être abonné que pour une personne
    const other = otherOf(b.who);
    await db([["HDEL", K.subs, `${other}:${fp}`], ["HSET", K.subs, `${b.who}:${fp}`, JSON.stringify({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } })]]);
  },
  "push.unsub": async (b) => {
    if (typeof b.endpoint !== "string") return;
    const fp = crypto.createHash("sha256").update(b.endpoint).digest("hex").slice(0, 16);
    await db([["HDEL", K.subs, `dali:${fp}`], ["HDEL", K.subs, `rahma:${fp}`]]);
  },
  "push.test": async (b, d, req) => notify(req, b.who, { title: "🔔 Notifications activées", body: `Tu seras prévenu·e quand ${PEOPLE[otherOf(b.who)]} t'écrit 💕`, tag: "test", url: "/" }),
};

/* ================= HTTP ================= */
module.exports = async function handler(req, res) {
  try {
    const q = Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
    const code = req.headers["x-code"];

    // L'appli a-t-elle déjà un code secret ? (+ clé publique pour les notifications)
    if (req.method === "GET" && q.status) {
      const [auth] = await db([["GET", K.auth]]);
      const vapid = webpush && auth ? (await vapidKeys()).publicKey : null;
      return send(res, 200, { configured: !!auth, people: PEOPLE, vapid });
    }

    // Photos : protégées par un jeton dérivé du code secret
    if (req.method === "GET" && q.photo) {
      const id = String(q.photo);
      if (!/^[a-z0-9]{8,40}$/.test(id)) fail(400, "Photo invalide.");
      const [auth, data] = await db([["GET", K.auth], ["GET", q.s === "full" ? K.photo(id) : K.thumb(id)]]);
      if (!auth || q.k !== photoToken(JSON.parse(auth).hash, id)) fail(403, "Accès refusé.");
      if (!data) fail(404, "Photo introuvable.");
      res.statusCode = 200;
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      res.end(Buffer.from(data, "base64"));
      return;
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

    // fuseau horaire du téléphone (pour afficher l'heure chez l'autre)
    const tz = txt(b.tz, 60);
    if (tz && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz) && d.tz[who] !== tz) { await db([["HSET", K.tz, who, tz]]); d.tz[who] = tz; }

    let extra = {};
    if (req.method === "POST") {
      const fn = ACTIONS[b.action];
      if (!fn) fail(400, "Action inconnue.");
      extra = (await fn(b, d, req)) || {};
      d = await loadAll(req, code);
    }
    return send(res, 200, { ...view(d, who, day), pushed: extra.sent });
  } catch (e) {
    if (e.status === 409 && e.message === "SETUP") return send(res, 409, { error: "SETUP" });
    return sendError(res, e);
  }
};

module.exports.questionFor = questionFor;
