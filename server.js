// server.js - supports Almighty Python, GROWTH, House Nocturne,
// LUXBOUND, MECHMARINER, Slimecraft, KRON & SHEOL. One process, one port, isolated rooms by game.
// https://raw.githubusercontent.com/tribehunt/nodejs/refs/heads/main/server.js
// all games produced and engineered by © Dedset Media 08/31/2026
// RAILYARD = bm9kZWpzLXByb2R1Y3Rpb24tNzQwYmM=
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const PORT = process.env.PORT || 8080;
const HOST = String(process.env.HOST || process.env.BIND_HOST || process.env.MEGA_CLAIM_HOST || (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID ? "0.0.0.0" : "127.0.0.1")).trim() || "127.0.0.1";
const server = http.createServer((req, res) => {
  if (handleMegaClaimHTTP(req, res)) return;
  if (handleKronHTTP(req, res)) return;
  if (handleSheolHTTP(req, res)) return;
  if (handleSheolQwenHTTP(req, res)) return;
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("OK\n");
});
const wss = new WebSocket.Server({ server });
const HEARTBEAT_MS = 30000;
const _hb = setInterval(() => {
  try {
    for (const c of wss.clients) {
      if (!c) continue;
      if (c.isAlive === false) {
        try { c.terminate(); } catch {}
        continue;
      }
      c.isAlive = false;
      try { c.ping(); } catch {}
    }
  } catch {}
}, HEARTBEAT_MS);
try { if (_hb && typeof _hb.unref === "function") _hb.unref(); } catch {}
// ---------------------------------------------------------
// House Nocturne MEGA chat distributed reply claim endpoint
// ---------------------------------------------------------
// Vespera's autonomous MEGA responder runs inside each game copy, but this
// Railway endpoint gives all copies one shared lock so only one Vespera answers
// each incoming MEGA chat message.
function megaEnvNumber(name, fallback, min, max) {
  const n = Number(process.env[name]);
  let v = Number.isFinite(n) ? n : Number(fallback);
  if (Number.isFinite(min)) v = Math.max(Number(min), v);
  if (Number.isFinite(max)) v = Math.min(Number(max), v);
  return v;
}
const MEGA_CLAIM_TTL_MS = megaEnvNumber("MEGA_CLAIM_TTL_MS", 180000, 30000);
function readMegaClaimSecretFile() {
  const candidates = [
    process.env.MEGA_CLAIM_SECRET_FILE,
    path.join(process.cwd(), "crew", "her", ".gate", "mega_claim.secret"),
    path.join(__dirname, "crew", "her", ".gate", "mega_claim.secret"),
    path.join(process.cwd(), "crew", "her", "mega_claim.secret"),
    path.join(__dirname, "crew", "her", "mega_claim.secret"),
    path.join(process.cwd(), "mega_claim.secret"),
    path.join(__dirname, "mega_claim.secret")
  ].filter(Boolean);
  const seen = new Set();
  for (const candidate of candidates) {
    try {
      const p = path.resolve(String(candidate || ""));
      const key = p.toLowerCase();
      if (!p || seen.has(key)) continue;
      seen.add(key);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const secret = fs.readFileSync(p, "utf8").split(/\r?\n/)[0].trim();
        if (secret) return secret;
      }
    } catch {}
  }
  return "";
}
const MEGA_CLAIM_SECRET = String(process.env.MEGA_CLAIM_SECRET || process.env.VESPERA_MEGA_CLAIM_SECRET || readMegaClaimSecretFile() || "").trim();
const MEGA_CLAIM_REQUIRE_AUTH = !/^0|false|no|off$/i.test(String(process.env.MEGA_CLAIM_REQUIRE_AUTH || "1").trim());
const MEGA_CLAIM_HMAC_WINDOW_MS = megaEnvNumber("MEGA_CLAIM_HMAC_WINDOW_MS", 300000, 30000);
const MEGA_CLAIM_RATE_WINDOW_MS = megaEnvNumber("MEGA_CLAIM_RATE_WINDOW_MS", 60000, 10000);
const MEGA_CLAIM_RATE_MAX = megaEnvNumber("MEGA_CLAIM_RATE_MAX", 120, 5);
const MEGA_CLAIM_STORE = path.resolve(String(process.env.MEGA_CLAIM_STORE || path.join(process.cwd(), "data", "mega_claims.json")));
const MEGA_CLAIM_ALLOWED_ORIGINS = new Set(
  String(process.env.MEGA_CLAIM_ALLOWED_ORIGINS || "http://localhost,http://127.0.0.1,http://localhost:8080,http://127.0.0.1:8080")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);
const megaClaims = new Map();
const megaClaimRate = new Map();
let megaClaimsDirty = false;
let megaClaimSaveTimer = null;
function megaClaimCleanId(v, max = 220) {
  return String(v || "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .slice(0, max);
}
function megaClaimRoom(v) {
  const s = String(v || "house_nocturne")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 48);
  return s || "house_nocturne";
}
function megaClaimKey(room, messageId, fingerprint) {
  const rid = megaClaimRoom(room);
  const mid = megaClaimCleanId(messageId || fingerprint || "", 220);
  if (!mid) return "";
  return rid + ":" + mid;
}
function megaClaimClientIP(req) {
  try { return pickIP(req) || "local"; } catch { return "local"; }
}
function megaClaimOriginAllowed(req) {
  try {
    const origin = String((req && req.headers && req.headers.origin) || "").trim();
    if (!origin) return true;
    if (MEGA_CLAIM_ALLOWED_ORIGINS.has(origin)) return true;
    try {
      const u = new URL(origin);
      const host = String(u.hostname || "").toLowerCase();
      if ((host === "localhost" || host === "127.0.0.1" || host === "::1") && MEGA_CLAIM_ALLOWED_ORIGINS.has(u.protocol + "//" + host)) return true;
    } catch {}
    return false;
  } catch {
    return false;
  }
}
function megaClaimCorsHeaders(req) {
  const headers = {
    "content-type": "application/json",
    "cache-control": "no-store",
    "vary": "Origin",
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-hn-timestamp,x-hn-signature"
  };
  try {
    const origin = String((req && req.headers && req.headers.origin) || "").trim();
    if (origin && megaClaimOriginAllowed(req)) headers["access-control-allow-origin"] = origin;
  } catch {}
  return headers;
}
function megaClaimRateAllow(req) {
  const now = Date.now();
  const ip = megaClaimClientIP(req);
  let rec = megaClaimRate.get(ip);
  if (!rec || Number(rec.reset || 0) <= now) rec = { count: 0, reset: now + MEGA_CLAIM_RATE_WINDOW_MS };
  rec.count = Number(rec.count || 0) + 1;
  megaClaimRate.set(ip, rec);
  if (megaClaimRate.size > 2000) {
    for (const [k, v] of megaClaimRate.entries()) {
      if (!v || Number(v.reset || 0) <= now) megaClaimRate.delete(k);
    }
  }
  return rec.count <= MEGA_CLAIM_RATE_MAX;
}
function megaClaimSafeEqual(a, b) {
  try {
    const ab = Buffer.from(String(a || ""), "hex");
    const bb = Buffer.from(String(b || ""), "hex");
    return ab.length > 0 && ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}
function megaClaimVerifyHmac(req, body) {
  try {
    if (!MEGA_CLAIM_SECRET) {
      if (!MEGA_CLAIM_REQUIRE_AUTH) return { ok: true, auth: "disabled" };
      return { ok: false, code: 503, error: "claim-secret-not-configured" };
    }
    const h = (req && req.headers) ? req.headers : {};
    let ts = String(h["x-hn-timestamp"] || "").trim();
    let sig = String(h["x-hn-signature"] || "").trim().toLowerCase();
    const auth = String(h.authorization || "").trim();
    const m = auth.match(/^HN-HMAC\s+([0-9]{8,14})[: ]([a-f0-9]{64})$/i);
    if ((!ts || !sig) && m) { ts = m[1]; sig = m[2].toLowerCase(); }
    if (!ts || !sig) return { ok: false, code: 401, error: "missing-hmac" };
    const tsMs = Number(ts) * 1000;
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > MEGA_CLAIM_HMAC_WINDOW_MS) return { ok: false, code: 401, error: "stale-hmac" };
    const expected = crypto.createHmac("sha256", MEGA_CLAIM_SECRET).update(ts + "." + String(body || ""), "utf8").digest("hex");
    if (!megaClaimSafeEqual(sig, expected)) return { ok: false, code: 401, error: "bad-hmac" };
    return { ok: true, auth: "hmac" };
  } catch {
    return { ok: false, code: 401, error: "hmac-check-failed" };
  }
}
function megaClaimLoadStore() {
  try {
    if (!fs.existsSync(MEGA_CLAIM_STORE)) return;
    const raw = fs.readFileSync(MEGA_CLAIM_STORE, "utf8");
    const data = JSON.parse(raw || "{}");
    const claims = data && typeof data === "object" ? data.claims : null;
    if (!claims || typeof claims !== "object") return;
    const now = Date.now();
    for (const [k, v] of Object.entries(claims)) {
      if (v && typeof v === "object" && Number(v.expiresAt || 0) > now) megaClaims.set(String(k), v);
    }
  } catch (err) {
    console.warn("MEGA claim store load failed:", String(err && err.message ? err.message : err));
  }
}
function megaClaimSaveNow() {
  try {
    megaClaimSaveTimer = null;
    if (!megaClaimsDirty) return;
    megaClaimsDirty = false;
    const dir = path.dirname(MEGA_CLAIM_STORE);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const claims = {};
    for (const [k, v] of megaClaims.entries()) claims[k] = v;
    const tmp = MEGA_CLAIM_STORE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updated_at: Date.now(), claims }, null, 2), "utf8");
    fs.renameSync(tmp, MEGA_CLAIM_STORE);
  } catch (err) {
    console.warn("MEGA claim store save failed:", String(err && err.message ? err.message : err));
  }
}
function megaClaimMarkDirty() {
  megaClaimsDirty = true;
  if (!megaClaimSaveTimer) {
    megaClaimSaveTimer = setTimeout(megaClaimSaveNow, 250);
    try { if (megaClaimSaveTimer && typeof megaClaimSaveTimer.unref === "function") megaClaimSaveTimer.unref(); } catch {}
  }
}
megaClaimLoadStore();
function megaClaimSweep() {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of megaClaims.entries()) {
    if (!v || Number(v.expiresAt || 0) <= now) {
      megaClaims.delete(k);
      changed = true;
    }
  }
  if (changed) megaClaimMarkDirty();
}
try {
  const _megaClaimSweep = setInterval(megaClaimSweep, 30000);
  if (_megaClaimSweep && typeof _megaClaimSweep.unref === "function") _megaClaimSweep.unref();
} catch {}
function megaClaimReply(req, res, code, obj) {
  try {
    res.writeHead(code, megaClaimCorsHeaders(req));
    if (code === 204) res.end();
    else res.end(JSON.stringify(obj));
  } catch {}
}
function handleMegaClaimHTTP(req, res) {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const path = String(url.pathname || "").replace(/\/+$/, "") || "/";
    if (path !== "/mega-claim" && path !== "/api/mega-claim") return false;
    if (!megaClaimOriginAllowed(req)) {
      megaClaimReply(req, res, 403, { ok: false, error: "origin-not-allowed" });
      return true;
    }
    if (!megaClaimRateAllow(req)) {
      megaClaimReply(req, res, 429, { ok: false, error: "rate-limited" });
      return true;
    }
    if (req.method === "OPTIONS") {
      megaClaimReply(req, res, 204, { ok: true });
      return true;
    }
    if (req.method !== "POST") {
      megaClaimReply(req, res, 405, { ok: false, error: "method-not-allowed" });
      return true;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (body.length > 65536) {
        try { req.destroy(); } catch {}
      }
    });
    req.on("end", () => {
      const auth = megaClaimVerifyHmac(req, body);
      if (!auth || !auth.ok) {
        megaClaimReply(req, res, Number((auth && auth.code) || 401), { ok: false, error: String((auth && auth.error) || "unauthorized") });
        return;
      }
      let m = null;
      try { m = JSON.parse(body || "{}"); } catch { m = null; }
      if (!m || typeof m !== "object") {
        megaClaimReply(req, res, 400, { ok: false, error: "bad-json" });
        return;
      }
      megaClaimSweep();
      const op = String(m.op || "claim").toLowerCase();
      const room = megaClaimRoom(m.room || "house_nocturne");
      const ownerId = megaClaimCleanId(m.owner_id || m.owner || "", 96);
      const messageId = megaClaimCleanId(m.message_id || m.messageId || m.id || "", 220);
      const fingerprint = megaClaimCleanId(m.fingerprint || "", 96);
      const key = megaClaimKey(room, messageId, fingerprint);
      const ttlSeconds = Math.max(30, Math.min(900, Number(m.ttl_seconds || m.ttl || MEGA_CLAIM_TTL_MS / 1000) || 180));
      const now = Date.now();
      if (!key || !ownerId) {
        megaClaimReply(req, res, 400, { ok: false, error: "missing-message-or-owner" });
        return;
      }
      const existing = megaClaims.get(key);
      if (op === "status") {
        megaClaimReply(req, res, 200, {
          ok: true,
          claimed: !!existing,
          owner_id: existing ? existing.owner_id : "",
          owner_name: existing ? (existing.owner_name || "") : "",
          completed: existing ? !!existing.completed : false,
          expires_at: existing ? existing.expiresAt : 0,
          ts: now
        });
        return;
      }
      if (op === "release") {
        if (existing && existing.owner_id === ownerId) { megaClaims.delete(key); megaClaimMarkDirty(); }
        megaClaimReply(req, res, 200, { ok: true, released: true, owner_id: ownerId, ts: now });
        return;
      }
      if (op === "complete") {
        megaClaims.set(key, {
          owner_id: ownerId,
          owner_name: megaClaimCleanId(m.owner_name || "Vespera", 80),
          room,
          message_id: messageId,
          fingerprint,
          completed: true,
          claimedAt: existing ? existing.claimedAt : now,
          completedAt: now,
          expiresAt: now + Math.max(MEGA_CLAIM_TTL_MS, ttlSeconds * 1000)
        });
        megaClaimMarkDirty();
        megaClaimReply(req, res, 200, { ok: true, completed: true, claimed: true, owner_id: ownerId, ts: now });
        return;
      }
      // Default op: claim. Existing owner wins until TTL expires. A completed
      // claim also blocks duplicate replies for the TTL window.
      if (existing && Number(existing.expiresAt || 0) > now && existing.owner_id && existing.owner_id !== ownerId) {
        megaClaimReply(req, res, 200, {
          ok: true,
          claimed: false,
          owner_id: existing.owner_id,
          owner_name: existing.owner_name || "",
          completed: !!existing.completed,
          expires_at: existing.expiresAt,
          ts: now
        });
        return;
      }
      megaClaims.set(key, {
        owner_id: ownerId,
        owner_name: megaClaimCleanId(m.owner_name || "Vespera", 80),
        room,
        message_id: messageId,
        fingerprint,
        completed: false,
        claimedAt: existing ? existing.claimedAt : now,
        expiresAt: now + ttlSeconds * 1000
      });
      megaClaimMarkDirty();
      megaClaimReply(req, res, 200, { ok: true, claimed: true, owner_id: ownerId, expires_at: now + ttlSeconds * 1000, ts: now });
    });
  } catch (e) {
    try { megaClaimReply(req, res, 500, { ok: false, error: String(e && e.message ? e.message : e).slice(0, 240) }); } catch {}
  }
  return true;
}
// --------------
// Shared helpers
// --------------
function _cleanIP(raw) {
  try {
    let ip = String(raw || "").trim();
    if (!ip) return "";
    if (ip.startsWith("::ffff:")) ip = ip.slice(7);
    const m = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?$/);
    if (m) return m[1];
    return ip;
  } catch {
    return "";
  }
}
function pickIP(req) {
  try {
    const h = (req && req.headers) ? req.headers : {};
    const cands = [];
    const push = (v) => {
      if (!v) return;
      if (Array.isArray(v)) { for (const x of v) push(x); return; }
      cands.push(String(v));
    };
    push(h["cf-connecting-ip"]);
    push(h["x-real-ip"]);
    push(h["x-forwarded-for"]);
    for (const raw of cands) {
      const parts = String(raw || "").split(",").map(s => s.trim()).filter(Boolean);
      for (const p of parts) {
        const ip = _cleanIP(p);
        if (ip && ip !== "::1") return ip;
      }
    }
    const ra = (req && req.socket && req.socket.remoteAddress) ? String(req.socket.remoteAddress) : "";
    return _cleanIP(ra) || "";
  } catch {
    return "";
  }
}
function clamp(n, a, b) {
  n = Number(n);
  if (!Number.isFinite(n)) return a;
  return Math.max(a, Math.min(b, n));
}
function safeRoomId(s, fallback) {
  if (!s) return fallback;
  s = String(s).trim().toLowerCase();
  s = s.replace(/[^a-z0-9_-]/g, "");
  return s.slice(0, 32) || fallback;
}
function rid() {
  return Math.random().toString(36).slice(2, 10);
}
function nowSeed() {
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
}
// ---------------------------------------------------------------------------------------------------------
// GROWTH Frog-Hole / Croakline protocol (gf:...)
// Isolated section for the Bloatfrog home-hosting tutorial.
// Clients send:  gf:{"t":"hello","id":"GF-XXXX","name":"Peatwater Frog-Hole"}
//                gf:{"t":"host","id":"GF-XXXX","name":"...","home_name":"...","world_seed":123,"x":0,"y":0}
//                gf:{"t":"list"}
//                gf:{"t":"join_home","host_id":"GF-XXXX","visitor_id":"GF-YYYY","visitor_name":"..."}
// Server sends:  gf:{"t":"welcome",...} / gf:{"t":"hosts",...} / gf:{"t":"host_ok",...}
//                gf:{"t":"joined_home","host":{...}} / gf:{"t":"visitor_arrived","visitor_name":"..."}
// ---------------------------------------------------------------------------------------------------------
const growthHosts = new Map(); // id -> { id, name, home_name, world_seed, x, y, ws, visitors, snapshot, updatedAt, offlineSince }
const GROWTH_DISCONNECT_GRACE_MS = 15000;
function growthSafeName(s, fb) {
  try {
    const out = String(s || "").replace(/\s+/g, " ").trim().slice(0, 48);
    return out || fb;
  } catch { return fb; }
}
function growthSafeId(s) {
  try {
    const out = String(s || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    return out || ("GF-" + rid());
  } catch { return "GF-" + rid(); }
}
function growthHostPublic(h, viewerWs, includeSnapshot = false) {
  const out = {
    id: String(h.id || ""),
    name: growthSafeName(h.name, "Bloatfrog"),
    home_name: growthSafeName(h.home_name, "Frog-Hole"),
    world_seed: Number(h.world_seed || 0) || 0,
    x: Number(h.x || 0) || 0,
    y: Number(h.y || 0) || 0,
    age: Math.max(0, Math.floor((Date.now() - Number(h.updatedAt || 0)) / 1000)),
    you: !!(viewerWs && h.ws === viewerWs)
  };
  if (includeSnapshot && h.snapshot && typeof h.snapshot === "object") out.snapshot = h.snapshot;
  return out;
}
function growthSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send("gf:" + JSON.stringify(obj)); } catch {}
}
function growthExpireHost(id, h) {
  try {
    for (const v of growthVisitorSockets(h)) {
      growthSend(v, { t: "host_left", host_id: id, ts: Date.now() });
      try { v._growthHostId = ""; } catch {}
    }
  } catch {}
  try { growthHosts.delete(id); } catch {}
}
function growthCleanHosts() {
  const now = Date.now();
  let changed = false;
  for (const [id, h] of [...growthHosts.entries()]) {
    if (!h) { growthHosts.delete(id); changed = true; continue; }
    const open = !!(h.ws && h.ws.readyState === WebSocket.OPEN);
    if (!open) {
      if (!h.offlineSince) h.offlineSince = now;
      if (now - Number(h.offlineSince || now) > GROWTH_DISCONNECT_GRACE_MS) {
        growthExpireHost(id, h);
        changed = true;
      }
      continue;
    }
    h.offlineSince = 0;
    if (now - Number(h.updatedAt || 0) > 180000) {
      growthExpireHost(id, h);
      changed = true;
    }
  }
  return changed;
}
function growthHostsFor(ws) {
  growthCleanHosts();
  return [...growthHosts.values()]
    .filter(h => h && h.ws && h.ws.readyState === WebSocket.OPEN)
    .map(h => growthHostPublic(h, ws))
    .sort((a, b) => (b.you ? 1 : 0) - (a.you ? 1 : 0) || String(a.home_name).localeCompare(String(b.home_name)))
    .slice(0, 80);
}
function growthSendHosts(ws) {
  growthSend(ws, { t: "hosts", hosts: growthHostsFor(ws), ts: Date.now() });
}
function growthBroadcastHosts() {
  growthCleanHosts();
  try {
    for (const c of wss.clients) {
      if (c && c.readyState === WebSocket.OPEN && c._growthSeen) growthSendHosts(c);
    }
  } catch {}
}
function growthVisitorSockets(host) {
  const out = [];
  try {
    if (!host || !host.visitors) return out;
    for (const v of [...host.visitors]) {
      if (v && v.readyState === WebSocket.OPEN) out.push(v);
      else host.visitors.delete(v);
    }
  } catch {}
  return out;
}
function growthCombineEntityPages(layers) {
  const combined = {};
  const enemies = [];
  const food = [];
  const sorted = Array.isArray(layers) ? layers.slice().sort((a, b) => Number(a && a.sync_page || 0) - Number(b && b.sync_page || 0)) : [];
  for (const layer of sorted) {
    if (!layer || typeof layer !== "object") continue;
    for (const [k, v] of Object.entries(layer)) {
      if (k === "enemies" || k === "food") continue;
      if (k === "paged" || k === "sync_seq" || k === "sync_page" || k === "sync_pages" || k === "sync_total_enemies" || k === "sync_total_food") continue;
      if ((k === "dwellings" || k === "quests" || k === "hazards") && Array.isArray(v)) {
        if (!Array.isArray(combined[k])) combined[k] = v;
        continue;
      }
      combined[k] = v;
    }
    if (Array.isArray(layer.enemies)) enemies.push(...layer.enemies);
    if (Array.isArray(layer.food)) food.push(...layer.food);
  }
  combined.enemies = enemies;
  combined.food = food;
  return combined;
}
function growthDetachVisitor(ws, silent = false) {
  if (!ws) return;
  const hostId = String(ws._growthHostId || "");
  if (!hostId) return;
  const host = growthHosts.get(hostId);
  ws._growthHostId = "";
  if (!host || !host.visitors) return;
  host.visitors.delete(ws);
  if (!silent && host.ws && host.ws.readyState === WebSocket.OPEN) {
    growthSend(host.ws, { t: "visitor_left", visitor_id: String(ws._growthId || ""), visitor_name: growthSafeName(ws._growthName, "A visitor"), ts: Date.now() });
  }
  for (const v of growthVisitorSockets(host)) {
    if (v !== ws) growthSend(v, { t: "visitor_left", visitor_id: String(ws._growthId || ""), visitor_name: growthSafeName(ws._growthName, "A visitor"), ts: Date.now() });
  }
}
function growthDetach(ws) {
  if (!ws) return;
  let changed = false;
  growthDetachVisitor(ws, false);
  for (const [id, h] of [...growthHosts.entries()]) {
    if (h && h.ws === ws) {
      h.ws = null;
      h.offlineSince = Date.now();
      changed = true;
      setTimeout(() => { try { growthCleanHosts(); growthBroadcastHosts(); } catch {} }, GROWTH_DISCONNECT_GRACE_MS + 1000);
    }
  }
  ws._growthSeen = false;
  if (changed) growthBroadcastHosts();
}
function growthHandle(ws, payloadStr) {
  let m = null;
  try { m = JSON.parse(String(payloadStr || "")); } catch { m = null; }
  if (!m || typeof m !== "object") return;
  ws._growthSeen = true;
  const t = String(m.t || m.type || "").toLowerCase();
  if (t === "hello") {
    ws._growthId = growthSafeId(m.id || ws._growthId);
    ws._growthName = growthSafeName(m.name || ws._growthName, "Bloatfrog");
    growthSend(ws, { t: "welcome", id: ws._growthId, name: ws._growthName, ts: Date.now() });
    growthSendHosts(ws);
    return;
  }
  if (t === "list") {
    growthSendHosts(ws);
    return;
  }
  if (t === "host") {
    const id = growthSafeId(m.id || ws._growthId);
    ws._growthId = id;
    ws._growthName = growthSafeName(m.name || ws._growthName, "Bloatfrog");
    const homeName = growthSafeName(m.home_name || ws._growthName, "Frog-Hole");
    const prev = growthHosts.get(id) || null;
    const entry = {
      id,
      name: ws._growthName,
      home_name: homeName,
      world_seed: Number(m.world_seed || 0) || 0,
      x: clamp(Number(m.x || 0) || 0, -100000000, 100000000),
      y: clamp(Number(m.y || 0) || 0, -100000000, 100000000),
      ws,
      visitors: (prev && prev.visitors) ? prev.visitors : new Set(),
      snapshot: (m.snapshot && typeof m.snapshot === "object") ? m.snapshot : ((prev && prev.snapshot) || null),
      updatedAt: Date.now(),
      offlineSince: 0
    };
    growthHosts.set(id, entry);
    for (const v of growthVisitorSockets(entry)) {
      try { v._growthHostId = id; } catch {}
      growthSend(v, { t: "visitor_accepted", host_id: id, visitor_id: growthSafeId(v._growthId || ""), reconnect: true, ts: Date.now() });
      if (entry.snapshot && typeof entry.snapshot === "object") growthSend(v, { t: "director_world", host_id: id, snapshot: entry.snapshot, ts: Date.now() });
    }
    growthSend(ws, { t: "host_ok", host: growthHostPublic(entry, ws), ts: Date.now() });
    growthBroadcastHosts();
    return;
  }
  if (t === "host_quit" || t === "director_quit") {
    const hostId = growthSafeId(m.host_id || m.id || ws._growthId || "");
    const host = hostId ? growthHosts.get(hostId) : null;
    if (!host || host.ws !== ws) return;
    const packet = {
      t: "host_left",
      host_id: hostId,
      reason: String(m.reason || "director_quit").slice(0, 48),
      name: growthSafeName(m.name || ws._growthName, "Director"),
      ts: Date.now()
    };
    for (const v of growthVisitorSockets(host)) {
      growthSend(v, packet);
      try { v._growthHostId = ""; } catch {}
    }
    try { if (host.visitors) host.visitors.clear(); } catch {}
    try { growthHosts.delete(hostId); } catch {}
    growthBroadcastHosts();
    return;
  }
  if (t === "join_home") {
    const hostId = growthSafeId(m.host_id || m.id || "");
    growthCleanHosts();
    const host = growthHosts.get(hostId);
    if (!host || !host.ws || host.ws.readyState !== WebSocket.OPEN) {
      growthSend(ws, { t: "error", code: "host_missing", message: "That Sunken Shield director is no longer broadcasting." });
      growthSendHosts(ws);
      return;
    }
    const visitorName = growthSafeName(m.visitor_name || ws._growthName, "A visitor");
    const visitorId = growthSafeId(m.visitor_id || ws._growthId);
    if (host.ws === ws || visitorId === hostId) {
      growthSend(ws, { t: "error", code: "self_join", message: "That is your own Sunken Shield host. Pick another online director." });
      growthSendHosts(ws);
      return;
    }
    ws._growthId = visitorId;
    ws._growthName = visitorName;
    growthDetachVisitor(ws, true);
    ws._growthHostId = hostId;
    if (!host.visitors) host.visitors = new Set();
    host.visitors.add(ws);
    growthSend(ws, { t: "joined_home", host: growthHostPublic(host, ws, false), snapshot: null, ts: Date.now() });
    growthSend(host.ws, { t: "visitor_arrived", visitor_name: visitorName, visitor_id: ws._growthId, ts: Date.now() });
    growthSend(host.ws, { t: "request_world", visitor_name: visitorName, visitor_id: ws._growthId, ts: Date.now() });
    for (const v of growthVisitorSockets(host)) {
      if (v !== ws) growthSend(v, { t: "visitor_arrived", visitor_name: visitorName, visitor_id: ws._growthId, ts: Date.now() });
    }
    return;
  }
  if (t === "resume_visit") {
    const hostId = growthSafeId(m.host_id || ws._growthHostId || "");
    growthCleanHosts();
    const host = hostId ? growthHosts.get(hostId) : null;
    if (!host || !host.ws || host.ws.readyState !== WebSocket.OPEN) {
      growthSend(ws, { t: "error", code: "host_missing", message: "Sunken Shield director is reconnecting or no longer available." });
      return;
    }
    const player = (m.player && typeof m.player === "object") ? m.player : {};
    const visitorId = growthSafeId(m.visitor_id || player.id || ws._growthId);
    ws._growthId = visitorId;
    ws._growthName = growthSafeName(m.visitor_name || m.name || player.name || ws._growthName, "A visitor");
    ws._growthHostId = hostId;
    if (!host.visitors) host.visitors = new Set();
    host.visitors.add(ws);
    growthSend(ws, { t: "visitor_accepted", host_id: hostId, visitor_id: visitorId, reconnect: true, ts: Date.now() });
    if (host.snapshot && typeof host.snapshot === "object") {
      growthSend(ws, { t: "director_world", host_id: hostId, snapshot: host.snapshot, ts: Date.now() });
    }
    if (host.ws && host.ws.readyState === WebSocket.OPEN) {
      growthSend(host.ws, { t: "remote_player", from_id: visitorId, name: ws._growthName, player, reconnect: true, ts: Date.now() });
    }
    return;
  }
  if (t === "visitor_disconnect" || t === "leave_host" || t === "disconnect_host") {
    try {
      const hostId = growthSafeId(m.host_id || ws._growthHostId || "");
      const visitorId = growthSafeId(m.visitor_id || ws._growthId || "");
      const host = hostId ? growthHosts.get(hostId) : null;
      if (host && host.visitors) {
        host.visitors.delete(ws);
        if (host.ws && host.ws.readyState === WebSocket.OPEN) {
          growthSend(host.ws, { t: "visitor_left", visitor_id: visitorId, visitor_name: growthSafeName(m.visitor_name || ws._growthName, "A visitor"), manual: true, ts: Date.now() });
        }
        for (const v of growthVisitorSockets(host)) {
          if (v !== ws) growthSend(v, { t: "visitor_left", visitor_id: visitorId, visitor_name: growthSafeName(m.visitor_name || ws._growthName, "A visitor"), manual: true, ts: Date.now() });
        }
      }
      ws._growthHostId = "";
      growthSend(ws, { t: "visitor_disconnected", host_id: hostId, visitor_id: visitorId, ts: Date.now() });
    } catch {}
    return;
  }
  if (t === "request_world") {
    const hostId = growthSafeId(m.host_id || ws._growthHostId || m.id || "");
    const host = hostId ? growthHosts.get(hostId) : null;
    if (host && host.ws && host.ws.readyState === WebSocket.OPEN) {
      if (host.ws !== ws) {
        growthSend(host.ws, { t: "request_world", visitor_id: growthSafeId(m.visitor_id || ws._growthId), visitor_name: growthSafeName(m.visitor_name || ws._growthName, "A visitor"), ts: Date.now() });
      }
      if (host.snapshot && typeof host.snapshot === "object") {
        growthSend(ws, { t: "director_world", host_id: hostId, snapshot: host.snapshot, ts: Date.now() });
      }
    }
    return;
  }
  if (t === "director_player") {
    const id = growthSafeId(m.id || ws._growthId);
    const host = growthHosts.get(id);
    if (!host || host.ws !== ws) return;
    ws._growthId = id;
    ws._growthName = growthSafeName(m.name || ws._growthName, "Bloatfrog");
    const player = (m.player && typeof m.player === "object") ? m.player : {};
    const packet = { t: "director_player", host_id: id, from_id: id, name: ws._growthName, player, ts: Date.now() };
    for (const v of growthVisitorSockets(host)) growthSend(v, packet);
    return;
  }
  if (t === "entity_update") {
    const id = growthSafeId(m.id || ws._growthId);
    const host = growthHosts.get(id);
    if (!host || host.ws !== ws) return;
    if (m.layer && typeof m.layer === "object") {
      const layer = m.layer;
      host.updatedAt = Date.now();
      try {
        host.world_seed = Number(layer.world_seed || host.world_seed || 0) || host.world_seed || 0;
        host.x = clamp(Number(layer.home_x || host.x || 0) || 0, -100000000, 100000000);
        host.y = clamp(Number(layer.home_y || host.y || 0) || 0, -100000000, 100000000);
      } catch {}
      if (layer.paged) {
        const seq = String(layer.sync_seq || "");
        const page = Math.max(0, Math.floor(Number(layer.sync_page || 0) || 0));
        const pages = Math.max(1, Math.floor(Number(layer.sync_pages || 1) || 1));
        if (!host.entityPageBuf || host.entityPageBuf.seq !== seq || host.entityPageBuf.pages !== pages) {
          host.entityPageBuf = { seq, pages, layers: new Map(), at: Date.now() };
        }
        if (page < pages) host.entityPageBuf.layers.set(page, layer);
        host.entityPageBuf.at = Date.now();
        if (host.entityPageBuf.layers.size >= pages) {
          const ordered = [];
          for (let i = 0; i < pages; i++) ordered.push(host.entityPageBuf.layers.get(i));
          const combined = growthCombineEntityPages(ordered);
          host.snapshot = Object.assign({}, host.snapshot || {}, combined);
          host.entityPageBuf = null;
        }
      } else {
        host.snapshot = Object.assign({}, host.snapshot || {}, layer);
      }
      for (const v of growthVisitorSockets(host)) growthSend(v, { t: "director_entities", host_id: id, layer, ts: Date.now() });
    }
    return;
  }
  if (t === "world_update") {
    const id = growthSafeId(m.id || ws._growthId);
    const host = growthHosts.get(id);
    if (!host || host.ws !== ws) return;
    if (m.snapshot && typeof m.snapshot === "object") {
      host.snapshot = m.snapshot;
      host.updatedAt = Date.now();
      try {
        host.world_seed = Number(m.snapshot.world_seed || host.world_seed || 0) || host.world_seed || 0;
        host.x = clamp(Number(m.snapshot.home_x || host.x || 0) || 0, -100000000, 100000000);
        host.y = clamp(Number(m.snapshot.home_y || host.y || 0) || 0, -100000000, 100000000);
      } catch {}
      for (const v of growthVisitorSockets(host)) growthSend(v, { t: "director_world", host_id: id, snapshot: host.snapshot, ts: Date.now() });
    }
    return;
  }
  if (t === "player_update") {
    const player = (m.player && typeof m.player === "object") ? m.player : {};
    const fromId = growthSafeId(m.id || player.id || ws._growthId);
    ws._growthId = fromId;
    ws._growthName = growthSafeName(m.name || player.name || ws._growthName, "Bloatfrog");
    const hostId = String(ws._growthHostId || "");
    const host = hostId ? growthHosts.get(hostId) : null;
    if (!host) return;
    const packet = { t: "remote_player", from_id: fromId, name: ws._growthName, player, ts: Date.now() };
    if (host.ws && host.ws !== ws) growthSend(host.ws, packet);
    for (const v of growthVisitorSockets(host)) {
      if (v !== ws) growthSend(v, packet);
    }
    return;
  }
  if (t === "visitor_tongue") {
    const hostId = growthSafeId(m.host_id || ws._growthHostId || "");
    const host = hostId ? growthHosts.get(hostId) : null;
    if (!host || !host.ws || host.ws.readyState !== WebSocket.OPEN) {
      growthSend(ws, { t: "error", code: "host_missing", message: "Sunken Shield director is no longer available." });
      return;
    }
    const player = (m.player && typeof m.player === "object") ? m.player : {};
    const visitorId = growthSafeId(m.visitor_id || player.id || ws._growthId);
    ws._growthId = visitorId;
    ws._growthName = growthSafeName(m.visitor_name || m.name || player.name || ws._growthName, "A visitor");
    if (!host.visitors) host.visitors = new Set();
    host.visitors.add(ws);
    ws._growthHostId = hostId;
    growthSend(host.ws, {
      t: "visitor_tongue",
      host_id: hostId,
      visitor_id: visitorId,
      visitor_name: ws._growthName,
      player,
      sx: Number(m.sx || 0) || 0,
      sy: Number(m.sy || 0) || 0,
      target_x: Number(m.target_x || 0) || 0,
      target_y: Number(m.target_y || 0) || 0,
      max_range: Number(m.max_range || 0) || 0,
      kinetic: Number(m.kinetic || 0) || 0,
      toxicity: Number(m.toxicity || 0) || 0,
      chaos: Number(m.chaos || 0) || 0,
      soda_extra: Number(m.soda_extra || 0) || 0,
      soda_note: String(m.soda_note || "").slice(0, 80),
      client_hit_uid: String(m.client_hit_uid || "").slice(0, 96),
      client_hit_type: String(m.client_hit_type || "").slice(0, 16),
      castle_active: !!m.castle_active,
      castle_floor: Number(m.castle_floor || -1) || -1,
      mode: String(m.mode || "").slice(0, 24),
      request_id: String(m.request_id || "").slice(0, 96),
      ts: Date.now()
    });
    return;
  }
  if (t === "visitor_decision") {
    const hostId = growthSafeId(m.host_id || ws._growthId || "");
    const host = hostId ? growthHosts.get(hostId) : null;
    if (!host || host.ws !== ws) return;
    const visitorId = growthSafeId(m.visitor_id || "");
    const accepted = !!m.accepted;
    let target = null;
    for (const v of growthVisitorSockets(host)) {
      if (growthSafeId(v._growthId || "") === visitorId) { target = v; break; }
    }
    if (!target) return;
    if (accepted) {
      growthSend(target, { t: "visitor_accepted", host_id: hostId, visitor_id: visitorId, ts: Date.now() });
      growthSend(ws, { t: "visitor_accepted_ack", visitor_id: visitorId, ts: Date.now() });
      if (host.snapshot && typeof host.snapshot === "object") {
        growthSend(target, { t: "director_world", host_id: hostId, snapshot: host.snapshot, ts: Date.now() });
      }
      return;
    }
    growthSend(target, { t: "visitor_rejected", host_id: hostId, visitor_id: visitorId, message: "The director ignored the alcove request.", ts: Date.now() });
    try { if (host.visitors) host.visitors.delete(target); } catch {}
    try { target._growthHostId = ""; } catch {}
    for (const v of growthVisitorSockets(host)) {
      if (v !== target) growthSend(v, { t: "visitor_left", visitor_id: visitorId, visitor_name: growthSafeName(target._growthName, "A visitor"), ts: Date.now() });
    }
    return;
  }
  if (t === "castle_grate_request") {
    const hostId = growthSafeId(m.host_id || ws._growthHostId || "");
    const host = hostId ? growthHosts.get(hostId) : null;
    if (!host || !host.ws || host.ws.readyState !== WebSocket.OPEN) {
      growthSend(ws, { t: "error", code: "host_missing", message: "Sunken Shield director is no longer available." });
      return;
    }
    const player = (m.player && typeof m.player === "object") ? m.player : {};
    const visitorId = growthSafeId(m.visitor_id || player.id || ws._growthId);
    ws._growthId = visitorId;
    ws._growthName = growthSafeName(m.visitor_name || m.name || player.name || ws._growthName, "A visitor");
    if (!host.visitors) host.visitors = new Set();
    host.visitors.add(ws);
    ws._growthHostId = hostId;
    growthSend(host.ws, {
      t: "castle_grate_request",
      host_id: hostId,
      visitor_id: visitorId,
      visitor_name: ws._growthName,
      floor: Number(m.floor || 0) || 0,
      direction: Number(m.direction || 0) || 0,
      ts: Date.now()
    });
    return;
  }
  if (t === "castle_exit_request") {
    const hostId = growthSafeId(m.host_id || ws._growthHostId || "");
    const host = hostId ? growthHosts.get(hostId) : null;
    if (!host || !host.ws || host.ws.readyState !== WebSocket.OPEN) {
      growthSend(ws, { t: "error", code: "host_missing", message: "Sunken Shield director is no longer available." });
      return;
    }
    const visitorId = growthSafeId(m.visitor_id || ws._growthId);
    ws._growthId = visitorId;
    ws._growthName = growthSafeName(m.visitor_name || m.name || ws._growthName, "A visitor");
    if (!host.visitors) host.visitors = new Set();
    host.visitors.add(ws);
    ws._growthHostId = hostId;
    growthSend(host.ws, {
      t: "castle_exit_request",
      host_id: hostId,
      visitor_id: visitorId,
      visitor_name: ws._growthName,
      ts: Date.now()
    });
    return;
  }
  if (t === "castle_exit") {
    const hostId = growthSafeId(m.host_id || ws._growthId || "");
    const host = hostId ? growthHosts.get(hostId) : null;
    if (!host || host.ws !== ws) return;
    const packet = {
      t: "castle_exit",
      host_id: hostId,
      reason: String(m.reason || "exit_grate").slice(0, 48),
      requested_by: growthSafeName(m.requested_by || "", ""),
      ts: Date.now()
    };
    for (const v of growthVisitorSockets(host)) {
      growthSend(v, packet);
      try { v._growthHostId = ""; } catch {}
    }
    try { if (host.visitors) host.visitors.clear(); } catch {}
    return;
  }
  if (t === "sluagh_request") {
    const hostId = growthSafeId(m.host_id || ws._growthHostId || ws._growthId || "");
    const host = hostId ? growthHosts.get(hostId) : null;
    if (!host || !host.ws || host.ws.readyState !== WebSocket.OPEN) {
      growthSend(ws, { t: "error", code: "host_missing", message: "Sluagh host is no longer available." });
      return;
    }
    const fromId = growthSafeId(m.from_id || ws._growthId || "");
    ws._growthId = fromId;
    ws._growthName = growthSafeName(m.name || ws._growthName, "Bloatfrog");
    const packet = {
      t: "sluagh_request", host_id: hostId, from_id: fromId, name: ws._growthName,
      size_percent: Number(m.size_percent || 100) || 100,
      max_size: Number(m.max_size || 90) || 90,
      hole_uid: String(m.hole_uid || "").slice(0, 96), floor: Number(m.floor || 0) || 0,
      x: Number(m.x || 0) || 0, y: Number(m.y || 0) || 0, ts: Date.now()
    };
    if (host.ws !== ws) growthSend(host.ws, packet);
    for (const v of growthVisitorSockets(host)) if (v !== ws) growthSend(v, packet);
    return;
  }
  if (t === "sluagh_response") {
    const hostId = growthSafeId(m.host_id || ws._growthHostId || ws._growthId || "");
    const host = hostId ? growthHosts.get(hostId) : null;
    if (!host) return;
    const fromId = growthSafeId(m.from_id || ws._growthId || "");
    const toId = growthSafeId(m.to_id || "");
    const packet = {
      t: "sluagh_response", host_id: hostId, from_id: fromId, to_id: toId, accepted: !!m.accepted,
      reason: String(m.reason || "").slice(0, 48),
      who: String(m.who || "").slice(0, 48),
      need: Number(m.need || 0) || 0,
      message: String(m.message || "").slice(0, 180),
      request: (m.request && typeof m.request === "object") ? m.request : {},
      name: growthSafeName(m.name || ws._growthName, "Bloatfrog"),
      size_percent: Number(m.size_percent || 100) || 100,
      max_size: Number(m.max_size || 73.5) || 73.5,
      ts: Date.now()
    };
    if (host.ws && host.ws.readyState === WebSocket.OPEN && host.ws !== ws) growthSend(host.ws, packet);
    for (const v of growthVisitorSockets(host)) {
      if (v !== ws && (!toId || growthSafeId(v._growthId || "") === toId)) growthSend(v, packet);
    }
    return;
  }
  if (t === "sluagh_start" || t === "sluagh_state" || t === "sluagh_end" || t === "sluagh_combat_fx") {
    const hostId = growthSafeId(m.host_id || ws._growthId || "");
    const host = hostId ? growthHosts.get(hostId) : null;
    if (!host || host.ws !== ws) return;
    const packet = Object.assign({}, m, { host_id: hostId, ts: Date.now() });
    for (const v of growthVisitorSockets(host)) growthSend(v, packet);
    return;
  }
  if (t === "sluagh_player") {
    const hostId = growthSafeId(m.host_id || ws._growthHostId || ws._growthId || "");
    const host = hostId ? growthHosts.get(hostId) : null;
    if (!host) return;
    const fromId = growthSafeId(m.from_id || ws._growthId || "");
    const packet = {
      t: "sluagh_player",
      host_id: hostId,
      from_id: fromId,
      name: growthSafeName(m.name || ws._growthName || "Frog", "Frog"),
      x: Number(m.x || 0) || 0,
      y: Number(m.y || 0) || 0,
      ts: Date.now()
    };
    if (host.ws && host.ws.readyState === WebSocket.OPEN && host.ws !== ws) growthSend(host.ws, packet);
    for (const v of growthVisitorSockets(host)) if (v !== ws) growthSend(v, packet);
    return;
  }
  if (t === "sluagh_tongue") {
    const hostId = growthSafeId(m.host_id || ws._growthHostId || "");
    const host = hostId ? growthHosts.get(hostId) : null;
    if (!host || !host.ws || host.ws.readyState !== WebSocket.OPEN) return;
    const packet = { t: "sluagh_tongue", host_id: hostId, from_id: growthSafeId(m.from_id || ws._growthId || ""), shot: (m.shot && typeof m.shot === "object") ? m.shot : {}, ts: Date.now() };
    growthSend(host.ws, packet);
    return;
  }
  if (t === "castle_chat" || t === "chat") {
    const hostId = growthSafeId(m.host_id || ws._growthHostId || m.id || ws._growthId || "");
    const host = hostId ? growthHosts.get(hostId) : null;
    if (!host) return;
    const senderId = growthSafeId(m.id || ws._growthId || "");
    ws._growthId = senderId;
    ws._growthName = growthSafeName(m.name || ws._growthName, senderId || "FROG");
    const msg = String(m.msg || m.message || "").replace(/\r?\n/g, " ").trim().slice(0, 220);
    if (!msg) return;
    const mid = String(m.mid || (senderId + "-" + Date.now() + "-" + rid())).slice(0, 80);
    const packet = { t: "castle_chat", host_id: host.id, id: senderId, name: ws._growthName, msg, mid, ts: Date.now() };
    if (host.ws && host.ws.readyState === WebSocket.OPEN) growthSend(host.ws, packet);
    for (const v of growthVisitorSockets(host)) growthSend(v, packet);
    return;
  }
  if (t === "castle_xp_share") {
    const hostId = growthSafeId(m.host_id || ws._growthId || "");
    const host = hostId ? growthHosts.get(hostId) : null;
    if (!host || host.ws !== ws) return;
    const amount = Math.max(0, Math.floor(Number(m.amount || 0) || 0));
    if (amount <= 0) return;
    const packet = {
      t: "castle_xp_share",
      host_id: hostId,
      amount,
      reason: String(m.reason || "Sunken Shield kill").slice(0, 80),
      ts: Date.now()
    };
    for (const v of growthVisitorSockets(host)) growthSend(v, packet);
    return;
  }
  if (t === "castle_quest_event") {
    const hostId = growthSafeId(m.host_id || ws._growthId || ws._growthHostId || "");
    const host = hostId ? growthHosts.get(hostId) : null;
    if (!host) return;
    const event = String(m.event || "").slice(0, 80);
    if (!event) return;
    const packet = { t: "castle_quest_event", host_id: hostId, event, ts: Date.now() };
    if (host.ws && host.ws.readyState === WebSocket.OPEN && host.ws !== ws) growthSend(host.ws, packet);
    for (const v of growthVisitorSockets(host)) growthSend(v, packet);
    return;
  }
  if (t === "visitor_action_result") {
    const hostId = growthSafeId(m.host_id || ws._growthId || "");
    const host = hostId ? growthHosts.get(hostId) : null;
    if (!host || host.ws !== ws) return;
    const visitorId = growthSafeId(m.visitor_id || "");
    const packet = {
      t: "visitor_action_result",
      host_id: hostId,
      visitor_id: visitorId,
      result: (m.result && typeof m.result === "object") ? m.result : {},
      ts: Date.now()
    };
    let delivered = false;
    for (const v of growthVisitorSockets(host)) {
      if (growthSafeId(v._growthId || "") === visitorId) {
        growthSend(v, packet);
        delivered = true;
      }
    }
    if (!delivered) {
      for (const v of growthVisitorSockets(host)) growthSend(v, packet);
    }
    return;
  }
  if (t === "ping") {
    growthSend(ws, { t: "pong", ts: Date.now() });
    return;
  }
}
// -------------------------------------------------------------------------------
// ALMIGHTY PYTHON // Velvet Byte multiplayer lobby
// Protocol prefix: ap:
// Four players per lobby. The first connected player is the Real Almighty Python;
// the other three are story-canon clones.
// -------------------------------------------------------------------------------
const almightyPythonRooms = new Map();
let almightyPythonRoomCounter = 1;
let almightyPythonPartyCounter = 1;
const ALMIGHTY_PYTHON_MAX_PLAYERS = 4;
const ALMIGHTY_PYTHON_TTL_MS = 15000;
const ALMIGHTY_PYTHON_HIDEOUT_ENTRY_RADIUS = 2.0;
const ALMIGHTY_PYTHON_HIDEOUT_STOP_SPEED = 0.08;
const ALMIGHTY_PYTHON_ENTRY_PRESENCE_MAX_AGE_MS = 2500;
const ALMIGHTY_PYTHON_MISSION_DISCONNECT_MS = 5 * 60 * 1000;
function almightyPythonSafeId(value) {
  const out = String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return out || ("AP-" + rid());
}
function almightyPythonSafeName(value) {
  const out = String(value || "Almighty Python").replace(/\s+/g, " ").trim().slice(0, 28);
  return out || "Almighty Python";
}
function almightyPythonSafeMessage(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 420);
}
function almightyPythonSafeMid(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 96) || ("APM-" + rid());
}
function almightyPythonChooseRoom() {
  for (const room of almightyPythonRooms.values()) {
    if (room && room.clients && room.clients.size < ALMIGHTY_PYTHON_MAX_PLAYERS) return room;
  }
  const name = "velvet-byte-" + String(almightyPythonRoomCounter++);
  const room = { name, clients: new Map(), joinedOrder: [], hostId: "", hideouts: new Map() };
  almightyPythonRooms.set(name, room);
  return room;
}
function almightyPythonSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
}
function almightyPythonFinite(value, fallback = 0, limit = 10000000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Number(fallback) || 0;
  return Math.max(-limit, Math.min(limit, n));
}
function almightyPythonSafeScene(value) {
  const scene = String(value || "velvet_byte").toLowerCase();
  return ["velvet_byte", "ride", "hideout"].includes(scene) ? scene : "velvet_byte";
}
function almightyPythonSafeHand(value) {
  const hand = String(value || "").toLowerCase();
  return hand === "left" || hand === "right" ? hand : "";
}
function almightyPythonPublicPlayer(client, room) {
  return {
    t: "presence",
    game: "almighty_python",
    room: String(room && room.name || ""),
    id: String(client && client.id || ""),
    name: almightyPythonSafeName(client && client.name),
    x: almightyPythonFinite(client && client.x, 12.0),
    y: almightyPythonFinite(client && client.y, 15.25),
    angle: almightyPythonFinite(client && client.angle, -1.5707963, 100000),
    moving: !!(client && client.moving),
    scene: almightyPythonSafeScene(client && client.scene),
    speed: almightyPythonFinite(client && client.speed, 0, 1000),
    lean: Math.max(-1, Math.min(1, almightyPythonFinite(client && client.lean, 0, 1))),
    fists_drawn: !!(client && client.fistsDrawn),
    punch_hand: almightyPythonSafeHand(client && client.punchHand),
    punch_progress: Math.max(0, Math.min(1, almightyPythonFinite(client && client.punchProgress, 0, 1))),
    hideout_id: String(client && client.hideoutId || "").slice(0, 96),
    party_id: String(client && client.partyId || ""),
    host: !!(room && String(room.hostId || "") === String(client && client.id || "")),
    host_id: String(room && room.hostId || ""),
    ts: Date.now()
  };
}
function almightyPythonMissionForClient(room, client) {
  if (!room || !room.hideouts || !client || !client.partyId) return null;
  const mission = room.hideouts.get(String(client.partyId || ""));
  return mission ? Object.assign({}, mission) : null;
}
function almightyPythonSnapshot(room, ws = null, kind = "snapshot") {
  if (!room || !room.clients) return;
  const players = [...room.clients.values()].slice(0, ALMIGHTY_PYTHON_MAX_PLAYERS).map(c => almightyPythonPublicPlayer(c, room));
  const sendOne = (client) => {
    if (!client) return;
    const packet = { t: kind, game: "almighty_python", room: room.name, host_id: String(room.hostId || ""), players, ts: Date.now() };
    const mission = almightyPythonMissionForClient(room, client);
    if (mission) packet.hideout = mission;
    almightyPythonSend(client.ws, packet);
  };
  if (ws) {
    const client = [...room.clients.values()].find(c => c && c.ws === ws);
    if (client) sendOne(client);
  } else {
    for (const c of room.clients.values()) sendOne(c);
  }
}
function almightyPythonPartyBroadcast(room, partyId, packet) {
  for (const member of almightyPythonPartyMembers(room, partyId)) almightyPythonSend(member.ws, packet);
}
function almightyPythonCancelHideout(room, partyId, mission, reason) {
  if (!room || !mission) return false;
  const packet = { t: "hideout_cancelled", game: "almighty_python", room: room.name,
    hideout_id: String(mission.id || ""), reason: String(reason || "TEAM MISSION CANCELLED").slice(0, 120), ts: Date.now() };
  for (const client of room.clients.values()) {
    if (String(client.partyId || "") === String(partyId || "") || (Array.isArray(mission.member_ids) && mission.member_ids.includes(client.id))) almightyPythonSend(client.ws, packet);
  }
  if (room.hideouts) room.hideouts.delete(String(partyId || ""));
  for (const client of room.clients.values()) if (String(client.partyId || "") === String(partyId || "")) client.partyId = "";
  return true;
}
function almightyPythonPromoteHost(room) {
  if (!room || !room.clients) return;
  room.joinedOrder = (room.joinedOrder || []).filter(id => room.clients.has(id));
  if (!room.hostId || !room.clients.has(room.hostId)) room.hostId = room.joinedOrder[0] || "";
}
function almightyPythonNormalizeParties(room) {
  if (!room || !room.clients) return;
  const groups = new Map();
  for (const client of room.clients.values()) {
    const partyId = String(client && client.partyId || "");
    if (!partyId) continue;
    if (!groups.has(partyId)) groups.set(partyId, []);
    groups.get(partyId).push(client);
  }
  for (const [partyId, members] of groups.entries()) {
    const activeMission = room.hideouts ? room.hideouts.get(partyId) : null;
    let missionMissing = [];
    if (activeMission && String(activeMission.status || "active") === "active") {
      const expected = Array.isArray(activeMission.member_ids) ? activeMission.member_ids.map(String) : [];
      const connected = new Set(members.map(member => String(member.id || "")));
      missionMissing = expected.filter(id => !connected.has(id));
      if (missionMissing.length) {
        if (!Number(activeMission.disconnect_since || 0)) activeMission.disconnect_since = Date.now();
        if (Date.now() - Number(activeMission.disconnect_since || 0) >= ALMIGHTY_PYTHON_MISSION_DISCONNECT_MS) {
          almightyPythonCancelHideout(room, partyId, activeMission, "TEAMMATE DISCONNECTED FOR MORE THAN FIVE MINUTES");
          continue;
        }
      } else {
        activeMission.disconnect_since = 0;
      }
    }
    if (members.length < 2) {
      if (activeMission && missionMissing.length) continue;
      for (const client of members) client.partyId = "";
      if (room.hideouts) room.hideouts.delete(partyId);
      continue;
    }
    const mission = room.hideouts ? room.hideouts.get(partyId) : null;
    if (mission && String(mission.status || "active") === "complete") {
      const returned = mission.returned && typeof mission.returned === "object" ? mission.returned : {};
      if (members.every(member => !!returned[member.id])) {
        room.hideouts.delete(partyId);
        almightyPythonPartyBroadcast(room, partyId, { t: "hideout_cleared", game: "almighty_python", room: room.name, hideout_id: String(mission.id || ""), ts: Date.now() });
        continue;
      }
    }
    if (mission && !members.some(member => member.id === String(mission.authority_id || ""))) {
      const replacement = members.find(member => member.id === String(room.hostId || "")) || members[0];
      mission.authority_id = String(replacement && replacement.id || "");
    }
  }
  if (room.hideouts) {
    for (const partyId of [...room.hideouts.keys()]) if (!groups.has(partyId)) room.hideouts.delete(partyId);
  }
}
function almightyPythonPartyMembers(room, partyId) {
  const id = String(partyId || "");
  if (!room || !room.clients || !id) return [];
  return [...room.clients.values()].filter(client => String(client && client.partyId || "") === id);
}
function almightyPythonDetach(ws, announce = true) {
  const id = String(ws && ws._almightyPythonId || "");
  const roomName = String(ws && ws._almightyPythonRoom || "");
  if (!id || !roomName) return;
  const room = almightyPythonRooms.get(roomName);
  if (room && room.clients) {
    const client = room.clients.get(id);
    if (client && client.ws === ws) room.clients.delete(id);
    room.joinedOrder = (room.joinedOrder || []).filter(value => value !== id);
    almightyPythonNormalizeParties(room);
    almightyPythonPromoteHost(room);
    if (announce) {
      const packet = { t: "peer_left", game: "almighty_python", room: room.name, id, host_id: String(room.hostId || ""), ts: Date.now() };
      for (const c of room.clients.values()) almightyPythonSend(c.ws, packet);
      almightyPythonSnapshot(room);
    }
    if (room.clients.size === 0) almightyPythonRooms.delete(roomName);
  }
  ws._almightyPythonId = "";
  ws._almightyPythonRoom = "";
}
function almightyPythonJoin(ws, message) {
  almightyPythonDetach(ws, false);
  const id = almightyPythonSafeId(message.id);
  const room = almightyPythonChooseRoom();
  const previous = room.clients.get(id);
  if (previous && previous.ws && previous.ws !== ws) {
    try { previous.ws.close(4001, "Reconnected"); } catch {}
    room.clients.delete(id);
    room.joinedOrder = room.joinedOrder.filter(value => value !== id);
  }
  const client = {
    id,
    name: almightyPythonSafeName(message.name),
    ws,
    x: 12.0,
    y: 15.25,
    angle: -1.5707963,
    moving: false,
    scene: "velvet_byte",
    speed: 0,
    lean: 0,
    fistsDrawn: false,
    punchHand: "",
    punchProgress: 0,
    hideoutId: "",
    partyId: "",
    lastSeen: Date.now()
  };
  if (room.hideouts) {
    for (const [partyId, mission] of room.hideouts.entries()) {
      if (mission && String(mission.status || "active") === "active" && Array.isArray(mission.member_ids) && mission.member_ids.map(String).includes(id)) {
        client.partyId = String(partyId || "");
        mission.disconnect_since = 0;
        break;
      }
    }
  }
  room.clients.set(id, client);
  room.joinedOrder.push(id);
  if (!room.hostId) room.hostId = id;
  ws._almightyPythonId = id;
  ws._almightyPythonRoom = room.name;
  almightyPythonSnapshot(room, ws, "welcome");
  almightyPythonSnapshot(room);
  return client;
}
function almightyPythonHandle(ws, payload) {
  let message = null;
  try { message = JSON.parse(String(payload || "")); } catch { message = null; }
  if (!message || typeof message !== "object") return;
  const kind = String(message.t || message.type || "").toLowerCase();
  if (kind === "join" || kind === "hello") {
    almightyPythonJoin(ws, message);
    return;
  }
  if (!ws._almightyPythonId || !ws._almightyPythonRoom) almightyPythonJoin(ws, message);
  const room = almightyPythonRooms.get(String(ws._almightyPythonRoom || ""));
  const client = room && room.clients ? room.clients.get(String(ws._almightyPythonId || "")) : null;
  if (!room || !client) return;
  client.lastSeen = Date.now();
  if (kind === "presence" || kind === "move") {
    client.scene = almightyPythonSafeScene(message.scene != null ? message.scene : client.scene);
    client.x = almightyPythonFinite(message.x != null ? message.x : client.x, client.x);
    client.y = almightyPythonFinite(message.y != null ? message.y : client.y, client.y);
    if (client.scene === "velvet_byte" || client.scene === "hideout") {
      client.x = Math.max(1.1, Math.min(22.9, client.x));
      client.y = Math.max(1.1, Math.min(15.8, client.y));
    }
    client.angle = almightyPythonFinite(message.angle != null ? message.angle : client.angle, client.angle, 100000);
    client.moving = !!message.moving;
    client.speed = almightyPythonFinite(message.speed != null ? message.speed : client.speed, client.speed, 1000);
    client.lean = Math.max(-1, Math.min(1, almightyPythonFinite(message.lean != null ? message.lean : client.lean, client.lean, 1)));
    client.fistsDrawn = !!message.fists_drawn;
    client.punchHand = almightyPythonSafeHand(message.punch_hand);
    client.punchProgress = Math.max(0, Math.min(1, almightyPythonFinite(message.punch_progress, 0, 1)));
    client.hideoutId = String(message.hideout_id || "").slice(0, 96);
    const packet = almightyPythonPublicPlayer(client, room);
    for (const c of room.clients.values()) if (c.ws !== ws) almightyPythonSend(c.ws, packet);
    return;
  }
  if (kind === "chat" || kind === "msg") {
    const targetId = almightyPythonSafeId(message.to || message.target_id || message.target);
    const target = room.clients.get(targetId);
    const msg = almightyPythonSafeMessage(message.msg != null ? message.msg : message.text);
    if (!target || target.id === client.id || !msg) return;
    const packet = {
      t: "chat",
      game: "almighty_python",
      room: room.name,
      from: client.id,
      to: target.id,
      name: almightyPythonSafeName(client.name),
      msg,
      mid: almightyPythonSafeMid(message.mid),
      ts: Date.now()
    };
    almightyPythonSend(client.ws, packet);
    almightyPythonSend(target.ws, packet);
    return;
  }
  if (kind === "team_up" || kind === "party_join") {
    const targetId = almightyPythonSafeId(message.target_id || message.to || message.target);
    const target = room.clients.get(targetId);
    if (!target || target.id === client.id) return;
    if (client.partyId && client.partyId === target.partyId) {
      almightyPythonSnapshot(room);
      return;
    }
    const leftParty = String(client.partyId || "");
    const rightParty = String(target.partyId || "");
    const left = leftParty ? almightyPythonPartyMembers(room, leftParty) : [client];
    const right = rightParty ? almightyPythonPartyMembers(room, rightParty) : [target];
    const merged = [];
    const seen = new Set();
    for (const member of [...left, ...right, client, target]) {
      if (!member || seen.has(member.id)) continue;
      seen.add(member.id);
      merged.push(member);
    }
    if (merged.length > ALMIGHTY_PYTHON_MAX_PLAYERS) return;
    const partyId = String(leftParty || rightParty || ("python-party-" + String(almightyPythonPartyCounter++)));
    let inheritedMission = null;
    if (room.hideouts) inheritedMission = room.hideouts.get(leftParty) || room.hideouts.get(rightParty) || null;
    for (const member of merged) member.partyId = partyId;
    if (room.hideouts) {
      if (leftParty && leftParty !== partyId) room.hideouts.delete(leftParty);
      if (rightParty && rightParty !== partyId) room.hideouts.delete(rightParty);
      if (inheritedMission) {
        inheritedMission.party_id = partyId;
        room.hideouts.set(partyId, inheritedMission);
      }
    }
    almightyPythonNormalizeParties(room);
    almightyPythonSnapshot(room, null, "party");
    return;
  }
  if (kind === "kick_ass" || kind === "hideout_request") {
    const partyId = String(client.partyId || "");
    const members = almightyPythonPartyMembers(room, partyId);
    if (!partyId || members.length < 2) return;
    let mission = room.hideouts ? room.hideouts.get(partyId) : null;
    if (!mission) {
      const raw = message.hideout && typeof message.hideout === "object" ? message.hideout : {};
      const id = String(raw.id || ("hideout-" + rid())).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 96);
      const authority = members.find(member => member.id === room.hostId) || client;
      mission = {
        id: id || ("hideout-" + rid()),
        name: String(raw.name || "Snake City Hideout").replace(/\s+/g, " ").trim().slice(0, 72) || "Snake City Hideout",
        seed: Math.abs(Math.trunc(almightyPythonFinite(raw.seed, Date.now(), 2147483647))),
        entrance_x: almightyPythonFinite(raw.entrance_x, client.x),
        entrance_y: almightyPythonFinite(raw.entrance_y, client.y),
        wall_x: almightyPythonFinite(raw.wall_x, client.x),
        wall_y: almightyPythonFinite(raw.wall_y, client.y),
        facing: almightyPythonFinite(raw.facing, client.angle, 100000),
        origin_x: almightyPythonFinite(raw.origin_x, client.x),
        origin_y: almightyPythonFinite(raw.origin_y, client.y),
        enemy_count: Math.max(8, Math.min(14, Number(raw.enemy_count || (6 + members.length * 2)) | 0)),
        floor_count: Math.max(3, Math.min(5, Number(raw.floor_count || 3) | 0)),
        status: "active",
        party_id: partyId,
        authority_id: String(authority.id || client.id),
        member_ids: members.map(member => String(member.id || "")).filter(Boolean),
        defeated: {},
        disconnect_since: 0,
        created_at: Date.now()
      };
      if (!room.hideouts) room.hideouts = new Map();
      room.hideouts.set(partyId, mission);
    }
    almightyPythonPartyBroadcast(room, partyId, { t: "hideout", game: "almighty_python", room: room.name, hideout: Object.assign({}, mission), ts: Date.now() });
    almightyPythonSnapshot(room);
    return;
  }
  if (kind === "hideout_enter" || kind === "hideout_entry") {
    const partyId = String(client.partyId || "");
    const members = almightyPythonPartyMembers(room, partyId);
    const mission = room.hideouts && room.hideouts.get(partyId);
    const requestedId = String(message.hideout_id || "").slice(0, 96);
    const deny = (reason) => almightyPythonSend(client.ws, {
      t: "hideout_enter_denied",
      game: "almighty_python",
      room: room.name,
      hideout_id: requestedId,
      reason: String(reason || "BOTH PLAYERS MUST BE AT THE DOOR AND STOPPED").slice(0, 96),
      ts: Date.now()
    });
    if (!partyId || members.length < 2 || !mission || mission.status !== "active" || requestedId !== String(mission.id || "")) {
      deny("HIDEOUT PARTY LINK NOT READY");
      return;
    }
    const now = Date.now();
    let failure = "";
    for (const member of members) {
      if (!member || now - Number(member.lastSeen || 0) > ALMIGHTY_PYTHON_ENTRY_PRESENCE_MAX_AGE_MS) {
        failure = "WAITING FOR BOTH PLAYERS AT THE HIDEOUT DOOR";
        break;
      }
      if (almightyPythonSafeScene(member.scene) !== "ride" || String(member.hideoutId || "") !== String(mission.id || "")) {
        failure = "BOTH PLAYERS MUST BE AT THE SAME HIDEOUT DOOR";
        break;
      }
      const dx = almightyPythonFinite(member.x, 0) - almightyPythonFinite(mission.entrance_x, 0);
      const dy = almightyPythonFinite(member.y, 0) - almightyPythonFinite(mission.entrance_y, 0);
      if (Math.hypot(dx, dy) > ALMIGHTY_PYTHON_HIDEOUT_ENTRY_RADIUS) {
        failure = "BOTH PLAYERS MUST BE IN THE DOOR RADIUS";
        break;
      }
      if (!!member.moving || Math.abs(almightyPythonFinite(member.speed, 0, 1000)) > ALMIGHTY_PYTHON_HIDEOUT_STOP_SPEED) {
        failure = "BOTH BIKES MUST BE COMPLETELY STOPPED";
        break;
      }
    }
    if (failure) {
      deny(failure);
      return;
    }
    if (!mission.entry_token) {
      mission.entry_token = "hideout-entry-" + rid() + "-" + String(now);
      mission.entry_started_at = now;
      mission.entry_triggered_by = client.id;
    }
    almightyPythonPartyBroadcast(room, partyId, {
      t: "hideout_enter",
      game: "almighty_python",
      room: room.name,
      hideout_id: String(mission.id || ""),
      entry_token: String(mission.entry_token || ""),
      triggered_by: String(mission.entry_triggered_by || client.id),
      ts: Number(mission.entry_started_at || now)
    });
    almightyPythonSnapshot(room);
    return;
  }
  if (kind === "combat_punch") {
    const partyId = String(client.partyId || "");
    const mission = room.hideouts && room.hideouts.get(partyId);
    if (!mission || mission.status !== "active" || String(message.hideout_id || "") !== String(mission.id || "")) return;
    const authority = room.clients.get(String(mission.authority_id || ""));
    if (!authority) return;
    almightyPythonSend(authority.ws, {
      t: "combat_punch", game: "almighty_python", room: room.name,
      from: client.id, hand: almightyPythonSafeHand(message.hand) || "right",
      x: almightyPythonFinite(message.x, client.x), y: almightyPythonFinite(message.y, client.y),
      angle: almightyPythonFinite(message.angle, client.angle, 100000),
      hideout_id: String(mission.id || ""), ts: Date.now()
    });
    return;
  }
  if (kind === "combat_snapshot") {
    const partyId = String(client.partyId || "");
    const mission = room.hideouts && room.hideouts.get(partyId);
    if (!mission || String(mission.authority_id || "") !== client.id || String(message.hideout_id || "") !== String(mission.id || "")) return;
    const snapshot = message.snapshot && typeof message.snapshot === "object" ? message.snapshot : null;
    if (!snapshot) return;
    almightyPythonPartyBroadcast(room, partyId, { t: "combat_snapshot", game: "almighty_python", room: room.name, hideout_id: mission.id, snapshot, ts: Date.now() });
    return;
  }
  if (kind === "combat_damage") {
    const partyId = String(client.partyId || "");
    const mission = room.hideouts && room.hideouts.get(partyId);
    if (!mission || String(mission.authority_id || "") !== client.id || String(message.hideout_id || "") !== String(mission.id || "")) return;
    const target = room.clients.get(almightyPythonSafeId(message.target_id));
    if (!target || String(target.partyId || "") !== partyId) return;
    almightyPythonSend(target.ws, { t: "combat_damage", game: "almighty_python", room: room.name, from: client.id, to: target.id, amount: Math.max(0, Math.min(500, Number(message.amount || 0))), blocking: Boolean(message.blocking), hideout_id: mission.id, ts: Date.now() });
    return;
  }
  if (kind === "hideout_defeat") {
    const partyId = String(client.partyId || "");
    const mission = room.hideouts && room.hideouts.get(partyId);
    if (!mission || String(mission.status || "active") !== "active" || String(message.hideout_id || "") !== String(mission.id || "")) return;
    if (!mission.defeated || typeof mission.defeated !== "object") mission.defeated = {};
    mission.defeated[client.id] = true;
    const expected = Array.isArray(mission.member_ids) ? mission.member_ids.map(String) : almightyPythonPartyMembers(room, partyId).map(member => String(member.id || ""));
    if (expected.length >= 2 && expected.every(id => !!mission.defeated[id])) {
      almightyPythonCancelHideout(room, partyId, mission, "EVERY RIDER WAS KNOCKED OUT // TEAM MISSION CANCELLED");
      almightyPythonSnapshot(room);
    } else {
      if (String(mission.authority_id || "") === String(client.id || "")) {
        const replacement = almightyPythonPartyMembers(room, partyId).find(member => !mission.defeated[String(member.id || "")]);
        if (replacement) mission.authority_id = String(replacement.id || "");
      }
      almightyPythonPartyBroadcast(room, partyId, { t: "hideout_state", game: "almighty_python", room: room.name, hideout: Object.assign({}, mission), ts: Date.now() });
      almightyPythonSnapshot(room);
    }
    return;
  }
  if (kind === "hideout_cancel") {
    const partyId = String(client.partyId || "");
    const mission = room.hideouts && room.hideouts.get(partyId);
    if (!mission || String(message.hideout_id || "") !== String(mission.id || "")) return;
    almightyPythonCancelHideout(room, partyId, mission, message.reason || "TEAM MISSION CANCELLED");
    almightyPythonSnapshot(room);
    return;
  }
  if (kind === "hideout_complete") {
    const partyId = String(client.partyId || "");
    const mission = room.hideouts && room.hideouts.get(partyId);
    if (!mission || mission.status === "complete" || String(mission.authority_id || "") !== client.id || String(message.hideout_id || "") !== String(mission.id || "")) return;
    mission.status = "complete";
    const rawStats = message.stats && typeof message.stats === "object" ? message.stats : {};
    const stats = {
      xp: Math.max(0, Math.min(100000, Number(rawStats.xp || 0) | 0)),
      hardest_hit: Math.max(0, Math.min(100000, Number(rawStats.hardest_hit || 0))),
      total_kills: Math.max(0, Math.min(1000, Number(rawStats.total_kills || 0) | 0)),
      reputation: Math.max(0, Math.min(10000, Number(rawStats.reputation || 0) | 0)),
      credits: Math.max(0, Math.min(100000, Number(rawStats.credits || 0) | 0))
    };
    almightyPythonPartyBroadcast(room, partyId, { t: "hideout_complete", game: "almighty_python", room: room.name, hideout_id: mission.id, stats, ts: Date.now() });
    return;
  }
  if (kind === "mission_return") {
    const partyId = String(client.partyId || "");
    const mission = room.hideouts && room.hideouts.get(partyId);
    if (!mission || String(message.hideout_id || "") !== String(mission.id || "")) return;
    if (!mission.returned) mission.returned = {};
    mission.returned[client.id] = true;
    const members = almightyPythonPartyMembers(room, partyId);
    if (members.length && members.every(member => mission.returned[member.id])) {
      room.hideouts.delete(partyId);
      almightyPythonPartyBroadcast(room, partyId, { t: "hideout_cleared", game: "almighty_python", room: room.name, hideout_id: mission.id, ts: Date.now() });
    }
    return;
  }
  if (kind === "sync" || kind === "list") {
    almightyPythonSnapshot(room, ws);
    return;
  }
  if (kind === "leave") almightyPythonDetach(ws, true);
}
function almightyPythonCleanRooms() {
  const now = Date.now();
  for (const [roomName, room] of [...almightyPythonRooms.entries()]) {
    if (!room || !room.clients) { almightyPythonRooms.delete(roomName); continue; }
    for (const [id, client] of [...room.clients.entries()]) {
      const open = !!(client && client.ws && client.ws.readyState === WebSocket.OPEN);
      if (!open || now - Number(client.lastSeen || 0) > ALMIGHTY_PYTHON_TTL_MS) {
        if (client && client.ws) almightyPythonDetach(client.ws, true);
        else room.clients.delete(id);
      }
    }
    almightyPythonNormalizeParties(room);
    almightyPythonPromoteHost(room);
    if (room.clients.size === 0) almightyPythonRooms.delete(roomName);
  }
}
try {
  const _almightyPythonSweep = setInterval(almightyPythonCleanRooms, 5000);
  if (_almightyPythonSweep && typeof _almightyPythonSweep.unref === "function") _almightyPythonSweep.unref();
} catch {}
// ------------------------------------------------------------------------------------------------------------------
// HOUSE NOCTURNE / VESPERA Umbral Rail protocol
// Raw JSON, plus optional ur: prefix for future clients.
// Clients send:  {"type":"presence","id":"UR-XXXX","name":"King","floor":0,"x":10.5,"y":10.5,"angle":0,"maps":{...}}
//                {"type":"visit","target":"UR-OTHER","visitor":{...}}
//                {"type":"visit_position","target":"UR-OTHER","visitor":{...}}
//                {"type":"leave","target":"UR-OTHER","id":"UR-XXXX"}
// Server sends:  {"type":"presence",...} / {"type":"peer_left",...} / relayed visit packets
// ------------------------------------------------------------------------------------------------------------------
const umbralRooms = new Map(); // roomName -> { name, clients:Map<id,client> }
const UMBRAL_DEFAULT_ROOM = "house_nocturne";
const UMBRAL_PEER_TTL_MS = 45000;
const UMBRAL_MAX_CLIENTS = 16;
const UMBRAL_MAX_MAP_FLOORS = 8;
const UMBRAL_MAX_MAP_ROWS = 128;
const UMBRAL_MAX_MAP_COLS = 160;
function umbralSafeId(s) {
  try {
    const out = String(s || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    return out || ("UR-" + rid());
  } catch { return "UR-" + rid(); }
}
function umbralSafeName(s, fb = "Gaunt-Geist") {
  try {
    const out = String(s || "").replace(/\s+/g, " ").trim().slice(0, 28);
    return out || fb;
  } catch { return fb; }
}
function umbralRoomName(s) {
  return safeRoomId(s || UMBRAL_DEFAULT_ROOM, UMBRAL_DEFAULT_ROOM);
}
function umbralGetRoom(roomName) {
  const rn = umbralRoomName(roomName);
  if (!umbralRooms.has(rn)) umbralRooms.set(rn, { name: rn, clients: new Map() });
  const room = umbralRooms.get(rn);
  if (!room.clients) room.clients = new Map();
  return room;
}
function umbralCleanMaps(raw) {
  const out = {};
  try {
    if (!raw || typeof raw !== "object") return out;
    let floors = 0;
    for (const [fk, grid] of Object.entries(raw)) {
      if (floors++ >= UMBRAL_MAX_MAP_FLOORS) break;
      const key = String(fk || "0").replace(/[^0-9-]/g, "").slice(0, 8) || "0";
      const rows = [];
      if (Array.isArray(grid)) {
        for (const row of grid.slice(0, UMBRAL_MAX_MAP_ROWS)) {
          rows.push(String(row || "").slice(0, UMBRAL_MAX_MAP_COLS));
        }
      }
      out[key] = rows;
    }
  } catch {}
  return out;
}
function umbralPublicPeer(client, viewerWs = null) {
  return {
    type: "presence",
    room: String(client.room || UMBRAL_DEFAULT_ROOM),
    id: String(client.id || ""),
    name: umbralSafeName(client.name, "Gaunt-Geist"),
    floor: Math.floor(clamp(Number(client.floor || 0), -16, 16)),
    x: clamp(Number(client.x || 10.5), -1000000, 1000000),
    y: clamp(Number(client.y || 10.5), -1000000, 1000000),
    angle: clamp(Number(client.angle || 0), -1000000, 1000000),
    maps: client.maps && typeof client.maps === "object" ? client.maps : {},
    visiting: !!client.visiting,
    visit_target: String(client.visit_target || ""),
    you: !!(viewerWs && client.ws === viewerWs),
    t: Date.now() / 1000
  };
}
function umbralSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    const data = JSON.stringify(obj);
    if (ws._umbralPrefixed) ws.send("ur:" + data);
    else ws.send(data);
    return true;
  } catch { return false; }
}
function umbralBroadcast(room, obj, exceptWs = null) {
  if (!room || !room.clients) return;
  for (const c of room.clients.values()) {
    if (!c || !c.ws || c.ws === exceptWs) continue;
    umbralSend(c.ws, obj);
  }
}
function umbralSendPeerList(ws, room, selfId) {
  if (!room || !room.clients) return;
  for (const c of room.clients.values()) {
    if (!c || String(c.id || "") === String(selfId || "")) continue;
    umbralSend(ws, umbralPublicPeer(c, ws));
  }
}
function umbralRoster(room, viewerWs = null) {
  if (!room || !room.clients) return [];
  return [...room.clients.values()].slice(0, UMBRAL_MAX_CLIENTS).map(c => umbralPublicPeer(c, viewerWs));
}
function umbralSendWelcome(ws, room, selfId) {
  umbralSend(ws, {
    type: "roster",
    game: "house_nocturne",
    room: room.name,
    self_id: String(selfId || ""),
    peers: umbralRoster(room, ws),
    ts: Date.now()
  });
}
function umbralDetach(ws, announce = true) {
  if (!ws || !ws._umbralId) return;
  const id = String(ws._umbralId || "");
  const roomName = umbralRoomName(ws._umbralRoomName || UMBRAL_DEFAULT_ROOM);
  const room = umbralRooms.get(roomName);
  if (room && room.clients) {
    const c = room.clients.get(id);
    const removed = !!(c && c.ws === ws);
    if (removed) room.clients.delete(id);
    if (removed && announce && id) umbralBroadcast(room, { type: "peer_left", id, room: room.name, ts: Date.now() }, ws);
    if (room.clients.size === 0) umbralRooms.delete(roomName);
  }
  ws._umbralId = "";
  ws._umbralRoomName = "";
}
function umbralRememberPresence(ws, m) {
  const room = umbralGetRoom(m.room || m.castle_room || UMBRAL_DEFAULT_ROOM);
  const oldRoom = ws._umbralRoomName ? umbralRoomName(ws._umbralRoomName) : "";
  if (oldRoom && oldRoom !== room.name) umbralDetach(ws, true);
  const id = umbralSafeId(m.id || ws._umbralId || "");
  ws._umbralId = id;
  ws._umbralRoomName = room.name;
  const prior = room.clients.get(id);
  if (prior && prior.ws && prior.ws !== ws) {
    try { prior.ws._umbralId = ""; prior.ws._umbralRoomName = ""; prior.ws.close(4001, "newer House connection"); } catch {}
  }
  if (!prior && room.clients.size >= UMBRAL_MAX_CLIENTS) {
    umbralSend(ws, { type: "error", code: "umbral_room_full", message: "This House junction is full.", ts: Date.now() });
    return null;
  }
  const existing = prior || { id, room: room.name, ws };
  existing.ws = ws;
  existing.id = id;
  existing.room = room.name;
  existing.name = umbralSafeName(m.name || existing.name, "Gaunt-Geist");
  existing.floor = Math.floor(clamp(Number(m.floor != null ? m.floor : existing.floor || 0), -16, 16));
  existing.x = clamp(Number(m.x != null ? m.x : existing.x || 10.5), -1000000, 1000000);
  existing.y = clamp(Number(m.y != null ? m.y : existing.y || 10.5), -1000000, 1000000);
  existing.angle = clamp(Number(m.angle != null ? m.angle : existing.angle || 0), -1000000, 1000000);
  existing.maps = m.maps && typeof m.maps === "object" ? umbralCleanMaps(m.maps) : (existing.maps || {});
  existing.visiting = !!m.visiting;
  existing.visit_target = String(m.visit_target || "").slice(0, 64);
  existing.lastSeen = Date.now();
  room.clients.set(id, existing);
  return { room, client: existing };
}
function umbralFindClient(targetId, roomName = "") {
  const tid = String(targetId || "").slice(0, 64);
  if (!tid) return null;
  if (roomName) {
    const room = umbralRooms.get(umbralRoomName(roomName));
    const c = room && room.clients ? room.clients.get(tid) : null;
    if (c) return c;
  }
  for (const room of umbralRooms.values()) {
    const c = room && room.clients ? room.clients.get(tid) : null;
    if (c) return c;
  }
  return null;
}
function umbralRelayToTarget(ws, m) {
  const roomName = m.room || ws._umbralRoomName || UMBRAL_DEFAULT_ROOM;
  const targetId = String(m.target || m.host || "").slice(0, 64);
  const target = umbralFindClient(targetId, roomName);
  if (!target || !target.ws || target.ws.readyState !== WebSocket.OPEN) {
    umbralSend(ws, { type: "error", code: "umbral_target_missing", message: "The Umbral Rail target is no longer online.", target: targetId, ts: Date.now() });
    return false;
  }
  return umbralSend(target.ws, m);
}
function umbralHandle(ws, payloadStr, prefixed = false) {
  if (prefixed) ws._umbralPrefixed = true;
  let m = null;
  try { m = JSON.parse(String(payloadStr || "")); } catch { m = null; }
  if (!m || typeof m !== "object") return;
  const typ = String(m.type || m.t || "").toLowerCase();
  if (typ === "presence" || typ === "peer" || typ === "hello" || typ === "join") {
    const got = umbralRememberPresence(ws, m);
    if (!got || !got.client) return;
    umbralSendWelcome(ws, got.room, got.client.id);
    umbralBroadcast(got.room, umbralPublicPeer(got.client), ws);
    return;
  }
  if (typ === "list" || typ === "request_peers" || typ === "sync") {
    const room = umbralGetRoom(m.room || ws._umbralRoomName || UMBRAL_DEFAULT_ROOM);
    umbralSendPeerList(ws, room, ws._umbralId || "");
    return;
  }
  if (typ === "rail_chat" || typ === "visitor_chat" || typ === "chat") {
    const text = String(m.text || m.msg || m.message || "").replace(/\r?\n/g, " ").slice(0, 240);
    if (!text) return;
    if (!m.from_id) m.from_id = String(ws._umbralId || m.id || "").slice(0, 64);
    if (!m.from_name) {
      const c = umbralFindClient(m.from_id, m.room || ws._umbralRoomName || UMBRAL_DEFAULT_ROOM);
      m.from_name = c ? umbralSafeName(c.name, "Gaunt-Wraith") : umbralSafeName(m.name, "Gaunt-Wraith");
    }
    m.type = "rail_chat";
    m.text = text;
    m.ts = Date.now();
    if (m.target || m.host) umbralRelayToTarget(ws, m);
    return;
  }
  if (typ === "visit" || typ === "visit_position") {
    const visitor = (m.visitor && typeof m.visitor === "object") ? m.visitor : m;
    const id = umbralSafeId(visitor.id || ws._umbralId || "");
    if (id) {
      const got = umbralRememberPresence(ws, {
        type: "presence",
        room: m.room || ws._umbralRoomName || UMBRAL_DEFAULT_ROOM,
        id,
        name: visitor.name || m.name,
        floor: visitor.floor,
        x: visitor.x,
        y: visitor.y,
        angle: visitor.angle,
        maps: visitor.maps,
        visiting: true,
        visit_target: m.target || m.host || ""
      });
      if (got && got.client) umbralBroadcast(got.room, umbralPublicPeer(got.client), ws);
    }
    umbralRelayToTarget(ws, m);
    return;
  }
  if (typ === "leave") {
    const id = String(m.id || ws._umbralId || "").slice(0, 64);
    if (ws._umbralId && id === ws._umbralId) {
      const room = umbralGetRoom(m.room || ws._umbralRoomName || UMBRAL_DEFAULT_ROOM);
      const c = room.clients.get(id);
      if (c) {
        c.visiting = false;
        c.visit_target = "";
        c.lastSeen = Date.now();
        umbralBroadcast(room, umbralPublicPeer(c), ws);
      }
    }
    if (m.target || m.host) umbralRelayToTarget(ws, m);
    return;
  }
  if (typ === "ping") {
    umbralSend(ws, { type: "pong", peers: umbralGetRoom(ws._umbralRoomName || UMBRAL_DEFAULT_ROOM).clients.size, ts: Date.now() });
    return;
  }
}
function umbralCleanRooms() {
  const now = Date.now();
  for (const [roomName, room] of [...umbralRooms.entries()]) {
    if (!room || !room.clients) { umbralRooms.delete(roomName); continue; }
    for (const [id, c] of [...room.clients.entries()]) {
      const open = !!(c && c.ws && c.ws.readyState === WebSocket.OPEN);
      if (!open || now - Number(c.lastSeen || 0) > UMBRAL_PEER_TTL_MS) {
        room.clients.delete(id);
        umbralBroadcast(room, { type: "peer_left", id, room: room.name, ts: Date.now() });
      }
    }
    if (room.clients.size === 0) umbralRooms.delete(roomName);
  }
}
try {
  const _umbralSweep = setInterval(umbralCleanRooms, 15000);
  if (_umbralSweep && typeof _umbralSweep.unref === "function") _umbralSweep.unref();
} catch {}
// ------------------------------------------
// LUXBOUND / LYRALAN observer-admin protocol
// ------------------------------------------
const luxboundPlayers = new Map();
const luxboundAdmins = new Map();
const LUXBOUND_STATE_MIN_MS = 120;
function luxboundSend(ws, packet) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send("lb:" + JSON.stringify(packet)); return true; } catch { return false; }
}
function luxboundClean(v, max=96) {
  return String(v || "").replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function luxboundPublic(c) {
  return { id:c.id, name:c.name, state:c.state || null, last_seen:Number(c.lastSeen || Date.now()) };
}
function luxboundRoster() {
  return [...luxboundPlayers.values()].filter(c => c && c.ws && c.ws.readyState === WebSocket.OPEN).map(luxboundPublic);
}
function luxboundBroadcastAdmins(packet) {
  for (const a of luxboundAdmins.values()) if (a && a.ws && a.ws.readyState === WebSocket.OPEN) luxboundSend(a.ws, packet);
}
function luxboundSendRoster(ws=null) {
  const packet = { t:"roster", game:"luxbound", players:luxboundRoster(), ts:Date.now() };
  if (ws) luxboundSend(ws, packet); else luxboundBroadcastAdmins(packet);
}
function luxboundDetach(ws) {
  const pid = ws && ws._luxboundPlayerId;
  const aid = ws && ws._luxboundAdminId;
  if (pid) {
    const c = luxboundPlayers.get(pid);
    if (c && c.ws === ws) luxboundPlayers.delete(pid);
    try { delete ws._luxboundPlayerId; } catch {}
    luxboundBroadcastAdmins({ t:"player_left", game:"luxbound", id:String(pid), ts:Date.now() });
    luxboundSendRoster();
  }
  if (aid) {
    const a = luxboundAdmins.get(aid);
    if (a && a.ws === ws) luxboundAdmins.delete(aid);
    try { delete ws._luxboundAdminId; } catch {}
  }
}
function luxboundJoin(ws, m) {
  luxboundDetach(ws);
  const role = String(m.role || "player").toLowerCase() === "admin" ? "admin" : "player";
  const id = luxboundClean(m.id || `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`, 80);
  const name = luxboundClean(m.name || (role === "admin" ? "LYRALAN" : "LUXBOUND"), 64);
  if (role === "admin") {
    const old = luxboundAdmins.get(id); if (old && old.ws && old.ws !== ws) { try { old.ws.close(1008,"duplicate lyralan id"); } catch {} }
    luxboundAdmins.set(id, {id,name,ws,lastSeen:Date.now()}); ws._luxboundAdminId=id;
    luxboundSend(ws, {t:"welcome",game:"luxbound",role:"admin",id,name,players:luxboundRoster(),ts:Date.now()});
    luxboundSendRoster(ws);
    return;
  }
  const old = luxboundPlayers.get(id); if (old && old.ws && old.ws !== ws) { try { old.ws.close(1008,"duplicate luxbound id"); } catch {} }
  const client = {id,name,ws,state:null,lastStateAt:0,lastSeen:Date.now()};
  luxboundPlayers.set(id, client); ws._luxboundPlayerId=id;
  luxboundSend(ws,{t:"welcome",game:"luxbound",role:"player",id,name,ts:Date.now()});
  luxboundSendRoster();
}
function luxboundHandle(ws, payload) {
  let m=null; try { m=JSON.parse(String(payload||"")); } catch { return; }
  if (!m || typeof m !== "object") return;
  const t=String(m.t || m.type || "").toLowerCase();
  if (t === "join") { luxboundJoin(ws,m); return; }
  const pid=ws._luxboundPlayerId, aid=ws._luxboundAdminId;
  if (t === "state" && pid) {
    const client=luxboundPlayers.get(pid); if (!client || !m.state || typeof m.state !== "object" || Array.isArray(m.state)) return;
    const now=Date.now(); if (now-Number(client.lastStateAt||0)<LUXBOUND_STATE_MIN_MS) return;
    let bytes=0; try { bytes=Buffer.byteLength(JSON.stringify(m.state),"utf8"); } catch { return; }
    if (bytes > 256*1024) return;
    client.lastStateAt=now; client.lastSeen=now; client.state=m.state;
    luxboundBroadcastAdmins({t:"state",game:"luxbound",id:client.id,name:client.name,state:client.state,ts:now});
    return;
  }
  if (t === "player_chat" && pid) {
    const client = luxboundPlayers.get(pid);
    const text = luxboundClean(m.text,500);
    if (!client || !text) return;
    client.lastSeen = Date.now();
    luxboundBroadcastAdmins({
      t:"player_chat",
      game:"luxbound",
      id:client.id,
      name:client.name,
      text,
      ts:Date.now()
    });
    return;
  }
  if (t === "chat" && aid) {
    const target=luxboundPlayers.get(luxboundClean(m.target,80));
    const text=luxboundClean(m.text,500);
    if (!target || !target.ws || target.ws.readyState !== WebSocket.OPEN || !text) {
      luxboundSend(ws,{t:"chat_error",game:"luxbound",message:"That LUXBOUND session is no longer online.",ts:Date.now()}); return;
    }
    const packet={t:"admin_chat",game:"luxbound",target:target.id,text,from:aid,from_name:"LYRALAN",ts:Date.now()};
    luxboundSend(target.ws,packet);
    luxboundBroadcastAdmins({t:"chat",game:"luxbound",target:target.id,text,from:"LYRALAN",ts:Date.now()});
    return;
  }
  if (t === "request_players" && aid) { luxboundSendRoster(ws); return; }
  if (t === "ping") { luxboundSend(ws,{t:"pong",game:"luxbound",ts:Date.now()}); return; }
}
// --------------------------------------------------------------------------
// SLIMECRAFT Railway player presence
// Shares mm: framing with MECHMARINER; game:"slimecraft" selects this route.
// --------------------------------------------------------------------------
const SLIMECRAFT_RAILWAY_PROTOCOL_VERSION = 3;
const SLIMECRAFT_RAILWAY_MAX_PLAYERS = Math.max(2, Math.min(32, Number(process.env.SLIMECRAFT_RAILWAY_MAX_PLAYERS || 32) || 32));
const SLIMECRAFT_RAILWAY_PRESENCE_MIN_MS = Math.max(50, Math.min(1000, Number(process.env.SLIMECRAFT_RAILWAY_PRESENCE_MIN_MS || 100) || 100));
const slimecraftRailwayClients = new Map();
function slimecraftRailwayClean(v, max=128) {
  return String(v == null ? "" : v).replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function slimecraftRailwaySafeId(v) {
  return slimecraftRailwayClean(v, 80).replace(/[^A-Za-z0-9_.-]/g, "");
}
function slimecraftRailwayFinite(v, fallback=0, limit=1000000) {
  const n = Number(v);
  if (!Number.isFinite(n)) return Number(fallback) || 0;
  return Math.max(-limit, Math.min(limit, n));
}
function slimecraftRailwaySend(ws, packet) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send("mm:" + JSON.stringify(packet)); return true; } catch { return false; }
}
function slimecraftRailwayPublic(client) {
  if (!client || !client.state) return null;
  return Object.assign({}, client.state, {
    t:"presence",
    game:"slimecraft",
    protocol_version:SLIMECRAFT_RAILWAY_PROTOCOL_VERSION,
    lieutenant_id:client.id,
    id:client.id
  });
}
function slimecraftRailwayRoster(excludeId="") {
  const out=[];
  for (const client of slimecraftRailwayClients.values()) {
    if (!client || client.id === excludeId || !client.state) continue;
    const row=slimecraftRailwayPublic(client);
    if (row) out.push(row);
  }
  return out.slice(0, SLIMECRAFT_RAILWAY_MAX_PLAYERS);
}
function slimecraftRailwayBroadcast(packet, excludeWs=null) {
  for (const client of slimecraftRailwayClients.values()) {
    if (!client || client.ws === excludeWs || !client.ws || client.ws.readyState !== WebSocket.OPEN) continue;
    slimecraftRailwaySend(client.ws, packet);
  }
}
function slimecraftRailwayDetach(ws, silent=false) {
  const id = ws && ws._slimecraftRailwayId ? String(ws._slimecraftRailwayId) : "";
  if (!id) return;
  const client = slimecraftRailwayClients.get(id);
  try { delete ws._slimecraftRailwayId; } catch {}
  if (!client || client.ws !== ws) return;
  slimecraftRailwayClients.delete(id);
  if (!silent) slimecraftRailwayBroadcast({
    t:"leave",game:"slimecraft",protocol_version:SLIMECRAFT_RAILWAY_PROTOCOL_VERSION,
    lieutenant_id:id,id,ts:Date.now()
  }, ws);
}
function slimecraftRailwayJoin(ws, m) {
  const id = slimecraftRailwaySafeId(m.lieutenant_id || m.id);
  if (!id) {
    slimecraftRailwaySend(ws,{t:"error",game:"slimecraft",code:"missing_id",message:"Missing SLIMECRAFT lieutenant_id.",ts:Date.now()});
    return null;
  }
  const requestedVersion = Math.trunc(Number(m.protocol_version || SLIMECRAFT_RAILWAY_PROTOCOL_VERSION) || 0);
  if (requestedVersion !== SLIMECRAFT_RAILWAY_PROTOCOL_VERSION) {
    slimecraftRailwaySend(ws,{t:"error",game:"slimecraft",code:"protocol_version",protocol_version:SLIMECRAFT_RAILWAY_PROTOCOL_VERSION,ts:Date.now()});
    return null;
  }
  const existing = slimecraftRailwayClients.get(id);
  if (!existing && slimecraftRailwayClients.size >= SLIMECRAFT_RAILWAY_MAX_PLAYERS) {
    slimecraftRailwaySend(ws,{t:"error",game:"slimecraft",code:"room_full",max_players:SLIMECRAFT_RAILWAY_MAX_PLAYERS,ts:Date.now()});
    return null;
  }
  if (existing && existing.ws && existing.ws !== ws) {
    try { existing.ws.close(1008,"duplicate slimecraft railway lieutenant_id"); } catch {}
    slimecraftRailwayClients.delete(id);
  }
  const client={id,ws,state:existing && existing.state ? existing.state : null,lastPresenceAt:0,joinedAt:Date.now()};
  slimecraftRailwayClients.set(id,client);
  ws._slimecraftRailwayId=id;
  slimecraftRailwaySend(ws,{
    t:"welcome",game:"slimecraft",protocol_version:SLIMECRAFT_RAILWAY_PROTOCOL_VERSION,
    lieutenant_id:id,id,max_players:SLIMECRAFT_RAILWAY_MAX_PLAYERS,
    players:slimecraftRailwayRoster(id),ts:Date.now()
  });
  return client;
}
function slimecraftRailwayPresenceState(client, m) {
  const state={
    lieutenant_id:client.id,
    id:client.id,
    x:slimecraftRailwayFinite(m.x),
    y:slimecraftRailwayFinite(m.y),
    zone:slimecraftRailwayClean(m.zone,32),
    room:slimecraftRailwayClean(m.room,128),
    site:slimecraftRailwayClean(m.site,96),
    sprite_key:slimecraftRailwayClean(m.sprite_key,32),
    class_name:slimecraftRailwayClean(m.class_name,32),
    evolved:!!m.evolved,
    level:Math.max(1,Math.min(999,Math.trunc(Number(m.level)||1))),
    facing:slimecraftRailwayClean(m.facing,16),
    flip:!!m.flip,
    moving:!!m.moving,
    form:!!m.form,
    light_thing:!!m.light_thing,
    ts:Date.now()
  };
  client.state=state;
  return state;
}
function slimecraftRailwayHandle(ws, payload) {
  let m=null;
  try { m=JSON.parse(String(payload||"")); } catch { m=null; }
  if (!m || typeof m !== "object") return;
  const t=String(m.t || m.type || "").toLowerCase();
  let id=ws && ws._slimecraftRailwayId ? String(ws._slimecraftRailwayId) : "";
  let client=id ? slimecraftRailwayClients.get(id) : null;
  if (t === "hello" || t === "join") {
    slimecraftRailwayJoin(ws,m);
    return;
  }
  if (!client) {
    client=slimecraftRailwayJoin(ws,m);
    if (!client) return;
    id=client.id;
  }
  if (t === "presence") {
    const now=Date.now();
    if (now-Number(client.lastPresenceAt||0) < SLIMECRAFT_RAILWAY_PRESENCE_MIN_MS) return;
    client.lastPresenceAt=now;
    const state=slimecraftRailwayPresenceState(client,m);
    slimecraftRailwayBroadcast(Object.assign({
      t:"presence",game:"slimecraft",protocol_version:SLIMECRAFT_RAILWAY_PROTOCOL_VERSION
    },state),ws);
    return;
  }
  if (t === "request_players" || t === "request_roster" || t === "sync") {
    slimecraftRailwaySend(ws,{
      t:"players",game:"slimecraft",protocol_version:SLIMECRAFT_RAILWAY_PROTOCOL_VERSION,
      players:slimecraftRailwayRoster(id),ts:Date.now()
    });
    return;
  }
  if (t === "leave") {
    slimecraftRailwayDetach(ws,false);
    return;
  }
  if (t === "ping") {
    slimecraftRailwaySend(ws,{t:"pong",game:"slimecraft",protocol_version:SLIMECRAFT_RAILWAY_PROTOCOL_VERSION,ts:Date.now()});
  }
}
// --------------------------------------
// MECHMARINER shared expedition protocol
// Protocol prefix: mm:
// --------------------------------------
const MECHMARINER_PROTOCOL_VERSION = 3;
const MECHMARINER_MAX_PLAYERS = Math.max(2, Math.min(32, Number(process.env.MECHMARINER_MAX_PLAYERS || 32) || 32));
const MECHMARINER_PRESENCE_MIN_MS = 50;
const mechmarinerClients = new Map();
let mechmarinerJoinOrder = [];
let mechmarinerAuthorityId = "";
const mechmarinerSeenHits = new Map();
const mechmarinerSeenBlasts = new Map();
const mechmarinerSeenChats = new Map();
const mechmarinerSeenKillCredits = new Map();
function mechmarinerClean(v, max=96) {
  return String(v || "").replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function mechmarinerSafeId(v) {
  return mechmarinerClean(v, 80).replace(/[^A-Za-z0-9_.-]/g, "");
}
function mechmarinerFinite(v, fallback=0, limit=1000000) {
  const n = Number(v);
  if (!Number.isFinite(n)) return Number(fallback) || 0;
  return Math.max(-limit, Math.min(limit, n));
}
function mechmarinerAllocatePlayerNum(existing=0) {
  const prior = Math.trunc(Number(existing) || 0);
  if (prior >= 1 && prior <= MECHMARINER_MAX_PLAYERS) {
    let occupied = false;
    for (const c of mechmarinerClients.values()) {
      if (c && Number(c.playerNum || 0) === prior) { occupied = true; break; }
    }
    if (!occupied) return prior;
  }
  const used = new Set([...mechmarinerClients.values()].map(c => Math.trunc(Number(c && c.playerNum) || 0)));
  for (let n=1; n<=MECHMARINER_MAX_PLAYERS; n++) if (!used.has(n)) return n;
  return 0;
}
function mechmarinerSend(ws, packet) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send("mm:" + JSON.stringify(packet)); return true; } catch { return false; }
}
function mechmarinerBroadcast(packet, exclude=null) {
  for (const client of mechmarinerClients.values()) {
    if (!client || !client.ws || client.ws === exclude || client.ws.readyState !== WebSocket.OPEN) continue;
    mechmarinerSend(client.ws, packet);
  }
}
function mechmarinerChooseAuthority() {
  mechmarinerJoinOrder = mechmarinerJoinOrder.filter(id => mechmarinerClients.has(id));
  if (!mechmarinerAuthorityId || !mechmarinerClients.has(mechmarinerAuthorityId)) {
    mechmarinerAuthorityId = mechmarinerJoinOrder[0] || "";
  }
  return mechmarinerAuthorityId;
}
function mechmarinerRosterPacket(t="roster") {
  const players = [...mechmarinerClients.values()].map(c => ({id:c.id,name:c.name,player_num:Number(c.playerNum)||0}));
  return {
    t,
    game:"mechmariner",
    protocol_version:MECHMARINER_PROTOCOL_VERSION,
    authority_id:mechmarinerChooseAuthority(),
    max_players:MECHMARINER_MAX_PLAYERS,
    count:players.length,
    players,
    ts:Date.now()
  };
}
function mechmarinerAnnounceAuthority() {
  mechmarinerBroadcast(mechmarinerRosterPacket("authority"));
}
function mechmarinerSweepSeen(map, now=Date.now()) {
  if (map.size <= 2048) return;
  const cutoff = now - 30000;
  for (const [k, at] of map.entries()) if (Number(at || 0) < cutoff) map.delete(k);
}
function mechmarinerDetach(ws, silent=false) {
  const id = ws && ws._mechmarinerId;
  if (!id) return;
  const client = mechmarinerClients.get(id);
  try { delete ws._mechmarinerId; } catch {}
  // A reconnect may already have replaced this id with a new socket. Never let
  // the old socket's close event evict or de-authorize the replacement.
  if (!client || client.ws !== ws) return;
  mechmarinerClients.delete(id);
  mechmarinerJoinOrder = mechmarinerJoinOrder.filter(v => v !== id);
  const oldAuthority = mechmarinerAuthorityId;
  if (oldAuthority === id) mechmarinerAuthorityId = "";
  mechmarinerChooseAuthority();
  if (!silent) {
    mechmarinerBroadcast({t:"leave",game:"mechmariner",id:client.id,name:client.name,authority_id:mechmarinerAuthorityId,ts:Date.now()});
    mechmarinerAnnounceAuthority();
  }
}
function mechmarinerJoin(ws, m) {
  const id = mechmarinerSafeId(m.id);
  if (!id) { mechmarinerSend(ws,{t:"error",game:"mechmariner",message:"Missing MECHMARINER peer id.",ts:Date.now()}); return; }
  const existing = mechmarinerClients.get(id);
  if (!existing && mechmarinerClients.size >= MECHMARINER_MAX_PLAYERS) {
    mechmarinerSend(ws,{t:"error",game:"mechmariner",code:"room_full",message:`MECHMARINER relay full (${MECHMARINER_MAX_PLAYERS}).`,max_players:MECHMARINER_MAX_PLAYERS,ts:Date.now()});
    try { ws.close(1008,"mechmariner room full"); } catch {}
    return;
  }
  if (existing && existing.ws && existing.ws !== ws) {
    try { existing.ws.close(1008,"duplicate mechmariner peer id"); } catch {}
    mechmarinerClients.delete(id);
  }
  const name = mechmarinerClean(m.name || "MARINER", 64) || "MARINER";
  const playerNum = mechmarinerAllocatePlayerNum(existing && existing.playerNum);
  const client = {id,name,ws,playerNum,lastSeen:Date.now(),lastPresenceAt:0};
  mechmarinerClients.set(id, client);
  if (!mechmarinerJoinOrder.includes(id)) mechmarinerJoinOrder.push(id);
  ws._mechmarinerId = id;
  mechmarinerChooseAuthority();
  mechmarinerSend(ws, {
    ...mechmarinerRosterPacket("welcome"),
    id,
    name,
    player_num:playerNum
  });
  mechmarinerBroadcast({t:"join",game:"mechmariner",id,name,authority_id:mechmarinerAuthorityId,ts:Date.now()}, ws);
  mechmarinerAnnounceAuthority();
}
function mechmarinerHandle(ws, payload) {
  let m=null; try { m=JSON.parse(String(payload || "")); } catch { return; }
  if (!m || typeof m !== "object" || Array.isArray(m)) return;
  const t=String(m.t || m.type || "").toLowerCase();
  if (t === "join") { mechmarinerJoin(ws,m); return; }
  const id=ws && ws._mechmarinerId;
  const client=id ? mechmarinerClients.get(id) : null;
  if (!client || client.ws !== ws) return;
  client.lastSeen=Date.now();
  if (t === "presence") {
    const now=Date.now();
    if (now-Number(client.lastPresenceAt || 0) < MECHMARINER_PRESENCE_MIN_MS) return;
    client.lastPresenceAt=now;
    const packet={
      t:"presence",game:"mechmariner",id:client.id,name:client.name,
      x:mechmarinerFinite(m.x),y:mechmarinerFinite(m.y),heading:mechmarinerFinite(m.heading,0,100000),
      moving:!!m.moving,firing:!!m.firing,
      weapon:mechmarinerClean(m.weapon,8),shot_seq:Math.max(0,Math.trunc(mechmarinerFinite(m.shot_seq,0,2147483647))),
      surface:mechmarinerClean(m.surface,12),scene:mechmarinerClean(m.scene,20),
      node:Math.max(-1,Math.min(100000,Math.trunc(mechmarinerFinite(m.node,-1,100000)))),
      floor_z:mechmarinerFinite(m.floor_z,0,100000),
      player_num:Number(client.playerNum)||0,ts:now
    };
    mechmarinerBroadcast(packet,ws);
    return;
  }
  if (t === "chat") {
    const text=mechmarinerClean(m.text,500);
    if (!text) return;
    const msgId=mechmarinerSafeId(m.msg_id || `${client.id}-${Date.now()}`);
    const now=Date.now();
    if (msgId && mechmarinerSeenChats.has(msgId)) return;
    if (msgId) mechmarinerSeenChats.set(msgId,now);
    mechmarinerSweepSeen(mechmarinerSeenChats,now);
    mechmarinerBroadcast({t:"chat",game:"mechmariner",id:client.id,name:client.name,text,msg_id:msgId,ts:now},ws);
    return;
  }
  if (t === "enemies") {
    mechmarinerChooseAuthority();
    if (client.id !== mechmarinerAuthorityId) return;
    const incoming=Array.isArray(m.items) ? m.items.slice(0,512) : [];
    const items=[];
    for (const row of incoming) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const uid=mechmarinerSafeId(row[0]);
      if (!uid) continue;
      items.push([
        uid,
        mechmarinerFinite(row[1]),
        mechmarinerFinite(row[2]),
        Math.max(0,Math.min(1000000,Math.trunc(mechmarinerFinite(row[3],0,1000000)))),
        Math.max(1,Math.min(1000000,Math.trunc(mechmarinerFinite(row[4],1,1000000)))),
        Math.max(-1000,Math.min(1000,Math.trunc(mechmarinerFinite(row[5],0,1000)))),
        mechmarinerClean(row[6] == null ? "continuance" : row[6],32) || "continuance",
        mechmarinerClean(row[7] == null ? "idle" : row[7],24) || "idle",
        Math.max(0,Math.min(255,Math.trunc(mechmarinerFinite(row[8],0,255)))),
        mechmarinerFinite(row[9],0,100000),
        !!row[10],
        mechmarinerFinite(row[11],0,100000)
      ]);
    }
    mechmarinerBroadcast({t:"enemies",game:"mechmariner",id:client.id,name:client.name,authority_id:client.id,items,ts:Date.now()},ws);
    return;
  }
  if (t === "enemy_hit") {
    mechmarinerChooseAuthority();
    if (!mechmarinerAuthorityId || client.id === mechmarinerAuthorityId) return;
    const authority=mechmarinerClients.get(mechmarinerAuthorityId);
    if (!authority || !authority.ws || authority.ws.readyState !== WebSocket.OPEN) return;
    const uid=mechmarinerSafeId(m.uid);
    const damage=Math.max(0,Math.min(1000,Math.trunc(Number(m.damage)||0)));
    const hitId=mechmarinerSafeId(m.hit_id || `${client.id}-${Date.now()}`);
    if (!uid || damage <= 0) return;
    const now=Date.now();
    if (hitId && mechmarinerSeenHits.has(hitId)) return;
    if (hitId) mechmarinerSeenHits.set(hitId,now);
    mechmarinerSweepSeen(mechmarinerSeenHits,now);
    mechmarinerSend(authority.ws,{t:"enemy_hit",game:"mechmariner",id:client.id,name:client.name,uid,damage,hit_id:hitId,ts:now});
    return;
  }
  if (t === "enemy_blast") {
    mechmarinerChooseAuthority();
    if (!mechmarinerAuthorityId || client.id === mechmarinerAuthorityId) return;
    const authority=mechmarinerClients.get(mechmarinerAuthorityId);
    if (!authority || !authority.ws || authority.ws.readyState !== WebSocket.OPEN) return;
    const x=Number(m.x)||0;
    const y=Number(m.y)||0;
    const radius=Math.max(0,Math.min(30,Number(m.radius)||0));
    const force=Math.max(0,Math.min(30,Number(m.force)||0));
    const blastId=mechmarinerSafeId(m.blast_id || `${client.id}-${Date.now()}`);
    if (radius <= 0 || force <= 0) return;
    const now=Date.now();
    if (blastId && mechmarinerSeenBlasts.has(blastId)) return;
    if (blastId) mechmarinerSeenBlasts.set(blastId,now);
    mechmarinerSweepSeen(mechmarinerSeenBlasts,now);
    mechmarinerSend(authority.ws,{t:"enemy_blast",game:"mechmariner",id:client.id,name:client.name,x,y,radius,force,blast_id:blastId,ts:now});
    return;
  }
  if (t === "enemy_kill_credit") {
    mechmarinerChooseAuthority();
    if (!mechmarinerAuthorityId || client.id !== mechmarinerAuthorityId) return;
    const targetId=mechmarinerSafeId(m.target_id);
    const target=targetId ? mechmarinerClients.get(targetId) : null;
    const uid=mechmarinerSafeId(m.uid);
    const creditId=mechmarinerSafeId(m.credit_id || `${targetId}-${uid}-${Date.now()}`);
    if (!target || !target.ws || target.ws.readyState !== WebSocket.OPEN || targetId === client.id || !uid || !creditId) return;
    const now=Date.now();
    if (mechmarinerSeenKillCredits.has(creditId)) return;
    mechmarinerSeenKillCredits.set(creditId,now);
    mechmarinerSweepSeen(mechmarinerSeenKillCredits,now);
    mechmarinerSend(target.ws,{
      t:"enemy_kill_credit",game:"mechmariner",id:client.id,name:client.name,target_id:targetId,uid,
      x:mechmarinerFinite(m.x),y:mechmarinerFinite(m.y),
      max_hp:Math.max(1,Math.min(1000000,Math.trunc(mechmarinerFinite(m.max_hp,1,1000000)))),
      underwater:!!m.underwater,kind:mechmarinerClean(m.kind || "continuance",32) || "continuance",
      credit_id:creditId,ts:now
    });
    return;
  }
  if (t === "request_roster") { mechmarinerSend(ws,mechmarinerRosterPacket("roster")); return; }
  if (t === "ping") { mechmarinerSend(ws,{t:"pong",game:"mechmariner",protocol_version:MECHMARINER_PROTOCOL_VERSION,authority_id:mechmarinerAuthorityId,ts:Date.now()}); return; }
}
// ----------------------------------------------------------
// KRON authoritative Python-server Railway bridge (kron:...)
// ----------------------------------------------------------
// The public Node process is transport only. One KRON Python server registers
// as the room host; game clients register as clients. Requests are forwarded to
// that host and replies are routed back to the originating client. Persistence,
// quests, REP, chat, GRIDMIND and presence therefore remain authoritative in
// server_app.py rather than being duplicated here.
const KRON_RELAY_SECRET = String(process.env.KRON_RELAY_SECRET || "").trim();
const kronRooms = new Map(); // room -> {host,hostId,clients:Map<clientId,ws>}
function kronRoom(name) {
  const roomName = safeRoomId(name, "kron");
  let room = kronRooms.get(roomName);
  if (!room) {
    room = { name: roomName, host: null, hostId: "", clients: new Map() };
    kronRooms.set(roomName, room);
  }
  return room;
}
function kronToken(v, fallback = "") {
  const s = String(v || fallback).replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 96);
  return s || fallback;
}
function kronSend(ws, obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send("kron:" + JSON.stringify(obj));
  } catch {}
}
function kronSecretOK(value) {
  if (!KRON_RELAY_SECRET) return true;
  try {
    const a = Buffer.from(String(value || ""), "utf8");
    const b = Buffer.from(KRON_RELAY_SECRET, "utf8");
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
function kronDetach(ws, silent = false) {
  try {
    const roomName = String(ws && ws._kronRoom || "");
    if (!roomName) return;
    const room = kronRooms.get(roomName);
    if (!room) return;
    if (room.host === ws) {
      room.host = null;
      room.hostId = "";
      for (const c of room.clients.values()) kronSend(c, { t:"host_offline", game:"kron", room:room.name, ts:Date.now() });
    }
    const cid = String(ws._kronClientId || "");
    if (cid && room.clients.get(cid) === ws) {
      room.clients.delete(cid);
      if (!silent && room.host) kronSend(room.host, { t:"client_left", game:"kron", room:room.name, client_id:cid, ts:Date.now() });
    }
    ws._kronRoom = "";
    ws._kronClientId = "";
    ws._kronRole = "";
    if (!room.host && room.clients.size === 0) kronRooms.delete(room.name);
  } catch {}
}
function kronHandle(ws, payloadStr) {
  let m = null;
  try { m = JSON.parse(String(payloadStr || "")); } catch { m = null; }
  if (!m || typeof m !== "object") { kronSend(ws,{t:"error",game:"kron",code:"bad_json",message:"Invalid KRON relay packet."}); return; }
  const t = String(m.t || m.type || "").toLowerCase();
  const roomName = safeRoomId(m.room || ws._kronRoom || "kron", "kron");
  let room = kronRoom(roomName);
  if (t === "host") {
    if (!kronSecretOK(m.secret)) { kronSend(ws,{t:"error",game:"kron",code:"host_auth",message:"KRON relay host authentication failed."}); return; }
    const incomingHostId = kronToken(m.host_id, "KH-" + rid());
    if (room.host && room.host !== ws && room.host.readyState === WebSocket.OPEN) {
      if (room.hostId && room.hostId === incomingHostId) {
        const staleHost = room.host;
        room.host = null;
        try { staleHost.terminate(); } catch { try { staleHost.close(); } catch {} }
      } else {
        kronSend(ws,{t:"error",game:"kron",code:"host_busy",message:"A KRON authoritative host is already online."});
        return;
      }
    }
    kronDetach(ws, true);
    room = kronRoom(roomName);
    room.host = ws;
    room.hostId = incomingHostId;
    ws._kronRole = "host";
    ws._kronRoom = room.name;
    kronSend(ws,{t:"hosted",game:"kron",room:room.name,host_id:room.hostId,clients:room.clients.size,ts:Date.now()});
    for (const c of room.clients.values()) kronSend(c,{t:"host_online",game:"kron",room:room.name,ts:Date.now()});
    return;
  }
  if (t === "hello") {
    kronDetach(ws, true);
    room = kronRoom(roomName);
    const cid = kronToken(m.client_id, "KC-" + rid());
    const old = room.clients.get(cid);
    if (old && old !== ws) { try { old.close(); } catch {} }
    room.clients.set(cid, ws);
    ws._kronRole = "client";
    ws._kronRoom = room.name;
    ws._kronClientId = cid;
    kronSend(ws,{t:"welcome",game:"kron",room:room.name,client_id:cid,host_online:!!(room.host && room.host.readyState===WebSocket.OPEN),ts:Date.now()});
    return;
  }
  if (t === "request") {
    const cid = String(ws._kronClientId || "");
    if (ws._kronRole !== "client" || !cid || room.clients.get(cid) !== ws) {
      kronSend(ws,{t:"error",game:"kron",code:"not_joined",message:"Send kron: hello first."}); return;
    }
    const reqId = kronToken(m.req_id, "KR-" + rid());
    const now = Date.now();
    if (!ws._kronRateStart || now - ws._kronRateStart >= 1000) { ws._kronRateStart = now; ws._kronRateCount = 0; }
    ws._kronRateCount = Number(ws._kronRateCount || 0) + 1;
    if (ws._kronRateCount > 30) { kronSend(ws,{t:"error",game:"kron",code:"rate_limited",req_id:reqId,message:"KRON relay request rate exceeded."}); return; }
    const payload = (m.payload && typeof m.payload === "object" && !Array.isArray(m.payload)) ? m.payload : null;
    if (!payload) { kronSend(ws,{t:"error",game:"kron",code:"bad_request",req_id:reqId,message:"KRON request payload must be an object."}); return; }
    let payloadSize = 0; try { payloadSize = Buffer.byteLength(JSON.stringify(payload), "utf8"); } catch {}
    if (!payloadSize || payloadSize > 65507) { kronSend(ws,{t:"error",game:"kron",code:"payload_too_large",req_id:reqId,message:"KRON relay payload exceeds UDP parity limit."}); return; }
    if (!room.host || room.host.readyState !== WebSocket.OPEN) {
      kronSend(ws,{t:"error",game:"kron",code:"host_offline",req_id:reqId,message:"KRON authoritative server is offline."}); return;
    }
    kronSend(room.host,{t:"request",game:"kron",room:room.name,client_id:cid,req_id:reqId,payload,ts:Date.now()});
    return;
  }
  if (t === "reply") {
    if (ws._kronRole !== "host" || room.host !== ws) return;
    const cid = kronToken(m.client_id, "");
    const reqId = kronToken(m.req_id, "");
    const target = cid ? room.clients.get(cid) : null;
    if (!target || target.readyState !== WebSocket.OPEN || !reqId) return;
    const payload = (m.payload && typeof m.payload === "object" && !Array.isArray(m.payload)) ? m.payload : {ok:false,error:"invalid server reply"};
    kronSend(target,{t:"reply",game:"kron",room:room.name,req_id:reqId,payload,ts:Date.now()});
    return;
  }
  if (t === "ping") { kronSend(ws,{t:"pong",game:"kron",room:room.name,host_online:!!(room.host && room.host.readyState===WebSocket.OPEN),ts:Date.now()}); return; }
  kronSend(ws,{t:"error",game:"kron",code:"unknown_type",message:"Unknown KRON relay packet."});
}
function handleKronHTTP(req, res) {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = String(url.pathname || "").replace(/\/+$/, "") || "/";
    if (pathname !== "/kron" && pathname !== "/api/kron") return false;
    const room = kronRooms.get("kron");
    const body = JSON.stringify({
      ok:true, game:"kron", room:"kron",
      host_online:!!(room && room.host && room.host.readyState === WebSocket.OPEN),
      clients:room ? room.clients.size : 0,
      ts:Date.now()
    });
    res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});
    res.end(body);
    return true;
  } catch { return false; }
}
// ---------------------------------------------------------------
// Dedicated SHEOL Qwen inference bridge (sq:...) -- independent of multiplayer
// The Qwen model runs on SHEOL's PC; Railway routes requests, never loads GGUF.
// ---------------------------------------------------------------
const SHEOL_QWEN_HOST_SECRET = String(process.env.SHEOL_QWEN_HOST_SECRET || process.env.SHEOL_QWEN_RELAY_SECRET || process.env.SHEOL_RELAY_SECRET || "").trim();
const SHEOL_QWEN_CLIENT_SECRET = String(process.env.SHEOL_QWEN_CLIENT_SECRET || process.env.SHEOL_QWEN_RELAY_SECRET || process.env.SHEOL_RELAY_SECRET || "").trim();
let sheolQwenHost = null;
let sheolQwenModel = "";
let sheolQwenContext = 1024;
const sheolQwenPending = new Map();
const sheolQwenRate = new Map();
function sheolQwenEqual(a, b) {
  if (!a || !b) return false;
  try {
    const aHash = crypto.createHash("sha256").update(String(a)).digest();
    const bHash = crypto.createHash("sha256").update(String(b)).digest();
    return crypto.timingSafeEqual(aHash, bHash);
  } catch { return false; }
}
function sheolQwenRespond(res, status, data) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.writeHead(status, {"content-type":"application/json", "cache-control":"no-store"});
    res.end(JSON.stringify(data));
  } catch {}
}
function sheolQwenFailPending(reason) {
  for (const [id, pending] of sheolQwenPending) {
    clearTimeout(pending.timer);
    sheolQwenPending.delete(id);
    sheolQwenRespond(pending.res, 503, {error:"sheol_qwen_offline", detail:reason});
  }
}
function sheolQwenDetach(ws) {
  if (ws !== sheolQwenHost) return;
  sheolQwenHost = null;
  sheolQwenModel = "";
  sheolQwenContext = 1024;
  sheolQwenFailPending("SHEOL Qwen host disconnected");
}
function sheolQwenHandle(ws, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m !== "object") return;
  if (m.t === "host") {
    if (!SHEOL_QWEN_HOST_SECRET || !sheolQwenEqual(m.secret, SHEOL_QWEN_HOST_SECRET)) {
      try { ws.send('sq:{"t":"error","code":"unauthorized"}'); ws.close(1008); } catch {}
      return;
    }
    if (sheolQwenHost && sheolQwenHost !== ws && sheolQwenHost.readyState === WebSocket.OPEN) {
      try { ws.send('sq:{"t":"error","code":"host_busy"}'); ws.close(1008); } catch {}
      return;
    }
    sheolQwenHost = ws;
    sheolQwenModel = String(m.model || "sheol-qwen").slice(0, 160);
    sheolQwenContext = Math.max(256, Math.min(65536, Math.floor(Number(m.context_tokens || 1024)) || 1024));
    ws._sheolQwenHost = true;
    try { ws.send('sq:' + JSON.stringify({t:"hosted",model:sheolQwenModel})); } catch {}
    return;
  }
  if (m.t === "reply" && ws === sheolQwenHost) {
    const id = String(m.req_id || "");
    const pending = sheolQwenPending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    sheolQwenPending.delete(id);
    if (m.ok === false) {
      const upstream = Number(m.status || 502);
      sheolQwenRespond(pending.res, [400,413,422,429,500,502,503,504].includes(upstream) ? upstream : 502,
                       {error:"sheol_qwen_inference_failed",detail:String(m.error || "inference failed").slice(0, 1200)});
    } else if (m.result && typeof m.result === "object" && Array.isArray(m.result.choices)) {
      sheolQwenRespond(pending.res, 200, m.result);
    } else {
      sheolQwenRespond(pending.res, 502, {error:"invalid_sheol_qwen_reply"});
    }
    return;
  }
  if (m.t === "ping" && ws === sheolQwenHost) {
    try { ws.send('sq:{"t":"pong"}'); } catch {}
  }
}
function handleSheolQwenHTTP(req, res) {
  const route = (String(req.url || "/").split("?", 1)[0] || "/").replace(/\/+$/, "");
  if (route !== "/api/sheol-qwen/status" && route !== "/api/sheol-qwen/chat") return false;
  if (route.endsWith("/status") && req.method !== "GET") {
    sheolQwenRespond(res, 405, {error:"method_not_allowed"}); return true;
  }
  if (!route.endsWith("/status") && req.method !== "POST") {
    sheolQwenRespond(res, 405, {error:"method_not_allowed"}); return true;
  }
  if (!SHEOL_QWEN_CLIENT_SECRET || !SHEOL_QWEN_HOST_SECRET) {
    sheolQwenRespond(res, 503, {error:"sheol_qwen_relay_not_configured"}); return true;
  }
  const auth = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!auth || !sheolQwenEqual(auth[1].trim(), SHEOL_QWEN_CLIENT_SECRET)) {
    sheolQwenRespond(res, 401, {error:"unauthorized"}); return true;
  }
  if (route.endsWith("/status")) {
    sheolQwenRespond(res, 200, {ok:true, configured:true,
      host_online:!!(sheolQwenHost && sheolQwenHost.readyState===WebSocket.OPEN),
      model:sheolQwenModel, context_tokens:sheolQwenContext});
    return true;
  }
  if (!sheolQwenHost || sheolQwenHost.readyState !== WebSocket.OPEN) {
    sheolQwenRespond(res, 503, {error:"sheol_qwen_host_offline"}); return true;
  }
  const ip = pickIP(req) || "unknown";
  const now = Date.now();
  let rate = sheolQwenRate.get(ip);
  if (!rate || now - rate.start > 60000) rate = {start:now, count:0};
  rate.count++;
  sheolQwenRate.set(ip, rate);
  if (sheolQwenRate.size > 2048) for (const [key, entry] of sheolQwenRate) if (now-entry.start > 60000) sheolQwenRate.delete(key);
  if (rate.count > 40) { sheolQwenRespond(res, 429, {error:"rate_limited"}); return true; }
  if (sheolQwenPending.size >= 4) { sheolQwenRespond(res, 503, {error:"sheol_qwen_busy"}); return true; }
  let body = ""; let tooLarge = false;
  req.on("data", chunk => {
    if (tooLarge) return;
    body += chunk.toString("utf8");
    if (Buffer.byteLength(body, "utf8") > 32768) { tooLarge = true; body = ""; }
  });
  req.on("end", () => {
    if (tooLarge) { sheolQwenRespond(res, 413, {error:"payload_too_large"}); return; }
    let payload;
    try { payload = JSON.parse(body); } catch { sheolQwenRespond(res, 400, {error:"bad_json"}); return; }
    if (!payload || !Array.isArray(payload.messages) || !payload.messages.length || payload.messages.length > 40 || payload.stream === true ||
        payload.messages.some(x => !x || !["system","user","assistant"].includes(x.role) || typeof x.content !== "string")) {
      sheolQwenRespond(res, 400, {error:"invalid_chat_request"}); return;
    }
    payload.max_tokens = Math.max(1, Math.min(256, Number(payload.max_tokens || 128) || 128));
    // Limit size and model options again in the SHEOL host process.
    if (!sheolQwenHost || sheolQwenHost.readyState !== WebSocket.OPEN) { sheolQwenRespond(res, 503, {error:"sheol_qwen_host_offline"}); return; }
    const id = "SQ-" + crypto.randomBytes(12).toString("hex");
    const timer = setTimeout(() => {
      sheolQwenPending.delete(id);
      sheolQwenRespond(res, 504, {error:"sheol_qwen_timeout"});
    }, 65000);
    sheolQwenPending.set(id, {res, timer});
    res.on("close", () => { if (!res.writableEnded) { clearTimeout(timer); sheolQwenPending.delete(id); } });
    try { sheolQwenHost.send('sq:' + JSON.stringify({t:"infer", req_id:id, payload})); }
    catch { clearTimeout(timer); sheolQwenPending.delete(id); sheolQwenRespond(res, 503, {error:"sheol_qwen_send_failed"}); }
  });
  req.on("error", () => {});
  return true;
}

// ---------------------------------------------------------------
// SHEOL authoritative TRENCHMIND / NPC Railway bridge (sheol:...)
// ---------------------------------------------------------------
// server_app.py is the single authority for HUTCH resident identity, memory,
// story state and local Qwen inference. This Node service is transport only:
// WAN players register as clients and their requests are forwarded to the same
// Python host that LAN players reach directly on SHEOL's configured LAN port.
const SHEOL_RELAY_SECRET = String(process.env.SHEOL_RELAY_SECRET || "").trim();
const sheolRooms = new Map();
function sheolRoom(name) {
  const roomName = safeRoomId(name, "sheol");
  let room = sheolRooms.get(roomName);
  if (!room) {
    room = { name: roomName, host: null, hostId: "", clients: new Map() };
    sheolRooms.set(roomName, room);
  }
  return room;
}
function sheolToken(v, fallback = "") {
  const x = String(v || fallback).replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 96);
  return x || fallback;
}
function sheolSend(ws, obj) {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.send("sheol:" + JSON.stringify(obj)); } catch {}
}
function sheolSecretOK(value) {
  if (!SHEOL_RELAY_SECRET) return true;
  try {
    const a = Buffer.from(String(value || ""), "utf8");
    const b = Buffer.from(SHEOL_RELAY_SECRET, "utf8");
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
function sheolDetach(ws, silent = false) {
  try {
    const roomName = String(ws && ws._sheolRoom || "");
    if (!roomName) return;
    const room = sheolRooms.get(roomName);
    if (!room) return;
    if (room.host === ws) {
      room.host = null; room.hostId = "";
      for (const c of room.clients.values()) sheolSend(c,{t:"host_offline",game:"sheol",room:room.name,ts:Date.now()});
    }
    const cid = String(ws._sheolClientId || "");
    if (cid && room.clients.get(cid) === ws) {
      room.clients.delete(cid);
      if (!silent && room.host) sheolSend(room.host,{t:"client_left",game:"sheol",room:room.name,client_id:cid,ts:Date.now()});
    }
    ws._sheolRoom = ""; ws._sheolClientId = ""; ws._sheolRole = "";
    if (!room.host && room.clients.size === 0) sheolRooms.delete(room.name);
  } catch {}
}
function sheolHandle(ws, payloadStr) {
  let m = null;
  try { m = JSON.parse(String(payloadStr || "")); } catch { m = null; }
  if (!m || typeof m !== "object") { sheolSend(ws,{t:"error",game:"sheol",code:"bad_json",message:"Invalid SHEOL relay packet."}); return; }
  const t = String(m.t || m.type || "").toLowerCase();
  const roomName = safeRoomId(m.room || ws._sheolRoom || "sheol", "sheol");
  let room = sheolRoom(roomName);
  if (t === "host") {
    if (!sheolSecretOK(m.secret)) { sheolSend(ws,{t:"error",game:"sheol",code:"host_auth",message:"SHEOL relay host authentication failed."}); return; }
    const incomingHostId = sheolToken(m.host_id, "SH-" + rid());
    if (room.host && room.host !== ws && room.host.readyState === WebSocket.OPEN) {
      if (room.hostId && room.hostId === incomingHostId) {
        const stale = room.host; room.host = null;
        try { stale.terminate(); } catch { try { stale.close(); } catch {} }
      } else { sheolSend(ws,{t:"error",game:"sheol",code:"host_busy",message:"A SHEOL authoritative host is already online."}); return; }
    }
    sheolDetach(ws, true); room = sheolRoom(roomName);
    room.host = ws; room.hostId = incomingHostId;
    ws._sheolRole = "host"; ws._sheolRoom = room.name;
    sheolSend(ws,{t:"hosted",game:"sheol",room:room.name,host_id:room.hostId,clients:room.clients.size,ts:Date.now()});
    for (const c of room.clients.values()) sheolSend(c,{t:"host_online",game:"sheol",room:room.name,ts:Date.now()});
    return;
  }
  if (t === "hello") {
    sheolDetach(ws, true); room = sheolRoom(roomName);
    const cid = sheolToken(m.client_id, "SC-" + rid());
    const old = room.clients.get(cid); if (old && old !== ws) { try { old.close(); } catch {} }
    room.clients.set(cid, ws); ws._sheolRole = "client"; ws._sheolRoom = room.name; ws._sheolClientId = cid;
    sheolSend(ws,{t:"welcome",game:"sheol",room:room.name,client_id:cid,host_online:!!(room.host && room.host.readyState===WebSocket.OPEN),ts:Date.now()});
    return;
  }
  if (t === "request") {
    const cid = String(ws._sheolClientId || "");
    if (ws._sheolRole !== "client" || !cid || room.clients.get(cid) !== ws) { sheolSend(ws,{t:"error",game:"sheol",code:"not_joined",message:"Send sheol: hello first."}); return; }
    const reqId = sheolToken(m.req_id, "SR-" + rid());
    const now = Date.now();
    if (!ws._sheolRateStart || now - ws._sheolRateStart >= 1000) { ws._sheolRateStart = now; ws._sheolRateCount = 0; }
    ws._sheolRateCount = Number(ws._sheolRateCount || 0) + 1;
    if (ws._sheolRateCount > 12) { sheolSend(ws,{t:"error",game:"sheol",code:"rate_limited",req_id:reqId,message:"SHEOL relay request rate exceeded."}); return; }
    const payload = (m.payload && typeof m.payload === "object" && !Array.isArray(m.payload)) ? m.payload : null;
    if (!payload) { sheolSend(ws,{t:"error",game:"sheol",code:"bad_request",req_id:reqId,message:"SHEOL request payload must be an object."}); return; }
    let payloadSize = 0; try { payloadSize = Buffer.byteLength(JSON.stringify(payload),"utf8"); } catch {}
    if (!payloadSize || payloadSize > 32768) { sheolSend(ws,{t:"error",game:"sheol",code:"payload_too_large",req_id:reqId,message:"SHEOL relay payload too large."}); return; }
    if (!room.host || room.host.readyState !== WebSocket.OPEN) { sheolSend(ws,{t:"error",game:"sheol",code:"host_offline",req_id:reqId,message:"SHEOL authoritative server is offline."}); return; }
    sheolSend(room.host,{t:"request",game:"sheol",room:room.name,client_id:cid,req_id:reqId,payload,ts:Date.now()});
    return;
  }
  if (t === "reply") {
    if (ws._sheolRole !== "host" || room.host !== ws) return;
    const cid = sheolToken(m.client_id, ""); const reqId = sheolToken(m.req_id, "");
    const target = cid ? room.clients.get(cid) : null;
    if (!target || target.readyState !== WebSocket.OPEN || !reqId) return;
    const payload = (m.payload && typeof m.payload === "object" && !Array.isArray(m.payload)) ? m.payload : {ok:false,error:"invalid server reply"};
    sheolSend(target,{t:"reply",game:"sheol",room:room.name,req_id:reqId,payload,ts:Date.now()});
    return;
  }
  if (t === "ping") { sheolSend(ws,{t:"pong",game:"sheol",room:room.name,host_online:!!(room.host && room.host.readyState===WebSocket.OPEN),ts:Date.now()}); return; }
  sheolSend(ws,{t:"error",game:"sheol",code:"unknown_type",message:"Unknown SHEOL relay packet."});
}
function handleSheolHTTP(req, res) {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = String(url.pathname || "").replace(/\/+$/, "") || "/";
    if (pathname !== "/sheol" && pathname !== "/api/sheol") return false;
    const room = sheolRooms.get("sheol");
    const body = JSON.stringify({ok:true,game:"sheol",room:"sheol",host_online:!!(room&&room.host&&room.host.readyState===WebSocket.OPEN),clients:room?room.clients.size:0,ts:Date.now()});
    res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"}); res.end(body); return true;
  } catch { return false; }
}
function detachAllProtocols(ws) {
  try { almightyPythonDetach(ws, true); } catch {}
  try { umbralDetach(ws, true); } catch {}
  try { growthDetach(ws); } catch {}
  try { luxboundDetach(ws); } catch {}
  try { mechmarinerDetach(ws); } catch {}
  try { slimecraftRailwayDetach(ws, true); } catch {}
  try { kronDetach(ws, true); } catch {}
  try { sheolDetach(ws, true); } catch {}
  try { sheolQwenDetach(ws); } catch {}
}
function routeSocketMessage(ws, data) {
  let raw = "";
  try {
    raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data || "");
  } catch {
    raw = "";
  }
  if (!raw) return;
  if (raw.startsWith("ap:")) { almightyPythonHandle(ws, raw.slice(3)); return; }
  if (raw.startsWith("ur:")) { umbralHandle(ws, raw.slice(3), true); return; }
  if (raw.startsWith("gf:")) { growthHandle(ws, raw.slice(3)); return; }
  if (raw.startsWith("lb:")) { luxboundHandle(ws, raw.slice(3)); return; }
  if (raw.startsWith("mm:")) {
    const mmPayload = raw.slice(3);
    let mmMessage = null;
    try { mmMessage = JSON.parse(mmPayload); } catch { mmMessage = null; }
    const mmGame = mmMessage && typeof mmMessage === "object" ? String(mmMessage.game || mmMessage.g || "").toLowerCase() : "";
    if (mmGame === "slimecraft" || mmGame === "slime_craft" || mmGame === "sc") { slimecraftRailwayHandle(ws, mmPayload); return; }
    mechmarinerHandle(ws, mmPayload); return;
  }
  if (raw.startsWith("kron:")) { kronHandle(ws, raw.slice(5)); return; }
  if (raw.startsWith("sheol:")) { sheolHandle(ws, raw.slice(6)); return; }
  if (raw.startsWith("sq:")) { sheolQwenHandle(ws, raw.slice(3)); return; }
  // Legacy/no-prefix fallback.
  let m = null;
  try { m = JSON.parse(raw); } catch { m = null; }
  if (m && typeof m === "object") {
    const game = String(m.game || m.proto || m.protocol || m.g || "").toLowerCase();
    if (game === "almighty_python" || game === "almighty" || game === "ap") { almightyPythonHandle(ws, raw); return; }
    if (game === "umbral" || game === "umbral_rail" || game === "house_nocturne" || game === "vespera" || game === "ur") { umbralHandle(ws, raw, false); return; }
    if (game === "growth" || game === "gf") { growthHandle(ws, raw); return; }
    if (game === "luxbound" || game === "lyralan" || game === "lb") { luxboundHandle(ws, raw); return; }
    if (game === "mechmariner" || game === "mm") { mechmarinerHandle(ws, raw); return; }
    if (game === "slimecraft" || game === "slime_craft" || game === "sc") { slimecraftRailwayHandle(ws, raw); return; }
    if (game === "kron" || game === "kr") { kronHandle(ws, raw); return; }
    if (game === "sheol" || game === "sh") { sheolHandle(ws, raw); return; }
    const t = String(m.t || m.type || "").toLowerCase();
    if (t === "presence" || t === "peer" || t === "visit" || t === "visit_position" || t === "rail_chat" || t === "visitor_chat" || t === "leave" || t === "request_peers" || t === "sync") {
      umbralHandle(ws, raw, false);
      return;
    }
  }
  try { ws.send(JSON.stringify({ type: "error", code: "unsupported_protocol", message: "Use Almighty Python, House Nocturne, GROWTH, LUXBOUND, SLIMECRAFT, MECHMARINER, KRON, or SHEOL protocol routing." })); } catch {}
}
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("ping", () => { ws.isAlive = true; });
  ws.on("message", (data) => {
    ws.isAlive = true;
    try { routeSocketMessage(ws, data); } catch (err) {
      try { ws.send(JSON.stringify({ type: "error", message: "Relay packet error." })); } catch {}
    }
  });
  ws.on("close", () => { detachAllProtocols(ws); });
  ws.on("error", () => { detachAllProtocols(ws); });
});
// --------------------------------------------------------------------------------------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  console.log("Dedset relay (Almighty Python / GROWTH / House Nocturne / LUXBOUND / SLIMECRAFT / MECHMARINER / KRON / SHEOL) on", HOST + ":" + PORT);
  if (MEGA_CLAIM_REQUIRE_AUTH && !MEGA_CLAIM_SECRET) console.warn("MEGA claim endpoint is locked until MEGA_CLAIM_SECRET is configured.");
});
