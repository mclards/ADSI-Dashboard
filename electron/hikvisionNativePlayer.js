"use strict";

const crypto = require("crypto");
const WebSocket = require("ws");

const SERVICE_URL = "ws://127.0.0.1:33686";
const REQUEST_TIMEOUT_MS = 8000;

let socket = null;
let uuid = "";
let ownerWindow = null;
let ownerWebContentsId = null;
let running = false;
let visible = false;
let currentRect = null;
let playInfo = {};
let generation = 0;
let operationChain = Promise.resolve();
let detachOwnerLifecycle = null;
const pending = new Map();

function ownerId(owner) {
  try { return owner && !owner.isDestroyed() ? owner.webContents.id : null; } catch (_) { return null; }
}

function sanitizeRect(rect, owner = ownerWindow) {
  const values = [rect?.left, rect?.top, rect?.width, rect?.height].map(Number);
  if (!values.every(Number.isFinite) || values[2] < 2 || values[3] < 2) {
    throw new Error("Invalid Hikvision native surface rectangle");
  }
  const scale = Math.max(0.5, Math.min(4, Number(rect?.scaleFactor) || 1));
  const content = owner && !owner.isDestroyed() ? owner.getContentSize() : [values[2], values[3]];
  const maxWidth = Math.max(2, Math.round((Number(content[0]) || values[2]) * scale));
  const maxHeight = Math.max(2, Math.round((Number(content[1]) || values[3]) * scale));
  const left = Math.max(0, Math.min(maxWidth - 2, Math.round(values[0] * scale)));
  const top = Math.max(0, Math.min(maxHeight - 2, Math.round(values[1] * scale)));
  return {
    left,
    top,
    width: Math.max(2, Math.min(maxWidth - left, Math.round(values[2] * scale))),
    height: Math.max(2, Math.min(maxHeight - top, Math.round(values[3] * scale))),
  };
}

function enqueue(operation) {
  const result = operationChain.then(operation, operation);
  operationChain = result.catch(() => {});
  return result;
}

function assertGeneration(expectedGeneration) {
  if (expectedGeneration !== generation) throw new Error("Hikvision playback start was superseded");
}

function assertOwner(owner) {
  const id = ownerId(owner);
  if (!id || id !== ownerWebContentsId) throw new Error("Hikvision native player is owned by another window");
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

function attachOwnerLifecycle(owner) {
  detachOwnerLifecycle?.();
  const id = ownerId(owner);
  const onGone = () => stopOwnedById(id).catch(() => {});
  const onNavigation = (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) onGone();
  };
  owner.once("closed", onGone);
  owner.webContents.once("destroyed", onGone);
  owner.webContents.once("render-process-gone", onGone);
  owner.webContents.on("did-start-navigation", onNavigation);
  owner.webContents.on("leave-html-full-screen", onGone);
  detachOwnerLifecycle = () => {
    try { owner.removeListener("closed", onGone); } catch (_) {}
    try { owner.webContents.removeListener("destroyed", onGone); } catch (_) {}
    try { owner.webContents.removeListener("render-process-gone", onGone); } catch (_) {}
    try { owner.webContents.removeListener("did-start-navigation", onNavigation); } catch (_) {}
    try { owner.webContents.removeListener("leave-html-full-screen", onGone); } catch (_) {}
    detachOwnerLifecycle = null;
  };
}

async function cleanupNative() {
  detachOwnerLifecycle?.();
  if (socket && socket.readyState === WebSocket.OPEN && uuid) {
    await request("video.stop", { wndIndex: 0 }, 2500).catch(() => {});
    await request("window.destroyWnd", {}, 2500).catch(() => {});
  }
  const oldSocket = socket;
  socket = null;
  uuid = "";
  ownerWindow = null;
  ownerWebContentsId = null;
  running = false;
  visible = false;
  currentRect = null;
  playInfo = {};
  settlePending(new Error("Hikvision LocalService stopped"));
  try { oldSocket?.close(); } catch (_) {}
  return status();
}

function start(owner, config, rect) {
  if (!owner || owner.isDestroyed()) return Promise.reject(new Error("Hikvision host window is unavailable"));
  if (!config?.password) return Promise.reject(new Error("Hikvision DVR password is not configured"));
  let sanitized;
  try { sanitized = sanitizeRect(rect, owner); } catch (err) { return Promise.reject(err); }
  const runGeneration = ++generation;
  const newOwnerId = ownerId(owner);
  return enqueue(async () => {
    assertGeneration(runGeneration);
    if (running && ownerWebContentsId === newOwnerId) {
      currentRect = sanitized;
      await updateCurrentRect();
      await showCurrent();
      return status();
    }
    await cleanupNative();
    assertGeneration(runGeneration);
    ownerWindow = owner;
    ownerWebContentsId = newOwnerId;
    currentRect = sanitized;
    attachOwnerLifecycle(owner);
    try {
      await connectService(runGeneration);
      assertGeneration(runGeneration);
      await createNativeWindow(owner, currentRect);
      assertGeneration(runGeneration);

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
      assertGeneration(runGeneration);
      running = true;
      visible = true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assertGeneration(runGeneration);
      playInfo = await request("video.getPlayInfo", { wndIndex: 0 }).catch(() => ({}));
      assertGeneration(runGeneration);
      return status();
    } catch (err) {
      await cleanupNative();
      throw err;
    }
  });
}

async function updateCurrentRect() {
  if (!running || !socket || socket.readyState !== WebSocket.OPEN) return status();
  await request("window.setWndGeometry", { rect: geometryOf(currentRect) }).catch(() => {});
  return status();
}

function update(owner, rect) {
  let nextRect;
  try {
    assertOwner(owner);
    nextRect = sanitizeRect(rect, owner);
  } catch (err) { return Promise.reject(err); }
  return enqueue(async () => {
    assertOwner(owner);
    const previous = currentRect;
    currentRect = nextRect;
    const unchanged = previous && previous.left === nextRect.left && previous.top === nextRect.top &&
      previous.width === nextRect.width && previous.height === nextRect.height;
    if (running && !unchanged) await request("window.setWndGeometry", { rect: geometryOf(currentRect) }).catch(() => {});
    return status();
  });
}

async function hideCurrent() {
  if (!running) return status();
  await request("window.hideWnd").catch(() => {});
  visible = false;
  return status();
}

function hide(owner) {
  try { assertOwner(owner); } catch (err) { return Promise.reject(err); }
  return enqueue(async () => { assertOwner(owner); return hideCurrent(); });
}

async function showCurrent() {
  if (!running) return status();
  if (ownerWindow?.isDestroyed()) return status();
  if (currentRect) {
    await request("window.setWndGeometry", { rect: geometryOf(currentRect) }).catch(() => {});
  }
  await request("window.showWnd").catch(() => {});
  visible = true;
  return status();
}

function show(owner) {
  try { assertOwner(owner); } catch (err) { return Promise.reject(err); }
  return enqueue(async () => { assertOwner(owner); return showCurrent(); });
}

function hideImmediately() {
  if (!socket || socket.readyState !== WebSocket.OPEN || !uuid) return;
  visible = false;
  request("window.hideWnd", {}, 1000).catch(() => {});
}

function stop(owner = null) {
  if (owner) {
    if (ownerWebContentsId == null) return Promise.resolve(status());
    try { assertOwner(owner); } catch (err) { return Promise.reject(err); }
  }
  generation += 1;
  hideImmediately();
  return enqueue(cleanupNative);
}

function stopOwnedById(id) {
  if (!id || id !== ownerWebContentsId) return Promise.resolve(status());
  generation += 1;
  hideImmediately();
  return enqueue(async () => {
    if (id !== ownerWebContentsId) return status();
    return cleanupNative();
  });
}

function status() {
  const pictureSize = playInfo?.pictureSize || {};
  return {
    running,
    visible,
    connected: Boolean(socket && socket.readyState === WebSocket.OPEN && uuid),
    ownerWebContentsId,
    width: Number(pictureSize.width) || null,
    height: Number(pictureSize.height) || null,
  };
}

module.exports = {
  start,
  update,
  stop,
  hide,
  show,
  status,
  __test: { sanitizeRect },
};
