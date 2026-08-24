# Implementation Plan â€” Architecture Unification & Operation Mode Simplification

**Date:** 2026-08-24  
**Status:** PROPOSED (Awaiting Operator Approval)  
**Goal:** Unify the ADSI Dashboard into a clean, secure **Client-Server Architecture** designed for **Multi-User / Multi-Controller Plant Operations**. Implement **Per-Controller Device Identification**, **Server-Side Personalization Profiles**, **Single-Writer Inverter Control Arbitration**, and **Server Single Source of Truth**.

---

## User Review Required

> [!IMPORTANT]
> ### ðŸ‘¥ Multi-User / Multi-Controller Identity & Role Management
> Since different engineers and shift controllers access the dashboard from their own workstations, laptops, and field tablets:
> 1. **Per-Controller Profiles (Saved on the Server):**
>    - Each controller device (`deviceId`) stores its operator name (e.g. `"Engr. M (Lead Engineer)"`, `"Shift Tech A (Control Room)"`, `"Field Tablet 1"`).
>    - The server independently preserves each controller's **UI theme, favorite inverters, custom chart zoom ranges, alarm audio toggles, and layout preferences**.
> 2. **Live Inverter Control Ownership:**
>    - When a controller enters the APC or Plant Cap tab to adjust setpoints or run a grid test, the server grants a **Single-Writer Control Lease**.
>    - All other open dashboards instantly display a live ownership banner:  
>      `ðŸ”’ Active Control by Engr. M (Lead Engineer) [100.114.7.50] â€” Inverter Writes Locked`
> 3. **SCADA Audit Accountability:**
>    - Every single write action (APC setpoint, %P limit, inverter start/stop, schedule edit, test sweep) records the controller's friendly name, device ID, IP address, and exact parameters in `audit_log`.

> [!IMPORTANT]
> ### ðŸ—„ï¸ Server as the Single Source of Truth (DATA & CONFIG PRESERVATION)
> - All master configurations (`ipconfig.json`, settings table, `credentials.json`, `go2rtc.yaml`), database telemetry (`adsi.db`, multi-year `archive/*.db`), AI models (`.joblib`, `ml_train_state.json`), weather CSVs, and audit logs reside **exclusively on the server** (`/var/lib/adsi-dashboard/` or Windows server directory).
> - Connected clients are lightweight and stateless â€” they never maintain divergent local DB fragments.

---

## 1. Multi-Controller System Architecture

```
 â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
 â”‚                             ADSI Server Backend                              â”‚
 â”‚                 (Linux Server / Dedicated Gateway Appliance)                 â”‚
 â”‚                                                                              â”‚
 â”‚   - Express API & WebSockets Gateway (Port 3500)                             â”‚
 â”‚   - Inverter Modbus Engine (Port 9100)                                       â”‚
 â”‚   - Solar AI Day-Ahead Engine (Python venv)                                  â”‚
 â”‚   - go2rtc RTSP/WebRTC Streaming (Ports 1984, 8555)                          â”‚
 â”‚   - Authoritative Master Storage (/var/lib/adsi-dashboard/)                  â”‚
 â”‚                                                                              â”‚
 â”‚   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ SECURITY & AUDIT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”   â”‚
 â”‚   â”‚ â€¢ Controller Device Registry (`client_devices` table in adsi.db)     â”‚   â”‚
 â”‚   â”‚ â€¢ Per-Controller Personalization (Themes, Layouts, Chart Views)      â”‚   â”‚
 â”‚   â”‚ â€¢ Single-Writer Control Arbiter & Modbus Write Queue Lock            â”‚   â”‚
 â”‚   â”‚ â€¢ SCADA Audit Trail (Logs Controller Name, Device ID, IP, Setpoint)  â”‚   â”‚
 â”‚   â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜   â”‚
 â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                                        â”‚
             â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
             â”‚ Multi-Client Telemetry   â”‚ Single-Writer Controls   â”‚
             â–¼                          â–¼                          â–¼
   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”      â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”      â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
   â”‚ "Lead Engineer"   â”‚      â”‚ "Control Room"    â”‚      â”‚ "Field Tablet"    â”‚
   â”‚ Engr. M Laptop    â”‚      â”‚ Shift Tech PC     â”‚      â”‚ Electrician A     â”‚
   â”‚ Theme: Dark Navy  â”‚      â”‚ Theme: High Con.  â”‚      â”‚ Theme: Solar      â”‚
   â”‚ (Active Control)  â”‚      â”‚ (Read Telemetry)  â”‚      â”‚ (Read Telemetry)  â”‚
   â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜      â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜      â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

---

## 2. Phase-by-Phase Implementation

### Phase 1: Controller Device Identification & Personalization Registry
- **Server Device Registry (`server/deviceRegistry.js`):**
  - Create table `client_devices (device_id TEXT PRIMARY KEY, device_name TEXT, operator_name TEXT, ip_address TEXT, role TEXT, preferences_json TEXT, last_seen_ts INTEGER)`.
  - Provide endpoints:
    - `POST /api/device/register` â€” Handshake device, return saved controller preferences.
    - `POST /api/device/preferences` â€” Save personalized theme, layout zoom, active tabs to server.
    - `GET /api/devices` â€” View all registered controllers / devices list.
- **Client Identity (`public/js/app.js`):**
  - Generate UUID `deviceId` in `localStorage` on first visit.
  - Allow operator to set/edit their controller name (e.g. `"Engr. M (Lead Engineer)"`).
  - Send `X-Device-Id` and `X-Operator-Name` in all API headers and WebSocket handshakes.
  - Automatically load and apply that controller's theme and custom UI layout.

### Phase 2: Inverter Control Arbitration & SCADA Audit Enforcement
- **Server Control Arbiter (`server/controlArbiter.js`):**
  - Manage a single-writer control lease (60s sliding expiration).
  - Gate all setpoints and commands (`/api/write`, `/api/plant-cap/apply`, `/api/compliance/run/start`, `/api/plant-cap/schedule/save`).
  - Broadcast active lock state via WebSockets:  
    `{ type: "control_lock", lockedBy: "Engr. M (Lead Engineer)", ip: "100.114.7.50", expiresTs: 1771829000 }`
  - Log every control action to `audit_log` with controller name and device ID.
- **Client Lock UI:**
  - Display non-intrusive live lock banner on APC and Plant Cap tabs when another controller holds the lease.

### Phase 3: Frontend Simplification & Mode Elimination (`public/js/app.js`)
- **Rip Out Legacy Modes:** Strip `isClientModeActive()`, `getActiveOperationModeClient()`, `getSelectedOperationModeClient()`, and `normalizeOperationModeValue()`.
- **Remove Fake Status Banners:** Remove `State.remoteHealth`, `normalizeRemoteHealthClient()`, and stale-data warnings.
- **Universal Feature Access:** Ensure all analytics, reports, exports, QA scoring, and DLS upload tools are open to all connected clients.
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
1. **Multi-Controller Profile Test:** Register Controller A (Lead Engr) and Controller B (Shift Tech) â†’ verify each receives and persists independent themes and layout preferences on the server.
2. **Concurrent Inverter Control Test:**
   - Controller A issues an APC setpoint â†’ verify lease is granted and `audit_log` logs Controller A's name.
   - Controller B attempts to change setpoint at same time â†’ verify HTTP 423 rejection with Controller A's name in error payload.
3. **Lease Release & Handoff Test:** Controller A finishes â†’ lease releases â†’ Controller B can immediately claim control.

### Manual Verification
1. **Dual Device Verification:** Open dashboard on Laptop and Phone simultaneously with different controller names:
   - Verify both have independent personalized themes.
   - Verify live telemetry and cameras stream in real time on both.
2. **Desktop & Mobile UI Invariants:** Verify 1440px desktop view and 360px mobile view remain 100% compliant with Golden Rules 1, 2, 4, 5.

