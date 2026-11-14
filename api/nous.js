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
 *   nd:letters       hash   id -> lettre « Ouvre quand… » / lettre datée
 *   nd:jar           hash   id -> raison « Pourquoi je t'aime » (bocal)
 *   nd:thinks        hash   "personne:AAAA-MM-JJ" -> nombre de « je pense à toi »
 *   nd:lastthink     hash   personne -> horodatage de sa dernière pensée
 *   nd:loc           hash   personne -> position approximative (pour la distance et la météo)
 *   nd:doodle:ID     dessin JPEG (base64) envoyé dans les petits mots
 *   nd:snaps         hash   id -> snap (photo du jour, visible 24 h)
 *   nd:snap:ID       photo du snap (expire après 24 h)   nd:snapt:ID  miniature
 *   nd:voice:ID      message vocal (« type-mime\nbase64 ») envoyé dans les petits mots
 *   nd:sched         hash   id -> surprise programmée (devient un petit mot à l'heure choisie)
 *   nd:story         hash   id -> moment de « Notre histoire »     nd:storyimg:ID  sa photo
 *   nd:songs         hash   id -> chanson de « Notre playlist »
 *   nd:sleep         hash   personne -> {s: "sleep"|"awake", t}
 *   nd:act           hash   "personne:AAAA-MM-JJ" -> 1 (a envoyé quelque chose ce jour-là, pour la série)
 *   nd:call          appel en cours (offre/réponse WebRTC), expire après 2 h
 *   nd:avatar:ID     photo de profil (affichée sur la carte) ; l'id actuel est dans nd:cfg « avatar_personne »
 *   nd:qa            hash   "AAAA-MM-JJ:personne" -> réponse à la question du jour
 *   nd:fail:IP       compteur d'essais de code ratés (15 min)
 */
const crypto = require("crypto");
const { fail, db, hobj, send, readBody, sendError } = require("./_lib.js");
let webpush = null;
try { webpush = require("web-push"); } catch (e) { /* notifications désactivées si la bibliothèque manque */ }

const PEOPLE = { dali: "Dali", rahma: "Rahma" };
const START = "2025-09-15";
const MAX_PHOTO = 950000, MAX_THUMB = 200000, MAX_DOODLE = 400000, MAX_VOICE = 900000, SNAP_TTL = 86400; // tailles max en base64

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
  doodle: id => `nd:doodle:${id}`, snaps: "nd:snaps", snap: id => `nd:snap:${id}`, snapt: id => `nd:snapt:${id}`, avatar: id => `nd:avatar:${id}`, voice: id => `nd:voice:${id}`, sched: "nd:sched", call: "nd:call", story: "nd:story", storyimg: id => `nd:storyimg:${id}`, songs: "nd:songs", sleep: "nd:sleep", act: "nd:act", letters: "nd:letters", jar: "nd:jar", thinks: "nd:thinks", lastthink: "nd:lastthink", loc: "nd:loc",
  qa: "nd:qa", fail: ip => `nd:fail:${ip}`,
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

/* ================= Snaps ================= */
// Ne garde que les snaps de moins de 24 h (et efface les plus anciens)
async function freshSnaps(list) {
  const limit = Date.now() - SNAP_TTL * 1000;
  const old = list.filter(x => x.t < limit);
  if (old.length) await db(old.map(x => ["HDEL", K.snaps, x.id]));
  return list.filter(x => x.t >= limit);
}

/* ================= Appels (WebRTC) ================= */
// Serveurs pour établir l'appel : STUN public + relais TURN (indispensable sur beaucoup de réseaux mobiles).
// Relais au choix, configuré dans Vercel → Settings → Environment Variables :
//   - Metered (gratuit 50 Go/mois) : METERED_DOMAIN (ex. nousdeux.metered.live) + METERED_API_KEY
//   - ou n'importe quel TURN : TURN_URLS (séparés par des virgules) + TURN_USERNAME + TURN_CREDENTIAL
let meteredCache = null;
async function iceServers() {
  const list = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  const e = process.env;
  if (e.METERED_DOMAIN && e.METERED_API_KEY) {
    try {
      if (!meteredCache || Date.now() - meteredCache.t > 3600000) {
        const dom = e.METERED_DOMAIN.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        const r = await fetch(`https://${dom}/api/v1/turn/credentials?apiKey=${encodeURIComponent(e.METERED_API_KEY)}`);
        if (!r.ok) throw new Error("Metered HTTP " + r.status);
        const servers = await r.json();
        if (Array.isArray(servers) && servers.length) meteredCache = { t: Date.now(), servers };
      }
      if (meteredCache) list.push(...meteredCache.servers);
    } catch (err) { console.error("TURN Metered", err.message); }
  }
  if (e.TURN_URLS && e.TURN_USERNAME && e.TURN_CREDENTIAL)
    list.push({ urls: e.TURN_URLS.split(",").map(x => x.trim()).filter(Boolean), username: e.TURN_USERNAME, credential: e.TURN_CREDENTIAL });
  return list;
}
const hasRelay = list => list.some(x => [].concat(x.urls || x.url || []).some(u => /^turns?:/.test(u)));
async function checkCode(req, code) {
  const [auth, fails] = await db([["GET", K.auth], ["GET", K.fail(ipOf(req))]]);
  if (!auth) fail(409, "SETUP");
  if (Number(fails) >= 10) fail(429, "Trop d'essais ratés. Réessaie dans 15 minutes.");
  const a = JSON.parse(auth);
  if (!crypto.timingSafeEqual(Buffer.from(hashCode(a.salt, code || "")), Buffer.from(a.hash))) fail(401, "Code secret incorrect.");
}
async function getCall() {
  const [c] = await db([["GET", K.call]]);
  const x = c ? JSON.parse(c) : null;
  if (x && x.state === "ringing" && Date.now() - x.t > 60000) x.state = "missed"; // personne n'a répondu
  return x;
}
// Ce que chacun voit de l'appel : l'offre pour celui qui est appelé, la réponse pour celui qui appelle
function callView(x, who) {
  if (!x || (x.state !== "ringing" && x.state !== "accepted" && Date.now() - (x.endedAt || x.t) > 15000)) return null;
  const { offer, answer, ...rest } = x;
  return { ...rest, ...(x.to === who && x.state === "ringing" ? { offer } : {}), ...(x.from === who && x.state === "accepted" ? { answer } : {}) };
}

/* ================= Série de jours ================= */
function streakOf(act, day) {
  const both = dd => act[`dali:${dd}`] && act[`rahma:${dd}`];
  const prev = dd => new Date(Date.parse(dd) - 86400000).toISOString().slice(0, 10);
  let dd = both(day) ? day : prev(day), n = 0;
  while (both(dd) && n < 5000) { n++; dd = prev(dd); }
  return { days: n, today: !!both(day), meToday: !!act[`dali:${day}`] || !!act[`rahma:${day}`] };
}

/* ================= Surprises programmées ================= */
// Transforme en petits mots les surprises dont l'heure est arrivée (appelé à chaque requête et par la tâche planifiée)
async function deliverDue(req) {
  const [raw] = await db([["HGETALL", K.sched]]);
  const due = parseHash(raw).filter(x => !x.delivered && x.at <= Date.now());
  let n = 0;
  for (const x of due) {
    const [ok] = await db([["SET", `nd:l:sched:${x.id}`, "1", "EX", 3600, "NX"]]);
    if (ok !== "OK") continue;
    const note = { id: newId(), from: x.from, text: x.text, img: false, t: x.at, read: false, heart: false, surprise: true };
    await db([["HSET", K.notes, note.id, JSON.stringify(note)], ["HSET", K.sched, x.id, JSON.stringify({ ...x, delivered: Date.now() })]]);
    await notify(req, otherOf(x.from), { title: `🎁 Une surprise de ${PEOPLE[x.from]}`, body: short(x.text, 160), tag: "surprise-" + x.id, url: "/?tab=notes" });
    n++;
  }
  return n;
}

/* ================= Lecture de toutes les données ================= */
async function loadAll(req, code) {
  const [auth, fails, cfg, tz, notes, moods, dates, mem, mnotes, qa, subs, letters, jar, thinks, lastthink, loc, snaps, sched, story, songs, sleep, act] = await db([
    ["GET", K.auth], ["GET", K.fail(ipOf(req))],
    ["HGETALL", K.cfg], ["HGETALL", K.tz], ["HGETALL", K.notes], ["HGETALL", K.moods], ["HGETALL", K.dates],
    ["HGETALL", K.mem], ["HGETALL", K.mnotes], ["HGETALL", K.qa], ["HGETALL", K.subs],
    ["HGETALL", K.letters], ["HGETALL", K.jar], ["HGETALL", K.thinks], ["HGETALL", K.lastthink], ["HGETALL", K.loc], ["HGETALL", K.snaps],
    ["HGETALL", K.sched], ["HGETALL", K.story], ["HGETALL", K.songs], ["HGETALL", K.sleep], ["HGETALL", K.act],
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
    mem: parseHash(mem), mnotes: parseHash(mnotes), qa: hobj(qa),
    subs: Object.keys(hobj(subs)),
    letters: parseHash(letters), jar: parseHash(jar), thinks: hobj(thinks), lastthink: hobj(lastthink), loc: hobj(loc),
    snaps: await freshSnaps(parseHash(snaps)),
    sched: parseHash(sched), story: parseHash(story), songs: parseHash(songs), sleep: hobj(sleep), act: hobj(act),
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
  // Lettres : le texte n'est envoyé au destinataire qu'une fois la lettre ouverte
  const letters = d.letters.sort((a, b) => b.t - a.t).map(l => {
    if (l.from === who || l.openedAt) return l;
    const { text, ...sealed } = l;
    return { ...sealed, locked: l.unlock ? l.unlock > day : false };
  });
  // Bocal : les raisons pas encore tirées restent secrètes
  const jarMine = d.jar.filter(r => r.from === who).sort((a, b) => b.t - a.t);
  const jarForMe = d.jar.filter(r => r.from !== who);
  const locs = {};
  for (const p in PEOPLE) if (d.loc[p]) { try { locs[p] = JSON.parse(d.loc[p]); } catch (e) {} }
  return {
    people: PEOPLE, start: START,
    reunion: d.cfg.reunion || null,
    tz: d.tz,
    notes: d.notes.sort((a, b) => b.t - a.t).slice(0, 300).map(n => (n.img || n.voice ? { ...n, tk: photoToken(d.authHash, n.id) } : n)),
    letters,
    jar: {
      mine: jarMine,                                                           // ce que j'ai écrit pour l'autre
      drawn: jarForMe.filter(r => r.drawnAt).sort((a, b) => b.drawnAt - a.drawnAt), // ce que j'ai déjà tiré
      left: jarForMe.filter(r => !r.drawnAt).length,                            // combien il en reste à tirer
    },
    thinks: {
      fromThem: Number(d.thinks[`${other}:${day}`] || 0), fromMe: Number(d.thinks[`${who}:${day}`] || 0),
      lastFromThem: Number(d.lastthink[other] || 0),
      total: Object.entries(d.thinks).reduce((a, [k, v]) => a + Number(v || 0), 0),
    },
    locs,
    surprises: d.sched.filter(x => x.from === who && !x.delivered).sort((a, b) => a.at - b.at), // seulement les miennes, en attente
    story: d.story.sort((a, b) => a.date.localeCompare(b.date) || a.t - b.t).map(x => (x.photo ? { ...x, tk: photoToken(d.authHash, x.id) } : x)),
    songs: d.songs.sort((a, b) => b.t - a.t),
    sleep: Object.fromEntries(Object.keys(PEOPLE).filter(p => d.sleep[p]).map(p => [p, JSON.parse(d.sleep[p])])),
    streak: streakOf(d.act, day),
    movie: (() => { try { const m = JSON.parse(d.cfg.movie || "null"); return m && m.at > Date.now() - 3 * 3600000 ? m : null; } catch (e) { return null; } })(),
    avatars: Object.fromEntries(Object.keys(PEOPLE).filter(p => d.cfg["avatar_" + p]).map(p => [p, { id: d.cfg["avatar_" + p], tk: photoToken(d.authHash, d.cfg["avatar_" + p]) }])),
    snaps: d.snaps.sort((a, b) => b.t - a.t).map(x => ({ ...x, tk: photoToken(d.authHash, x.id) })),
    moods,
    dates: d.dates.sort((a, b) => a.date.localeCompare(b.date)),
    memories,
    qa: { day, question: questionFor(day), mine, theirs: mine ? theirs : null, theirAnswered: !!theirs, history },
    push: { available: !!webpush, mine: d.subs.filter(k => k.startsWith(who + ":")).length, theirs: d.subs.filter(k => k.startsWith(other + ":")).length },
    now: Date.now(),
  };
}

/* ================= Actions ================= */
const ACTIONS = {
  "note.add": async (b, d, req) => {
    const text = longTxt(b.text, 1000);
    const img = b.doodle ? /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.doodle)) : null;
    if (b.doodle && (!img || img[1].length > MAX_DOODLE)) fail(400, "Dessin invalide.");
    const voice = b.voice ? /^data:(audio\/(?:mp4|webm|ogg|aac|mpeg|x-m4a))(?:;[^,;]*)*;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.voice)) : null;
    if (b.voice && (!voice || voice[2].length > MAX_VOICE)) fail(400, voice ? "Vocal trop long (2 min max)." : "Vocal invalide.");
    if (!text && !img && !voice) fail(400, "Écris un petit mot.");
    const dur = voice ? Math.max(1, Math.min(600, Math.round(Number(b.dur) || 0))) : 0;
    const n = { id: newId(), from: b.who, text, img: !!img, voice: !!voice, dur, t: Date.now(), read: false, heart: false };
    if (img) await db([["SET", K.doodle(n.id), img[1]]]);
    if (voice) await db([["SET", K.voice(n.id), voice[1] + "\n" + voice[2]]]);
    await db([["HSET", K.notes, n.id, JSON.stringify(n)]]);
    const mmss = `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}`;
    if (voice) return notify(req, otherOf(b.who), { title: `🎤 ${PEOPLE[b.who]} t'a envoyé un vocal (${mmss})`, body: text ? short(text, 160) : "Écoute-le vite 💕", tag: "note-" + n.id, url: "/?tab=notes" });
    return notify(req, otherOf(b.who), img
      ? { title: `🎨 ${PEOPLE[b.who]} t'a fait un dessin`, body: text ? short(text, 160) : "Viens voir 💕", tag: "note-" + n.id, url: "/?tab=notes" }
      : { title: `💌 ${PEOPLE[b.who]}`, body: short(text, 160), tag: "note-" + n.id, url: "/?tab=notes" });
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
    if (n && n.from === b.who) await db([["HDEL", K.notes, n.id], ["DEL", K.doodle(n.id)], ["DEL", K.voice(n.id)]]);
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

  "qa.answer": async (b, d, req) => {
    if (!isDay(b.day)) fail(400, "Date invalide.");
    const text = longTxt(b.text, 600);
    if (!text) fail(400, "Écris ta réponse.");
    const first = !d.qa[`${b.day}:${b.who}`];
    await db([["HSET", K.qa, `${b.day}:${b.who}`, text]]);
    if (first) return notify(req, otherOf(b.who), { title: `❓ ${PEOPLE[b.who]} a répondu à la question du jour`, body: "Réponds à ton tour pour découvrir sa réponse 👀", tag: "qa-" + b.day, url: "/?tab=question" });
  },

  // « Je pense à toi » en un geste
  "think": async (b, d, req) => {
    const last = Number(d.lastthink[b.who] || 0);
    await db([["HINCRBY", K.thinks, `${b.who}:${b.day}`, 1], ["HSET", K.lastthink, b.who, Date.now()]]);
    if (Date.now() - last < 45000) return; // pas plus d'une notification toutes les 45 s
    const n = Number(d.thinks[`${b.who}:${b.day}`] || 0) + 1;
    return notify(req, otherOf(b.who), { title: `💗 ${PEOPLE[b.who]} pense à toi`, body: n > 1 ? `Déjà ${n} fois aujourd'hui…` : "En ce moment même ✨", tag: "think", url: "/" });
  },

  // Lettres « Ouvre quand… » et lettres datées
  "letter.add": async (b, d, req) => {
    const text = longTxt(b.text, 5000);
    const label = txt(b.label, 80);
    const unlock = b.unlock && isDay(b.unlock) ? b.unlock : null;
    if (!text) fail(400, "Écris ta lettre.");
    if (!label && !unlock) fail(400, "Choisis quand l'ouvrir.");
    const l = { id: newId(), from: b.who, label, unlock, text, t: Date.now(), openedAt: null };
    await db([["HSET", K.letters, l.id, JSON.stringify(l)]]);
    return notify(req, otherOf(b.who), {
      title: `✉️ ${PEOPLE[b.who]} t'a écrit une lettre`,
      body: unlock ? `À ouvrir le ${unlock.split("-").reverse().join("/")} 🔒` : `« Ouvre quand ${label} »`,
      tag: "letter-" + l.id, url: "/?tab=letters",
    });
  },
  "letter.open": async (b, d, req) => {
    const l = d.letters.find(x => x.id === b.id);
    if (!l || l.from === b.who) fail(404, "Lettre introuvable.");
    if (l.openedAt) return;
    if (l.unlock && l.unlock > b.day) fail(403, "Pas encore… patience 💕");
    await db([["HSET", K.letters, l.id, JSON.stringify({ ...l, openedAt: Date.now() })]]);
    return notify(req, l.from, { title: `💌 ${PEOPLE[b.who]} a ouvert ta lettre`, body: l.unlock ? `Ta lettre du ${l.unlock.split("-").reverse().join("/")}` : `« Ouvre quand ${l.label} »`, tag: "letteropen-" + l.id, url: "/?tab=letters" });
  },
  "letter.del": async (b, d) => {
    const l = d.letters.find(x => x.id === b.id);
    if (l && l.from === b.who) await db([["HDEL", K.letters, l.id]]);
  },

  // Bocal « Pourquoi je t'aime »
  "jar.add": async (b, d, req) => {
    const text = longTxt(b.text, 400);
    if (!text) fail(400, "Écris une raison.");
    const r = { id: newId(), from: b.who, text, t: Date.now(), drawnAt: null };
    await db([["HSET", K.jar, r.id, JSON.stringify(r)]]);
    const left = d.jar.filter(x => x.from === b.who && !x.drawnAt).length + 1;
    return notify(req, otherOf(b.who), { title: `🫙 Ton bocal se remplit`, body: `${PEOPLE[b.who]} y a glissé une raison de t'aimer (${left} à découvrir)`, tag: "jar", url: "/?tab=letters" });
  },
  "jar.draw": async (b, d, req) => {
    const pool = d.jar.filter(r => r.from !== b.who && !r.drawnAt);
    if (!pool.length) fail(404, "Le bocal est vide pour l'instant 🥺");
    const r = pool[crypto.randomInt(pool.length)];
    await db([["HSET", K.jar, r.id, JSON.stringify({ ...r, drawnAt: Date.now() })]]);
    const n = await notify(req, r.from, { title: `🫙 ${PEOPLE[b.who]} a tiré un papier du bocal`, body: short(r.text, 140), tag: "jardraw", url: "/?tab=letters" });
    return { drawn: r.id, sent: n.sent };
  },
  "jar.del": async (b, d) => {
    const r = d.jar.find(x => x.id === b.id);
    if (r && r.from === b.who) await db([["HDEL", K.jar, r.id]]);
  },

  // Position approximative (arrondie à ~1 km) pour la distance et la météo
  // Position partagée volontairement : précise (~1 m) ou approximative (~1 km)
  "loc.set": async (b) => {
    const precise = b.precise !== false;
    const f = precise ? 100000 : 100;
    const lat = Math.round(Number(b.lat) * f) / f, lon = Math.round(Number(b.lon) * f) / f;
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || isNaN(lat) || isNaN(lon)) fail(400, "Position invalide.");
    const acc = precise ? Math.min(100000, Math.max(0, Math.round(Number(b.acc) || 0))) : 1000;
    await db([["HSET", K.loc, b.who, JSON.stringify({ lat, lon, precise, acc, city: txt(b.city, 60), t: Date.now() })]]);
  },

  // Photo de profil (pour la carte)
  "avatar.set": async (b, d) => {
    const img = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.photo || ""));
    if (!img || img[1].length > MAX_THUMB) fail(400, "Photo invalide.");
    const id = "av" + b.who + Date.now().toString(36);
    const old = d.cfg["avatar_" + b.who];
    await db([["SET", K.avatar(id), img[1]], ["HSET", K.cfg, "avatar_" + b.who, id], ...(old ? [["DEL", K.avatar(old)]] : [])]);
  },
  "avatar.del": async (b, d) => {
    const old = d.cfg["avatar_" + b.who];
    if (old) await db([["DEL", K.avatar(old)], ["HDEL", K.cfg, "avatar_" + b.who]]);
  },
  "loc.clear": async (b) => { await db([["HDEL", K.loc, b.who]]); },

  // Snaps : photos du jour avec une petite note, visibles 24 h
  "snap.add": async (b, d, req) => {
    const photo = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.photo || ""));
    const thumb = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.thumb || ""));
    if (!photo || !thumb) fail(400, "Photo invalide.");
    if (photo[1].length > MAX_PHOTO || thumb[1].length > MAX_THUMB) fail(413, "Photo trop lourde.");
    const x = { id: newId(), from: b.who, caption: txt(b.caption, 140), pos: Math.min(85, Math.max(10, Math.round(Number(b.pos) || 62))), t: Date.now(), seenAt: null, kept: false };
    await db([["SET", K.snap(x.id), photo[1], "EX", SNAP_TTL + 3600]]);
    await db([["SET", K.snapt(x.id), thumb[1], "EX", SNAP_TTL + 3600], ["HSET", K.snaps, x.id, JSON.stringify(x)]]);
    return notify(req, otherOf(b.who), { title: `📸 ${PEOPLE[b.who]} t'a envoyé un snap`, body: x.caption || "Ouvre vite, il disparaît dans 24 h ⏳", tag: "snap-" + x.id, url: "/?snap=" + x.id });
  },
  "snap.seen": async (b, d, req) => {
    const x = d.snaps.find(y => y.id === b.id);
    if (!x || x.from === b.who || x.seenAt) return;
    await db([["HSET", K.snaps, x.id, JSON.stringify({ ...x, seenAt: Date.now() })]]);
    return notify(req, x.from, { title: `👀 ${PEOPLE[b.who]} a vu ton snap`, body: x.caption || "", tag: "snapseen-" + x.id, url: "/" });
  },
  "snap.keep": async (b, d, req) => {
    const x = d.snaps.find(y => y.id === b.id);
    if (!x) fail(404, "Ce snap a disparu.");
    if (x.kept) return;
    const [full, th] = await db([["GET", K.snap(x.id)], ["GET", K.snapt(x.id)]]);
    if (!full) fail(404, "Ce snap a disparu.");
    const m = { id: newId(), by: x.from, caption: x.caption, date: new Date(x.t).toISOString().slice(0, 10), t: Date.now(), fromSnap: true };
    await db([["SET", K.photo(m.id), full]]);
    await db([["SET", K.thumb(m.id), th || full], ["HSET", K.mem, m.id, JSON.stringify(m)], ["HSET", K.snaps, x.id, JSON.stringify({ ...x, kept: true })]]);
    if (b.who !== x.from) return notify(req, x.from, { title: `💾 ${PEOPLE[b.who]} a gardé ton snap`, body: "Il est maintenant dans vos souvenirs 💕", tag: "snapkeep-" + x.id, url: "/?tab=memories" });
  },
  "snap.del": async (b, d) => {
    const x = d.snaps.find(y => y.id === b.id);
    if (x && x.from === b.who) await db([["HDEL", K.snaps, x.id], ["DEL", K.snap(x.id)], ["DEL", K.snapt(x.id)]]);
  },

  // 🎁 Surprise programmée
  "sched.add": async (b) => {
    const text = longTxt(b.text, 1000), at = Number(b.at);
    if (!text) fail(400, "Écris ta surprise.");
    if (!(at > Date.now() + 30000 && at < Date.now() + 400 * 86400000)) fail(400, "Choisis une date et une heure dans le futur.");
    const x = { id: newId(), from: b.who, text, at, delivered: null, t: Date.now() };
    await db([["HSET", K.sched, x.id, JSON.stringify(x)]]);
  },
  "sched.del": async (b, d) => {
    const x = d.sched.find(y => y.id === b.id);
    if (x && x.from === b.who && !x.delivered) await db([["HDEL", K.sched, x.id]]);
  },

  // 📖 Notre histoire
  "story.add": async (b, d, req) => {
    const title = txt(b.title, 80);
    if (!title || !isDay(b.date)) fail(400, "Donne un titre et une date.");
    const img = b.photo ? /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.photo)) : null;
    if (b.photo && (!img || img[1].length > MAX_PHOTO)) fail(400, "Photo invalide.");
    const x = { id: newId(), by: b.who, date: b.date, title, text: longTxt(b.text, 1500), emoji: txt(b.emoji, 8) || "💕", photo: !!img, t: Date.now() };
    if (img) await db([["SET", K.storyimg(x.id), img[1]]]);
    await db([["HSET", K.story, x.id, JSON.stringify(x)]]);
    return notify(req, otherOf(b.who), { title: `📖 ${PEOPLE[b.who]} a ajouté un moment à votre histoire`, body: `${x.emoji} ${title}`, tag: "story-" + x.id, url: "/?tab=memories&sub=story" });
  },
  "story.del": async (b, d) => {
    const x = d.story.find(y => y.id === b.id);
    if (x) await db([["HDEL", K.story, x.id], ["DEL", K.storyimg(x.id)]]);
  },

  // 🎵 Notre playlist
  "song.add": async (b, d, req) => {
    const title = txt(b.title, 120);
    if (!title) fail(400, "Écris le titre de la chanson.");
    const url = /^https:\/\/[^\s]{4,500}$/.test(String(b.url || "").trim()) ? String(b.url).trim() : "";
    const x = { id: newId(), by: b.who, title, url, note: longTxt(b.note, 300), t: Date.now() };
    await db([["HSET", K.songs, x.id, JSON.stringify(x)]]);
    return notify(req, otherOf(b.who), { title: `🎵 ${PEOPLE[b.who]} a ajouté une chanson pour toi`, body: x.note ? `${title} — ${short(x.note, 100)}` : title, tag: "song-" + x.id, url: "/?tab=memories&sub=songs" });
  },
  "song.del": async (b, d) => {
    const x = d.songs.find(y => y.id === b.id);
    if (x && x.by === b.who) await db([["HDEL", K.songs, x.id]]);
  },

  // 🌙 Bonne nuit / ☀️ Bonjour
  "sleep.set": async (b, d, req) => {
    const st = b.state === "sleep" ? "sleep" : "awake";
    await db([["HSET", K.sleep, b.who, JSON.stringify({ s: st, t: Date.now() })]]);
    return notify(req, otherOf(b.who), st === "sleep"
      ? { title: `🌙 ${PEOPLE[b.who]} va dormir`, body: "Bonne nuit mon amour, fais de beaux rêves 💫", tag: "sleep", url: "/" }
      : { title: `☀️ ${PEOPLE[b.who]} est réveillé·e`, body: "Bonjour mon amour, bonne journée 💕", tag: "sleep", url: "/" });
  },

  // 🎬 Soirée film : compte à rebours commun
  "movie.start": async (b, d, req) => {
    const delay = [10, 30, 60].includes(Number(b.delay)) ? Number(b.delay) : 30;
    const m = { title: txt(b.title, 80), at: Date.now() + delay * 1000, by: b.who };
    await db([["HSET", K.cfg, "movie", JSON.stringify(m)]]);
    return notify(req, otherOf(b.who), { title: `🎬 Soirée film avec ${PEOPLE[b.who]} !`, body: `${m.title ? "« " + m.title + " » — " : ""}on lance dans ${delay} s, ouvre vite l'appli 🍿`, tag: "movie", url: "/?movie=1" });
  },
  "movie.stop": async (b) => { await db([["HDEL", K.cfg, "movie"]]); },

  // 📞 Appels audio / vidéo
  "call.start": async (b, d, req) => {
    const offer = String(b.offer || "");
    if (!offer.startsWith("v=0") || offer.length > 60000) fail(400, "Appel impossible.");
    const cur = await getCall();
    if (cur && cur.state === "accepted" && Date.now() - cur.t < 4 * 3600000) fail(409, "Un appel est déjà en cours.");
    const x = { id: newId(), from: b.who, to: otherOf(b.who), video: !!b.video, state: "ringing", offer, answer: null, t: Date.now() };
    await db([["SET", K.call, JSON.stringify(x), "EX", 7200]]);
    const n = await notify(req, x.to, { title: `${x.video ? "🎥" : "📞"} ${PEOPLE[b.who]} t'appelle`, body: x.video ? "Appel vidéo — touche pour répondre" : "Appel audio — touche pour répondre", tag: "call", url: "/?call=1" });
    return { ...n, call: x.id };
  },
  "call.answer": async (b) => {
    const x = await getCall();
    const answer = String(b.answer || "");
    if (!x || x.id !== b.id || x.to !== b.who || x.state !== "ringing") fail(409, "Cet appel n'est plus disponible.");
    if (!answer.startsWith("v=0") || answer.length > 60000) fail(400, "Réponse invalide.");
    await db([["SET", K.call, JSON.stringify({ ...x, state: "accepted", answer, acceptedAt: Date.now() }), "EX", 7200]]);
  },
  "call.end": async (b, d, req) => {
    const x = await getCall();
    if (!x || x.id !== b.id || x.state === "ended") return;
    const missed = x.state === "ringing" || x.state === "missed";
    await db([["SET", K.call, JSON.stringify({ ...x, offer: null, answer: null, state: "ended", endedAt: Date.now(), endedBy: b.who, declined: missed && b.who === x.to }), "EX", 600]]);
    if (missed && b.who === x.from) return notify(req, x.to, { title: `📞 Appel manqué de ${PEOPLE[x.from]}`, body: "Rappelle-le/la vite 💕", tag: "call", url: "/" });
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

// actions qui comptent pour la série de jours
const ACTIVE = new Set(["call.start", "call.answer", "note.add", "mood.set", "think", "snap.add", "qa.answer", "letter.add", "jar.add", "mem.add", "mem.note", "sleep.set"]);

/* ================= HTTP ================= */
module.exports = async function handler(req, res) {
  try {
    const q = Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
    const code = req.headers["x-code"];

    // Suivi rapide de l'appel en cours (seulement le code secret et l'appel : 3 lectures)
    if (req.method === "GET" && q.call) {
      await checkCode(req, code);
      const ice = await iceServers();
      return send(res, 200, { call: callView(await getCall(), q.who), ice, relay: hasRelay(ice), now: Date.now() });
    }

    // Tâche planifiée : livre les surprises arrivées à échéance (ne renvoie aucune donnée)
    if (req.method === "GET" && q.tick) return send(res, 200, { delivered: await deliverDue(req) });

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
      const key = { full: K.photo(id), doodle: K.doodle(id), snap: K.snap(id), snapt: K.snapt(id), avatar: K.avatar(id), voice: K.voice(id), story: K.storyimg(id) }[q.s] || K.thumb(id);
      const [auth, data] = await db([["GET", K.auth], ["GET", key]]);
      if (!auth || q.k !== photoToken(JSON.parse(auth).hash, id)) fail(403, "Accès refusé.");
      if (!data) fail(404, "Photo introuvable.");
      res.statusCode = 200;
      if (q.s === "voice") {
        const i = data.indexOf("\n");
        res.setHeader("Content-Type", data.slice(0, i));
        res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
        res.end(Buffer.from(data.slice(i + 1), "base64"));
        return;
      }
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
    if (await deliverDue(req)) d = await loadAll(req, code);
    if (req.method === "POST") {
      const fn = ACTIONS[b.action];
      if (!fn) fail(400, "Action inconnue.");
      extra = (await fn(b, d, req)) || {};
      if (ACTIVE.has(b.action)) await db([["HSET", K.act, `${who}:${day}`, "1"]]);
      d = await loadAll(req, code);
    }
    return send(res, 200, { ...view(d, who, day), call: callView(await getCall(), who), pushed: extra.sent, drawn: extra.drawn, callId: extra.call });
  } catch (e) {
    if (e.status === 409 && e.message === "SETUP") return send(res, 409, { error: "SETUP" });
    return sendError(res, e);
  }
};

module.exports.questionFor = questionFor;
