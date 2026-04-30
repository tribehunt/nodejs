// server.js - supports Eldritch Cyber Front,
// Ethane Sea, Azha, STUG, GROWTH & FOIDBALL
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
// FOIDBALL spectator protocol (fb:...)
// Roster hub can list hosts. Hosts stream lightweight match snapshots. Viewers receive autoplay field frames.
// ---------------------------------------------------------------------------------------------------------
const foidHosts = new Map(); // id -> { id, name, ws, playing, snapshot, viewers:Set<ws>, updatedAt }
function foidSafeId(s) {
  try { return String(s || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || ("FB-" + rid()); } catch { return "FB-" + rid(); }
}
function foidSafeName(s, fb="FOIDBALL") {
  try { return String(s || "").replace(/\s+/g, " ").trim().slice(0, 48) || fb; } catch { return fb; }
}
function foidSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send("fb:" + JSON.stringify(obj)); } catch {}
}
function foidHostPublic(h, viewerWs=null) {
  return { id:String(h.id||""), name:foidSafeName(h.name,"FOIDBALL"), playing:!!h.playing,
    viewers:h.viewers?Math.max(0,h.viewers.size|0):0,
    age:Math.max(0,Math.floor((Date.now()-Number(h.updatedAt||0))/1000)), you:!!(viewerWs&&h.ws===viewerWs) };
}
function foidViewerSockets(h) {
  const out=[]; if(!h||!h.viewers)return out;
  for(const v of [...h.viewers]) { if(v&&v.readyState===WebSocket.OPEN) out.push(v); else h.viewers.delete(v); }
  return out;
}
function foidSendHosts(ws) {
  const hosts=[...foidHosts.values()].filter(h=>h&&h.ws&&h.ws.readyState===WebSocket.OPEN).map(h=>foidHostPublic(h,ws));
  foidSend(ws,{t:"hosts",hosts,ts:Date.now()});
}
function foidBroadcastHosts() {
  const hosts=[...foidHosts.values()].filter(h=>h&&h.ws&&h.ws.readyState===WebSocket.OPEN).map(h=>foidHostPublic(h));
  try { for(const c of wss.clients) if(c&&c.readyState===WebSocket.OPEN&&c._foidSeen) foidSend(c,{t:"hosts",hosts,ts:Date.now()}); } catch {}
}
function foidDetachViewer(ws, silent=false) {
  if(!ws||!ws._foidWatchingHostId)return;
  const host=foidHosts.get(String(ws._foidWatchingHostId)); ws._foidWatchingHostId="";
  if(host&&host.viewers){ host.viewers.delete(ws); const count=foidViewerSockets(host).length; if(!silent) foidSend(host.ws,{t:"spectator_count",count,ts:Date.now()}); }
  foidBroadcastHosts();
}
function foidDetach(ws) {
  if(!ws)return; foidDetachViewer(ws,true);
  const id=String(ws._foidId||""); const host=id?foidHosts.get(id):null;
  if(host&&host.ws===ws){
    for(const v of foidViewerSockets(host)){ foidSend(v,{t:"host_left",host_id:id,ts:Date.now()}); try{v._foidWatchingHostId="";}catch{} }
    foidHosts.delete(id); foidBroadcastHosts();
  }
  ws._foidSeen=false;
}
function foidHandle(ws, payloadStr) {
  let m=null; try{m=JSON.parse(String(payloadStr||""));}catch{m=null}
  if(!m||typeof m!=="object")return; ws._foidSeen=true;
  const t=String(m.t||m.type||"").toLowerCase();
  if(t==="hello") { ws._foidId=foidSafeId(m.id||ws._foidId); ws._foidName=foidSafeName(m.name||ws._foidName,"FOIDBALL"); foidSend(ws,{t:"welcome",id:ws._foidId,name:ws._foidName,ts:Date.now()}); foidSendHosts(ws); return; }
  if(t==="list") { foidSendHosts(ws); return; }
  if(t==="host") {
    const id=foidSafeId(m.id||ws._foidId); ws._foidId=id; ws._foidName=foidSafeName(m.name||ws._foidName,"FOIDBALL");
    const prev=foidHosts.get(id)||null;
    const entry={id,name:ws._foidName,ws,playing:!!m.playing,snapshot:(m.snapshot&&typeof m.snapshot==="object")?m.snapshot:(prev?prev.snapshot:null),viewers:prev&&prev.viewers?prev.viewers:new Set(),updatedAt:Date.now()};
    foidHosts.set(id,entry);
    for(const v of foidViewerSockets(entry)){ try{v._foidWatchingHostId=id;}catch{}; foidSend(v,{t:"watch_ok",host:foidHostPublic(entry,v),ts:Date.now()}); if(entry.playing&&entry.snapshot) foidSend(v,{t:"frame",host_id:id,playing:true,snapshot:entry.snapshot,ts:Date.now()}); else foidSend(v,{t:"watch_wait",host_id:id,message:"HOST IS NOT IN A MATCH YET",ts:Date.now()}); }
    foidSend(ws,{t:"host_ok",host:foidHostPublic(entry,ws),ts:Date.now()}); foidBroadcastHosts(); return;
  }
  if(t==="unhost"||t==="host_quit") {
    const id=foidSafeId(m.id||ws._foidId||""); const host=id?foidHosts.get(id):null; if(!host||host.ws!==ws)return;
    for(const v of foidViewerSockets(host)){ foidSend(v,{t:"host_left",host_id:id,ts:Date.now()}); try{v._foidWatchingHostId="";}catch{} }
    foidHosts.delete(id); foidBroadcastHosts(); return;
  }
  if(t==="watch") {
    const hostId=foidSafeId(m.host_id||""); const host=foidHosts.get(hostId);
    if(!host||!host.ws||host.ws.readyState!==WebSocket.OPEN){ foidSend(ws,{t:"error",code:"host_missing",message:"That FOIDBALL host is offline."}); foidSendHosts(ws); return; }
    if(host.ws===ws||hostId===foidSafeId(ws._foidId||"")){ foidSend(ws,{t:"error",code:"self_watch",message:"That is your own broadcast."}); return; }
    if(!host.viewers)host.viewers=new Set(); foidDetachViewer(ws,true);
    if(host.viewers.size>=20){ foidSend(ws,{t:"error",code:"full",message:"That FOIDBALL broadcast already has 20 viewers."}); return; }
    ws._foidId=foidSafeId(m.viewer_id||ws._foidId); ws._foidName=foidSafeName(m.viewer_name||ws._foidName,"VIEWER"); ws._foidWatchingHostId=hostId; host.viewers.add(ws);
    foidSend(ws,{t:"watch_ok",host:foidHostPublic(host,ws),ts:Date.now()}); foidSend(host.ws,{t:"spectator_count",count:foidViewerSockets(host).length,ts:Date.now()});
    if(host.playing&&host.snapshot) foidSend(ws,{t:"frame",host_id:hostId,playing:true,snapshot:host.snapshot,ts:Date.now()}); else foidSend(ws,{t:"watch_wait",host_id:hostId,message:"HOST IS NOT IN A MATCH YET",ts:Date.now()});
    foidBroadcastHosts(); return;
  }
  if(t==="unwatch") { foidDetachViewer(ws); return; }
  if(t==="frame") {
    const id=foidSafeId(m.id||ws._foidId||""); const host=id?foidHosts.get(id):null; if(!host||host.ws!==ws)return;
    host.playing=!!m.playing; host.updatedAt=Date.now(); if(m.snapshot&&typeof m.snapshot==="object")host.snapshot=m.snapshot;
    const packet={t:"frame",host_id:id,playing:host.playing,snapshot:host.snapshot,ts:Date.now()};
    for(const v of foidViewerSockets(host)) {
      try {
        if(Number(v.bufferedAmount || 0) < 262144) foidSend(v,packet);
      } catch { foidSend(v,packet); }
    }
    return;
  }
  if(t==="ping") { foidSend(ws,{t:"pong",ts:Date.now()}); return; }
}

// -----------------------------------------
// Connection handler (auto-detect protocol)
// -----------------------------------------
wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws._ip = pickIP(req);
  ws._proto = null; // "ECF" | "AZHA"
  ws._ecf_id = null;
  ws._roomGame = null; // "ECF"|"AZHA"
  ws._roomName = null;
  // ECF defaults
  let ecf_id = rid();
  let ecf_roomName = "brothers";
  // AZHA defaults
  let azha_roomName = "global";
  let azha_meta = {
    id: "U" + Math.floor(Math.random() * 1e9).toString(36),
    name: "",
    ready: false,
    state: null
  };
  function detachFromCurrentRoom() {
    if (!ws._roomGame || !ws._roomName) return;
    if (ws._roomGame === "ECF") {
      const room = getRoom("ECF", ws._roomName);
      if (ecf_id && room.clients.get(ecf_id) === ws) room.clients.delete(ecf_id);
      room.ready.delete(ecf_id);
      ecfBroadcast(room, { t: "leave", id: ecf_id });
      deleteRoomIfEmpty(room);
    } else {
      const room = getRoom("AZHA", ws._roomName);
      room.clients.delete(ws);
      room.started = false;
      room.seed = 0;
      room.mapGrid = null;
      room.mission = { step: 0, phase: "rally", target: { x: 2.5, y: 2.5 }, entities: [], nextId: 1 };
      azhaSyncLobby(room, ws._roomName);
      deleteRoomIfEmpty(room);
    }
    ws._roomGame = null;
    ws._roomName = null;
  }
  function attachToRoom(game, roomName) {
    ws._roomGame = game;
    ws._roomName = roomName;
    if (game === "ECF") {
      const room = getRoom("ECF", roomName);
      if (ws._ip) {
        for (const [oid, ows] of room.clients) {
          if (!ows || ows === ws) continue;
          if (ows._ip && ows._ip === ws._ip) {
            room.clients.delete(oid);
            room.ready.delete(oid);
            try { ows.send(JSON.stringify({ t: "error", code: "dup_ip", message: "Duplicate session from same IP; closing old." })); } catch {}
            try { ows.close(); } catch {}
          }
        }
      }
      room.clients.set(ecf_id, ws);
      if (!room.ready.has(ecf_id)) room.ready.set(ecf_id, false);
      return room;
    } else {
      const room = getRoom("AZHA", roomName);
      if (ws._ip) {
        for (const [ows] of room.clients) {
          if (!ows || ows === ws) continue;
          if (ows._ip && ows._ip === ws._ip) {
            room.clients.delete(ows);
            try { ows.send(JSON.stringify({ type: "error", message: "Duplicate session from same IP; closing old." })); } catch {}
            try { ows.close(); } catch {}
          }
        }
      }
      room.clients.set(ws, azha_meta);
      return room;
    }
  }
  ws.on("message", (buf) => {
    let raw = "";
    try { raw = buf.toString("utf8"); } catch { raw = ""; }
    // ETHANE SEA prison protocol:
    if (raw && raw.startsWith("p:")) {
      try { prisonHandle(ws, raw.slice(2)); } catch {}
      return;
    }
    // STUG fleet-autobattle protocol:
    if (raw && raw.startsWith("s:")) {
      try { stugHandle(ws, raw.slice(2)); } catch {}
      return;
    }
    // GROWTH Frog-Hole / Croakline protocol:
    if (raw && raw.startsWith("gf:")) {
      try { growthHandle(ws, raw.slice(3)); } catch {}
      return;
    }
    // FOIDBALL spectator protocol:
    if (raw && raw.startsWith("fb:")) {
      try { foidHandle(ws, raw.slice(3)); } catch {}
      return;
    }
let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m) return;
    if (!ws._proto) {
      if (m.t) ws._proto = "ECF";
      else if (m.type) ws._proto = "AZHA";
      else return;
    }
    // ------------
    // ECF handling
    // ------------
    if (ws._proto === "ECF") {
      const t = m.t;
      if (!ws._roomGame) {
        ws._roomGame = "ECF";
        ws._roomName = ecf_roomName;
        ws._ecf_id = ecf_id;
        const room = attachToRoom("ECF", ecf_roomName);
        ws.send(JSON.stringify({ t: "welcome", id: ecf_id, room: ecf_roomName }));
        ws.send(JSON.stringify(ecfRoomState(room)));
      }
      const room = getRoom("ECF", ws._roomName);
      if (room.game !== "ECF") return;
      if (t === "hello") {
        const roomName = safeRoomId(m.room || "brothers", "brothers");
        const oldRoomName = ws._roomName;
        if (oldRoomName !== roomName) {
          detachFromCurrentRoom();
          ecf_roomName = roomName;
          attachToRoom("ECF", roomName);
        }
        ws.send(JSON.stringify({ t: "welcome", id: ecf_id, room: ws._roomName }));
        ws.send(JSON.stringify(ecfRoomState(getRoom("ECF", ws._roomName))));
        ecfBroadcast(getRoom("ECF", ws._roomName), { t: "msg", s: `${ecf_id} joined.` }, ecf_id);
        return;
      }
      if (t === "scan") {
        room.seed = (m.seed != null ? m.seed : room.seed);
        room.difficulty = (m.difficulty != null ? m.difficulty : room.difficulty);
        room.missionActive = false;
        for (const k of room.ready.keys()) room.ready.set(k, false);
        ecfBroadcast(room, { t: "scan", seed: room.seed, difficulty: room.difficulty });
        ecfBroadcast(room, ecfRoomState(room));
        return;
      }
      if (t === "ready") {
        room.ready.set(ecf_id, !!m.ready);
        ecfBroadcast(room, ecfRoomState(room));
        const ids = [...room.clients.keys()].sort();
        if (room.seed != null && !room.missionActive) {
          if (ws._roomName === "solo") {
            if (!!room.ready.get(ecf_id)) {
              room.missionActive = true;
              ecfBroadcast(room, { t: "start", seed: room.seed, difficulty: room.difficulty, players: [ecf_id] });
              ecfBroadcast(room, ecfRoomState(room));
            }
          } else {
            if (ids.length >= 2) {
              const r0 = !!room.ready.get(ids[0]);
              const r1 = !!room.ready.get(ids[1]);
              if (r0 && r1) {
                room.missionActive = true;
                ecfBroadcast(room, { t: "start", seed: room.seed, difficulty: room.difficulty, players: ids.slice(0, 2) });
                ecfBroadcast(room, ecfRoomState(room));
              }
            }
          }
        }
        return;
      }
      if (t === "state") {
        ecfBroadcast(room, { t: "state", id: ecf_id, x: m.x, y: m.y, a: m.a, hp: m.hp }, ecf_id);
        return;
      }
      if (t === "mission_exit") {
        ecfBroadcast(room, { t: "mission_exit", id: ecf_id, reason: m.reason, hp: m.hp }, ecf_id);
        return;
      }
      if (t === "shot") {
        ecfBroadcast(room, { t: "shot", id: ecf_id, x: m.x, y: m.y, vx: m.vx, vy: m.vy, dmg: m.dmg }, ecf_id);
        return;
      }
      if (t === "dmg") {
        ecfBroadcast(room, { t: "dmg", from: ecf_id, to: m.to, amt: m.amt }, ecf_id);
        return;
      }
      if (t === "obj_use") {
        ecfBroadcast(room, { t: "obj_use", id: ecf_id, i: m.i, on: !!m.on }, ecf_id);
        return;
      }
      if (t === "enemies") {
        ecfBroadcast(room, {
          t: "enemies",
          id: ecf_id,
          en: m.en, te: m.te, stl: m.stl, swc: m.swc, ssd: m.ssd,
          mt: m.mt, obj: m.obj, op: m.op, od: m.od,
          ex: m.ex, ext: m.ext, exr: m.exr
        }, ecf_id);
        return;
      }
      if (t === "msg") {
        const s = ((m.s != null ? m.s : "")).toString().slice(0, 240);
        if (s.length) ecfBroadcast(room, { t: "msg", s }, ecf_id);
        return;
      }
      return;
    }
    // -------------
    // AZHA handling
    // -------------
    if (ws._proto === "AZHA") {
      const type = m.type;
      if (!ws._roomGame) {
        ws._roomGame = "AZHA";
        ws._roomName = azha_roomName;
        const room = attachToRoom("AZHA", azha_roomName);
        azhaSyncLobby(room, ws._roomName);
      }
      let room = getRoom("AZHA", ws._roomName);
      if (room.game !== "AZHA") return;
      if (type === "join") {
        const nextRoomId = safeRoomId(m.room || "global", "global");
        const nextRoom = getRoom("AZHA", nextRoomId);
        if (nextRoom.clients.size >= 2 && !nextRoom.clients.has(ws)) {
          try { ws.send(JSON.stringify({ type: "error", message: "Room is full (2 players max)." })); } catch {}
          return;
        }
        detachFromCurrentRoom();
        azha_roomName = nextRoomId;
        ws._roomGame = "AZHA";
        ws._roomName = nextRoomId;
        room = attachToRoom("AZHA", nextRoomId);
        azha_meta.id = String(m.id || azha_meta.id).slice(0, 32);
        let desired = String(m.name || "").replace(/\s+/g, " ").trim().slice(0, 24);
        const _aEnf = enforceReservedName(ws, desired, azha_meta.name, azha_meta.id, "azha");
        desired = _aEnf.name;
        const used = new Set();
        for (const meta of nextRoom.clients.values()) {
          if (meta && meta.name) used.add(normNameKey(meta.name));
        }
        let finalName = desired;
        if (finalName && used.has(normNameKey(finalName))) {
          for (let i = 0; i < 12; i++) {
            const suf = "-" + Math.random().toString(36).slice(2, 5).toUpperCase();
            const cut = Math.max(1, 24 - suf.length);
            const cand = finalName.slice(0, cut) + suf;
            if (!used.has(normNameKey(cand))) { finalName = cand; break; }
          }
        }
        azha_meta.name = finalName;
        azha_meta.ready = false;
        azha_meta.state = null;
        room.clients.set(ws, azha_meta);
        azhaSyncLobby(room, nextRoomId);
        return;
      }
      if (type === "ready") {
        azha_meta.ready = !!m.ready;
        azhaSyncLobby(room, ws._roomName);
        azhaMaybeStart(room, ws._roomName);
        return;
      }
      if (type === "mission_request") {
        azhaEnsureMission(room);
        return;
      }
      if (type === "chat") {
        const text = String(m.text || "").slice(0, 200).trim();
        if (!text) return;
        let as = String(m.as || "").slice(0, 24).trim();
        if (as && isReservedName(as) && !isSkeletonAuthorized(ws._ip)) {
          try { ws.send(JSON.stringify({ type: "error", message: `Name "${as}" is reserved.` })); } catch {}
          as = "";
        }
        const from = as ? as : azha_meta.id;
        const name = as ? as : (azha_meta.name || azha_meta.id);
        azhaBroadcast(room, { type: "chat", from, name, text, ts: Date.now() });
        return;
      }
      if (!room.started) return;
      if (type === "state") {
        if (m.s && Number.isFinite(m.s.x) && Number.isFinite(m.s.y)) {
          azha_meta.state = { x: Number(m.s.x), y: Number(m.s.y), ang: Number(m.s.ang) };
          if (m.name != null) azha_meta.name = String(m.name || azha_meta.name || "").slice(0, 24);
          azha_meta._dirty = true;
          azhaMaybeAdvanceMission(room);
        }
        return;
      }
      if (type === "m_hit") {
        const eid = m.eid | 0;
        if (!eid) return;
        const idx = room.mission.entities.findIndex(e => e.id === eid && e.type === "enemy");
        if (idx === -1) return;
        const ent = room.mission.entities[idx];
        ent.hp = (ent.hp | 0) - 1;
        if (ent.hp <= 0) {
          room.mission.entities.splice(idx, 1);
          azhaBroadcast(room, { type: "m_update", op: "remove", eid, by: azha_meta.id });
        } else {
          azhaBroadcast(room, { type: "m_update", op: "hp", eid, hp: ent.hp, by: azha_meta.id });
        }
        azhaMaybeAdvanceMission(room);
        return;
      }
      if (type === "m_collect") {
        const eid = m.eid | 0;
        if (!eid) return;
        const idx = room.mission.entities.findIndex(e => e.id === eid && e.type === "datnode");
        if (idx === -1) return;
        room.mission.entities.splice(idx, 1);
        azhaBroadcast(room, { type: "m_update", op: "remove", eid, by: azha_meta.id });
        azhaMaybeAdvanceMission(room);
        return;
      }
      return;
    }
  });
  ws.on("close", () => {
    try { prisonDetach(ws, true); } catch {}
    try { stugDetach(ws, true); } catch {}
    try { growthDetach(ws); } catch {}
    try { foidDetach(ws); } catch {}
    detachFromCurrentRoom();
  });
});
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
