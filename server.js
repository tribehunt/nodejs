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
 *   mapGrid: string[],
 *   mission: {
 *     step: number,
 *     phase: 'rally'|'destroy'|'retrieve',
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
      mapGrid: null,
      mission: { step: 0, phase: "rally", target: { x: 2.5, y: 2.5 }, entities: [], nextId: 1 }
    });
  }
  return rooms.get(roomId);
}
function broadcast(room, msgObj) {
  const data = JSON.stringify(msgObj);
  for (const ws of room.clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}
function sendOne(ws, msgObj){
  try{
    if(ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msgObj));
  }catch(e){}
}
function lobbyState(room) {
  const users = [];
  for (const meta of room.clients.values()) {
    users.push({ id: meta.id, name: meta.name, ready: meta.ready });
  }
  return users;
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
function isWall(room, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= room.mapW || yi >= room.mapH) return true;
  const row = room.mapGrid && room.mapGrid[yi];
  return row ? row[xi] === "1" : true;
}
function findNearestEmpty(room, x, y) {
  if (!isWall(room, x, y)) return { x, y };
  const bx = Math.floor(x) + 0.5, by = Math.floor(y) + 0.5;
  for (let r = 1; r < Math.max(room.mapW, room.mapH); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const nx = bx + dx, ny = by + dy;
        if (nx < 1 || ny < 1 || nx >= room.mapW - 1 || ny >= room.mapH - 1) continue;
        if (!isWall(room, nx, ny)) return { x: nx, y: ny };
      }
    }
  }
  for (let yy = 1; yy < room.mapH - 1; yy++) {
    for (let xx = 1; xx < room.mapW - 1; xx++) {
      if (!isWall(room, xx + 0.5, yy + 0.5)) return { x: xx + 0.5, y: yy + 0.5 };
    }
  }
  return { x: 2.5, y: 2.5 };
}
function jimboSay(room, text) {
  broadcast(room, { type: "chat", from: "JIMBO", name: "Jimbo", text: "@@JIMBO@@" + String(text || ""), ts: Date.now() });
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
function pickRallyTarget(room) {
  const w = room.mapW, h = room.mapH;
  const raw = {
    x: rndInt(2, Math.max(2, w - 3)) + 0.5,
    y: rndInt(2, Math.max(2, h - 3)) + 0.5
  };
  return findNearestEmpty(room, raw.x, raw.y);
}
function spawnLocalEntities(room, type, center, count) {
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
      if (!isWall(room, x, y)) break;
    }
    const snapped = findNearestEmpty(room, x, y);
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
function startMission(room) {
  room.mission.step = 0;
  room.mission.phase = "rally";
  room.mission.entities = [];
  room.mission.nextId = 1;
  const tgt = pickRallyTarget(room);
  room.mission.target = { x: Math.round(tgt.x * 1000) / 1000, y: Math.round(tgt.y * 1000) / 1000 };
  jimboSay(room, `AZHA / MIL-AI ONLINE. Tankers, rally at the marked nav blip. (X:${room.mission.target.x.toFixed(1)} Y:${room.mission.target.y.toFixed(1)})`);
  pushMission(room);
}
function ensureMission(room) {
  if (!room.started) return;
  if (!room.mission || !room.mission.target || !Number.isFinite(room.mission.target.x) || !Number.isFinite(room.mission.target.y)) {
    room.mission = { step: 0, phase: "rally", target: { x: 2.5, y: 2.5 }, entities: [], nextId: 1 };
  }
  if (!room.mapGrid) {
    room.mapGrid = genDuneMap(room.mapW || 80, room.mapH || 45, room.seed || 1);
  }
  if (room.mission.target.x === 0 && room.mission.target.y === 0) {
    startMission(room);
    return;
  }
  const sn = findNearestEmpty(room, room.mission.target.x, room.mission.target.y);
  room.mission.target = { x: Math.round(sn.x * 1000) / 1000, y: Math.round(sn.y * 1000) / 1000 };
  pushMission(room);
}
function within(a, b, r) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return (dx * dx + dy * dy) <= (r * r);
}
function maybeAdvanceMission(room) {
  if (!room.started) return;
  const metas = [...room.clients.values()].filter(m => m && m.state && m.alive !== false);
  if (metas.length < 1) return;
  ensureMission(room);
  const tgt = room.mission && room.mission.target ? room.mission.target : {x:2.5,y:2.5};
  if (room.mission.phase === "rally") {
    const allNear = metas.every(m => within(m.state, tgt, 3.0));
    if (allNear) {
      room.mission.phase = "destroy";
      room.mission.step = (room.mission.step|0)+1;
      const pick = (Math.random() < 0.60) ? "destroy" : "retrieve";
      room.mission.nextId = Math.max(room.mission.nextId || 1, 1);
      if (pick === "destroy") {
        const count = rndInt(2, 7);
        room.mission.entities = spawnLocalEntities(room, "enemy", tgt, count);
        jimboSay(room, `CONTACT. Hostile old-tech drones detected. Destroy all targets in the local grid. (${count} total)`);
      } else {
        const count = rndInt(1, 6);
        room.mission.entities = spawnLocalEntities(room, "datnode", tgt, count);
        jimboSay(room, `SIGNAL. Locate and retrieve the scattered datnodes. (${count} total)`);
      }
      pushMission(room);
    }
    return;
  }
  if (room.mission.phase === "destroy") {
    const enemiesLeft = (room.mission.entities||[]).some(e => e && e.type === "enemy");
    if (!enemiesLeft) {
      room.mission.phase = "retrieve";
      room.mission.step = (room.mission.step|0)+1;
      room.mission.entities = spawnLocalEntities(room, "datnode", tgt, rndInt(1, 6));
      jimboSay(room, "CLEAR. Recover any remaining datnodes and rally.");
      pushMission(room);
    }
    return;
  }
  if (room.mission.phase === "retrieve") {
    const datLeft = (room.mission.entities||[]).some(e => e && e.type === "datnode");
    if (!datLeft) {
      room.mission.phase = "rally";
      room.mission.step = (room.mission.step|0)+1;
      room.mission.entities = [];
      room.mission.target = pickRallyTarget(room);
      jimboSay(room, "MOVE. Rally on the next coordinate.");
      pushMission(room);
    }
    return;
  }
}
function maybeStart(room, roomId) {
  if (room.started) return;
  const metas = [...room.clients.values()];
  if (metas.length < 1) return;
  if (metas.length !== 2) return;
  if (!metas.every(m => m.ready)) return;
  room.started = true;
  room.seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  room.mapW = 80;
  room.mapH = 45;
  room.mapGrid = genDuneMap(room.mapW, room.mapH, room.seed);
  for (const m of metas) { m.alive = true; }
  broadcast(room, { type: "start", room: roomId, seed: room.seed, mapW: room.mapW, mapH: room.mapH });
  startMission(room);
}
wss.on("connection", (ws) => {
  let roomId = "global";
  let room = getRoom(roomId);
  let meta = {
    id: "U" + Math.floor(Math.random() * 1e9).toString(36),
    name: "",
    ready: false,
    state: null,
    alive: true
  };
  room.clients.set(ws, meta);
  function syncLobby() {
    broadcast(room, { type: "lobby", room: roomId, users: lobbyState(room), started: room.started });
  }
  syncLobby();
  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString("utf8")); } catch { return; }
    if (!msg || !msg.type) return;
    if (msg.type === "join") {
      const nextRoomId = safeRoomId(msg.room || "global");
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
      meta.state = null;
      meta.alive = true;
      room.clients.set(ws, meta);
      syncLobby();
      return;
    }
    if (msg.type === "ready") {
      meta.ready = !!msg.ready;
      if (room.started && meta.ready) {
        meta.alive = true;
        sendOne(ws, { type: "start", room: roomId, seed: room.seed, mapW: room.mapW, mapH: room.mapH });
        ensureMission(room);
      }
      syncLobby();
      maybeStart(room, roomId);
      return;
    }
    if (msg.type === "mission_request") {
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
    if (msg.type === "dead") {
      meta.alive = false;
      meta.ready = false;
      meta.state = null;
      syncLobby();
      sendOne(ws, { type: "dead_ack" });
      return;
    }
    if (!room.started) return;
    if (msg.type === "state") {
      if (msg.s && Number.isFinite(msg.s.x) && Number.isFinite(msg.s.y)) {
        meta.state = { x: Number(msg.s.x), y: Number(msg.s.y), ang: Number(msg.s.ang) };
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
    room.mapGrid = null;
    room.mission = { step: 0, phase: "rally", target: { x: 2.5, y: 2.5 }, entities: [], nextId: 1 };
    broadcast(room, { type: "lobby", room: roomId, users: lobbyState(room), started: room.started });
    if (room.clients.size === 0) rooms.delete(roomId);
  });
});
const AI_TICK_MS = 110;
const ENEMY_SPEED = 0.62;
const RAM_RANGE = 0.90;
const ZAP_RANGE = 6.60;
const ZAP_MIN = 2.30;
const RAM_DMG = 4;
const ZAP_DMG = 2;
function stepEnemy(room, ent, dt){
  if(!ent || ent.type!=="enemy") return;
  const metas = [...room.clients.values()].filter(m=>m && m.state && m.alive !== false);
  if(metas.length<1) return;
  let best=null, bd=1e9;
  for(const m of metas){
    const dx=m.state.x-ent.x, dy=m.state.y-ent.y;
    const d=Math.hypot(dx,dy);
    if(d<bd){bd=d; best=m;}
  }
  if(!best) return;
  const px=best.state.x, py=best.state.y, pid=best.id;
  const dx=px-ent.x, dy=py-ent.y;
  const dist=Math.hypot(dx,dy) || 0.00001;
  const now=Date.now();
  if(ent._cdRam==null) ent._cdRam=0;
  if(ent._cdZap==null) ent._cdZap=0;
  if(dist <= RAM_RANGE && now >= ent._cdRam){
    ent._cdRam = now + 650 + rndInt(0,250);
    broadcast(room, { type:"m_fx", kind:"ram", eid: ent.id, x: ent.x, y: ent.y, tx: px, ty: py, target: pid, dmg: RAM_DMG, ts: now });
  }else if(dist <= ZAP_RANGE && now >= ent._cdZap){
    const wantRam = (dist < 1.35) || (dist < 3.80 && Math.random() < 0.22);
    if(!wantRam){
      ent._cdZap = now + 820 + rndInt(0,350);
      broadcast(room, { type:"m_fx", kind:"zap", eid: ent.id, x: ent.x, y: ent.y, tx: px, ty: py, target: pid, dmg: ZAP_DMG, ts: now });
    }
  }
  let vx=0, vy=0;
  if(dist > 0.0001){
    let txDir = dx/dist, tyDir = dy/dist;
    if(dist < ZAP_MIN && (ent._cdZap && (ent._cdZap - now) > 250)){
      txDir = -txDir; tyDir = -tyDir;
    }else if(dist < ZAP_MIN && (now < (ent._cdZap||0))){
      txDir = -txDir; tyDir = -tyDir;
    }else if(dist < ZAP_MIN && Math.random() < 0.65){
      txDir = -txDir; tyDir = -tyDir;
    }
    if(dist < 1.10){ txDir = -txDir; tyDir = -tyDir; }
    vx = txDir * ENEMY_SPEED;
    vy = tyDir * ENEMY_SPEED;
  }
  const step = Math.min(0.25, dt) * 1.0;
  const nx = ent.x + vx * step;
  const ny = ent.y + vy * step;
  let moved=false;
  if(!isWall(room, nx, ent.y)){ ent.x = Math.round(nx*1000)/1000; moved=true; }
  if(!isWall(room, ent.x, ny)){ ent.y = Math.round(ny*1000)/1000; moved=true; }
  if(!moved){
    const jx = ent.x + (Math.random()*2-1)*0.25;
    const jy = ent.y + (Math.random()*2-1)*0.25;
    if(!isWall(room, jx, ent.y)) ent.x = Math.round(jx*1000)/1000;
    if(!isWall(room, ent.x, jy)) ent.y = Math.round(jy*1000)/1000;
  }
  if(ent._tpos==null) ent._tpos=0;
  ent._tpos += dt*1000;
  if(ent._tpos > 160){
    ent._tpos = 0;
    broadcast(room, { type:"m_update", op:"pos", eid: ent.id, x: ent.x, y: ent.y });
  }
}
function tickEnemyAI(){
  const dt = AI_TICK_MS/1000;
  for(const room of rooms.values()){
    if(!room || !room.started) continue;
    const ents = room.mission && Array.isArray(room.mission.entities) ? room.mission.entities : null;
    if(!ents || ents.length<1) continue;
    for(const ent of ents){
      if(ent && ent.type==="enemy") stepEnemy(room, ent, dt);
    }
  }
}
setInterval(tickEnemyAI, AI_TICK_MS);
server.listen(PORT, "0.0.0.0", () => {
  console.log("WebSocket relay on port", PORT);
});
