// server.js - supports Eldritch Cyber Front,
// Ethane Sea, Azha, STUG, GROWTH & [2]
// One process, one port, isolated rooms by game.
// by Dedset Media 02/24/2026
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const WebSocket = require("ws");
const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
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
// --------------------------------------
// Room registry: key = `${game}:${room}`
// game is "ECF" or "AZHA"
// --------------------------------------
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
  const key = roomKey(game, roomName);
  if (!rooms.has(key)) {
    if (game === "ECF") {
      rooms.set(key, {
        game: "ECF",
        name: roomName,
        clients: new Map(),     // id -> ws
        ready: new Map(),       // id -> bool
        seed: null,
        difficulty: 1,
        missionActive: false
      });
    } else {
      rooms.set(key, {
        game: "AZHA",
        name: roomName,
        clients: new Map(),     // ws -> meta
        started: false,
        seed: 0,
        mapW: 80,
        mapH: 45,
        mapGrid: null,
        mission: { step: 0, phase: "rally", target: { x: 2.5, y: 2.5 }, entities: [], nextId: 1 }
      });
    }
  }
  return rooms.get(key);
}
function deleteRoomIfEmpty(room) {
  if (!room) return;
  if (room.game === "ECF") {
    if (room.clients.size === 0) rooms.delete(roomKey("ECF", room.name));
  } else {
    if (room.clients.size === 0) rooms.delete(roomKey("AZHA", room.name));
  }
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
// -------------
// AZHA protocol
// -------------
function azhaBroadcast(room, msgObj) {
  const data = JSON.stringify(msgObj);
  for (const ws of room.clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch {}
    }
  }
}
function azhaLobbyState(room) {
  const users = [];
  for (const meta of room.clients.values()) {
    users.push({ id: meta.id, name: meta.name, ready: meta.ready });
  }
  return users;
}
function azhaSyncLobby(room, roomId) {
  azhaBroadcast(room, { type: "lobby", room: roomId, users: azhaLobbyState(room), started: room.started });
}
function rndInt(min, max) {
  min = Math.floor(min);
  max = Math.floor(max);
  return min + Math.floor(Math.random() * (max - min + 1));
}
function mulberry32(seed) {
  let t = (seed >>> 0);
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function genDuneMap(w, h, seed) {
  w = Math.max(24, Math.floor(w));
  h = Math.max(18, Math.floor(h));
  const rnd = mulberry32((seed >>> 0) || 1);
  const g = new Array(h);
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) {
      const border = (x === 0 || y === 0 || x === w - 1 || y === h - 1);
      row += border ? "1" : "0";
    }
    g[y] = row;
  }
  const duneCount = Math.max(6, Math.floor((w * h) / 700));
  const bumps = Math.max(8, Math.floor((w * h) / 500));
  function stampEllipse(cx, cy, rx, ry) {
    const x0 = Math.max(1, Math.floor(cx - rx));
    const x1 = Math.min(w - 2, Math.ceil(cx + rx));
    const y0 = Math.max(1, Math.floor(cy - ry));
    const y1 = Math.min(h - 2, Math.ceil(cy + ry));
    for (let yy = y0; yy <= y1; yy++) {
      let row = g[yy].split("");
      for (let xx = x0; xx <= x1; xx++) {
        const nx = (xx - cx) / rx, ny = (yy - cy) / ry;
        if (nx * nx + ny * ny <= 1) row[xx] = "1";
      }
      g[yy] = row.join("");
    }
  }
  for (let i = 0; i < duneCount; i++) {
    const cx = 2 + Math.floor(rnd() * (w - 4));
    const cy = 2 + Math.floor(rnd() * (h - 4));
    const rx = 3 + Math.floor(rnd() * 8);
    const ry = 2 + Math.floor(rnd() * 6);
    stampEllipse(cx + 0.5, cy + 0.5, rx, ry);
  }
  for (let i = 0; i < bumps; i++) {
    const cx = 2 + Math.floor(rnd() * (w - 4));
    const cy = 2 + Math.floor(rnd() * (h - 4));
    const rx = 1 + Math.floor(rnd() * 3);
    const ry = 1 + Math.floor(rnd() * 3);
    stampEllipse(cx + 0.5, cy + 0.5, rx, ry);
  }
  function carve(cx, cy, r) {
    for (let yy = Math.max(1, cy - r); yy <= Math.min(h - 2, cy + r); yy++) {
      let row = g[yy].split("");
      for (let xx = Math.max(1, cx - r); xx <= Math.min(w - 2, cx + r); xx++) {
        row[xx] = "0";
      }
      g[yy] = row.join("");
    }
  }
  carve(4, 4, 4);
  carve(w - 5, h - 5, 4);
  return g;
}
function azhaIsWall(room, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= room.mapW || yi >= room.mapH) return true;
  const row = room.mapGrid && room.mapGrid[yi];
  return row ? row[xi] === "1" : true;
}
function azhaFindNearestEmpty(room, x, y) {
  if (!azhaIsWall(room, x, y)) return { x, y };
  const bx = Math.floor(x) + 0.5, by = Math.floor(y) + 0.5;
  for (let r = 1; r < Math.max(room.mapW, room.mapH); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const nx = bx + dx, ny = by + dy;
        if (nx < 1 || ny < 1 || nx >= room.mapW - 1 || ny >= room.mapH - 1) continue;
        if (!azhaIsWall(room, nx, ny)) return { x: nx, y: ny };
      }
    }
  }
  for (let yy = 1; yy < room.mapH - 1; yy++) {
    for (let xx = 1; xx < room.mapW - 1; xx++) {
      if (!azhaIsWall(room, xx + 0.5, yy + 0.5)) return { x: xx + 0.5, y: yy + 0.5 };
    }
  }
  return { x: 2.5, y: 2.5 };
}
function azhaJimboSay(room, text) {
  azhaBroadcast(room, { type: "chat", from: "JIMBO", name: "Jimbo", text: "@@JIMBO@@" + String(text || ""), ts: Date.now() });
}
function azhaPushMission(room) {
  azhaBroadcast(room, {
    type: "mission",
    phase: room.mission.phase,
    step: room.mission.step,
    target: room.mission.target,
    entities: room.mission.entities
  });
}
function azhaPickRallyTarget(room) {
  const w = room.mapW, h = room.mapH;
  const raw = {
    x: rndInt(2, Math.max(2, w - 3)) + 0.5,
    y: rndInt(2, Math.max(2, h - 3)) + 0.5
  };
  return azhaFindNearestEmpty(room, raw.x, raw.y);
}
function azhaSpawnLocalEntities(room, type, center, count) {
  const w = room.mapW, h = room.mapH;
  const out = [];
  const radius = 6.5;
  for (let i = 0; i < count; i++) {
    let x = center.x, y = center.y;
    for (let t = 0; t < 12; t++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * radius;
      x = clamp(center.x + Math.cos(a) * r, 1.5, w - 2.5);
      y = clamp(center.y + Math.sin(a) * r, 1.5, h - 2.5);
      if (!azhaIsWall(room, x, y)) break;
    }
    const snapped = azhaFindNearestEmpty(room, x, y);
    const ent = {
      id: room.mission.nextId++,
      type,
      x: Math.round(snapped.x * 1000) / 1000,
      y: Math.round(snapped.y * 1000) / 1000
    };
    if (type === "enemy") ent.hp = 2;
    out.push(ent);
  }
  return out;
}
function azhaStartMission(room) {
  room.mission.step = 0;
  room.mission.phase = "rally";
  room.mission.entities = [];
  room.mission.nextId = 1;
  const tgt = azhaPickRallyTarget(room);
  room.mission.target = { x: Math.round(tgt.x * 1000) / 1000, y: Math.round(tgt.y * 1000) / 1000 };
  azhaJimboSay(room, `AZHA / MIL-AI ONLINE. Tankers, rally at the marked nav blip. (X:${room.mission.target.x.toFixed(1)} Y:${room.mission.target.y.toFixed(1)})`);
  azhaPushMission(room);
}
function azhaEnsureMission(room) {
  if (!room.started) return;
  if (!room.mission || !room.mission.target || !Number.isFinite(room.mission.target.x) || !Number.isFinite(room.mission.target.y)) {
    room.mission = { step: 0, phase: "rally", target: { x: 2.5, y: 2.5 }, entities: [], nextId: 1 };
  }
  if (!room.mapGrid) {
    room.mapGrid = genDuneMap(room.mapW || 80, room.mapH || 45, room.seed || 1);
  }
  if (room.mission.target.x === 0 && room.mission.target.y === 0) {
    azhaStartMission(room);
    return;
  }
  const sn = azhaFindNearestEmpty(room, room.mission.target.x, room.mission.target.y);
  room.mission.target = { x: Math.round(sn.x * 1000) / 1000, y: Math.round(sn.y * 1000) / 1000 };
  azhaPushMission(room);
}
function azhaWithin(a, b, r) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return (dx * dx + dy * dy) <= (r * r);
}
function azhaMaybeAdvanceMission(room) {
  if (!room.started) return;
  const metas = [...room.clients.values()];
  if (metas.length !== 2) return;
  if (!metas.every(m => m && m.state && Number.isFinite(m.state.x) && Number.isFinite(m.state.y))) return;
  const p0 = { x: metas[0].state.x, y: metas[0].state.y };
  const p1 = { x: metas[1].state.x, y: metas[1].state.y };
  const tgt = room.mission.target;
  if (room.mission.phase === "rally") {
    if (azhaWithin(p0, tgt, 1.25) && azhaWithin(p1, tgt, 1.25)) {
      room.mission.step++;
      const pick = Math.random() < 0.5 ? "destroy" : "retrieve";
      room.mission.phase = pick;
      room.mission.entities = [];
      room.mission.nextId = Math.max(room.mission.nextId || 1, 1);
      if (pick === "destroy") {
        const count = rndInt(2, 7);
        room.mission.entities = azhaSpawnLocalEntities(room, "enemy", tgt, count);
        azhaJimboSay(room, `CONTACT. Hostile old-tech drones detected. Destroy all targets in the local grid. (${count} total)`);
      } else {
        const count = rndInt(1, 6);
        room.mission.entities = azhaSpawnLocalEntities(room, "datnode", tgt, count);
        azhaJimboSay(room, `DATA SIGNATURES FOUND. Retrieve all datnodes in the local grid. (${count} total)`);
      }
      azhaPushMission(room);
    }
    return;
  }
  if (room.mission.phase === "destroy" || room.mission.phase === "retrieve") {
    if (room.mission.entities.length === 0) {
      azhaJimboSay(room, room.mission.phase === "destroy" ? `AREA SECURED. Stand by for next nav task.` : `DATA RECOVERED. Stand by for next nav task.`);
      room.mission.step++;
      room.mission.phase = "rally";
      room.mission.entities = [];
      room.mission.nextId = 1;
      const nt = azhaPickRallyTarget(room);
      room.mission.target = { x: Math.round(nt.x * 1000) / 1000, y: Math.round(nt.y * 1000) / 1000 };
      azhaJimboSay(room, `New nav blip uploaded. Rally at (X:${room.mission.target.x.toFixed(1)} Y:${room.mission.target.y.toFixed(1)}).`);
      azhaPushMission(room);
    }
  }
}
function azhaMaybeStart(room, roomId) {
  if (room.started) return;
  const metas = [...room.clients.values()];
  if (metas.length !== 2) return;
  if (!metas.every(m => m.ready)) return;
  room.started = true;
  room.seed = nowSeed();
  room.mapW = 80;
  room.mapH = 45;
  room.mapGrid = genDuneMap(room.mapW, room.mapH, room.seed);
  azhaBroadcast(room, { type: "start", room: roomId, seed: room.seed, mapW: room.mapW, mapH: room.mapH });
  azhaStartMission(room);
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

// ---------------------------------------------------------------------------------------------------------
// [2] Hunters protocol (2:...)
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
// ---------------------------------------------------------------------------------------------------------
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
      vehicle: { x: 2.5, y: 2.5, a: 0, hp: 100 },
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
      role
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
  function isBlockedNeighbor(x, y) {
    return cells[y][x + 1] === "1" || cells[y][x - 1] === "1" || cells[y + 1][x] === "1" || cells[y - 1][x] === "1";
  }
  for (let i = 0; i < 42; i++) {
    const x = 2 + Math.floor(rnd() * (w - 4));
    const y = 2 + Math.floor(rnd() * (h - 4));
    if (x <= 6 && y <= 6) continue;
    if (isBlockedNeighbor(x, y)) continue;
    cells[y][x] = "1";
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
function twoNosferatuTrait(eid) {
  const odd = ((Math.max(1, Number(eid || 1) | 0) % 2) === 1);
  if (odd) {
    return {
      archetype: "brute", kind: "rage-brute", role: "tanky fearless monstrous rage machine",
      stats: { STR: 18, DEX: 11, CON: 18, INT: 6, WIS: 11, CHA: 8 },
      ac: 14, hp: 34, speed: 1.04, lunge: 2.08,
      attack_bonus: 6, damage_dice: [2, 8], damage_bonus: 4,
      attack: 13, range: 0.62, prefer_range: 0, cooldown: 0.64, flank: 0.38,
      xp: 200, save_dc: 0, attack_mode: "melee"
    };
  }
  return {
    archetype: "caster", kind: "eldritch-caster", role: "intelligent wary ranged Nosferatu",
    stats: { STR: 9, DEX: 16, CON: 12, INT: 17, WIS: 15, CHA: 14 },
    ac: 13, hp: 24, speed: 1.12, lunge: 1.40,
    attack_bonus: 6, damage_dice: [2, 6], damage_bonus: 3,
    attack: 10, range: 5.80, prefer_range: 3.65, cooldown: 1.08, flank: 0.88,
    xp: 250, save_dc: 13, attack_mode: "wis_save"
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
  const d20 = 1 + Math.floor(Math.random() * 20);
  const ac = Number(enemy.ac || 12);
  const hit = d20 !== 1 && (d20 === 20 || d20 + atk >= ac);
  const crit = hit && d20 === 20;
  const damage = hit ? Math.max(1, twoRollDice(dc * (crit ? 2 : 1), ds) + bonus) : 0;
  return { d20, attack_bonus: atk, ac, hit, crit, damage };
}
function twoResolveEnemyDamage(e, v) {
  const mode = String(e.attack_mode || "melee");
  if (mode === "wis_save") {
    const dc = Number(e.save_dc || 13);
    const bonus = Number(v.wis_save || 0);
    const d20 = 1 + Math.floor(Math.random() * 20);
    const saved = d20 !== 1 && (d20 === 20 || d20 + bonus >= dc);
    const dice = Array.isArray(e.damage_dice) ? e.damage_dice : [2, 6];
    const raw = twoRollDice(dice[0], dice[1]) + Number(e.damage_bonus || 0);
    return Math.max(1, saved ? Math.floor(raw / 2) : raw);
  }
  const ac = Number(v.ac || 16);
  const d20 = 1 + Math.floor(Math.random() * 20);
  const atk = Number(e.attack_bonus || 4);
  const hit = d20 !== 1 && (d20 === 20 || d20 + atk >= ac);
  if (!hit) return 0;
  const dice = Array.isArray(e.damage_dice) ? e.damage_dice : [2, 6];
  return Math.max(1, twoRollDice(dice[0] * (d20 === 20 ? 2 : 1), dice[1]) + Number(e.damage_bonus || 0));
}
function twoPrepareEnemy(e, rnd) {
  e = (e && typeof e === "object") ? e : {};
  const eid = Math.max(1, Number(e.id || 1) | 0);
  const tr = twoNosferatuTrait(eid);
  const fresh = !e.dnd5e;
  e.id = eid;
  e.dnd5e = true;
  e.archetype = String(e.archetype || tr.archetype);
  e.kind = String(e.kind || tr.kind);
  e.role = String(e.role || tr.role);
  e.stats = (e.stats && typeof e.stats === "object") ? e.stats : tr.stats;
  e.ac = Number(e.ac || tr.ac);
  e.max_hp = Math.max(Number(e.max_hp || 0) | 0, Number(tr.hp || 20) | 0);
  const ehp = Number(e.hp || 0) | 0;
  e.hp = (fresh || ehp <= 6) ? e.max_hp : Math.max(1, Math.min(ehp, e.max_hp));
  e.speed = Number(e.speed || tr.speed);
  e.lunge_speed = Number(e.lunge_speed || tr.lunge);
  e.attack_bonus = Number(e.attack_bonus || tr.attack_bonus);
  e.damage_dice = Array.isArray(e.damage_dice) ? e.damage_dice : tr.damage_dice;
  e.damage_bonus = Number(e.damage_bonus || tr.damage_bonus);
  e.attack_damage = Number(e.attack_damage || tr.attack);
  e.attack_range = Number(e.attack_range || tr.range);
  e.prefer_range = Number(e.prefer_range || tr.prefer_range || 0);
  e.attack_cooldown = Number(e.attack_cooldown || tr.cooldown);
  e.flank_bias = Number(e.flank_bias || tr.flank);
  e.flank_dir = Number(e.flank_dir || ((eid % 2) ? -1 : 1));
  e.xp = Number(e.xp || tr.xp);
  e.save_dc = Number(e.save_dc || tr.save_dc || 0);
  e.attack_mode = String(e.attack_mode || tr.attack_mode || "melee");
  e.attackT = Number(e.attackT || ((rnd ? rnd() : Math.random()) * 0.34));
  e.smellT = Number(e.smellT || 0);
  e.lungeT = Number(e.lungeT || 0);
  e.stuckT = Number(e.stuckT || 0);
  return e;
}
function twoMoveEnemy(room, e, nx, ny) {
  const ex = Number(e.x || 0), ey = Number(e.y || 0);
  if (!twoIsWall(room, nx, ny)) { e.x = Math.round(nx * 1000) / 1000; e.y = Math.round(ny * 1000) / 1000; return true; }
  if (!twoIsWall(room, nx, ey)) { e.x = Math.round(nx * 1000) / 1000; return true; }
  if (!twoIsWall(room, ex, ny)) { e.y = Math.round(ny * 1000) / 1000; return true; }
  return false;
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

function twoSpawnMission(room, campaignReq = null) {
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
    const tr = twoNosferatuTrait(i + 1);
    const hp = tr.hp + (rnd() < 0.28 ? 1 : 0);
    enemies.push(twoPrepareEnemy({
      id: i + 1,
      x: Math.round(p.x * 1000) / 1000,
      y: Math.round(p.y * 1000) / 1000,
      hp, max_hp: hp, kind: tr.kind,
      speed: tr.speed, lunge_speed: tr.lunge,
      attack_damage: tr.attack, attack_range: tr.range, attack_cooldown: tr.cooldown,
      flank_bias: tr.flank, flank_dir: ((i % 2) ? 1 : -1)
    }, rnd));
  }
  room.mission = {
    id: (campaign ? ("CAMPAIGN-" + campaign.stage + "-" + String(seed >>> 0)) : ("NEST-" + String(seed >>> 0))), seed, code,
    raid_code: raidCode,
    location: campaign ? campaign.location : "Unknown Exclusion Zone",
    campaign: campaign || { enabled: false },
    mapW: w, mapH: h, map,
    target: {
      x: campaign ? Math.round(campaign.lon * 1000) / 1000 : Math.round((rnd() * 900 + 50) * 10) / 10,
      y: campaign ? Math.round(campaign.lat * 1000) / 1000 : Math.round((rnd() * 900 + 50) * 10) / 10,
      mx: target.mx, my: target.my
    },
    enemies,
    complete: false
  };
  room.vehicle = { x: 2.5, y: 2.5, a: 0, hp: 100 };
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
    const mission = (room.mission && twoMissionMatchesCampaign(room.mission, m.campaign)) ? room.mission : twoSpawnMission(room, m.campaign);
    twoBroadcast(room, { t: "mission", mission, ts: Date.now() });
    return;
  }
  if (t === "launch") {
    const mission = (room.mission && twoMissionMatchesCampaign(room.mission, m.campaign)) ? room.mission : twoSpawnMission(room, m.campaign);
    twoAutoAssignRolesForLaunch(room, meta.id);
    room.started = true;
    room.vehicle = { x: 2.5, y: 2.5, a: 0, hp: 100 };
    for (const [ows, ometa] of room.clients.entries()) {
      twoSend(ows, { t: "start", mission, vehicle: room.vehicle, roles: room.roles, role: twoRoleForId(room, ometa.id), id: ometa.id, ts: Date.now() });
    }
    twoSendRoleSync(room);
    twoSyncLobby(room);
    return;
  }
  if (t === "drive") {
    if (room.roles.driver && room.roles.driver !== meta.id) return;
    const v = (m.v && typeof m.v === "object") ? m.v : {};
    room.vehicle = {
      x: clamp(Number(v.x != null ? v.x : room.vehicle.x), 1.2, (room.mission ? room.mission.mapW - 1.2 : 31)),
      y: clamp(Number(v.y != null ? v.y : room.vehicle.y), 1.2, (room.mission ? room.mission.mapH - 1.2 : 21)),
      a: clamp(Number(v.a != null ? v.a : room.vehicle.a), -999999, 999999),
      hp: clamp(Number(v.hp != null ? v.hp : room.vehicle.hp), 0, 100)
    };
    twoBroadcast(room, { t: "vehicle", v: room.vehicle, by: meta.id, ts: Date.now() });
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
      if (d < 0.2 || d > 17) continue;
      let da = Math.atan2(dy, dx) - a;
      while (da <= -Math.PI) da += Math.PI * 2;
      while (da > Math.PI) da -= Math.PI * 2;
      if (Math.abs(da) < 0.12 && d < bestD && twoLineClear(room, sx, sy, e.x, e.y)) { bestIdx = i; bestD = d; }
    }
    twoBroadcast(room, { t: "shot", by: meta.id, a, ts: Date.now() });
    if (bestIdx >= 0) {
      const e = room.mission.enemies[bestIdx];
      const shotRoll = twoResolveShotDamage(m.dnd, e);
      if (!shotRoll.hit) {
        twoBroadcast(room, { t: "enemy_update", enemies: [{ id: e.id, x: e.x, y: e.y, hp: e.hp, max_hp: e.max_hp, kind: e.kind, ac: e.ac, miss: true }], ts: Date.now() });
        return;
      }
      e.hp = (e.hp | 0) - Math.max(1, shotRoll.damage | 0);
      if (e.hp <= 0) {
        const dead = room.mission.enemies.splice(bestIdx, 1)[0];
        twoBroadcast(room, { t: "enemy_remove", id: dead.id, by: meta.id, ts: Date.now() });
        if (room.mission.enemies.length === 0) {
          room.started = false;
          room.mission.complete = true;
          twoBroadcast(room, { t: "complete", mission: room.mission, by: meta.id, ts: Date.now() });
          room.mission = null;
        }
      } else {
        twoBroadcast(room, { t: "enemy_update", enemies: [{ id: e.id, x: e.x, y: e.y, hp: e.hp, max_hp: e.max_hp, kind: e.kind, ac: e.ac, xp: e.xp, archetype: e.archetype, attack_mode: e.attack_mode }], ts: Date.now() });
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
  const v = room.vehicle || { x: 2.5, y: 2.5, hp: 100 };
  const dtSec = Math.max(0.001, Math.min(0.09, Number(dt || 80) / 1000));
  const moved = [];
  let damaged = false;

  for (let idx = 0; idx < room.mission.enemies.length; idx++) {
    const e = twoPrepareEnemy(room.mission.enemies[idx]);
    const ex = Number(e.x || 0), ey = Number(e.y || 0);
    const dx = Number(v.x || 2.5) - ex, dy = Number(v.y || 2.5) - ey;
    const dist = Math.hypot(dx, dy) || 0.001;
    const visible = twoLineClear(room, ex, ey, Number(v.x || 2.5), Number(v.y || 2.5));
    if (visible) {
      e.lastX = Number(v.x || 2.5);
      e.lastY = Number(v.y || 2.5);
      e.smellT = 2.25;
    } else {
      e.smellT = Math.max(0, Number(e.smellT || 0) - dtSec);
    }
    e.attackT = Math.max(0, Number(e.attackT || 0) - dtSec);
    e.lungeT = Math.max(0, Number(e.lungeT || 0) - dtSec);

    const aggro = Number(v.aggro_range || 8.5);
    if (visible && dist > aggro) {
      // High CHA tanks draw farther aggro. Outside the signal radius, monsters prowl.
    } else if (visible && dist <= Number(e.attack_range || 0.74)) {
      if (e.attackT <= 0) {
        const dmg = twoResolveEnemyDamage(e, v);
        if (dmg > 0) {
          v.hp = clamp(Number(v.hp || 100) - dmg, 0, 100);
          damaged = true;
        }
        e.attackT = Number(e.attack_cooldown || 0.45) * (0.82 + Math.random() * 0.34);
        e.lungeT = (String(e.archetype || "") === "caster") ? 0.09 : 0.16;
      }
      moved.push({ id: e.id, x: e.x, y: e.y, hp: e.hp, max_hp: e.max_hp, kind: e.kind, ac: e.ac, xp: e.xp, moving: false });
      continue;
    }

    let tx, ty;
    const aggroMove = Number(v.aggro_range || 8.5);
    if (visible && dist <= aggroMove) {
      if (String(e.archetype || "") === "caster" && Number(e.prefer_range || 0) > 0 && dist < Number(e.prefer_range || 0) * 0.86) {
        tx = ex - dx; ty = ey - dy;
      } else {
        tx = Number(v.x || 2.5); ty = Number(v.y || 2.5);
      }
    }
    else if (Number(e.smellT || 0) > 0 && Number.isFinite(e.lastX) && Number.isFinite(e.lastY)) { tx = e.lastX; ty = e.lastY; }
    else {
      tx = ex + Math.cos(idx * 1.9 + Date.now() * 0.0007) * 1.4;
      ty = ey + Math.sin(idx * 2.3 + Date.now() * 0.0006) * 1.1;
    }

    let vx = tx - ex, vy = ty - ey;
    let mag = Math.hypot(vx, vy) || 1;
    vx /= mag; vy /= mag;

    let sepX = 0, sepY = 0;
    for (let j = 0; j < room.mission.enemies.length; j++) {
      if (j === idx) continue;
      const o = room.mission.enemies[j];
      const ox = ex - Number(o.x || ex), oy = ey - Number(o.y || ey);
      const od = Math.hypot(ox, oy);
      if (od > 0.001 && od < 0.82) { sepX += ox / od * (0.82 - od); sepY += oy / od * (0.82 - od); }
    }

    const fd = Number(e.flank_dir || 1) < 0 ? -1 : 1;
    const wounded = (Number(e.hp || 1) <= Math.max(1, (Number(e.max_hp || 3) | 0) >> 1));
    let flank = Number(e.flank_bias || 0.5) * (visible ? 1.0 : 1.45) * (wounded ? 1.22 : 1.0);
    const lx = -vy * fd * flank, ly = vx * fd * flank;
    let mx = vx + lx + sepX * 1.7, my = vy + ly + sepY * 1.7;
    mag = Math.hypot(mx, my) || 1;
    mx /= mag; my /= mag;

    let speed = Number(e.speed || 1.0);
    if (visible && dist < 5.0) speed *= 1.18;
    if (wounded) speed *= 1.10;
    if (Number(e.lungeT || 0) > 0) speed = Math.max(speed, Number(e.lunge_speed || speed));
    const step = speed * dtSec;
    const candidates = [
      [ex + mx * step, ey + my * step],
      [ex + vx * step, ey + vy * step],
      [ex + (vx - lx) * step, ey + (vy - ly) * step],
      [ex + (vx + ly) * step, ey + (vy - lx) * step],
      [ex + (vx - ly) * step, ey + (vy + lx) * step],
    ];
    let ok = false;
    for (const c of candidates) { if (twoMoveEnemy(room, e, c[0], c[1])) { ok = true; break; } }
    if (!ok) {
      e.stuckT = Number(e.stuckT || 0) + dtSec;
      if (e.stuckT > 0.18) { e.flank_dir = -fd; e.stuckT = 0; }
    } else {
      e.stuckT = 0;
      moved.push({ id: e.id, x: e.x, y: e.y, hp: e.hp, max_hp: e.max_hp, kind: e.kind, ac: e.ac, xp: e.xp, archetype: e.archetype, moving: true });
    }
  }
  if (moved.length) twoBroadcast(room, { t: "enemy_update", enemies: moved, ts: Date.now() });
  if (damaged) twoBroadcast(room, { t: "vehicle", v, ts: Date.now() });
  if (v.hp <= 0) {
    room.started = false;
    v.hp = 100;
    twoBroadcast(room, { t: "chat", from: "COMMAND", name: "COMMAND", text: "Pod disabled. Emergency recall complete.", ts: Date.now() });
    twoBroadcast(room, { t: "vehicle", v, ts: Date.now() });
  }
}

// -----------------------------
// [2] Hunters enemy AI tick
// -----------------------------
const TWO_TICK_MS = 80;
setInterval(() => {
  try {
    for (const room of twoRooms.values()) twoTickRoom(room, TWO_TICK_MS);
  } catch {}
}, TWO_TICK_MS);

// ----------------------------------------
// AZHA fixed-rate net sync & enemy AI tick
// ----------------------------------------
const TICK_MS = 50;   // 20 Hz
const ENEMY_MS = 100; // 10 Hz
let _accEnemy = 0;
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room || room.game !== "AZHA") continue;
    if (!room.started) continue;
    const metas = [...room.clients.entries()];
    if (metas.length === 0) continue;
    for (const [wsA, metaA] of metas) {
      if (!metaA || !metaA.state || !metaA._dirty) continue;
      metaA._dirty = false;
      const msg = { type: "state", from: metaA.id, name: metaA.name || metaA.id, s: metaA.state };
      const data = JSON.stringify(msg);
      for (const [wsB] of metas) {
        try { if (wsB && wsB.readyState === 1) wsB.send(data); } catch {}
      }
    }
    _accEnemy += TICK_MS;
    if (_accEnemy >= ENEMY_MS) {
      _accEnemy = 0;
      if (room.mission && room.mission.phase === "destroy" && Array.isArray(room.mission.entities) && room.mission.entities.length) {
        const players = metas
          .map(([, m]) => (m && m.state) ? { x: m.state.x, y: m.state.y } : null)
          .filter(Boolean);
        if (players.length) {
          let moved = null;
          for (const e of room.mission.entities) {
            if (!e || e.type !== "enemy") continue;
            const ex = e.x, ey = e.y;
            let best = players[0], bestD2 = 1e9;
            for (const p of players) {
              const dx = p.x - ex, dy = p.y - ey;
              const d2 = dx * dx + dy * dy;
              if (d2 < bestD2) { bestD2 = d2; best = p; }
            }
            const hp = (e.hp | 0) || 2;
            const flee = hp <= 1 && bestD2 < 9.0;
            const speed = flee ? 0.020 : 0.028;
            let vx = best.x - ex, vy = best.y - ey;
            const mag = Math.hypot(vx, vy) || 1;
            vx /= mag; vy /= mag;
            if (flee) { vx = -vx; vy = -vy; }
            let nx = ex + vx * speed;
            let ny = ey + vy * speed;
            if (azhaIsWall(room, nx, ny)) {
              if (!azhaIsWall(room, nx, ey)) { ny = ey; }
              else if (!azhaIsWall(room, ex, ny)) { nx = ex; }
              else { nx = ex; ny = ey; }
            }
            nx = clamp(nx, 1.25, (room.mapW || 80) - 2.25);
            ny = clamp(ny, 1.25, (room.mapH || 45) - 2.25);
            const dxm = nx - ex, dym = ny - ey;
            if ((dxm * dxm + dym * dym) > 1e-6) {
              e.x = Math.round(nx * 1000) / 1000;
              e.y = Math.round(ny * 1000) / 1000;
              (moved || (moved = [])).push({ id: e.id | 0, x: e.x, y: e.y, hp: e.hp | 0 });
            }
          }
          if (moved && moved.length) {
            azhaBroadcast(room, { type: "m_update", op: "pos", list: moved });
          }
        }
      }
    }
  }
}, TICK_MS);
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
// ------------------------------------------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log("Merged relay (Dedset App) on port", PORT);
});
