# v2.8.8 — Confidence release (23 CRITICAL remediations)

**Tag:** `v2.8.8` · **Baseline commit:** `0d4f8b9` · **Date:** 2026-04-14

All changes are **backwards compatible** with v2.8.7 data on disk. No schema migrations. No `appId` change.

---

## Highlights

Security + reliability sweep across the entire stack (Node / Python / Electron / frontend). 123 issues found, 23 CRITICAL shipped. Every fix is linked below to the exact commit and a debug pointer.

**Operator-visible behaviour changes:**
- Double-launching the installed app now focuses the running instance instead of starting a second copy (T6.1).
- The `/write` API now returns HTTP 400 for out-of-range unit (≠1..4) or value (≠0/1) instead of silently forwarding to Modbus (T3.1 / T3.2).
- Auto-reset is suppressed for 5 s after an operator write on the same (inverter, unit), so manual control won't immediately be undone (T3.5).
- `shell.openExternal` from the renderer now only accepts `http/https/mailto` URLs — `file://`, `javascript:`, `data:` schemes are blocked (T6.5).
- Auto-updater now verifies the installer's signer certificate thumbprint as a secondary defence to the SHA-512 integrity check (T6.3).

**Silent correctness fixes:**
- Forecast ML training no longer mislabels past-date Solcast snapshots as real tri-band data (T4.1 / T4.2).
- Long alarms / audit exports no longer block the polling event loop (T1.2).
- Concurrent backup + restore calls are serialised (T2.2).

---

## Shipped CRITICALs

| ID | Area | Commit | What changed |
|---|---|---|---|
| T1.1 | server/index.js | `974be7f` | Replication merge — whitelist `tableName` before dynamic SQL |
| T1.2 | server/exporter.js | `974be7f` | Alarm + audit exports — yield to event loop around heavy `.all()` |
| T1.4 | server/poller.js | `974be7f` | Pressure-retry callback wrapped in try/catch |
| T3.1 | services/inverter_engine.py | `d1c6081` | `/write` + `/write/batch` validate `unit ∈ {1..4}` |
| T3.2 | services/inverter_engine.py | `d1c6081` | `/write` + `/write/batch` validate `value ∈ {0,1}` |
| T3.3 | services/inverter_engine.py | `d1c6081` | Atomic mark+enqueue to close TOCTOU on `write_pending` |
| T3.4 | services/inverter_engine.py | `d1c6081` | Worker re-validates each step at dequeue time |
| T3.5 | services/inverter_engine.py | `d1c6081` | 5-s operator-write hold on auto-reset transitions |
| T4.1 | services/forecast_engine.py | `0402ff7` | `has_real_triband` distinguishes past-date fallback |
| T4.2 | services/forecast_engine.py | `0402ff7` | `triband_data_quality_flag` exposed for training filters |
| T4.3 | services/forecast_engine.py | `0402ff7` | Spread-ratio guard raised 0.1 → 0.5 kWh + `np.nan_to_num` |
| T4.4 | services/forecast_engine.py | `0402ff7` | Advisory lock file for day-ahead generation (Python-side) |
| T4.5 | services/forecast_engine.py | `0402ff7` | `prediction_error` surfaced to caller + `_ml_failed` flag |
| T2.1 | server/bulkControlAuth.js + index.js | `9fcd6bf` | Single clock capture across paired auth operations |
| T2.2 | server/cloudBackup.js | `9fcd6bf` | Mutex on backup / restore public entry points |
| T5.1 | public/js/app.js | `250cdd4` | Idempotent theme-toggle listeners |
| T5.2 | public/js/app.js | `250cdd4` | WS parse errors log full Error + payload excerpt |
| T5.3 | public/js/app.js | `250cdd4` | Theme-modal backdrop listener de-duped on rapid re-open |
| T6.1 | electron/main.js | `8d9e949` | `app.requestSingleInstanceLock()` |
| T6.2 | electron/main.js | `8d9e949` | `open-ip` IPC rejects non-IPv4 / scheme-injected input |
| T6.3 | electron/main.js | `8d9e949` | `autoUpdater` thumbprint secondary check |
| T6.4 | electron/main.js | `8d9e949` | Backend subprocess `spawn` success listener |
| T6.5 | electron/main.js | `8d9e949` | `shell.openExternal` URL scheme whitelist |
| T6.6 | package.json + 4 docs | `8d9e949` | Version sync to 2.8.8 (SKILL.md was stale at 2.8.6) |

Full per-fix file:line anchors, symptom-if-misbehaving, and rollback commands: [FIX_DEBUG_INDEX_2026-04-14.md](FIX_DEBUG_INDEX_2026-04-14.md).

---

## Known gaps carried forward to v2.8.9+

Full list: [KNOWN_GAPS_2026-04-14.md](KNOWN_GAPS_2026-04-14.md). Highest-impact:

- **T4.4 Node-side coordination** — Python-side lock only; Node orchestrator can still write a late audit row.
- **T6.3 thumbprint is hardcoded** — will break updates silently if cert rotates; move to config.
- **T2.10 / T2.11** — `pullFromCloud`, `createPortableBackup`, `importPortableBackup` not yet mutex-wrapped.
- **38 HIGH findings** untouched — scheduled for v2.8.9 Phase 2.
- **Node test suite** (`server/tests/*.test.js`) never run this session (repo in Electron ABI). T7.3 (ABI-toggle smoke script) is the highest-value tooling task next.
- **No `npm audit` / `pip-audit`** — dependency CVEs not reviewed.
- **No Playwright E2E** — no behavioural verification of the fixes.

---

## Upgrade notes

- **From v2.8.7**: drop-in. No migration required. Installer auto-updater will carry the update forward.
- **Signer cert**: before shipping this build, verify the installer thumbprint matches the constant in `electron/main.js` (`EXPECTED_SIGNER_THUMBPRINT`). If it doesn't match, every post-v2.8.8 auto-update will refuse itself silently. Rotation procedure: update the constant, sign + release.
- **Python services rebuilt**: `InverterCoreService.exe` and `ForecastCoreService.exe` must be rebuilt — both engines have code changes. Per memory `feedback_python_release_full_rebuild.md`, do NOT take the "Python-only" shortcut.

---

## Commit index

```
0d4f8b9 Document v2.8.8 CRITICAL-fix progress log
8d9e949 Fix Phase 1F (v2.8.8): Electron hardening + version sync
250cdd4 Fix Phase 1E (v2.8.8): Frontend memory/integrity hardening
9fcd6bf Fix Phase 1D (v2.8.8): Node subsystem security (auth, backup mutex)
0402ff7 Fix Phase 1C (v2.8.8): Forecast ML correctness
d1c6081 Fix Phase 1B (v2.8.8): Inverter write-control safety
974be7f Fix Phase 1A (v2.8.8): SQL injection, export yield gaps, pressure-retry guard
1d88c8e Document comprehensive v2.8.8 bug sweep: 123 findings across 8 tracks
```
