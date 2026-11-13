"use strict";
/* Outils communs aux API des jeux : stockage Redis (Upstash) et HTTP. */
const crypto = require("crypto");

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
function memHash(k) { let h = memEntry(k); if (!h) { h = { v: new Map(), exp: 0 }; mem.set(k, h); } return h; }
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
    case "INCR": { const n = Number(e ? e.v : 0) + 1; if (e) e.v = String(n); else mem.set(k, { v: String(n), exp: 0 }); return n; }
    case "HSET": memHash(k).v.set(a[0], a[1]); return 1;
    case "HINCRBY": { const h = memHash(k); const n = Number(h.v.get(a[0]) || 0) + Number(a[1]); h.v.set(a[0], String(n)); return n; }
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

const hobj = a => {
  const o = {};
  if (Array.isArray(a)) for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1];
  else if (a) Object.assign(o, a);
  return o;
};

/* ================= Divers ================= */
const cleanName = n => String(n || "").trim().replace(/\s+/g, " ").slice(0, 16) || "Joueur";
const validId = id => typeof id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(id);
function genCode() {
  const L = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let c = ""; for (let i = 0; i < 4; i++) c += L[crypto.randomInt(L.length)];
  return c;
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

function sendError(res, e) {
  if (e instanceof HttpError) return send(res, e.status, { error: e.message });
  console.error(e);
  return send(res, 500, { error: e.message || "Erreur serveur." });
}

module.exports = { HttpError, fail, db, hobj, cleanName, validId, genCode, send, readBody, sendError };
