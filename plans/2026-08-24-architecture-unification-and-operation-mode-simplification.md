# Implementation Plan â€” Architecture Unification & Operation Mode Simplification

**Date:** 2026-08-24  
**Status:** PROPOSED (Awaiting Operator Approval)  
**Goal:** Unify the ADSI Dashboard into a clean, standard **Client-Server Architecture**. Eliminate legacy dual-mode boilerplate while establishing **Strict Inverter Control Arbitration** (unlimited multi-client read telemetry + single-writer control locking).

---

## User Review Required

> [!IMPORTANT]
> ### ðŸ›¡ï¸ Inverter Control Safety & Single-Writer Arbitration (NEW RULE)
> While **data telemetry, charts, and camera streams** are open to unlimited concurrent viewers (browsers, mobile, desktop), **Inverter Control Actions** (APC Setpoints, %P, Power Factor, Reactive kVAr, Start/Stop, Plant Cap Schedules, Compliance Tests) will be strictly protected against multi-operator collisions:
> 1. **Centralized Control Lock (Server-Enforced):** A control session lease is granted to one active operator at a time (authenticated via `adsiMM` / session lease token).
> 2. **Visual Busy Indicator:** Other connected clients immediately see a status pill: `ðŸ”’ Controlled by Operator (<Client-IP>) â€” Locked`.
> 3. **Conflict Rejection (HTTP 423 Locked):** Simultaneous competing commands from another device are safely rejected while a control sequence is in flight.
> 4. **Hardware-Level Modbus Serialization:** `inverter_engine.py` enforces a single-thread Modbus write queue (FIFO with bus locking) so hardware is never bombarded by parallel write requests.

---

## 1. Problem & Architectural Rationale

### Current State (The "Mess" & Technical Debt)
1. **Server-on-Server Redundancy:** A remote laptop running the Electron app starts a full local Express server on port 3500 just to proxy requests over HTTP to the actual Linux server on port 3500.
2. **Dual-DB & Sync Complexities:** The local client tries to cache and snapshot tables from the gateway, creating stale-data warnings, replication collisions, and sync state machines (`State.remoteHealth`, `remoteBridgeState`).
3. **Artificial Feature Lockouts:** Features like Day-Ahead Generator, DLS uploads, and QA backfill were riddled with `if (isRemoteMode()) return 403` or client-side `isClientModeActive()` disables.
4. **Reverse-Proxy Boilerplate:** Over 250 instances of `if (isRemoteMode()) return proxyToRemote(req, res)` and manual route routing filters (`shouldProxyApiPath()`) scattered across `server/index.js` and `server/calibrationRoutes.js`.
5. **Operator Confusion:** Users had to navigate to Settings / Global Config to toggle "Gateway" vs "Remote" modes instead of simply connecting to the server.

### Target State (Unified Architecture with Control Arbitration)
```
 â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
 â”‚                     ADSI Server Backend                     â”‚
 â”‚          (Linux Server / Dedicated Gateway / Local)         â”‚
 â”‚   - Express API & WebSockets Gateway (Port 3500)            â”‚
 â”‚   - Inverter Modbus Engine (Port 9100)                      â”‚
 â”‚   - Solar AI Day-Ahead Engine (Python venv)                 â”‚
 â”‚   - go2rtc RTSP/WebRTC Streaming (Ports 1984, 8555)         â”‚
 â”‚   - Single Authoritative SQLite Database & Archives         â”‚
 â”‚   - [CONTROL ARBITER]: Single-Writer Lease & Mutex Guard    â”‚
 â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                                â”‚
        â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
        â”‚ Read Streams (Multi)  â”‚ Control Actions (1-At-A-Time)
        â–¼                       â–¼                       â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”         â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”         â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚ Web Browsers â”‚         â”‚ Electron App â”‚         â”‚ Mobile / PWA â”‚
â”‚  (Read-Only  â”‚         â”‚(Active Masterâ”‚         â”‚  (Read-Only  â”‚
â”‚  Live View)  â”‚         â”‚ Control Leaseâ”‚         â”‚  Live View)  â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜         â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜         â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

---

## 2. Phase-by-Phase Implementation

### Phase 1: Inverter Control Arbitration & Single-Writer Guard
- **Server Control Arbiter (`server/controlArbiter.js`):**
  - Manage a lightweight control session lease (e.g. 60-second sliding expiration).
  - Gate all destructive or setpoint endpoints (`/api/write`, `/api/plant-cap/apply`, `/api/compliance/run/start`, `/api/plant-cap/schedule/save`).
  - Broadcast active controller state via WebSocket (`{ type: "control_lock", lockedBy: "operator@100.114.7.50", expiresTs: 1771829000 }`).
- **Frontend Lock Indicators (`public/js/app.js`):**
  - Display non-intrusive lock badge on APC and Plant Cap tabs when another operator is commanding the fleet.
  - Require single-click confirmation before claiming control.

### Phase 2: Frontend Simplification (`public/js/app.js` & `public/index.html`)
- **Remove Mode Checks:** Strip `isClientModeActive()`, `getActiveOperationModeClient()`, `getSelectedOperationModeClient()`, and `normalizeOperationModeValue()`.
- **Remove Remote Health & Fallback Banners:** Remove `State.remoteHealth`, `normalizeRemoteHealthClient()`, stale-data warnings, and remote status indicators.
- **Universal Feature Access:** Ensure all analytics, reports, exports, QA scoring, and DLS upload tools are open to all connected clients.
- **Bust Cache:** Increment CSS and JS version in `public/index.html` (Golden Rule 3).

### Phase 3: Server Decoupling & Proxy Removal (`server/index.js`)
- **Eliminate Reverse-Proxying:** Remove `proxyToRemote()`, `proxyWebSocketToRemote()`, and `shouldProxyApiPath()`.
- **Remove Remote Polling Bridges:** Remove `_startRemotePollingBridge()`, `_stopRemotePollingBridge()`, `remoteBridgeState`, and `remoteChatBridgeState`.
- **Simplify Route Handlers:** Convert all routes (compliance runs, forecast generation, QA backfill, calibration, alarms) to direct local handlers on the server without `if (isRemoteMode())` conditionals.
- **Clean Subsystem Modules:** Strip `isRemoteMode` from `server/calibrationRoutes.js`, `server/alarmsDiagnostic.js`, and `server/cloudBackup.js`.

### Phase 4: Settings & Configuration Clean-up (`public/global-config.html` & `server/db.js`)
- **Settings Schema Streamlining:** Deprecate and remove obsolete settings: `operationMode`, `remoteGatewayUrl`, `remoteApiToken`, `remoteViewerMode`.
- **UI Settings Modal Clean-up:** Remove "Operation Mode: Gateway vs Remote" toggle and token inputs from `global-config.html` and UI modals.

### Phase 5: Electron Client Streamlining (`electron/main.js`)
- **Flexible Electron Startup:**
  - Remote viewer: Simply loads `http://<server-ip>:3500` as a webview window.
  - Standalone local: Spawns local services and loads `http://localhost:3500`.

---

## 3. Verification Plan

### Automated & Concurrency Tests
1. **Multi-Client Read Test:** Connect 5 simulated WebSocket and HTTP clients simultaneously â€” verify zero performance drop in telemetry.
2. **Concurrent Write Lock Test:** Send simultaneous conflicting setpoints from Client A and Client B:
   - Verify Client A obtains lease and applies setpoint.
   - Verify Client B receives `423 Locked: Control session active by Client A`.
3. **Lease Expiration Test:** Verify lease cleanly releases after timeout or manual release.

### Manual Verification
1. **Dual Device Verification:** Open dashboard on Laptop and Phone simultaneously:
   - Verify both show synchronized live data and charts.
   - Send setpoint on Laptop â†’ Verify Phone shows "Controlled by Operator" lock badge.
2. **Desktop & Mobile UI Invariants:** Verify 1440px desktop view and 360px mobile view remain 100% compliant with Golden Rules 1, 2, 4, 5.

