const http = require("http");
const WebSocket = require("ws");
const { execFileSync } = require("child_process");
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
    rooms.set(roomId, { clients: new Map(), started: false, seed: 0, map: null });
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

function generateMapFromPython(seed, w=64, h=64){
  const py = process.env.PYTHON || "python";
  try{
    const code = `
import json
import map
print(json.dumps(map.generate_map(${w}, ${h}, ${seed})))
`;
    const out = execFileSync(py, ["-c", code], { encoding:"utf8" });
    const data = JSON.parse(out.trim());
    // basic validation
    if(!data || !Array.isArray(data.grid) || !data.grid.length) throw new Error("bad map");
    return data;
  }catch(e){
    // fallback: simple open arena
    const W = (w|0) || 64, H = (h|0) || 64;
    const grid = [];
    for(let y=0;y<H;y++){
      let row="";
      for(let x=0;x<W;x++){
        const border = (x===0||y===0||x===W-1||y===H-1);
        row += border ? "1" : "0";
      }
      grid.push(row);
    }
    return { w:W, h:H, grid, spawns:[{x:3.5,y:3.5},{x:W-4.5,y:H-4.5}], seed:seed>>>0 };
  }
}

function maybeStart(room, roomId) {
  if (room.started) return;
  const metas = [...room.clients.values()];
  if (metas.length !== 2) return;
  if (!metas.every(m => m.ready)) return;
  room.started = true;
  room.seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    room.map = generateMapFromPython(room.seed, 64, 64);
  broadcast(room, {
    type: "start",
    room: roomId,
    seed: room.seed,
    map: room.map
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
    broadcast(room, { type: "lobby", room: roomId, users: lobbyState(room), started: room.started });
    if (room.clients.size === 0) rooms.delete(roomId);
  });
});
server.listen(PORT, "0.0.0.0", () => {
  console.log("WebSocket relay on port", PORT);
});
