# Implementation Plan â€” Architecture Unification & Operation Mode Simplification

**Date:** 2026-08-24  
**Status:** PROPOSED (Awaiting Operator Approval)  
**Goal:** Unify the ADSI Dashboard into a clean, standard **Client-Server Architecture**. Eliminate the legacy "Gateway vs Remote" dual-mode state machines, remove thousands of lines of reverse-proxying and polling bridge boilerplate, unlock all features universally across all clients, and streamline settings and configuration.

---

## User Review Required

> [!IMPORTANT]
> This plan will permanently retire the legacy "Gateway vs Remote (Client)" dual-mode design and unify the dashboard into a standard **Client-Server Architecture**:
> - **The Backend Server** (Linux or Windows) runs the microservices (Express, Modbus, AI forecasting, go2rtc, SQLite DB).
> - **The Frontend Dashboard** (Web Browser, Phone/Tablet PWA, or Electron Desktop) connects directly to `http://<server-ip>:3500` as a universal client.
> - **All features** (Day-Ahead generation, QA scoring, DLS upload, compliance tests, setpoint dispatch, exports) will be 100% available from any client without artificial "Unavailable in Remote mode" restrictions.
> - Desktop UI layouts, Modbus engine capabilities, AI forecasting models, and multi-year databases will remain 100% preserved.

---

## 1. Problem & Architectural Rationale

### Current State (The "Mess" & Technical Debt)
The codebase currently attempts to support a hybrid "Gateway Mode" vs "Remote (Gateway-Linked) Mode" where:
1. **Server-on-Server Redundancy:** A remote laptop running the Electron app starts a full local Express server on port 3500 just to proxy requests over HTTP to the actual Linux server on port 3500.
2. **Dual-DB & Sync Complexities:** The local client tries to cache and snapshot tables from the gateway, creating stale-data warnings, replication collisions, and sync state machines (`State.remoteHealth`, `remoteBridgeState`).
3. **Artificial Feature Lockouts:** Features like the Day-Ahead Generator, DLS uploads, Grid Compliance runs, and QA backfill were riddled with `if (isRemoteMode()) return 403` or client-side `isClientModeActive()` disables.
4. **Reverse-Proxy Boilerplate:** Over 250 instances of `if (isRemoteMode()) return proxyToRemote(req, res)` and manual route routing filters (`shouldProxyApiPath()`) scattered across `server/index.js` and `server/calibrationRoutes.js`.
5. **Operator Confusion:** Users had to navigate to Settings / Global Config to toggle "Gateway" vs "Remote" modes and configure tokens rather than simply connecting to a server IP/URL.

### Target State (Unified Client-Server Architecture)
```
 â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
 â”‚                     ADSI Server Backend                     â”‚
 â”‚          (Linux Server / Dedicated Gateway / Local)         â”‚
 â”‚   - Express API & WebSockets Gateway (Port 3500)            â”‚
 â”‚   - Inverter Modbus Engine (Port 9100)                      â”‚
 â”‚   - Solar AI Day-Ahead Engine (Python venv)                 â”‚
 â”‚   - go2rtc RTSP/WebRTC Streaming (Ports 1984, 8555)         â”‚
 â”‚   - Single Authoritative SQLite Database & Archives         â”‚
 â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                                â”‚ REST APIs & WebSockets
       â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
       â–¼                        â–¼                        â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”         â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”         â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚ Web Browsers â”‚         â”‚ Electron App â”‚         â”‚ Mobile / PWA â”‚
â”‚(Chrome/Edge) â”‚         â”‚(Remote Clientâ”‚         â”‚(Phones/Tabs) â”‚
â”‚  on Any PC   â”‚         â”‚ or Standalone)â”‚        â”‚  on Network  â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜         â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜         â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

- **The Server is purely the Server:** Runs the 4 core microservices. All endpoints are local to the server. Zero proxying code required.
- **The Client is purely the Client:** A universal, responsive Single Page Application (SPA). It connects directly to the server via HTTP and WebSockets.
- **100% Feature Availability Everywhere:** Clicking "Generate Forecast", "Run QA Backfill", "Upload DLS", "Export Excel", or "Send Inverter Setpoint" sends a standard API request to the connected server.

---

## 2. Phase-by-Phase Proposed Changes

### Phase 1: Frontend Simplification (`public/js/app.js` & `public/index.html`)
- **Remove Mode Checks:** Strip `isClientModeActive()`, `getActiveOperationModeClient()`, `getSelectedOperationModeClient()`, and `normalizeOperationModeValue()`.
- **Remove Remote Health & Fallback Banners:** Remove `State.remoteHealth`, `normalizeRemoteHealthClient()`, stale-data warnings, and remote status indicators that cluttered the UI.
- **Universal Feature Access:** Ensure all forms, buttons, and tools (Day-Ahead generation, QA scoring, DLS upload, grid compliance tests, exports) execute standard API calls without client-side gates.
- **Bust Cache:** Increment CSS and JS version in `public/index.html` (Golden Rule 3).

### Phase 2: Server Decoupling & Proxy Removal (`server/index.js`)
- **Eliminate Reverse-Proxying:** Remove `proxyToRemote()`, `proxyWebSocketToRemote()`, and `shouldProxyApiPath()`.
- **Remove Remote Polling Bridges:** Remove `_startRemotePollingBridge()`, `_stopRemotePollingBridge()`, `remoteBridgeState`, and `remoteChatBridgeState`.
- **Simplify Route Handlers:** Convert all routes (compliance runs, forecast generation, QA backfill, calibration, alarms) to direct local handlers on the server without `if (isRemoteMode())` conditionals.
- **Clean Subsystem Modules:** Strip `isRemoteMode` from `server/calibrationRoutes.js`, `server/alarmsDiagnostic.js`, and `server/cloudBackup.js`.

### Phase 3: Settings & Configuration Clean-up (`public/global-config.html` & `server/db.js`)
- **Settings Schema Streamlining:** Deprecate and remove obsolete settings: `operationMode`, `remoteGatewayUrl`, `remoteApiToken`, `remoteViewerMode`.
- **UI Settings Modal Clean-up:**
  - Remove the "Operation Mode: Gateway vs Remote" radio / dropdown options.
  - In `global-config.html`, remove the remote gateway configuration tabs and replace them with standard plant network parameters.

### Phase 4: Electron Client Streamlining (`electron/main.js`)
- **Flexible Electron Startup:**
  - If running as a remote viewer: Electron simply prompts for/reads the server URL (e.g. `http://100.114.7.12:3500` or `http://192.168.1.13:3500`) and loads `mainWin.loadURL(SERVER_URL)`. It does NOT spawn a local backend server or duplicate databases.
  - If running standalone on Windows (all-in-one): Electron spawns the local Python/Node engine and loads `http://localhost:3500`.

---

## 3. Verification Plan

### Automated & Unit Tests
1. **Server Boot & Health:** Run `node server/index.js` in a test environment to verify clean route mounting without proxy dependencies.
2. **Forecast & QA Routes:**
   - Test `POST /api/forecast/generate`
   - Test `POST /api/forecast/backfill-qa?days=15`
   - Test `GET /api/forecast/qa-history`
3. **Inverter & Compliance Controls:** Verify Modbus and compliance endpoints respond properly.

### Manual Verification
1. **Direct Web Client:** Open `http://100.114.7.12:3500` on Windows Chrome/Edge:
   - Verify live telemetry, charts, and cameras stream without error.
   - Run a 7-day forecast generation from the Analytics tab.
   - Run a QA evaluation.
2. **Mobile Viewport Verification:** Verify responsive viewports (360pxâ€“390px) retain zero horizontal scroll and zero input collision per Golden Rules 1, 2, 4, 5.
3. **Desktop Verification:** Verify 1440px desktop view remains 100% pristine.

