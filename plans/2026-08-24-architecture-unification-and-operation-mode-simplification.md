# Master Architecture Blueprint â€” ADSI Inverter Dashboard 2.0

**Project Name:** Inverter Dashboard (ADSI Inverter Dashboard 2.0)  
**Target Repository:** Standalone New Repository (preserving legacy `ADSI-Dashboard` untouched)  
**Architecture Model:** Pure Client-Server Model (inspired by `edocflow` + proven industrial cores)  
**Status:** PROPOSED & SPECIFIED  

---

## Executive Summary & Strategic Rationale

To eliminate years of accumulated technical debt (dual-mode reverse proxying, client-side database fragments, artificial feature lockouts, monolithic files) without risking production uptime, **ADSI Inverter Dashboard 2.0** will be created as a **fresh, clean, standalone repository**.

The legacy `ADSI-Dashboard` repository remains 100% untouched and operational, while **2.0** is built from the ground up with clean boundaries, modern performance, per-controller personalization, and strict industrial safety locks.

---

## 1. Core Invariants & Architectural Principles

1. **Clean Client-Server Separation:**
   - **Backend Server (`backend/` or `server/`):** Pure headless appliance. Hosts Express/FastAPI, WebSockets, Modbus Polling Engine, Solar AI Engine, go2rtc Streaming, and authoritative SQLite storage.
   - **Universal Frontend (`frontend/` or `public/`):** Universal, responsive Single Page Application (SPA). Zero proxying, zero duplicate DBs.
   - **Lightweight Desktop Wrapper (`desktop/`):** Electron container (following the `edocflow/desktop` pattern) that simply loads `http://<server-ip>:3500` or local instance.

2. **Server as Single Source of Truth:**
   - All configurations (`ipconfig.json`, `credentials.json`, `go2rtc.yaml`), telemetry (`adsi.db`, multi-year `archive/*.db`), AI models (`.joblib`), and audit logs reside **exclusively on the server**.

3. **Multi-User / Multi-Controller Identity & Personalization:**
   - Each connecting browser, tablet, or desktop receives a persistent **`deviceId`**.
   - Controllers set friendly identities (e.g. `"Engr. M (Lead Engineer)"`, `"Control Room Shift Tech"`, `"Field Electrician"`).
   - Individual themes (Dark, Solar Amber, High-Contrast), favorite inverter layouts, custom chart zoom ranges, and audio alert toggles are saved on the server mapped to `deviceId`.

4. **Single-Writer Inverter Control Arbitration (SCADA Safety):**
   - **Read Telemetry:** Multi-client concurrent streaming (unlimited viewers).
   - **Write Controls (APC %P, Setpoints, PF, kVAr, Start/Stop, Plant Cap, Compliance Tests):** Protected by a **Centralized Control Lease** (60s sliding expiration). Competing writes receive HTTP 423 with a live lock banner: `ðŸ”’ Active Control by <OperatorName> â€” Inverter Writes Locked`.
   - **Hardware Modbus Serialization:** FIFO queue with bus locking prevents overlapping hardware commands.

5. **100% Production Data Compatibility:**
   - Seamlessly mounts the existing 27.5 GB production data hierarchy (`adsi.db`, `archive/2026-03.db` ... `2026-08.db`, `ml_train_state.json`, weather CSVs).

---

## 2. Target Repository Directory Structure

```
Inverter-Dashboard/ (2.0 New Repository)
â”œâ”€â”€ backend/                  # Pure Backend Microservices & API
â”‚   â”œâ”€â”€ api/                  # Modular Route Controllers
â”‚   â”‚   â”œâ”€â”€ telemetry.js      # /api/live, /api/energy, /api/analytics
â”‚   â”‚   â”œâ”€â”€ control.js        # /api/write, /api/plant-cap, /api/compliance
â”‚   â”‚   â”œâ”€â”€ forecast.js       # /api/forecast/generate, /backfill-qa
â”‚   â”‚   â”œâ”€â”€ streaming.js      # go2rtc & Hikvision video routes
â”‚   â”‚   â”œâ”€â”€ devices.js        # Device registry & personalization profiles
â”‚   â”‚   â””â”€â”€ config.js         # /api/ipconfig, /api/settings
â”‚   â”œâ”€â”€ core/                 # Core Subsystems
â”‚   â”‚   â”œâ”€â”€ controlArbiter.js # Single-writer lease & mutex manager
â”‚   â”‚   â”œâ”€â”€ deviceRegistry.js # client_devices table & profile store
â”‚   â”‚   â”œâ”€â”€ db.js             # SQLite reader/writer + archive manager
â”‚   â”‚   â””â”€â”€ websocket.js      # Real-time telemetry & control lock broadcaster
â”‚   â”œâ”€â”€ engines/              # Industrial Engines
â”‚   â”‚   â”œâ”€â”€ inverter/         # InverterCoreService (Modbus Asyncio)
â”‚   â”‚   â”œâ”€â”€ forecast/         # ForecastCoreService (Solar ML Engine)
â”‚   â”‚   â””â”€â”€ go2rtc/           # go2rtc binary & streaming manager
â”‚   â”œâ”€â”€ server.js             # Express Gateway Entry Point (:3500)
â”‚   â””â”€â”€ package.json
â”‚
â”œâ”€â”€ frontend/                 # Universal Responsive Web Dashboard
â”‚   â”œâ”€â”€ public/               # Static assets, fonts, icons, manifest
â”‚   â”œâ”€â”€ src/ (or public/js/)  # Modular Frontend Components
â”‚   â”‚   â”œâ”€â”€ core/             # API client, WebSocket listener, State
â”‚   â”‚   â”œâ”€â”€ identity/         # Device ID manager & personalization sync
â”‚   â”‚   â”œâ”€â”€ views/            # Dashboard, Plant Cap, Analytics, Cameras
â”‚   â”‚   â””â”€â”€ controls/         # APC setpoint modal, control lock banners
â”‚   â””â”€â”€ index.html
â”‚
â”œâ”€â”€ desktop/                  # Lightweight Electron Desktop Wrapper
â”‚   â”œâ”€â”€ main.js               # Clean Electron window loader
â”‚   â”œâ”€â”€ config.js             # Network discovery & server address resolver
â”‚   â”œâ”€â”€ server.js             # Optional standalone server launcher
â”‚   â””â”€â”€ package.json
â”‚
â”œâ”€â”€ deploy/                   # Production Deployment Suite
â”‚   â”œâ”€â”€ linux/                # Hardened 18-step Linux setup & systemd units
â”‚   â”œâ”€â”€ windows/              # One-click Windows deployment & launchers
â”‚   â””â”€â”€ docker/               # Docker Compose configuration
â”‚
â””â”€â”€ storage/                  # Authoritative Server Data (or /var/lib/adsi-dashboard)
    â”œâ”€â”€ db/                   # adsi.db + archive/*.db
    â”œâ”€â”€ config/               # ipconfig.json
    â”œâ”€â”€ auth/                 # credentials.json
    â””â”€â”€ programdata/          # forecast models, weather, snapshots
```

---

## 3. Step-by-Step Implementation Roadmap

### Phase 1: Repository Foundation & Core Server Setup
- Initialize the clean repository structure.
- Implement the unified Express API Gateway (`backend/server.js`) on Port 3500.
- Mount the authoritative SQLite storage layer (`adsi.db` + multi-year `archive/` shards) with zero schema regressions.

### Phase 2: Device Identity & Multi-Controller Personalization
- Implement `deviceRegistry.js` with table `client_devices`.
- Implement `controlArbiter.js` single-writer lease guard for all inverter write routes.
- Build the client-side `deviceId` generator and server profile sync (theme, custom views, operator friendly name).

### Phase 3: Engine Integration & Direct Route Modularization
- Wire `inverter_engine.py` on Port 9100 with Modbus FIFO write serialization.
- Wire `forecast_engine.py` with Open-Meteo + Solcast ML day-ahead generation and QA backfill.
- Wire `go2rtc` camera streaming on ports 1984/8555.
- Remove all legacy `if (isRemoteMode()) proxyToRemote()` and polling bridge loops.

### Phase 4: Frontend Modernization & Responsive Layouts
- Clean modular frontend with zero mode-based disables.
- Real-time lock ownership banner on APC and Plant Cap tabs.
- Multi-theme engine (Dark Navy, Solar Amber, High-Contrast, Cyberpunk).
- Verify 100% compliance with Golden Rules 1, 2, 4, 5 (pristine desktop + zero-collision mobile).

### Phase 5: Desktop App & One-Click Deployment
- Build `desktop/` wrapper following the `edocflow/desktop` model (Server URL picker + QR code + network interface discovery).
- Update deployment scripts for Linux (`deploy/linux/setup.sh`) and Windows (`deploy/windows/`).

---

## 4. Verification & Testing Matrix

| Test Category | Target Objective | Verification Method |
|---|---|---|
| **Data Integrity** | Existing 27.5 GB telemetry and archives load cleanly | Query August 2026 actuals & March-August 2026 archive DBs |
| **Control Safety** | Simultaneous inverter writes are blocked | Concurrent API test: Client A commands setpoint, Client B receives HTTP 423 |
| **Device Profiles** | Controller personalizations persist on server | Change theme on Laptop â†’ reload â†’ theme restored from server |
| **Streaming** | Real-time Modbus telemetry and dual cameras | 10 concurrent browser connections with live WebSockets |
| **Responsive UI** | Zero mobile overflow and pristine desktop layout | Automated Puppeteer viewport checks (360px vs 1440px) |

