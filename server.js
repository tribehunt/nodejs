// server.js - supports Eldritch Cyber Front,
// Ethane Sea, STUG, GROWTH, ARMORBOUND & House Nocturne
// One process, one port, isolated rooms by game.
// by Dedset Media 02/24/2026
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
// ------------------------
// ECF legacy room registry
// ------------------------
const rooms = new Map();
// ------------------------------------------------------------------------------------------------------------
// ETHANE SEA PRISON protocol (p:...)
// Simple prefix protocol so it won't collide with JSON-based games.
// Clients send:  p:{"t":"hello","room":"ethane_prison","id":"P-XXXX","name":"P-XXXX"}
// Chat send:     p:{"t":"chat","room":"ethane_prison","id":"P-XXXX","name":"P-XXXX","msg":"hello","mid":"..."}
// Server sends:  p:{"t":"chat","id":"...","name":"...","msg":"...","mid":"...","ts":...}
// ------------------------------------------------------------------------------------------------------------
const prisonRooms = new Map(); // roomName -> { name, clients:Set<ws> }
function prisonGetRoom(roomName) {
  const rn = safeRoomId(roomName || "ethane_prison", "ethane_prison");
  if (!prisonRooms.has(rn)) prisonRooms.set(rn, { name: rn, clients: new Set(), nameMap: new Map(), ipMap: new Map() });
  const room = prisonRooms.get(rn);
  if (!room.nameMap) room.nameMap = new Map();
  if (!room.ipMap) room.ipMap = new Map();
  return room;
}
function prisonMid() {
  return (
    Math.random().toString(16).slice(2, 10) +
    Date.now().toString(16).slice(-8)
  ).toUpperCase();
}
function prisonSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send("p:" + JSON.stringify(obj)); } catch {}
}
function prisonBroadcast(room, obj) {
  const msg = "p:" + JSON.stringify(obj);
  for (const ws of room.clients) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch {}
    }
  }
}
function prisonDetach(ws, announce = true) {
  if (!ws || !ws._prisonRoomName) return;
  const roomName = ws._prisonRoomName;
  const room = prisonRooms.get(roomName);
  if (room) {
    room.clients.delete(ws);
    if (room.nameMap && ws._prisonName) {
      const k = normNameKey(ws._prisonName);
      if (k && room.nameMap.get(k) === ws) room.nameMap.delete(k);
    }
    if (room.ipMap && ws._ip) {
      if (room.ipMap.get(ws._ip) === ws) room.ipMap.delete(ws._ip);
    }
    if (announce && ws._prisonName) {
      prisonBroadcast(room, { t: "sys", msg: `${ws._prisonName} left cellblock.` });
    }
    if (room.clients.size === 0) prisonRooms.delete(roomName);
  }
  ws._prisonRoomName = null;
}
function prisonKickSameIP(room, ip, exceptWs) {
  if (!room || !ip) return;
  for (const ows of [...room.clients]) {
    if (!ows || ows === exceptWs) continue;
    if (ows._ip && ows._ip === ip) {
      prisonSend(ows, { t: "error", code: "dup_ip", message: "Duplicate session from same IP; closing old." });
      try { prisonDetach(ows, false); } catch {}
      try { ows.close(); } catch {}
    }
  }
}
function prisonMakeUniqueName(room, desired, fallback) {
  const base = String(desired || fallback || "PRISONER").replace(/\s+/g, " ").trim().slice(0, 24) || "PRISONER";
  const has = (nm) => {
    const k = normNameKey(nm);
    if (!k) return false;
    if (room && room.nameMap && room.nameMap.has(k)) return true;
    for (const ws of (room && room.clients ? room.clients : [])) {
      if (ws && normNameKey(ws._prisonName) === k) return true;
    }
    return false;
  };
  if (!has(base)) return base;
  for (let i = 0; i < 12; i++) {
    const suf = "-" + Math.random().toString(36).slice(2, 5).toUpperCase();
    const cut = Math.max(1, 24 - suf.length);
    const cand = base.slice(0, cut) + suf;
    if (!has(cand)) return cand;
  }
  const suf = "-" + rid().slice(0, 3).toUpperCase();
  return (base.slice(0, Math.max(1, 24 - suf.length)) + suf).slice(0, 24);
}
function prisonHandle(ws, payloadStr) {
  let s = "";
  try { s = String(payloadStr || "").trim(); } catch { s = ""; }
  if (!s) return;
  let m = null;
  try { m = JSON.parse(s); } catch { m = null; }
  if (!m || typeof m !== "object") {
    if (!ws._prisonRoomName) {
      const room = prisonGetRoom("ethane_prison");
      ws._prisonRoomName = room.name;
      ws._prisonId = ws._prisonId || ("P-" + prisonMid().slice(0, 8));
      prisonKickSameIP(room, ws._ip, ws);
      const _pDesired = String(ws._prisonName || ws._prisonId).slice(0, 24);
      const _pEnf = enforceReservedName(ws, _pDesired, ws._prisonName, ws._prisonId, "prison");
      ws._prisonName = prisonMakeUniqueName(room, _pEnf.name, ws._prisonId);
      room.clients.add(ws);
      if (room.ipMap && ws._ip) room.ipMap.set(ws._ip, ws);
      if (room.nameMap) room.nameMap.set(normNameKey(ws._prisonName), ws);
      prisonSend(ws, { t: "welcome", id: ws._prisonId, room: room.name, name: ws._prisonName });
      prisonBroadcast(room, { t: "sys", msg: `${ws._prisonName} entered cellblock.` });
    }
    const room = prisonRooms.get(ws._prisonRoomName);
    if (!room) return;
    const msg = s.slice(0, 240);
    prisonBroadcast(room, {
      t: "chat",
      id: ws._prisonId,
      name: ws._prisonName,
      msg,
      mid: prisonMid(),
      ts: Date.now()
    });
    return;
  }
  const t = String(m.t || m.type || "").toLowerCase();
  if (t === "hello" || t === "join") {
    const room = prisonGetRoom(m.room || "ethane_prison");
    const switching = ws._prisonRoomName && ws._prisonRoomName !== room.name;
    if (switching) {
      prisonDetach(ws, true);
    }
    const alreadyIn = (!switching) && (ws._prisonRoomName === room.name) && room && room.clients && room.clients.has(ws);
    const oldName = String(ws._prisonName || "").replace(/\s+/g, " ").trim().slice(0, 24);
    ws._prisonRoomName = room.name;
    ws._prisonId = String(m.id || ws._prisonId || ("P-" + prisonMid().slice(0, 8))).slice(0, 32);
    prisonKickSameIP(room, ws._ip, ws);
    let desired = String(m.name || ws._prisonId).replace(/\s+/g, " ").trim().slice(0, 24);
    const rk = normNameKey(desired);
    if (alreadyIn && oldName && rk && RESERVED_NAMES.has(rk) && !isSkeletonAuthorized(ws._ip) && !skeletonIP) {
      try {
        ws._pending_reserved = { desired, proto: "prison", at: Date.now() };
        if (!ws._pending_reserved_timer) ws._pending_reserved_timer = setTimeout(() => _tryApplyPendingReserved(ws), 300);
      } catch {}
      prisonSend(ws, { t: "welcome", id: ws._prisonId, room: room.name, name: oldName });
      prisonSend(ws, { t: "sys", msg: "Checking skeleton key..." });
      return;
    }
    if (alreadyIn && room && room.nameMap && oldName) {
      const ok = normNameKey(oldName);
      if (ok && room.nameMap.get(ok) === ws) room.nameMap.delete(ok);
    }
    const _pEnf = enforceReservedName(ws, desired, ws._prisonName, ws._prisonId, "prison");
    desired = _pEnf.name;
    const newName = prisonMakeUniqueName(room, desired, ws._prisonId);
    ws._prisonName = newName;
    room.clients.add(ws);
    if (room.ipMap && ws._ip) room.ipMap.set(ws._ip, ws);
    if (room.nameMap) room.nameMap.set(normNameKey(newName), ws);
    prisonSend(ws, { t: "welcome", id: ws._prisonId, room: room.name, name: newName });
    if (!alreadyIn) {
      prisonBroadcast(room, { t: "sys", msg: `${newName} entered cellblock.` });
    } else if (oldName && normNameKey(oldName) !== normNameKey(newName)) {
      prisonBroadcast(room, { t: "sys", msg: `${oldName} is now ${newName}.` });
    }
    return;
  }
  if (t === "chat" || t === "msg") {
    if (!ws._prisonRoomName) {
      prisonHandle(ws, JSON.stringify({ t: "hello", room: m.room || "ethane_prison", id: m.id, name: m.name }));
    }
    const room = prisonRooms.get(ws._prisonRoomName);
    if (!room) return;
    const name = String(ws._prisonName || ws._prisonId || "PRISONER").slice(0, 24);
    const id = String(ws._prisonId || "").slice(0, 32);
    let msg = String(m.msg || m.message || "");
    msg = msg.replace(/\r?\n/g, " ").slice(0, 240);
    const mt = String(msg || "").trim().toLowerCase();
    if (mt === "/ip" || mt === "/whoami") {
      const ip = ws._ip ? String(ws._ip) : "unknown";
      const sk = skeletonIP ? "loaded" : "not loaded";
      const age = skeletonFetchedAt ? Math.floor((Date.now() - skeletonFetchedAt) / 1000) : -1;
      const ok = isSkeletonAuthorized(ip) ? "YES" : "NO";
      prisonSend(ws, { t: "sys", msg: `IP: ${ip} | skeleton: ${sk}${age >= 0 ? ` (${age}s ago)` : ``} | last: ${skeletonLastStatus || 0}${skeletonLastErr ? ` err:${skeletonLastErr}` : ``} | admin: ${ok}` });
      return;
    }
    const mid = String(m.mid || prisonMid()).slice(0, 48);
    prisonBroadcast(room, { t: "chat", id, name, msg, mid, ts: Date.now() });
    return;
  }
  if (t === "ping") {
    prisonSend(ws, { t: "pong", ts: Date.now() });
    return;
  }
}
// -------------------------------------------------------------------------------------------------
// STUG fleet-autobattle protocol (s:...)
// Relaxed co-op bridge chat + fleet order relay for the endless war theater.
// Clients send:  s:{"t":"join","room":"stug","id":"S-XXXX","name":"COMMANDER"}
// State send:    s:{"t":"state","anchor":{"x":0,"y":0},"hp":100,"energy":100,"escorts_alive":8,...}
// Order send:    s:{"t":"order","order":"focus","target":{"x":0,"y":0},"slot":0}
// Chat send:     s:{"t":"chat","msg":"..."}
// Story send:    s:{"t":"story","text":"AI director/story bit"}
// Server sends:  s:{"t":"welcome"} / s:{"t":"roster"} / s:{"t":"pulse"} / s:{"t":"state"}
//                s:{"t":"order"} / s:{"t":"chat"} / s:{"t":"story"} / s:{"t":"sys"}
// -------------------------------------------------------------------------------------------------
const stugRooms = new Map(); // roomName -> { name, clients:Set<ws>, nameMap:Map, ipMap:Map, clock, theater, ... }
function stugGetRoom(roomName) {
  const rn = safeRoomId(roomName || "stug", "stug");
  if (!stugRooms.has(rn)) {
    stugRooms.set(rn, {
      name: rn,
      clients: new Set(),
      nameMap: new Map(),
      ipMap: new Map(),
      clock: 0,
      pulseAt: 0,
      seed: nowSeed(),
      waveIndex: 0,
      waveEveryMs: 18000,
      nextWaveAt: 18000,
      theater: {
        phase: "holding",
        humanPressure: 58,
        aiPressure: 42,
        threat: 26,
        salvage: 12,
        nebulaDrift: Math.random() * Math.PI * 2,
        front: 0.0,
        storySeq: 0,
        battleTick: 0,
        waveIndex: 0,
        nextWaveIn: 18.0,
        lastWaveCount: 0
      }
    });
  }
  const room = stugRooms.get(rn);
  if (!room.nameMap) room.nameMap = new Map();
  if (!room.ipMap) room.ipMap = new Map();
  if (!room.theater) {
    room.theater = {
      phase: "holding",
      humanPressure: 58,
      aiPressure: 42,
      threat: 26,
      salvage: 12,
      nebulaDrift: Math.random() * Math.PI * 2,
      front: 0.0,
      storySeq: 0,
      battleTick: 0,
      waveIndex: 0,
      nextWaveIn: 9.0,
      lastWaveCount: 0
    };
  }
  return room;
}
function stugMid() {
  return (Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-8)).toUpperCase();
}
function stugSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send("s:" + JSON.stringify(obj)); } catch {}
}
function stugBroadcast(room, obj, exceptWs = null) {
  const msg = "s:" + JSON.stringify(obj);
  for (const ws of room.clients) {
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    if (exceptWs && ws === exceptWs) continue;
    try { ws.send(msg); } catch {}
  }
}
function stugRoster(room) {
  const commanders = [];
  for (const ws of room.clients) {
    commanders.push({
      id: String(ws._stugId || "").slice(0, 32),
      name: String(ws._stugName || ws._stugId || "COMMANDER").slice(0, 24),
      ready: !!ws._stugReady,
      fleet: ws._stugState ? {
        hp: clamp(Number(ws._stugState.hp || 100), 0, 100),
        energy: clamp(Number(ws._stugState.energy || 100), 0, 100),
        escorts_alive: clamp(Number(ws._stugState.escorts_alive || 0), 0, 8),
        morale: clamp(Number(ws._stugState.morale || 50), 0, 100)
      } : null
    });
  }
  commanders.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  return commanders;
}
function stugSyncRoster(room) {
  stugBroadcast(room, {
    t: "roster",
    room: room.name,
    seed: room.seed >>> 0,
    theater: room.theater,
    commanders: stugRoster(room),
    ts: Date.now()
  });
}
function stugDetach(ws, announce = true) {
  if (!ws || !ws._stugRoomName) return;
  const roomName = ws._stugRoomName;
  const room = stugRooms.get(roomName);
  if (room) {
    room.clients.delete(ws);
    if (room.nameMap && ws._stugName) {
      const k = normNameKey(ws._stugName);
      if (k && room.nameMap.get(k) === ws) room.nameMap.delete(k);
    }
    if (room.ipMap && ws._ip) {
      if (room.ipMap.get(ws._ip) === ws) room.ipMap.delete(ws._ip);
    }
    if (announce && ws._stugId) {
      stugBroadcast(room, { t: "leave", id: ws._stugId, name: ws._stugName, ts: Date.now() }, ws);
      if (ws._stugName) stugBroadcast(room, { t: "sys", msg: `${ws._stugName} left the bridge net.`, ts: Date.now() });
    }
    stugSyncRoster(room);
    if (room.clients.size === 0) stugRooms.delete(roomName);
  }
  ws._stugRoomName = null;
}
function stugKickSameIP(room, ip, exceptWs) {
  return;
}
function stugMakeUniqueId(room, desired, exceptWs = null) {
  const base0 = String(desired || ("S-" + stugMid().slice(0, 8))).replace(/\s+/g, " ").trim();
  const base = base0.slice(0, 32) || ("S-" + stugMid().slice(0, 8));
  const used = new Set();
  for (const ws of (room && room.clients ? room.clients : [])) {
    if (!ws || (exceptWs && ws === exceptWs)) continue;
    if (ws._stugId) used.add(String(ws._stugId).slice(0, 32));
  }
  if (!used.has(base)) return base;
  for (let i = 0; i < 12; i++) {
    const suf = "-" + rid().slice(0, 4).toUpperCase();
    const cut = Math.max(1, 32 - suf.length);
    const cand = (base.slice(0, cut) + suf).slice(0, 32);
    if (!used.has(cand)) return cand;
  }
  return ("S-" + stugMid().slice(0, 8)).slice(0, 32);
}
function stugMakeUniqueName(room, desired, fallback) {
  const base = String(desired || fallback || "COMMANDER").replace(/\s+/g, " ").trim().slice(0, 24) || "COMMANDER";
  const has = (nm) => {
    const k = normNameKey(nm);
    if (!k) return false;
    if (room && room.nameMap && room.nameMap.has(k)) return true;
    for (const ws of (room && room.clients ? room.clients : [])) {
      if (ws && normNameKey(ws._stugName) === k) return true;
    }
    return false;
  };
  if (!has(base)) return base;
  for (let i = 0; i < 12; i++) {
    const suf = "-" + Math.random().toString(36).slice(2, 5).toUpperCase();
    const cut = Math.max(1, 24 - suf.length);
    const cand = base.slice(0, cut) + suf;
    if (!has(cand)) return cand;
  }
  const suf = "-" + rid().slice(0, 3).toUpperCase();
  return (base.slice(0, Math.max(1, 24 - suf.length)) + suf).slice(0, 24);
}
function stugDefaultState() {
  return {
    anchor: { x: 0, y: 0 },
    hp: 100,
    energy: 100,
    escorts_alive: 8,
    morale: 72,
    mode: "screen",
    target: null,
    selection: -1,
    progression: { level: 1, rank: "" },
    cannon: null,
    routes: null,
    ts: Date.now()
  };
}
function stugTickRoom(room, dt) {
  if (!room || !room.theater) return;
  const th = room.theater;
  room.clock = (room.clock || 0) + dt;
  room.pulseAt = (room.pulseAt || 0) + dt;
  th.battleTick = (th.battleTick | 0) + 1;
  th.nebulaDrift = (Number(th.nebulaDrift || 0) + dt * 0.00011) % (Math.PI * 2);
  const commanderCount = room.clients.size;
  const readiness = [...room.clients].reduce((acc, ws) => acc + (ws._stugReady ? 1 : 0), 0);
  const fleetScore = [...room.clients].reduce((acc, ws) => {
    const s = ws._stugState || {};
    return acc + clamp(Number(s.hp || 0), 0, 100) + clamp(Number(s.escorts_alive || 0), 0, 8) * 5 + clamp(Number(s.energy || 0), 0, 100) * 0.2;
  }, 0);
  const readinessBoost = readiness * 0.04;
  const commanderBoost = commanderCount * 0.025;
  const fleetBoost = fleetScore * 0.00032;
  const threatWave = Math.sin(room.clock * 0.00023 + room.seed * 0.000001) * 0.18 + Math.cos(room.clock * 0.00011) * 0.09;
  th.threat = clamp((Number(th.threat || 0) + threatWave + 0.06 - readinessBoost - commanderBoost - fleetBoost), 0, 100);
  th.humanPressure = clamp((Number(th.humanPressure || 50) + 0.035 + readinessBoost + commanderBoost + fleetBoost - th.threat * 0.0065), 0, 100);
  th.aiPressure = clamp((Number(th.aiPressure || 50) + 0.028 + th.threat * 0.009 - readinessBoost * 0.35), 0, 100);
  th.salvage = clamp((Number(th.salvage || 0) + 0.012 + commanderCount * 0.018 + Math.max(0, 55 - th.threat) * 0.002), 0, 9999);
  th.front = clamp((Number(th.front || 0) + (th.humanPressure - th.aiPressure) * 0.00055), -100, 100);
  if (th.threat >= 72) th.phase = "surge";
  else if (th.front >= 20) th.phase = "advance";
  else if (th.front <= -20) th.phase = "fallback";
  else th.phase = "holding";
  room.waveEveryMs = clamp(Number(room.waveEveryMs || 18000), 12000, 24000);
  room.nextWaveAt = Number(room.nextWaveAt || room.waveEveryMs);
  while (room.clock >= room.nextWaveAt) {
    room.waveIndex = (room.waveIndex | 0) + 1;
    const threat = clamp(Number(th.threat || 0), 0, 100);
    const count = 1 + (threat >= 35 ? 1 : 0) + (threat >= 60 ? 1 : 0) + (threat >= 82 ? 1 : 0);
    th.waveIndex = room.waveIndex | 0;
    th.lastWaveCount = count | 0;
    stugBroadcast(room, {
      t: "wave",
      room: room.name,
      wave: room.waveIndex | 0,
      count: count | 0,
      threat: Math.round(threat * 10) / 10,
      ts: Date.now()
    });
    room.waveEveryMs = Math.round(clamp(19000 - threat * 45, 12000, 24000));
    room.nextWaveAt += room.waveEveryMs;
  }
  th.waveIndex = room.waveIndex | 0;
  th.nextWaveIn = Math.max(0, Math.round((room.nextWaveAt - room.clock) / 100) / 10);
  if (room.pulseAt >= 1000) {
    room.pulseAt = 0;
    stugBroadcast(room, {
      t: "pulse",
      room: room.name,
      seed: room.seed >>> 0,
      theater: {
        phase: th.phase,
        humanPressure: Math.round(th.humanPressure * 10) / 10,
        aiPressure: Math.round(th.aiPressure * 10) / 10,
        threat: Math.round(th.threat * 10) / 10,
        salvage: Math.round(th.salvage * 10) / 10,
        front: Math.round(th.front * 100) / 100,
        nebulaDrift: Math.round(th.nebulaDrift * 100000) / 100000,
        battleTick: th.battleTick | 0,
        storySeq: th.storySeq | 0,
        waveIndex: th.waveIndex | 0,
        nextWaveIn: Number(th.nextWaveIn || 0),
        lastWaveCount: th.lastWaveCount | 0
      },
      ts: Date.now()
    });
  }
}
function stugHandle(ws, payloadStr) {
  let s = "";
  try { s = String(payloadStr || "").trim(); } catch { s = ""; }
  if (!s) return;
  let m = null;
  try { m = JSON.parse(s); } catch { m = null; }
  if (!m || typeof m !== "object") {
    const room = stugRooms.get(ws._stugRoomName || "") || stugGetRoom("stug");
    if (!ws._stugRoomName) {
      ws._stugRoomName = room.name;
      ws._stugId = stugMakeUniqueId(room, ws._stugId || ("S-" + stugMid().slice(0, 8)), ws);
      stugKickSameIP(room, ws._ip, ws);
      const desired0 = String(ws._stugName || ws._stugId).slice(0, 24);
      const enf0 = enforceReservedName(ws, desired0, ws._stugName, ws._stugId, "stug");
      ws._stugName = stugMakeUniqueName(room, enf0.name, ws._stugId);
      ws._stugReady = false;
      ws._stugState = stugDefaultState();
      room.clients.add(ws);
      if (room.ipMap && ws._ip) room.ipMap.set(ws._ip, ws);
      if (room.nameMap) room.nameMap.set(normNameKey(ws._stugName), ws);
      stugSend(ws, { t: "welcome", id: ws._stugId, room: room.name, name: ws._stugName, seed: room.seed >>> 0, theater: room.theater, ts: Date.now() });
      stugBroadcast(room, { t: "sys", msg: `${ws._stugName} linked into the STUG net.`, ts: Date.now() }, ws);
      stugSyncRoster(room);
    }
    const msg = s.slice(0, 240);
    stugBroadcast(room, { t: "chat", id: ws._stugId, name: ws._stugName, msg, mid: stugMid(), ts: Date.now() }, ws);
    return;
  }
  const t = String(m.t || m.type || "").toLowerCase();
  if (t === "hello" || t === "join") {
    const room = stugGetRoom(m.room || "stug");
    const switching = ws._stugRoomName && ws._stugRoomName !== room.name;
    if (switching) stugDetach(ws, true);
    const alreadyIn = (!switching) && (ws._stugRoomName === room.name) && room && room.clients && room.clients.has(ws);
    const oldName = String(ws._stugName || "").replace(/\s+/g, " ").trim().slice(0, 24);
    ws._stugRoomName = room.name;
    ws._stugId = String(m.id || ws._stugId || ("S-" + stugMid().slice(0, 8))).slice(0, 32);
    stugKickSameIP(room, ws._ip, ws);
    ws._stugId = stugMakeUniqueId(room, ws._stugId, ws);
    let desired = String(m.name || ws._stugId).replace(/\s+/g, " ").trim().slice(0, 24);
    const enf = enforceReservedName(ws, desired, ws._stugName, ws._stugId, "stug");
    desired = enf.name;
    if (alreadyIn && room && room.nameMap && oldName) {
      const ok = normNameKey(oldName);
      if (ok && room.nameMap.get(ok) === ws) room.nameMap.delete(ok);
    }
    const newName = stugMakeUniqueName(room, desired, ws._stugId);
    ws._stugName = newName;
    ws._stugReady = !!(m.ready != null ? m.ready : ws._stugReady);
    if (!ws._stugState) ws._stugState = stugDefaultState();
    room.clients.add(ws);
    if (room.ipMap && ws._ip) room.ipMap.set(ws._ip, ws);
    if (room.nameMap) room.nameMap.set(normNameKey(newName), ws);
    stugSend(ws, { t: "welcome", id: ws._stugId, room: room.name, name: newName, seed: room.seed >>> 0, theater: room.theater, ts: Date.now() });
    if (!alreadyIn) stugBroadcast(room, { t: "sys", msg: `${newName} linked into the STUG net.`, ts: Date.now() }, ws);
    else if (oldName && normNameKey(oldName) !== normNameKey(newName)) stugBroadcast(room, { t: "sys", msg: `${oldName} is now ${newName}.`, ts: Date.now() });
    stugSyncRoster(room);
    return;
  }
  if (!ws._stugRoomName) stugHandle(ws, JSON.stringify({ t: "join", room: m.room || "stug", id: m.id, name: m.name }));
  const room = stugRooms.get(ws._stugRoomName);
  if (!room) return;
  if (t === "ready") {
    ws._stugReady = !!m.ready;
    stugBroadcast(room, { t: "ready", id: ws._stugId, name: ws._stugName, ready: ws._stugReady, ts: Date.now() });
    stugSyncRoster(room);
    return;
  }
  if (t === "chat" || t === "msg") {
    let msg = String(m.msg || m.message || "");
    msg = msg.replace(/\r?\n/g, " ").slice(0, 240);
    const mid = String(m.mid || stugMid()).slice(0, 48);
    stugBroadcast(room, { t: "chat", id: ws._stugId, name: ws._stugName, msg, mid, kind: "player", ts: Date.now() });
    return;
  }
  if (t === "gift") {
    const giftId = String(m.gift_id || stugMid()).slice(0, 64);
    const amount = Math.floor(Number(m.amount || 0));
    const senderId = String(ws._stugId || "").slice(0, 32);
    const senderName = String(ws._stugName || ws._stugId || "COMMANDER").slice(0, 24);
    const wantedId = String(m.to_id || m.recipient_id || "").slice(0, 32);
    const wantedName = String(m.to_name || m.recipient_name || "").replace(/\s+/g, " ").trim().slice(0, 24);
    if (!(amount > 0)) {
      stugSend(ws, { t: "gift_result", ok: false, gift_id: giftId, amount: 0, to_id: wantedId, to_name: wantedName, reason: "BAD_AMOUNT", ts: Date.now() });
      return;
    }
    let recipient = null;
    if (wantedId) {
      for (const ows of room.clients) {
        if (!ows) continue;
        if (String(ows._stugId || "") === wantedId) {
          recipient = ows;
          break;
        }
      }
    }
    if (!recipient && wantedName) {
      const key = normNameKey(wantedName);
      if (key && room.nameMap && room.nameMap.get(key)) recipient = room.nameMap.get(key);
      if (!recipient) {
        for (const ows of room.clients) {
          if (!ows) continue;
          if (normNameKey(ows._stugName || "") === key) {
            recipient = ows;
            break;
          }
        }
      }
    }
    if (!recipient || recipient.readyState !== WebSocket.OPEN || !room.clients.has(recipient)) {
      stugSend(ws, { t: "gift_result", ok: false, gift_id: giftId, amount, to_id: wantedId, to_name: wantedName, reason: "TARGET_OFFLINE", ts: Date.now() });
      return;
    }
    if (recipient === ws || String(recipient._stugId || "") === senderId) {
      stugSend(ws, { t: "gift_result", ok: false, gift_id: giftId, amount, to_id: String(recipient._stugId || wantedId || "").slice(0, 32), to_name: String(recipient._stugName || wantedName || "").slice(0, 24), reason: "SELF_GIFT", ts: Date.now() });
      return;
    }
    const recipientId = String(recipient._stugId || wantedId || "").slice(0, 32);
    const recipientName = String(recipient._stugName || wantedName || recipientId || "COMMANDER").slice(0, 24);
    stugSend(recipient, {
      t: "gift",
      gift_id: giftId,
      from_id: senderId,
      from_name: senderName,
      to_id: recipientId,
      to_name: recipientName,
      amount,
      ts: Date.now()
    });
    stugSend(ws, {
      t: "gift_result",
      ok: true,
      gift_id: giftId,
      from_id: senderId,
      from_name: senderName,
      to_id: recipientId,
      to_name: recipientName,
      amount,
      ts: Date.now()
    });
    return;
  }
  if (t === "state") {
    const prev = ws._stugState || stugDefaultState();
    const anchor = m.anchor || prev.anchor || { x: 0, y: 0 };
    ws._stugState = {
      anchor: {
        x: clamp(Number(anchor.x || 0), -1e9, 1e9),
        y: clamp(Number(anchor.y || 0), -1e9, 1e9),
        vx: clamp(Number(anchor.vx || 0), -1e6, 1e6),
        vy: clamp(Number(anchor.vy || 0), -1e6, 1e6)
      },
      hp: clamp(Number(m.hp != null ? m.hp : prev.hp), 0, 100),
      energy: clamp(Number(m.energy != null ? m.energy : prev.energy), 0, 100),
      escorts_alive: clamp(Number(m.escorts_alive != null ? m.escorts_alive : prev.escorts_alive), 0, 8),
      morale: clamp(Number(m.morale != null ? m.morale : prev.morale), 0, 100),
      mode: String(m.mode || prev.mode || "screen").slice(0, 16),
      heading: clamp(Number(m.heading != null ? m.heading : prev.heading || 0), -360000, 360000),
      target: (m.target && Number.isFinite(Number(m.target.x)) && Number.isFinite(Number(m.target.y))) ? {
        x: clamp(Number(m.target.x), -1e9, 1e9),
        y: clamp(Number(m.target.y), -1e9, 1e9)
      } : null,
      selection: clamp(Number(m.selection != null ? m.selection : prev.selection), -1, 8),
      progression: (m.progression && typeof m.progression === "object") ? {
        level: clamp(Number(m.progression.level != null ? m.progression.level : ((prev.progression && prev.progression.level) || 1)), 1, 9999),
        rank: String(m.progression.rank != null ? m.progression.rank : ((prev.progression && prev.progression.rank) || "")).slice(0, 64)
      } : ((prev.progression && typeof prev.progression === "object") ? prev.progression : { level: 1, rank: "" }),
      escorts: Array.isArray(m.escorts) ? m.escorts.slice(0, 16) : (Array.isArray(prev.escorts) ? prev.escorts : []),
      enemies: Array.isArray(m.enemies) ? m.enemies.slice(0, 64) : (Array.isArray(prev.enemies) ? prev.enemies : []),
      bolts: Array.isArray(m.bolts) ? m.bolts.slice(0, 160) : (Array.isArray(prev.bolts) ? prev.bolts : []),
      cannon: (m.cannon && typeof m.cannon === "object") ? {
        mounted: !!m.cannon.mounted,
        aim: clamp(Number(m.cannon.aim != null ? m.cannon.aim : 0), -360000, 360000),
        retract: clamp(Number(m.cannon.retract != null ? m.cannon.retract : 0), 0, 1),
        recoil: clamp(Number(m.cannon.recoil != null ? m.cannon.recoil : 0), 0, 1),
        flash: clamp(Number(m.cannon.flash != null ? m.cannon.flash : 0), 0, 1)
      } : ((prev.cannon && typeof prev.cannon === "object") ? prev.cannon : null),
      rare_item_bonuses: (m.rare_item_bonuses && typeof m.rare_item_bonuses === "object") ? m.rare_item_bonuses : ((prev.rare_item_bonuses && typeof prev.rare_item_bonuses === "object") ? prev.rare_item_bonuses : null),
      hive_guardian_beams: Array.isArray(m.hive_guardian_beams) ? m.hive_guardian_beams.slice(0, 24) : (Array.isArray(prev.hive_guardian_beams) ? prev.hive_guardian_beams : []),
      inside_hive: (m.inside_hive && typeof m.inside_hive === "object") ? m.inside_hive : ((prev.inside_hive && typeof prev.inside_hive === "object") ? prev.inside_hive : { active: false }),
      inside_hive_shared: (m.inside_hive_shared && typeof m.inside_hive_shared === "object") ? m.inside_hive_shared : ((prev.inside_hive_shared && typeof prev.inside_hive_shared === "object") ? prev.inside_hive_shared : null),
      hive_aftermath: (m.hive_aftermath && typeof m.hive_aftermath === "object") ? m.hive_aftermath : ((prev.hive_aftermath && typeof prev.hive_aftermath === "object") ? prev.hive_aftermath : null),
      routes: (m.routes && typeof m.routes === "object") ? m.routes : ((prev.routes && typeof prev.routes === "object") ? prev.routes : null),
      ts: Date.now()
    };
    const out = {
      t: "state",
      id: String(ws._stugId || "").slice(0, 32),
      name: String(ws._stugName || ws._stugId || "COMMANDER").slice(0, 24),
      state: ws._stugState,
      ts: Date.now()
    };
    stugBroadcast(room, out, ws);
    return;
  }
  if (t === "order") {
    const order = String(m.order || "screen").slice(0, 24);
    const out = {
      t: "order",
      id: String(ws._stugId || "").slice(0, 32),
      name: String(ws._stugName || ws._stugId || "COMMANDER").slice(0, 24),
      order,
      slot: clamp(Number(m.slot != null ? m.slot : -1), -1, 8),
      target: (m.target && Number.isFinite(Number(m.target.x)) && Number.isFinite(Number(m.target.y))) ? {
        x: clamp(Number(m.target.x), -1e9, 1e9),
        y: clamp(Number(m.target.y), -1e9, 1e9)
      } : null,
      ts: Date.now()
    };
    stugBroadcast(room, out, ws);
    return;
  }
  if (t === "story") {
    const text = String(m.text || "").replace(/\r?\n/g, " ").slice(0, 500).trim();
    if (!text) return;
    room.theater.storySeq = ((room.theater.storySeq | 0) + 1) | 0;
    stugBroadcast(room, { t: "story", id: ws._stugId, name: ws._stugName, text, seq: room.theater.storySeq, ts: Date.now() });
    return;
  }
  if (t === "request_state" || t === "sync") {
    stugSend(ws, { t: "roster", room: room.name, seed: room.seed >>> 0, theater: room.theater, commanders: stugRoster(room), ts: Date.now() });
    for (const ows of room.clients) {
      if (!ows || ows === ws || !ows._stugState) continue;
      stugSend(ws, {
        t: "state",
        id: String(ows._stugId || "").slice(0, 32),
        name: String(ows._stugName || ows._stugId || "COMMANDER").slice(0, 24),
        state: ows._stugState,
        ts: Date.now()
      });
    }
    return;
  }
  if (t === "ping") {
    stugSend(ws, { t: "pong", ts: Date.now(), theater: room.theater });
    return;
  }
}
function roomKey(game, room) {
  return `${game}:${room}`;
}
function getRoom(game, roomName) {
  if (String(game || "").toUpperCase() !== "ECF") return null;
  const key = roomKey("ECF", roomName);
  if (!rooms.has(key)) {
    rooms.set(key, {
      game: "ECF",
      name: roomName,
      clients: new Map(),     // id -> ws
      ready: new Map(),       // id -> bool
      seed: null,
      difficulty: 1,
      missionActive: false
    });
  }
  return rooms.get(key);
}
function deleteRoomIfEmpty(room) {
  if (!room) return;
  if (room.game === "ECF" && room.clients.size === 0) rooms.delete(roomKey("ECF", room.name));
}
// ------------
// ECF protocol
// ------------
function ecfBroadcast(room, obj, exceptId = null) {
  const msg = JSON.stringify(obj);
  for (const [id, ws] of room.clients) {
    if (exceptId && id === exceptId) continue;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch {}
    }
  }
}
function ecfRoomState(room) {
  const r = {};
  for (const [id, val] of room.ready) r[id] = !!val;
  const players = [...room.clients.keys()].sort();
  return { t: "room_state", seed: room.seed, difficulty: room.difficulty, ready: r, missionActive: room.missionActive, players };
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
// --------------------------------------------------------------------------------------------------
// ARMORBOUND protocol (2:...)
// Small 700x400 co-op vampire-nest game. One room = two hunters, one shared drop-pod vehicle.
// Clients send:  2:{"t":"join","room":"global","id":"H-XXXX","name":"Hunter","sprite":1}
//                2:{"t":"chat","text":"..."}
//                2:{"t":"role","role":"driver"|"shooter"}
//                2:{"t":"mission_request"}
//                2:{"t":"launch"}
//                2:{"t":"drive","v":{"x":2.5,"y":2.5,"a":0,"hp":100}}
//                2:{"t":"shot","a":0}
// Server sends:  2:{"t":"welcome"} / 2:{"t":"lobby"} / 2:{"t":"mission"} / 2:{"t":"start"}
//                2:{"t":"vehicle"} / 2:{"t":"enemies"} / 2:{"t":"enemy_remove"} / 2:{"t":"complete"}
// --------------------------------------------------------------------------------------------------
const twoRooms = new Map();
function twoSafeId(s, fallback) {
  s = String(s || fallback || ("H-" + rid())).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return s || ("H-" + rid());
}
function twoSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send("2:" + JSON.stringify(obj)); } catch {}
}
function twoBroadcast(room, obj, exceptWs = null) {
  const data = "2:" + JSON.stringify(obj);
  for (const ws of room.clients.keys()) {
    if (!ws || ws === exceptWs || ws.readyState !== WebSocket.OPEN) continue;
    try { ws.send(data); } catch {}
  }
}
function twoGetRoom(roomName) {
  const rn = safeRoomId(roomName || "global", "global");
  if (!twoRooms.has(rn)) {
    twoRooms.set(rn, {
      name: rn,
      clients: new Map(),
      roles: { driver: null, shooter: null },
      mission: null,
      started: false,
      vehicle: { x: 2.5, y: 2.5, a: 0, hp: 100, max_hp: 100 },
      mainGarage: null,
      mainGarageOwnerId: null,
      buffPickups: [],
      activeBuffs: [],
      nesting: null,
      seed: nowSeed(),
      lastTick: Date.now()
    });
  }
  return twoRooms.get(rn);
}
function twoUsers(room) {
  const out = [];
  for (const [ws, meta] of room.clients.entries()) {
    let role = null;
    if (room.roles.driver === meta.id) role = "driver";
    if (room.roles.shooter === meta.id) role = "shooter";
    out.push({
      id: meta.id,
      name: meta.name,
      sprite: meta.sprite,
      x: meta.x,
      y: meta.y,
      dir: meta.dir,
      moving: !!meta.moving,
      role,
      garage: meta.garage || (meta.dnd5e && meta.dnd5e.garage) || null
    });
  }
  out.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  return out;
}
function twoRoleForId(room, id) {
  id = String(id || "");
  if (!room || !id) return null;
  if (String(room.roles.driver || "") === id) return "driver";
  if (String(room.roles.shooter || "") === id) return "shooter";
  return null;
}
function twoMetaById(room, id) {
  id = String(id || "");
  if (!room || !id) return null;
  for (const meta of room.clients.values()) if (String(meta.id || "") === id) return meta;
  return null;
}
function twoCleanGaragePayload(raw) {
  try {
    if (!raw || typeof raw !== "object") return null;
    const effIn = (raw.effects && typeof raw.effects === "object") ? raw.effects : {};
    const allowed = ["max_hull", "ac", "drive", "turn", "regen", "salvage_gain", "salvage_flat", "crit", "wis_save", "cannon_attack", "cannon_damage", "dice_bonus", "aggro", "pickup_radius"];
    const effects = {};
    for (const k of allowed) {
      const v = Number(effIn[k] || 0);
      if (Number.isFinite(v) && Math.abs(v) > 0.000001) effects[k] = v;
    }
    const nodeCount = Math.max(0, Math.min(256, Number(raw.node_count != null ? raw.node_count : raw.install_count) | 0));
    const installCount = Math.max(nodeCount, Math.max(0, Math.min(256, Number(raw.install_count || nodeCount) | 0)));
    const spentLifetime = Math.max(0, Math.min(999999, Number(raw.spent_lifetime || 0) | 0));
    const maxHull = Math.max(50, Math.min(280, Math.round(Number(raw.max_hull || (100 + Number(effects.max_hull || 0))) || 100)));
    return {
      owner_id: String(raw.owner_id || "").slice(0, 64),
      owner_name: String(raw.owner_name || "Hunter").replace(/\s+/g, " ").trim().slice(0, 20) || "Hunter",
      node_count: nodeCount,
      install_count: installCount,
      spent_lifetime: spentLifetime,
      max_hull: maxHull,
      effects
    };
  } catch (_) { return null; }
}
function twoStoreDndPayload(meta, payload, fallbackLevel = 1) {
  if (!meta) return;
  const d = (payload && typeof payload === "object") ? payload : {};
  const cleanGarage = twoCleanGaragePayload(d.garage);
  const cleanStats = {};
  const rawStats = (d.stats && typeof d.stats === "object") ? d.stats : {};
  for (const k of ["STR", "DEX", "CON", "INT", "WIS", "CHA"]) {
    const v = Math.max(1, Math.min(99, Math.round(Number(rawStats[k] || 10))));
    cleanStats[k] = Number.isFinite(v) ? v : 10;
  }
  meta.dnd5e = {
    level: clamp(Number(d.level || fallbackLevel || 1), 1, 20),
    ac: clamp(Math.round(Number(d.ac || d.tank_ac || (meta.dnd5e && meta.dnd5e.ac) || 16)), 10, 35),
    stats: cleanStats
  };
  if (cleanGarage) {
    cleanGarage.owner_id = cleanGarage.owner_id || String(meta.id || "").slice(0, 64);
    cleanGarage.owner_name = cleanGarage.owner_name || String(meta.name || "Hunter").slice(0, 20);
    meta.garage = cleanGarage;
    meta.dnd5e.garage = cleanGarage;
  } else if (meta.garage) {
    meta.dnd5e.garage = meta.garage;
  }
}
function twoMetaGarage(meta) {
  if (!meta) return null;
  return twoCleanGaragePayload(meta.garage || (meta.dnd5e && meta.dnd5e.garage));
}
function twoSelectedGarageMeta(room) {
  if (!room) return null;
  twoCleanRoles(room);
  const ids = [];
  if (room.roles.driver) ids.push(String(room.roles.driver));
  if (room.roles.shooter && String(room.roles.shooter) !== String(room.roles.driver || "")) ids.push(String(room.roles.shooter));
  for (const meta of room.clients.values()) if (ids.indexOf(String(meta.id || "")) < 0) ids.push(String(meta.id || ""));
  let best = null;
  let bestScore = -1;
  for (const id of ids) {
    const meta = twoMetaById(room, id);
    const g = twoMetaGarage(meta);
    if (!meta || !g) continue;
    const d = (meta.dnd5e && typeof meta.dnd5e === "object") ? meta.dnd5e : {};
    const score = Number(g.node_count || 0) * 100000 + Number(g.install_count || 0) * 1000 + Number(g.spent_lifetime || 0) + Number(d.level || 1) * 0.01;
    if (score > bestScore) {
      bestScore = score;
      best = { meta, garage: Object.assign({}, g, { owner_id: String(meta.id || g.owner_id || ""), owner_name: String(meta.name || g.owner_name || "Hunter").slice(0, 20) }) };
    }
  }
  return best;
}
function twoSharedGarage(room) {
  const sel = twoSelectedGarageMeta(room);
  return sel ? sel.garage : null;
}
function twoSharedTankMaxHull(room, fallback = 100) {
  const g = (room && room.mainGarage) ? room.mainGarage : twoSharedGarage(room);
  if (g && Number.isFinite(Number(g.max_hull))) return Math.max(50, Math.min(280, Math.round(Number(g.max_hull))));
  return Math.max(50, Math.min(280, Math.round(Number(fallback || 100))));
}
function twoMetaTankAC(meta, fallback = 16) {
  const d = (meta && meta.dnd5e && typeof meta.dnd5e === "object") ? meta.dnd5e : {};
  const ac = Number(d.ac != null ? d.ac : d.tank_ac);
  if (Number.isFinite(ac)) return clamp(Math.round(ac), 10, 35);
  return clamp(Math.round(Number(fallback || 16)), 10, 35);
}
function twoSharedTankAC(room, fallback = 16) {
  if (!room) return clamp(Math.round(Number(fallback || 16)), 10, 35);
  twoCleanRoles(room);
  const mainId = String(room.mainGarageOwnerId || "");
  if (mainId) {
    const mainMeta = twoMetaById(room, mainId);
    if (mainMeta) return clamp(Math.round(twoMetaTankAC(mainMeta, fallback)), 10, 35);
  }
  const selected = twoSelectedGarageMeta(room);
  if (selected && selected.meta) return clamp(Math.round(twoMetaTankAC(selected.meta, fallback)), 10, 35);
  const driver = twoMetaById(room, room.roles.driver);
  const shooter = twoMetaById(room, room.roles.shooter);
  if (driver && shooter && String(driver.id) !== String(shooter.id)) {
    return clamp(Math.round((twoMetaTankAC(driver, fallback) + twoMetaTankAC(shooter, fallback)) / 2), 10, 35);
  }
  const only = driver || shooter || Array.from(room.clients.values())[0] || null;
  return twoMetaTankAC(only, fallback);
}
function twoActiveBuffCount(room, type) {
  if (!room || !Array.isArray(room.activeBuffs)) return 0;
  const wave = room.mission && room.mission.waves ? Number(room.mission.waves.current || 1) : 1;
  return room.activeBuffs.filter(b => Number(b.type || 0) === Number(type) && Number(b.target_wave || wave) === wave).length;
}
function twoPruneBuffs(room) {
  if (!room) return;
  const wave = room.mission && room.mission.waves ? Number(room.mission.waves.current || 1) : 1;
  room.activeBuffs = Array.isArray(room.activeBuffs) ? room.activeBuffs.filter(b => Number(b.target_wave || wave) >= wave) : [];
  room.buffPickups = Array.isArray(room.buffPickups) ? room.buffPickups.slice(-8) : [];
}
function twoBuffName(type) {
  type = Number(type || 1) | 0;
  if (type === 1) return "Rubius Redline Ampoule";
  if (type === 2) return "Aegis Psalm Relay";
  if (type === 3) return "Gravefire Ballistic Sigil";
  return "Purge Relic";
}
function twoSharedTankACBuffed(room, fallback = 16) {
  const base = twoSharedTankAC(room, fallback);
  return clamp(base + twoActiveBuffCount(room, 2), 10, 35);
}
function twoDropWaveBuff(room, dead) {
  if (!room || !room.mission || !dead) return null;
  room.buffPickups = Array.isArray(room.buffPickups) ? room.buffPickups : [];
  const waves = room.mission.waves || { current: 1, total: 1 };
  const dropWave = Number(waves.current || 1) | 0;
  const existing = room.buffPickups.find(b => Number(b.drop_wave || -1) === dropWave);
  if (existing) return existing;
  const type = 1 + Math.floor(Math.random() * 3);
  const buff = {
    id: Math.floor(100000 + Math.random() * 899999),
    type,
    x: Number(dead.x || 2.5),
    y: Number(dead.y || 2.5),
    drop_wave: dropWave,
    target_wave: Math.min(Number(waves.total || 1), Number(waves.current || 1) + 1),
    pickup_after: Date.now() + 950,
    force_visible_until: Date.now() + 3000,
    name: twoBuffName(type)
  };
  room.buffPickups.push(buff);
  room.buffPickups = room.buffPickups.slice(-8);
  twoBroadcast(room, { t: "buff_drop", buff, ts: Date.now() });
  twoBroadcast(room, { t: "buff_state", pickups: room.buffPickups, active: room.activeBuffs || [], ts: Date.now() });
  twoBroadcast(room, { t: "chat", from: "RELIC", name: "RELIC", text: `${buff.name} dropped from the last guard of wave ${dropWave}.`, ts: Date.now() });
  return buff;
}
function twoApplyBuffPickup(room, buff) {
  if (!room || !buff) return false;
  room.activeBuffs = Array.isArray(room.activeBuffs) ? room.activeBuffs : [];
  const type = Number(buff.type || 1) | 0;
  if (type === 1) {
    room.vehicle.hp = Number(room.vehicle.max_hp || twoSharedTankMaxHull(room, 100) || 100);
  } else {
    room.activeBuffs.push({ type, target_wave: Number(buff.target_wave || ((room.mission && room.mission.waves && room.mission.waves.current) || 1)), name: String(buff.name || twoBuffName(type)), started: Date.now() });
    if (type === 3) {
      const cap = Number(room.vehicle.max_hp || twoSharedTankMaxHull(room, 100) || 100);
      const roll = 1 + Math.floor(Math.random() * 20);
      const gain = roll + cap * 0.02;
      room.vehicle.hp = clamp(Number(room.vehicle.hp || cap) + gain, 0, cap);
      buff.hull_roll = roll;
      buff.hull_gain = gain;
    }
  }
  const ac = twoSharedTankACBuffed(room, room.vehicle.ac || 16);
  room.vehicle.ac = ac;
  room.vehicle.tank_ac = ac;
  room.vehicle.shared_tank_ac = true;
  return true;
}
function twoCheckBuffPickup(room) {
  if (!room || !room.vehicle || !Array.isArray(room.buffPickups)) return;
  const px = Number(room.vehicle.x || 2.5), py = Number(room.vehicle.y || 2.5);
  const live = [];
  for (const b of room.buffPickups) {
    const d = Math.hypot(Number(b.x || px) - px, Number(b.y || py) - py);
    if (d <= 0.96 && Date.now() >= Number(b.pickup_after || 0)) {
      twoApplyBuffPickup(room, b);
      twoBroadcast(room, { t: "buff_pickup", id: b.id, buff: b, vehicle: room.vehicle, active: room.activeBuffs, ts: Date.now() });
      twoBroadcast(room, { t: "vehicle", v: room.vehicle, ts: Date.now() });
    } else live.push(b);
  }
  room.buffPickups = live.slice(-8);
}
function twoSharedMissionLevel(room, fallback = 1) {
  let best = clamp(Number(fallback || 1), 1, 20);
  if (!room) return best;
  for (const meta of room.clients.values()) {
    const d = (meta && meta.dnd5e && typeof meta.dnd5e === "object") ? meta.dnd5e : {};
    const lvl = Number(d.level || 1);
    if (Number.isFinite(lvl)) best = Math.max(best, clamp(lvl, 1, 20));
  }
  return best;
}
function twoKinguStatsFromParty(room) {
  const keys = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];
  const blocks = [];
  if (room) {
    twoCleanRoles(room);
    const ids = [];
    if (room.roles.driver) ids.push(String(room.roles.driver));
    if (room.roles.shooter && String(room.roles.shooter) !== String(room.roles.driver || "")) ids.push(String(room.roles.shooter));
    if (!ids.length) for (const meta of room.clients.values()) ids.push(String(meta.id || ""));
    for (const id of ids) {
      const meta = twoMetaById(room, id);
      const st = meta && meta.dnd5e && meta.dnd5e.stats && typeof meta.dnd5e.stats === "object" ? meta.dnd5e.stats : null;
      if (st) blocks.push(st);
    }
  }
  if (!blocks.length) blocks.push({ STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 });
  const out = {};
  for (const k of keys) out[k] = Math.round((blocks.reduce((a, b) => a + Number(b[k] || 10), 0) / blocks.length) * 3);
  return out;
}
function twoApplyKinguBalance(e, stats) {
  if (!e) return e;
  stats = stats && typeof stats === "object" ? stats : twoKinguStatsFromParty(null);
  e.kingu = true;
  e.elite = true;
  e.elite_type = "kingu";
  e.id = Number(e.id || 9002) | 0;
  if (e.id % 2) e.id += 1;
  e.kind = "Kingu"; e.name = "Kingu"; e.role = "Prime-sire Kingu, original blood-line breach"; e.rank = "prime-sire"; e.class = "Kingu";
  e.archetype = "caster"; e.attack_mode = "wis_save"; e.stats = Object.assign({}, stats);
  const con = Number(stats.CON || 30), str = Number(stats.STR || 30), dex = Number(stats.DEX || 30), intel = Number(stats.INT || 30), wis = Number(stats.WIS || 30), cha = Number(stats.CHA || 30);
  e.max_hp = Math.max(Number(e.max_hp || 0) | 0, 90 + con * 5 + str * 2);
  e.hp = Math.max(Number(e.hp || 0) | 0, e.max_hp);
  e.ac = Math.max(Number(e.ac || 0) | 0, Math.min(35, 15 + Math.max(0, Math.floor((dex - 10) / 6))));
  e.save_dc = Math.max(Number(e.save_dc || 0) | 0, Math.min(35, 8 + Math.max(0, Math.floor((wis - 10) / 3)) + Math.max(0, Math.floor((cha - 10) / 4))));
  e.attack_bonus = Math.max(Number(e.attack_bonus || 0) | 0, Math.min(30, 6 + Math.max(0, Math.floor((intel - 10) / 4)) + Math.max(0, Math.floor((dex - 10) / 6))));
  e.damage_dice = [4, 10];
  e.damage_bonus = Math.max(Number(e.damage_bonus || 0) | 0, 8 + Math.max(0, Math.floor((intel - 10) / 5)) + Math.max(0, Math.floor((cha - 10) / 6)));
  e.attack_range = Math.max(Number(e.attack_range || 0), 7.25); e.prefer_range = Math.max(Number(e.prefer_range || 0), 5.10);
  e.spell_slots_max = Math.max(Number(e.spell_slots_max || 0) | 0, 7); e.spell_slots = Math.max(Number(e.spell_slots || 0) | 0, e.spell_slots_max);
  e.rally_radius = 5.0; e.rally_bonus = 0.0025; e.scale = 1.55; e.body_radius = TWO_ENEMY_RADIUS * 1.55; e.crit_immune = true; e.aggro_immune = true; e.acid_dot = true;
  e.xp = 0;
  return e;
}
function twoMissionIsKinguStage(mission) {
  const c = mission && mission.campaign && typeof mission.campaign === "object" ? mission.campaign : {};
  return !!(c && (Number(c.stage || -1) === 5 || c.final));
}
function twoEnsureKinguForMission(room) {
  if (!room || !room.mission || !twoMissionIsKinguStage(room.mission)) return false;
  const mission = room.mission;
  mission.enemies = Array.isArray(mission.enemies) ? mission.enemies : [];
  const ks = twoKinguStatsFromParty(room);
  let found = false;
  for (const e of mission.enemies) {
    if (e && (e.kingu || String(e.elite_type || "").toLowerCase() === "kingu")) {
      twoApplyKinguBalance(e, ks);
      found = true;
    }
  }
  if (!found) {
    const rnd = twoRnd(Number(mission.seed || nowSeed()) ^ 0x6b1f);
    const target = mission.target || {};
    const p = twoFindOpen(mission.map || [["0"]], rnd, Number(target.mx || target.x || 24), Number(target.my || target.y || 15));
    const rawKingu = { id: 9002, x: Math.round(Number(p.x || 24.5) * 1000) / 1000, y: Math.round(Number(p.y || 15.5) * 1000) / 1000, elite: true, elite_type: "kingu", kingu: true, kingu_stats: ks, militia_delay: 0, enemy_level: twoSharedMissionLevel(room, 20), enemy_wave: 1 };
    mission.enemies.push(twoApplyKinguBalance(twoPrepareEnemy(rawKingu, rnd), ks));
    mission.kingu_spawned = true;
    found = true;
  }
  return found;
}
function twoSendRoleSync(room) {
  if (!room) return;
  for (const [ws, meta] of room.clients.entries()) {
    twoSend(ws, { t: "role_sync", id: meta.id, role: twoRoleForId(room, meta.id), roles: room.roles, ts: Date.now() });
  }
}
function twoSyncLobby(room) {
  twoBroadcast(room, { t: "lobby", room: room.name, roles: room.roles, users: twoUsers(room), started: !!room.started, ts: Date.now() });
  twoSendRoleSync(room);
}
function twoMetaById(room, id) {
  id = String(id || "");
  if (!room || !id) return null;
  for (const meta of room.clients.values()) {
    if (meta && String(meta.id || "") === id) return meta;
  }
  return null;
}
function twoNameById(room, id) {
  const meta = twoMetaById(room, id);
  return meta ? String(meta.name || meta.id || "Hunter").slice(0, 24) : "Hunter";
}
function twoCurrentIds(room) {
  return [...room.clients.values()].map(m => String((m && m.id) || "")).filter(Boolean);
}
function twoCleanRoles(room) {
  const ids = new Set(twoCurrentIds(room));
  if (!ids.has(String(room.roles.driver || ""))) room.roles.driver = null;
  if (!ids.has(String(room.roles.shooter || ""))) room.roles.shooter = null;
  if (room.roles.driver && room.roles.shooter && room.roles.driver === room.roles.shooter && room.clients.size >= 2) {
    const other = twoCurrentIds(room).find(id => id !== room.roles.driver) || null;
    if (other) room.roles.shooter = other;
  }
}
function twoShuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}
function twoAutoAssignRolesForLaunch(room, launcherId) {
  twoCleanRoles(room);
  const ids = twoCurrentIds(room);
  if (!ids.length) return;
  const beforeDriver = room.roles.driver;
  const beforeShooter = room.roles.shooter;
  if (ids.length === 1) {
    const only = ids[0];
    if (!room.roles.driver) room.roles.driver = only;
    if (!room.roles.shooter) room.roles.shooter = only;
  } else {
    if (!room.roles.driver && !room.roles.shooter) {
      const pair = twoShuffle(ids).slice(0, 2);
      room.roles.driver = pair[0];
      room.roles.shooter = pair[1];
    } else if (room.roles.driver && !room.roles.shooter) {
      room.roles.shooter = ids.find(id => id !== room.roles.driver) || room.roles.driver;
    } else if (!room.roles.driver && room.roles.shooter) {
      room.roles.driver = ids.find(id => id !== room.roles.shooter) || room.roles.shooter;
    } else if (room.roles.driver === room.roles.shooter) {
      const other = ids.find(id => id !== room.roles.driver);
      if (other) room.roles.shooter = other;
    }
  }
  if (beforeDriver !== room.roles.driver || beforeShooter !== room.roles.shooter) {
    const d = twoNameById(room, room.roles.driver);
    const g = twoNameById(room, room.roles.shooter);
    twoBroadcast(room, { t: "chat", from: "COMMAND", name: "COMMAND", text: `Launch seats assigned: ${d} drives / ${g} shoots.`, ts: Date.now() });
  }
}
function twoDetach(ws) {
  if (!ws || !ws._twoRoomName) return;
  const room = twoRooms.get(ws._twoRoomName);
  if (room) {
    const meta = room.clients.get(ws);
    room.clients.delete(ws);
    if (meta) {
      if (room.roles.driver === meta.id) room.roles.driver = null;
      if (room.roles.shooter === meta.id) room.roles.shooter = null;
      twoBroadcast(room, { t: "chat", from: "NET", name: "NET", text: `${meta.name || meta.id} disconnected.`, ts: Date.now() });
    }
    if (room.clients.size === 0) twoRooms.delete(room.name);
    else twoSyncLobby(room);
  }
  ws._twoRoomName = null;
}
function twoRnd(seed) {
  let t = (seed >>> 0) || 1;
  return function() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function twoGenMap(w, h, seed) {
  const rnd = twoRnd(seed);
  // Workable by construction: border walls only, plus isolated interior obstructions.
  // Isolated walls cannot partition the map, so every vampire spawn remains reachable.
  const cells = [];
  for (let y = 0; y < h; y++) {
    cells[y] = [];
    for (let x = 0; x < w; x++) {
      cells[y][x] = (x === 0 || y === 0 || x === w - 1 || y === h - 1) ? "1" : "0";
    }
  }
  const shapes = [
    [[0,0],[1,0],[0,1]],
    [[0,0],[-1,0],[1,0],[0,1]],
    [[0,0],[0,1],[1,1]],
    [[0,0],[1,0],[2,0]],
    [[0,0],[0,1],[0,2]],
    [[0,0],[1,0],[1,1],[2,1]],
    [[0,0],[-1,0],[0,1],[1,1]],
    [[0,0],[1,0],[2,0],[2,1]],
    [[0,0],[0,1],[0,2],[1,2]],
    [[0,0],[1,0],[2,0],[3,0]],
    [[0,0],[0,1],[0,2],[0,3]],
    [[0,0],[1,0],[0,1],[1,2]],
    [[0,0],[-1,0],[1,0],[0,1],[0,-1]],
    [[0,0],[1,0],[2,0],[1,1],[2,1]],
  ];
  for (let i = 0; i < 30; i++) {
    const shape = shapes[Math.floor(rnd() * shapes.length)];
    const ox = 3 + Math.floor(rnd() * (w - 6));
    const oy = 3 + Math.floor(rnd() * (h - 6));
    if (ox <= 7 && oy <= 7) continue;
    let ok = true;
    const pts = [];
    for (const [dx, dy] of shape) {
      const x = ox + dx, y = oy + dy;
      if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1 || (x <= 6 && y <= 6)) { ok = false; break; }
      pts.push([x, y]);
    }
    if (!ok) continue;
    for (const [x, y] of pts) cells[y][x] = "1";
  }
  for (let i = 0; i < 26; i++) {
    const x = 3 + Math.floor(rnd() * (w - 6));
    const y = 3 + Math.floor(rnd() * (h - 6));
    if (x <= 7 && y <= 7) continue;
    const n = (cells[y][x+1] === "1" ? 1 : 0) + (cells[y][x-1] === "1" ? 1 : 0) + (cells[y+1][x] === "1" ? 1 : 0) + (cells[y-1][x] === "1" ? 1 : 0);
    if (n <= 2 || rnd() < 0.18) cells[y][x] = "1";
  }
  for (let i = 0; i < 3; i++) {
    if (rnd() < 0.55) {
      const yy = 7 + Math.floor(rnd() * Math.max(1, h - 12));
      const start = 4 + Math.floor(rnd() * 5);
      const end = w - (4 + Math.floor(rnd() * 4));
      for (let xx = start; xx < end; xx++) {
        if (!(xx <= 7 && yy <= 7) && rnd() < 0.74) cells[yy][xx] = "0";
      }
    } else {
      const xx = 8 + Math.floor(rnd() * Math.max(1, w - 14));
      const start = 5 + Math.floor(rnd() * 4);
      const end = h - (4 + Math.floor(rnd() * 4));
      for (let yy = start; yy < end; yy++) {
        if (rnd() < 0.72) cells[yy][xx] = "0";
      }
    }
  }
  for (let y = 1; y <= 5; y++) for (let x = 1; x <= 5; x++) cells[y][x] = "0";
  const seen = new Set();
  const stack = [[2, 2]];
  while (stack.length) {
    const [x, y] = stack.pop();
    const key = `${x},${y}`;
    if (seen.has(key) || x < 0 || y < 0 || x >= w || y >= h || cells[y][x] === "1") continue;
    seen.add(key);
    stack.push([x+1,y],[x-1,y],[x,y+1],[x,y-1]);
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (cells[y][x] === "0" && !seen.has(`${x},${y}`)) cells[y][x] = "1";
    }
  }
  for (let y = 1; y <= 5; y++) for (let x = 1; x <= 5; x++) cells[y][x] = "0";
  return cells.map(row => row.join(""));
}
function twoIsWall(room, x, y) {
  const m = room.mission;
  if (!m || !Array.isArray(m.map) || !m.map.length) return true;
  const xi = Math.floor(Number(x));
  const yi = Math.floor(Number(y));
  if (yi < 0 || yi >= m.map.length || xi < 0 || xi >= m.map[0].length) return true;
  return m.map[yi][xi] === "1";
}
function twoLineClear(room, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.hypot(dx, dy) || 1;
  const steps = Math.max(1, Math.floor(dist / 0.12));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (twoIsWall(room, x0 + dx * t, y0 + dy * t)) return false;
  }
  return true;
}
const TWO_NEST_DELAY_SEC = 12.0;
const TWO_NEST_BUILD_INTERVAL_SEC = 0.72;
const TWO_NEST_RADIUS = 3;
const TWO_NEST_BUILDER_COUNT = 3;
const TWO_NEST_BUILD_RANGE = 1.55;
const TWO_NEST_RALLY_RADIUS = 1.85;
function twoMapCell(map, x, y, fallback = "1") {
  try {
    x = Math.floor(Number(x)); y = Math.floor(Number(y));
    if (!map || y < 0 || y >= map.length || x < 0 || x >= String(map[y] || "").length) return fallback;
    return String(map[y] || "").charAt(x) || fallback;
  } catch { return fallback; }
}
function twoSetMapCell(map, x, y, ch) {
  try {
    x = Math.floor(Number(x)); y = Math.floor(Number(y)); ch = String(ch || "0").charAt(0);
    if (!map || y < 0 || y >= map.length) return false;
    const row = String(map[y] || "");
    if (x < 0 || x >= row.length || row.charAt(x) === ch) return false;
    map[y] = row.slice(0, x) + ch + row.slice(x + 1);
    return true;
  } catch { return false; }
}
function twoReachableCells(map, sx = 2, sy = 2) {
  const h = map ? map.length : 0, w = h ? String(map[0] || "").length : 0;
  sx = Math.max(1, Math.min(w - 2, Math.floor(Number(sx || 2))));
  sy = Math.max(1, Math.min(h - 2, Math.floor(Number(sy || 2))));
  if (twoMapCell(map, sx, sy) === "1") { sx = 2; sy = 2; }
  const seen = new Set();
  const stack = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop();
    const key = x + "," + y;
    if (seen.has(key) || x < 0 || y < 0 || x >= w || y >= h || twoMapCell(map, x, y) === "1") continue;
    seen.add(key);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return seen;
}
function twoSharedInfectedTree(mission) {
  try {
    if (mission && mission.infected_tree && typeof mission.infected_tree === "object") return mission.infected_tree;
    const map = mission && Array.isArray(mission.map) ? mission.map : [];
    const h = map.length, w = h ? String(map[0] || "").length : 0;
    if (w < 5 || h < 5) return null;
    const rnd = twoRnd((Number(mission.seed || 1) ^ 0xB1A6A7E) >>> 0);
    const candidates = [], fallback = [];
    for (let yy = 1; yy < h - 1; yy++) {
      for (let xx = 1; xx < w - 1; xx++) {
        if (twoMapCell(map, xx, yy) === "1" || (xx < 3 && yy < 3)) continue;
        let nearWalls = 0, open = 0;
        for (let oy = -2; oy <= 2; oy++) {
          for (let ox = -2; ox <= 2; ox++) {
            if (ox * ox + oy * oy > 8) continue;
            const c = twoMapCell(map, xx + ox, yy + oy);
            if (c === "1") nearWalls++; else open++;
          }
        }
        if (open >= 5) fallback.push({ x: xx, y: yy, nearWalls });
        if (nearWalls >= 3 && open >= 5) {
          const copies = Math.max(1, Math.min(5, nearWalls));
          for (let n = 0; n < copies; n++) candidates.push({ x: xx, y: yy, nearWalls });
        }
      }
    }
    const pool = candidates.length ? candidates : fallback;
    if (!pool.length) return null;
    const pick = pool[Math.floor(rnd() * pool.length)] || pool[0];
    const tree = {
      kind: "tree", tree_class: "large", infected: true, shared: true,
      x: Number((pick.x + 0.22 + rnd() * 0.56).toFixed(3)),
      y: Number((pick.y + 0.22 + rnd() * 0.56).toFixed(3)),
      size: Number((1.48 + rnd() * 0.24).toFixed(3)),
      trunk_radius: 0.48, rot: Number((-0.26 + rnd() * 0.52).toFixed(3)),
      seed: Math.floor(1 + rnd() * 999999)
    };
    mission.infected_tree = tree;
    return tree;
  } catch { return null; }
}
function twoChooseNestEntrance(map, cx, cy, radius, px, py) {
  const h = map ? map.length : 0, w = h ? String(map[0] || "").length : 0;
  const choices = [
    { x: cx, y: cy - radius, side: "north", outside: [cx, cy - radius - 1], inside: [cx, cy - radius + 1] },
    { x: cx, y: cy + radius, side: "south", outside: [cx, cy + radius + 1], inside: [cx, cy + radius - 1] },
    { x: cx - radius, y: cy, side: "west", outside: [cx - radius - 1, cy], inside: [cx - radius + 1, cy] },
    { x: cx + radius, y: cy, side: "east", outside: [cx + radius + 1, cy], inside: [cx + radius - 1, cy] },
  ];
  const seen = twoReachableCells(map, px, py);
  let best = null, bestScore = -999999;
  for (const c of choices) {
    if (c.x <= 0 || c.y <= 0 || c.x >= w - 1 || c.y >= h - 1) continue;
    const [ox, oy] = c.outside;
    const [ix, iy] = c.inside;
    let score = 0;
    if (seen.has(ox + "," + oy)) score += 500;
    if (twoMapCell(map, ox, oy) !== "1") score += 90;
    if (twoMapCell(map, ix, iy) !== "1") score += 40;
    score -= Math.hypot((ox + 0.5) - Number(px || 2.5), (oy + 0.5) - Number(py || 2.5));
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best || choices[0];
}
function twoNestEntranceUnit(state) {
  try {
    const side = String((state && state.entrance && state.entrance.side) || "north").toLowerCase();
    if (side === "south") return { x: 0, y: 1 };
    if (side === "west") return { x: -1, y: 0 };
    if (side === "east") return { x: 1, y: 0 };
  } catch {}
  return { x: 0, y: -1 };
}
function twoNestTreeInfo(state) {
  try {
    const a = (state && state.anchor) || {};
    const t = (state && state.tree) || {};
    return {
      x: Number(t.x ?? a.x ?? a.cell_x ?? 0),
      y: Number(t.y ?? a.y ?? a.cell_y ?? 0),
      r: Math.max(0.36, Number(t.trunk_radius ?? 0.48) || 0.48)
    };
  } catch { return { x: 0, y: 0, r: 0.48 }; }
}
function twoPushPointOffNestTree(state, px, py, extra = 0.88) {
  const t = twoNestTreeInfo(state);
  px = Number(px); py = Number(py);
  let vx = px - t.x, vy = py - t.y;
  let d = Math.hypot(vx, vy);
  const clear = Math.max(0.96, t.r + Number(extra || 0.88));
  if (d >= clear) return { x: px, y: py };
  if (d <= 0.001) { const u = twoNestEntranceUnit(state); vx = u.x; vy = u.y; d = 1; }
  return { x: t.x + (vx / d) * clear, y: t.y + (vy / d) * clear };
}
function twoSegmentNearNestTree(state, ax, ay, bx, by, extra = 0.82) {
  try {
    const t = twoNestTreeInfo(state);
    ax = Number(ax); ay = Number(ay); bx = Number(bx); by = Number(by);
    const vx = bx - ax, vy = by - ay;
    const den = vx * vx + vy * vy;
    if (den <= 0.0001) return Math.hypot(ax - t.x, ay - t.y) < t.r + extra;
    const q = Math.max(0, Math.min(1, ((t.x - ax) * vx + (t.y - ay) * vy) / den));
    const cx = ax + vx * q, cy = ay + vy * q;
    return Math.hypot(cx - t.x, cy - t.y) < t.r + extra;
  } catch { return false; }
}
function twoNestTreeBypassPoint(room, state, ex, ey, tx, ty) {
  try {
    if (!twoSegmentNearNestTree(state, ex, ey, tx, ty)) return null;
    const map = room && room.mission && Array.isArray(room.mission.map) ? room.mission.map : [];
    const t = twoNestTreeInfo(state);
    const u = twoNestEntranceUnit(state);
    const p1 = { x: u.y, y: -u.x }, p2 = { x: -u.y, y: u.x };
    const sideDist = Math.max(1.18, t.r + 1.05);
    const candidates = [];
    for (const p of [p1, p2]) {
      for (const fwd of [0.72, 0.20, -0.35]) {
        const pushed = twoPushPointOffNestTree(state, t.x + p.x * sideDist + u.x * fwd, t.y + p.y * sideDist + u.y * fwd, 0.98);
        candidates.push(pushed);
      }
    }
    let best = null, bestScore = 999999;
    for (const c of candidates) {
      if (twoMapCell(map, Math.floor(c.x), Math.floor(c.y)) === "1") continue;
      if (twoSegmentNearNestTree(state, ex, ey, c.x, c.y, 0.20)) continue;
      const score = Math.hypot(c.x - Number(ex), c.y - Number(ey)) + Math.hypot(Number(tx) - c.x, Number(ty) - c.y) * 0.72;
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  } catch { return null; }
}
function twoFrontHalfNestCell(side, cx, cy, x, y) {
  side = String(side || "north").toLowerCase();
  if (side === "south") return Number(y) >= Number(cy);
  if (side === "west") return Number(x) <= Number(cx);
  if (side === "east") return Number(x) >= Number(cx);
  return Number(y) <= Number(cy);
}
function twoFrontGatherSortKey(side, cx, cy, entrance, pt) {
  const ex = Number((entrance && entrance.x) || cx) + 0.5;
  const ey = Number((entrance && entrance.y) || cy) + 0.5;
  const x = Number(pt[0]), y = Number(pt[1]);
  return Math.hypot(x - ex, y - ey) * 1000 + Math.abs(x - (Number(cx) + 0.5)) + Math.abs(y - (Number(cy) + 0.5));
}
function twoIsEnemy2(e) {
  try {
    if (String((e && e.archetype) || "").toLowerCase() === "caster") return true;
    if (Number((e && e.spell_slots_max) || 0) > 0) return true;
    const mode = String((e && e.attack_mode) || "").toLowerCase();
    if (["wis_save", "spell", "caster", "ranged"].includes(mode)) return true;
    return (Number((e && e.id) || 1) % 2) === 0;
  } catch { return false; }
}
function twoNestEntranceBundle(state) {
  try {
    const ent = (state && state.entrance) || {};
    const dx = Number(ent.x || 0) | 0, dy = Number(ent.y || 0) | 0;
    const u = twoNestEntranceUnit(state);
    let ux = Math.round(Number(u.x || 0)), uy = Math.round(Number(u.y || 0));
    if (!ux && !uy) { ux = 0; uy = -1; }
    const px = -uy, py = ux;
    return { door: [dx, dy], outside: [dx + ux, dy + uy], inside: [dx - ux, dy - uy], u: [ux, uy], p: [px, py] };
  } catch { return { door: [0, 0], outside: [0, -1], inside: [0, 1], u: [0, -1], p: [1, 0] }; }
}
function twoNestDoorGuardSlots(room, state) {
  const slots = [];
  try {
    const map = room && room.mission && room.mission.map;
    const h = map ? map.length : 0, w = h ? String(map[0] || "").length : 0;
    const b = twoNestEntranceBundle(state);
    const ox = Number(b.outside[0]), oy = Number(b.outside[1]);
    const dx = Number(b.door[0]), dy = Number(b.door[1]);
    const ux = Number(b.u[0]), uy = Number(b.u[1]);
    const px = Number(b.p[0]), py = Number(b.p[1]);
    const sideSets = [
      [[ox + px, oy + py], [ox + px + ux, oy + py + uy], [dx + px, dy + py], [ox + px * 2, oy + py * 2]],
      [[ox - px, oy - py], [ox - px + ux, oy - py + uy], [dx - px, dy - py], [ox - px * 2, oy - py * 2]],
    ];
    const seen = new Set();
    for (let si = 0; si < sideSets.length; si++) {
      let chosen = null;
      for (const c of sideSets[si]) {
        const cx = Number(c[0]) | 0, cy = Number(c[1]) | 0;
        const k = `${cx},${cy}`;
        if (cx <= 0 || cy <= 0 || cx >= w - 1 || cy >= h - 1 || seen.has(k)) continue;
        if (twoNestPerimeterCell(state, cx, cy)) continue;
        if (twoNestVehicleInCell(room, cx, cy)) continue;
        chosen = [cx, cy]; break;
      }
      if (chosen) {
        seen.add(`${chosen[0]},${chosen[1]}`);
        slots.push({ cell: chosen, x: chosen[0] + 0.5, y: chosen[1] + 0.5, side: si === 0 ? "left" : "right" });
      }
    }
  } catch {}
  return slots.slice(0, 2);
}
function twoEnsureNestGuardSlotsOpen(room, state, cells) {
  const slots = twoNestDoorGuardSlots(room, state);
  try {
    state.guard_slots = slots.map(s => [Number(s.cell[0]) | 0, Number(s.cell[1]) | 0]);
    const map = room && room.mission && room.mission.map;
    for (const s of slots) {
      const x = Number(s.cell[0]) | 0, y = Number(s.cell[1]) | 0;
      if (twoSetMapCell(map, x, y, "0") && Array.isArray(cells)) cells.push([x, y, "0"]);
    }
  } catch {}
  return slots;
}
function twoGarrisonPointsAwayFromDoor(state, gather) {
  try {
    const b = twoNestEntranceBundle(state);
    const dx = Number(b.door[0]) + 0.5, dy = Number(b.door[1]) + 0.5;
    const ox = Number(b.outside[0]) + 0.5, oy = Number(b.outside[1]) + 0.5;
    const pts = [];
    for (const g of (gather || [])) {
      const gx = Number(g[0]), gy = Number(g[1]);
      if (Math.hypot(gx - dx, gy - dy) <= 1.42) continue;
      if (Math.hypot(gx - ox, gy - oy) <= 1.72) continue;
      pts.push([gx, gy]);
    }
    return pts.length ? pts : (gather || []);
  } catch { return gather || []; }
}
function twoPlanNesting(room) {
  try {
    const mission = room && room.mission;
    const map = mission && Array.isArray(mission.map) ? mission.map : [];
    const h = map.length, w = h ? String(map[0] || "").length : 0;
    if (!mission || w < 9 || h < 9) return null;
    const tree = twoSharedInfectedTree(mission);
    if (!tree) return null;
    const radius = TWO_NEST_RADIUS;
    const cx = Math.max(4, Math.min(w - 5, Math.floor(Number(tree.x || 4))));
    const cy = Math.max(4, Math.min(h - 5, Math.floor(Number(tree.y || 4))));
    const v = room.vehicle || { x: 2.5, y: 2.5 };
    const entrance = twoChooseNestEntrance(map, cx, cy, radius, Number(v.x || 2.5), Number(v.y || 2.5));
    const keep = new Set();
    keep.add(entrance.x + "," + entrance.y);
    keep.add(entrance.outside[0] + "," + entrance.outside[1]);
    keep.add(entrance.inside[0] + "," + entrance.inside[1]);
    keep.add(cx + "," + cy);
    const build = [];
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1 || (x <= 6 && y <= 6)) continue;
        const perimeter = (x === cx - radius || x === cx + radius || y === cy - radius || y === cy + radius);
        if (!perimeter || keep.has(x + "," + y)) continue;
        if (twoMapCell(map, x, y) !== "1") build.push([x, y]);
      }
    }
    build.sort((a, b) => (Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy)) || (Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx)));
    const gather = [];
    const chamberOpen = [];
    const tempState = {
      anchor: { x: Number(tree.x || cx + 0.5), y: Number(tree.y || cy + 0.5), cell_x: cx, cell_y: cy },
      tree,
      entrance: { x: entrance.x, y: entrance.y, side: entrance.side }
    };
    for (let y = cy - radius + 1; y < cy + radius; y++) {
      for (let x = cx - radius + 1; x < cx + radius; x++) {
        if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) continue;
        chamberOpen.push([x, y]);
        if (x === cx && y === cy) continue;
        if (!twoFrontHalfNestCell(entrance.side, cx, cy, x, y)) continue;
        let g = twoPushPointOffNestTree(tempState, x + 0.5, y + 0.5, 0.88);
        if (twoMapCell(map, Math.floor(g.x), Math.floor(g.y)) === "1") g = { x: x + 0.5, y: y + 0.5 };
        const ti = twoNestTreeInfo(tempState);
        if (Math.hypot(g.x - ti.x, g.y - ti.y) < ti.r + 0.74) continue;
        gather.push([Number(g.x), Number(g.y)]);
      }
    }
    gather.sort((a, b) => twoFrontGatherSortKey(entrance.side, cx, cy, entrance, a) - twoFrontGatherSortKey(entrance.side, cx, cy, entrance, b));
    if (!gather.length) {
      const inside = entrance.inside || [cx, cy];
      const g = twoPushPointOffNestTree(tempState, Number(inside[0]) + 0.5, Number(inside[1]) + 0.5, 0.92);
      gather.push([g.x, g.y]);
    }
    return {
      enabled: true, phase: "waiting", timer: 0, build_timer: 0, delay: TWO_NEST_DELAY_SEC, interval: TWO_NEST_BUILD_INTERVAL_SEC, radius,
      anchor: { x: Number(tree.x || cx + 0.5), y: Number(tree.y || cy + 0.5), cell_x: cx, cell_y: cy },
      tree,
      entrance: { x: entrance.x, y: entrance.y, side: entrance.side },
      keep_open: Array.from(keep).map(k => k.split(",").map(n => Number(n))),
      chamber_open: chamberOpen,
      build_cells: build, built: [], build_index: 0, gather, ceiling: false, started_at: Date.now(), debug_last: "planned", debug_log: []
    };
  } catch { return null; }
}
function twoEnsureNesting(room) {
  if (!room || !room.mission) return null;
  if (room.nesting && room.nesting.enabled) return room.nesting;
  if (room.mission.nesting && room.mission.nesting.enabled) { room.nesting = room.mission.nesting; return room.nesting; }
  room.nesting = twoPlanNesting(room);
  if (room.nesting) room.mission.nesting = room.nesting;
  return room.nesting;
}
function twoNestAliveEnemies(room) {
  try {
    const enemies = room && room.mission && Array.isArray(room.mission.enemies) ? room.mission.enemies : [];
    return enemies.filter(e => e && Number(e.hp || 0) > 0);
  } catch { return []; }
}
function twoNestEnemyKey(e, fallback) {
  const n = Number(e && e.id);
  return Number.isFinite(n) && n !== 0 ? n : Number(fallback || 0);
}
function twoNestBuilderIds(room, state) {
  const enemies = twoNestAliveEnemies(room);
  if (!enemies.length) { state.builder_ids = []; return new Set(); }
  const ax = Number((state.anchor && (state.anchor.x ?? state.anchor.cell_x)) || 2.5);
  const ay = Number((state.anchor && (state.anchor.y ?? state.anchor.cell_y)) || 2.5);
  const cap = Math.max(1, Math.min(TWO_NEST_BUILDER_COUNT, enemies.length));
  const alive = new Set(enemies.map((e, i) => twoNestEnemyKey(e, i + 1)));
  const current = Array.isArray(state.builder_ids) ? state.builder_ids.map(v => Number(v)).filter(v => alive.has(v)).slice(0, cap) : [];
  const used = new Set(current);
  if (current.length < cap) {
    const ranked = [];
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const key = twoNestEnemyKey(e, i + 1);
      if (used.has(key)) continue;
      ranked.push({ key, d: Math.hypot(Number(e.x || ax) - ax, Number(e.y || ay) - ay) });
    }
    ranked.sort((a, b) => a.d - b.d);
    for (const item of ranked) {
      if (current.length >= cap) break;
      current.push(item.key);
      used.add(item.key);
    }
  }
  state.builder_ids = current;
  return new Set(current);
}
function twoCurrentBuildCell(state) {
  try {
    const build = Array.isArray(state.build_cells) ? state.build_cells : [];
    const idx = Number(state.build_index || 0) | 0;
    if (idx >= 0 && idx < build.length) return [Number(build[idx][0]), Number(build[idx][1])];
  } catch {}
  return null;
}
function twoNestWorkCandidates(state, x, y) {
  const out = [];
  const seen = new Set();
  const a = (state && state.anchor) || {};
  const cx = Number.isFinite(Number(a.cell_x)) ? Number(a.cell_x) : Math.floor(Number(a.x || 0));
  const cy = Number.isFinite(Number(a.cell_y)) ? Number(a.cell_y) : Math.floor(Number(a.y || 0));
  function add(wx, wy) { const k = `${wx},${wy}`; if (!seen.has(k)) { seen.add(k); out.push([wx, wy]); } }
  x = Number(x); y = Number(y);
  if (y < cy) add(x, y + 1);
  if (y > cy) add(x, y - 1);
  if (x < cx) add(x + 1, y);
  if (x > cx) add(x - 1, y);
  add(x + 1, y); add(x - 1, y); add(x, y + 1); add(x, y - 1);
  return out;
}
function twoNestDebug(state, msg) {
  try {
    if (!state) return;
    msg = String(msg || '').slice(0, 180);
    state.debug_last = msg;
    if (!Array.isArray(state.debug_log)) state.debug_log = [];
    const stamp = new Date().toTimeString().slice(0, 8);
    const line = `${stamp}  ${msg}`;
    if (!state.debug_log.length || String(state.debug_log[state.debug_log.length - 1]).split('  ').slice(1).join('  ') !== msg) state.debug_log.push(line);
    if (state.debug_log.length > 14) state.debug_log.splice(0, state.debug_log.length - 14);
  } catch {}
}
function twoNestPointWalkable(room, state, px, py) {
  try {
    px = Number(px); py = Number(py);
    const map = room && room.mission && Array.isArray(room.mission.map) ? room.mission.map : [];
    if (twoMapCell(map, Math.floor(px), Math.floor(py)) === "1") return false;
    // Nest workers ignore the black-tree trunk body while operating in the hive.
    // Wall/grid clearance still applies.
    if (!twoCircleOpen(room, px, py, TWO_ENEMY_RADIUS)) return false;
    return true;
  } catch { return false; }
}
function twoNestWorkPoints(room, state, x, y) {
  const out = [];
  const seen = new Set();
  try {
    const map = room && room.mission && Array.isArray(room.mission.map) ? room.mission.map : [];
    const candidates = twoNestWorkCandidates(state, x, y).slice();
    for (const d of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const wx = Number(x) + d[0], wy = Number(y) + d[1];
      if (twoMapCell(map, wx, wy) !== "1") candidates.push([wx, wy]);
    }
    for (const p of candidates) {
      const px = Number(p[0]) + 0.5, py = Number(p[1]) + 0.5;
      const pushed = twoPushPointOffNestTree(state, px, py, 0.66);
      for (const q of [[px, py], [pushed.x, pushed.y]]) {
        const qx = Number(q[0]), qy = Number(q[1]);
        const key = `${Math.round(qx * 1000)},${Math.round(qy * 1000)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (twoNestPointWalkable(room, state, qx, qy)) out.push([qx, qy]);
      }
    }
  } catch {}
  return out;
}
function twoNestWorkPoint(room, state, x, y, prefs = null) {
  try {
    const points = twoNestWorkPoints(room, state, x, y);
    if (!points.length) return null;
    if (Array.isArray(prefs) && prefs.length) {
      points.sort((a, b) => {
        const da = Math.min(...prefs.map(e => Math.hypot(Number(e.x || a[0]) - a[0], Number(e.y || a[1]) - a[1])));
        const db = Math.min(...prefs.map(e => Math.hypot(Number(e.x || b[0]) - b[0], Number(e.y || b[1]) - b[1])));
        return da - db;
      });
    }
    return [Number(points[0][0]), Number(points[0][1])];
  } catch {}
  return null;
}
function twoCurrentWorkPoint(room, state) {
  const cell = twoCurrentBuildCell(state);
  if (!cell) return null;
  const builders = twoNestBuilderIds(room, state);
  const prefs = twoNestAliveEnemies(room).filter((e, i) => builders.has(twoNestEnemyKey(e, i + 1)));
  const work = twoNestWorkPoint(room, state, cell[0], cell[1], prefs);
  if (work) { state.current_wall = [Number(cell[0]), Number(cell[1])]; state.current_work = [Number(work[0]), Number(work[1])]; }
  return work;
}
function twoSelectReachableBuildCell(room, state) {
  try {
    twoRefreshBuildIndex(room, state);
    const cell = twoCurrentBuildCell(state);
    if (!cell) return null;
    const build = Array.isArray(state.build_cells) ? state.build_cells : [];
    const idx = Number(state.build_index || 0) | 0;
    const builders = twoNestBuilderIds(room, state);
    const prefs = twoNestAliveEnemies(room).filter((e, i) => builders.has(twoNestEnemyKey(e, i + 1)));
    if (twoNestWorkPoint(room, state, cell[0], cell[1], prefs)) { twoCurrentWorkPoint(room, state); return cell; }
    for (const it of twoRemainingBuildCells(room, state, 14)) {
      const j = Number(it[0]), x = Number(it[1]), y = Number(it[2]);
      if (j === idx) continue;
      if (twoNestWorkPoint(room, state, x, y, prefs)) {
        const tmp = build[idx]; build[idx] = build[j]; build[j] = tmp;
        state.build_cells = build;
        twoRefreshBuildIndex(room, state);
        twoNestDebug(state, `rotated build target to reachable wall ${build[idx][0]},${build[idx][1]}`);
        twoCurrentWorkPoint(room, state);
        return twoCurrentBuildCell(state);
      }
    }
    return cell;
  } catch { return twoCurrentBuildCell(state); }
}
function twoRemainingBuildCells(room, state, limit = null) {
  const out = [];
  try {
    const map = room && room.mission && Array.isArray(room.mission.map) ? room.mission.map : [];
    const ent = twoNestEntranceCell(state);
    const built = new Set();
    for (const it of (state.built || [])) built.add(`${Number(it[0])},${Number(it[1])}`);
    const build = Array.isArray(state.build_cells) ? state.build_cells : [];
    for (let idx = 0; idx < build.length; idx++) {
      const x = Number(build[idx][0]), y = Number(build[idx][1]);
      if (ent && Number(ent[0]) === x && Number(ent[1]) === y) continue;
      if (twoMapCell(map, x, y) === "1") continue;
      if (!twoNestPerimeterCell(state, x, y)) continue;
      out.push([idx, x, y]);
      if (limit !== null && out.length >= Number(limit)) break;
    }
  } catch {}
  return out;
}
function twoRefreshBuildIndex(room, state) {
  try {
    const rem = twoRemainingBuildCells(room, state, 1);
    if (rem.length) {
      state.build_index = Number(rem[0][0]);
      state.current_wall = [Number(rem[0][1]), Number(rem[0][2])];
      return state.build_index;
    }
    state.build_index = Array.isArray(state.build_cells) ? state.build_cells.length : 0;
    state.current_wall = null;
    state.current_work = null;
    return state.build_index;
  } catch { return Number(state.build_index || 0) | 0; }
}
function twoBuilderJobs(room, state) {
  const jobs = {};
  try {
    const builders = twoNestBuilderIds(room, state);
    if (!builders.size) { state.builder_jobs = {}; return jobs; }
    const enemies = twoNestAliveEnemies(room);
    const alive = [];
    const ax = Number((state.anchor && (state.anchor.x ?? state.anchor.cell_x)) || 2.5);
    const ay = Number((state.anchor && (state.anchor.y ?? state.anchor.cell_y)) || 2.5);
    for (let i = 0; i < enemies.length; i++) {
      const key = twoNestEnemyKey(enemies[i], i + 1);
      if (builders.has(key)) alive.push([key, enemies[i]]);
    }
    alive.sort((a, b) => (Math.hypot(Number(a[1].x || ax) - ax, Number(a[1].y || ay) - ay) - Math.hypot(Number(b[1].x || ax) - ax, Number(b[1].y || ay) - ay)) || (Number(a[0]) - Number(b[0])));
    const remaining = twoRemainingBuildCells(room, state, Math.max(8, alive.length * 6));
    if (!remaining.length) { state.builder_jobs = {}; return jobs; }
    const firstIdx = Number(remaining[0][0]);
    const claimed = new Set();
    for (const pair of alive) {
      const key = Number(pair[0]);
      const e = pair[1];
      const ex = Number(e.x || ax), ey = Number(e.y || ay);
      let best = null, bestScore = 999999;
      for (const it of remaining) {
        const idx = Number(it[0]), x = Number(it[1]), y = Number(it[2]);
        const cellKey = `${x},${y}`;
        if (claimed.has(cellKey)) continue;
        const work = twoNestWorkPoint(room, state, x, y, [e]);
        if (!work) continue;
        const score = Math.hypot(ex - Number(work[0]), ey - Number(work[1])) + Math.max(0, idx - firstIdx) * 0.085;
        if (score < bestScore) { bestScore = score; best = { idx, x, y, wx: Number(work[0]), wy: Number(work[1]) }; }
      }
      if (!best) continue;
      claimed.add(`${best.x},${best.y}`);
      jobs[String(key)] = { idx: best.idx, wall: [best.x, best.y], work: [best.wx, best.wy] };
    }
    state.builder_jobs = jobs;
    const vals = Object.values(jobs);
    if (vals.length) {
      vals.sort((a, b) => Number(a.idx || 999999) - Number(b.idx || 999999));
      state.current_wall = [Number(vals[0].wall[0]), Number(vals[0].wall[1])];
      state.current_work = [Number(vals[0].work[0]), Number(vals[0].work[1])];
    }
  } catch { try { state.builder_jobs = jobs; } catch {} }
  return jobs;
}
function twoBuilderJobFor(state, key) {
  try {
    const jobs = state && state.builder_jobs && typeof state.builder_jobs === "object" ? state.builder_jobs : {};
    return jobs[String(Number(key))] || null;
  } catch { return null; }
}
function twoBuilderReadyForJob(room, state, key, job) {
  try {
    if (!job || typeof job !== "object") return false;
    const x = Number(job.wall[0]), y = Number(job.wall[1]);
    const wx = Number(job.work[0]), wy = Number(job.work[1]);
    const wallX = x + 0.5, wallY = y + 0.5;
    const enemies = twoNestAliveEnemies(room);
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (twoNestEnemyKey(e, i + 1) !== Number(key)) continue;
      const ex = Number(e.x || wallX), ey = Number(e.y || wallY);
      const dWork = Math.hypot(ex - wx, ey - wy);
      const dWall = Math.hypot(ex - wallX, ey - wallY);
      if (dWall <= TWO_NEST_BUILD_RANGE + 0.72 && (dWork <= Math.max(0.88, TWO_NEST_BUILD_RANGE * 0.76) || dWall <= TWO_NEST_BUILD_RANGE + 0.42)) {
        state.current_wall = [x, y];
        state.current_work = [wx, wy];
        twoNestDebug(state, `builder ${Number(key)} working wall ${x},${y}`);
        return true;
      }
      return false;
    }
  } catch {}
  return false;
}
function twoPrepareNestChamber(room, state, cells) {
  try {
    const map = room && room.mission && Array.isArray(room.mission.map) ? room.mission.map : [];
    for (const it of (state.chamber_open || [])) {
      const x = Number(it[0]), y = Number(it[1]);
      if (twoSetMapCell(map, x, y, "0")) cells.push([x, y, "0"]);
    }
  } catch {}
}
function twoNestBuilderNearCell(room, state, x, y) {
  const builders = twoNestBuilderIds(room, state);
  if (!builders.size) { twoNestDebug(state, "no live builders assigned"); return false; }
  const workPoints = twoNestWorkPoints(room, state, x, y);
  if (!workPoints.length) { twoNestDebug(state, `wall ${x},${y} has no usable work point`); return false; }
  const wx = Number(x) + 0.5, wy = Number(y) + 0.5;
  const enemies = twoNestAliveEnemies(room);
  let bestD = 999999;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!builders.has(twoNestEnemyKey(e, i + 1))) continue;
    const ex = Number(e.x || wx), ey = Number(e.y || wy);
    for (const p of workPoints) {
      const tx = Number(p[0]), ty = Number(p[1]);
      const d = Math.hypot(ex - tx, ey - ty);
      bestD = Math.min(bestD, d);
      if (d <= Math.max(0.72, TWO_NEST_BUILD_RANGE * 0.70) && Math.hypot(ex - wx, ey - wy) <= TWO_NEST_BUILD_RANGE + 0.55) {
        state.current_work = [tx, ty];
        twoNestDebug(state, `builder ${twoNestEnemyKey(e, i + 1)} working wall ${x},${y}`);
        return true;
      }
    }
  }
  if (bestD < 999998) twoNestDebug(state, `waiting: nearest builder ${bestD.toFixed(2)} from work point for wall ${x},${y}`);
  return false;
}
function twoAssignNestTargets(room, state) {
  try {
    const enemies = room && room.mission && Array.isArray(room.mission.enemies) ? room.mission.enemies : [];
    const gather = state && Array.isArray(state.gather) ? state.gather : [];
    if (!gather.length) return;
    const phase = String(state.phase || "waiting");
    const ax = Number((state.anchor && state.anchor.x) || 2.5), ay = Number((state.anchor && state.anchor.y) || 2.5);
    const builders = phase === "building" ? twoNestBuilderIds(room, state) : new Set();
    const buildCell = phase === "building" ? twoSelectReachableBuildCell(room, state) : twoCurrentBuildCell(state);
    if (phase === "building") twoBuilderJobs(room, state);
    const guardSlots = phase === "built" ? twoEnsureNestGuardSlotsOpen(room, state, null) : [];
    const guardKeys = [];
    if (phase === "built" && guardSlots.length) {
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (!e || Number(e.hp || 1) <= 0 || twoIsEnemy2(e)) continue;
        guardKeys.push(twoNestEnemyKey(e, i + 1));
        if (guardKeys.length >= Math.min(2, guardSlots.length)) break;
      }
    }
    const guardMap = new Map();
    for (let i = 0; i < Math.min(guardKeys.length, guardSlots.length); i++) guardMap.set(Number(guardKeys[i]), guardSlots[i]);
    const garrison = twoGarrisonPointsAwayFromDoor(state, gather);
    let liveSlot = 0, garrisonSlot = 0;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e || Number(e.hp || 1) <= 0) continue;
      if (phase === "building" || phase === "built") {
        const key = twoNestEnemyKey(e, i + 1);
        const isBuilder = !!(phase === "building" && builders.has(key));
        const isDoorGuard = !!(phase === "built" && guardMap.has(Number(key)));
        let tx, ty, mode = phase, hiveJob = phase === "built" ? "garrison" : "guard-builder";
        if (phase === "building" && isBuilder) {
          if (Math.hypot(Number(e.x || ax) - ax, Number(e.y || ay) - ay) > TWO_NEST_RALLY_RADIUS) { tx = ax; ty = ay; }
          else {
            let job = twoBuilderJobFor(state, key);
            if (!job) { twoBuilderJobs(room, state); job = twoBuilderJobFor(state, key); }
            if (job && job.work) { tx = Number(job.work[0]); ty = Number(job.work[1]); e.hive_build_wall = job.wall; }
            else if (buildCell) { const work = twoCurrentWorkPoint(room, state); if (work) { tx = Number(work[0]); ty = Number(work[1]); } else { const g = gather[liveSlot % Math.max(1, gather.length)]; tx = Number(g[0]); ty = Number(g[1]); } }
            else { const g = gather[liveSlot % Math.max(1, gather.length)]; tx = Number(g[0]); ty = Number(g[1]); }
          }
          hiveJob = "builder";
        } else if (phase === "built" && isDoorGuard) {
          const slot = guardMap.get(Number(key));
          tx = Number(slot.x); ty = Number(slot.y); hiveJob = "door-guard"; e.nest_guard = true; e.nest_guard_slot = slot.side;
          const sx = Number(slot.cell[0]) | 0, sy = Number(slot.cell[1]) | 0;
          if (twoMapCell(room.mission.map, sx, sy) === "1") twoSetMapCell(room.mission.map, sx, sy, "0");
          if (twoMapCell(room.mission.map, Math.floor(Number(e.x || tx)), Math.floor(Number(e.y || ty))) === "1") { e.x = tx; e.y = ty; e.moving = false; e.stuckT = 0; e.aiPathCells = []; }
        } else if (phase === "built") {
          const g = garrison[garrisonSlot % Math.max(1, garrison.length)]; tx = Number(g[0]); ty = Number(g[1]); garrisonSlot++; delete e.nest_guard; delete e.nest_guard_slot;
        } else {
          const g = gather[liveSlot % Math.max(1, gather.length)]; tx = Number(g[0]); ty = Number(g[1]); liveSlot++;
        }
        try {
          const targetIsTreeRally = Math.hypot(Number(tx) - ax, Number(ty) - ay) < 0.72;
          const bypass = (targetIsTreeRally || isDoorGuard) ? null : twoNestTreeBypassPoint(room, state, Number(e.x || tx), Number(e.y || ty), Number(tx), Number(ty));
          if (bypass) { tx = Number(bypass.x); ty = Number(bypass.y); e.nest_route = "tree-bypass"; }
          else delete e.nest_route;
        } catch {}
        e.nest_tx = tx; e.nest_ty = ty; e.nest_anchor_x = ax; e.nest_anchor_y = ay; e.nest_mode = mode; e.nest_builder = isBuilder;
        e.hive_job = hiveJob;
        e.hive_target = [Math.round(Number(tx) * 1000) / 1000, Math.round(Number(ty) * 1000) / 1000];
        e.debug_thought = `${e.hive_job} -> ${Number(tx).toFixed(2)},${Number(ty).toFixed(2)}`;
        if (state.entrance) { e.nest_door_x = Number(state.entrance.x); e.nest_door_y = Number(state.entrance.y); }
      } else {
        delete e.nest_tx; delete e.nest_ty; delete e.nest_anchor_x; delete e.nest_anchor_y; delete e.nest_mode; delete e.nest_builder;
        delete e.hive_job; delete e.hive_target; delete e.debug_thought;
        delete e.nest_door_x; delete e.nest_door_y; delete e.nest_guard; delete e.nest_guard_slot;
      }
    }
  } catch {}
}
function twoEnemyInNestDoorway(e) {
  try {
    const mode = String((e && e.nest_mode) || "");
    if (mode !== "building") return false;
    const dx = Number(e.nest_door_x), dy = Number(e.nest_door_y);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    return Math.hypot(Number(e.x || 0) - (dx + 0.5), Number(e.y || 0) - (dy + 0.5)) <= 1.28;
  } catch { return false; }
}
function twoSameNestDoorway(a, b) {
  try {
    return twoEnemyInNestDoorway(a) && twoEnemyInNestDoorway(b)
      && Number(a.nest_door_x) === Number(b.nest_door_x)
      && Number(a.nest_door_y) === Number(b.nest_door_y);
  } catch { return false; }
}
function twoSameActiveNestSpace(a, b) {
  try {
    const ma = String((a && a.nest_mode) || "");
    const mb = String((b && b.nest_mode) || "");
    if ((ma !== "building" && ma !== "built") || (mb !== "building" && mb !== "built")) return false;
    const ax = Math.round(Number((a && a.nest_anchor_x) || 0) * 100) / 100;
    const ay = Math.round(Number((a && a.nest_anchor_y) || 0) * 100) / 100;
    const bx = Math.round(Number((b && b.nest_anchor_x) || 0) * 100) / 100;
    const by = Math.round(Number((b && b.nest_anchor_y) || 0) * 100) / 100;
    if (ax !== bx || ay !== by) return false;
    const ex = Number((a && a.x) || 0), ey = Number((a && a.y) || 0);
    const ox = Number((b && b.x) || 0), oy = Number((b && b.y) || 0);
    return Math.hypot(ex - ax, ey - ay) <= 4.65 && Math.hypot(ox - bx, oy - by) <= 4.65;
  } catch { return false; }
}
function twoEnemyIdentity(e, idx) {
  const eid = Number(e && e.id);
  return Number.isFinite(eid) ? eid : Number(idx || 0) + 1;
}
function twoEnsureEnemyMind(e, idx) {
  try {
    const eid = twoEnemyIdentity(e, idx);
    const ex = Number(e.x || 0), ey = Number(e.y || 0);
    if (!Number.isFinite(e.spawn_x)) { e.spawn_x = ex; e.spawn_y = ey; }
    if (!Number.isFinite(e.home_x)) { e.home_x = ex; e.home_y = ey; }
    if (!Number.isFinite(e.ai_slot)) e.ai_slot = Math.abs((eid * 1103515245 + 12345) | 0) % 8;
    if (!Number.isFinite(e.ai_patience)) e.ai_patience = 0.86 + (Math.abs(eid) % 7) * 0.045;
    if (!Number.isFinite(e.aiDecideT)) e.aiDecideT = 0.05 + (Math.abs(eid) % 5) * 0.035;
    if (!e.aiGoal) { e.aiGoal = "hold"; e.aiGoalX = ex; e.aiGoalY = ey; }
  } catch {}
  return e;
}
function twoSnapIdleEnemy(e, ex, ey) {
  try {
    e.x = Math.round(Number(Number.isFinite(ex) ? ex : e.x || 0) * 1000) / 1000;
    e.y = Math.round(Number(Number.isFinite(ey) ? ey : e.y || 0) * 1000) / 1000;
    e.moving = false;
    e.avoidT = 0;
    e.avoidBias = 0;
    e.stuckT = 0;
  } catch {}
}
function twoAlertEnemyUnderFire(e, sx, sy, duration = 7.0) {
  if (!e || typeof e !== "object") return e;
  try {
    const x = Number(Number.isFinite(Number(sx)) ? sx : (e.lastX ?? e.x ?? 0));
    const y = Number(Number.isFinite(Number(sy)) ? sy : (e.lastY ?? e.y ?? 0));
    if (Number.isFinite(x) && Number.isFinite(y)) {
      e.lastX = x; e.lastY = y;
      e.last_seen_x = x; e.last_seen_y = y;
    }
    e.shotReactT = Math.max(Number(e.shotReactT || 0), Number(duration || 7.0));
    e.smellT = Math.max(Number(e.smellT || 0), 4.5);
    e.alertT = Math.max(Number(e.alertT || 0), 2.5);
    e.engagedT = Math.max(Number(e.engagedT || 0), Number(duration || 7.0));
    e.aiDecideT = 0;
    e.aiPathCells = [];
    e.stuckT = 0;
    e.avoidT = 0;
    e.brain = "shot-react-pursue";
    e.tactic = "under-fire";
    e.debug_thought = "SHOT REACT: pursue/reposition";
  } catch (_) {}
  return e;
}
function twoCommitEnemyGoal(e, tx, ty, brain, tactic, force) {
  tx = Number(tx); ty = Number(ty);
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return null;
  const oldX = Number.isFinite(Number(e.aiGoalX)) ? Number(e.aiGoalX) : tx;
  const oldY = Number.isFinite(Number(e.aiGoalY)) ? Number(e.aiGoalY) : ty;
  const same = Math.hypot(oldX - tx, oldY - ty) < 0.20 && String(e.aiGoal || "") === String(tactic || brain || "");
  if (!force && same && Number(e.aiDecideT || 0) > 0) {
    e.brain = brain; e.tactic = tactic;
    return { x: oldX, y: oldY };
  }
  e.aiGoal = String(tactic || brain || "move");
  e.aiGoalX = tx; e.aiGoalY = ty;
  const eid = Math.abs(twoEnemyIdentity(e, 0));
  const jitter = ((eid % 11) - 5) * 0.012;
  e.aiDecideT = clamp(Number(e.ai_patience || 1.0) * (0.22 + Math.random() * 0.33) + jitter, 0.16, 0.72);
  e.brain = brain; e.tactic = tactic;
  return { x: tx, y: ty };
}
function twoAllyAlertSignal(e, enemies) {
  try {
    const ex = Number(e.x || 0), ey = Number(e.y || 0);
    let best = null, bestD = 999999;
    for (const o of (enemies || [])) {
      if (!o || o === e || Number(o.hp || 0) <= 0) continue;
      if (!Number.isFinite(Number(o.lastX)) && !Number.isFinite(Number(o.last_seen_x))) continue;
      const alert = Number(o.alertT || o.alert_t || 0), engaged = Number(o.engagedT || o.engaged_t || 0);
      const b = String(o.brain || "");
      if (alert <= 0.20 && engaged <= 0 && !(b.startsWith("paladin-pitbull") || b.startsWith("paladin-intercept") || b.startsWith("ranged-command") || b.startsWith("lich-"))) continue;
      const d = Math.hypot(Number(o.x || ex) - ex, Number(o.y || ey) - ey);
      if (d <= 7.25 && d < bestD) {
        best = { x: Number(o.lastX ?? o.last_seen_x ?? o.x ?? ex), y: Number(o.lastY ?? o.last_seen_y ?? o.y ?? ey), d, alert, engaged };
        bestD = d;
      }
    }
    return best;
  } catch { return null; }
}
function twoPaladinTacticalTarget(room, e, ex, ey, px, py, dist, visible, meleeAttackRange) {
  try {
    if (dist <= Math.max(4.75, meleeAttackRange + 2.15) || (visible && dist <= 6.3)) return { x: px, y: py, brain: "paladin-pitbull-charge", tactic: "maul" };
    const slot = (Number(e.ai_slot || 0) | 0) % 8;
    const base = Math.atan2(ey - py, ex - px);
    const offsets = [0, 0.58, -0.58, 1.04, -1.04, 1.55, -1.55, Math.PI];
    const radius = 1.08 + (slot % 3) * 0.22;
    const order = [slot, (slot + 1) % 8, (slot + 7) % 8, (slot + 2) % 8, (slot + 6) % 8];
    for (const idx of order) {
      const ang = base + offsets[idx];
      const tx = px + Math.cos(ang) * radius, ty = py + Math.sin(ang) * radius;
      if (twoEnemyBodyClear(room, e, tx, ty, room.mission ? room.mission.enemies : [], room.vehicle || { x: px, y: py })) return { x: tx, y: ty, brain: idx === slot ? "paladin-intercept" : "paladin-cutoff", tactic: "cutoff" };
    }
  } catch {}
  return { x: px, y: py, brain: "paladin-intercept", tactic: "intercept" };
}
function twoArriveRadius(e, nestOrder, aware) {
  const base = Math.max(0.24, Number(e.body_radius || TWO_ENEMY_RADIUS) * 0.72);
  if (nestOrder) return Math.max(base, String(e.nest_mode || "") === "built" ? 0.54 : 0.42);
  if (!aware) return Math.max(base, 0.34);
  return base;
}
function twoGridCellFromPoint(x, y) {
  return [Math.floor(Number(x) || 0), Math.floor(Number(y) || 0)];
}
function twoNavCellOpen(room, e, cx, cy, vehicle) {
  try {
    const x = Number(cx) + 0.5, y = Number(cy) + 0.5;
    return twoEnemyBodyClear(room, e, x, y, [], vehicle || room.vehicle || null);
  } catch { return false; }
}
function twoNearestOpenNavCell(room, e, tx, ty, vehicle, maxR) {
  const [gx, gy] = twoGridCellFromPoint(tx, ty);
  if (twoNavCellOpen(room, e, gx, gy, vehicle)) return [gx, gy];
  let best = null, bestD = 999999;
  for (let r = 1; r <= (maxR || 4); r++) {
    for (let yy = gy - r; yy <= gy + r; yy++) {
      for (let xx = gx - r; xx <= gx + r; xx++) {
        if (Math.abs(xx - gx) !== r && Math.abs(yy - gy) !== r) continue;
        if (!twoNavCellOpen(room, e, xx, yy, vehicle)) continue;
        const d = Math.hypot(xx + 0.5 - Number(tx), yy + 0.5 - Number(ty));
        if (d < bestD) { bestD = d; best = [xx, yy]; }
      }
    }
    if (best) return best;
  }
  return null;
}
function twoStraightRouteClear(room, e, ex, ey, tx, ty, vehicle) {
  try {
    const dist = Math.hypot(Number(tx) - Number(ex), Number(ty) - Number(ey));
    if (dist <= 0.35) return true;
    const steps = Math.max(2, Math.min(18, Math.ceil(dist / 0.42)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = Number(ex) + (Number(tx) - Number(ex)) * t;
      const y = Number(ey) + (Number(ty) - Number(ey)) * t;
      if (!twoEnemyBodyClear(room, e, x, y, [], vehicle || room.vehicle || null)) return false;
    }
    return true;
  } catch { return false; }
}
function twoReconstructPath(came, cur) {
  const out = [cur];
  while (came.has(cur.join(','))) {
    cur = came.get(cur.join(','));
    out.push(cur);
  }
  out.reverse();
  return out;
}
function twoPlanGridPath(room, e, ex, ey, tx, ty, vehicle, maxNodes) {
  try {
    const start = twoGridCellFromPoint(ex, ey);
    const goal = twoNearestOpenNavCell(room, e, tx, ty, vehicle, 4);
    if (!goal) return [];
    if (start[0] === goal[0] && start[1] === goal[1]) return [start];
    const pad = 9;
    const minX = Math.min(start[0], goal[0]) - pad, maxX = Math.max(start[0], goal[0]) + pad;
    const minY = Math.min(start[1], goal[1]) - pad, maxY = Math.max(start[1], goal[1]) + pad;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    const open = [{ f: 0, g: 0, c: start }];
    const came = new Map();
    const gscore = new Map([[start.join(','), 0]]);
    const seen = new Set();
    while (open.length && seen.size < (maxNodes || 420)) {
      open.sort((a, b) => a.f - b.f);
      const curItem = open.shift();
      const cur = curItem.c;
      const key = cur.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      if (cur[0] === goal[0] && cur[1] === goal[1]) return twoReconstructPath(came, cur);
      for (const d of dirs) {
        const nx = cur[0] + d[0], ny = cur[1] + d[1];
        if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
        if ((nx !== goal[0] || ny !== goal[1]) && !twoNavCellOpen(room, e, nx, ny, vehicle)) continue;
        if (d[0] && d[1] && (!twoNavCellOpen(room, e, cur[0] + d[0], cur[1], vehicle) || !twoNavCellOpen(room, e, cur[0], cur[1] + d[1], vehicle))) continue;
        const nk = `${nx},${ny}`;
        const step = d[0] && d[1] ? 1.414 : 1.0;
        const tentative = Number(gscore.get(key) || 0) + step;
        if (tentative >= Number(gscore.get(nk) ?? 999999)) continue;
        came.set(nk, cur);
        gscore.set(nk, tentative);
        const h = Math.hypot(goal[0] - nx, goal[1] - ny);
        open.push({ f: tentative + h, g: tentative, c: [nx, ny] });
      }
    }
  } catch {}
  return [];
}
function twoPathCacheValid(e, goal) {
  try {
    return Array.isArray(e.aiPathCells) && e.aiPathCells.length >= 1 && Array.isArray(e.aiPathGoal) && Number(e.aiPathGoal[0]) === Number(goal[0]) && Number(e.aiPathGoal[1]) === Number(goal[1]) && Number(e.aiPathT || 0) > 0;
  } catch { return false; }
}
function twoHiveWaypointForGoal(room, e, ex, ey, tx, ty, vehicle, forcePath) {
  try {
    tx = Number(tx); ty = Number(ty);
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return { x: tx, y: ty };
    const goal = twoNearestOpenNavCell(room, e, tx, ty, vehicle, 4);
    if (!goal) return { x: tx, y: ty };
    const start = twoGridCellFromPoint(ex, ey);
    const direct = twoStraightRouteClear(room, e, ex, ey, tx, ty, vehicle);
    const needPath = !!(forcePath || Number(e.stuckT || 0) > 0.12 || ((start[0] !== goal[0] || start[1] !== goal[1]) && !direct));
    if (!needPath && Math.hypot(tx - ex, ty - ey) < 3.2) return { x: tx, y: ty };
    if (!twoPathCacheValid(e, goal)) {
      if (Number(e.aiPathReplanT || 0) > 0) return { x: tx, y: ty };
      const path = twoPlanGridPath(room, e, ex, ey, tx, ty, vehicle, forcePath ? 300 : 220);
      e.aiPathReplanT = 0.13 + (Math.abs(Number(e.id || 0) | 0) % 5) * 0.025;
      if (path && path.length) { e.aiPathCells = path; e.aiPathGoal = goal; e.aiPathT = forcePath ? 0.74 : 0.42; e.aiPathFail = 0; }
      else { e.aiPathCells = []; e.aiPathT = 0.16; e.aiPathFail = Number(e.aiPathFail || 0) + 1; return { x: tx, y: ty }; }
    } else e.aiPathT = Math.max(0, Number(e.aiPathT || 0) - 0.016);
    const cells = Array.isArray(e.aiPathCells) ? e.aiPathCells : [];
    while (cells.length > 1) {
      const wx = Number(cells[1][0]) + 0.5, wy = Number(cells[1][1]) + 0.5;
      if (Math.hypot(wx - ex, wy - ey) <= Math.max(0.26, Number(e.body_radius || TWO_ENEMY_RADIUS) * 0.92)) cells.shift();
      else break;
    }
    e.aiPathCells = cells;
    if (cells.length > 1) {
      const wx = Number(cells[1][0]) + 0.5, wy = Number(cells[1][1]) + 0.5;
      e.aiWaypointX = wx; e.aiWaypointY = wy;
      return { x: wx, y: wy };
    }
    return { x: tx, y: ty };
  } catch { return { x: tx, y: ty }; }
}
function twoNestRepathGoal(room, e, ex, ey, tx, ty) {
  try {
    const oldD = Math.hypot(tx - ex, ty - ey);
    const base = Math.atan2(ty - ey, tx - ex);
    const offsets = [0, 0.45, -0.45, 0.90, -0.90, 1.35, -1.35, 1.85, -1.85, 2.45, -2.45, Math.PI];
    const dists = [0.72, 1.05, 1.42, 1.90, 2.55];
    let best = null, bestScore = -999999;
    for (const dist of dists) {
      for (const off of offsets) {
        const a = base + off;
        const cx = ex + Math.cos(a) * dist, cy = ey + Math.sin(a) * dist;
        if (!twoEnemyBodyClear(room, e, cx, cy, room.mission ? room.mission.enemies : [], room.vehicle || null)) continue;
        const nd = Math.hypot(tx - cx, ty - cy);
        const score = (oldD - nd) * 7.5 - Math.abs(off) * 0.28 + (nd < oldD + 0.25 ? 0.8 : -1.2);
        if (score > bestScore) { bestScore = score; best = { x: cx, y: cy }; }
      }
    }
    if (best) return best;
    for (const r of [0.65, 1.0, 1.45, 2.0]) {
      for (let i = 0; i < 12; i++) {
        const a = Math.PI * 2 * i / 12 + (i % 2 ? 0.17 : 0);
        const cx = tx + Math.cos(a) * r, cy = ty + Math.sin(a) * r;
        if (twoEnemyBodyClear(room, e, cx, cy, room.mission ? room.mission.enemies : [], room.vehicle || null)) return { x: cx, y: cy };
      }
    }
  } catch {}
  return null;
}
function twoNestEnemyOccupiesCell(e, x, y) {
  try {
    const ex = Number(e.x || 0), ey = Number(e.y || 0);
    const radius = Math.max(0.28, Number(e.body_radius || TWO_ENEMY_RADIUS));
    if (Math.floor(ex) === Number(x) && Math.floor(ey) === Number(y)) return true;
    const cx = Math.max(Number(x), Math.min(ex, Number(x) + 1));
    const cy = Math.max(Number(y), Math.min(ey, Number(y) + 1));
    return Math.hypot(ex - cx, ey - cy) < radius + 0.08;
  } catch { return false; }
}
function twoNestEnemiesInCell(room, x, y) {
  try {
    const enemies = room && room.mission && Array.isArray(room.mission.enemies) ? room.mission.enemies : [];
    return enemies.filter(e => e && Number(e.hp || 1) > 0 && twoNestEnemyOccupiesCell(e, x, y));
  } catch { return []; }
}
function twoNestVehicleInCell(room, x, y) {
  try {
    const v = (room && room.vehicle) || {};
    const vx = Number(v.x || 0), vy = Number(v.y || 0);
    const radius = Math.max(0.30, Number(v.body_radius || TWO_TANK_RADIUS));
    if (Math.floor(vx) === Number(x) && Math.floor(vy) === Number(y)) return true;
    const cx = Math.max(Number(x), Math.min(vx, Number(x) + 1));
    const cy = Math.max(Number(y), Math.min(vy, Number(y) + 1));
    return Math.hypot(vx - cx, vy - cy) < radius + 0.10;
  } catch { return false; }
}
function twoNestEvacPoints(room, state, x, y) {
  const mission = room && room.mission;
  const map = mission && Array.isArray(mission.map) ? mission.map : [];
  const h = map.length, w = h ? String(map[0] || "").length : 0;
  const pts = [];
  try { for (const g of (state.gather || [])) pts.push([Number(g[0]), Number(g[1])]); } catch {}
  try { for (const k of (state.keep_open || [])) pts.push([Number(k[0]) + 0.5, Number(k[1]) + 0.5]); } catch {}
  for (let r = 1; r <= 5; r++) {
    for (let yy = Number(y) - r; yy <= Number(y) + r; yy++) {
      for (let xx = Number(x) - r; xx <= Number(x) + r; xx++) {
        if (xx <= 0 || yy <= 0 || xx >= w - 1 || yy >= h - 1) continue;
        if (Math.abs(xx - Number(x)) !== r && Math.abs(yy - Number(y)) !== r) continue;
        if (twoMapCell(map, xx, yy) !== "1") pts.push([xx + 0.5, yy + 0.5]);
      }
    }
  }
  pts.sort((a, b) => Math.hypot(a[0] - (Number(x) + 0.5), a[1] - (Number(y) + 0.5)) - Math.hypot(b[0] - (Number(x) + 0.5), b[1] - (Number(y) + 0.5)));
  const seen = new Set(), out = [];
  for (const p of pts) {
    const key = p[0].toFixed(3) + "," + p[1].toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    if (twoMapCell(map, Math.floor(p[0]), Math.floor(p[1])) !== "1") out.push(p);
  }
  return out;
}
function twoNestEvacuateEnemy(room, state, e, x, y) {
  for (const p of twoNestEvacPoints(room, state, x, y)) {
    e.x = Math.round(Number(p[0]) * 1000) / 1000;
    e.y = Math.round(Number(p[1]) * 1000) / 1000;
    e.moving = false; e.stuckT = 0; e.avoidT = 0; e.avoidBias = 0;
    return true;
  }
  return false;
}
function twoNestEvacuateFutureWallCell(room, state, x, y) {
  for (const e of twoNestEnemiesInCell(room, x, y)) twoNestEvacuateEnemy(room, state, e, x, y);
}
function twoNestUnstickEnemiesFromWalls(room, state) {
  try {
    const enemies = room && room.mission && Array.isArray(room.mission.enemies) ? room.mission.enemies : [];
    for (const e of enemies) {
      if (!e || Number(e.hp || 1) <= 0) continue;
      const cx = Math.floor(Number(e.x || 0)), cy = Math.floor(Number(e.y || 0));
      if (twoMapCell(room.mission.map, cx, cy) === "1") twoNestEvacuateEnemy(room, state, e, cx, cy);
    }
  } catch {}
}
function twoNestBuildWallNow(room, state, map, x, y, cells, reason) {
  try {
    x = Number(x) | 0; y = Number(y) | 0;
    const ent = twoNestEntranceCell(state);
    if (ent && x === ent[0] && y === ent[1]) return false;
    if (!twoNestPerimeterCell(state, x, y)) return false;
    if (twoMapCell(map, x, y) === "1") {
      if (!Array.isArray(state.built)) state.built = [];
      if (!state.built.some(it => Number(it[0]) === x && Number(it[1]) === y)) state.built.push([x, y]);
      twoRefreshBuildIndex(room, state);
      return false;
    }
    if (twoNestVehicleInCell(room, x, y)) {
      twoNestDebug(state, `deferred occupied wall ${x},${y}: tank in cell`);
      return false;
    }
    twoNestEvacuateFutureWallCell(room, state, x, y);
    if (!Array.isArray(state.built)) state.built = [];
    if (!state.built.some(it => Number(it[0]) === x && Number(it[1]) === y)) state.built.push([x, y]);
    if (twoSetMapCell(map, x, y, "1")) {
      if (Array.isArray(cells)) cells.push([x, y, "1"]);
      twoNestDebug(state, `${reason || "failsafe"} built wall ${x},${y} (${state.built.length}/${Array.isArray(state.build_cells) ? state.build_cells.length : 0})`);
      twoNestUnstickEnemiesFromWalls(room, state);
      twoRefreshBuildIndex(room, state);
      return true;
    }
  } catch {}
  return false;
}
function twoNestSealCompletedShell(room, state, map, cells, force = false) {
  let changed = false;
  try {
    if (!state || !map || !map.length) return false;
    twoNormalizeSingleEntrance(state);
    const ent = twoNestEntranceCell(state);
    const raw = [];
    for (const src of [state.build_cells || [], state.built || []]) {
      for (const it of (src || [])) {
        const x = Number(it[0]) | 0, y = Number(it[1]) | 0;
        if (ent && x === ent[0] && y === ent[1]) continue;
        if (!twoNestPerimeterCell(state, x, y)) continue;
        raw.push([x, y]);
      }
    }
    const seen = new Set();
    for (const it of raw) {
      const x = Number(it[0]) | 0, y = Number(it[1]) | 0;
      const k = `${x},${y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (twoMapCell(map, x, y) !== "1") {
        if (!force && twoNestVehicleInCell(room, x, y)) continue;
        changed = twoNestBuildWallNow(room, state, map, x, y, cells, force ? "final-seal" : "seal") || changed;
      }
    }
    for (const it of (state.keep_open || [])) {
      const x = Number(it[0]) | 0, y = Number(it[1]) | 0;
      if (twoSetMapCell(map, x, y, "0")) { if (Array.isArray(cells)) cells.push([x, y, "0"]); changed = true; }
    }
    state.ceiling = true;
    twoNestUnstickEnemiesFromWalls(room, state);
  } catch {}
  return changed;
}
function twoNestPerimeterCell(state, x, y) {
  try {
    const a = (state && state.anchor) || {};
    const cx = Number.isFinite(Number(a.cell_x)) ? Number(a.cell_x) : Math.floor(Number(a.x || 0));
    const cy = Number.isFinite(Number(a.cell_y)) ? Number(a.cell_y) : Math.floor(Number(a.y || 0));
    const r = Math.max(1, Number((state && state.radius) || 3) | 0);
    x = Number(x) | 0; y = Number(y) | 0;
    return x >= cx - r && x <= cx + r && y >= cy - r && y <= cy + r && (x === cx - r || x === cx + r || y === cy - r || y === cy + r);
  } catch { return false; }
}
function twoNestEntranceCell(state) {
  try {
    const ent = (state && state.entrance) || {};
    return [Number(ent.x || 0) | 0, Number(ent.y || 0) | 0];
  } catch { return null; }
}
function twoNormalizeSingleEntrance(state) {
  try {
    const ent = twoNestEntranceCell(state);
    if (!ent) return;
    const keep = [], seen = new Set();
    for (const it of (state.keep_open || [])) {
      const x = Number(it[0]) | 0, y = Number(it[1]) | 0;
      if (twoNestPerimeterCell(state, x, y) && (x !== ent[0] || y !== ent[1])) continue;
      const key = `${x},${y}`;
      if (!seen.has(key)) { seen.add(key); keep.push([x, y]); }
    }
    const ekey = `${ent[0]},${ent[1]}`;
    if (!seen.has(ekey)) keep.push([ent[0], ent[1]]);
    state.keep_open = keep;
  } catch {}
}
function twoSyncNestBuildProgress(room, state) {
  try {
    const map = room && room.mission && Array.isArray(room.mission.map) ? room.mission.map : [];
    if (!state || !map.length) return false;
    twoNormalizeSingleEntrance(state);
    const ent = twoNestEntranceCell(state);
    const raw = [], seen = new Set();
    for (const src of [state.build_cells || [], state.built || []]) {
      for (const it of (src || [])) {
        const x = Number(it[0]) | 0, y = Number(it[1]) | 0;
        if (ent && x === ent[0] && y === ent[1]) continue;
        if (!twoNestPerimeterCell(state, x, y)) continue;
        const key = `${x},${y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        raw.push([x, y]);
      }
    }
    if (!raw.length) return false;
    const built = [], remaining = [];
    for (const it of raw) {
      const x = Number(it[0]) | 0, y = Number(it[1]) | 0;
      if (twoMapCell(map, x, y) === "1") built.push([x, y]);
      else remaining.push([x, y]);
    }
    state.built = built;
    state.build_cells = built.concat(remaining);
    state.build_index = built.length;
    if (remaining.length) {
      state.phase = "building";
      state.waiting_for_builder = remaining[0];
      state.current_wall = remaining[0];
      state.build_wait_t = 0;
    } else {
      state.phase = "built";
      state.waiting_for_builder = null;
      state.current_wall = null;
    }
    state.builder_ids = [];
    state.builder_jobs = {};
    return true;
  } catch { return false; }
}
function twoResumeNestingForNewWave(room) {
  try {
    const state = twoEnsureNesting(room);
    const mission = room && room.mission;
    const map = mission && Array.isArray(mission.map) ? mission.map : [];
    if (!state || !state.enabled || !map.length) return state;
    if (String(state.phase || "waiting") === "building" || String(state.phase || "waiting") === "built") {
      for (const it of state.keep_open || []) twoSetMapCell(map, Number(it[0]), Number(it[1]), "0");
      twoPrepareNestChamber(room, state, []);
    }
    const resumed = twoSyncNestBuildProgress(room, state);
    if (resumed && String(state.phase || "waiting") === "building") {
      state.build_timer = Math.min(Number(state.build_timer || 0), Math.max(0.15, Number(state.interval || TWO_NEST_BUILD_INTERVAL_SEC)));
      twoSelectReachableBuildCell(room, state);
      twoNestBuilderIds(room, state);
      twoAssignNestTargets(room, state);
      const left = Math.max(0, (Array.isArray(state.build_cells) ? state.build_cells.length : 0) - (Number(state.build_index || 0) | 0));
      twoNestDebug(state, `wave resume: ${(state.built || []).length} built, ${left} walls left; entrance locked`);
    } else if (resumed) {
      twoAssignNestTargets(room, state);
      twoNestDebug(state, "wave resume: nest already built; garrison order renewed");
    }
    mission.nesting = state;
    room.nesting = state;
    return state;
  } catch { return room && room.nesting; }
}
function twoUpdateNesting(room, dtSec) {
  const state = twoEnsureNesting(room);
  const mission = room && room.mission;
  const map = mission && Array.isArray(mission.map) ? mission.map : [];
  if (!state || !map.length) return null;
  const cells = [];
  let phaseChanged = false;
  if (String(state.phase || "waiting") === "building" || String(state.phase || "waiting") === "built") twoNormalizeSingleEntrance(state);
  state.timer = Number(state.timer || 0) + Math.max(0, Number(dtSec || 0));
  if (String(state.phase || "waiting") === "waiting" && state.timer >= Number(state.delay || TWO_NEST_DELAY_SEC)) {
    state.phase = "building";
    state.ceiling = false;
    state.build_timer = 0;
    state.waiting_for_builder = null;
    state.build_wait_t = 0;
    twoNestDebug(state, "phase -> building; hive workers activated");
    phaseChanged = true;
  }
  if (String(state.phase || "waiting") === "building" || String(state.phase || "waiting") === "built") {
    for (const it of state.keep_open || []) {
      if (twoSetMapCell(map, Number(it[0]), Number(it[1]), "0")) cells.push([Number(it[0]), Number(it[1]), "0"]);
    }
    twoPrepareNestChamber(room, state, cells);
    if (String(state.phase || "waiting") === "built") twoEnsureNestGuardSlotsOpen(room, state, cells);
    twoNestUnstickEnemiesFromWalls(room, state);
  }
  twoAssignNestTargets(room, state);
  if (String(state.phase || "waiting") === "building") {
    twoSelectReachableBuildCell(room, state);
    twoBuilderJobs(room, state);
    state.build_timer = Number(state.build_timer || 0) + Math.max(0, Number(dtSec || 0));
    const interval = Math.max(0.15, Number(state.interval || TWO_NEST_BUILD_INTERVAL_SEC));
    while (state.build_timer >= interval) {
      twoRefreshBuildIndex(room, state);
      const remaining = twoRemainingBuildCells(room, state);
      if (!remaining.length) {
        twoNestSealCompletedShell(room, state, map, cells, true);
        state.phase = "built";
        state.ceiling = true;
        twoEnsureNestGuardSlotsOpen(room, state, cells);
        state.waiting_for_builder = null;
        state.builder_jobs = {};
        state.current_wall = null;
        state.current_work = null;
        twoNestDebug(state, "phase -> built; garrison slots active");
        phaseChanged = true;
        break;
      }
      const jobs = twoBuilderJobs(room, state);
      const vals = Object.entries(jobs || {});
      if (!vals.length) {
        state.waiting_for_builder = [Number(remaining[0][1]), Number(remaining[0][2])];
        state.build_wait_t = Number(state.build_wait_t || 0) + Math.max(0, Number(dtSec || 0));
        state.build_timer = Math.min(Number(state.build_timer || 0), interval);
        if (Number(state.build_wait_t || 0) > 1.35) {
          if (twoNestBuildWallNow(room, state, map, Number(remaining[0][1]), Number(remaining[0][2]), cells, "failsafe-no-builder")) {
            state.build_wait_t = 0;
            state.build_timer = Math.max(0, Number(state.build_timer || 0) - interval);
            twoBuilderJobs(room, state);
            twoAssignNestTargets(room, state);
            continue;
          }
        }
        twoNestDebug(state, "waiting: no reachable builder jobs");
        break;
      }
      const ready = [];
      for (const [key, job] of vals) {
        const x = Number(job.wall[0]), y = Number(job.wall[1]);
        if (twoMapCell(map, x, y) === "1") ready.push([Number(job.idx || 999999), Number(key), job, true]);
        else if (twoBuilderReadyForJob(room, state, Number(key), job)) ready.push([Number(job.idx || 999999), Number(key), job, false]);
      }
      if (!ready.length) {
        state.waiting_for_builder = [Number(remaining[0][1]), Number(remaining[0][2])];
        state.build_wait_t = Number(state.build_wait_t || 0) + Math.max(0, Number(dtSec || 0));
        state.build_timer = Math.min(Number(state.build_timer || 0), interval);
        if (Number(state.build_wait_t || 0) > 1.10) {
          state.builder_jobs = {};
          twoSelectReachableBuildCell(room, state);
          twoBuilderJobs(room, state);
          twoAssignNestTargets(room, state);
          twoNestDebug(state, "reassigned builders to reachable hive work points");
        }
        if (Number(state.build_wait_t || 0) > 1.65) {
          if (twoNestBuildWallNow(room, state, map, Number(remaining[0][1]), Number(remaining[0][2]), cells, "failsafe-stalled-builder")) {
            state.build_wait_t = 0;
            state.build_timer = Math.max(0, Number(state.build_timer || 0) - interval);
            twoBuilderJobs(room, state);
            twoAssignNestTargets(room, state);
            continue;
          }
        }
        break;
      }
      ready.sort((a, b) => (Number(a[0]) - Number(b[0])) || (Number(a[1]) - Number(b[1])));
      const builderKey = Number(ready[0][1]);
      const job = ready[0][2];
      const x = Number(job.wall[0]), y = Number(job.wall[1]);
      state.build_timer -= interval;
      state.waiting_for_builder = null;
      state.build_wait_t = 0;
      if (twoMapCell(map, x, y) === "1") {
        if (!Array.isArray(state.built)) state.built = [];
        if (!state.built.some(it => Number(it[0]) === x && Number(it[1]) === y)) state.built.push([x, y]);
        twoRefreshBuildIndex(room, state);
        continue;
      }
      twoNestEvacuateFutureWallCell(room, state, x, y);
      if (twoNestVehicleInCell(room, x, y) || twoNestEnemiesInCell(room, x, y).length) {
        twoNestDebug(state, `deferred occupied wall ${x},${y}`);
        continue;
      }
      if (!Array.isArray(state.built)) state.built = [];
      if (!state.built.some(it => Number(it[0]) === x && Number(it[1]) === y)) state.built.push([x, y]);
      if (twoSetMapCell(map, x, y, "1")) { cells.push([x, y, "1"]); twoNestDebug(state, `builder ${builderKey} built wall ${x},${y} (${state.built.length}/${Array.isArray(state.build_cells) ? state.build_cells.length : 0})`); }
      twoRefreshBuildIndex(room, state);
      twoBuilderJobs(room, state);
    }
    twoAssignNestTargets(room, state);
  }
  if (String(state.phase || "waiting") === "built") {
    if (twoNestSealCompletedShell(room, state, map, cells, false)) phaseChanged = true;
    twoAssignNestTargets(room, state);
  }
  mission.nesting = state;
  room.nesting = state;
  if (!cells.length && !phaseChanged) return null;
  return { cells, map, nesting: state };
}
function twoPointSegmentDistance(ax, ay, bx, by, px, py) {
  const vx = bx - ax, vy = by - ay;
  const denom = vx * vx + vy * vy;
  if (denom <= 0.000001) return { d: Math.hypot(px - ax, py - ay), u: 0 };
  let u = ((px - ax) * vx + (py - ay) * vy) / denom;
  u = clamp(u, 0, 1);
  const cx = ax + vx * u, cy = ay + vy * u;
  return { d: Math.hypot(px - cx, py - cy), u };
}
function twoCastLineBlocker(caster, enemies, px, py, fromX, fromY) {
  const ax = Number.isFinite(fromX) ? Number(fromX) : Number(caster.x || 0);
  const ay = Number.isFinite(fromY) ? Number(fromY) : Number(caster.y || 0);
  const bx = Number(px || 0), by = Number(py || 0);
  if (Math.hypot(bx - ax, by - ay) <= 0.35) return null;
  let best = null, bestU = 999;
  for (const other of (enemies || [])) {
    if (!other || other === caster || Number(other.hp || 0) <= 0) continue;
    const ox = Number(other.x || ax), oy = Number(other.y || ay);
    const hit = twoPointSegmentDistance(ax, ay, bx, by, ox, oy);
    if (hit.u <= 0.075 || hit.u >= 0.92) continue;
    const body = Number(other.body_radius || TWO_ENEMY_RADIUS);
    if (hit.d <= Math.max(0.34, body + 0.18) && hit.u < bestU) { best = other; bestU = hit.u; }
  }
  return best;
}
function twoFindCastLanePoint(room, caster, enemies, px, py) {
  const ex = Number(caster.x || 0), ey = Number(caster.y || 0);
  const dx = Number(px || 0) - ex, dy = Number(py || 0) - ey;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = -dy / dist, ny = dx / dist;
  const fx = dx / dist, fy = dy / dist;
  const sideFirst = Number(caster.flank_dir || 1) < 0 ? -1 : 1;
  let best = null, bestScore = 999999;
  for (const side of [sideFirst, -sideFirst]) {
    for (const lateral of [0.85, 1.25, 1.75, 2.30]) {
      for (const back of [0, -0.45, 0.45]) {
        const cx = ex + nx * side * lateral + fx * back;
        const cy = ey + ny * side * lateral + fy * back;
        if (!twoEnemyBodyClear(room, caster, cx, cy, enemies, room.mission && room.mission.vehicle ? room.mission.vehicle : { x: px, y: py })) continue;
        if (twoCastLineBlocker(caster, enemies, px, py, cx, cy)) continue;
        const score = lateral + Math.abs(back) * 0.35 + Math.hypot(cx - ex, cy - ey) * 0.15;
        if (score < bestScore) { best = { x: cx, y: cy }; bestScore = score; }
      }
    }
  }
  return best;
}
function twoFindOpen(map, rnd, nearX, nearY) {
  const h = map.length, w = map[0].length;
  for (let tries = 0; tries < 200; tries++) {
    let x, y;
    if (Number.isFinite(nearX) && Number.isFinite(nearY)) {
      x = Math.max(1, Math.min(w - 2, Math.floor(nearX + (rnd() - 0.5) * 12)));
      y = Math.max(1, Math.min(h - 2, Math.floor(nearY + (rnd() - 0.5) * 10)));
    } else {
      x = 2 + Math.floor(rnd() * (w - 4));
      y = 2 + Math.floor(rnd() * (h - 4));
    }
    if (map[y] && map[y][x] === "0") return { x: x + 0.5, y: y + 0.5, mx: x, my: y };
  }
  return { x: 2.5, y: 2.5, mx: 2, my: 2 };
}
function twoWaveDieForLevel(level) {
  level = Math.max(1, Math.min(20, Number(level || 1) | 0));
  if (level >= 17) return 12;
  if (level >= 13) return 10;
  if (level >= 9) return 8;
  if (level >= 5) return 6;
  return 4;
}
function twoInitMissionWaves(mission, level) {
  if (!mission || typeof mission !== "object") return {};
  if (mission.waves && Number(mission.waves.total || 0) > 0) return mission.waves;
  const die = twoWaveDieForLevel(level);
  const total = 1 + Math.floor(Math.random() * die) + 1; // 1dN + 1
  mission.waves = { total, die, current: 1, spawned: 1, cleared: 0, level_gate: Math.max(1, Math.min(20, Number(level || 1) | 0)) };
  mission.base_wave_size = Math.max(5, Math.min(10, Array.isArray(mission.enemies) ? mission.enemies.length : 7));
  mission.next_enemy_serial = Math.max(100, Number(mission.next_enemy_serial || 100) | 0);
  return mission.waves;
}
function twoMissionHasNextWave(mission) {
  const w = mission && mission.waves;
  return !!(w && Number(w.current || 1) < Number(w.total || 1));
}
function twoGridWalkable(map, x, y) {
  const gx = Math.floor(Number(x)), gy = Math.floor(Number(y));
  return !!(map && map[gy] && map[gy][gx] === "0");
}
function twoGridNearWall(map, x, y) {
  const gx = Math.floor(Number(x)), gy = Math.floor(Number(y));
  const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
  for (const [ox, oy] of dirs) if (!twoGridWalkable(map, gx + ox, gy + oy)) return true;
  return false;
}
function twoInsideActiveNestSpawnBlock(nesting, x, y) {
  try {
    if (!nesting || typeof nesting !== "object") return false;
    const phase = String(nesting.phase || "");
    if (phase !== "building" && phase !== "built") return false;
    const a = (nesting.anchor && typeof nesting.anchor === "object") ? nesting.anchor : {};
    const cx = Number.isFinite(Number(a.cell_x)) ? Number(a.cell_x) : Math.floor(Number(a.x || 0));
    const cy = Number.isFinite(Number(a.cell_y)) ? Number(a.cell_y) : Math.floor(Number(a.y || 0));
    const r = Math.max(1, Number(nesting.radius || 3) | 0);
    return Math.abs((Number(x) | 0) - cx) <= r + 2 && Math.abs((Number(y) | 0) - cy) <= r + 2;
  } catch { return false; }
}
function twoWaveSpawnCandidates(room) {
  const m = room && room.mission;
  const map = m && Array.isArray(m.map) ? m.map : [];
  const v = room.vehicle || { x: 2.5, y: 2.5 };
  const px = Number(v.x || 2.5), py = Number(v.y || 2.5);
  const h = map.length, w = h ? map[0].length : 0;
  const out = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!twoGridWalkable(map, x, y)) continue;
      if (twoInsideActiveNestSpawnBlock(m && m.nesting, x, y)) continue;
      const cx = x + 0.5, cy = y + 0.5;
      const d = Math.hypot(cx - px, cy - py);
      if (d < 8.25 || (x <= 7 && y <= 7)) continue; // never around the player picture/start area
      const edgeDist = Math.min(x, y, w - 1 - x, h - 1 - y);
      const outer = edgeDist <= 3;
      const wallish = twoGridNearWall(map, x, y);
      if (!outer && !wallish) continue;
      const visible = twoLineClear(room, px, py, cx, cy);
      const score = d + (outer ? 7 : 0) + (wallish ? 3.5 : 0) - (visible ? 9 : 0) - edgeDist * 0.2;
      out.push({ score, x: cx, y: cy, mx: x, my: y });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
const TOXIC_GREEN_HEX = "#75e398";
function twoMarkEliteTrait(tr, eliteType) {
  tr = Object.assign({}, tr || {});
  tr.stats = Object.assign({}, tr.stats || {});
  const rawEliteType = String(eliteType || "").toLowerCase();
  const isKingu = rawEliteType === "kingu";
  eliteType = (rawEliteType === "lich" || rawEliteType === "kingu") ? "lich" : "paladin";
  tr.elite = true;
  tr.elite_type = isKingu ? "kingu" : eliteType;
  tr.crit_immune = true;
  tr.aggro_immune = true;
  tr.rally_radius = 3.0;
  tr.rally_bonus = 0.001;
  tr.scale = 1.333;
  tr.hp = Math.max(1, Math.round(Number(tr.hp || 20) * 1.18));
  tr.ac = Number(tr.ac || 12) + 1;
  if (eliteType === "lich") {
    for (const k of ["DEX", "INT", "WIS"]) tr.stats[k] = Number(tr.stats[k] || 10) + 1 + Math.floor(Math.random() * 4);
    tr.kind = "gem-head-vampire-lich";
    tr.role = "Gem-head Chaotic Evil vampire lich officer";
    tr.rank = "gem-head officer";
    tr.save_dc = Number(tr.save_dc || 14) + 1;
    tr.spell_slots = Number(tr.spell_slots || 4) + 1;
    tr.xp = Math.round(Number(tr.xp || 325) * 1.55);
  } else {
    for (const k of ["STR", "CON", "CHA"]) tr.stats[k] = Number(tr.stats[k] || 10) + 1 + Math.floor(Math.random() * 6);
    tr.kind = "gem-head-vampire-paladin";
    tr.role = "Gem-head Lawful Evil vampire paladin shock elite";
    tr.rank = "gem-head guard";
    tr.attack_bonus = Number(tr.attack_bonus || 7) + 1;
    tr.damage_bonus = Number(tr.damage_bonus || 5) + 2;
    tr.xp = Math.round(Number(tr.xp || 225) * 1.50);
  }
  return tr;
}
function twoApplyRally(room) {
  const enemies = (room && room.mission && Array.isArray(room.mission.enemies)) ? room.mission.enemies : [];
  for (const e of enemies) { e.rallied = false; e.rally_bonus_active = 0; }
  const elites = enemies.filter(e => e && e.elite && Number(e.hp || 0) > 0);
  for (const elite of elites) {
    const ex = Number(elite.x || 0), ey = Number(elite.y || 0);
    const radius = Number(elite.rally_radius || 3.0);
    const bonus = Number(elite.rally_bonus || 0.001);
    for (const other of enemies) {
      if (!other || other === elite || Number(other.hp || 0) <= 0) continue;
      if (Math.hypot(Number(other.x || 0) - ex, Number(other.y || 0) - ey) <= radius) {
        other.rallied = true;
        other.rally_bonus_active = Number(other.rally_bonus_active || 0) + bonus;
      }
    }
  }
}
function twoAddAcidStack(v) {
  if (!v) return 0;
  let stacks = Array.isArray(v.acid_stacks) ? v.acid_stacks.slice(-5) : [];
  const total = Math.max(0, (1 + Math.floor(Math.random() * 6)) - 1);
  stacks.push({ total, remaining: 6.0, source: "acid" });
  v.acid_stacks = stacks.slice(0, 6);
  return total;
}
function twoUpdateAcidStacks(v, dtSec) {
  if (!v || !Array.isArray(v.acid_stacks) || !v.acid_stacks.length) return 0;
  let dmg = 0;
  const live = [];
  for (const st of v.acid_stacks.slice(0, 6)) {
    let rem = Number(st.remaining || 0);
    const total = Number(st.total || 0);
    if (rem <= 0 || total <= 0) continue;
    const tick = Math.min(rem, dtSec);
    dmg += (total / 6.0) * tick;
    rem -= tick;
    if (rem > 0) live.push({ total, remaining: rem, source: "acid" });
  }
  if (dmg > 0) v.hp = clamp(Number(v.hp || 100) - dmg, 0, Number(v.max_hp || 100));
  v.acid_stacks = live;
  return dmg;
}
function twoSpawnWaveElite(room, level) {
  if (!room || !room.mission) return null;
  const mission = room.mission;
  const waves = mission.waves || { current: 1 };
  const waveNo = Number(waves.current || 1) | 0;
  const cands = twoWaveSpawnCandidates(room);
  if (!cands.length) return null;
  const pool = cands.slice(0, Math.max(12, Math.min(cands.length, 36)));
  const p = pool[Math.floor(Math.random() * pool.length)];
  let serial = Math.max(500, Number(mission.next_enemy_serial || 500) | 0) + 1;
  // Enemy 2 elite is reserved for Kingu. Regular half-wave elites are paladins only.
  const eliteType = "paladin";
  let enemyId = eliteType === "lich" ? ((serial % 2 === 0) ? serial : serial + 1) : ((serial % 2 === 1) ? serial : serial + 1);
  const e = twoPrepareEnemy({ id: enemyId, x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000, elite: true, elite_type: eliteType, militia_delay: 0, enemy_level: level, enemy_wave: waveNo }, Math.random);
  mission.next_enemy_serial = enemyId + 1;
  return e;
}
function twoMaybeSpawnWaveElite(room, level) {
  if (!room || !room.mission || !Array.isArray(room.mission.enemies)) return null;
  const mission = room.mission;
  const waves = mission.waves || { current: 1 };
  const waveNo = Number(waves.current || 1) | 0;
  const key = `elite_wave_${waveNo}`;
  if (mission[`${key}_rolled`] || mission[`${key}_spawned`]) return null;
  const start = Math.max(1, Number(mission.wave_start_count || mission.base_wave_size || (mission.enemies.length + 1)) | 0);
  mission.wave_start_count = start;
  const remaining = mission.enemies.filter(e => e && Number(e.hp || 0) > 0).length;
  const killed = Math.max(0, start - remaining);
  if (killed < Math.max(1, Math.ceil(start / 2))) return null;
  const roll = 1 + Math.floor(Math.random() * 20);
  mission[`${key}_rolled`] = roll;
  if (roll < 15) return null;
  const elite = twoSpawnWaveElite(room, level);
  if (elite) mission[`${key}_spawned`] = true;
  return elite;
}
function twoSpawnNextWave(room, level) {
  if (!room || !room.mission) return [];
  const mission = room.mission;
  const waves = twoInitMissionWaves(mission, level);
  if (!twoMissionHasNextWave(mission)) return [];
  waves.cleared = Number(waves.cleared || 0) + 1;
  waves.current = Number(waves.current || 1) + 1;
  waves.spawned = Number(waves.spawned || 1) + 1;
  const cands = twoWaveSpawnCandidates(room);
  if (!cands.length) return [];
  const waveNo = Number(waves.current || 1);
  const base = Number(mission.base_wave_size || 7) | 0;
  const lvl = Math.max(1, Math.min(20, Number(level || waves.level_gate || 1) | 0));
  const total = Math.max(5, Math.min(12, base + Math.floor(waveNo / 3) + Math.floor(lvl / 7)));
  // Enemy 2 is an officer slot, not common filler: max one caster per wave.
  const lichCount = total >= 5 ? 1 : 0;
  const lichSlots = new Set();
  while (lichSlots.size < lichCount) lichSlots.add(Math.floor(Math.random() * total));
  let serial = Math.max(100, Number(mission.next_enemy_serial || 100) | 0);
  const pool = cands.slice(0, Math.max(18, Math.min(cands.length, total * 9)));
  const used = new Set();
  const enemies = [];
  for (let i = 0; i < total; i++) {
    let p = null;
    for (let tries = 0; tries < 80; tries++) {
      const cand = pool[Math.floor(Math.random() * pool.length)];
      const key = `${cand.mx},${cand.my}`;
      if (used.has(key)) continue;
      if (enemies.some(e => Math.hypot(cand.x - e.x, cand.y - e.y) < 1.25)) continue;
      used.add(key);
      p = cand;
      break;
    }
    if (!p) p = pool[Math.min(i, pool.length - 1)];
    serial += 1;
    let enemyId;
    if (lichSlots.has(i)) {
      enemyId = (serial % 2 === 0) ? serial : serial + 1;
    } else {
      enemyId = (serial % 2 === 1) ? serial : serial + 1;
    }
    serial = enemyId;
    enemies.push(twoPrepareEnemy({ id: enemyId, x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000, militia_delay: 0.65 + Math.random() * 1.2, enemy_level: lvl, enemy_wave: waveNo }, Math.random));
  }
  mission.next_enemy_serial = serial + 1;
  mission.enemies = enemies;
  mission.wave_start_count = enemies.length;
  try { twoResumeNestingForNewWave(room); } catch {}
  delete mission[`elite_wave_${waveNo}_rolled`];
  delete mission[`elite_wave_${waveNo}_spawned`];
  return enemies;
}
function twoNosferatuTrait(eid) {
  const odd = ((Math.max(1, Number(eid || 1) | 0) % 2) === 1);
  if (odd) {
    return {
      archetype: "brute", kind: "vampire-paladin-ogre", role: "Lawful Evil ogre-sized vampire paladin shock trooper loyal to the lich officer",
      class: "Paladin", alignment: "Lawful Evil", size: "Ogre", creature_type: "Undead Vampire Paladin", rank: "guard",
      stats: { STR: 19, DEX: 11, CON: 18, INT: 9, WIS: 12, CHA: 15 },
      ac: 16, hp: 42, speed: 1.25, lunge: 2.18,
      attack_bonus: 7, damage_dice: [2, 8], damage_bonus: 5,
      attack: 14, range: 0.64, prefer_range: 0, cooldown: 0.64, flank: 0.28,
      xp: 225, save_dc: 0, attack_mode: "melee"
    };
  }
  return {
    archetype: "caster", kind: "vampire-lich-officer", role: "higher-rank Chaotic Evil orcish vampire lich officer",
    class: "Lich", alignment: "Chaotic Evil", size: "Orcish", creature_type: "Undead Vampire Lich", rank: "officer",
    stats: { STR: 10, DEX: 16, CON: 12, INT: 19, WIS: 16, CHA: 17 },
    ac: 14, hp: 26, speed: 0.72, lunge: 0.90,
    attack_bonus: 7, damage_dice: [2, 6], damage_bonus: 4,
    attack: 11, range: 6.45, prefer_range: 4.65, cooldown: 1.25, flank: 0.80, spell_slots: 4, spell_recharge: 3.35,
    xp: 325, save_dc: 14, attack_mode: "wis_save"
  };
}
function twoRollDice(count, sides) {
  count = Math.max(1, Math.min(20, Number(count || 1) | 0));
  sides = Math.max(2, Math.min(100, Number(sides || 6) | 0));
  let total = 0;
  for (let i = 0; i < count; i++) total += 1 + Math.floor(Math.random() * sides);
  return total;
}
function twoResolveShotDamage(dnd, enemy) {
  dnd = (dnd && typeof dnd === "object") ? dnd : {};
  const atk = clamp(Number(dnd.attack_bonus != null ? dnd.attack_bonus : 4), -5, 18);
  const dice = Array.isArray(dnd.damage_dice) ? dnd.damage_dice : [2, 8];
  const dc = Math.max(1, Math.min(8, Number(dice[0] || 2) | 0));
  const ds = Math.max(2, Math.min(20, Number(dice[1] || 8) | 0));
  const bonus = clamp(Number(dnd.damage_bonus != null ? dnd.damage_bonus : 2), -5, 20);
  let d20 = 1 + Math.floor(Math.random() * 20);
  if (d20 === 20 && (enemy.elite || enemy.crit_immune)) d20 = 1;
  const ac = Number(enemy.ac || 12);
  const hit = d20 !== 1 && (d20 === 20 || d20 + atk >= ac);
  const crit = hit && d20 === 20;
  const extraD4 = Math.max(0, Math.min(8, Number(dnd.buff_damage_d4 || 0) | 0));
  const damage = hit ? Math.max(1, twoRollDice(dc * (crit ? 2 : 1), ds) + bonus + (extraD4 ? twoRollDice(extraD4, 4) : 0)) : 0;
  return { d20, attack_bonus: atk, ac, hit, crit, damage };
}
function twoCombatLog(room, text) {
  try {
    if (!room || !text) return;
    twoBroadcast(room, { t: "combat_log", text: String(text).slice(0, 180), ts: Date.now() });
  } catch (_) {}
}
function twoShotRollText(roll, enemy) {
  const label = (enemy && (enemy.kingu || String(enemy.elite_type || "").toLowerCase() === "kingu")) ? "KINGU" : ((enemy && enemy.elite ? "GEM " : "") + (String((enemy && enemy.archetype) || "") === "caster" ? "LICH" : "PAL"));
  const total = Number(roll.d20 || 0) + Number(roll.attack_bonus || 0);
  if (roll.hit) return `SHOT${roll.crit ? " CRIT" : ""}: d20 ${roll.d20}+${roll.attack_bonus}=${total} vs AC ${roll.ac} ${label} -> HIT ${roll.damage}`;
  return `SHOT: d20 ${roll.d20}+${roll.attack_bonus}=${total} vs AC ${roll.ac} ${label} -> ${Number(roll.d20 || 0) === 1 ? "JAM" : "MISS"}`;
}
function twoResolveEnemyDamage(e, v) {
  const mode = String(e.attack_mode || "melee");
  const label = (e && (e.kingu || String(e.elite_type || "").toLowerCase() === "kingu")) ? "KINGU" : ((e && e.elite ? "GEM " : "") + (String(e.archetype || "") === "caster" ? "LICH" : "PAL"));
  if (mode === "wis_save") {
    const dc = Number(e.save_dc || 13);
    const bonus = Number(v.wis_save || 0);
    const d20 = 1 + Math.floor(Math.random() * 20);
    const saved = d20 !== 1 && (d20 === 20 || d20 + bonus >= dc);
    const dice = Array.isArray(e.damage_dice) ? e.damage_dice : [2, 6];
    let raw = twoRollDice(dice[0], dice[1]) + Number(e.damage_bonus || 0);
    raw *= (1.0 + Number(e.rally_bonus_active || 0));
    const damage = Math.max(1, saved ? Math.floor(raw / 2) : Math.floor(raw));
    return { damage, text: `${label} WIS SAVE: d20 ${d20}+${bonus} vs DC ${dc} -> ${saved ? "SAVE" : "FAIL"} / ${damage} hull` };
  }
  const ac = Number(v.ac || 16);
  const d20 = 1 + Math.floor(Math.random() * 20);
  const atk = Number(e.attack_bonus || 4);
  const total = d20 + atk;
  const hit = d20 !== 1 && (d20 === 20 || total >= ac);
  if (!hit) return { damage: 0, text: `${label}: d20 ${d20}+${atk}=${total} vs TANK AC ${ac} -> MISS` };
  const dice = Array.isArray(e.damage_dice) ? e.damage_dice : [2, 6];
  let out = twoRollDice(dice[0] * (d20 === 20 ? 2 : 1), dice[1]) + Number(e.damage_bonus || 0);
  out *= (1.0 + Number(e.rally_bonus_active || 0));
  const damage = Math.max(1, Math.floor(out));
  return { damage, text: `${label}${d20 === 20 ? " CRIT" : ""}: d20 ${d20}+${atk}=${total} vs TANK AC ${ac} -> HIT ${damage}` };
}
function twoScaleTraitForLevel(tr, level, wave) {
  tr = Object.assign({}, tr || {});
  tr.stats = Object.assign({}, tr.stats || {});
  level = Math.max(1, Math.min(20, Number(level || tr.enemy_level || 1) | 0));
  wave = Math.max(1, Math.min(99, Number(wave || tr.enemy_wave || 1) | 0));
  const l = level - 1;
  const w = Math.max(0, wave - 1);
  const officer = String(tr.archetype || "") === "caster" || String(tr.rank || "") === "officer";
  let hpMult = 1.0 + 0.135 * l + 0.040 * w;
  if (officer) hpMult += 0.025 * l;
  tr.hp = Math.max(1, Math.round(Number(tr.hp || 20) * hpMult));
  tr.ac = Math.max(8, Math.min(28, Number(tr.ac || 12) + Math.floor(l / 4) + Math.floor(w / 6)));
  tr.attack_bonus = Number(tr.attack_bonus || 4) + Math.floor(l / 3) + Math.floor(w / 5);
  tr.damage_bonus = Number(tr.damage_bonus || 0) + Math.floor(l / 2) + Math.floor(w / 3);
  if (officer) {
    tr.save_dc = Number(tr.save_dc || 13) + Math.floor(l / 4) + Math.floor(w / 7);
    tr.spell_slots = Number(tr.spell_slots || 4) + Math.floor(l / 6) + Math.floor(w / 8);
    tr.spell_recharge = Math.max(1.45, Number(tr.spell_recharge || 3.35) - 0.045 * l - 0.020 * w);
    tr.speed = Math.min(Number(tr.speed || 0.72) * (1.0 + Math.min(0.18, 0.006 * l)), 1.05);
  } else {
    tr.speed = Math.min(Number(tr.speed || 1.25) * (1.0 + Math.min(0.22, 0.007 * l)), 1.70);
    tr.lunge = Math.min(Number(tr.lunge || 2.18) * (1.0 + Math.min(0.18, 0.006 * l)), 2.85);
  }
  tr.attack = tr.damage_bonus + (Array.isArray(tr.damage_dice) ? tr.damage_dice[0] * ((tr.damage_dice[1] + 1) / 2) : Number(tr.attack || 10));
  tr.xp = Math.round(Number(tr.xp || 100) * (1.0 + 0.055 * l + 0.018 * w));
  tr.enemy_level = level;
  tr.enemy_wave = wave;
  return tr;
}
function twoPrepareEnemy(e, rnd) {
  e = (e && typeof e === "object") ? e : {};
  const eid = Math.max(1, Number(e.id || 1) | 0);
  let tr = twoNosferatuTrait(eid);
  const eLevel = Math.max(1, Math.min(20, Number(e.enemy_level || e.level || 1) | 0));
  const eWave = Math.max(1, Math.min(99, Number(e.enemy_wave || e.wave || 1) | 0));
  tr = twoScaleTraitForLevel(tr, eLevel, eWave);
  if (e.elite) tr = twoMarkEliteTrait(tr, e.elite_type || (String(tr.archetype) === "caster" ? "lich" : "paladin"));
  const fresh = !e.dnd5e;
  e.id = eid;
  e.dnd5e = true;
  e.enemy_level = Number(tr.enemy_level || eLevel || 1) | 0;
  e.enemy_wave = Number(tr.enemy_wave || eWave || 1) | 0;
  // ID owns the rules archetype; do not preserve stale mission/cached packets.
  e.archetype = String(tr.archetype);
  e.kind = String(tr.kind);
  e.role = String(tr.role);
  e.stats = e.elite ? tr.stats : ((e.stats && typeof e.stats === "object") ? e.stats : tr.stats);
  e.ac = Number(tr.ac);
  e.max_hp = Math.max(Number(e.max_hp || 0) | 0, Number(tr.hp || 20) | 0);
  const hasHp = Object.prototype.hasOwnProperty.call(e, "hp") && e.hp !== null && e.hp !== undefined;
  const ehp = Number(e.hp || 0) | 0;
  e.hp = (!hasHp || fresh) ? e.max_hp : Math.max(1, Math.min(ehp, e.max_hp));
  e.speed = Number(tr.speed);
  e.lunge_speed = Number(tr.lunge);
  e.attack_bonus = Number(tr.attack_bonus);
  e.damage_dice = tr.damage_dice;
  e.damage_bonus = Number(tr.damage_bonus);
  e.attack_damage = Number(tr.attack);
  e.attack_range = Number(tr.range);
  e.prefer_range = Number(tr.prefer_range || 0);
  e.body_radius = Number(e.body_radius || TWO_ENEMY_RADIUS);
  if (tr.elite) {
    e.elite = true; e.elite_type = String(tr.elite_type || (String(e.archetype) === "caster" ? "lich" : "paladin"));
    e.crit_immune = true; e.aggro_immune = true; e.scale = 1.333;
    e.rally_radius = 3.0; e.rally_bonus = 0.001;
    e.body_radius = TWO_ENEMY_RADIUS * 1.333;
    if (String(e.archetype) === "caster") e.acid_dot = true;
  }
  if (e.kingu || String(e.elite_type || "").toLowerCase() === "kingu") twoApplyKinguBalance(e, e.kingu_stats || e.stats);
  e.attack_cooldown = Number(tr.cooldown);
  e.flank_bias = Number(tr.flank);
  e.flank_dir = Number(e.flank_dir || ((eid % 2) ? -1 : 1));
  e.xp = Number(tr.xp);
  e.save_dc = Number(tr.save_dc || 0);
  e.attack_mode = String(tr.attack_mode || "melee");
  e.spell_slots_max = Number(tr.spell_slots || 0) | 0;
  if (String(e.archetype || "") === "caster") {
    if (e.spell_slots === undefined || e.spell_slots === null) e.spell_slots = e.spell_slots_max;
    e.spell_slots = Math.max(0, Math.min(Number(e.spell_slots || 0) | 0, e.spell_slots_max));
    e.spellRechargeT = Number(e.spellRechargeT || e.spell_recharge_t || 0);
    e.spellRechargeNeed = Number(tr.spell_recharge || 2.75);
  } else {
    e.spell_slots = 0;
    e.spellRechargeT = 0;
    e.spellRechargeNeed = 0;
  }
  e.attackT = Number(e.attackT || ((rnd ? rnd() : Math.random()) * 0.34));
  e.smellT = Number(e.smellT || 0);
  e.lungeT = Number(e.lungeT || e.lunge_t || 0);
  e.castingT = Number(e.castingT || e.casting_t || 0);
  e.stuckT = Number(e.stuckT || 0);
  if (e.aiPathReplanT === undefined || e.aiPathReplanT === null) {
    e.aiPathReplanT = 0.035 + (Math.abs(eid) % 7) * 0.025 + ((rnd ? rnd() : Math.random()) * 0.035);
  }
  return e;
}
const TWO_ENEMY_RADIUS = 0.32;
const TWO_TANK_RADIUS = 0.48;
const TWO_ENEMY_TANK_STANDOFF = TWO_ENEMY_RADIUS + TWO_TANK_RADIUS + 0.10;
const TWO_ENEMY_ENEMY_STANDOFF = TWO_ENEMY_RADIUS * 2.0 + 0.10;
function twoCircleOpen(room, x, y, radius) {
  const r = Math.max(0, Number(radius || 0)) * 1.08;
  if (twoIsWall(room, x, y)) return false;
  if (r <= 0.01) return true;
  const d = r * 0.707;
  const samples = [
    [ r, 0], [-r, 0], [0,  r], [0, -r],
    [ d, d], [-d, d], [d, -d], [-d, -d],
    [ r * 0.38, 0], [-r * 0.38, 0], [0, r * 0.38], [0, -r * 0.38],
  ];
  for (const [ox, oy] of samples) if (twoIsWall(room, x + ox, y + oy)) return false;
  return true;
}
function twoVehicleCanStand(room, x, y, oldX = null, oldY = null) {
  if (!twoCircleOpen(room, x, y, 0.30)) return false;
  oldX = Number(oldX == null ? x : oldX);
  oldY = Number(oldY == null ? y : oldY);
  const enemies = room && room.mission && Array.isArray(room.mission.enemies) ? room.mission.enemies : [];
  for (const o of enemies) {
    if (!o || Number(o.hp || 1) <= 0) continue;
    const ox = Number(o.x || x), oy = Number(o.y || y);
    const orad = Number(o.body_radius || TWO_ENEMY_RADIUS);
    const minD = orad + TWO_TANK_RADIUS + 0.08;
    const oldD = Math.hypot(oldX - ox, oldY - oy);
    const newD = Math.hypot(x - ox, y - oy);
    if (newD < minD && newD <= oldD + 0.006) return false;
  }
  return true;
}
function twoEnemyBodyClear(room, e, nx, ny, enemies, vehicle) {
  const ex = Number(e.x || 0), ey = Number(e.y || 0);
  const radius = Number(e.body_radius || TWO_ENEMY_RADIUS);
  if (!twoCircleOpen(room, nx, ny, radius)) return false;
  const v = vehicle || room.vehicle || { x: 2.5, y: 2.5 };
  const px = Number(v.x || 2.5), py = Number(v.y || 2.5);
  const minTankD = radius + Number(v.body_radius || TWO_TANK_RADIUS) + 0.08;
  const oldTankD = Math.hypot(ex - px, ey - py);
  const newTankD = Math.hypot(nx - px, ny - py);
  if (newTankD < minTankD && newTankD <= oldTankD + 0.006) return false;
  for (const o of (enemies || [])) {
    if (!o || o === e || Number(o.hp || 1) <= 0) continue;
    if (twoSameNestDoorway(e, o) || twoSameActiveNestSpace(e, o)) continue;
    const ox = Number(o.x || ex), oy = Number(o.y || ey);
    const orad = Number(o.body_radius || TWO_ENEMY_RADIUS);
    const minD = radius + orad + 0.08;
    const oldD = Math.hypot(ex - ox, ey - oy);
    const newD = Math.hypot(nx - ox, ny - oy);
    if (newD < minD && newD <= oldD + 0.006) return false;
  }
  return true;
}
function twoMoveEnemy(room, e, nx, ny, enemies, vehicle) {
  const ex = Number(e.x || 0), ey = Number(e.y || 0);
  if (twoEnemyBodyClear(room, e, nx, ny, enemies, vehicle)) { e.x = Math.round(nx * 1000) / 1000; e.y = Math.round(ny * 1000) / 1000; return true; }
  if (twoEnemyBodyClear(room, e, nx, ey, enemies, vehicle)) { e.x = Math.round(nx * 1000) / 1000; return true; }
  if (twoEnemyBodyClear(room, e, ex, ny, enemies, vehicle)) { e.y = Math.round(ny * 1000) / 1000; return true; }
  return false;
}
function twoBodyPressureScore(e, nx, ny, enemies, vehicle) {
  const radius = Number(e.body_radius || TWO_ENEMY_RADIUS);
  let score = 0;
  const v = vehicle || { x: 2.5, y: 2.5 };
  const pd = Math.hypot(nx - Number(v.x || 2.5), ny - Number(v.y || 2.5));
  const pmin = radius + Number(v.body_radius || TWO_TANK_RADIUS) + 0.12;
  if (pd < pmin + 0.85) score -= (pmin + 0.85 - pd) * 4.5;
  for (const o of enemies || []) {
    if (!o || o === e || Number(o.hp || 1) <= 0) continue;
    if (twoSameNestDoorway(e, o) || twoSameActiveNestSpace(e, o)) continue;
    const d = Math.hypot(nx - Number(o.x || nx), ny - Number(o.y || ny));
    const minD = radius + Number(o.body_radius || TWO_ENEMY_RADIUS) + 0.14;
    if (d < minD + 0.90) score -= (minD + 0.90 - d) * 5.25;
  }
  return score;
}
function twoWallForwardClear(room, nx, ny, ux, uy, radius) {
  const probe = Math.max(0.18, Number(radius || TWO_ENEMY_RADIUS) * 0.92);
  const side = Math.max(0.12, Number(radius || TWO_ENEMY_RADIUS) * 0.55);
  const px = nx + ux * probe, py = ny + uy * probe;
  const sx = -uy * side, sy = ux * side;
  return !twoIsWall(room, px, py) && !twoIsWall(room, px + sx, py + sy) && !twoIsWall(room, px - sx, py - sy);
}
function twoWallClearanceScore(room, nx, ny, radius) {
  const r = Math.max(0.18, Number(radius || TWO_ENEMY_RADIUS) * 1.12);
  const samples = [[r,0],[-r,0],[0,r],[0,-r],[r*0.75,r*0.75],[-r*0.75,r*0.75],[r*0.75,-r*0.75],[-r*0.75,-r*0.75]];
  let score = 0, blocked = 0;
  for (const [ox, oy] of samples) {
    if (!twoIsWall(room, nx + ox, ny + oy)) score += 0.10;
    else { blocked += 1; score -= 0.72; }
  }
  if (blocked >= 2) score -= 1.20 + blocked * 0.28;
  return score;
}
function twoWallContactVector(room, nx, ny, radius) {
  try {
    const r = Math.max(0.20, Number(radius || TWO_ENEMY_RADIUS) * 1.18);
    const samples = [[r,0],[-r,0],[0,r],[0,-r],[r*0.72,r*0.72],[-r*0.72,r*0.72],[r*0.72,-r*0.72],[-r*0.72,-r*0.72]];
    let ax = 0, ay = 0, hits = 0;
    for (const [ox, oy] of samples) {
      if (twoIsWall(room, Number(nx) + ox, Number(ny) + oy)) { ax -= ox; ay -= oy; hits++; }
    }
    if (!hits) return { x: 0, y: 0, hits: 0 };
    const mag = Math.hypot(ax, ay) || 1;
    return { x: ax / mag, y: ay / mag, hits };
  } catch { return { x: 0, y: 0, hits: 0 }; }
}
function twoEmergencyUnstickStep(room, e, ex, ey, tx, ty, step, enemies, vehicle) {
  try {
    const radius = Number(e.body_radius || TWO_ENEMY_RADIUS);
    step = Math.max(0.10, Math.min(Math.max(0.16, Number(step || 0) * 1.35), 0.34));
    const away = twoWallContactVector(room, ex, ey, radius);
    const toAng = Math.atan2(Number(ty) - Number(ey), Number(tx) - Number(ex));
    const angles = [];
    if (away.hits > 0) {
      const a = Math.atan2(away.y, away.x);
      angles.push(a, a + 0.70, a - 0.70);
    }
    angles.push(toAng);
    for (let i = 0; i < 8; i++) angles.push(i * Math.PI * 2 / 8);
    const oldD = Math.hypot(Number(tx) - Number(ex), Number(ty) - Number(ey));
    const oldClear = twoWallClearanceScore(room, ex, ey, radius);
    let best = null, bestScore = -999999;
    const seen = new Set();
    for (const ang of angles) {
      for (const scale of [1.0, 0.72, 0.48]) {
        const ux = Math.cos(ang), uy = Math.sin(ang);
        const nx = Number(ex) + ux * step * scale, ny = Number(ey) + uy * step * scale;
        const key = `${Math.round(nx*1000)},${Math.round(ny*1000)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!twoEnemyBodyClear(room, e, nx, ny, enemies, vehicle)) continue;
        const newD = Math.hypot(Number(tx) - nx, Number(ty) - ny);
        const clear = twoWallClearanceScore(room, nx, ny, radius);
        const awayScore = away.hits > 0 ? (ux * away.x + uy * away.y) : 0;
        let score = (clear - oldClear) * 5.0 + (oldD - newD) * 3.25 + awayScore * 2.2 + scale * 0.15;
        if (away.hits > 0 && clear > oldClear + 0.20) score += 2.0;
        if (score > bestScore) { bestScore = score; best = { nx, ny, ux, uy }; }
      }
    }
    if (!best) return false;
    e.x = Math.round(best.nx * 1000) / 1000;
    e.y = Math.round(best.ny * 1000) / 1000;
    e.avoidBias = (best.ux * (-(Number(ty) - Number(ey))) + best.uy * (Number(tx) - Number(ex))) > 0 ? 1 : -1;
    e.avoidT = 0.62;
    e.aiPathCells = [];
    e.aiPathT = 0;
    e.aiPathReplanT = 0;
    return true;
  } catch { return false; }
}
function twoSteeredMove(room, e, ex, ey, mx, my, step, tx, ty, enemies, vehicle) {
  if (!Number.isFinite(step) || step <= 0.0001) return false;
  const base = Math.atan2(my, mx);
  const radius = Number(e.body_radius || TWO_ENEMY_RADIUS);
  const flank = Number(e.flank_dir || 1) < 0 ? -1 : 1;
  const oldD = Math.hypot(tx - ex, ty - ey);
  const sideOrder = Number(e.avoidBias || 0) > 0 ? [1, -1] : (Number(e.avoidBias || 0) < 0 ? [-1, 1] : [flank, -flank]);
  const offsets = [0];
  for (const mag of [0.38, 0.82, 1.28, 1.80]) for (const side of sideOrder) offsets.push(side * mag);
  offsets.push(Math.PI);
  let best = null, bestScore = -999999;
  for (const scale of [1.0, 0.70, 0.46]) {
    const ds = step * scale;
    for (const off of offsets) {
      const ang = base + off, ux = Math.cos(ang), uy = Math.sin(ang);
      const nx = ex + ux * ds, ny = ey + uy * ds;
      if (!twoEnemyBodyClear(room, e, nx, ny, enemies, vehicle)) continue;
      const wallClear = twoWallForwardClear(room, nx, ny, ux, uy, radius);
      if (!wallClear && scale > 0.50) continue;
      const progress = (oldD - Math.hypot(tx - nx, ty - ny)) * 8.0;
      const pressure = twoBodyPressureScore(e, nx, ny, enemies, vehicle);
      const clearance = twoWallClearanceScore(room, nx, ny, radius) * 0.55;
      const score = progress + pressure + clearance + (wallClear ? 0.42 : -0.55) - Math.abs(off) * 0.36 - (Math.abs(off) > 2.4 ? 0.80 : 0) + scale * 0.12;
      if (score > bestScore) { bestScore = score; best = { nx, ny, off }; }
    }
  }
  if (!best) return false;
  e.x = Math.round(best.nx * 1000) / 1000;
  e.y = Math.round(best.ny * 1000) / 1000;
  if (Math.abs(best.off) > 0.30) { e.avoidBias = best.off > 0 ? 1 : -1; e.avoidT = 0.36; }
  else { e.avoidT = Math.max(0, Number(e.avoidT || 0) - 0.08); if (e.avoidT <= 0) e.avoidBias = 0; }
  return true;
}
function twoFindCoverPoint(room, ex, ey, px, py) {
  const away = Math.atan2(ey - py, ex - px);
  let best = null;
  let bestScore = -999999;
  const radii = [1.1, 1.7, 2.35, 3.0];
  const offs = [0, 0.45, -0.45, 0.9, -0.9, 1.35, -1.35, Math.PI];
  for (const radius of radii) {
    for (const off of offs) {
      const ang = away + off;
      const cx = ex + Math.cos(ang) * radius;
      const cy = ey + Math.sin(ang) * radius;
      if (twoIsWall(room, cx, cy)) continue;
      const blocked = !twoLineClear(room, px, py, cx, cy);
      const distGain = Math.hypot(cx - px, cy - py);
      const score = (blocked ? 8 : 0) + distGain - Math.abs(off) * 0.45;
      if (score > bestScore) { bestScore = score; best = { x: cx, y: cy, covered: blocked }; }
    }
  }
  if (best) return best;
  return { x: ex + Math.cos(away) * 2.0, y: ey + Math.sin(away) * 2.0, covered: false };
}
function twoCampaignPayload(raw) {
  try {
    if (!raw || typeof raw !== "object" || !raw.enabled) return null;
    const stage = Math.max(0, Math.min(5, Number(raw.stage || 0) | 0));
    const location = String(raw.location || raw.city || "Unknown Seed Nest").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!location) return null;
    const code = String(raw.code || ("SEED NEST " + String(raw.roman || stage + 1))).replace(/\s+/g, " ").trim().slice(0, 80);
    return {
      enabled: true,
      title: String(raw.title || "SEED NEST CAMPAIGN").slice(0, 64),
      stage,
      roman: String(raw.roman || "?").slice(0, 8),
      code,
      city: String(raw.city || "").slice(0, 48),
      region: String(raw.region || "").slice(0, 48),
      country: String(raw.country || "").slice(0, 48),
      location,
      lat: Number.isFinite(Number(raw.lat)) ? Number(raw.lat) : 0,
      lon: Number.isFinite(Number(raw.lon)) ? Number(raw.lon) : 0,
      subtitle: String(raw.subtitle || "").slice(0, 180),
      final: !!raw.final
    };
  } catch { return null; }
}
function twoMissionMatchesCampaign(mission, campaignReq = null) {
  const campaign = twoCampaignPayload(campaignReq);
  if (!campaign) return true;
  if (!mission || typeof mission !== "object") return false;
  const mc = (mission.campaign && typeof mission.campaign === "object") ? mission.campaign : {};
  if (!mc.enabled) return false;
  const mStage = Number(mc.stage != null ? mc.stage : -1) | 0;
  const cStage = Number(campaign.stage != null ? campaign.stage : -2) | 0;
  if (mStage !== cStage) return false;
  const mLoc = String(mission.location || mc.location || "").replace(/\s+/g, " ").trim();
  const cLoc = String(campaign.location || "").replace(/\s+/g, " ").trim();
  if (cLoc && mLoc && mLoc !== cLoc) return false;
  return true;
}
function twoSpawnMission(room, campaignReq = null, level = 1) {
  const seed = nowSeed();
  const rnd = twoRnd(seed);
  const w = 32, h = 22;
  const map = twoGenMap(w, h, seed);
  const target = twoFindOpen(map, rnd, 24, 15);
  const campaign = twoCampaignPayload(campaignReq);
  const codes = ["ASH CHOIR", "BLACK ALTAR", "GLASS COFFIN", "STATIC ORCHARD", "DEAD VOLT", "RED CHAPEL", "NULL BASILICA", "HOLLOW RELAY"];
  const raidCode = codes[Math.floor(rnd() * codes.length)] + "-" + Math.floor(100 + rnd() * 899);
  const code = campaign ? campaign.code : raidCode;
  const enemies = [];
  const count = 7 + Math.floor(rnd() * 5);
  const used = new Set(["2,2"]);
  const officerSlot = Math.floor(rnd() * Math.max(1, count));
  let palSerial = 1;
  for (let i = 0; i < count; i++) {
    let p = null;
    for (let tries = 0; tries < 240; tries++) {
      const cand = twoFindOpen(map, rnd, target.x, target.y);
      const key = `${cand.mx},${cand.my}`;
      if (key !== "2,2" && !used.has(key) && map[cand.my] && map[cand.my][cand.mx] === "0") {
        used.add(key);
        p = cand;
        break;
      }
    }
    if (!p) p = { x: 2.5 + i * 0.35, y: 7.5, mx: 2 + i, my: 7 };
    const enemyId = (i === officerSlot) ? 2 : (palSerial++ * 2 - 1);
    const tr = twoNosferatuTrait(enemyId);
    enemies.push(twoPrepareEnemy({
      id: enemyId,
      x: Math.round(p.x * 1000) / 1000,
      y: Math.round(p.y * 1000) / 1000,
      enemy_level: level || 1,
      enemy_wave: 1,
      kind: tr.kind,
      flank_dir: ((i % 2) ? 1 : -1)
    }, rnd));
  }
  const isKinguStage = !!(campaign && (Number(campaign.stage || -1) === 5 || campaign.final));
  if (isKinguStage) {
    const ks = twoKinguStatsFromParty(room);
    const kp = twoFindOpen(map, rnd, target.x, target.y);
    const rawKingu = { id: 9002, x: Math.round(kp.x * 1000) / 1000, y: Math.round(kp.y * 1000) / 1000, elite: true, elite_type: "kingu", kingu: true, kingu_stats: ks, militia_delay: 0, enemy_level: level || 20, enemy_wave: 1 };
    enemies.push(twoApplyKinguBalance(twoPrepareEnemy(rawKingu, rnd), ks));
  }
  const flashliteWeather = (rnd() < 0.5) ? "NIGHT" : "EVENING";
  room.mission = {
    id: (campaign ? ("CAMPAIGN-" + campaign.stage + "-" + String(seed >>> 0)) : ("NEST-" + String(seed >>> 0))), seed, code,
    flashlite_weather: flashliteWeather,
    raid_code: raidCode,
    location: campaign ? campaign.location : "Unknown Exclusion Zone",
    campaign: campaign || { enabled: false },
    objective: campaign ? "Armorbound drop: sever the blood node, recover the fragment, and survive the nest." : "Dark-zone cleanup: eradicate Nosferatu activity.",
    mapW: w, mapH: h, map,
    target: {
      x: campaign ? Math.round(campaign.lon * 1000) / 1000 : Math.round((rnd() * 900 + 50) * 10) / 10,
      y: campaign ? Math.round(campaign.lat * 1000) / 1000 : Math.round((rnd() * 900 + 50) * 10) / 10,
      mx: target.mx, my: target.my
    },
    enemies,
    complete: false
  };
  twoSharedInfectedTree(room.mission);
  room.nesting = null;
  twoEnsureNesting(room);
  room.vehicle = { x: 2.5, y: 2.5, a: 0, hp: 100, max_hp: 100 };
  room.buffPickups = [];
  room.activeBuffs = [];
  room.started = false;
  return room.mission;
}
function twoHandle(ws, payloadStr) {
  let m = null;
  try { m = JSON.parse(String(payloadStr || "")); } catch { return; }
  if (!m || typeof m !== "object") return;
  const t = String(m.t || m.type || "").toLowerCase();
  if (t === "join") {
    const roomName = safeRoomId(m.room || "global", "global");
    let room = twoGetRoom(roomName);
    if (room.clients.size >= 2 && !room.clients.has(ws)) {
      twoSend(ws, { t: "error", message: "Room is full for [2]. One driver, one shooter." });
      return;
    }
    if (ws._twoRoomName && ws._twoRoomName !== roomName) twoDetach(ws);
    ws._twoRoomName = roomName;
    let id = twoSafeId(m.id, "H-" + rid());
    for (const meta of room.clients.values()) {
      if (meta.id === id && meta.ws !== ws) id = twoSafeId(id + "-" + rid().slice(0, 3), id);
    }
    let desired = String(m.name || id).replace(/\s+/g, " ").trim().slice(0, 20) || id;
    const enf = enforceReservedName(ws, desired, "", id, "two");
    desired = enf.name;
    const meta = room.clients.get(ws) || { ws, id, name: desired, sprite: 1, x: 250, y: 190, dir: "down", moving: false };
    meta.ws = ws; meta.id = id; meta.name = desired; meta.sprite = clamp(Number(m.sprite || meta.sprite || 1), 1, 4);
    if (m.dnd5e && typeof m.dnd5e === "object") {
      twoStoreDndPayload(meta, m.dnd5e, 1);
    }
    room.clients.set(ws, meta);
    ws._twoId = id;
    twoSend(ws, { t: "welcome", id, room: room.name, roles: room.roles, role: twoRoleForId(room, id), ip: ws._ip || "", ts: Date.now() });
    twoSyncLobby(room);
    if (room.mission) twoSend(ws, { t: "mission", mission: room.mission, ts: Date.now() });
    return;
  }
  if (!ws._twoRoomName) {
    twoHandle(ws, JSON.stringify({ t: "join", room: m.room || "global", id: m.id, name: m.name, sprite: m.sprite }));
  }
  const room = twoRooms.get(ws._twoRoomName);
  if (!room) return;
  const meta = room.clients.get(ws);
  if (!meta) return;
  if (t === "chat" || t === "msg") {
    const text = String(m.text || m.msg || "").replace(/\r?\n/g, " ").trim().slice(0, 220);
    if (!text) return;
    const name = String(m.name || meta.name || meta.id).slice(0, 24);
    twoBroadcast(room, { t: "chat", from: meta.id, name, text, ts: Date.now() });
    return;
  }
  if (t === "lobby_state") {
    meta.x = clamp(Number(m.x || meta.x || 250), 17, 423);
    meta.y = clamp(Number(m.y || meta.y || 190), 114, 390);
    meta.dir = String(m.dir || meta.dir || "down").slice(0, 8);
    meta.moving = !!m.moving;
    meta.sprite = clamp(Number(m.sprite || meta.sprite || 1), 1, 4);
    if (m.name != null) meta.name = String(m.name || meta.name || meta.id).replace(/\s+/g, " ").trim().slice(0, 20) || meta.id;
    if (m.dnd5e && typeof m.dnd5e === "object") {
      twoStoreDndPayload(meta, m.dnd5e, (meta.dnd5e && meta.dnd5e.level) || 1);
    }
    twoSyncLobby(room);
    return;
  }
  if (t === "role") {
    const role = String(m.role || "").toLowerCase();
    if (role !== "driver" && role !== "shooter") return;
    twoCleanRoles(room);
    const occupiedBy = room.roles[role];
    if (occupiedBy && occupiedBy !== meta.id) {
      const who = twoNameById(room, occupiedBy);
      twoSend(ws, { t: "error", message: `${role.toUpperCase()} seat is already occupied by ${who}.` });
      twoSend(ws, { t: "chat", from: "COMMAND", name: "COMMAND", text: `${role.toUpperCase()} is already occupied by ${who}.`, ts: Date.now() });
      twoSyncLobby(room);
      return;
    }
    if (room.roles.driver === meta.id) room.roles.driver = null;
    if (room.roles.shooter === meta.id) room.roles.shooter = null;
    room.roles[role] = meta.id;
    twoBroadcast(room, { t: "chat", from: "COMMAND", name: "COMMAND", text: `${meta.name} took ${role.toUpperCase()}.`, ts: Date.now() });
    twoSyncLobby(room);
    return;
  }
  if (t === "mission_request") {
    if (m.dnd5e && typeof m.dnd5e === "object") twoStoreDndPayload(meta, m.dnd5e, m.level || 1);
    const partyLevelForSpawn = twoSharedMissionLevel(room, Number(m.level || 1));
    const mission = (room.mission && twoMissionMatchesCampaign(room.mission, m.campaign)) ? room.mission : twoSpawnMission(room, m.campaign, partyLevelForSpawn);
    room.mission = mission;
    twoEnsureKinguForMission(room);
    twoBroadcast(room, { t: "mission", mission: room.mission, ts: Date.now() });
    return;
  }
  if (t === "launch") {
    const partyLevelForSpawn = twoSharedMissionLevel(room, Number(m.level || 1));
    const mission = (room.mission && twoMissionMatchesCampaign(room.mission, m.campaign)) ? room.mission : twoSpawnMission(room, m.campaign, partyLevelForSpawn);
    room.mission = mission;
    twoEnsureKinguForMission(room);
    if (m.dnd5e && typeof m.dnd5e === "object") {
      twoStoreDndPayload(meta, m.dnd5e, m.level || 1);
      twoEnsureKinguForMission(room);
    }
    twoAutoAssignRolesForLaunch(room, meta.id);
    const partyLevel = twoSharedMissionLevel(room, Number(m.level || 1));
    twoInitMissionWaves(mission, partyLevel);
    if (Array.isArray(mission.enemies)) mission.wave_start_count = mission.enemies.length;
    room.buffPickups = [];
    room.activeBuffs = [];
    const selectedGarage = twoSharedGarage(room);
    room.mainGarage = selectedGarage;
    room.mainGarageOwnerId = selectedGarage ? String(selectedGarage.owner_id || "") : null;
    const maxHull = twoSharedTankMaxHull(room, 100);
    const sharedAC = twoSharedTankACBuffed(room, 16);
    room.started = true;
    room.nesting = null;
    room.vehicle = { x: 2.5, y: 2.5, a: 0, hp: maxHull, max_hp: maxHull, ac: sharedAC, tank_ac: sharedAC, shared_tank_ac: true, shared_garage: selectedGarage, body_radius: TWO_TANK_RADIUS };
    twoEnsureNesting(room);
    if (selectedGarage) {
      twoBroadcast(room, { t: "chat", from: "GARAGE", name: "GARAGE", text: `Using ${selectedGarage.owner_name}'s tank tree (${selectedGarage.node_count || 0} nodes) as the main mission tree.`, ts: Date.now() });
    }
    for (const [ows, ometa] of room.clients.entries()) {
      twoSend(ows, { t: "start", mission, vehicle: room.vehicle, garage: selectedGarage, roles: room.roles, role: twoRoleForId(room, ometa.id), id: ometa.id, ts: Date.now() });
    }
    if (room.nesting && room.nesting.enabled) {
      twoBroadcast(room, { t: "nest_update", cells: [], map: room.mission.map, nesting: room.nesting, ts: Date.now() });
    }
    twoSendRoleSync(room);
    twoSyncLobby(room);
    return;
  }
  if (t === "drive") {
    if (room.roles.driver && room.roles.driver !== meta.id) return;
    const v = (m.v && typeof m.v === "object") ? m.v : {};
    const wantX = clamp(Number(v.x != null ? v.x : room.vehicle.x), 1.2, (room.mission ? room.mission.mapW - 1.2 : 31));
    const wantY = clamp(Number(v.y != null ? v.y : room.vehicle.y), 1.2, (room.mission ? room.mission.mapH - 1.2 : 21));
    const oldX = Number(room.vehicle.x || 2.5), oldY = Number(room.vehicle.y || 2.5);
    let finalX = oldX, finalY = oldY;
    if (twoVehicleCanStand(room, wantX, wantY, oldX, oldY)) { finalX = wantX; finalY = wantY; }
    else if (twoVehicleCanStand(room, wantX, oldY, oldX, oldY)) finalX = wantX;
    else if (twoVehicleCanStand(room, oldX, wantY, oldX, oldY)) finalY = wantY;
    twoPruneBuffs(room);
    const sharedAC = twoSharedTankACBuffed(room, room.vehicle.ac || 16);
    const maxHull = Number(room.vehicle.max_hp || twoSharedTankMaxHull(room, 100) || 100);
    room.vehicle = {
      x: finalX,
      y: finalY,
      a: clamp(Number(v.a != null ? v.a : room.vehicle.a), -999999, 999999),
      hp: clamp(Number(v.hp != null ? v.hp : room.vehicle.hp), 0, maxHull),
      max_hp: maxHull,
      ac: sharedAC,
      tank_ac: sharedAC,
      shared_tank_ac: true,
      shared_garage: room.mainGarage || room.vehicle.shared_garage || null,
      body_radius: TWO_TANK_RADIUS
    };
    twoCheckBuffPickup(room);
    twoBroadcast(room, { t: "vehicle", v: room.vehicle, by: meta.id, ts: Date.now() });
    return;
  }
  if (t === "buff_pickup") {
    const bid = Number(m.id || 0) | 0;
    const b = (room.buffPickups || []).find(x => Number(x.id || 0) === bid);
    if (b && Date.now() >= Number(b.pickup_after || 0)) {
      room.buffPickups = (room.buffPickups || []).filter(x => Number(x.id || 0) !== bid);
      twoApplyBuffPickup(room, b);
      twoBroadcast(room, { t: "buff_pickup", id: b.id, buff: b, vehicle: room.vehicle, active: room.activeBuffs, ts: Date.now() });
      twoBroadcast(room, { t: "vehicle", v: room.vehicle, ts: Date.now() });
    }
    return;
  }
  if (t === "shot") {
    if (room.roles.shooter && room.roles.shooter !== meta.id) return;
    if (!room.mission || !Array.isArray(room.mission.enemies)) return;
    const a = Number(m.a != null ? m.a : room.vehicle.a);
    const sx = room.vehicle.x, sy = room.vehicle.y;
    let bestIdx = -1, bestD = 999999;
    for (let i = 0; i < room.mission.enemies.length; i++) {
      const e = room.mission.enemies[i];
      const dx = e.x - sx, dy = e.y - sy;
      const d = Math.hypot(dx, dy);
      // Too-close enemies must not become unshootable if a stale packet overlaps the tank.
      if (d < 0.025 || d > 17) continue;
      let da = Math.atan2(dy, dx) - a;
      while (da <= -Math.PI) da += Math.PI * 2;
      while (da > Math.PI) da -= Math.PI * 2;
      if (Math.abs(da) < 0.12 && d < bestD && twoLineClear(room, sx, sy, e.x, e.y)) { bestIdx = i; bestD = d; }
    }
    twoBroadcast(room, { t: "shot", by: meta.id, a, ts: Date.now() });
    if (bestIdx >= 0) {
      const e = room.mission.enemies[bestIdx];
      const shotDnd = Object.assign({}, (m.dnd && typeof m.dnd === "object") ? m.dnd : {}, { buff_damage_d4: twoActiveBuffCount(room, 3) });
      const shotRoll = twoResolveShotDamage(shotDnd, e);
      twoCombatLog(room, twoShotRollText(shotRoll, e));
      if (!shotRoll.hit) {
        twoAlertEnemyUnderFire(e, sx, sy);
        twoBroadcast(room, { t: "enemy_update", enemies: [{ id: e.id, x: e.x, y: e.y, hp: e.hp, max_hp: e.max_hp, kind: e.kind, ac: e.ac, miss: true, brain: e.brain, tactic: e.tactic, shot_react_t: e.shotReactT, debug_thought: e.debug_thought }], ts: Date.now() });
        return;
      }
      e.hp = (e.hp | 0) - Math.max(1, shotRoll.damage | 0);
      twoAlertEnemyUnderFire(e, sx, sy);
      if (e.hp <= 0) {
        const dead = room.mission.enemies.splice(bestIdx, 1)[0];
        twoBroadcast(room, { t: "enemy_remove", id: dead.id, by: meta.id, ts: Date.now() });
        const elite = twoMaybeSpawnWaveElite(room, twoSharedMissionLevel(room, Number(m.level || (room.mission.waves && room.mission.waves.level_gate) || 1)));
        if (elite) {
          room.mission.enemies.push(elite);
          twoBroadcast(room, { t: "chat", from: "COMMAND", name: "COMMAND", text: "Gem-head elite rally signature entering the nest.", ts: Date.now() });
          twoBroadcast(room, { t: "enemies", enemies: room.mission.enemies, waves: room.mission.waves, ts: Date.now() });
        }
        if (room.mission.enemies.length === 0) {
          if (twoMissionHasNextWave(room.mission)) twoDropWaveBuff(room, dead);
          const nextWave = twoSpawnNextWave(room, twoSharedMissionLevel(room, Number(m.level || (room.mission.waves && room.mission.waves.level_gate) || 1)));
          if (nextWave.length) {
            const wv = room.mission.waves || {};
            twoBroadcast(room, { t: "chat", from: "COMMAND", name: "COMMAND", text: `Wave ${Number(wv.current || 1)}/${Number(wv.total || 1)} entering from elsewhere on the map.`, ts: Date.now() });
            twoBroadcast(room, { t: "enemies", enemies: room.mission.enemies, waves: room.mission.waves, ts: Date.now() });
            if (room.nesting && room.nesting.enabled) twoBroadcast(room, { t: "nest_update", cells: [], map: room.mission.map, nesting: room.nesting, ts: Date.now() });
            twoBroadcast(room, { t: "buff_state", pickups: room.buffPickups || [], active: room.activeBuffs || [], ts: Date.now() });
          } else {
            room.started = false;
            room.mission.complete = true;
            twoBroadcast(room, { t: "complete", mission: room.mission, by: meta.id, ts: Date.now() });
            room.mission = null;
            room.buffPickups = [];
            room.activeBuffs = [];
            room.nesting = null;
          }
        }
      } else {
        twoBroadcast(room, { t: "enemy_update", enemies: [{ id: e.id, x: e.x, y: e.y, hp: e.hp, max_hp: e.max_hp, kind: e.kind, ac: e.ac, xp: e.xp, archetype: e.archetype, attack_mode: e.attack_mode, lunge_t: e.lungeT, casting_t: e.castingT, elite: e.elite, elite_type: e.elite_type, acid_dot: e.acid_dot, brain: e.brain, tactic: e.tactic, ai_goal: e.aiGoal, ai_waypoint_x: e.aiWaypointX, ai_waypoint_y: e.aiWaypointY, nest_mode: e.nest_mode, nest_builder: e.nest_builder, nest_tx: e.nest_tx, nest_ty: e.nest_ty, hive_job: e.hive_job, hive_target: e.hive_target, debug_thought: e.debug_thought }], ts: Date.now() });
      }
    }
    return;
  }
  if (t === "ping") {
    twoSend(ws, { t: "pong", client_ts: m.client_ts || 0, ip: ws._ip || "", ts: Date.now() });
    return;
  }
}
function twoTickRoom(room, dt) {
  if (!room || !room.started || !room.mission || !Array.isArray(room.mission.enemies)) return;
  const v = room.vehicle || { x: 2.5, y: 2.5, hp: 100, max_hp: twoSharedTankMaxHull(room, 100) };
  v.max_hp = Number(v.max_hp || twoSharedTankMaxHull(room, 100) || 100);
  v.shared_garage = room.mainGarage || v.shared_garage || null;
  const dtSec = Math.max(0.001, Math.min(0.09, Number(dt || 80) / 1000));
  twoPruneBuffs(room);
  const regen = twoActiveBuffCount(room, 2);
  if (regen > 0) v.hp = clamp(Number(v.hp || v.max_hp || 100) + (Number(v.max_hp || 100) * 0.0015) * regen * dtSec, 0, Number(v.max_hp || 100));
  const acidDamage = twoUpdateAcidStacks(v, dtSec);
  twoApplyRally(room);
  v.ac = twoSharedTankACBuffed(room, v.ac || 16);
  v.tank_ac = v.ac;
  v.shared_tank_ac = true;
  const moved = [];
  let damaged = acidDamage > 0;
  const nestUpdate = twoUpdateNesting(room, dtSec);
  if (nestUpdate) twoBroadcast(room, { t: "nest_update", cells: nestUpdate.cells, map: nestUpdate.map, nesting: nestUpdate.nesting, ts: Date.now() });
  for (let idx = 0; idx < room.mission.enemies.length; idx++) {
    const e = twoPrepareEnemy(room.mission.enemies[idx]);
    twoEnsureEnemyMind(e, idx);
    e.aiDecideT = Math.max(0, Number(e.aiDecideT || 0) - dtSec);
    e.nestRepathT = Math.max(0, Number(e.nestRepathT || 0) - dtSec);
    e.aiPathReplanT = Math.max(0, Number(e.aiPathReplanT || 0) - dtSec);
    e.shotReactT = Math.max(0, Number(e.shotReactT || 0) - dtSec);
    const shotReact = Number(e.shotReactT || 0) > 0;
    const ex = Number(e.x || 0), ey = Number(e.y || 0);
    const px = Number(v.x || 2.5), py = Number(v.y || 2.5);
    const dx = px - ex, dy = py - ey;
    const dist = Math.hypot(dx, dy) || 0.001;
    const visible = twoLineClear(room, ex, ey, px, py);
    const isCaster = String(e.archetype || "") === "caster";
    const bodyRadius = Number(e.body_radius || TWO_ENEMY_RADIUS);
    const tankRadius = Number(v.body_radius || TWO_TANK_RADIUS);
    const contactStop = bodyRadius + tankRadius + 0.10;
    const meleeAttackRange = Math.max(Number(e.attack_range || 0.74), contactStop + 0.16);
    let didCast = false;
    const aggro = Number(v.aggro_range || 8.5);
    const closeVisible = !!(visible && dist <= (isCaster ? Math.max(2.10, Number(e.attack_range || 0.74) * 0.38) : Math.max(2.85, meleeAttackRange + 1.15)));
    const alreadyHurt = Number(e.hp || 1) < Number(e.max_hp || e.hp || 1);
    const nestMode = String(e.nest_mode || "");
    const nestHasTarget = (nestMode === "building" || nestMode === "built") && Number.isFinite(Number(e.nest_tx)) && Number.isFinite(Number(e.nest_ty));
    const nestInterruptRange = nestMode === "building" ? Math.max(1.55, meleeAttackRange + 0.55) : Math.max(4.2, meleeAttackRange + 2.2);
    const nestInterrupt = !!(nestHasTarget && ((visible && dist <= nestInterruptRange) || shotReact));
    const nestHardOrder = !!(nestHasTarget && !nestInterrupt);
    if (shotReact || ((!nestHardOrder) && visible && (dist <= aggro || closeVisible || alreadyHurt))) {
      // CHA / aggro only lowers the first trigger radius.  Close, wounded, or
      // already-engaged vampires keep hunting and never freeze in front of the tank.
      e.lastX = px;
      e.lastY = py;
      e.smellT = Math.max(Number(e.smellT || 0), 2.45);
      e.engagedT = Math.max(Number(e.engagedT || 0), isCaster ? 3.6 : 5.0);
    } else {
      e.smellT = Math.max(0, Number(e.smellT || 0) - dtSec);
      e.engagedT = Math.max(0, Number(e.engagedT || 0) - dtSec);
      e.alertT = Math.max(0, Number(e.alertT || 0) - dtSec * 0.24);
      const signal = twoAllyAlertSignal(e, room.mission.enemies);
      if (signal) {
        e.lastX = signal.x;
        e.lastY = signal.y;
        e.smellT = Math.max(Number(e.smellT || 0), Math.max(0.65, 2.10 - signal.d * 0.16));
        e.alertT = Math.max(Number(e.alertT || 0), Math.max(0.12, Math.min(1.15, 0.72 - signal.d * 0.055)));
      }
    }
    e.attackT = Math.max(0, Number(e.attackT || 0) - dtSec);
    e.lungeT = Math.max(0, Number(e.lungeT || 0) - dtSec);
    e.castingT = Math.max(0, Number(e.castingT || 0) - dtSec);
    e.castBlockedT = Math.max(0, Number(e.castBlockedT || 0) - dtSec);
    if (isCaster) {
      const maxSlots = Math.max(1, Number(e.spell_slots_max || 3) | 0);
      e.spell_slots_max = maxSlots;
      e.spell_slots = Math.max(0, Math.min(Number(e.spell_slots || 0) | 0, maxSlots));
      if (e.spell_slots < maxSlots) {
        e.spellRechargeT = Number(e.spellRechargeT || 0) + dtSec;
        const need = Math.max(0.75, Number(e.spellRechargeNeed || 2.75));
        if (e.spellRechargeT >= need) {
          e.spell_slots = Math.min(maxSlots, e.spell_slots + 1);
          e.spellRechargeT = 0;
        }
      }
    } else {
      e.spell_slots = 0;
      e.spellRechargeT = 0;
    }
    // Both enemy types are cooldown-driven. Brutes never require fake spell slots.
    const hasCharge = true;
    const effectiveAttackRange = isCaster ? Number(e.attack_range || 0.74) : meleeAttackRange;
    const castBlocker = (isCaster && visible && dist <= effectiveAttackRange) ? twoCastLineBlocker(e, room.mission.enemies, px, py) : null;
    if (castBlocker) { e.castBlockedT = Math.max(Number(e.castBlockedT || 0), 0.55); e.brain = "lich-reposition-cast-lane"; }
    if ((!nestHardOrder) && visible && dist <= effectiveAttackRange && hasCharge && (!isCaster || !castBlocker)) {
      if (e.attackT <= 0) {
        let atkResult = twoResolveEnemyDamage(e, v);
        twoCombatLog(room, atkResult.text);
        let dmg = Number(atkResult.damage || 0);
        if (e.elite && isCaster) {
          twoAddAcidStack(v);
          dmg = 0;
          damaged = true;
        }
        if (dmg > 0) {
          v.hp = clamp(Number(v.hp || v.max_hp || 100) - dmg, 0, Number(v.max_hp || 100));
          damaged = true;
        }
        e.attackT = Number(e.attack_cooldown || 0.45) * (0.82 + Math.random() * 0.34);
        if (isCaster) {
          e.castingT = 0.70;
          e.lungeT = 0;
          e.spell_slots = Math.max(1, Number(e.spell_slots_max || e.spell_slots || 1) | 0);
          e.spellRechargeT = 0;
          didCast = true;
        } else {
          e.lungeT = 0.16;
        }
      }
      moved.push({ id: e.id, x: e.x, y: e.y, hp: e.hp, max_hp: e.max_hp, kind: e.kind, ac: e.ac, xp: e.xp, archetype: e.archetype, attack_mode: e.attack_mode, moving: false, lunge_t: e.lungeT, casting_t: e.castingT, cast: didCast, spell_slots: e.spell_slots, spell_slots_max: e.spell_slots_max, elite: e.elite, elite_type: e.elite_type, acid_dot: e.acid_dot, brain: e.brain, tactic: e.tactic, ai_goal: e.aiGoal, ai_waypoint_x: e.aiWaypointX, ai_waypoint_y: e.aiWaypointY, nest_mode: e.nest_mode, nest_builder: e.nest_builder, nest_tx: e.nest_tx, nest_ty: e.nest_ty, hive_job: e.hive_job, hive_target: e.hive_target, debug_thought: e.debug_thought });
      if (!isCaster || dist >= Math.max(1.0, Number(e.prefer_range || 0) * 0.65)) continue;
    }
    let tx, ty;
    const aggroMove = Number(v.aggro_range || 8.5);
    const nestOrder = nestHardOrder;
    if (nestOrder) {
      tx = Number(e.nest_tx); ty = Number(e.nest_ty);
      e.brain = String(e.nest_mode || "") === "building" ? "nest-builder" : "nest-garrison-hold";
      if (Number(e.nestRepathT || 0) > 0 && Number.isFinite(Number(e.nestRepathX)) && Number.isFinite(Number(e.nestRepathY))) {
        const rx = Number(e.nestRepathX), ry = Number(e.nestRepathY);
        if (Math.hypot(rx - ex, ry - ey) > Math.max(0.34, Number(e.body_radius || TWO_ENEMY_RADIUS) * 0.95)) {
          tx = rx; ty = ry; e.brain = "nest-reroute"; e.tactic = "hive-repath";
        } else { e.nestRepathT = 0; }
      }
    }
    else if (shotReact || (visible && (dist <= aggroMove || closeVisible || Number(e.engagedT || 0) > 0))) {
      if (dist < contactStop) {
        const awayX = (ex - px) / dist, awayY = (ey - py) / dist;
        tx = ex + awayX * 1.20; ty = ey + awayY * 1.20;
      }
      else if (isCaster && Number(e.prefer_range || 0) > 0) {
        const prefer = Number(e.prefer_range || 0);
        if (Number(e.castBlockedT || 0) > 0 || castBlocker) {
          const lane = twoFindCastLanePoint(room, e, room.mission.enemies, px, py);
          if (lane) { tx = lane.x; ty = lane.y; e.brain = "lich-reposition-cast-lane"; }
          else {
            const side = Number(e.flank_dir || 1) < 0 ? -1 : 1;
            tx = ex + (-dy / dist) * side * 1.65;
            ty = ey + (dx / dist) * side * 1.65;
            e.brain = "lich-reposition-cast-lane";
          }
        }
        else if (dist < prefer * 0.70) { tx = ex - dx; ty = ey - dy; }
        else if (dist > Math.min(Number(e.attack_range || 0) * 0.88, prefer * 1.35)) { tx = px; ty = py; }
        else {
          const side = Number(e.flank_dir || 1) < 0 ? -1 : 1;
          tx = ex + (-dy / dist) * side * 0.95;
          ty = ey + (dx / dist) * side * 0.95;
        }
      } else {
        const plan = twoPaladinTacticalTarget(room, e, ex, ey, px, py, dist, visible, meleeAttackRange);
        tx = plan.x; ty = plan.y; e.brain = plan.brain; e.tactic = plan.tactic;
      }
    }
    else if (Number(e.smellT || 0) > 0 && Number.isFinite(e.lastX) && Number.isFinite(e.lastY)) { tx = e.lastX; ty = e.lastY; e.brain = "investigate"; }
    else {
      // No idle orbit/jiggle.  If the vampire has no line-of-sight, scent trail,
      // attack, or regroup objective, it holds position like a predator.
      e.brain = isCaster ? "lich-command-hold" : "paladin-sentry-hold";
      twoSnapIdleEnemy(e, ex, ey);
      moved.push({ id: e.id, x: e.x, y: e.y, hp: e.hp, max_hp: e.max_hp, kind: e.kind, ac: e.ac, xp: e.xp, archetype: e.archetype, attack_mode: e.attack_mode, moving: false, lunge_t: e.lungeT, casting_t: e.castingT, spell_slots: e.spell_slots, spell_slots_max: e.spell_slots_max, elite: e.elite, elite_type: e.elite_type, acid_dot: e.acid_dot, brain: e.brain, tactic: e.tactic, ai_goal: e.aiGoal, ai_waypoint_x: e.aiWaypointX, ai_waypoint_y: e.aiWaypointY, nest_mode: e.nest_mode, nest_builder: e.nest_builder, nest_tx: e.nest_tx, nest_ty: e.nest_ty, hive_job: e.hive_job, hive_target: e.hive_target, debug_thought: e.debug_thought });
      continue;
    }
    const awareMove = !!(shotReact || (visible && (dist <= aggroMove || closeVisible || Number(e.engagedT || 0) > 0)) || Number(e.smellT || 0) > 1.9 || Number(e.alertT || 0) > 0.55);
    const forceGoal = !!((nestOrder && String(e.nest_mode || "") === "building") || (awareMove && visible && dist <= Math.max(5.0, meleeAttackRange + 1.15)) || (e.elite && visible));
    const committed = twoCommitEnemyGoal(e, tx, ty, e.brain || "move", e.tactic || "move", forceGoal);
    if (!committed) {
      twoSnapIdleEnemy(e, ex, ey);
      moved.push({ id: e.id, x: e.x, y: e.y, hp: e.hp, max_hp: e.max_hp, kind: e.kind, ac: e.ac, xp: e.xp, archetype: e.archetype, attack_mode: e.attack_mode, moving: false, lunge_t: e.lungeT, casting_t: e.castingT, spell_slots: e.spell_slots, spell_slots_max: e.spell_slots_max, elite: e.elite, elite_type: e.elite_type, acid_dot: e.acid_dot, brain: e.brain, tactic: e.tactic, ai_goal: e.aiGoal, ai_waypoint_x: e.aiWaypointX, ai_waypoint_y: e.aiWaypointY, nest_mode: e.nest_mode, nest_builder: e.nest_builder, nest_tx: e.nest_tx, nest_ty: e.nest_ty, hive_job: e.hive_job, hive_target: e.hive_target, debug_thought: e.debug_thought });
      continue;
    }
    tx = committed.x; ty = committed.y;
    const targetDist = Math.hypot(tx - ex, ty - ey);
    if (targetDist <= twoArriveRadius(e, nestOrder, awareMove)) {
      twoSnapIdleEnemy(e, ex, ey);
      e.aiPathCells = [];
      moved.push({ id: e.id, x: e.x, y: e.y, hp: e.hp, max_hp: e.max_hp, kind: e.kind, ac: e.ac, xp: e.xp, archetype: e.archetype, attack_mode: e.attack_mode, moving: false, lunge_t: e.lungeT, casting_t: e.castingT, spell_slots: e.spell_slots, spell_slots_max: e.spell_slots_max, elite: e.elite, elite_type: e.elite_type, acid_dot: e.acid_dot, brain: e.brain, tactic: e.tactic, ai_goal: e.aiGoal, ai_waypoint_x: e.aiWaypointX, ai_waypoint_y: e.aiWaypointY, nest_mode: e.nest_mode, nest_builder: e.nest_builder, nest_tx: e.nest_tx, nest_ty: e.nest_ty, hive_job: e.hive_job, hive_target: e.hive_target, debug_thought: e.debug_thought });
      continue;
    }
    const pathForce = !!((nestOrder && (String(e.nest_mode || "") === "building" || String(e.nest_mode || "") === "built")) || (!visible && awareMove) || Number(e.stuckT || 0) > 0.12);
    const wp = twoHiveWaypointForGoal(room, e, ex, ey, tx, ty, v, pathForce);
    const moveTx = Number(wp.x), moveTy = Number(wp.y);
    let vx = moveTx - ex, vy = moveTy - ey;
    let mag = Math.hypot(vx, vy) || 1;
    vx /= mag; vy /= mag;
    let sepX = 0, sepY = 0;
    if (targetDist > Math.max(0.42, Number(e.body_radius || TWO_ENEMY_RADIUS) * 1.15)) {
      for (let j = 0; j < room.mission.enemies.length; j++) {
        if (j === idx) continue;
        const o = room.mission.enemies[j];
        if (!o || Number(o.hp || 1) <= 0 || twoSameNestDoorway(e, o) || twoSameActiveNestSpace(e, o)) continue;
        const ox = ex - Number(o.x || ex), oy = ey - Number(o.y || ey);
        const od = Math.hypot(ox, oy);
        if (od > 0.001 && od < TWO_ENEMY_ENEMY_STANDOFF) { sepX += ox / od * (TWO_ENEMY_ENEMY_STANDOFF - od); sepY += oy / od * (TWO_ENEMY_ENEMY_STANDOFF - od); }
      }
    }
    const fd = Number(e.flank_dir || 1) < 0 ? -1 : 1;
    const wounded = (Number(e.hp || 1) <= Math.max(1, (Number(e.max_hp || 3) | 0) >> 1));
    let flank = Number(e.flank_bias || 0.5) * (visible ? 1.0 : 1.45) * (wounded && !isCaster ? 1.08 : 1.0);
    // First-person view fix: visible melee enemies should advance straight at the tank,
    // not diagonally strafe while the minimap path reads as direct.
    if (nestOrder) flank = 0;
    else if (!isCaster && visible && (dist <= Number(v.aggro_range || 8.5) || closeVisible || Number(e.engagedT || 0) > 0)) flank = 0;
    if (isCaster) flank *= 0.90;
    const lx = -vy * fd * flank, ly = vx * fd * flank;
    let mx = vx + lx + sepX * 1.7, my = vy + ly + sepY * 1.7;
    mag = Math.hypot(mx, my) || 1;
    mx /= mag; my /= mag;
    let speed = Number(e.speed || 1.0);
    if (!isCaster && visible && dist < 5.0) speed *= 1.16;
    if (isCaster) speed *= 0.92;
    if (!isCaster && wounded) speed *= 1.08;
    if (Number(e.lungeT || 0) > 0) speed = Math.max(speed, Number(e.lunge_speed || speed));
    if (Number(e.avoidT || 0) > 0) e.avoidT = Math.max(0, Number(e.avoidT || 0) - dtSec);
    else e.avoidBias = 0;
    const step = speed * dtSec;
    let ok = twoSteeredMove(room, e, ex, ey, mx, my, step, moveTx, moveTy, room.mission.enemies, v);
    if (ok && Math.hypot(Number(e.x || ex) - ex, Number(e.y || ey) - ey) < 0.024) { e.x = Math.round(ex * 1000) / 1000; e.y = Math.round(ey * 1000) / 1000; ok = false; }
    if (!ok) {
      if (!isCaster && visible && dist > meleeAttackRange + 0.18 && Number(e.stuckT || 0) <= 0.10) {
        const dxp = (px - ex) / (dist || 1), dyp = (py - ey) / (dist || 1);
        if (twoMoveEnemy(room, e, ex + dxp * step, ey + dyp * step, [], v)) {
          e.stuckT = 0;
          moved.push({ id: e.id, x: e.x, y: e.y, hp: e.hp, max_hp: e.max_hp, kind: e.kind, ac: e.ac, xp: e.xp, archetype: e.archetype, attack_mode: e.attack_mode, moving: true, lunge_t: e.lungeT, casting_t: e.castingT, spell_slots: e.spell_slots, spell_slots_max: e.spell_slots_max, elite: e.elite, elite_type: e.elite_type, acid_dot: e.acid_dot, brain: e.brain, tactic: e.tactic, ai_goal: e.aiGoal, ai_waypoint_x: e.aiWaypointX, ai_waypoint_y: e.aiWaypointY, nest_mode: e.nest_mode, nest_builder: e.nest_builder, nest_tx: e.nest_tx, nest_ty: e.nest_ty, hive_job: e.hive_job, hive_target: e.hive_target, debug_thought: e.debug_thought });
          continue;
        }
      }
      e.stuckT = Number(e.stuckT || 0) + dtSec;
      if (e.stuckT > 0.14 && twoEmergencyUnstickStep(room, e, ex, ey, tx, ty, step, room.mission.enemies, v)) {
        e.stuckT = 0;
        e.brain = "wall-unstick";
        e.tactic = "clear-wall";
        moved.push({ id: e.id, x: e.x, y: e.y, hp: e.hp, max_hp: e.max_hp, kind: e.kind, ac: e.ac, xp: e.xp, archetype: e.archetype, attack_mode: e.attack_mode, moving: true, lunge_t: e.lungeT, casting_t: e.castingT, spell_slots: e.spell_slots, spell_slots_max: e.spell_slots_max, elite: e.elite, elite_type: e.elite_type, acid_dot: e.acid_dot, brain: e.brain, tactic: e.tactic, ai_goal: e.aiGoal, ai_waypoint_x: e.aiWaypointX, ai_waypoint_y: e.aiWaypointY, nest_mode: e.nest_mode, nest_builder: e.nest_builder, nest_tx: e.nest_tx, nest_ty: e.nest_ty, hive_job: e.hive_job, hive_target: e.hive_target, debug_thought: e.debug_thought });
        continue;
      }
      if (!awareMove && !nestOrder) twoSnapIdleEnemy(e, ex, ey);
      if (!isCaster && visible && dist <= meleeAttackRange + 0.18 && e.attackT <= 0) {
        const atkResult = twoResolveEnemyDamage(e, v);
        twoCombatLog(room, atkResult.text);
        const dmg = Number(atkResult.damage || 0);
        if (dmg > 0) { v.hp = clamp(Number(v.hp || v.max_hp || 100) - dmg, 0, Number(v.max_hp || 100)); damaged = true; }
        e.attackT = Number(e.attack_cooldown || 0.45) * (0.82 + Math.random() * 0.34);
        e.lungeT = 0.16;
      }
      moved.push({ id: e.id, x: e.x, y: e.y, hp: e.hp, max_hp: e.max_hp, kind: e.kind, ac: e.ac, xp: e.xp, archetype: e.archetype, attack_mode: e.attack_mode, moving: false, lunge_t: e.lungeT, casting_t: e.castingT, spell_slots: e.spell_slots, spell_slots_max: e.spell_slots_max, elite: e.elite, elite_type: e.elite_type, acid_dot: e.acid_dot, brain: e.brain, tactic: e.tactic, ai_goal: e.aiGoal, ai_waypoint_x: e.aiWaypointX, ai_waypoint_y: e.aiWaypointY, nest_mode: e.nest_mode, nest_builder: e.nest_builder, nest_tx: e.nest_tx, nest_ty: e.nest_ty, hive_job: e.hive_job, hive_target: e.hive_target, debug_thought: e.debug_thought });
      if (!nestOrder && e.stuckT > 0.18) {
        const alt = twoNestRepathGoal(room, e, ex, ey, tx, ty);
        if (alt) {
          e.aiGoal = "combat-reroute"; e.aiGoalX = alt.x; e.aiGoalY = alt.y;
          e.aiDecideT = Math.max(Number(e.aiDecideT || 0), 0.42);
          e.aiPathCells = [];
          e.brain = "hive-combat-reroute"; e.tactic = "repath";
          e.avoidBias = Number(e.avoidBias || 0) > 0 ? -1 : 1; e.avoidT = 0.45;
        } else {
          e.flank_dir = -fd;
        }
        e.stuckT = 0;
      }
      else if (nestOrder && e.stuckT > 0.30) {
        const alt = twoNestRepathGoal(room, e, ex, ey, tx, ty);
        if (alt) {
          e.nestRepathX = alt.x; e.nestRepathY = alt.y; e.nestRepathT = 0.95;
          e.aiGoal = "nest-reroute"; e.aiGoalX = alt.x; e.aiGoalY = alt.y;
          e.aiDecideT = Math.max(Number(e.aiDecideT || 0), 0.38);
          e.avoidBias = Number(e.avoidBias || 0) > 0 ? -1 : 1; e.avoidT = 0.55;
        } else {
          e.flank_dir = -fd; e.avoidBias = Number(e.avoidBias || 0) > 0 ? -1 : 1; e.avoidT = 0.65;
        }
        e.stuckT = 0;
      }
    } else {
      e.stuckT = 0;
      moved.push({ id: e.id, x: e.x, y: e.y, hp: e.hp, max_hp: e.max_hp, kind: e.kind, ac: e.ac, xp: e.xp, archetype: e.archetype, attack_mode: e.attack_mode, moving: true, lunge_t: e.lungeT, casting_t: e.castingT, spell_slots: e.spell_slots, spell_slots_max: e.spell_slots_max, elite: e.elite, elite_type: e.elite_type, acid_dot: e.acid_dot, brain: e.brain, tactic: e.tactic, ai_goal: e.aiGoal, ai_waypoint_x: e.aiWaypointX, ai_waypoint_y: e.aiWaypointY, nest_mode: e.nest_mode, nest_builder: e.nest_builder, nest_tx: e.nest_tx, nest_ty: e.nest_ty, hive_job: e.hive_job, hive_target: e.hive_target, debug_thought: e.debug_thought });
    }
  }
  if (moved.length) twoBroadcast(room, { t: "enemy_update", enemies: moved, ts: Date.now() });
  if (damaged) twoBroadcast(room, { t: "vehicle", v, ts: Date.now() });
  if (v.hp <= 0) {
    room.started = false;
    v.hp = 0;
    const failedMission = room.mission;
    twoBroadcast(room, { t: "chat", from: "COMMAND", name: "COMMAND", text: "Hull at 0%. Mission failed. Emergency recall ordered.", ts: Date.now() });
    twoBroadcast(room, { t: "vehicle", v, ts: Date.now() });
    twoBroadcast(room, { t: "fail", reason: "HULL_ZERO", mission: failedMission, vehicle: v, ts: Date.now() });
    room.mission = null;
    room.buffPickups = [];
    room.activeBuffs = [];
    room.nesting = null;
    room.vehicle = { x: 2.5, y: 2.5, a: 0, hp: 100, max_hp: 100, ac: v.ac || 16, tank_ac: v.tank_ac || v.ac || 16, shared_tank_ac: true, body_radius: TWO_TANK_RADIUS };
    room.mainGarage = null;
    room.mainGarageOwnerId = null;
    twoSyncLobby(room);
  }
}
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
function umbralDetach(ws, announce = true) {
  if (!ws || !ws._umbralId) return;
  const id = String(ws._umbralId || "");
  const roomName = umbralRoomName(ws._umbralRoomName || UMBRAL_DEFAULT_ROOM);
  const room = umbralRooms.get(roomName);
  if (room && room.clients) {
    const c = room.clients.get(id);
    if (c && c.ws === ws) room.clients.delete(id);
    if (announce && id) umbralBroadcast(room, { type: "peer_left", id, room: room.name, ts: Date.now() }, ws);
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
  const existing = room.clients.get(id) || { id, room: room.name, ws };
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
    umbralSendPeerList(ws, got.room, got.client.id);
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
// ----------------------------------
// Shared WebSocket connection router
// ----------------------------------
function detachAllProtocols(ws) {
  try { umbralDetach(ws, true); } catch {}
  try { twoDetach(ws); } catch {}
  try { growthDetach(ws); } catch {}
  try { stugDetach(ws, true); } catch {}
  try { prisonDetach(ws, true); } catch {}
}
function routeSocketMessage(ws, data) {
  let raw = "";
  try {
    raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data || "");
  } catch {
    raw = "";
  }
  if (!raw) return;
  if (raw.startsWith("ur:")) { umbralHandle(ws, raw.slice(3), true); return; }
  if (raw.startsWith("2:")) { twoHandle(ws, raw.slice(2)); return; }
  if (raw.startsWith("gf:")) { growthHandle(ws, raw.slice(3)); return; }
  if (raw.startsWith("s:")) { stugHandle(ws, raw.slice(2)); return; }
  if (raw.startsWith("p:")) { prisonHandle(ws, raw.slice(2)); return; }
  // Legacy/no-prefix fallback.
  let m = null;
  try { m = JSON.parse(raw); } catch { m = null; }
  if (m && typeof m === "object") {
    const game = String(m.game || m.proto || m.protocol || m.g || "").toLowerCase();
    if (game === "umbral" || game === "umbral_rail" || game === "house_nocturne" || game === "vespera" || game === "ur") { umbralHandle(ws, raw, false); return; }
    if (game === "two" || game === "2" || game === "hunters") { twoHandle(ws, raw); return; }
    if (game === "growth" || game === "gf") { growthHandle(ws, raw); return; }
    if (game === "stug" || game === "s") { stugHandle(ws, raw); return; }
    if (game === "prison" || game === "ethane" || game === "p") { prisonHandle(ws, raw); return; }
    const t = String(m.t || m.type || "").toLowerCase();
    if (t === "presence" || t === "peer" || t === "visit" || t === "visit_position" || t === "rail_chat" || t === "visitor_chat" || t === "leave" || t === "request_peers" || t === "sync") {
      umbralHandle(ws, raw, false);
      return;
    }
    if (t === "join" || t === "lobby_state" || t === "role" || t === "mission_request" || t === "launch" || t === "drive" || t === "shot" || t === "ping") {
      twoHandle(ws, raw);
      return;
    }
  }
  // Plain text fallback.
  prisonHandle(ws, raw);
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
// ------------------------
// ARMORBOUND enemy AI tick
// ------------------------
const TWO_TICK_MS = 80;
setInterval(() => {
  try {
    for (const room of twoRooms.values()) twoTickRoom(room, TWO_TICK_MS);
  } catch {}
}, TWO_TICK_MS);
// -------------------------
// STUG shared theater pulse
// -------------------------
const STUG_TICK_MS = 250;
setInterval(() => {
  for (const room of stugRooms.values()) {
    if (!room) continue;
    stugTickRoom(room, STUG_TICK_MS);
  }
}, STUG_TICK_MS);
// --------------------------------------------------------------
server.listen(PORT, HOST, () => {
  console.log("Merged relay (Dedset App) on", HOST + ":" + PORT);
  if (MEGA_CLAIM_REQUIRE_AUTH && !MEGA_CLAIM_SECRET) console.warn("MEGA claim endpoint is locked until MEGA_CLAIM_SECRET is configured.");
});
