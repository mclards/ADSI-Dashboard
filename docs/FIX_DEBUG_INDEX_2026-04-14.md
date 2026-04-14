# v2.8.8 Fix Debug Index

**Purpose:** everything a future debugger needs to (a) locate a fix, (b) judge whether it's misbehaving, and (c) roll it back safely.

**Companion docs:**
- [BUG_SWEEP_2026-04-14.md](BUG_SWEEP_2026-04-14.md) — the 123-finding audit
- [FIXES_PROGRESS_2026-04-14.md](FIXES_PROGRESS_2026-04-14.md) — what shipped
- [KNOWN_GAPS_2026-04-14.md](KNOWN_GAPS_2026-04-14.md) — what did NOT ship

Each row below = one shipped CRITICAL.
- **Locator** = grep string (works from repo root) that uniquely finds the change
- **Rollback** = command to revert just that fix
- **Symptom-if-misbehaving** = what you'd see in logs if the fix itself introduced a regression

---

## Phase 1A — Data integrity & SQL safety (commit `974be7f`)

### T1.1 — Replication SQL-table whitelist

| Field | Value |
|---|---|
| Files touched | `server/index.js` |
| Insertion points | declared `REPLICATION_ALLOWED_TABLES` + `assertReplicationTableAllowed()` above `stmtCached`; called at both dynamic-SQL construction sites |
| Locator (grep) | `REPLICATION_ALLOWED_TABLES` |
| Log signature | `replication: rejected non-whitelisted tableName=` (thrown as Error — surfaces in server error log + stops the merge transaction) |
| Symptom if misbehaving | Legitimate replication payloads rejected → pull/push snapshot diverges. If you see `replication: rejected` for a table that IS in `REPLICATION_TABLE_DEFS`, the whitelist is out of sync with the defs array (update both together). |
| Rollback | `git revert 974be7f -- server/index.js` (Phase 1A commit also includes T1.2/T1.4; see per-hunk rollback in §Rollback tips below) |
| Runtime verification | Hit `/api/internal/replication/apply` with a forged `tables.FOO` key where `FOO` is not a whitelisted table; server should log the rejection and skip the row. |

### T1.2 — Event-loop yield in alarm / audit exports

| Field | Value |
|---|---|
| Files touched | `server/exporter.js` |
| Insertion points | `exportAlarms` (line ≈1362 area) and `exportAudit` (line ≈1615 area) now have `await yieldToEventLoop()` immediately before and after their `db.prepare(...).all(...)` block |
| Locator | `// T1.2 fix: yield before .all` |
| Log signature | None — silent fix. Behaviour change visible only via `pollStats.pendingReadingQueueHighWater` staying lower during long exports. |
| Symptom if misbehaving | Export produces wrong row count (yield mid-transaction would only matter if someone wrapped the export in `db.transaction(...)`, which they haven't). |
| Rollback | `git revert 974be7f -- server/exporter.js` |
| Runtime verification | Start 366-day alarm export while polling; observe `pollStats` — `pendingReadingQueueHighWater` should stay < 50 (was spiking > 500 pre-fix). |

### T1.4 — Pressure-retry callback guard

| Field | Value |
|---|---|
| Files touched | `server/poller.js` |
| Insertion point | Line ≈830 — `setTimeout(() => { try { flushPersistBacklog... } catch ...})`  |
| Locator | `T1.4 fix: guard the async callback` |
| Log signature | `[poller] pressure-retry callback threw:` (console.error) — fires only on failure of the callback itself |
| Symptom if misbehaving | If the inner `flushPersistBacklog` was relying on the caller catching a rethrow, that chain is now silenced. Current code does not rely on that — it already treats retries as best-effort. |
| Rollback | `git revert 974be7f -- server/poller.js` |
| Runtime verification | Inject a thrown Error into `flushPersistBacklog` under test; confirm `[poller] pressure-retry callback threw` appears in logs and server keeps running. |

---

## Phase 1B — Inverter write-control safety (commit `d1c6081`)

### T3.1 / T3.2 — `/write` and `/write/batch` input validation

| Field | Value |
|---|---|
| Files touched | `services/inverter_engine.py` |
| Insertion point | Top of `write_command` (line ≈1296) and `write_batch_command` (line ≈1395) |
| Locator | `T3.1 fix: validate unit range` · `T3.2 fix` |
| Log signature | None from the server side — just a 400 JSON response with `"msg": "invalid unit (must be 1..4)"` or `"invalid value (must be 0 or 1)"` |
| Symptom if misbehaving | Legitimate writes returning 400. Check: the frontend must always send `unit ∈ {1,2,3,4}` and `value ∈ {0,1}` — if those bounds ever legitimately change (e.g. new inverter model with 5+ nodes), update the constants here AND in `_sanitize_write_units` AND in the worker re-validation (T3.4). |
| Rollback | `git revert d1c6081 -- services/inverter_engine.py` (will revert all of Phase 1B; use hunk-mode revert if you need only T3.1) |
| Runtime verification | `curl -XPOST http://127.0.0.1:9000/write -d '{"inverter":1,"unit":-1,"value":1}'` → HTTP 400 with `"invalid unit"`. |

### T3.3 — TOCTOU on `write_pending`

| Field | Value |
|---|---|
| Files touched | `services/inverter_engine.py` |
| Insertion points | (a) module-level `write_pending_lock` (line ≈183), (b) `enqueue_write_atomically(ip, job)` helper after `mark_write_pending` (line ≈645), (c) worker-loop two clear sites now inside `with write_pending_lock:` |
| Locator | `write_pending_lock` OR `enqueue_write_atomically` |
| Log signature | None (silent correctness fix). |
| Symptom if misbehaving | Write latency noticeably up under load (lock contention) — look for throughput drop correlated with multi-inverter dispatch storms. Or a write getting stuck "pending" forever — if the event is never cleared, `is_write_pending(ip)` returns True indefinitely and polling stays in slow-write-mode. |
| Rollback | Hunk-revert is messy (mixed with T3.4 / T3.5 in the same commit); easier to `git revert d1c6081` and re-apply T3.1/T3.2/T3.4/T3.5 manually if only T3.3 needs to go. |
| Runtime verification | Stress: 1000 concurrent `/write` calls across 27 inverters; assert zero dropped writes per inverter log. |

### T3.4 — Worker-level revalidation

| Field | Value |
|---|---|
| Files touched | `services/inverter_engine.py` (write worker loop, ~line 495) |
| Locator | `T3.4 fix: re-validate each step at dequeue time` |
| Log signature | `[write_worker] rejecting invalid step ip=...` (print — goes to service stdout / PyInstaller console) |
| Symptom if misbehaving | Legitimate writes dropped at dequeue with "invalid step" log — would indicate a bug in the enqueue-side validators (T3.1/T3.2) that let through a bad payload, or the constants diverged. |
| Runtime verification | Inject a crafted queue item (via test) with unit=99 or value=-1; confirm the worker logs and drops. |

### T3.5 — Operator-write hold on auto-reset

| Field | Value |
|---|---|
| Files touched | `services/inverter_engine.py` |
| Insertion points | (a) module-level `last_operator_write_ts` + `AUTO_RESET_WRITE_HOLD_SEC` (line ≈185), (b) `note_operator_write` / `operator_write_hold_active` helpers (line ≈665), (c) `handle_auto_reset` checks the hold at both `armed → OFF` and `waiting_clear → ON` paths |
| Locator | `operator_write_hold_active` OR `AUTO_RESET_WRITE_HOLD_SEC` |
| Log signature | None (the check silently returns). Indirect signature: absence of `[AUTORESET] OFF OK` for 5 s after an operator write. |
| Symptom if misbehaving | Auto-reset never firing after ANY operator write (would indicate the hold timestamp never expires — check `time.monotonic()` math). Or auto-reset firing during the hold window (would indicate the check is wired wrong). |
| Runtime verification | Issue `/write` on (inverter=1, unit=1); within 5 s, trigger an auto-reset-able alarm on the same (inverter, unit). The auto-reset should NOT fire. Wait 6 s; alarm should now process normally. |

---

## Phase 1C — Forecast ML correctness (commit `0402ff7`)

### T4.1 / T4.2 — Tri-band past-date flag

| Field | Value |
|---|---|
| Files touched | `services/forecast_engine.py`, `services/tests/test_forecast_engine_triband.py` |
| Insertion points | `solcast_prior_from_snapshot` now exposes `has_real_triband`, `triband_data_quality_flag`, `is_past_date` in its return dict (line ≈5130 area). `build_features` gates the tri-band feature block on `has_real_triband` (line ≈2618). Test `test_collect_training_data_hardened_mixed` updated to reflect new semantics. |
| Locator | `has_real_triband` OR `triband_data_quality_flag` |
| Log signature | None (silent correctness change). |
| Symptom if misbehaving | ML training loss stops improving / regime features oddly flat — check that `has_real_triband` is True for live training runs (not only backtest). Debug with `log.info` in `solcast_prior_from_snapshot` printing `is_past_date` and `triband_data_quality_flag`. |
| Rollback | `git revert 0402ff7` (reverts all of Phase 1C) |
| Runtime verification | Python test `pytest services/tests/test_forecast_engine_triband.py -v` — all 4 tri-band tests must pass; `test_collect_training_data_hardened_mixed` asserts spread bounds only (not presence of non-zero). |

### T4.3 — Spread-ratio guard + NaN sanitisation

| Field | Value |
|---|---|
| Files touched | `services/forecast_engine.py` (lines ≈2665-2685) |
| Locator | `# T4.3 fix: raise the denominator guard from 0.1 to 0.5` |
| Log signature | None. |
| Symptom if misbehaving | Sudden `NaN`/`inf` warnings from sklearn / LightGBM would indicate the `np.nan_to_num` calls aren't catching the producer. Rare — the raised guard (0.5 kWh) makes it very unlikely to fire. |
| Runtime verification | Construct a test snapshot where `forecast_kwh[i] = 0.2` for some slot `i`; call `build_features` and assert `np.all(np.isfinite(features["solcast_spread_ratio"]))`. |

### T4.4 — Advisory lock on day-ahead generation (Python side)

| Field | Value |
|---|---|
| Files touched | `services/forecast_engine.py` |
| Insertion points | (a) `DAYAHEAD_GEN_LOCK_DIR` + `DAYAHEAD_GEN_LOCK_MAX_AGE_SEC` constants (≈line 145), (b) `_dayahead_gen_lock_{path,acquire,release}` helpers before `_delegate_run_dayahead` (≈line 11540), (c) `_delegate_run_dayahead` wraps its body in acquire/try/finally-release, (d) three fallback sites (`manual_cli_fallback`, `auto_service_fallback` for both target and recovery) wrap `run_dayahead` in acquire/release |
| Locator | `DAYAHEAD_GEN_LOCK_DIR` OR `_dayahead_gen_lock_acquire` |
| Log signature | `Day-ahead gen lock busy for <date> (owner=..., age=...s)` (warn) → skip. `Day-ahead gen lock for <date> is stale (...s old) — force-acquiring` (info). `Could not acquire day-ahead gen lock for <date>: ...` (warn — proceeds without lock). |
| Symptom if misbehaving | Forecast generation **never runs** — check `APP_DB_FILE.parent/locks/dayahead_*.lock` for stuck files with recent mtime but no live PID. The 300 s max age should self-heal; if it doesn't, manually `rm` the lock. |
| Runtime verification | Fire two `_delegate_run_dayahead` in parallel via Python REPL; second must return None with `"lock busy"` in logs. |
| Known limitation | Node orchestrator does NOT respect this lock — see [KNOWN_GAPS §2 T4.4](KNOWN_GAPS_2026-04-14.md). |

### T4.5 — ML prediction error surfacing

| Field | Value |
|---|---|
| Files touched | `services/forecast_engine.py` (caller at ≈line 10515) |
| Locator | `T4.5 fix: surface prediction failures` |
| Log signature | `ML global prediction error surfaced to caller: <err>` (log.error) OR `ML regime prediction error surfaced: <err>` (log.warn). |
| Symptom if misbehaving | If the caller repeatedly logs "ML global prediction error" yet the forecast still "succeeds", the `_ml_failed` flag isn't propagating to the audit layer. Check downstream usage of `_ml_failed`. |
| Runtime verification | Inject `raise ValueError("test")` into `global_model.predict` (via mock); confirm the error is logged and `_ml_failed=True` by end of `run_dayahead`. |

---

## Phase 1D — Node subsystem security (commit `9fcd6bf`)

### T2.1 — Single clock capture for paired auth ops

| Field | Value |
|---|---|
| Files touched | `server/bulkControlAuth.js`, `server/index.js` |
| Insertion points | (a) `bulkControlAuth.js getPlantWideAuthKeys` now captures `baseMs` once (comment block), (b) route handler `POST /api/write/auth/bulk` captures `nowMs = Date.now()` once and threads it (line ≈12672), (c) `isAuthorizedPlantWideControl` does the same |
| Locator | `T2.1 fix` in either file |
| Log signature | None. |
| Symptom if misbehaving | Auth failures only at minute boundaries (would indicate `nowMs` threading broke somewhere — check if any code path still calls `isValidPlantWideAuthKey(key)` without passing the explicit `nowMs`). |
| Runtime verification | `bulkControlAuth.test.js` covers this. Run via `npm run rebuild:native:node && node server/tests/bulkControlAuth.test.js && npm run rebuild:native:electron`. |

### T2.2 — Backup / restore mutex

| Field | Value |
|---|---|
| Files touched | `server/cloudBackup.js` |
| Insertion points | (a) `_backupOpChain = Promise.resolve()` in constructor, (b) `_withBackupMutex(label, fn)` helper, (c) public `backupNow` / `restoreBackup` / `restorePortableBackup` now delegate to `_XxxLocked` via the mutex |
| Locator | `_withBackupMutex` OR `_backupOpChain` |
| Log signature | None today. If you want observability, add `console.log("[cloudBackup] acquired mutex:", label)` inside the helper during debugging. |
| Symptom if misbehaving | Restore hanging forever — check that `_backupNowLocked` or the internal `createLocalBackup` (pre-restore safety snapshot) isn't reentering `_withBackupMutex`. **The internal createLocalBackup call during restoreBackup MUST NOT go through the mutex** — that would deadlock. Comment in the helper's JSDoc explains. |
| Rollback | `git revert 9fcd6bf -- server/cloudBackup.js` |
| Runtime verification | Script: fire `POST /api/backup/create` and `POST /api/backup/restore/<id>` simultaneously from two tabs; verify `_setProgress` calls are serialised (status field transitions sequentially, never mixed). |
| Known limitation | `pullFromCloud`, `createPortableBackup`, `importPortableBackup` NOT yet wrapped — [KNOWN_GAPS §1 T2.10/T2.11](KNOWN_GAPS_2026-04-14.md). |

---

## Phase 1E — Frontend memory/integrity (commit `250cdd4`)

### T5.1 — Idempotent theme-toggle listeners

| Field | Value |
|---|---|
| Files touched | `public/js/app.js` (lines ≈2024-2050) |
| Locator | `_themeToggleEscapeHandler` OR `_themeToggleOpenHandler` |
| Log signature | None. |
| Symptom if misbehaving | Escape key doesn't close theme modal → the remove-then-add didn't attach. Probably a naming drift — ensure both the remove and the add reference the SAME function constant. |
| Runtime verification | DevTools on the running dashboard: `getEventListeners(document).keydown.length` should stay at 1 across navigations. |

### T5.2 — WebSocket parse-error payload excerpt

| Field | Value |
|---|---|
| Files touched | `public/js/app.js` (line ≈11440) |
| Locator | `T5.2 fix: surface enough context` |
| Log signature | `[ws] message handling failed: <Error> payload excerpt: <str>` (console.error) |
| Symptom if misbehaving | If payloads are huge, the `.slice(0, 500)` excerpt might leak a secret into console. Current dashboard WS never carries secrets, but if that changes, reduce excerpt length or redact. |
| Runtime verification | Via DevTools: `State.ws.onmessage({ data: "{not json" })` — console.error should fire with the excerpt and full Error. |

### T5.3 — Modal backdrop listener de-dup

| Field | Value |
|---|---|
| Files touched | `public/js/app.js` (line ≈1999) |
| Locator | `T5.3 fix: rapid re-opens used to stack backdrop handlers` |
| Log signature | None. |
| Symptom if misbehaving | Modal stops closing on backdrop click. Check that `modal._backdropHandler` attachment survives the open path (not nulled between open and register). |

---

## Phase 1F — Electron hardening (commit `8d9e949`)

### T6.1 — Single-instance lock

| Field | Value |
|---|---|
| Files touched | `electron/main.js` (lines ≈23-50) |
| Locator | `requestSingleInstanceLock` OR `_gotSingleInstanceLock` |
| Log signature | `[main] Another instance is already running — quitting this one.` (console.warn) on the losing side. `[main] second-instance focus failed:` if the re-focus path throws. |
| Symptom if misbehaving | First instance doesn't receive focus when a second launch attempts → check `BrowserWindow.getAllWindows()` is populated at that moment. |
| Runtime verification | Double-click the installed-app shortcut twice. Second attempt should exit instantly; first window should come to front. |

### T6.2 — `open-ip` IPv4 validation

| Field | Value |
|---|---|
| Files touched | `electron/main.js` (lines ≈4593-4650) |
| Locator | `sanitizeInverterIpHost` |
| Log signature | `[main] open-ip rejected invalid input: <truncated input>` (console.warn) |
| Symptom if misbehaving | Legit inverter IPs rejected — most likely cause is the octet or port regex being too strict if IPv6 is ever added (currently the regex enforces IPv4 `[0-255].[0-255].[0-255].[0-255]`). |
| Runtime verification | From DevTools: `window.api.send("open-ip", "file:///etc/passwd")` — nothing should happen, server logs should show the rejection. |

### T6.3 — autoUpdater thumbprint

| Field | Value |
|---|---|
| Files touched | `electron/main.js` (lines ≈670-730) |
| Locator | `EXPECTED_SIGNER_THUMBPRINT` |
| Log signature | `verifyUpdateCodeSignature: thumbprint match (...)` (info) = success. `THUMBPRINT MISMATCH — refusing update.` (error) = reject. `check errored — accepting (SHA-512 remains authoritative)` (warn) = PowerShell unreachable fallback. |
| **CRITICAL pre-release check** | Before shipping v2.8.8, run `Get-AuthenticodeSignature release/Inverter-Dashboard-Setup-2.8.7.exe | Select-Object ... Thumbprint` and ensure the value matches `44CD054E69D04011DAA8FB2B60127F1F6EB99C0E`. If not, bump the constant — otherwise every auto-update after v2.8.8 will silently refuse itself. |
| Rollback | `git revert 8d9e949 -- electron/main.js` (also reverts T6.1/T6.2/T6.4/T6.5) — or hunk-revert just the `verifyUpdateCodeSignature` block |
| Runtime verification | Ship a deliberately-forged `latest.yml` pointing to a differently-signed binary; updater must log `THUMBPRINT MISMATCH` and refuse. |

### T6.4 — Backend `spawn` listener

| Field | Value |
|---|---|
| Files touched | `electron/main.js` (line ≈3360) |
| Locator | `T6.4 fix: observe 'spawn'` |
| Log signature | `[main] Backend spawned OK pid=<N>` (console.log) |
| Symptom if misbehaving | N/A — pure observability addition. |

### T6.5 — `shell.openExternal` URL whitelist

| Field | Value |
|---|---|
| Files touched | `electron/main.js` (lines ≈3700 and ≈960) |
| Locator | `isSafeExternalUrl` |
| Log signature | `[main] blocked openExternal for non-whitelisted URL:` (console.warn) |
| Symptom if misbehaving | Links that used to open externally now blocked → extend `isSafeExternalUrl` to the new scheme explicitly (never return true by default). |

### T6.6 — Version sync

| Field | Value |
|---|---|
| Files touched | `package.json`, `SKILL.md`, `CLAUDE.md`, `AGENTS.md`, `MEMORY.md` |
| Locator | grep `2\.8\.8` across repo — should match package.json, and the four docs; no other source files reference the numeric version. |
| Symptom if misbehaving | UI footer / About dialog reading a hardcoded version string from any source other than `package.json` would drift. Per memory `project_stack.md` and `release_rules.md`, **`package.json` is the version source of truth**; other sources must lag silently rather than shadow. |

---

## Rollback tips

### Revert a single phase cleanly
```
git revert 974be7f   # Phase 1A
git revert d1c6081   # Phase 1B
git revert 0402ff7   # Phase 1C
git revert 9fcd6bf   # Phase 1D
git revert 250cdd4   # Phase 1E
git revert 8d9e949   # Phase 1F
```

### Revert a single fix inside a multi-fix phase

Use `git revert -n <commit>` to stage the full revert, then `git restore --staged <file>` and `git checkout <file>` for the files you want to keep reverted, leaving the rest restored from the commit. Then commit.

Example — revert only T1.4 from `974be7f` (keeping T1.1 and T1.2):
```
git revert -n 974be7f
git restore --staged --worktree server/index.js server/exporter.js
git commit -m "Revert T1.4 only from 974be7f"
```

### Revert the whole v2.8.8 series
```
git revert --no-commit 0d4f8b9 8d9e949 250cdd4 9fcd6bf 0402ff7 d1c6081 974be7f 1d88c8e
git commit -m "Revert v2.8.8 Phase-1 remediation series"
```
Bumps `package.json` back to 2.8.7 automatically via the revert.

---

## Post-release monitoring — what to watch

These are the log signatures that indicate a Phase-1 fix is actively catching something in production. A sudden spike in any of them is worth investigating:

| Log line | What it means |
|---|---|
| `replication: rejected non-whitelisted tableName=` | T1.1 active — someone (or a new feature) is attempting to replicate an un-allow-listed table. Either add to the whitelist or stop the upstream caller. |
| `[poller] pressure-retry callback threw:` | T1.4 active — the backlog-flush retry is hitting an exception. Upstream `flushPersistBacklog` is unhealthy. |
| `[write_worker] rejecting invalid step ip=...` | T3.4 active — a crafted or malformed write reached the worker. Check the API validator (T3.1/T3.2) for a gap. |
| `Day-ahead gen lock busy for` | T4.4 active — two Python generators raced. Expected during manual + scheduler overlap; frequent occurrence indicates the scheduler is firing more than needed. |
| `ML global prediction error surfaced to caller:` | T4.5 active — the residual ML model raised. Expected if the model file is corrupt / mismatched feature count; unexpected otherwise. |
| `verifyUpdateCodeSignature: THUMBPRINT MISMATCH` | T6.3 active — **either an attack attempt OR the cert rotated and the constant is stale** (see [KNOWN_GAPS §2 T6.3](KNOWN_GAPS_2026-04-14.md)). |
| `blocked openExternal for non-whitelisted URL:` | T6.5 active — renderer tried to hand a non-http URL to the OS. |
| `[main] Another instance is already running — quitting` | T6.1 active — double-launch suppressed. |
| `[main] open-ip rejected invalid input:` | T6.2 active — renderer tried to open a non-IPv4 host. |

---

## Dependencies between fixes

Only if you're planning a cherry-pick or partial rollback:

- **T3.3 ↔ T3.4 ↔ T3.5** — all three touch `services/inverter_engine.py` write path. Reverting T3.3 alone is fine; reverting T3.5 alone requires also removing the `note_operator_write` calls added by T3.1/T3.2 routes (they would call an undefined function).
- **T4.1 ↔ T4.2** — both modify `solcast_prior_from_snapshot` return dict. The updated test `test_collect_training_data_hardened_mixed` expects the new semantics — revert together or also revert the test change.
- **T6.1 ↔ T6.4** — both touch `electron/main.js` startup; reverting in any order is fine.
- **T6.3 updater** — reverting leaves `autoUpdater.verifyUpdateCodeSignature` with the **original v2.8.7 bypass**. The SHA-512 check in latest.yml remains the primary defence either way.

---

## Not a fix, but tracked here for future reference

- `docs/BUG_SWEEP_2026-04-14.md` — commit `1d88c8e` — the full 123-finding audit report; **do not modify** (it's the frozen baseline against which Phase 2/3/4 will be measured).
- `docs/FIXES_PROGRESS_2026-04-14.md` — commit `0d4f8b9` — the Phase-1 shipping log.
- `docs/KNOWN_GAPS_2026-04-14.md` — this doc's companion.
- `docs/FIX_DEBUG_INDEX_2026-04-14.md` — this doc.
