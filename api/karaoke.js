"use strict";
/*
 * API multijoueur de Karaoké Battle (fonction serverless Vercel).
 *
 * Déroulement d'une manche :
 *   pick   le chanteur choisit sa chanson (et découvre son défi)
 *   sing   il chante ; les autres envoient des réactions en direct
 *   vote   les autres notent de 1 à 5 étoiles
 *   result note moyenne et points
 *
 * Clés Redis (expirent au bout de 6 h) :
 *   ka:CODE        état de la partie (JSON)
 *   ka:CODE:p      hash joueurId -> {name, t}
 *   ka:CODE:v      hash joueurId -> {g, r, s}   notes de la manche
 *   ka:CODE:x      hash "g:r:emoji" -> nombre    réactions
 *   ka:CODE:l:...  verrous
 */
const crypto = require("crypto");
const { fail, db, hobj, cleanName, validId, genCode, send, readBody, sendError } = require("./_lib.js");

const TTL = 6 * 3600;
const VOTE_TIME = 40000;       // temps pour voter (ms)
const GRACE = 3000;
const MIN_PLAYERS = 2, MAX_PLAYERS = 12;
const EMOJIS = ["👏", "🔥", "😂", "😍", "🎶", "😱"];

const CHALLENGES = [
  "Chante en chuchotant… sauf le refrain, que tu cries !",
  "Chante comme un chanteur d'opéra",
  "Chante en dansant sans jamais t'arrêter",
  "Chante comme un robot",
  "Chante les yeux fermés",
  "Chante en regardant quelqu'un dans les yeux tout du long",
  "Fais un geste pour chaque phrase",
  "Chante comme si c'était la chanson la plus triste du monde",
  "Chante comme une rock star dans un stade",
  "Chante en version slow romantique",
  "Chante avec une voix de personnage de dessin animé",
  "Chante avec un accent (au choix !)",
  "Chante accroupi·e",
  "Chante en mode rappeur",
  "Chante en faisant le lip-sync le plus dramatique possible",
  "Chante sur une seule jambe",
  "Fais chanter le refrain à tout le monde",
  "Chante en mode comédie musicale",
  "Chante avec une voix très grave",
  "Chante avec une voix très aiguë",
];

class Ctx { }

/* ================= Stockage ================= */
const K = {
  st: c => `ka:${c}`,
  pl: c => `ka:${c}:p`,
  votes: c => `ka:${c}:v`,
  react: c => `ka:${c}:x`,
  lock: (c, ...a) => `ka:${c}:l:${a.join(":")}`,
};

async function load(code) {
  if (!/^[A-Z]{4}$/.test(code || "")) fail(404, "Partie introuvable.");
  const [s, p, v, x] = await db([["GET", K.st(code)], ["HGETALL", K.pl(code)], ["HGETALL", K.votes(code)], ["HGETALL", K.react(code)]]);
  if (!s) fail(404, "Partie introuvable.");
  const ctx = new Ctx();
  ctx.code = code;
  ctx.st = JSON.parse(s);
  ctx.players = Object.entries(hobj(p)).map(([id, val]) => ({ id, ...JSON.parse(val) })).sort((a, b) => a.t - b.t);
  ctx.votes = {};
  for (const [id, val] of Object.entries(hobj(v))) {
    const o = JSON.parse(val);
    if (o.g === ctx.st.game && o.r === ctx.st.round) ctx.votes[id] = o.s;
  }
  ctx.react = {};
  const prefix = `${ctx.st.game}:${ctx.st.round}:`;
  for (const [f, n] of Object.entries(hobj(x))) if (f.startsWith(prefix)) ctx.react[f.slice(prefix.length)] = Number(n);
  return ctx;
}

async function save(ctx, extra = []) {
  ctx.st.v = (ctx.st.v || 0) + 1;
  await db([["SET", K.st(ctx.code), JSON.stringify(ctx.st), "EX", TTL], ["EXPIRE", K.pl(ctx.code), TTL], ...extra]);
}

async function lock(ctx, ...parts) {
  const [r] = await db([["SET", K.lock(ctx.code, ...parts), "1", "EX", 3600, "NX"]]);
  return r === "OK";
}

/* ================= Règles ================= */
const votersOf = st => st.order.filter(id => id !== st.singer);

function pickChallenge(st) {
  if (!st.settings.challenges) return null;
  const used = new Set(st.usedCh || []);
  let left = CHALLENGES.filter(c => !used.has(c));
  if (!left.length) { st.usedCh = []; left = CHALLENGES.slice(); }
  const c = left[crypto.randomInt(left.length)];
  st.usedCh = (st.usedCh || []).concat(c);
  return c;
}

function startRound(st) {
  st.singer = st.order[st.round % st.order.length];
  st.challenge = pickChallenge(st);
  st.song = null;
  st.result = null;
  st.voteEnd = 0;
  st.phase = "pick";
}

function closeRound(ctx, skipped) {
  const st = ctx.st;
  const stars = Object.values(ctx.votes).filter(s => s >= 1 && s <= 5);
  let avg = 0, pts = 0;
  if (!skipped && stars.length) {
    avg = Math.round(stars.reduce((a, b) => a + b, 0) / stars.length * 10) / 10;
    pts = Math.round(avg * 20);
    st.scores[st.singer] = (st.scores[st.singer] || 0) + pts;
  }
  const reactions = Object.values(ctx.react).reduce((a, b) => a + b, 0);
  st.result = { skipped: !!skipped, avg, pts, count: stars.length, dist: [1, 2, 3, 4, 5].map(n => stars.filter(s => s === n).length), reactions };
  st.history.push({ singer: st.singer, title: st.song ? st.song.title : null, avg, pts, skipped: !!skipped });
  st.phase = "result";
}

// Clôt le vote quand tout le monde a voté ou que le temps est écoulé.
async function maybeAdvance(ctx) {
  const st = ctx.st;
  if (st.phase !== "vote") return ctx;
  const all = votersOf(st).every(id => ctx.votes[id] != null);
  if (!all && Date.now() < st.voteEnd + GRACE) return ctx;
  if (!(await lock(ctx, st.game, st.round, "close"))) return load(ctx.code);
  closeRound(ctx, false);
  await save(ctx);
  return ctx;
}

function youtubeId(url) {
  const s = String(url || "").trim();
  if (!s) return null;
  const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/.exec(s);
  return m ? m[1] : null;
}

/* ================= Réponse envoyée aux téléphones ================= */
function view(ctx) {
  const st = { ...ctx.st };
  delete st.usedCh;
  return {
    state: st,
    players: ctx.players.map(p => ({ id: p.id, name: p.name })),
    voted: Object.keys(ctx.votes),          // qui a voté (les notes restent secrètes)
    react: ctx.react,
    now: Date.now(),
  };
}

/* ================= Actions ================= */
const isMember = (ctx, id) => ctx.players.some(p => p.id === id);
const mustBeHost = (ctx, id) => { if (ctx.st.host !== id) fail(403, "Seul l'hôte peut faire ça."); };
const sameRound = (st, b) => +b.round === st.round && +b.game === st.game;

async function create(b) {
  const name = cleanName(b.name);
  for (let i = 0; i < 20; i++) {
    const code = genCode();
    const st = {
      code, v: 1, host: b.id, created: Date.now(), game: 0, phase: "lobby",
      settings: { turns: 1, challenges: true },
      order: [], scores: {}, history: [], usedCh: [], round: 0, totalRounds: 0,
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
      if (ctx.players.length >= MAX_PLAYERS) fail(409, `La partie est complète (${MAX_PLAYERS} joueurs maximum).`);
    }
    await db([["HSET", K.pl(ctx.code), b.id, JSON.stringify({ name: cleanName(b.name), t: me ? me.t : Date.now() })]]);
    return load(ctx.code);
  },

  async leave(ctx, b) {
    if (ctx.st.phase !== "lobby" || !isMember(ctx, b.id)) return ctx;
    const rest = ctx.players.filter(p => p.id !== b.id);
    if (!rest.length) { await db([["DEL", K.st(ctx.code)], ["DEL", K.pl(ctx.code)], ["DEL", K.votes(ctx.code)], ["DEL", K.react(ctx.code)]]); return null; }
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
    if ([1, 2, 3].includes(+s.turns)) cur.turns = +s.turns;
    if (typeof s.challenges === "boolean") cur.challenges = s.challenges;
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
    await save(ctx, [["DEL", K.votes(ctx.code)], ["DEL", K.react(ctx.code)]]);
    ctx.votes = {}; ctx.react = {};
    return ctx;
  },

  // Le chanteur annonce sa chanson.
  async choose(ctx, b) {
    const st = ctx.st;
    if (st.phase !== "pick" || !sameRound(st, b)) return ctx;
    if (b.id !== st.singer) fail(403, "Ce n'est pas ton tour de chanter.");
    const title = String(b.title || "").trim().replace(/\s+/g, " ").slice(0, 80);
    if (!title) fail(400, "Écris le titre de ta chanson.");
    const yt = youtubeId(b.yt);
    if (String(b.yt || "").trim() && !yt) fail(400, "Ce lien YouTube n'est pas valide.");
    st.song = { title, yt };
    st.phase = "sing";
    st.singStart = Date.now();
    await save(ctx);
    return ctx;
  },

  // Fin de la chanson : place au vote.
  async sung(ctx, b) {
    const st = ctx.st;
    if (st.phase !== "sing" || !sameRound(st, b)) return ctx;
    if (!(await lock(ctx, st.game, st.round, "vote"))) return load(ctx.code);
    st.phase = "vote";
    st.voteEnd = Date.now() + VOTE_TIME;
    await save(ctx);
    return ctx;
  },

  async vote(ctx, b) {
    const st = ctx.st;
    if (st.phase !== "vote" || !sameRound(st, b)) return ctx;
    if (!votersOf(st).includes(b.id)) fail(403, "Tu ne peux pas voter pour toi-même !");
    const s = Math.round(Number(b.stars));
    if (!(s >= 1 && s <= 5)) fail(400, "Choisis entre 1 et 5 étoiles.");
    await db([["HSET", K.votes(ctx.code), b.id, JSON.stringify({ g: st.game, r: st.round, s })], ["EXPIRE", K.votes(ctx.code), TTL]]);
    ctx.votes[b.id] = s;
    return maybeAdvance(ctx);
  },

  async react(ctx, b) {
    const st = ctx.st;
    if (!["sing", "vote"].includes(st.phase) || !sameRound(st, b)) return ctx;
    const cmds = [];
    for (const [e, n] of Object.entries(b.r || {})) {
      const k = Math.min(30, Math.max(0, Math.round(Number(n) || 0)));
      if (EMOJIS.includes(e) && k > 0) { cmds.push(["HINCRBY", K.react(ctx.code), `${st.game}:${st.round}:${e}`, k]); ctx.react[e] = (ctx.react[e] || 0) + k; }
    }
    if (cmds.length) await db([...cmds, ["EXPIRE", K.react(ctx.code), TTL]]);
    return ctx;
  },

  // Passer la manche (chanteur absent ou qui ne veut pas chanter).
  async skip(ctx, b) {
    const st = ctx.st;
    if (!["pick", "sing"].includes(st.phase) || !sameRound(st, b)) return ctx;
    if (!(await lock(ctx, st.game, st.round, "close"))) return load(ctx.code);
    closeRound(ctx, true);
    await save(ctx);
    return ctx;
  },

  async next(ctx, b) {
    const st = ctx.st;
    if (st.phase !== "result" || !sameRound(st, b)) return ctx;
    if (!(await lock(ctx, st.game, st.round, "next"))) return load(ctx.code);
    st.round++;
    if (st.round >= st.totalRounds) st.phase = "final"; else startRound(st);
    await save(ctx);
    ctx.votes = {}; ctx.react = {};
    return ctx;
  },

  async lobby(ctx, b) {
    const st = ctx.st;
    if (st.phase !== "final" || +b.game !== st.game) return ctx;
    if (!(await lock(ctx, st.game, "lobby"))) return load(ctx.code);
    st.phase = "lobby";
    await save(ctx);
    return ctx;
  },
};

/* ================= HTTP ================= */
module.exports = async function handler(req, res) {
  try {
    const q = Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
    if (req.method === "GET") {
      if (!validId(q.id)) fail(400, "Identifiant invalide.");
      let ctx = await load(String(q.code || "").toUpperCase());
      ctx = await maybeAdvance(ctx);
      return send(res, 200, view(ctx));
    }
    if (req.method !== "POST") fail(405, "Méthode non autorisée.");
    const b = await readBody(req);
    if (!validId(b.id)) fail(400, "Identifiant invalide.");
    if (b.action === "create") return send(res, 200, view(await create(b)));
    const fn = ACTIONS[b.action];
    if (!fn) fail(400, "Action inconnue.");
    let ctx = await load(String(b.code || "").toUpperCase());
    ctx = await maybeAdvance(ctx);
    if (b.action !== "join" && !isMember(ctx, b.id)) fail(403, "Tu ne fais pas partie de cette partie.");
    ctx = await fn(ctx, b);
    if (!ctx) return send(res, 200, { ok: true });
    return send(res, 200, view(ctx));
  } catch (e) {
    return sendError(res, e);
  }
};

module.exports.youtubeId = youtubeId;
