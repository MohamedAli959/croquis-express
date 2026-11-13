"use strict";
/*
 * API multijoueur de Croquis Express (fonction serverless Vercel).
 *
 * L'état de chaque partie est stocké dans Upstash Redis (via son API REST).
 * Les téléphones interrogent GET /api/room?code=XXXX&id=... toutes les ~1 s
 * et envoient leurs actions en POST /api/room {action, code, id, ...}.
 *
 * Clés Redis (expirent au bout de 6 h) :
 *   cx:CODE          état de la partie (JSON)
 *   cx:CODE:p        hash  joueurId -> {name, t}
 *   cx:CODE:d        hash  joueurId -> {g, r, t, e}  dessins rendus pour la manche en cours
 *   cx:CODE:i:G:R:ID image JPEG (base64) d'un dessin
 *   cx:CODE:l:...    verrous (évite qu'une transition soit faite deux fois)
 */
const crypto = require("crypto");
const { WORDS } = require("./_words.js");

const TTL = 6 * 3600;          // durée de vie d'une partie (s)
const COUNTDOWN = 3500;        // compte à rebours avant de dessiner (ms)
const GRACE = 5000;            // délai d'envoi toléré après la fin du chrono (ms)
const MIN_PLAYERS = 3, MAX_PLAYERS = 8;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

/* ================= Stockage ================= */
function dbConf() {
  const e = process.env;
  const pairs = [["KV_REST_API_URL", "KV_REST_API_TOKEN"], ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]];
  for (const [u, t] of pairs) if (e[u] && e[t]) return { url: e[u], token: e[t] };
  // variables avec un préfixe personnalisé (ex : STORAGE_KV_REST_API_URL)
  for (const k of Object.keys(e)) for (const [u, t] of pairs) {
    if (k.endsWith(u)) { const tk = k.slice(0, -u.length) + t; if (e[k] && e[tk]) return { url: e[k], token: e[tk] }; }
  }
  return null;
}
const CONF = dbConf();

// Stockage en mémoire, uniquement pour tester en local (hors Vercel).
const mem = new Map();
function memEntry(k) { const e = mem.get(k); if (e && e.exp && e.exp < Date.now()) { mem.delete(k); return undefined; } return e; }
function memExec([cmd, k, ...a]) {
  const e = memEntry(k);
  switch (cmd) {
    case "GET": return e ? e.v : null;
    case "SET": {
      if (a.includes("NX") && e) return null;
      const i = a.indexOf("EX");
      mem.set(k, { v: a[0], exp: i >= 0 ? Date.now() + Number(a[i + 1]) * 1000 : 0 });
      return "OK";
    }
    case "DEL": return mem.delete(k) ? 1 : 0;
    case "EXPIRE": if (e) e.exp = Date.now() + Number(a[0]) * 1000; return e ? 1 : 0;
    case "HSET": { let h = e; if (!h) { h = { v: new Map(), exp: 0 }; mem.set(k, h); } h.v.set(a[0], a[1]); return 1; }
    case "HDEL": return e && e.v.delete(a[0]) ? 1 : 0;
    case "HGETALL": return e ? [...e.v].flat() : [];
  }
  throw new Error("Commande inconnue " + cmd);
}

async function db(cmds) {
  if (CONF) {
    const r = await fetch(CONF.url.replace(/\/+$/, "") + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + CONF.token, "Content-Type": "application/json" },
      body: JSON.stringify(cmds.map(c => c.map(String))),
    });
    if (!r.ok) throw new Error("Base de données : erreur HTTP " + r.status);
    const out = await r.json();
    return out.map(o => { if (o.error) throw new Error("Base de données : " + o.error); return o.result; });
  }
  if (process.env.VERCEL) fail(500, "La base de données n'est pas configurée : ajoute « Upstash for Redis » à ton projet Vercel puis redéploie (voir README).");
  return cmds.map(c => memExec(c.map(String)));
}

const K = {
  st: c => `cx:${c}`,
  pl: c => `cx:${c}:p`,
  done: c => `cx:${c}:d`,
  img: (c, g, r, p) => `cx:${c}:i:${g}:${r}:${p}`,
  lock: (c, ...a) => `cx:${c}:l:${a.join(":")}`,
};
const hobj = a => {
  const o = {};
  if (Array.isArray(a)) for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1];
  else if (a) Object.assign(o, a);
  return o;
};

async function load(code) {
  if (!/^[A-Z]{4}$/.test(code || "")) fail(404, "Partie introuvable.");
  const [s, p, d] = await db([["GET", K.st(code)], ["HGETALL", K.pl(code)], ["HGETALL", K.done(code)]]);
  if (!s) fail(404, "Partie introuvable.");
  const st = JSON.parse(s);
  const players = Object.entries(hobj(p)).map(([id, v]) => ({ id, ...JSON.parse(v) })).sort((a, b) => a.t - b.t);
  const done = {};
  for (const [id, v] of Object.entries(hobj(d))) {
    const x = JSON.parse(v);
    if (x.g === st.game && x.r === st.round) done[id] = x;
  }
  return { code, st, players, done };
}

async function save(ctx, extra = []) {
  ctx.st.v = (ctx.st.v || 0) + 1;
  await db([["SET", K.st(ctx.code), JSON.stringify(ctx.st), "EX", TTL], ["EXPIRE", K.pl(ctx.code), TTL], ...extra]);
}

async function lock(ctx, ...parts) {
  const [r] = await db([["SET", K.lock(ctx.code, ...parts), "1", "EX", 3600, "NX"]]);
  return r === "OK";
}

/* ================= Règles du jeu ================= */
const drawersOf = st => st.order.filter(id => id !== st.guesser);

function pickWord(st) {
  const pool = st.settings.level === "mix" ? WORDS.facile.concat(WORDS.difficile) : WORDS[st.settings.level] || WORDS.facile;
  const used = new Set(st.used || []);
  let left = pool.filter(w => !used.has(w));
  if (!left.length) { st.used = []; left = pool.slice(); }
  const w = left[crypto.randomInt(left.length)];
  st.used = (st.used || []).concat(w).slice(-300);
  return w;
}

function startRound(st) {
  st.guesser = st.order[st.round % st.order.length];
  st.word = pickWord(st);
  st.phase = "draw";
  st.startAt = Date.now() + COUNTDOWN;
  st.drawings = []; st.guesses = []; st.revealIdx = 0; st.result = null;
}

function finish(st, ok) {
  const k = st.drawings.length;
  st.result = { ok: false, foundAt: -1, gPts: 0, artist: null };
  if (ok && k) {
    const i = st.revealIdx, artist = st.drawings[i].p, g = k - i;
    st.scores[st.guesser] = (st.scores[st.guesser] || 0) + g;
    st.scores[artist] = (st.scores[artist] || 0) + 2;
    st.result = { ok: true, foundAt: i, gPts: g, artist };
  }
  st.history.push({ word: st.word, guesser: st.guesser, foundAt: st.result.foundAt });
  st.phase = "result";
}

function nextDrawing(st) {
  if (st.revealIdx < st.drawings.length - 1) st.revealIdx++;
  else finish(st, false);
}

// Passe de la phase « dessin » à la phase « devine » quand tout le monde a fini (ou temps écoulé).
async function maybeAdvance(ctx) {
  const st = ctx.st;
  if (st.phase !== "draw") return ctx;
  const now = Date.now(), ds = drawersOf(st);
  const allDone = ds.every(id => ctx.done[id]);
  const timeUp = now > st.startAt + st.settings.drawTime * 1000 + GRACE;
  if (!allDone && !timeUp) return ctx;
  if (!(await lock(ctx, st.game, st.round, "guess"))) return load(ctx.code);
  st.drawings = ds.filter(id => ctx.done[id])
    .map(id => ({ p: id, t: ctx.done[id].t, e: !!ctx.done[id].e }))
    .sort((a, b) => a.t - b.t);
  st.revealIdx = 0; st.guesses = [];
  if (st.drawings.length) st.phase = "guess"; else finish(st, false);
  await save(ctx);
  return ctx;
}

/* ---- Vérification de la réponse ---- */
function norm(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/œ/g, "oe").replace(/æ/g, "ae")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\b(le|la|les|l|un|une|des|du|de|d)\b/g, " ")
    .split(/\s+/).filter(Boolean).map(w => (w.length > 3 ? w.replace(/(s|x)$/, "") : w)).join(" ");
}
function lev(a, b) {
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i].concat(Array(n).fill(0)));
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function isRight(guess, word) {
  const g = norm(guess), w = norm(word);
  if (!g) return false;
  if (g === w) return true;
  const tol = w.length >= 8 ? 2 : w.length >= 4 ? 1 : 0;
  return lev(g, w) <= tol;
}

/* ================= Réponse envoyée aux téléphones ================= */
function view(ctx, me) {
  const st = { ...ctx.st };
  delete st.used;
  if ((st.phase === "draw" || st.phase === "guess") && me === st.guesser) st.word = null; // le devineur ne reçoit pas le mot
  const done = {};
  for (const id in ctx.done) done[id] = ctx.done[id].t;
  return { state: st, players: ctx.players.map(p => ({ id: p.id, name: p.name })), done, now: Date.now() };
}

/* ================= Actions ================= */
const cleanName = n => String(n || "").trim().replace(/\s+/g, " ").slice(0, 16) || "Joueur";
const isMember = (ctx, id) => ctx.players.some(p => p.id === id);
const mustBeHost = (ctx, id) => { if (ctx.st.host !== id) fail(403, "Seul l'hôte peut faire ça."); };
const mustBeMember = (ctx, id) => { if (!isMember(ctx, id)) fail(403, "Tu ne fais pas partie de cette partie."); };

function genCode() {
  const L = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let c = ""; for (let i = 0; i < 4; i++) c += L[crypto.randomInt(L.length)];
  return c;
}

async function create(b) {
  const name = cleanName(b.name);
  for (let i = 0; i < 20; i++) {
    const code = genCode();
    const st = {
      code, v: 1, host: b.id, created: Date.now(), game: 0, phase: "lobby",
      settings: { drawTime: 60, turns: 1, level: "facile" },
      order: [], scores: {}, history: [], used: [], round: 0, totalRounds: 0,
    };
    const [ok] = await db([["SET", K.st(code), JSON.stringify(st), "EX", TTL, "NX"]]);
    if (ok === "OK") {
      await db([["HSET", K.pl(code), b.id, JSON.stringify({ name, t: Date.now() })], ["EXPIRE", K.pl(code), TTL]]);
      return load(code);
    }
  }
  fail(500, "Impossible de créer la partie, réessaie.");
}

const ACTIONS = {
  async join(ctx, b) {
    const me = ctx.players.find(p => p.id === b.id);
    if (!me) {
      if (ctx.st.phase !== "lobby") fail(409, "La partie a déjà commencé. Attends la fin de la partie pour la rejoindre.");
      if (ctx.players.length >= MAX_PLAYERS) fail(409, "La partie est complète (8 joueurs maximum).");
    }
    await db([["HSET", K.pl(ctx.code), b.id, JSON.stringify({ name: cleanName(b.name), t: me ? me.t : Date.now() })]]);
    return load(ctx.code);
  },

  async leave(ctx, b) {
    if (ctx.st.phase !== "lobby" || !isMember(ctx, b.id)) return ctx; // en cours de partie, on garde sa place
    const rest = ctx.players.filter(p => p.id !== b.id);
    if (!rest.length) { await db([["DEL", K.st(ctx.code)], ["DEL", K.pl(ctx.code)], ["DEL", K.done(ctx.code)]]); return null; }
    await db([["HDEL", K.pl(ctx.code), b.id]]);
    if (ctx.st.host === b.id) { ctx.st.host = rest[0].id; await save(ctx); }
    return load(ctx.code);
  },

  async kick(ctx, b) {
    mustBeHost(ctx, b.id);
    if (ctx.st.phase !== "lobby" || b.target === b.id) return ctx;
    await db([["HDEL", K.pl(ctx.code), String(b.target)]]);
    return load(ctx.code);
  },

  async settings(ctx, b) {
    mustBeHost(ctx, b.id);
    if (ctx.st.phase !== "lobby") return ctx;
    const s = b.settings || {}, cur = ctx.st.settings;
    if ([30, 45, 60, 90].includes(+s.drawTime)) cur.drawTime = +s.drawTime;
    if ([1, 2, 3].includes(+s.turns)) cur.turns = +s.turns;
    if (["facile", "difficile", "mix"].includes(s.level)) cur.level = s.level;
    await save(ctx);
    return ctx;
  },

  async start(ctx, b) {
    mustBeHost(ctx, b.id);
    const st = ctx.st;
    if (st.phase !== "lobby") return ctx;
    if (ctx.players.length < MIN_PLAYERS) fail(409, `Il faut au moins ${MIN_PLAYERS} joueurs.`);
    st.order = ctx.players.map(p => p.id);
    st.scores = Object.fromEntries(st.order.map(id => [id, 0]));
    st.round = 0; st.totalRounds = st.order.length * st.settings.turns; st.history = [];
    st.game++;
    startRound(st);
    await save(ctx, [["DEL", K.done(ctx.code)]]);
    ctx.done = {};
    return ctx;
  },

  async submit(ctx, b) {
    const st = ctx.st;
    if (st.phase !== "draw" || +b.round !== st.round || +b.game !== st.game) return ctx; // trop tard : ignoré
    if (!drawersOf(st).includes(b.id)) fail(403, "Ce n'est pas ton tour de dessiner.");
    if (ctx.done[b.id]) return ctx;
    const img = String(b.img || "");
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(img);
    if (!m || img.length > 2000000) fail(400, "Image invalide.");
    const elapsed = Math.max(0, (Date.now() - st.startAt) / 1000);
    const t = Math.max(0, Math.min(Number(b.time) || elapsed, elapsed + 0.5, st.settings.drawTime));
    const entry = { g: st.game, r: st.round, t: Math.round(t * 10) / 10, e: !!b.empty };
    await db([
      ["SET", K.img(ctx.code, st.game, st.round, b.id), m[1], "EX", TTL],
      ["HSET", K.done(ctx.code), b.id, JSON.stringify(entry)],
      ["EXPIRE", K.done(ctx.code), TTL],
    ]);
    ctx.done[b.id] = entry;
    return maybeAdvance(ctx);
  },

  async guess(ctx, b) {
    const st = ctx.st;
    if (!guesserTurn(st, b)) return ctx;
    const text = String(b.text || "").trim().slice(0, 60);
    if (!text) return ctx;
    const ok = isRight(text, st.word);
    st.guesses.push({ i: st.revealIdx, text, ok });
    if (ok) finish(st, true); else nextDrawing(st);
    await save(ctx);
    return ctx;
  },

  async pass(ctx, b) {
    if (!guesserTurn(ctx.st, b)) return ctx;
    nextDrawing(ctx.st);
    await save(ctx);
    return ctx;
  },

  async accept(ctx, b) {
    if (!guesserTurn(ctx.st, b)) return ctx;
    finish(ctx.st, true);
    await save(ctx);
    return ctx;
  },

  // N'importe quel joueur peut passer la manche (utile si le devineur a quitté la partie).
  async skip(ctx, b) {
    mustBeMember(ctx, b.id);
    const st = ctx.st;
    if (st.phase !== "guess" || +b.round !== st.round) return ctx;
    finish(st, false);
    await save(ctx);
    return ctx;
  },

  async next(ctx, b) {
    mustBeMember(ctx, b.id);
    const st = ctx.st;
    if (st.phase !== "result" || +b.round !== st.round) return ctx;
    if (!(await lock(ctx, st.game, st.round, "next"))) return load(ctx.code);
    st.round++;
    if (st.round >= st.totalRounds) st.phase = "final"; else startRound(st);
    await save(ctx, [["DEL", K.done(ctx.code)]]);
    ctx.done = {};
    return ctx;
  },

  async lobby(ctx, b) {
    mustBeMember(ctx, b.id);
    const st = ctx.st;
    if (st.phase !== "final" || +b.game !== st.game) return ctx;
    if (!(await lock(ctx, st.game, "lobby"))) return load(ctx.code);
    st.phase = "lobby";
    await save(ctx);
    return ctx;
  },
};

function guesserTurn(st, b) {
  return st.phase === "guess" && b.id === st.guesser && +b.round === st.round && +b.idx === st.revealIdx;
}

/* ================= HTTP ================= */
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body != null) return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : {};
}

const validId = id => typeof id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(id);

module.exports = async function handler(req, res) {
  try {
    const q = Object.fromEntries(new URL(req.url, "http://localhost").searchParams);

    if (req.method === "GET" && q.img) {
      const code = String(q.code || "").toUpperCase();
      if (!/^[A-Z]{4}$/.test(code) || !/^\d+$/.test(q.g || "") || !/^\d+$/.test(q.r || "") || !validId(q.p)) fail(400, "Requête invalide.");
      const [b64] = await db([["GET", K.img(code, q.g, q.r, q.p)]]);
      if (!b64) fail(404, "Dessin introuvable.");
      res.statusCode = 200;
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "private, max-age=86400, immutable");
      res.end(Buffer.from(b64, "base64"));
      return;
    }

    if (req.method === "GET") {
      if (!validId(q.id)) fail(400, "Identifiant invalide.");
      let ctx = await load(String(q.code || "").toUpperCase());
      ctx = await maybeAdvance(ctx);
      return send(res, 200, view(ctx, q.id));
    }

    if (req.method !== "POST") fail(405, "Méthode non autorisée.");
    const b = await readBody(req);
    if (!validId(b.id)) fail(400, "Identifiant invalide.");

    if (b.action === "create") return send(res, 200, view(await create(b), b.id));

    const fn = ACTIONS[b.action];
    if (!fn) fail(400, "Action inconnue.");
    let ctx = await load(String(b.code || "").toUpperCase());
    ctx = await maybeAdvance(ctx);
    if (b.action !== "join") mustBeMember(ctx, b.id);
    ctx = await fn(ctx, b);
    if (!ctx) return send(res, 200, { ok: true });
    return send(res, 200, view(ctx, b.id));
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: e.message || "Erreur serveur." });
  }
};

// exposé pour les tests
module.exports.isRight = isRight;
