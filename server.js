// Minimal 2-player WebSocket relay.
// Deploy this on Railway (or run locally) and point clients to wss://.../ (already provided in Python client).
// Protocol: JSON messages with t=join/state/shot/scan/start/end. Server assigns id 0/1.

const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

let clients = []; // {ws,id}

function broadcastExcept(sender, obj) {
  const msg = JSON.stringify(obj);
  for (const c of clients) {
    if (c.ws !== sender && c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
  }
}

function prune() {
  clients = clients.filter(c => c.ws.readyState === WebSocket.OPEN);
}

wss.on("connection", (ws) => {
  prune();
  if (clients.length >= 2) {
    ws.send(JSON.stringify({ t: "full" }));
    ws.close();
    return;
  }

  const id = clients.length;
  clients.push({ ws, id });

  ws.send(JSON.stringify({ t: "welcome", id }));
  broadcastExcept(ws, { t: "peer", id });

  ws.on("message", (buf) => {
    let data;
    try { data = JSON.parse(buf.toString()); } catch { return; }
    if (!data || typeof data.t !== "string") return;

    // Relay everything (except join)
    if (data.t === "join") return;

    // attach sender id
    data.from = id;
    broadcastExcept(ws, data);
  });

  ws.on("close", () => {
    prune();
    // Notify remaining client
    broadcastExcept(ws, { t: "peer_left", id });
  });
});

console.log("WS relay listening on", PORT);
