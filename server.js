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
      room.mission.nextId = Math.max(room.mission.nextId || 1, 1);
      if (pick === "destroy") {
        const count = rndInt(2, 7); // 1d6+1
        room.mission.entities = spawnLocalEntities(room, "enemy", tgt, count);
        jimboSay(room, `CONTACT. Hostile old-tech drones detected. Destroy all targets in the local grid. (${count} total)`);
      } else {
        const count = rndInt(1, 6); // 1d6
        room.mission.entities = spawnLocalEntities(room, "datnode", tgt, count);
        jimboSay(room, `DATA SIGNATURES FOUND. Retrieve all datnodes in the local grid. (${count} total)`);
      }
      pushMission(room);
    }
    return;
  }
  if (room.mission.phase === "destroy" || room.mission.phase === "retrieve") {
    if (room.mission.entities.length === 0) {
      jimboSay(room, room.mission.phase === "destroy" ? `AREA SECURED. Stand by for next nav task.` : `DATA RECOVERED. Stand by for next nav task.`);
      room.mission.step++;
      room.mission.phase = "rally";
      room.mission.entities = [];
      room.mission.nextId = 1;
      const nt = pickRallyTarget(room);
      room.mission.target = { x: Math.round(nt.x * 1000) / 1000, y: Math.round(nt.y * 1000) / 1000 };
      jimboSay(room, `New nav blip uploaded. Rally at (X:${room.mission.target.x.toFixed(1)} Y:${room.mission.target.y.toFixed(1)}).`);
      pushMission(room);
    }
  }
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
  room.mapGrid = genDuneMap(room.mapW, room.mapH, room.seed);
  broadcast(room, { type: "start", room: roomId, seed: room.seed, mapW: room.mapW, mapH: room.mapH });
  startMission(room);
}

function hasLOS(room, ax, ay, bx, by) {
  let dx = bx - ax, dy = by - ay;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return true;
  dx /= dist; dy /= dist;
  const step = 0.12;
  let x = ax, y = ay;
  for (let t = 0; t < dist; t += step) {
    x += dx * step;
    y += dy * step;
    if (isWall(room, x, y)) return false;
  }
  return true;
}
function _nowMs(){ return Date.now(); }
function _enemyInit(ent){
  if (!ent) return;
  if (ent.ai) return;
  ent.ai = {
    mode: (Math.random() < 0.55) ? "aggr" : "skirm",
    nextAttack: 0,
    strafe: (Math.random() < 0.5) ? -1 : 1,
    nextRepath: 0,
    vx: 0, vy: 0
  };
  ent.maxhp = (ent.hp|0) || 2;
}
function _tryMove(room, ent, nx, ny){
  if (!isWall(room, nx, ny)) { ent.x = nx; ent.y = ny; return true; }
  if (!isWall(room, nx, ent.y)) { ent.x = nx; return true; }
  if (!isWall(room, ent.x, ny)) { ent.y = ny; return true; }
  return false;
}
function tickEnemies(room){
  if (!room || !room.started) return;
  if (!room.mission || room.mission.phase !== "destroy") return;
  if (!Array.isArray(room.mission.entities) || room.mission.entities.length === 0) return;

  const metas = [...room.clients.values()].filter(m => m && m.state && Number.isFinite(m.state.x) && Number.isFinite(m.state.y));
  if (metas.length === 0) return;
  const ps = metas.map(m => ({ id: m.id, x: m.state.x, y: m.state.y }));

  const w = room.mapW, h = room.mapH;
  const t = _nowMs();
  let moved = false;

  for (const ent of room.mission.entities) {
    if (!ent || ent.type !== "enemy") continue;
    _enemyInit(ent);

    let target = ps[0];
    let bestD2 = 1e18;
    for (const p of ps) {
      const dx = p.x - ent.x, dy = p.y - ent.y;
      const d2 = dx*dx + dy*dy;
      if (d2 < bestD2) { bestD2 = d2; target = p; }
    }
    const dx = target.x - ent.x, dy = target.y - ent.y;
    const dist = Math.hypot(dx, dy) + 1e-6;

    const hp = (ent.hp|0) || 1;
    const maxhp = (ent.maxhp|0) || Math.max(2, hp);
    const low = hp <= Math.max(1, Math.floor(maxhp*0.34));

    const canSee = dist <= 9.5 && hasLOS(room, ent.x, ent.y, target.x, target.y);
    const meleeRange = 0.90;
    const rangedMin = 2.0;
    const rangedMax = 7.0;

    let wantFlee = false;
    if (low && dist < 4.5) wantFlee = true;
    if (ent.ai.mode === "skirm" && dist < 2.25 && Math.random() < 0.25) wantFlee = true;

    // attack
    if (t >= ent.ai.nextAttack) {
      if (dist <= meleeRange) {
        ent.ai.nextAttack = t + 750 + ((Math.random()*250)|0);
        broadcast(room, { type:"hurt", to: target.id, kind:"melee", eid: ent.id, amt: 1, ts: t });
      } else if (canSee && dist >= rangedMin && dist <= rangedMax) {
        ent.ai.nextAttack = t + 1100 + ((Math.random()*450)|0);
        broadcast(room, { type:"hurt", to: target.id, kind:"zap", eid: ent.id, amt: 1, ts: t, x: ent.x, y: ent.y });
      }
    }

    // movement
    const baseSpd = 0.060; // per tick (~20hz)
    let spd = baseSpd;
    if (dist > 8) spd *= 1.15;
    if (low) spd *= 1.05;

    let ux = dx / dist, uy = dy / dist;
    if (wantFlee) { ux = -ux; uy = -uy; }

    // skirmish strafe a bit
    let sx = 0, sy = 0;
    if (!wantFlee && ent.ai.mode === "skirm" && canSee && dist < 6.0) {
      sx = -uy * ent.ai.strafe;
      sy = ux * ent.ai.strafe;
    }
    let mx = ux + sx*0.55;
    let my = uy + sy*0.55;
    const ml = Math.hypot(mx, my) + 1e-6;
    mx /= ml; my /= ml;

    const nx = clamp(ent.x + mx*spd, 1.5, w-2.5);
    const ny = clamp(ent.y + my*spd, 1.5, h-2.5);

    const ox = ent.x, oy = ent.y;
    if (_tryMove(room, ent, nx, ny)) {
      if (Math.abs(ent.x-ox) > 1e-4 || Math.abs(ent.y-oy) > 1e-4) moved = true;
    } else if (Math.random() < 0.15) {
      ent.ai.strafe *= -1;
    }
  }

  if (moved) {
    broadcast(room, { type:"m_update", op:"pos", ents: room.mission.entities.filter(e => e && e.type==="enemy").map(e => ({id:e.id,x:e.x,y:e.y})) });
  }
}
// 20Hz AI tick
setInterval(() => {
  for (const room of rooms.values()) {
    try { tickEnemies(room); } catch(e) {}
  }
}, 50);

wss.on("connection", (ws) => {
  let roomId = "global";
  let room = getRoom(roomId);
  let meta = {
    id: "U" + Math.floor(Math.random() * 1e9).toString(36),
    name: "",
    ready: false,
    state: null
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
server.listen(PORT, "0.0.0.0", () => {
  console.log("WebSocket relay on port", PORT);
});
