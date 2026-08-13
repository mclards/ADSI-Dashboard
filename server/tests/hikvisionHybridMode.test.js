"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const nativePlayer = require("../../electron/hikvisionNativePlayer");
const hikvisionManager = require("../hikvisionManager");

const ROOT = path.join(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

try {
  const app = read("public/js/app.js");
  const html = read("public/index.html");
  const main = read("electron/main.js");
  const server = read("server/index.js");
  const manager = read("server/hikvisionManager.js");
  const preload = read("electron/preload.js");
  const viewerHtml = read("public/hikvision-native-viewer.html");
  const viewerJs = read("public/js/hikvision-native-viewer.js");
  const viewerCss = read("public/css/hikvision-native-viewer.css");

  assert(app.includes('this.requestedMode === "localservice"\n        ? "browser"'), "recommended dashboard mode must remain browser HLS");
  assert(app.includes("this.connectGeneration"), "hybrid transitions need stale-connect cancellation");
  assert(app.includes("hikvisionUiAbortController?.abort()"), "grid rebuilds must dispose prior Hikvision UI listeners");
  assert(app.includes("openHikvisionNativeViewer(theme)"), "dashboard must open the dedicated Electron native viewer");
  assert(app.includes('requestedMode === "localservice" && window.electronAPI?.openHikvisionNativeViewer'), "only recommended hybrid mode should open the native viewer");
  assert(app.includes("_pausedForNativeViewer"), "requesting HLS player must pause while the native viewer owns the DVR");
  assert(!app.includes("setHikvisionFloating"), "Hikvision must not float over other dashboard pages");
  assert(app.includes("if (!hikvisionPageActive && hikvisionPlayer)"), "Hikvision playback must stop away from its owning page");
  assert(app.includes("hikvisionCard.hidden = !hikvisionPageActive"), "Hikvision card must be explicitly hidden off-page");
  assert(app.includes('id="btnHikvisionSettings"'));
  assert(!app.includes('id="btnHikvisionPopout"'), "obsolete Hikvision HLS popout button must be removed");
  assert(app.includes('id="btnHikvisionNativeViewer"'), "native viewer control must remain available");
  assert(!html.includes('id="page-hikvision-camera"'), "obsolete Hikvision HLS popout page must be removed");
  assert(!main.includes('"hikvision-camera": "ADSI \\u2013 Hikvision Viewer"'), "obsolete Hikvision HLS popout route must be removed");
  assert(main.includes("function openHikvisionNativeViewer"));
  assert(main.includes('title: "ADSI \\u2013 Hikvision Native Viewer"'));
  assert(main.includes("frame: true"), "native viewer must use standard Windows window controls");
  assert(main.includes("minWidth: 900") && main.includes("minHeight: 600"), "native viewer must resize like dashboard popouts");
  assert(main.includes('hikvision-native-viewer.html?theme='));
  assert(main.includes("await hikvisionNativePlayer.stop(win)"), "native viewer must stop native playback before destruction");
  assert(main.includes("hikvisionNativePlayer.stop(getTrustedHikvisionOwner(event))"), "native stop IPC must be owner scoped");
  assert(!preload.includes("onHikvisionPopoutOpened") && !preload.includes("onHikvisionPopoutClosed"));
  assert(preload.includes("openHikvisionNativeViewer") && preload.includes("onHikvisionNativeViewerClosed"));
  assert(viewerHtml.includes('id="nativeSurface"') && !viewerHtml.includes('id="nativeExit"'));
  assert(viewerJs.includes("requestAnimationFrame(() => requestAnimationFrame"), "native viewer must wait for settled geometry");
  assert(!viewerJs.includes("closeHikvisionNativeFullscreen"));
  assert(viewerCss.includes(".native-surface") && viewerCss.includes("height: 100%"), "native surface must fill the framed window content area");
  assert(server.includes("function proxyHikvisionMediaToRemote"), "remote Hikvision media needs a binary streaming proxy");
  assert(server.includes('if (isRemoteMode()) return proxyHikvisionMediaToRemote(req, res);'), "remote snapshots and HLS must remain gateway-only");
  assert(server.includes('compactPath: remote ? "gateway-relay" : "local-hls"'), "remote compact playback must remain gateway-relayed");
  assert(server.includes('nativePath: remote ? "tailscale-direct" : "local-direct"'), "delivery metadata must identify the direct native path");
  assert(server.includes('app.post("/api/hikvision/route-status"'), "viewer-local DVR route diagnostics must remain available");
  assert(server.includes('recommendedRoute: net.isIP(cfg.host) === 4 ? `${cfg.host}/32`'), "route guidance must recommend only the DVR host, not the plant subnet");
  assert(html.includes('id="hikHttpPort"'), "native SDK HTTP port must be configurable alongside RTSP");
  assert(html.includes('id="hikRoutePanel"') && html.includes('id="btnHikRouteCheck"'), "settings must expose secure path diagnostics");
  assert(app.includes('api("/api/hikvision/route-status", "POST", configFromForm())'), "settings route check must use the current unsaved DVR target");
  assert(app.includes("Gateway HLS relay") && app.includes("Direct DVR over Tailscale"), "remote path labels must be explicit");
  assert(server.includes("isMissingRemoteHikvisionRoute"), "old gateway HTML 404 responses must be detected and contained");
  assert(app.includes("invalid HLS manifest") && app.includes("#EXTM3U"), "the renderer must validate gateway playlists before Hls.js parses them");
  assert(app.includes("requiresGatewayUpdate"), "missing relay endpoints must not enter an automatic retry loop");
  assert(manager.includes('"/api/hikvision/hls/hls/"'), "go2rtc child playlist and segment paths must stay inside the authenticated Hikvision relay");
  const rewrittenPlaylist = hikvisionManager.__test.rewriteHikvisionPlaylist(
    "#EXTM3U\n/api/hls/playlist.m3u8?id=abc\n/api/hls/segment.ts?id=abc",
  );
  assert(rewrittenPlaylist.includes("/api/hikvision/hls/hls/playlist.m3u8?id=abc"));
  assert(rewrittenPlaylist.includes("/api/hikvision/hls/hls/segment.ts?id=abc"));
  assert(!rewrittenPlaylist.includes("\n/api/hls/"), "no child request may escape the Hikvision relay namespace");

  const fakeOwner = {
    isDestroyed: () => false,
    getContentSize: () => [800, 600],
  };
  const rect = nativePlayer.__test.sanitizeRect(
    { left: 10, top: 20, width: 400, height: 300, scaleFactor: 1.5 },
    fakeOwner,
  );
  assert.deepStrictEqual(rect, { left: 15, top: 30, width: 600, height: 450 });
  const clamped = nativePlayer.__test.sanitizeRect(
    { left: -100, top: -20, width: 5000, height: 5000, scaleFactor: 1 },
    fakeOwner,
  );
  assert.deepStrictEqual(clamped, { left: 0, top: 0, width: 800, height: 600 });
  for (const invalid of [null, {}, { left: 0, top: 0, width: 0, height: 20 }, { left: 0, top: 0, width: Infinity, height: 20 }]) {
    assert.throws(() => nativePlayer.__test.sanitizeRect(invalid, fakeOwner), /Invalid Hikvision native surface rectangle/);
  }

  console.log("hikvisionHybridMode.test.js: PASS");
} catch (err) {
  console.error("hikvisionHybridMode.test.js: FAIL", err?.stack || err);
  process.exit(1);
}
