// merged server.js - supports EldritchCyberFront, Azha, Ethane Sea & Gun of Agartha
// One process, one port, isolated rooms by game.
// by Dedset Media 02/24/2026

const http = require("http");
const WebSocket = require("ws");
const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("OK\n");
});

const wss = new WebSocket.Server({ server });

// --------------
// Shared helpers
// --------------
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
  if (!prisonRooms.has(rn)) prisonRooms.set(rn, { name: rn, clients: new Set() });
  return prisonRooms.get(rn);
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
    if (announce && ws._prisonName) {
      prisonBroadcast(room, { t: "sys", msg: `${ws._prisonName} left cellblock.` });
    }
    if (room.clients.size === 0) prisonRooms.delete(roomName);
  }
  ws._prisonRoomName = null;
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
      ws._prisonName = ws._prisonName || ws._prisonId;
      room.clients.add(ws);
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
    if (ws._prisonRoomName && ws._prisonRoomName !== room.name) {
      prisonDetach(ws, true);
    }
    ws._prisonRoomName = room.name;
    ws._prisonId = String(m.id || ws._prisonId || ("P-" + prisonMid().slice(0, 8))).slice(0, 32);
    ws._prisonName = String(m.name || ws._prisonId).slice(0, 24);
    room.clients.add(ws);
    prisonSend(ws, { t: "welcome", id: ws._prisonId, room: room.name, name: ws._prisonName });
    prisonBroadcast(room, { t: "sys", msg: `${ws._prisonName} entered cellblock.` });
    return;
  }
  if (t === "chat" || t === "msg") {
    if (!ws._prisonRoomName) {
      prisonHandle(ws, JSON.stringify({ t: "hello", room: m.room || "ethane_prison", id: m.id, name: m.name }));
    }
    const room = prisonRooms.get(ws._prisonRoomName);
    if (!room) return;
    const name = String(m.name || ws._prisonName || ws._prisonId || "PRISONER").slice(0, 24);
    const id = String(m.id || ws._prisonId || "").slice(0, 32);
    let msg = String(m.msg || m.message || "");
    msg = msg.replace(/\r?\n/g, " ").slice(0, 240);
    const mid = String(m.mid || prisonMid()).slice(0, 48);
    prisonBroadcast(room, { t: "chat", id, name, msg, mid, ts: Date.now() });
    return;
  }
  if (t === "ping") {
    prisonSend(ws, { t: "pong", ts: Date.now() });
    return;
  }
}
// ------------------------------------------------------------------------------------------------------------
// GUN OF AGARTHA CHAT protocol (g:...)
// Prefix protocol so it won't collide with JSON-based games.
// Clients send:  g:{"t":"hello","room":"agartha","id":"G-XXXX","name":"G-XXXX"}
// Chat send:     g:{"t":"chat","room":"agartha","id":"G-XXXX","name":"G-XXXX","msg":"hello","mid":"..."} 
// Server sends:  g:{"t":"chat","id":"...","name":"...","msg":"...","mid":"...","ts":...}
// ------------------------------------------------------------------------------------------------------------
const agarthaRooms = new Map(); // roomName -> { name, clients:Set<ws> }
function agarthaGetRoom(roomName) {
  const rn = safeRoomId(roomName || "agartha", "agartha");
  if (!agarthaRooms.has(rn)) agarthaRooms.set(rn, { name: rn, clients: new Set() });
  return agarthaRooms.get(rn);
}
function agarthaMid() {
  return (
    Math.random().toString(16).slice(2, 10) +
    Date.now().toString(16).slice(-8)
  ).toUpperCase();
}
function agarthaSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send("g:" + JSON.stringify(obj)); } catch {}
}
function agarthaBroadcast(room, obj) {
  const msg = "g:" + JSON.stringify(obj);
  for (const ws of room.clients) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch {}
    }
  }
}
function agarthaDetach(ws, announce = true) {
  if (!ws || !ws._agarthaRoomName) return;
  const roomName = ws._agarthaRoomName;
  const room = agarthaRooms.get(roomName);
  if (room) {
    room.clients.delete(ws);
    if (announce && ws._agarthaName) {
      agarthaBroadcast(room, { t: "sys", msg: `${ws._agarthaName} left void.` });
    }
    if (room.clients.size === 0) agarthaRooms.delete(roomName);
  }
  ws._agarthaRoomName = null;
}
function agarthaHandle(ws, payloadStr) {
  let s = "";
  try { s = String(payloadStr || "").trim(); } catch { s = ""; }
  if (!s) return;

  // Accept either JSON or plaintext (plaintext becomes chat)
  let m = null;
  try { m = JSON.parse(s); } catch { m = null; }

  if (!m || typeof m !== "object") {
    // plaintext chat auto-joins default room
    if (!ws._agarthaRoomName) {
      const room = agarthaGetRoom("agartha");
      ws._agarthaRoomName = room.name;
      ws._agarthaId = ws._agarthaId || ("G-" + agarthaMid().slice(0, 8));
      ws._agarthaName = ws._agarthaName || ws._agarthaId;
      room.clients.add(ws);
      agarthaSend(ws, { t: "welcome", id: ws._agarthaId, room: room.name, name: ws._agarthaName });
      agarthaBroadcast(room, { t: "sys", msg: `${ws._agarthaName} entered void.` });
    }
    const room = agarthaRooms.get(ws._agarthaRoomName);
    if (!room) return;
    const msg = s.slice(0, 240);
    agarthaBroadcast(room, {
      t: "chat",
      id: ws._agarthaId,
      name: ws._agarthaName,
      msg,
      mid: agarthaMid(),
      ts: Date.now()
    });
    return;
  }

  const t = String(m.t || m.type || "").toLowerCase();
  if (t === "hello" || t === "join") {
    const room = agarthaGetRoom(m.room || "agartha");
    if (ws._agarthaRoomName && ws._agarthaRoomName !== room.name) {
      agarthaDetach(ws, true);
    }
    ws._agarthaRoomName = room.name;
    ws._agarthaId = String(m.id || ws._agarthaId || ("G-" + agarthaMid().slice(0, 8))).slice(0, 32);
    ws._agarthaName = String(m.name || ws._agarthaId).slice(0, 24);
    room.clients.add(ws);
    agarthaSend(ws, { t: "welcome", id: ws._agarthaId, room: room.name, name: ws._agarthaName });
    agarthaBroadcast(room, { t: "sys", msg: `${ws._agarthaName} entered void.` });
    return;
  }

  if (t === "chat" || t === "msg") {
    if (!ws._agarthaRoomName) {
      agarthaHandle(ws, JSON.stringify({ t: "hello", room: m.room || "agartha", id: m.id, name: m.name }));
    }
    const room = agarthaRooms.get(ws._agarthaRoomName);
    if (!room) return;
    const name = String(m.name || ws._agarthaName || ws._agarthaId || "PILOT").slice(0, 24);
    const id = String(m.id || ws._agarthaId || "").slice(0, 32);
    let msg = String(m.msg || m.message || "");
    msg = msg.replace(/
?
/g, " ").slice(0, 240);
    const mid = String(m.mid || agarthaMid()).slice(0, 48);
    agarthaBroadcast(room, { t: "chat", id, name, msg, mid, ts: Date.now() });
    return;
  }

  if (t === "ping") {
    agarthaSend(ws, { t: "pong", ts: Date.now() });
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
// -----------------------------------------
// Connection handler (auto-detect protocol)
// -----------------------------------------
wss.on("connection", (ws) => {
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
      room.clients.set(ecf_id, ws);
      if (!room.ready.has(ecf_id)) room.ready.set(ecf_id, false);
      return room;
    } else {
      const room = getRoom("AZHA", roomName);
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
    
    // GUN OF AGARTHA chat protocol:
    if (raw && raw.startsWith("g:")) {
      try { agarthaHandle(ws, raw.slice(2)); } catch {}
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
        azha_meta.name = String(m.name || "").slice(0, 24);
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
        const as = String(m.as || "").slice(0, 24).trim();
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
    try { agarthaDetach(ws, true); } catch {}
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

// ------------------------------------------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log("Merged relay (ECF + AZHA) on port", PORT);
});
