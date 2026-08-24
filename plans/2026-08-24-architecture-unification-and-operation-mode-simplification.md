# Implementation Plan â€” Architecture Unification & Operation Mode Simplification

**Date:** 2026-08-24  
**Status:** PROPOSED (Awaiting Operator Approval)  
**Goal:** Unify the ADSI Dashboard into a clean, secure **Client-Server Architecture**. Implement **Secure Device Identification (`deviceId`)**, **Server-Side Personalization Profiles**, **Strict Single-Writer Inverter Control Arbitration**, and **Server Single Source of Truth**.

---

## User Review Required

> [!IMPORTANT]
> ### ðŸ” Secure Device Identification & Personalization Registry (NEW SECURITY LAYER)
> Every connecting device (browser, phone, tablet, Electron app) will receive a unique cryptographic **`deviceId`** stored in persistent storage:
> 1. **Server-Side Profile & Preferences:**
>    - The server maintains a `client_devices` table in `adsi.db`.
>    - UI personalizations (Dark/Light theme, active layout, chart color schemes, favorite inverter views, audio alarm toggles) are mapped to that `device_id` and saved directly on the server.
>    - When a device connects, the server recognizes its `device_id` and restores its personalized profile.
> 2. **Complete Inverter Control Audit Accountability:**
>    - Every write action (setpoint change, inverter stop/start, plant cap schedule) logs the exact `device_id`, custom friendly name (e.g. `"Engr. M Laptop"`), and IP address in `audit_log`.
> 3. **Device Authorization & Control Whitelisting:**
>    - Devices can be named and granted roles (`Viewer`, `Operator`, `Admin`) by the administrator on the server.

> [!IMPORTANT]
> ### ðŸ—„ï¸ Server as the Single Source of Truth (DATA & CONFIG PRESERVATION)
> - All master configurations (`ipconfig.json`, settings table, `credentials.json`, `go2rtc.yaml`), database telemetry (`adsi.db`, multi-year `archive/*.db`), AI models (`.joblib`, `ml_train_state.json`), weather CSVs, and audit logs reside **exclusively on the server** (`/var/lib/adsi-dashboard/` or Windows server directory).
> - Connected clients are lightweight and stateless â€” they never maintain divergent local DB fragments.

> [!IMPORTANT]
> ### ðŸ›¡ï¸ Inverter Control Safety & Single-Writer Arbitration
> - **Multi-Client Read:** Unlimited simultaneous viewers for telemetry, charts, and camera feeds.
> - **Single-Writer Control Lease:** Only one authorized operator can issue Inverter commands at any given time (60-second sliding lease).
> - **Conflict Rejection (HTTP 423):** Competing write commands from another device while a control action is active are rejected with a visual lock banner: `ðŸ”’ Controlled by <DeviceName> (<IP>) â€” Busy`.

---

## 1. Unified System Architecture

```
 â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
 â”‚                           ADSI Server Backend                           â”‚
 â”‚               (Linux Server / Dedicated Gateway Appliance)              â”‚
 â”‚                                                                         â”‚
 â”‚   - Express API & WebSockets Gateway (Port 3500)                        â”‚
 â”‚   - Inverter Modbus Engine (Port 9100)                                  â”‚
 â”‚   - Solar AI Day-Ahead Engine (Python venv)                             â”‚
 â”‚   - go2rtc RTSP/WebRTC Streaming (Ports 1984, 8555)                     â”‚
 â”‚   - Authoritative Master Storage (/var/lib/adsi-dashboard/)             â”‚
 â”‚                                                                         â”‚
 â”‚   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ SECURITY CORE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”   â”‚
 â”‚   â”‚ â€¢ Device Registry (`client_devices` table in adsi.db)           â”‚   â”‚
 â”‚   â”‚ â€¢ Per-Device Personalization (Themes, Layouts, Chart Views)     â”‚   â”‚
 â”‚   â”‚ â€¢ Single-Writer Control Arbiter & Modbus Write Queue Lock       â”‚   â”‚
 â”‚   â”‚ â€¢ Audit Logger (Records Device ID, Device Name, IP, Action)     â”‚   â”‚
 â”‚   â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜   â”‚
 â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                                      â”‚
            â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
            â”‚ Telemetry Streams (All) â”‚ Control Actions (1-At-A-Time)
            â–¼                         â–¼                         â–¼
   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”      â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”      â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
   â”‚   Web Browser    â”‚      â”‚   Electron App   â”‚      â”‚   Mobile / PWA   â”‚
   â”‚  "Office Chrome" â”‚      â”‚ "Engr. M Laptop" â”‚      â”‚  "Plant Tablet"  â”‚
   â”‚ Device: 4f8a-... â”‚      â”‚ Device: 9b2c-... â”‚      â”‚ Device: e31d-... â”‚
   â”‚ Theme: Dark Navy â”‚      â”‚ (Active Control) â”‚      â”‚ Theme: High Con. â”‚
   â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜      â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜      â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

---

## 2. Phase-by-Phase Implementation

### Phase 1: Device Identification & Personalization Registry
- **Server Device Registry (`server/deviceRegistry.js`):**
  - Create table `client_devices (device_id TEXT PRIMARY KEY, device_name TEXT, ip_address TEXT, role TEXT, preferences_json TEXT, last_seen_ts INTEGER)`.
  - Provide endpoints:
    - `POST /api/device/register` â€” Register/handshake device, return saved preferences.
    - `POST /api/device/preferences` â€” Save personalized theme, layout zoom, active tabs to server.
    - `GET /api/devices` â€” View connected devices list (Admin view).
- **Client Device Identity (`public/js/app.js`):**
  - Generate UUID `deviceId` in `localStorage` on first visit.
  - Prompt user on first run for a friendly name (e.g. `"Engr. M Laptop"` or `"Control Room Tablet"`).
  - Include `X-Device-Id` and `X-Device-Name` headers in all HTTP API and WebSocket handshakes.
  - Automatically sync theme (Dark/Light/Cyberpunk) and UI custom preferences with the server.

### Phase 2: Inverter Control Arbitration & Audit Enforcement
- **Server Control Arbiter (`server/controlArbiter.js`):**
  - Manage a single-writer control lease (60s sliding expiration).
  - Gate all setpoints and commands (`/api/write`, `/api/plant-cap/apply`, `/api/compliance/run/start`, `/api/plant-cap/schedule/save`).
  - Broadcast active lock state via WebSockets (`{ type: "control_lock", lockedByDevice: "Engr. M Laptop", ip: "100.114.7.50", expiresTs: 1771829000 }`).
  - Log every single control action to `audit_log` with device identity.
- **Client Lock UI:**
  - Display non-intrusive lock badge on APC and Plant Cap tabs when another device holds the control lease.

### Phase 3: Frontend Simplification & Mode Elimination (`public/js/app.js`)
- **Rip Out Legacy Modes:** Strip `isClientModeActive()`, `getActiveOperationModeClient()`, `getSelectedOperationModeClient()`, and `normalizeOperationModeValue()`.
- **Remove Fake Status Banners:** Remove `State.remoteHealth`, `normalizeRemoteHealthClient()`, and stale-data warnings.
- **Universal Feature Access:** Ensure all forms, buttons, and tools (Day-Ahead generation, QA scoring, DLS upload, grid compliance tests, exports) execute standard API calls directly to the server.
- **Bust Cache:** Increment CSS and JS query version in `public/index.html` (Golden Rule 3).

### Phase 4: Server Decoupling & Proxy Removal (`server/index.js`)
- **Eliminate Reverse-Proxying:** Remove `proxyToRemote()`, `proxyWebSocketToRemote()`, and `shouldProxyApiPath()`.
- **Remove Remote Polling Bridges:** Remove `_startRemotePollingBridge()`, `_stopRemotePollingBridge()`, `remoteBridgeState`, and `remoteChatBridgeState`.
- **Clean Route Handlers:** Convert all routes to direct local handlers on the server without `if (isRemoteMode())` conditionals.
- **Clean Subsystem Modules:** Strip `isRemoteMode` from `server/calibrationRoutes.js`, `server/alarmsDiagnostic.js`, and `server/cloudBackup.js`.

### Phase 5: Settings & Electron Client Streamlining
- **Settings Schema Clean-up:** Deprecate and remove obsolete settings (`operationMode`, `remoteGatewayUrl`, `remoteApiToken`, `remoteViewerMode`).
- **Global Config Modal:** Remove "Operation Mode" toggle from `global-config.html`.
- **Electron Native Client:** Provide a clean server connection dialog (`http://<server-ip>:3500`) with connection test and persistent `deviceId` handoff.

---

## 3. Verification Plan

### Automated & Security Tests
1. **Device Identity Handshake Test:** Connect new client â†’ verify `device_id` is registered in `client_devices` table and default preferences are returned.
2. **Preference Persistence Test:** Change theme from Dark to Cyberpunk on Device A â†’ restart browser â†’ verify server restores Cyberpunk theme for Device A.
3. **Control Arbitration & Audit Test:**
   - Device A commands inverter %P setpoint â†’ verify lease is claimed.
   - Device B sends competing setpoint â†’ verify HTTP 423 rejection.
   - Inspect `audit_log` table â†’ verify entry records Device A's friendly name, UUID, and IP.

### Manual Verification
1. **Dual Device Verification:** Open dashboard on Laptop and Phone simultaneously:
   - Verify both have independent personalized themes (e.g. Laptop in Dark, Phone in Solar Amber).
   - Verify live telemetry and cameras stream in real time on both.
2. **Desktop & Mobile UI Invariants:** Verify 1440px desktop view and 360px mobile view remain 100% compliant with Golden Rules 1, 2, 4, 5.

