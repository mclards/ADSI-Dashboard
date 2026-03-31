# Camera Viewer Dashboard Integration Prompt

## Overview
Build a live IP camera viewer component to be integrated into an existing web dashboard.

---

## Stream Information

| Setting | Value |
|---|---|
| Stream Server | go2rtc over Tailscale VPN |
| go2rtc Tailscale IP | `100.93.11.9` |
| go2rtc API Port | `1984` |
| Camera Local IP | `192.168.4.211` |
| RTSP Port | `554` |
| Stream Key | `tapo_cam` |

### URL Formats
- **HLS:** `http://{go2rtc_ip}:{go2rtc_port}/api/stream.m3u8?src={stream_key}`
- **WebRTC:** `http://{go2rtc_ip}:{go2rtc_port}/api/webrtc?src={stream_key}`
- **Direct RTSP:** `rtsp://{username}:{password}@{camera_ip}:{rtsp_port}/stream1`

---

## Tech Stack

- **Frontend:** HTML, CSS, JavaScript (no framework)
- **HLS Playback:** hls.js via CDN
- **Styling:** Pure CSS only — no external CSS frameworks

---

## Requirements

### 1. Camera Viewer Card
- Continuous live video stream filling the card
- **Top-left overlay:** Camera name label (e.g. `Tapo C110 - Live`)
- **Top-right overlay:** Blinking red dot live indicator when stream is active
- **Bottom controls bar overlay** on the video:
  - ⚙️ Settings icon — opens settings modal
  - 🔇/🔊 Mute/unmute toggle button
  - ⛶ Fullscreen button
- **Loading indicator** overlay while buffering
- **Error message** overlay with Retry button if stream fails
- **Auto-reconnect** every 5 seconds if stream drops
- Responsive — works on both desktop and mobile

---

### 2. Settings Modal
> Opens when the ⚙️ gear icon is clicked on the viewer

- Overlays the viewer with a dark semi-transparent backdrop
- Close button (✕) at top right of modal
- Title: **"Camera Settings"**

#### Input Fields:
| Field | Type | Default |
|---|---|---|
| Stream Mode | Selector: `go2rtc (HLS)` / `go2rtc (WebRTC)` / `Direct RTSP` | `go2rtc (HLS)` |
| go2rtc Tailscale IP | Text input | `100.93.11.9` |
| go2rtc API Port | Number input | `1984` |
| Stream Key/Name | Text input | `tapo_cam` |
| Camera IP Address | Text input | `192.168.4.211` |
| RTSP Port | Number input | `554` |
| RTSP Stream Path | Selector: `stream1` / `stream2` | `stream1` |
| Username | Text input | `Adsicamera` |
| Password | Masked input with 👁 show/hide toggle | — |

#### Modal Buttons:
- **"Apply & Connect"** — saves settings to localStorage and reconnects stream
- **"Reset to Default"** — restores all default values

#### RTSP Warning:
> If `Direct RTSP` mode is selected, display this warning inside the modal:
> ⚠️ Browsers don't support RTSP natively. Use `go2rtc (HLS)` or `go2rtc (WebRTC)` instead.

---

### 3. Settings Persistence
- Save all settings to **localStorage** when Apply is clicked
- Automatically load saved settings on page load

---

### 4. UI/UX
- All controls and labels overlaid directly on the video (not outside the card)
- Smooth open/close animation on modal
- Single file HTML with embedded CSS and JS
- **Do not apply any custom theming** — the component will inherit the existing dashboard theme

---

## Additional Context
- go2rtc is always running on a separate laptop connected via Tailscale
- Plain HTML/CSS/JS only — no React, Vue, or other frameworks
- All credentials and IPs must be configurable via the modal — **nothing hardcoded**
- Include hls.js via CDN

---
