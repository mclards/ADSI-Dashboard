"use strict";

(() => {
  const api = window.electronAPI;
  const surface = document.getElementById("nativeSurface");
  const placeholder = document.getElementById("nativePlaceholder");
  const placeholderText = document.getElementById("nativePlaceholderText");
  const retryButton = document.getElementById("nativeRetry");

  let nativeRunning = false;
  let updateQueued = false;

  const requestedTheme = new URLSearchParams(window.location.search).get("theme") || "dark";
  if (["dark", "light", "classic", "midnight"].includes(requestedTheme)) {
    document.body.dataset.theme = requestedTheme;
  }

  function nativeRect() {
    const rect = surface?.getBoundingClientRect();
    if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) return null;
    if (rect.width < 2 || rect.height < 2) return null;
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      scaleFactor: window.devicePixelRatio || 1,
    };
  }

  function showError(message) {
    nativeRunning = false;
    placeholder.classList.add("error");
    placeholder.style.display = "flex";
    placeholderText.textContent = message || "Hikvision LocalService could not start.";
    retryButton.hidden = false;
  }

  async function nextLayoutFrame() {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  async function startNative() {
    retryButton.hidden = true;
    placeholder.classList.remove("error");
    placeholder.style.display = "flex";
    placeholderText.textContent = "Connecting to Hikvision LocalService…";
    if (!api?.hikvisionNativeStart) {
      showError("Native playback requires the ADSI Electron desktop app.");
      return;
    }
    await nextLayoutFrame();
    const rect = nativeRect();
    if (!rect) {
      showError("The native video surface is not ready. Select Retry.");
      return;
    }
    try {
      await api.hikvisionNativeStart(rect);
      nativeRunning = true;
      placeholder.style.display = "none";
    } catch (err) {
      showError(err?.message || "Hikvision native playback failed.");
    }
  }

  async function updateGeometry() {
    updateQueued = false;
    if (!nativeRunning || document.hidden) return;
    const rect = nativeRect();
    if (!rect) return;
    try { await api.hikvisionNativeUpdate(rect); } catch (_) {}
  }

  function queueGeometryUpdate() {
    if (updateQueued) return;
    updateQueued = true;
    requestAnimationFrame(updateGeometry);
  }

  retryButton.addEventListener("click", async () => {
    retryButton.disabled = true;
    try { await api?.hikvisionNativeStop?.(); } catch (_) {}
    retryButton.disabled = false;
    startNative();
  });
  window.addEventListener("resize", queueGeometryUpdate);
  document.addEventListener("visibilitychange", async () => {
    if (!nativeRunning) return;
    try {
      if (document.hidden) await api.hikvisionNativeHide();
      else {
        const rect = nativeRect();
        if (rect) await api.hikvisionNativeUpdate(rect);
        await api.hikvisionNativeShow();
      }
    } catch (_) {}
  });
  window.addEventListener("beforeunload", () => {
    if (nativeRunning) api?.hikvisionNativeStop?.().catch(() => {});
  });

  if (typeof ResizeObserver !== "undefined" && surface) {
    new ResizeObserver(queueGeometryUpdate).observe(surface);
  }

  startNative();
})();
