# Camera Viewer & go2rtc Integration

## Overview

The ADSI Dashboard includes a live IP camera viewer component integrated into the main dashboard as a draggable camera card. It supports three streaming modes via an embedded go2rtc process manager and direct FFmpeg transcoding fallback.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  ADSI Dashboard (Electron)                          │
│                                                     │
│  resources/backend/go2rtc/                          │
│    ├── go2rtc.exe     (bundled binary)              │
│    └── go2rtc.yaml    (localhost-only config)       │
│                                                     │
│  server/go2rtcManager.js  (process lifecycle)       │
│    ├── start(autoRestart)                           │
│    ├── stop()                                       │
│    ├── getStatus() → { running, pid, ... }          │
│    └── health check loop (5 s interval)             │
│                                                     │
│  server/index.js                                    │
│    ├── GET  /api/streaming/go2rtc-status             │
│    ├── POST /api/streaming/go2rtc/start              │
│    ├── POST /api/streaming/go2rtc/stop               │
│    └── _beginShutdown() → go2rtcManager.stop()       │
│                                                     │
│  public/js/app.js                                   │
│    ├── CameraPlayer class (HLS/WebRTC/FFmpeg)       │
│    ├── initCameraPlayer() — modal + player wiring   │
│    ├── buildCameraCard() — DOM construction          │
│    └── go2rtc* functions — service polling/control   │
│                                                     │
│  ProgramData/InverterDashboard/go2rtc/              │
│    └── go2rtc.yaml  (user override, optional)       │
└─────────────────────────────────────────────────────┘
```

---

## Stream Modes

| Mode | Backend | Protocol | Description |
|------|---------|----------|-------------|
| **HLS** | go2rtc | HTTP Live Streaming | Best compatibility. go2rtc converts RTSP to HLS. Slight delay (~2-5 s). Uses hls.js in browser. |
| **WebRTC** | go2rtc | WebRTC peer-to-peer | Ultra-low latency (<1 s). Requires STUN/TURN for NAT traversal. go2rtc acts as SFU. |
| **FFmpeg** | Server | MPEG1/TS over WebSocket | Direct RTSP transcode on the Express server. Requires FFmpeg installed. Uses jsmpeg decoder in browser. |

### URL Formats

- **HLS:** `http://{go2rtcIp}:{go2rtcPort}/api/stream.m3u8?src={streamKey}`
- **WebRTC:** `http://{go2rtcIp}:{go2rtcPort}/api/webrtc?src={streamKey}`
- **Direct RTSP (FFmpeg input):** `rtsp://{username}:{password}@{cameraIp}:{rtspPort}/{streamPath}`

---

## Default Configuration

### Camera Settings Defaults

| Setting | Default Value | localStorage Key |
|---------|---------------|------------------|
| Stream Mode | `hls` | `cam_mode` |
| go2rtc IP | `100.93.11.9` | `cam_go2rtc_ip` |
| go2rtc API Port | `1984` | `cam_go2rtc_port` |
| Stream Key | `tapo_cam` | `cam_stream_key` |
| Camera IP | `192.168.4.211` | `cam_ip` |
| RTSP Port | `554` | `cam_rtsp_port` |
| Stream Path | `stream1` | `cam_stream_path` |
| Username | `Adsicamera` | `cam_user` |
| Password | *(empty)* | `cam_pass` |

### go2rtc Service Defaults

| Setting | Default Value | Storage |
|---------|---------------|---------|
| Auto-start on boot | `0` (disabled) | Server setting `go2rtcAutoStart` |
| API bind address | `127.0.0.1:1984` | `go2rtc.yaml` |
| WebRTC bind address | `127.0.0.1:8555` | `go2rtc.yaml` |
| Max crash restarts | 3 | Hardcoded in `go2rtcManager.js` |
| Health check interval | 5 seconds | Hardcoded in `go2rtcManager.js` |
| Health check timeout | 2 seconds | Hardcoded in `go2rtcManager.js` |

### go2rtc.yaml (Bundled Default)

```yaml
streams:
  tapo_cam:
    - rtsp://Adsicamera:sacups2026@192.168.4.211:554/stream1

api:
  listen: "127.0.0.1:1984"
  origin: "*"

webrtc:
  listen: "127.0.0.1:8555"
  ice_servers:
    - urls:
        - stun:stun.l.google.com:19302
```

---

## Camera Settings Modal

The camera settings modal is a **page-level modal** (not card-scoped) centered on the main screen. It consolidates all camera-related settings in one place.

### Opening the Modal

Click the **gear icon** (⚙️) on the camera card's bottom control bar.

### Modal Structure

1. **Stream Mode Selector** — Three visual mode cards (HLS, WebRTC, FFmpeg) with icons and descriptions. Selecting a mode dynamically shows/hides relevant input sections.

2. **go2rtc Connection** (visible in HLS/WebRTC modes)
   - Tailscale / Server IP
   - API Port
   - Stream Key

3. **RTSP Connection** (visible in FFmpeg mode)
   - Camera IP
   - RTSP Port
   - Stream Path (dropdown: `stream1` High Quality / `stream2` Low Quality)
   - Username
   - Password (with show/hide toggle)
   - FFmpeg warning banner

4. **go2rtc Service** (visible in HLS/WebRTC modes, gateway mode only)
   - Status grid: Status, PID, Crashes, Health (last check time)
   - Auto-start on server boot checkbox
   - Start / Stop buttons
   - Status message area
   - Polls `/api/streaming/go2rtc-status` every 5 seconds while modal is open

5. **Actions**
   - **Reset Defaults** — restores all fields to factory defaults
   - **Apply & Connect** — saves settings to localStorage, persists auto-start to server, closes modal, and reconnects the stream

### Visibility Rules

| Condition | go2rtc Connection | RTSP Connection | go2rtc Service |
|-----------|-------------------|-----------------|----------------|
| HLS mode | Visible | Hidden | Visible |
| WebRTC mode | Visible | Hidden | Visible |
| FFmpeg mode | Hidden | Visible | Hidden |
| Remote operation mode | — | — | Hidden |

---

## Camera Card

The camera card is a draggable card that participates in the inverter grid layout. It renders in all layout modes (2-col through 5-col grids).

### Card Structure

- **Video viewport** — fills the card body
- **Top-left overlay** — Camera name label (e.g., "Tapo C110 - Live")
- **Top-right overlay** — Blinking red dot live indicator when stream is active
- **Bottom controls bar**:
  - ⚙️ Settings — opens the camera settings modal
  - 🔇/🔊 Mute/unmute toggle
  - ⛶ Fullscreen toggle
- **Loading spinner** — shown while buffering
- **Error overlay** — displayed with "Retry" button when stream fails
- **Auto-reconnect** — every 5 seconds on stream drop

### Card Sizing

Camera cards share the same grid sizing rules as inverter cards. In layouts 2-5, the camera card respects `grid-template-columns` and `min-height` constraints to maintain visual uniformity with inverter cards.

---

## go2rtc Service Management

### Process Lifecycle

go2rtc runs as a child process of the Express server, managed by `server/go2rtcManager.js`.

| State | Description |
|-------|-------------|
| `stopped` | Not running (initial state) |
| `starting` | Spawn initiated, waiting for health check |
| `running` | Process alive, health checks passing |
| `error` | Crashed 3+ times, auto-restart disabled |

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/streaming/go2rtc-status` | GET | Returns `{ running, status, pid, crashCount, lastHealthTs }` |
| `/api/streaming/go2rtc/start` | POST | Starts go2rtc. Returns 403 in remote mode. |
| `/api/streaming/go2rtc/stop` | POST | Stops go2rtc gracefully (SIGTERM → SIGKILL after 3 s). |

### Path Resolution

| Context | Binary Path |
|---------|-------------|
| Packaged (Electron) | `{resourcesPath}/backend/go2rtc/go2rtc.exe` |
| Development | `{__dirname}/go2rtc/go2rtc.exe` |

### Config Resolution

| Priority | Path |
|----------|------|
| User override | `C:\ProgramData\InverterDashboard\go2rtc\go2rtc.yaml` |
| Bundled default | `server/go2rtc/go2rtc.yaml` |

### Auto-Start

When server setting `go2rtcAutoStart` is `"1"` and the dashboard is in gateway mode, go2rtc starts automatically during Express server boot. The auto-start runs after the HTTP server is listening.

### Auto-Restart on Crash

When go2rtc is started (manually or auto-start), crash recovery is enabled:
- On unexpected process exit, the manager waits briefly then respawns
- After 3 consecutive crashes, auto-restart is disabled and status becomes `error`
- Manual stop always disables auto-restart (intentional shutdown)

### Shutdown

`_beginShutdown()` in `server/index.js` calls `go2rtcManager.stop()` during graceful shutdown. This ensures go2rtc is cleaned up before the Electron app exits, during update installs, or on server stop.

---

## Security

- **Localhost-only binding**: go2rtc API (`127.0.0.1:1984`) and WebRTC (`127.0.0.1:8555`) are bound to localhost only. Not accessible from external networks.
- **Gateway-mode only**: go2rtc start is blocked with HTTP 403 in remote mode. The service section is hidden in the UI when operating in remote mode.
- **STUN server**: Uses Google's public STUN server (`stun:stun.l.google.com:19302`) for WebRTC ICE negotiation.

---

## Packaging

The `go2rtc` directory is included in Electron builds via `extraResources` in `package.json`:

```json
{
  "from": "server/go2rtc",
  "to": "backend/go2rtc"
}
```

This places the binary and config at `resources/backend/go2rtc/` in the installed application.

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Frontend | Vanilla HTML/CSS/JS (no framework) |
| HLS playback | hls.js via CDN |
| WebRTC | Native browser WebRTC API via go2rtc signaling |
| FFmpeg transcode | Server-side FFmpeg → MPEG1/TS → WebSocket → jsmpeg decoder |
| Process manager | Node.js `child_process.spawn` in `go2rtcManager.js` |
| Settings persistence | `localStorage` (camera fields), server settings (auto-start) |

---

## Troubleshooting

| Issue | Cause | Resolution |
|-------|-------|------------|
| "Stream failed" error | go2rtc not running or wrong IP/port | Open camera settings, verify go2rtc IP and port, click Start in service section |
| go2rtc won't start | Port 1984 or 8555 in use | Stop conflicting process, or edit `go2rtc.yaml` ports |
| WebRTC no video | NAT/firewall blocking | Ensure STUN server is reachable; consider configuring TURN |
| FFmpeg mode no video | FFmpeg not installed on server | Install FFmpeg and ensure it's on PATH |
| Service section hidden | Remote mode active | Switch to Gateway mode in Settings > Connectivity |
| Auto-restart stopped | 3+ crashes | Check go2rtc logs, fix RTSP source, then manually restart |
