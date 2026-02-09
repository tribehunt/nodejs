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
 *   clients: Map(ws -> { id, name, ready }),
 *   started: bool,
 *   seed: number
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
    rooms.set(roomId, { clients: new Map(), started: false, seed: 0, map: null, pending: false, generator: null });
  }
  return rooms.get(roomId);
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
function maybeStart(room, roomId, triggerWs) {
  if (room.started || room.pending) return;
  const metas = [...room.clients.values()];
  if (metas.length !== 2) return;
  if (!metas.every(m => m.ready)) return;

  // When the 2nd player clicks ready (the trigger), THEY generate the match map on their machine.
  room.pending = true;
  room.map = null;
  room.generator = triggerWs;

  try {
    if (triggerWs && triggerWs.readyState === WebSocket.OPEN) {
      triggerWs.send(JSON.stringify({ type: "gen_map", room: roomId }));
    }
  } catch {}
}
wss.on("connection", (ws) => {
  let roomId = "public";
  let room = getRoom(roomId);
  let meta = { id: "U" + Math.floor(Math.random() * 1e9).toString(36), name: "", ready: false };
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
      maybeStart(room, roomId, ws);
      return;
    }
    if (msg.type === "map_data") {
      // Only accept from the designated generator while pending
      if (!room.pending || room.started) return;
      if (room.generator && room.generator !== ws) return;
      const md = msg.map;
      if (!md || !Array.isArray(md.grid) || !md.grid.length || !md.w || !md.h) return;
      room.map = { w: md.w|0, h: md.h|0, grid: md.grid, spawns: md.spawns||null, seed: md.seed>>>0 };
      room.started = true;
      room.pending = false;
      broadcast(room, { type:"start", room: roomId, map: room.map });
      return;
    }
    if (msg.type === "chat") {
      const text = String(msg.text || "").slice(0, 200).trim();
      if (!text) return;
      broadcast(room, { type: "chat", from: meta.id, name: meta.name || meta.id, text, ts: Date.now() });
      return;
    }
    if (!room.started) return;
    if (msg.type === "state" || msg.type === "shoot" || msg.type === "event") {
      msg.from = meta.id;
      broadcast(room, msg);
    }
  });
  ws.on("close", () => {
    room.clients.delete(ws);
    room.started = false;
    room.seed = 0;
    room.map = null;
    room.pending = false;
    room.generator = null;
    broadcast(room, { type: "lobby", room: roomId, users: lobbyState(room), started: room.started });
    if (room.clients.size === 0) rooms.delete(roomId);
  });
});
server.listen(PORT, "0.0.0.0", () => {
  console.log("WebSocket relay on port", PORT);
});
