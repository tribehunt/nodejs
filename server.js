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
    mapW: 80,
    mapH: 45
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
      const as = String(msg.as || "").slice(0, 24).trim();
      const from = as ? as : meta.id;
      const name = as ? as : (meta.name || meta.id);
      broadcast(room, { type: "chat", from, name, text, ts: Date.now() });
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
})}


function mulberry32(seed){
  let t = (seed>>>0);
  return function(){
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t>>>15), 1 | t);
    r ^= r + Math.imul(r ^ (r>>>7), 61 | r);
    return ((r ^ (r>>>14))>>>0) / 4294967296;
  };
}

function genDuneMap(w,h,seed){
  w = Math.max(24, Math.floor(w));
  h = Math.max(18, Math.floor(h));
  const rnd = mulberry32((seed>>>0) || 1);
  const g = new Array(h);
  for(let y=0;y<h;y++){
    let row="";
    for(let x=0;x<w;x++){
      const border = (x===0||y===0||x===w-1||y===h-1);
      row += border ? "1" : "0";
    }
    g[y]=row;
  }
  const duneCount = Math.max(6, Math.floor((w*h)/700));
  const bumps = Math.max(8, Math.floor((w*h)/500));
  function stampEllipse(cx,cy,rx,ry){
    const x0=Math.max(1, Math.floor(cx-rx));
    const x1=Math.min(w-2, Math.ceil(cx+rx));
    const y0=Math.max(1, Math.floor(cy-ry));
    const y1=Math.min(h-2, Math.ceil(cy+ry));
    for(let yy=y0;yy<=y1;yy++){
      let row=g[yy].split("");
      for(let xx=x0;xx<=x1;xx++){
        const nx=(xx-cx)/rx, ny=(yy-cy)/ry;
        if(nx*nx+ny*ny<=1) row[xx]="1";
      }
      g[yy]=row.join("");
    }
  }
  for(let i=0;i<duneCount;i++){
    const cx=2+Math.floor(rnd()*(w-4));
    const cy=2+Math.floor(rnd()*(h-4));
    const rx=3+Math.floor(rnd()*8);
    const ry=2+Math.floor(rnd()*6);
    stampEllipse(cx+0.5, cy+0.5, rx, ry);
  }
  for(let i=0;i<bumps;i++){
    const cx=2+Math.floor(rnd()*(w-4));
    const cy=2+Math.floor(rnd()*(h-4));
    const rx=1+Math.floor(rnd()*3);
    const ry=1+Math.floor(rnd()*3);
    stampEllipse(cx+0.5, cy+0.5, rx, ry);
  }
  function carve(cx,cy,r){
    for(let yy=Math.max(1,cy-r);yy<=Math.min(h-2,cy+r);yy++){
      let row=g[yy].split("");
      for(let xx=Math.max(1,cx-r);xx<=Math.min(w-2,cx+r);xx++){
        row[xx]="0";
      }
      g[yy]=row.join("");
    }
  }
  carve(4,4,4);
  carve(w-5,h-5,4);
  return g;
}

function isWall(room,x,y){
  const xi = Math.floor(x), yi = Math.floor(y);
  if(xi<0||yi<0||xi>=room.mapW||yi>=room.mapH) return true;
  const row = room.mapGrid && room.mapGrid[yi];
  return row ? row[xi]==="1" : true;
}

function findNearestEmpty(room,x,y){
  if(!isWall(room,x,y)) return {x,y};
  const bx=Math.floor(x)+0.5, by=Math.floor(y)+0.5;
  for(let r=1;r<Math.max(room.mapW,room.mapH);r++){
    for(let dy=-r;dy<=r;dy++){
      for(let dx=-r;dx<=r;dx++){
        if(Math.abs(dx)!==r && Math.abs(dy)!==r) continue;
        const nx=bx+dx, ny=by+dy;
        if(nx<1||ny<1||nx>=room.mapW-1||ny>=room.mapH-1) continue;
        if(!isWall(room,nx,ny)) return {x:nx,y:ny};
      }
    }
  }
  for(let yy=1;yy<room.mapH-1;yy++){
    for(let xx=1;xx<room.mapW-1;xx++){
      if(!isWall(room,xx+0.5,yy+0.5)) return {x:xx+0.5,y:yy+0.5};
    }
  }
  return {x:2.5,y:2.5};
}

function jimboSaye("http");
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
    mapW: 80,
    mapH: 45
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
      const as = String(msg.as || "").slice(0, 24).trim();
      const from = as ? as : meta.id;
      const name = as ? as : (meta.name || meta.id);
      broadcast(room, { type: "chat", from, name, text, ts: Date.now() });
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
