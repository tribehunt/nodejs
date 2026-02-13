const WebSocket = require("ws");
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });
const rooms = new Map(); // room -> { clients: Map(id, ws), ready: Map(id,bool), seed, difficulty }
function rid() {
  return Math.random().toString(36).slice(2, 10);
}
function roomGet(name) {
  if (!rooms.has(name)) {
    rooms.set(name, { clients: new Map(), ready: new Map(), seed: null, difficulty: 1, missionActive: false });
  }
  return rooms.get(name);
}
function broadcast(room, obj, exceptId=null) {
  const msg = JSON.stringify(obj);
  for (const [id, ws] of room.clients) {
    if (exceptId && id === exceptId) continue;
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}
function roomState(room) {
  const r = {};
  for (const [id, val] of room.ready) r[id] = !!val;
  const players = [...room.clients.keys()].sort();
  return { t: "room_state", seed: room.seed, difficulty: room.difficulty, ready: r, missionActive: room.missionActive, players };
}
wss.on("connection", (ws) => {
  const id = rid();
  ws._id = id;
  ws._room = "public";
  ws.send(JSON.stringify({ t: "welcome", id, room: ws._room }));
  ws.on("message", (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    const t = m.t;
    if (t === "hello") {
      const roomName = (m.room || "public").toString().slice(0, 32);
      const old = roomGet(ws._room);
      old.clients.delete(id);
      old.ready.delete(id);
      ws._room = roomName;
      const room = roomGet(roomName);
      room.clients.set(id, ws);
      if (!room.ready.has(id)) room.ready.set(id, false);
      ws.send(JSON.stringify({ t: "welcome", id, room: ws._room }));
      ws.send(JSON.stringify(roomState(room)));
      broadcast(room, { t:"msg", s:`${id} joined.` }, id);
      return;
    }
    const room = roomGet(ws._room);
    if (t === "scan") {
      room.seed = m.seed ?? room.seed;
      room.difficulty = m.difficulty ?? room.difficulty;
      room.missionActive = false;
      for (const k of room.ready.keys()) room.ready.set(k, false);
      broadcast(room, { t:"scan", seed: room.seed, difficulty: room.difficulty });
      broadcast(room, roomState(room));
      return;
    }
    if (t === "ready") {
      room.ready.set(id, !!m.ready);
      broadcast(room, roomState(room));
      const ids = [...room.clients.keys()].sort();
      if (ids.length >= 2 && room.seed != null) {
        const r0 = !!room.ready.get(ids[0]);
        const r1 = !!room.ready.get(ids[1]);
        if (r0 && r1 && !room.missionActive) {
          room.missionActive = true;
          broadcast(room, { t:"start", seed: room.seed, difficulty: room.difficulty, players: ids });
          broadcast(room, roomState(room));
        }
      }
      return;
    }
    if (t === "state") {
      broadcast(room, { t:"state", id, x:m.x, y:m.y, a:m.a, hp:m.hp }, id);
      return;
    }
    if (t === "shot") {
      broadcast(room, { t:"shot", id, x:m.x, y:m.y, vx:m.vx, vy:m.vy, dmg:m.dmg }, id);
      return;
    }
    if (t === "enemies") {
      // Host-authoritative enemy/tear snapshots.
      broadcast(room, { t:"enemies", id, en:m.en, te:m.te, stl:m.stl, swc:m.swc, ssd:m.ssd, mt:m.mt }, id);
      return;
    }
    if (t === "msg") {
      const s = (m.s ?? "").toString().slice(0, 240);
      if (s.length) broadcast(room, { t:"msg", s }, id);
      return;
    }
  });
  ws.on("close", () => {
    const room = roomGet(ws._room);
    room.clients.delete(id);
    room.ready.delete(id);
    broadcast(room, { t:"leave", id });
    if (room.clients.size === 0) rooms.delete(ws._room);
  });
});
console.log(`ECF relay server listening on :${PORT}`);
