const http = require("http");
const WebSocket = require("ws");
const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("OK\n");
});
const wss = new WebSocket.Server({ server });
/**
 * Rooms:
 * roomId -> {
 *   clients: Map(ws -> { id, name, ready, state? }),
 *   started: bool,
 *   seed: number,
 *   mapW: number,
 *   mapH: number,
 *   mission: {
 *     step: number,
 *     phase: 'rally'|'destroy'|'retrieve'|'complete',
 *     target: {x:number,y:number},
 *     entities: Array<{id:number,type:'enemy'|'datnode',x:number,y:number,hp?:number}>,
 *     nextId: number
 *   }
 * }
 */
const rooms = new Map();
function safeRoomId(s) {
  if (!s) return "public";
  s = String(s).trim().toLowerCase();
  s = s.replace(/[^a-z0-9_-]/g, "");
  return s.slice(0, 32) || "public";
}
function getRoom(roomId) {
  roomId = safeRoomId(roomId);
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Map(),
      started: false,
      seed: 0,
      mapW: 80,
      mapH: 45,
      mission: { step: 0, phase: "rally", target: { x: 0, y: 0 }, entities: [], nextId: 1 }
    });
  }
  return rooms.get(roomId);
}

function clamp(n, a, b) {
  n = Number(n);
  if (!Number.isFinite(n)) return a;
  return Math.max(a, Math.min(b, n));
}

function rndInt(min, max) {
  min = Math.floor(min);
  max = Math.floor(max);
  return min + Math.floor(Math.random() * (max - min + 1));
}

function jimboSay(room, text) {
  broadcast(room, { type: "chat", from: "JIMBO", name: "Jimbo", text: "@@JIMBO@@" + String(text || ""), ts: Date.now() });
}

function pickRallyTarget(room) {
  const w = room.mapW || 80;
  const h = room.mapH || 45;
  return {
    x: rndInt(2, Math.max(2, w - 3)) + 0.5,
    y: rndInt(2, Math.max(2, h - 3)) + 0.5
  };
}

function spawnLocalEntities(room, type, center, count) {
  const w = room.mapW || 80;
  const h = room.mapH || 45;
  const out = [];
  const radius = 6.5;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * radius;
    const x = clamp(center.x + Math.cos(a) * r, 1.5, w - 2.5);
    const y = clamp(center.y + Math.sin(a) * r, 1.5, h - 2.5);
    const ent = { id: room.mission.nextId++, type, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
    if (type === "enemy") ent.hp = 2;
    out.push(ent);
  }
  return out;
}

function pushMission(room) {
  broadcast(room, {
    type: "mission",
    phase: room.mission.phase,
    step: room.mission.step,
    target: room.mission.target,
    entities: room.mission.entities
  });
}

function startMission(room) {
  room.mission.step = 0;
  room.mission.phase = "rally";
  room.mission.entities = [];
  room.mission.nextId = 1;
  room.mission.target = pickRallyTarget(room);
  jimboSay(room, `AZHA / MIL-AI ONLINE. Tankers, rally at the marked nav blip. (X:${room.mission.target.x.toFixed(1)} Y:${room.mission.target.y.toFixed(1)})`);
  pushMission(room);
}

function ensureMission(room) {
  // If a mission hasn't been started (target at 0,0 or missing), start one now.
  const t = room.mission && room.mission.target;
  const ok = t && Number.isFinite(t.x) && Number.isFinite(t.y) && (t.x !== 0 || t.y !== 0);
  if (!ok) startMission(room);
  else pushMission(room);
}

function within(a, b, r) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return (dx * dx + dy * dy) <= (r * r);
}

function maybeAdvanceMission(room) {
  if (!room.started) return;
  const metas = [...room.clients.values()];
  if (metas.length !== 2) return;
  if (!metas.every(m => m && m.state && Number.isFinite(m.state.x) && Number.isFinite(m.state.y))) return;

  const p0 = { x: metas[0].state.x, y: metas[0].state.y };
  const p1 = { x: metas[1].state.x, y: metas[1].state.y };
  const tgt = room.mission.target;

  if (room.mission.phase === "rally") {
    if (within(p0, tgt, 1.25) && within(p1, tgt, 1.25)) {
      room.mission.step++;
      const pick = Math.random() < 0.5 ? "destroy" : "retrieve";
      room.mission.phase = pick;
      room.mission.entities = [];
      if (pick === "destroy") {
        const count = rndInt(2, 7);
        room.mission.entities = spawnLocalEntities(room, "enemy", tgt, count);
        jimboSay(room, `CONTACT. Hostile old-tech drones detected. Destroy all targets in the local grid. (${count} total)`);
      } else {
        const count = rndInt(2, 6);
        room.mission.entities = spawnLocalEntities(room, "datnode", tgt, count);
        jimboSay(room, `DATA SIGNATURES FOUND. Retrieve all datnodes in the local grid. (${count} total)`);
      }
      pushMission(room);
    }
    return;
  }

  if (room.mission.phase === "destroy") {
    if (room.mission.entities.length === 0) {
      room.mission.step++;
      room.mission.phase = "complete";
      jimboSay(room, `AREA SECURED. Stand by for next nav task.`);
      // Chain into a new rally point.
      room.mission.step++;
      room.mission.phase = "rally";
      room.mission.entities = [];
      room.mission.target = pickRallyTarget(room);
      jimboSay(room, `New nav blip uploaded. Rally at (X:${room.mission.target.x.toFixed(1)} Y:${room.mission.target.y.toFixed(1)}).`);
      pushMission(room);
    }
    return;
  }

  if (room.mission.phase === "retrieve") {
    if (room.mission.entities.length === 0) {
      room.mission.step++;
      room.mission.phase = "complete";
      jimboSay(room, `DATA RECOVERED. Stand by for next nav task.`);
      // Chain into a new rally point.
      room.mission.step++;
      room.mission.phase = "rally";
      room.mission.entities = [];
      room.mission.target = pickRallyTarget(room);
      jimboSay(room, `New nav blip uploaded. Rally at (X:${room.mission.target.x.toFixed(1)} Y:${room.mission.target.y.toFixed(1)}).`);
      pushMission(room);
    }
    return;
  }
}
function broadcast(room, msgObj) {
  const data = JSON.stringify(msgObj);
  for (const ws of room.clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}
function lobbyState(room) {
  const users = [];
  for (const meta of room.clients.values()) {
    users.push({ id: meta.id, name: meta.name, ready: meta.ready });
  }
  return users;
}
function maybeStart(room, roomId) {
  if (room.started) return;
  const metas = [...room.clients.values()];
  if (metas.length !== 2) return;
  if (!metas.every(m => m.ready)) return;
  room.started = true;
  room.seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  room.mapW = 80;
  room.mapH = 45;
  broadcast(room, {
    type: "start",
    room: roomId,
    seed: room.seed,
    mapW: 80,
    mapH: 45
  });
  startMission(room);
}
wss.on("connection", (ws) => {
  let roomId = "public";
  let room = getRoom(roomId);
  let meta = { id: "U" + Math.floor(Math.random() * 1e9).toString(36), name: "", ready: false, state: null };
  room.clients.set(ws, meta);
  function syncLobby() {
    broadcast(room, { type: "lobby", room: roomId, users: lobbyState(room), started: room.started });
  }
  syncLobby();
  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString("utf8")); } catch { return; }
    if (msg.type === "join") {
      const nextRoomId = safeRoomId(msg.room || "public");
      const nextRoom = getRoom(nextRoomId);
      if (nextRoom.clients.size >= 2 && !nextRoom.clients.has(ws)) {
        ws.send(JSON.stringify({ type: "error", message: "Room is full (2 players max)." }));
        return;
      }
      room.clients.delete(ws);
      syncLobby();
      roomId = nextRoomId;
      room = nextRoom;
      meta.id = String(msg.id || meta.id).slice(0, 32);
      meta.name = String(msg.name || "").slice(0, 24);
      meta.ready = false;
      room.clients.set(ws, meta);
      syncLobby();
      return;
    }
    if (msg.type === "ready") {
      meta.ready = !!msg.ready;
      syncLobby();
      maybeStart(room, roomId);
      return;
    }

    // Client can request the current mission (or force-init if missing)
    // Useful if a client connects late or missed the initial mission packet.
    if (msg.type === "mission_request") {
      if (!room.started) return;
      ensureMission(room);
      return;
    }
    if (msg.type === "chat") {
      const text = String(msg.text || "").slice(0, 200).trim();
      if (!text) return;
      const as = String(msg.as || "").slice(0, 24).trim();
      const from = as ? as : meta.id;
      const name = as ? as : (meta.name || meta.id);
      broadcast(room, { type: "chat", from, name, text, ts: Date.now() });
      return;
    }
    if (!room.started) return;
    if (msg.type === "state") {
      // Cache player position for mission logic.
      if (msg.s && Number.isFinite(msg.s.x) && Number.isFinite(msg.s.y)) {
        meta.state = { x: Number(msg.s.x), y: Number(msg.s.y), ang: Number(msg.s.ang) };
        // Drive mission advancement off latest states.
        maybeAdvanceMission(room);
      }
      msg.from = meta.id;
      broadcast(room, msg);
      return;
    }
    if (msg.type === "shoot" || msg.type === "event") {
      msg.from = meta.id;
      broadcast(room, msg);
      return;
    }
    if (msg.type === "m_hit") {
      const eid = msg.eid | 0;
      if (!eid) return;
      const idx = room.mission.entities.findIndex(e => e.id === eid && e.type === "enemy");
      if (idx === -1) return;
      const ent = room.mission.entities[idx];
      ent.hp = (ent.hp | 0) - 1;
      if (ent.hp <= 0) {
        room.mission.entities.splice(idx, 1);
        broadcast(room, { type: "m_update", op: "remove", eid, by: meta.id });
      } else {
        broadcast(room, { type: "m_update", op: "hp", eid, hp: ent.hp, by: meta.id });
      }
      maybeAdvanceMission(room);
      return;
    }
    if (msg.type === "m_collect") {
      const eid = msg.eid | 0;
      if (!eid) return;
      const idx = room.mission.entities.findIndex(e => e.id === eid && e.type === "datnode");
      if (idx === -1) return;
      room.mission.entities.splice(idx, 1);
      broadcast(room, { type: "m_update", op: "remove", eid, by: meta.id });
      maybeAdvanceMission(room);
      return;
    }
  });
  ws.on("close", () => {
    room.clients.delete(ws);
    room.started = false;
    room.seed = 0;
    room.mission = { step: 0, phase: "rally", target: { x: 0, y: 0 }, entities: [], nextId: 1 };
    broadcast(room, { type: "lobby", room: roomId, users: lobbyState(room), started: room.started });
    if (room.clients.size === 0) rooms.delete(roomId);
  });
});
server.listen(PORT, "0.0.0.0", () => {
  console.log("WebSocket relay on port", PORT);
});
