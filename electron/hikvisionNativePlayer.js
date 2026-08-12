"use strict";

const crypto = require("crypto");
const WebSocket = require("ws");

const SERVICE_URL = "ws://127.0.0.1:33686";
const REQUEST_TIMEOUT_MS = 8000;

let socket = null;
let uuid = "";
let ownerWindow = null;
let running = false;
let visible = false;
let currentRect = null;
let playInfo = {};
let generation = 0;
const pending = new Map();

function sanitizeRect(rect) {
  const scale = Math.max(0.5, Math.min(4, Number(rect?.scaleFactor) || 1));
  return {
    left: Math.round((Number(rect?.left) || 0) * scale),
    top: Math.round((Number(rect?.top) || 0) * scale),
    width: Math.max(1, Math.round((Number(rect?.width) || 1) * scale)),
    height: Math.max(1, Math.round((Number(rect?.height) || 1) * scale)),
  };
}

function geometryOf(rect) {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function settlePending(error) {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pending.clear();
}

function request(cmd, payload = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !uuid) {
      reject(new Error("Hikvision LocalService is not connected"));
      return;
    }
    const sequence = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(sequence);
      reject(new Error(`Hikvision LocalService timed out (${cmd})`));
    }, timeoutMs);
    pending.set(sequence, { resolve, reject, timer });
    socket.send(JSON.stringify({
      cmd,
      ...payload,
      sequence,
      uuid,
      timestamp: String(Date.now()),
    }));
  });
}

function connectService(expectedGeneration) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVICE_URL);
    socket = ws;
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      reject(new Error("Hikvision LocalService did not respond"));
    }, REQUEST_TIMEOUT_MS);
    const fail = (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    ws.once("error", fail);
    ws.once("open", () => {
      ws.send(JSON.stringify({ sequence: crypto.randomUUID(), cmd: "system.webconnect" }));
    });
    ws.on("message", (data) => {
      let message;
      try { message = JSON.parse(String(data || "")); } catch (_) { return; }
      if (message.sequence && pending.has(message.sequence)) {
        const entry = pending.get(message.sequence);
        pending.delete(message.sequence);
        clearTimeout(entry.timer);
        if (Number(message.errorCode || 0) === 0) entry.resolve(message);
        else entry.reject(new Error(`${message.cmd || "LocalService command"} failed (${message.errorCode})`));
        return;
      }
      if (!message.sequence && message.uuid && !uuid) {
        if (expectedGeneration !== generation) {
          try { ws.close(); } catch (_) {}
          fail(new Error("Hikvision playback start was superseded"));
          return;
        }
        uuid = String(message.uuid);
        clearTimeout(timer);
        resolve();
      }
    });
    ws.once("close", () => {
      settlePending(new Error("Hikvision LocalService connection closed"));
      if (socket === ws) {
        socket = null;
        uuid = "";
        running = false;
        visible = false;
      }
    });
  });
}

async function createNativeWindow(owner, rect) {
  const originalTitle = owner.getTitle();
  try {
    owner.setTitle(uuid);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await request("window.destroyWnd").catch(() => {});
    await request("window.createWnd", {
      rect: geometryOf(rect),
      className: "Chrome",
      embed: true,
    });
  } finally {
    if (!owner.isDestroyed()) owner.setTitle(originalTitle);
  }
  await request("video.arrangeWindow", { type: 1, custom: [] });
  await request("video.setWndRatioMode", { wndIndex: 0, mode: 0, allWnd: false }).catch(() => {});
}

async function start(owner, config, rect) {
  if (!owner || owner.isDestroyed()) throw new Error("Hikvision host window is unavailable");
  if (!config?.password) throw new Error("Hikvision DVR password is not configured");
  if (running) {
    ownerWindow = owner;
    await update(owner, rect);
    await show();
    return status();
  }
  await stop();
  const runGeneration = ++generation;
  ownerWindow = owner;
  currentRect = sanitizeRect(rect);
  await connectService(runGeneration);
  await createNativeWindow(owner, currentRect);

  const channel = Math.max(1, Math.min(32, Number(config.channel) || 1));
  const streamSuffix = config.stream === "sub" ? "02" : "01";
  const sourceId = Number(`${channel}${streamSuffix}`) - 1;
  const httpPort = Math.max(1, Math.min(65535, Number(config.httpPort) || 80));
  const auth = Buffer.from(`:::2:${config.username}:${config.password}`, "utf8").toString("base64");
  await request("video.startPlay", {
    url: `http://${config.host}:${httpPort}/SDK/play/${sourceId}/004`,
    token: "",
    auth,
    wndIndex: 0,
    startTime: "",
    stopTime: "",
  }, 12000);
  if (runGeneration !== generation) throw new Error("Hikvision playback start was superseded");
  running = true;
  visible = true;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  playInfo = await request("video.getPlayInfo", { wndIndex: 0 }).catch(() => ({}));
  return status();
}

async function update(owner, rect) {
  if (!running || !socket || socket.readyState !== WebSocket.OPEN) return status();
  if (owner && !owner.isDestroyed()) ownerWindow = owner;
  const nextRect = sanitizeRect(rect);
  const geometryUnchanged = currentRect &&
    currentRect.left === nextRect.left &&
    currentRect.top === nextRect.top &&
    currentRect.width === nextRect.width &&
    currentRect.height === nextRect.height;
  currentRect = nextRect;
  // LocalService applies geometry changes synchronously in its native decoder.
  // Re-sending the same rectangle on every dashboard tick can stall frames.
  if (!geometryUnchanged) {
    await request("window.setWndGeometry", { rect: geometryOf(currentRect) }).catch(() => {});
  }
  return status();
}

async function hide() {
  if (!running) return status();
  await request("window.hideWnd").catch(() => {});
  visible = false;
  return status();
}

async function show() {
  if (!running) return status();
  if (ownerWindow?.isDestroyed()) return status();
  if (currentRect) {
    await request("window.setWndGeometry", { rect: geometryOf(currentRect) }).catch(() => {});
  }
  await request("window.showWnd").catch(() => {});
  visible = true;
  return status();
}

async function stop() {
  generation += 1;
  if (socket && socket.readyState === WebSocket.OPEN && uuid) {
    await request("video.stop", { wndIndex: 0 }, 2500).catch(() => {});
    await request("window.destroyWnd", {}, 2500).catch(() => {});
  }
  const oldSocket = socket;
  socket = null;
  uuid = "";
  ownerWindow = null;
  running = false;
  visible = false;
  currentRect = null;
  playInfo = {};
  settlePending(new Error("Hikvision LocalService stopped"));
  try { oldSocket?.close(); } catch (_) {}
  return status();
}

function status() {
  const pictureSize = playInfo?.pictureSize || {};
  return {
    running,
    visible,
    connected: Boolean(socket && socket.readyState === WebSocket.OPEN && uuid),
    width: Number(pictureSize.width) || null,
    height: Number(pictureSize.height) || null,
  };
}

module.exports = { start, update, stop, hide, show, status };
