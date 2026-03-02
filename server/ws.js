"use strict";
// WebSocket client registry and broadcaster for live dashboard updates.

const clients = new Set();
const wsStats = {
  startedAt: Date.now(),
  totalConnections: 0,
  sentFrames: 0,
  droppedFramesBackpressure: 0,
  sendErrors: 0,
  lastPayloadBytes: 0,
  lastSentTs: 0,
  lastDropTs: 0,
};

function registerClient(ws) {
  clients.add(ws);
  wsStats.totalConnections += 1;
  ws.on("close", () => clients.delete(ws));
}

function broadcastUpdate(payload) {
  const msg = JSON.stringify(payload);
  wsStats.lastPayloadBytes = Buffer.byteLength(msg, "utf8");
  for (const ws of clients) {
    try {
      if (ws.readyState !== 1) continue;
      // Drop frame for congested sockets to keep realtime path responsive.
      if (Number(ws.bufferedAmount || 0) > 1024 * 1024) {
        wsStats.droppedFramesBackpressure += 1;
        wsStats.lastDropTs = Date.now();
        continue;
      }
      ws.send(msg);
      wsStats.sentFrames += 1;
      wsStats.lastSentTs = Date.now();
    } catch (err) {
      // Remove dead connections so they don't accumulate.
      clients.delete(ws);
      wsStats.sendErrors += 1;
      console.warn("[WS] send failed, client removed:", err.message);
    }
  }
}

function getStats() {
  return {
    ...wsStats,
    connectedClients: clients.size,
  };
}

module.exports = { clients, registerClient, broadcastUpdate, getStats };
