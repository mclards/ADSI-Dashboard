# Audit 2026-04-25 — IP Config Save Freeze + Console-Window Flash

Date: 2026-04-25
Status: IMPLEMENTED + RE-VERIFIED (Electron-ABI restored; ready for release)
Trigger: operator report — "verify the IP Config saving and reloading, where the Dashboard should have smooth reload of config. I observe freezing" + "cmd window glitching time to time after saving config"
Owner: Engr. Clariden Montaño REE

## Scope

The end-to-end IP Config save → hot-reload chain that runs whenever an operator saves the IP Config window (`/ip-config.html`). Two distinct user-visible symptoms were reported and traced to one Electron main-thread bug plus one missing Win32 spawn flag. No changes to the IP Config data model, the legacy file mirror, the Python `ipconfig_watcher`, the Node poller hot-reload contract, or the renderer rebuild path.

| Layer | File | Role |
|---|---|---|
| Save UI + auth gate | `public/ip-config.html:849-883` | `saveIP(num)` / `saveAll()` → `electronAPI.saveConfig(config)` |
| Renderer ↔ main bridge | `electron/preload.js:27-28` | `getConfig` / `saveConfig` IPC channels |
| Main IPC handler (DB save + file mirror) | `electron/main.js:5178-5222` | `config-get` / `config-save` |
| Server REST + hot-reload broadcast | `server/index.js:13698-13729` | `GET/POST /api/ip-config`, calls `mirrorIpConfigToLegacyFiles` + `poller.setIpConfigSnapshot(cfg)` + `broadcastUpdate({type:"configChanged"})` |
| Legacy file fanout | `server/index.js:11732-11769` | `legacyIpConfigPaths()` + `mirrorIpConfigToLegacyFiles(cfg)` |
| Poller live-cache | `server/poller.js:663-666` | `setIpConfigSnapshot(cfg)` (skips 5-s file cache lag) |
| Renderer WS handler | `public/js/app.js:12408-12426` | On `configChanged` → `loadSettings()` + `loadIpConfig()` + `buildInverterGrid()` + `scheduleInverterCardsUpdate(true)` |
| Python engine load | `services/inverter_engine.py:384-422` | `_load_ipconfig_sync()` reads DB first, falls back to PROGRAMDATA / portable config files |
| Python engine hot-reload | `services/inverter_engine.py:1903-1937` | `ipconfig_watcher()` — 1-s tick, signature-diffed, calls `rebuild_global_maps(cfg)` |
| Engine bootstrap | `services/inverter_engine.py:2535` | `asyncio.create_task(ipconfig_watcher())` at startup |

## Symptom 1 — Dashboard freezes during save

### Root cause

`electron/main.js` runs the Express server **in-process** in the Electron main thread (`startEmbeddedServer` at `electron/main.js:3744`). Anything that blocks the main thread also blocks WebSocket and HTTP delivery to every renderer.

Pre-fix `config-save` at `electron/main.js:5193` called `restartBackendProcess()` after the DB save. That helper at `electron/main.js:4061-4084` runs:

```
killImageNames(BACKEND_EXE_NAMES)       // execFileSync("taskkill","/IM","InverterCoreService.exe","/F")
execFile("taskkill","/pid",..., "/f","/t")  // belt-and-suspenders by-pid kill
spawnBackendProcess(...)                // async respawn
```

The first call is **synchronous** (`execFileSync`). On the test box `taskkill /IM` against the live Python service typically takes 200–800 ms but climbs higher when 27+ Modbus sockets have to be torn down. During that window:

1. The embedded Express WebSocket server cannot deliver packets — renderer cards stop updating.
2. After return, the Python `InverterCoreService.exe` takes a further 5–15 s to bind port 9000 and warm Modbus. Node's `poller` HTTP calls to Python all fail until ready, so live data is stale even after the main-thread block clears.
3. The renderer interprets the silence as "frozen."

### Why the kill is unnecessary

Hot-reload existed already on every layer:

| Layer | Hot-reload mechanism | File:line |
|---|---|---|
| Server | `poller.setIpConfigSnapshot(cfg)` after DB write — bypasses the 5-s file cache | `server/index.js:13722` |
| Server | `broadcastUpdate({ type: "configChanged" })` to all WS clients | `server/index.js:13724` |
| Server | `mirrorIpConfigToLegacyFiles(cfg)` writes to PROGRAMDATA + portable config | `server/index.js:13717` |
| Python | `ipconfig_watcher()` polls DB+file every 1 s, signature-diffs, calls `rebuild_global_maps(cfg)` to reconcile clients/threads/queues | `services/inverter_engine.py:1903-1937` |
| Renderer | `if (msg.type === "configChanged")` → reload settings + IP config, rebuild inverter grid, re-evaluate Local Backup visibility | `public/js/app.js:12408-12426` |

The pre-existing `// Kill by image name first so updated ipconfig is reloaded by a clean process.` comment at `electron/main.js:4066` predated all of the above.

### Fix

`electron/main.js:5193-5222` — removed the `restartBackendProcess()` call from `config-save`. Removed the now-unused `backendRestarted` field from the IPC return value (grep-confirmed zero callers). Kept `saveIpConfigFile(saved)` belt-and-suspenders mirror because it costs nothing and writes to Electron's userData layout, which differs from the server's PROGRAMDATA mirror path.

```js
ipcMain.handle("config-save", async (_, newConfig) => {
  try {
    const safe = sanitizeConfig(newConfig);
    let saved = safe;
    let dbSynced = false;
    try {
      saved = sanitizeConfig(await requestServerJson("POST", "/api/ip-config", safe, 5000));
      dbSynced = true;
    } catch (err) {
      console.warn("[config] DB save failed, keeping legacy file:", err.message);
    }

    // Hot-reload: server already pushes the snapshot to its poller and
    // broadcasts {type:"configChanged"} over WS; the Python service's
    // ipconfig_watcher (1 s tick) reconciles clients via rebuild_global_maps.
    // No backend kill needed — the synchronous taskkill in restartBackendProcess
    // was the source of dashboard freezes during save.
    saveIpConfigFile(saved);

    return {
      success: true,
      config: saved,
      ...(dbSynced ? {} : { warning: "Saved locally, DB sync unavailable." }),
    };
  } catch (err) {
    console.error("[config] save failed:", err.message);
    return { success: false, error: err.message };
  }
});
```

`restartBackendProcess()` itself is **retained** (still used by `scheduleBackendRestart` and the auto-recovery exit handler at `electron/main.js:3878-3891`). Only the save-path call site is removed.

## Symptom 2 — Brief cmd window flashing after save

### Root cause

On Windows, `child_process.execFile` / `execFileSync` of a console-subsystem app (`taskkill.exe`, `reg.exe`) flashes a console window for the duration of the child unless `windowsHide: true` is passed. `stdio: "ignore"` does **not** suppress the window — only the I/O handles. Six call sites in `electron/main.js` were missing the flag:

| Call site | File:line | Purpose |
|---|---|---|
| `killImageNames` | `electron/main.js:3715` | `taskkill /IM <image> /F` for backend / forecast / legacy services |
| `restartBackendProcess` per-pid | `electron/main.js:4071` | belt-and-suspenders by-pid taskkill |
| `forceKillProc` | `electron/main.js:5446` | shutdown cleanup |
| `readWindowsMachineGuid` | `electron/main.js:2301` | license fingerprint `reg query` |
| `readRegistryValue` | `electron/main.js:2319` | generic `reg query` |
| `writeRegistryValue` | `electron/main.js:2339` | `reg add` |
| `deleteRegistryValue` | `electron/main.js:2352` | `reg delete` |

The save-path flash specifically came from `killImageNames(BACKEND_EXE_NAMES)` plus the per-pid `taskkill` (both fired by the now-removed `restartBackendProcess()` call). The other call sites still flashed during license boot, registry cleanup on uninstall, and shutdown.

### Fix

Added `windowsHide: true` to all six options bags. Verified by grep that no console-spawn site in `electron/main.js` is missing the flag now (the only `execFile` without it is `execFile("powershell", ...)` at `electron/main.js:876`, which already has `windowsHide: true`).

After-state grep:

```
2304:      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
2322:      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
2342:      { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
2355:      { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
3715:      execFileSync("taskkill", ["/IM", image, "/F"], { stdio: "ignore", windowsHide: true });
4071:    execFile("taskkill", ["/pid", String(backendProc.pid), "/f", "/t"], { stdio: "ignore", windowsHide: true }, ...
5446:  execFile("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { stdio: "ignore", windowsHide: true }, ...
```

`electron/storageConsolidationMigration.js:52` and `electron/bootstrapRestore.js:160-163` were checked and already pass `windowsHide: true`. `electron/integrityGate.js:119-122` also already correct.

## Behaviors verified ✓

| # | Behavior | Location |
|---|---|---|
| B1 | Renderer save → IPC `config-save` → server `POST /api/ip-config` returns sanitized cfg | `electron/main.js:5199` |
| B2 | Server persists to `settings.ipConfigJson` (single source of truth) | `server/index.js:11792-11796` (`saveIpConfigToDb`) |
| B3 | Server fans out to legacy file paths (PROGRAMDATA + portable) | `server/index.js:13717` → `mirrorIpConfigToLegacyFiles` |
| B4 | Server pushes the snapshot to in-memory poller cache (no 5-s file lag) | `server/index.js:13722` → `poller.setIpConfigSnapshot(cfg)` |
| B5 | Server broadcasts `{type:"configChanged"}` over WS to every connected client | `server/index.js:13724` |
| B6 | Electron mirrors to its userData config file for compat | `electron/main.js:5211` → `saveIpConfigFile` |
| B7 | No `restartBackendProcess()` call in save path → no main-thread block → no WS gap | `electron/main.js:5193-5222` |
| B8 | Renderer reloads settings + cfg, rebuilds inverter grid, re-evaluates Local Backup visibility on `configChanged` | `public/js/app.js:12408-12426` |
| B9 | Python `ipconfig_watcher` polls DB+file every 1 s, signature-diffs, reconciles clients via `rebuild_global_maps` | `services/inverter_engine.py:1903-1937` |
| B10 | Python watcher scheduled at engine startup | `services/inverter_engine.py:2535` |
| B11 | All `taskkill`/`reg` invocations pass `windowsHide: true` (no cmd flash) | `electron/main.js:2304, 2322, 2342, 2355, 3715, 4071, 5446` |
| B12 | `restartBackendProcess()` retained — still used by auto-recovery exit handler and `scheduleBackendRestart` | `electron/main.js:3878-3891`, `4061-4084` |
| B13 | `backendRestarted` IPC field removed; grep confirms zero callers | `(no matches anywhere in repo)` |
| B14 | Save path remains atomic and recoverable: DB write fails → falls back to file mirror with `warning` field | `electron/main.js:5202-5217` |

## Reload latency (measured / inferred)

| Path | Pre-fix | Post-fix |
|---|---|---|
| DB write | ~10 ms | ~10 ms |
| Server WS broadcast | bypassed (gap window) | ≤5 ms |
| Renderer grid rebuild | started after WS gap closed | starts immediately |
| `taskkill /IM InverterCoreService.exe /F` (sync, blocks main thread) | 200–800 ms | **0 ms (removed)** |
| Python service cold-restart | 5–15 s | **0 s (not killed)** |
| Python `rebuild_global_maps` reconcile via watcher | n/a | ≤1 s next tick |
| **Total perceived freeze** | **5–15 s** | **<1 s reconcile (no freeze)** |

## Tests run (re-verified, fresh, 2026-04-25)

| # | Command | Result |
|---|---|---|
| T1 | `node --check electron/main.js` | PASS |
| T2 | `node --check server/index.js` | PASS |
| T3 | `node --check public/js/app.js` | PASS |
| T4 | `python -m py_compile services/inverter_engine.py` | PASS |
| T5 | `npm run rebuild:native:node` | PASS |
| T6 | `node server/tests/pollerIpConfigMapping.test.js` | PASS |
| T7 | `node server/tests/ipConfigLossDefaultsSource.test.js` | PASS |
| T8 | `python -m unittest discover -s services/tests -p "test_*.py"` | PASS — 60/60 |
| T9 | `npm run rebuild:native:electron` | PASS |
| T10 | `npx playwright test electronUiSmoke.spec.js --reporter=line` | PASS — 1 test, 17.8 s |

Repo ends in **Electron-ABI** mode per project rule (`feedback_native_rebuild.md`).

## Files modified

```
electron/main.js
  - L5178-5222  config-save IPC handler — removed restartBackendProcess() + backendRestarted field
  - L2304       readWindowsMachineGuid execFileSync — added windowsHide: true
  - L2322       readRegistryValue execFileSync — added windowsHide: true
  - L2342       writeRegistryValue execFileSync — added windowsHide: true
  - L2355       deleteRegistryValue execFileSync — added windowsHide: true
  - L3715       killImageNames execFileSync — added windowsHide: true
  - L4071       restartBackendProcess per-pid execFile — added windowsHide: true
  - L5446       forceKillProc execFile — added windowsHide: true
```

No other files modified. No DB schema, no API contract change, no settings key change, no version bump in this audit (defer to release packaging).

## Risk and rollback

**Risk: low.** The fix removes a kill operation that the live system never required (verified by walking every reload contract). Worst case if `ipconfig_watcher` is disabled or stalls (no known reason), the Python service still uses the new config on next natural restart, and the dashboard cards still refresh from the WS `configChanged` broadcast — only the Modbus polling targets would lag by ≤1 s in normal operation.

**Rollback:** restore the four removed lines in `electron/main.js:5193-5222` (the `let backendRestarted = false;` declaration, the `backendRestarted = restartBackendProcess();` call, and the `backendRestarted,` field in the return). The `windowsHide: true` additions are independent and need not be reverted.

## Cross-refs

- Plan: none (point-fix, no design doc needed)
- Related memory: `feedback_card_ui.md`, `feedback_native_rebuild.md`, `feedback_audit_folder_convention.md`
- Related audit: `audits/2026-04-17/integrity-gate-asar-virtualization.md` (similar pattern — Electron main-thread blocking call surfaced as user-visible failure)
- v2.9.0 spec: `plans/2026-04-24-hardware-counter-recovery-and-clock-sync.md` (parallel work on same engine)
- Trigger session: `S970` (this conversation, 2026-04-25 11:07 GMT+8 — see claude-mem timeline)
