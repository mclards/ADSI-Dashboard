# Audit 2026-04-14 — v2.8.8 Confidence Release

Self-contained record of the comprehensive bug sweep and Phase-1 remediation that shipped as v2.8.8 on 2026-04-14.

## Reading order

| Order | File | Purpose |
|---|---|---|
| 1 | [CHANGELOG_v2.8.8.md](CHANGELOG_v2.8.8.md) | Short release summary, one-liner per fix, upgrade notes |
| 2 | [BUG_SWEEP.md](BUG_SWEEP.md) | The full 123-finding audit (frozen baseline; do not edit) |
| 3 | [FIXES_PROGRESS.md](FIXES_PROGRESS.md) | What shipped, commit by commit |
| 4 | [FIX_DEBUG_INDEX.md](FIX_DEBUG_INDEX.md) | Per-fix file:line anchors, log signatures, rollback commands, symptom-if-misbehaving table, post-release monitoring checklist |
| 5 | [KNOWN_GAPS.md](KNOWN_GAPS.md) | What was deliberately NOT fixed (100-item HIGH/MED/LOW backlog, partial fixes, audit coverage gaps, verification gaps, tooling gaps, symptom → known-gap grep table) |
| 6 | [PHASE2_FIXES.md](PHASE2_FIXES.md) | Post-v2.8.8 session that closed T4.4 (Node-side lock), verified T6.3 thumbprint, and fixed T2.10/T2.11/T2.12/T5.4. Read alongside KNOWN_GAPS.md — its "closed" table amends that doc until it is regenerated. |
| 7 | [PHASE3_FIXES.md](PHASE3_FIXES.md) | Post-Phase-2 session that closed Electron hardening (T6.7/T6.9/T6.10/T6.11) and frontend tail (T5.5/T5.6/T5.7/T5.8). Same amend convention as Phase 2. |
| 8 | [SMOKE_BASELINE.md](SMOKE_BASELINE.md) | First end-to-end run of the new T7.3 smoke harness (`scripts/smoke-all.js`). Records Phase-2/3 verification result (zero regressions) and catalogues 5 pre-existing Node-test failures for triage. |
| 9 | [PHASE5_FIXES.md](PHASE5_FIXES.md) | Phase 5 — Node subsystem hardening: T2.3 (token bind), T2.4 (token-store key), T2.5 (alarm dedup on restart), T2.6 (cap math clamp), T2.7 (go2rtc spawn cleanup), T2.8 (snapshot capture serialisation), T2.9 (streaming backoff cap). Smoke-verified zero regressions. |
| 10 | [PHASE6_FIXES.md](PHASE6_FIXES.md) | Phase 6 — Python inverter engine: T3.6 (poll task isolation), T3.7 (Modbus FD leak), T3.8 (lock review, no change), T3.9 (atomic map swap), T3.10 (per-read timeout refresh), T3.11 (bounded write queue + 429), T3.12 (post-write read-back verify). Smoke-verified. |
| 11 | [PHASE7_FIXES.md](PHASE7_FIXES.md) | Phase 7 — Python forecast engine: T4.6 (reliability dimension logs), T4.7 (clock robustness), T4.8 (legacy-model WARN), T4.9 (LightGBM reason exposure), T4.10 (reviewed, no change), T4.11 (deferred to v2.9.0), T4.12 (regime sample floor at prediction). 107/107 Python tests pass. |
| 12 | [PHASE8_BACKLOG_SWEEP.md](PHASE8_BACKLOG_SWEEP.md) | Phase 8 — full MEDIUM/LOW backlog sweep closing remaining items from §1 KNOWN_GAPS. 9 actionable fixes, 22 verified already-correct, 31 deliberately deferred (with reasoning). After Phase 8, **all actionable audit findings are closed**. |
| 13 | [SMOKE_BASELINE.md § Resolution](SMOKE_BASELINE.md#resolution-of-pre-existing-failures-2026-04-15-commit-8f04883) | 2026-04-15 follow-on (commit `8f04883`) — closed all 5 pre-existing Node test failures. Surfaced one production regression (`roundSolcastExportNumber` digits default v2.4.38 → 1). Smoke baseline now **29/29 + 107/107**. |

## When to use which file

- **Debugging something post-v2.8.8** → [FIX_DEBUG_INDEX.md](FIX_DEBUG_INDEX.md) § Post-release monitoring; then [KNOWN_GAPS.md](KNOWN_GAPS.md) § 7 (symptom → gap) before filing a new bug.
- **Planning v2.8.9** → [KNOWN_GAPS.md](KNOWN_GAPS.md) § 1 and § 2 (untouched backlog + partial fixes); then [BUG_SWEEP.md](BUG_SWEEP.md) tracks T1–T6 for HIGH findings.
- **Running the next audit** → [KNOWN_GAPS.md](KNOWN_GAPS.md) § 5.3 (agent-orchestration lessons).
- **Writing release notes** → copy [CHANGELOG_v2.8.8.md](CHANGELOG_v2.8.8.md).
- **Rolling back a fix** → [FIX_DEBUG_INDEX.md](FIX_DEBUG_INDEX.md) § Rollback tips.

## Commit index for this audit

Phase 1 (v2.8.8 release):

```
b153d69  Document v2.8.8 gaps + per-fix debug index + changelog + docs README
0d4f8b9  Document v2.8.8 CRITICAL-fix progress log
8d9e949  Fix Phase 1F (v2.8.8): Electron hardening + version sync
250cdd4  Fix Phase 1E (v2.8.8): Frontend memory/integrity hardening
9fcd6bf  Fix Phase 1D (v2.8.8): Node subsystem security
0402ff7  Fix Phase 1C (v2.8.8): Forecast ML correctness
d1c6081  Fix Phase 1B (v2.8.8): Inverter write-control safety
974be7f  Fix Phase 1A (v2.8.8): SQL injection, export yields, pressure-retry
1d88c8e  Document comprehensive v2.8.8 bug sweep: 123 findings across 8 tracks
```

Phase 2 + Phase 3 + Phase 4 + Phase 5 (post-v2.8.8, pre-v2.8.9):

```
6ca5a66  Fix Phase 2 backend: T4.4 forecast lock + T2.10/T2.11/T2.12
eb1057b  Fix Phase 3 Electron: T6.7/T6.9/T6.10/T6.11 hardening
f83c131  Fix Phase 2+3 frontend: T5.4/T5.5/T5.6/T5.7/T5.8
fb36a19  Document Phase 2 + Phase 3 fixes
a5fed94  Add T7.3 smoke harness + first baseline run (Phase 4)
6d2abec  Fix Phase 5 Node subsystem: T2.3-T2.9
cacf31d  Document Phase 5 Node subsystem fixes
e0eb77b  Fix Phase 6 Python inverter: T3.6-T3.12
183a082  Document Phase 6 Python inverter engine fixes
1b96979  Fix Phase 7 Python forecast: T4.6-T4.12
da9f025  Document Phase 7 Python forecast engine fixes
048d94e  Fix Phase 8 backlog sweep: 9 point-fixes across 5 files
d2cecfe  Document Phase 8 backlog sweep
17f9d8e  Address Phase 8 code-review findings
8f04883  Clear smoke baseline: fix 5 pre-existing Node test failures
```

**Verified phase landmarks** (2026-04-15) — every Phase 2–8 fix has been re-grepped against current source and confirmed in place:

| Phase | Sentinel | Location |
|---|---|---|
| 2 — T4.4 | `forecastGenLock` module + `withForecastGenLock` call | `server/forecastGenLock.js`, `server/index.js:22,15278` |
| 2 — T5.4 | Chart.js y-axis hardening comment | `public/js/app.js:1817` |
| 3 — Electron hardening | `nodeIntegration:false, contextIsolation:true, webSecurity:true` on every window | `electron/main.js:1623,1715,3675,3836,…` |
| 4 — T7.3 | T7.3 smoke harness | `scripts/smoke-all.js` |
| 5 — T2.5 | `hydrateActiveAlarmStateFromDb()` | `server/alarms.js:191,445` |
| 5 — T2.6 | `clampInt(…)` cap math | `server/plantCapController.js:18,127` |
| 5 — T2.7 | `process.kill(pid, "SIGKILL")` cleanup | `server/go2rtcManager.js:304` |
| 6 — T3.7 | Modbus socket close-on-exception comment | `drivers/modbus_tcp.py:6-15,32` |
| 6 — T3.9 | `static_units = new_static_units` atomic rebind | `services/inverter_engine.py:1149` |
| 6 — T3.11 | `Queue(maxsize=64)` write queue | `services/inverter_engine.py:1168` |
| 6 — T3.12 | Post-write read-back comment + verify | `services/inverter_engine.py:566,600,621` |
| 7 — T4.7/4.8/4.9 | `_LIGHTGBM_IMPORT_ERROR`, `_reliability_fallback_notified`, `_legacy_model_truncate_notified` (module scope) | `services/forecast_engine.py:49,67,68` |
| 7 — T4.12 | `regime_confidence < 0.6` gate | `services/forecast_engine.py:8250` |
| 8 — T1.5 | `remoteLiveFetchController.abort()` before overwrite | `server/index.js:6361,6644` |
| 8 — T2.13 | `_dbDirFallbackLogged` one-time INFO log | `server/storagePaths.js:48,52,62` |
| 8 — T2.18 | SIGTERM → `stopCameraStream()` | `server/streaming.js:124,148,154` |
| 8 — T3.13/3.18 | `/health` endpoint | `services/inverter_engine.py:1446` |
| 8 — T3.14 | `CORSMiddleware` restricted `_cors_origins` | `services/inverter_engine.py:60` |
| 8 — T3.17 | `_pac_clamp_notified` set + WARN | `services/inverter_engine.py:216,1317` |
| 8 — T3.20 | Empty-inverters startup WARNING | `services/inverter_engine.py:1722` |

---

**Heads-up when reading older commit messages** — these audit docs lived under `docs/` (with longer `*_2026-04-14.md` filenames) in commits `1d88c8e` through `b153d69`. They moved to this folder after the fix commits; filenames were simplified since the folder now carries the date. Use `git log --follow audits/2026-04-14/<file>` to walk the history across the rename.
