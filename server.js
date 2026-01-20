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
    rooms.set(roomId, { clients: new Map(), started: false, seed: 0 });
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

function maybeStart(room, roomId) {
  if (room.started) return;

  const metas = [...room.clients.values()];
  if (metas.length !== 2) return;
  if (!metas.every(m => m.ready)) return;

  room.started = true;
  room.seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;

  broadcast(room, {
    type: "start",
    room: roomId,
    seed: room.seed,
    mapW: 64,
    mapH: 64
  });
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
      // join { room, name, id? }
      const nextRoomId = safeRoomId(msg.room || "public");
      const nextRoom = getRoom(nextRoomId);

      // enforce 2 players max
      if (nextRoom.clients.size >= 2 && !nextRoom.clients.has(ws)) {
        ws.send(JSON.stringify({ type: "error", message: "Room is full (2 players max)." }));
        return;
      }

      // move rooms
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
      // ready { ready: bool }
      meta.ready = !!msg.ready;
      syncLobby();
      maybeStart(room, roomId);
      return;
    }

    if (msg.type === "chat") {
      const text = String(msg.text || "").slice(0, 200).trim();
      if (!text) return;
      broadcast(room, { type: "chat", from: meta.id, name: meta.name || meta.id, text, ts: Date.now() });
      return;
    }

    // Relay gameplay messages only after start
    if (!room.started) return;

    // Basic relay: input, shoot, event, etc.
    // Add server-side validation later.
    if (msg.type === "state" || msg.type === "shoot" || msg.type === "event") {
      msg.from = meta.id;
      broadcast(room, msg);
    }
  });

  ws.on("close", () => {
    room.clients.delete(ws);
    // reset if someone leaves
    room.started = false;
    room.seed = 0;
    broadcast(room, { type: "lobby", room: roomId, users: lobbyState(room), started: room.started });
    if (room.clients.size === 0) rooms.delete(roomId);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("WebSocket relay on port", PORT);
});
