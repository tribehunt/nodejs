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
    if (type === "enemy") {
      // enemy kind/variant/seed for client rendering + balance
      const roll = Math.random();
      if (roll < 0.14) {
        ent.kind = "gorgek";
        ent.variant = 7;
        ent.maxhp = 10;
        ent.hp = 10;
      } else {
        ent.kind = "unclean";
        ent.variant = (Math.random()*7)|0;
        ent.maxhp = 3;
        ent.hp = 3;
      }
      ent.seed = (Math.random()*4294967296)>>>0;
    }
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
        if (msg.name != null) meta.name = String(msg.name || meta.name || "").slice(0, 24);
        meta._dirty = true;
        maybeAdvanceMission(room);
      }
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
const TICK_MS = 50;       // 20 Hz player state relay
const ENEMY_MS = 100;     // 10 Hz enemy sim
let _accEnemy = 0;
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room || !room.started) continue;
    const metas = [...room.clients.entries()];
    if (metas.length === 0) continue;
    for (const [wsA, metaA] of metas) {
      if (!metaA || !metaA.state || !metaA._dirty) continue;
      metaA._dirty = false;
      const msg = { type: "state", from: metaA.id, name: metaA.name || metaA.id, s: metaA.state };
      for (const [wsB] of metas) {
        try { if (wsB && wsB.readyState === 1) wsB.send(JSON.stringify(msg)); } catch {}
      }
    }
    _accEnemy += TICK_MS;
    if (_accEnemy >= ENEMY_MS) {
      _accEnemy = 0;
      if (room.mission && room.mission.phase === "destroy" && Array.isArray(room.mission.entities) && room.mission.entities.length) {
        const players = metas.map(([,m]) => (m && m.state) ? { x: m.state.x, y: m.state.y } : null).filter(Boolean);
        if (players.length) {
          let moved = null;
          for (const e of room.mission.entities) {
            if (!e || e.type !== "enemy") continue;
            const ex = e.x, ey = e.y;
            let best = players[0], bestD2 = 1e9;
            for (const p of players) {
              const dx = p.x - ex, dy = p.y - ey;
              const d2 = dx*dx + dy*dy;
              if (d2 < bestD2) { bestD2 = d2; best = p; }
            }
            const hp = (e.hp|0) || 2;
            const flee = hp <= 1 && bestD2 < 9.0; // low hp + close -> flee
            const speed = flee ? 0.020 : 0.028;
            let vx = best.x - ex, vy = best.y - ey;
            const mag = Math.hypot(vx, vy) || 1;
            vx /= mag; vy /= mag;
            if (flee) { vx = -vx; vy = -vy; }
            let nx = ex + vx*speed;
            let ny = ey + vy*speed;
            if (isWall(room, nx, ny)) {
              if (!isWall(room, nx, ey)) { ny = ey; }
              else if (!isWall(room, ex, ny)) { nx = ex; }
              else { nx = ex; ny = ey; }
            }
            nx = clamp(nx, 1.25, (room.mapW||80) - 2.25);
            ny = clamp(ny, 1.25, (room.mapH||45) - 2.25);
            const dxm = nx - ex, dym = ny - ey;
            if ((dxm*dxm + dym*dym) > 1e-6) {
              e.x = Math.round(nx * 1000) / 1000;
              e.y = Math.round(ny * 1000) / 1000;
              (moved || (moved = [])).push({ id: e.id|0, x: e.x, y: e.y, hp: e.hp|0 });
            }
          }
          if (moved && moved.length) {
            broadcast(room, { type: "m_update", op: "pos", list: moved });
          }
        }
      }
    }
  }
}, TICK_MS);
server.listen(PORT, "0.0.0.0", () => {
  console.log("WebSocket relay on port", PORT);
});
