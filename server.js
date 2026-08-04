// server.js - supports Almighty Python, GROWTH, House Nocturne
// and Illithid Throne. One process, one port, isolated rooms by game.
// https://raw.githubusercontent.com/tribehunt/nodejs/refs/heads/main/server.js
// all games produced and engineered by © Dedset Media 08/04/2026
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const PORT = process.env.PORT || 8080;
const HOST = String(process.env.HOST || process.env.BIND_HOST || process.env.MEGA_CLAIM_HOST || (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID ? "0.0.0.0" : "127.0.0.1")).trim() || "127.0.0.1";
const server = http.createServer((req, res) => {
  if (handleMegaClaimHTTP(req, res)) return;
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
function normNameKey(s) {
  try {
    return String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  } catch {
    return "";
  }
}
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
// ---------------------------------------
// Reserved names / skeletonkey admin gate
// ---------------------------------------
const SKELETON_URL = "https://www.hhfashion.org/uploads/1/5/3/2/153241525/skeletonkey.txt";
const RESERVED_NAMES = new Set(["dedset", "dedsetmedia", "psychonauticum", "hhfashion", "realhhfashion", "admin"]);
let skeletonIP = "";
let skeletonFetchedAt = 0;
let skeletonFetchInFlight = false;
let skeletonLastAttemptAt = 0;
let skeletonLastStatus = 0;
let skeletonLastErr = "";
let skeletonLastURL = "";
let skeletonLastBodyLen = 0;
let skeletonLastBodySample = "";
function isValidIPv4(ip) {
  if (!ip) return false;
  const m = String(ip).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}
function decodeSkeletonKey(body) {
  try {
    const raw = String(body || "").trim();
    if (!raw) return "";
    const toks = [];
    toks.push(raw);
    const reTok = /[A-Za-z0-9+/=]{8,}/g;
    let mm;
    while ((mm = reTok.exec(raw)) !== null) {
      toks.push(mm[0]);
      if (toks.length > 64) break;
    }
    for (const t of toks) {
      try {
        const ip = Buffer.from(String(t).trim(), "base64").toString("utf8").trim();
        if (isValidIPv4(ip)) return ip;
      } catch {}
    }
    return "";
  } catch {
    return "";
  }
}
function _httpsGetFollow(url, redirectsLeft, cb) {
  try {
    const u0 = new URL(String(url));
    const lib = (u0.protocol === "http:") ? http : https;
    const req = lib.request(u0, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Railway/Node)",
        "Accept": "text/plain,*/*"
      }
    }, (res) => {
      const sc = Number(res.statusCode || 0);
      const loc = res.headers ? res.headers.location : null;
      if (sc >= 300 && sc < 400 && loc && redirectsLeft > 0) {
        let next = "";
        try { next = new URL(String(loc), u0).toString(); } catch { next = String(loc); }
        try { res.resume(); } catch {}
        _httpsGetFollow(next, redirectsLeft - 1, cb);
        return;
      }
      const chunks = [];
      let total = 0;
      res.on("data", (c) => {
        try {
          chunks.push(c);
          total += c.length || 0;
          if (total > 65536) {
            try { req.destroy(); } catch {}
          }
        } catch {}
      });
      res.on("end", () => {
        try {
          const buf = Buffer.concat(chunks);
          let outBuf = buf;
          const enc = String((res.headers && res.headers["content-encoding"]) || "").toLowerCase();
          try {
            if (enc.includes("gzip")) outBuf = zlib.gunzipSync(buf);
            else if (enc.includes("deflate")) outBuf = zlib.inflateSync(buf);
          } catch {}
          const body = outBuf.toString("utf8");
          cb(null, body, sc, u0.toString());
        } catch (e) {
          cb(e, "", sc, u0.toString());
        }
      });
    });
    req.on("error", (e) => cb(e, "", 0, u0.toString()));
    req.setTimeout(8000, () => { try { req.destroy(new Error("timeout")); } catch {} });
    req.end();
  } catch (e) {
    cb(e, "", 0, String(url || ""));
  }
}
function _sendReservedNameError(ws, proto, desired) {
  try {
    if (proto === "prison") prisonSend(ws, { t: "error", code: "reserved_name", message: `Name "${desired}" is reserved.` });
    else {
      try { ws.send(JSON.stringify({ type: "error", message: `Name "${desired}" is reserved.` })); } catch {}
    }
  } catch {}
}
function _tryApplyPendingReserved(ws) {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const pr = ws._pending_reserved;
    if (!pr) return;
    const desired = String(pr.desired || "").slice(0, 24);
    const proto = String(pr.proto || "");
    const started = Number(pr.at || 0);
    if (!skeletonIP) {
      if (Date.now() - started < 12000) {
        ws._pending_reserved_timer = setTimeout(() => _tryApplyPendingReserved(ws), 300);
        return;
      }
      _sendReservedNameError(ws, proto, desired);
      ws._pending_reserved = null;
      ws._pending_reserved_timer = null;
      return;
    }
    const ip = ws && ws._ip ? String(ws._ip) : "";
    if (!isSkeletonAuthorized(ip)) {
      _sendReservedNameError(ws, proto, desired);
      ws._pending_reserved = null;
      ws._pending_reserved_timer = null;
      return;
    }
    if (proto === "prison") {
      const room = ws._prisonRoomName ? prisonRooms.get(ws._prisonRoomName) : null;
      if (room) {
        const old = String(ws._prisonName || "");
        if (room.nameMap && old) {
          const ok = normNameKey(old);
          if (ok && room.nameMap.get(ok) === ws) room.nameMap.delete(ok);
        }
        const newName = prisonMakeUniqueName(room, desired, ws._prisonId);
        ws._prisonName = newName;
        if (room.nameMap) room.nameMap.set(normNameKey(newName), ws);
        prisonSend(ws, { t: "welcome", id: ws._prisonId, room: room.name, name: newName });
        if (old && normNameKey(old) !== normNameKey(newName)) {
          prisonBroadcast(room, { t: "sys", msg: `${old} is now ${newName}.` });
        }
      }
    }
    ws._pending_reserved = null;
    ws._pending_reserved_timer = null;
  } catch {}
}
function fetchSkeletonIP() {
  if (skeletonFetchInFlight) return;
  const now = Date.now();
  if (now - (skeletonLastAttemptAt || 0) < 5000) return;
  skeletonFetchInFlight = true;
  skeletonLastAttemptAt = now;
  _httpsGetFollow(SKELETON_URL, 3, (err, body, status, finalUrl) => {
    try {
      skeletonLastStatus = Number(status || 0);
      skeletonLastURL = String(finalUrl || SKELETON_URL);
      skeletonLastErr = err ? String(err && err.message ? err.message : err) : "";
      skeletonLastBodyLen = body ? String(body).length : 0;
      skeletonLastBodySample = body ? String(body).slice(0, 64).replace(/\s+/g, " ").trim() : "";
    } catch {}
    try {
      const ip = err ? "" : decodeSkeletonKey(body);
      if (ip) {
        skeletonIP = ip;
        skeletonFetchedAt = Date.now();
      }
    } catch {}
    skeletonFetchInFlight = false;
    try {
      if (wss && wss.clients) {
        for (const c of wss.clients) {
          if (c && c._pending_reserved) _tryApplyPendingReserved(c);
        }
      }
    } catch {}
  });
}
fetchSkeletonIP();
try {
  const t = setInterval(fetchSkeletonIP, 5 * 60 * 1000);
  if (t && typeof t.unref === "function") t.unref();
} catch {}
function isReservedName(name) {
  const k = normNameKey(name);
  return !!k && RESERVED_NAMES.has(k);
}
function isSkeletonAuthorized(ip) {
  if (!skeletonIP) fetchSkeletonIP();
  const a = String(ip || "").trim();
  return !!a && !!skeletonIP && a === skeletonIP;
}
/**
 * Enforce exact reserved-name gate. If blocked, returns a safe replacement.
 * @returns {{name:string, blocked:boolean, reservedKey:string}}
 */
function enforceReservedName(ws, desired, currentName, fallbackId, proto) {
  const reservedKey = normNameKey(desired);
  if (!reservedKey || !RESERVED_NAMES.has(reservedKey)) {
    return { name: desired, blocked: false, reservedKey: "" };
  }
  const ip = ws && ws._ip ? String(ws._ip) : "";
  if (isSkeletonAuthorized(ip)) {
    return { name: desired, blocked: false, reservedKey };
  }
  if (!skeletonIP) {
    try {
      if (ws && !ws._pending_reserved) {
        ws._pending_reserved = { desired: String(desired || "").slice(0, 24), proto: String(proto || ""), at: Date.now() };
        ws._pending_reserved_timer = setTimeout(() => _tryApplyPendingReserved(ws), 300);
      }
    } catch {}
    const cur = String(currentName || "").slice(0, 24);
    if (cur && !isReservedName(cur)) return { name: cur, blocked: true, reservedKey };
    const fb = String(fallbackId || "USER").slice(0, 24);
    return { name: fb, blocked: true, reservedKey };
  }
  const cur = String(currentName || "").slice(0, 24);
  if (cur && !isReservedName(cur)) {
    _sendReservedNameError(ws, proto, desired);
    return { name: cur, blocked: true, reservedKey };
  }
  const fb = String(fallbackId || "USER").slice(0, 24);
  _sendReservedNameError(ws, proto, desired);
  return { name: fb, blocked: true, reservedKey };
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
// Python client connects to: wss://nodejs-production-740bc.up.railway.app
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
// Python client connects to: wss://nodejs-production-740bc.up.railway.app
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
// -------------------------------------
// Illithid Throne shared-world protocol
// -------------------------------------
const illithidClients = new Map();
let illithidJoinSeq = 0;
const ILLITHID_STATE_MIN_MS = 75;
const ILLITHID_EVENT_RATE_MAX = 48;
const ILLITHID_MAX_STATE_BYTES = 768 * 1024;
const ILLITHID_MAX_EVENT_BYTES = 96 * 1024;
function illithidSend(ws, packet) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify(packet)); return true; } catch { return false; }
}
function illithidLiveClients() {
  return [...illithidClients.values()].filter(c => c && c.ws && c.ws.readyState === WebSocket.OPEN);
}
function illithidHost() {
  const live = illithidLiveClients().sort((a,b) => a.seq-b.seq);
  return live.length ? live[0] : null;
}
function illithidShade(client) {
  if (!client) return 160;
  const shades = [218,204,190,176,162,148,134,120,106,92];
  return shades[Math.abs(Number(client.seq || 0)) % shades.length];
}
function illithidBroadcast(packet, exceptWs=null) {
  for (const c of illithidLiveClients()) if (c.ws !== exceptWs) illithidSend(c.ws, packet);
}
function illithidAnnounceHost() {
  const host = illithidHost();
  illithidBroadcast({ t:'host', game:'illithid_throne', id:host ? host.id : '', name:host ? host.name : '', ts:Date.now() });
}
function illithidSafeProfile(rawProfile) {
  rawProfile=(rawProfile&&typeof rawProfile==='object')?rawProfile:{};
  return {
    head:Math.max(0,Math.min(99,Number(rawProfile.head||0)|0)),
    armor_head:String(rawProfile.armor_head||'').replace(/[^a-zA-Z0-9_.:\/-]/g,'').slice(0,160),
    armor_torso:String(rawProfile.armor_torso||'').replace(/[^a-zA-Z0-9_.:\/-]/g,'').slice(0,160),
    armor_hands:String(rawProfile.armor_hands||'').replace(/[^a-zA-Z0-9_.:\/-]/g,'').slice(0,160)
  };
}
function illithidSafeBalances(rawBalances) {
  rawBalances=(rawBalances&&typeof rawBalances==='object')?rawBalances:{};
  return {
    matter:Math.max(0,Math.min(1000000000,Number(rawBalances.matter||0)|0)),
    essence:Math.max(0,Math.min(1000000000,Number(rawBalances.essence||0)|0))
  };
}
function illithidPublicClient(c, host) {
  return {
    id:c.id, name:c.name, host:!!host&&host.id===c.id,
    shade:illithidShade(c), profile:c.profile,
    balances:c.balances, state:c.state || null
  };
}
function illithidJoin(ws, m) {
  illithidDetach(ws, true);
  const id = String(m.id || '').replace(/[^a-zA-Z0-9_.:-]/g,'').slice(0,80) || `duke-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const name = String(m.name || 'The Duke').replace(/[\r\n\t]/g,' ').replace(/\s+/g,' ').trim().slice(0,48) || 'The Duke';
  const profile=illithidSafeProfile(m.profile);
  const balances=illithidSafeBalances(m.balances);
  const old=illithidClients.get(id);
  if (old && old.ws && old.ws !== ws) { try { old.ws.close(1008, 'duplicate duke id'); } catch {} }
  const client = {
    id, name, ws, seq:++illithidJoinSeq, profile, balances, state:null,
    lastStateAt:0, eventWindowAt:Date.now(), eventCount:0
  };
  illithidClients.set(id, client); ws._illithidId=id;
  const host=illithidHost();
  illithidSend(ws,{t:'welcome',game:'illithid_throne',id,name,host:!!host&&host.id===id,shade:illithidShade(client),online:illithidLiveClients().length,players:illithidLiveClients().map(c=>illithidPublicClient(c,host)),ts:Date.now()});
  illithidBroadcast({t:'join',game:'illithid_throne',id,name,host:!!host&&host.id===id,shade:illithidShade(client),profile:client.profile,text:'Another shadow lurks...',ts:Date.now()},ws);
  illithidAnnounceHost();
}
function illithidHandle(ws, payload) {
  let m=null; try { m=JSON.parse(String(payload||'')); } catch { return; }
  if (!m || typeof m !== 'object') return;
  const t=String(m.t||m.type||'').toLowerCase();
  if (t==='join') { illithidJoin(ws,m); return; }
  const client=illithidClients.get(ws._illithidId); if (!client) return;
  if (t==='chat') {
    const text=String(m.text||m.msg||m.message||'').replace(/[\r\n\t]/g,' ').replace(/\s+/g,' ').trim().slice(0,220);
    if (!text) return;
    const host=illithidHost();
    illithidBroadcast({t:'chat',game:'illithid_throne',id:client.id,name:client.name,text,host:!!host&&host.id===client.id,shade:illithidShade(client),ts:Date.now()});
    return;
  }
  if (t==='balance') {
    client.balances=illithidSafeBalances(m.balances);
    return;
  }
  if (t==='profile') {
    client.profile=illithidSafeProfile(m.profile);
    illithidBroadcast({t:'profile',game:'illithid_throne',id:client.id,name:client.name,profile:client.profile,ts:Date.now()},ws);
    return;
  }
  if (t==='gift') {
    const target=illithidClients.get(String(m.target||''));
    const resource=String(m.resource||'').toLowerCase();
    const amount=Math.max(1,Math.min(1000000000,Number(m.amount||0)|0));
    if (!target || !target.ws || target.ws.readyState!==WebSocket.OPEN || target.id===client.id) { illithidSend(ws,{t:'gift_error',message:'That Duke is no longer within the veil.'}); return; }
    if (resource!=='matter' && resource!=='essence') { illithidSend(ws,{t:'gift_error',message:'Unknown tribute.'}); return; }
    if (!client.balances || Number(client.balances[resource]||0)<amount) { illithidSend(ws,{t:'gift_error',message:`You do not possess enough ${resource.toUpperCase()}.`}); return; }
    client.balances[resource]-=amount; target.balances=target.balances||{matter:0,essence:0}; target.balances[resource]=Math.max(0,Number(target.balances[resource]||0))+amount;
    illithidSend(ws,{t:'gift_ok',resource,amount,target:target.id,target_name:target.name,balances:client.balances,ts:Date.now()});
    illithidSend(target.ws,{t:'gift_receive',resource,amount,from:client.id,from_name:client.name,balances:target.balances,ts:Date.now()});
    return;
  }
  if (t==='world_state') {
    const now=Date.now();
    if (now-Number(client.lastStateAt||0)<ILLITHID_STATE_MIN_MS) return;
    if (!m.state || typeof m.state!=='object' || Array.isArray(m.state)) return;
    let bytes=0; try { bytes=Buffer.byteLength(JSON.stringify(m.state),'utf8'); } catch { return; }
    if (bytes>ILLITHID_MAX_STATE_BYTES) return;
    client.lastStateAt=now; client.state=m.state;
    illithidBroadcast({t:'world_state',game:'illithid_throne',id:client.id,name:client.name,state:client.state,ts:now},ws);
    return;
  }
  if (t==='world_event') {
    const now=Date.now();
    if (now-Number(client.eventWindowAt||0)>=1000) { client.eventWindowAt=now; client.eventCount=0; }
    client.eventCount=Number(client.eventCount||0)+1;
    if (client.eventCount>ILLITHID_EVENT_RATE_MAX) return;
    if (!m.event || typeof m.event!=='object' || Array.isArray(m.event)) return;
    let bytes=0; try { bytes=Buffer.byteLength(JSON.stringify(m.event),'utf8'); } catch { return; }
    if (bytes>ILLITHID_MAX_EVENT_BYTES) return;
    illithidBroadcast({t:'world_event',game:'illithid_throne',id:client.id,name:client.name,event:m.event,ts:now},ws);
    return;
  }
  if (t==='request_world') {
    const host=illithidHost();
    illithidSend(ws,{t:'world_snapshot',game:'illithid_throne',host_id:host?host.id:'',players:illithidLiveClients().filter(c=>c.id!==client.id).map(c=>illithidPublicClient(c,host)),ts:Date.now()});
    return;
  }
  if (t==='ping') { illithidSend(ws,{t:'pong',game:'illithid_throne',ts:Date.now()}); return; }
}
function illithidDetach(ws, silent=false) {
  const id=ws && ws._illithidId; if (!id) return;
  const client=illithidClients.get(id); illithidClients.delete(id); try { delete ws._illithidId; } catch {}
  if (client && !silent) {
    illithidBroadcast({t:'leave',game:'illithid_throne',id:client.id,name:client.name,host:false,shade:illithidShade(client),text:'A shadow slips beyond the veil...',ts:Date.now()});
    illithidAnnounceHost();
  }
}
// ----------------------------------
// Shared WebSocket connection router
// ----------------------------------
function detachAllProtocols(ws) {
  try { almightyPythonDetach(ws, true); } catch {}
  try { umbralDetach(ws, true); } catch {}
  try { growthDetach(ws); } catch {}
  try { illithidDetach(ws); } catch {}
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
  if (raw.startsWith("it:")) { illithidHandle(ws, raw.slice(3)); return; }
  // Legacy/no-prefix fallback.
  let m = null;
  try { m = JSON.parse(raw); } catch { m = null; }
  if (m && typeof m === "object") {
    const game = String(m.game || m.proto || m.protocol || m.g || "").toLowerCase();
    if (game === "almighty_python" || game === "almighty" || game === "ap") { almightyPythonHandle(ws, raw); return; }
    if (game === "umbral" || game === "umbral_rail" || game === "house_nocturne" || game === "vespera" || game === "ur") { umbralHandle(ws, raw, false); return; }
    if (game === "growth" || game === "gf") { growthHandle(ws, raw); return; }
    if (game === "illithid_throne" || game === "illithid" || game === "it") { illithidHandle(ws, raw); return; }
    const t = String(m.t || m.type || "").toLowerCase();
    if (t === "presence" || t === "peer" || t === "visit" || t === "visit_position" || t === "rail_chat" || t === "visitor_chat" || t === "leave" || t === "request_peers" || t === "sync") {
      umbralHandle(ws, raw, false);
      return;
    }
  }
  try { ws.send(JSON.stringify({ type: "error", code: "unsupported_protocol", message: "Use Almighty Python, House Nocturne, GROWTH, or Illithid Throne protocol routing." })); } catch {}
}
wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws._ip = pickIP(req) || "";
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
// --------------------------------------------------------------
server.listen(PORT, HOST, () => {
  console.log("Dedset relay (Almighty Python / GROWTH / House Nocturne / Illithid Throne) on", HOST + ":" + PORT);
  if (MEGA_CLAIM_REQUIRE_AUTH && !MEGA_CLAIM_SECRET) console.warn("MEGA claim endpoint is locked until MEGA_CLAIM_SECRET is configured.");
});
