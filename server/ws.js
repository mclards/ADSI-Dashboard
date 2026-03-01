"use strict";
// WebSocket client registry and broadcaster for live dashboard updates.

const clients = new Set();

function registerClient(ws) {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
}

function broadcastUpdate(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    try {
      if (ws.readyState === 1) ws.send(msg);
    } catch (err) {
      // Remove dead connections so they don't accumulate.
      clients.delete(ws);
      console.warn("[WS] send failed, client removed:", err.message);
    }
  }
}

module.exports = { clients, registerClient, broadcastUpdate };
