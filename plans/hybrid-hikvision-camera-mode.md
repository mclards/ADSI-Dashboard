# Hybrid Hikvision Camera Mode

## Implementation Status

Implemented on 2026-08-13 with three safety refinements discovered during the code audit:

- Compact card playback uses the internal `browser` route, which is the browser-safe FFmpeg-to-H.264 HLS feed. The existing `hls` route is raw DVR codec pass-through and would not provide the compatibility described by this plan.
- Native playback uses an Analytics-style Electron window with the standard Windows frame, title bar, and minimize/maximize/restore/close controls. The native surface fills its entire content area, tracks window resizing, and supports a compact 480×300 minimum for multi-window monitor layouts.
- Native-viewer starts are generation-cancelled and the Electron native bridge is serialized, rectangle-validated, and scoped to its owning BrowserWindow. Rapid closes, grid rebuilds, navigation, owner shutdown, and competing windows cannot revive or steal a stale LocalService surface.
- Remote operation is gateway-relay-first but no longer camera-route-locked. The viewer validates gateway HLS and automatically uses a directly reachable DVR over the workstation's local LAN or approved Tailscale subnet route when the relay is missing, unhealthy, or invalid. This fallback affects camera delivery only; gateway authority for inverter data is unchanged. The settings modal visibly separates Gateway-host and Remote-viewer behavior.
- Complete Remote mode is explicit: when neither the gateway relay nor the workstation-to-DVR SDK/RTSP route exists, route-dependent actions are blocked and the card reports the actual topology requirement. The viewer does not launch a local transcoder against an unreachable DVR.

The recommended `localservice` setting now means hybrid HLS/native presentation. Explicit `compatible` snapshot and direct `hls` diagnostic selections keep their original HTML fullscreen behavior and do not open the native viewer. Per operator follow-up decisions, the dashboard card exists only on the Inverters page and exposes only Settings plus Native Viewer controls; navigating elsewhere hides it and stops HLS, and the redundant HLS popout was removed entirely.

Provide a "Best of Both Worlds" hybrid playback mode for the Hikvision camera. In the Inverters grid it uses browser-safe **HLS** (just like Tapo). The native-viewer action opens a dedicated, framed Electron window for the **Native Hardware Overlay**, providing zero-latency, high-quality playback with the same familiar window behavior as the Analytics popout.

## User Review Required

> [!IMPORTANT]
> The Tapo approach (HLS) introduces 2–3 seconds of latency and slight quality degradation due to FFmpeg transcoding. You will notice this when viewing the card in the dashboard grid. The pristine, zero-latency feed is available in the separate native viewer window.

## Proposed Changes

### 1. Card Interface Updates ✅
#### [MODIFY] [app.js](file:///d:/ADSI-Dashboard/public/js/app.js)
- Update `buildHikvisionCard()` to include Settings and Native Viewer controls while the compact card uses standard HTML5 video.
- Add double-click listeners to open the native viewer in recommended hybrid mode.

### 2. Player Logic Updates ✅
#### [MODIFY] [app.js](file:///d:/ADSI-Dashboard/public/js/app.js)
- Keep recommended `localservice` mode on `effectiveMode = "browser"` in the Inverters card.
- Open a dedicated framed, resizable BrowserWindow for native LocalService playback, pause the requesting HLS player while it is open, and resume HLS after it closes.
- Fill the whole window content area with the native rectangle. Use the operating system title bar for window management; show an HTML **Retry** action only when LocalService fails before creating the native surface.
- Preserve ordinary DOM fullscreen for explicit `compatible` and direct `hls` diagnostic modes.

### 3. Page Routing (Inverters Page Only) ✅
#### [MODIFY] [app.js](file:///d:/ADSI-Dashboard/public/js/app.js)
- Keep the card attached to the Inverters grid. On other pages it disappears with the inactive page and its HLS player stops; returning to Inverters reconnects it. Native playback remains isolated to its viewer window.

## Verification Plan

### Manual Verification
1. Open the dashboard. The Hikvision card should load using HLS (indicated by the `HLS` codec badge) and can be dragged or floated across pages without crashing.
2. Click the Native Viewer button on the card (or double click it).
3. Confirm an Analytics-style window opens with standard Windows controls and native video fills its content area.
4. Resize, maximize, restore, and minimize the viewer. Close it with the title-bar **X** and confirm the requesting HLS view resumes.
