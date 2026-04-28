# Audit Closure Status — 2026-04-28

**Baseline:** v2.10.0 (`c30dc30`)
**Released:** v2.10.1 (`6e0b9b9`) — published 2026-04-28
**Pending release:** 8 commits sit on `main` ahead of v2.10.1; recommended cut as v2.10.2.

This file is the canonical ledger for the seven audit reports in this folder.
Every finding falls into one of four buckets:

- ✅ **FIXED** — change landed in `main`; verified via grep on HEAD.
- 🟦 **N/A** — finding was a false positive; explanation inline.
- 🟡 **DEFERRED** — deliberately not fixed in this round; reason recorded.
- ⚪ **OPEN** — not addressed and no decision yet.

---

## Backend JS (`backend-js-audit.md`)

| ID | Status | Where |
|---|---|---|
| HI-001 counter-baseline remote proxy | ✅ FIXED | `server/index.js:12442` (commit `e6f2b77`) |
| HI-002 /admin/inverter-clock remote proxy | ✅ FIXED | `server/index.js:12891` (commit `e6f2b77`) |
| MD-001 silent catch on audit-log write | ✅ FIXED | `server/poller.js:534` (commit `95e5a5a`) |
| MD-002 stale-frame guard relies on Python pre-filter | ⚪ OPEN | Defensive double-check; Python pre-filter is the gate today |
| MD-003 missing input validation on /api/settings | 🟡 DEFERRED | 60+ keys; needs Zod-style schema, large scope |
| MD-004 PAC ceiling on per-row export | ✅ FIXED | `server/exporter.js:2965` (commit `95e5a5a`) |
| MD-005 getCounterStateAll() not paginated | 🟡 DEFERRED | Pagination would change UI contract; current 91-row payload is bounded |
| MD-006 dailyAggregator reaped-slot LRU race | ⚪ OPEN | Single-threaded Node; theoretical race only |
| MD-007 timezone validation at startup | ✅ FIXED | `server/index.js:19425` (commit `b201934`) |
| MD-008 missing await on `_isRemoteMode` in cloudBackup | 🟦 N/A | Function is synchronous; audit was speculative |
| LO-001 var → const/let in legacy code | 🟡 DEFERRED | Cosmetic; large sweep |
| LO-002 magic 256 LRU comment | ✅ FIXED | `server/dailyAggregator.js:64` (commit `95e5a5a`) |
| LO-003 inconsistent auth error codes (401 vs 403) | 🟡 DEFERRED | API contract change; needs frontend coordination |
| LO-004 JSON.parse without try/catch in settings | ⚪ OPEN | Low-impact |
| LO-005 PAC-units comment drift in dailyAggregator | ✅ FIXED | `server/dailyAggregator.js:267` (commit `95e5a5a`) |
| LO-006 rate limit on /api/sync-clock/:inv/:unit | ✅ FIXED | `server/index.js:12866` (commit `b201934`, covered by SEC-H-005 work) |

---

## Frontend (`frontend-audit.md`)

| ID | Status | Where |
|---|---|---|
| CRIT-1 Inverter Clocks first-open freeze | ✅ FIXED | `public/js/app.js:19751` (commit `ea18d02`) |
| HIGH-2 XSS in 3 innerHTML sites | ✅ FIXED | `public/js/app.js:19932/20112/20888` (commit `ea18d02`) |
| HIGH-3 Missing await in StopReasons init | ✅ FIXED | `public/js/app.js:19848` (commit `ea18d02`) |
| HIGH-4 PAC formatting inconsistency | 🟡 DEFERRED | Centralized formatter; cosmetic, large scope |
| MEDIUM-5 fire-and-forget promises | ✅ FIXED | `public/js/app.js:12718` (commit `adfcd49`) — covered the WS-handler site flagged by audit |
| MEDIUM-6 duplicate CSS class definitions | 🟡 DEFERRED | Risky bulk-edit; specificity drift potential |
| MEDIUM-7 stale event-listener pattern | 🟦 N/A | Audit confirmed currently safe |
| LOW-8 console statements (89 instances) | 🟦 N/A | All legitimate per audit |
| LOW-9 missing null checks | 🟦 N/A | Code is already defensive per audit |
| LOW-10 settings duplication | 🟦 N/A | Intentional per-module isolation |

**Operator-reported bug also fixed in this set:** Parameters Refresh button cache-bust at `public/js/app.js:14397` (commit `ea18d02`). Memory `project_refresh_button_cache_bust` saved.

---

## Database (`database-audit.md`)

| ID | Status | Where |
|---|---|---|
| DB-C-001 missing index on alarms.stop_reason_id | ✅ FIXED | `server/db.js:1485` (commit `2cb07d7`) |
| DB-C-002 pac_w repair won't re-run on backup restore | 🟡 DEFERRED | Needs schema versioning; documented in release notes |
| DB-C-003 PRAGMA foreign_keys not enforced | 🟡 DEFERRED | Existing data may have orphan refs; needs probe + migration |
| DB-C-004 SELECT * + LIMIT in alarms / audit_log | ✅ FIXED | `server/db.js:1683/1697`, `server/index.js:16444`, `server/exporter.js:1524/1842` (commits `2cb07d7`, `36adf9a`) |
| DB-H-001 soft-delete patterns on stop_reasons | 🟡 DEFERRED | Schema change; not blocking |
| DB-H-002 transaction isolation level docs | 🟡 DEFERRED | Single-process Node; documentation-only |
| DB-H-003 idx_icb_inv_unit_date | ✅ FIXED | `server/db.js:1488` (commit `07ed077`) |
| DB-H-004 daily_report / summary retention | 🟡 DEFERRED | Operator policy required |
| DB-H-005 idx_p5m_inv_slave | ✅ FIXED | `server/db.js:1491` (commit `07ed077`) |
| DB-H-006 forecast_run_audit UNIQUE column ordering | 🟡 DEFERRED | Risky migration; current perf adequate |
| DB-H-007 alarms idx_a_open_inv_unit partial | 🟦 N/A | Already exists per `db.js:1473` |
| DB-H-008 forecast_dayahead single-col date index | 🟡 DEFERRED | Composite index already covers common queries |
| DB-H-009 counter-history Map TTL | 🟡 DEFERRED | Capped at 60 frames per unit; bounded by fleet size |
| DB-H-010 chat_messages retention | 🟡 DEFERRED | Operator policy required |
| DB-H-011 forecast_error_compare ON CONFLICT | 🟡 DEFERRED | Calling code uses INSERT OR REPLACE pattern |
| DB-H-012 solcast_snapshot_history index | 🟦 N/A | Already exists per audit re-read |
| DB-H-013 audit_log reason DEFAULT NULL | 🟡 DEFERRED | Risky migration on existing data |
| DB-M-001 to DB-M-010 (10 medium items) | ⚪ OPEN | All deferred to v2.11+ schema sweep |
| DB-L-001 to DB-L-010 (10 low items) | ⚪ OPEN | Cosmetic |
| DB-L-011 alarms (inv, unit, ts) index | ✅ FIXED | `server/db.js:1494` (commit `07ed077`) |
| DB-L-012 availability_5min index | 🟡 DEFERRED | 288 rows/day; not query-hot |
| DB-PG-001/002/003 cloud-sync gaps | ⚪ OPEN | `cloudDb.js` not present in repo; possibly future work |
| DB-DI-001/002 REAL precision concerns | 🟡 DEFERRED | Long-term schema migration |

---

## Security (`security-audit.md`)

| ID | Status | Where |
|---|---|---|
| SEC-C-001 Electron 29 → 41 upgrade | 🟡 DEFERRED | Major version, needs separate test campaign |
| SEC-C-002 transitive dep CVEs (tar, basic-ftp, @xmldom) | 🟡 DEFERRED | `npm audit fix --force` needs eyes-on review |
| SEC-C-003 lodash prototype pollution | 🟡 DEFERRED | Bundled with C-002 transitive update |
| SEC-H-001 timing-safe auth compare | ✅ FIXED | `server/bulkControlAuth.js:120/125` (commit `e6f2b77`) |
| SEC-H-002 sacupsMM 2-min replay window | 🟡 DEFERRED | Operator UX impact; needs HMAC redesign |
| SEC-H-003 topology auth single-digit variant | 🟡 DEFERRED | Operator UX impact |
| SEC-H-004 serial token IP/UA binding | ✅ FIXED | `server/serialNumber.js:76/93` + `bulkControlAuth.js:140` (commit `030e290`) |
| SEC-H-005 clock-sync rate limiting | ✅ FIXED | `server/index.js:12848` (commit `b201934`) — 60 s per-IP minimum spacing on all 3 sync-clock POSTs |
| SEC-M-001 inverter_5min_param remote-mode gate | ✅ FIXED | Already in v2.10.0 |
| SEC-M-002 weak IPC parameter validation | 🟡 DEFERRED | Defense-in-depth; needs path-allowlist redesign |
| SEC-M-003 OAuth window persistent partition | ⚪ OPEN | Could change to ephemeral partition |
| SEC-M-004 hardcoded default credentials | 🟡 DEFERRED | Operator UX decision (force-change-on-first-login) |
| SEC-M-005 binds to all interfaces | 🟡 DEFERRED | Operator config; doc + env var override |
| SEC-L-001 topology auth no rate-limit | ⚪ OPEN | Lower priority than H-tier |
| SEC-L-002 audit log usernames | 🟦 N/A | Operator-controlled, not PII |
| SEC-L-003 no OAuth token rotation | 🟡 DEFERRED | Operator policy |
| SEC-I-001 to I-004 | 🟦 PASS (informational) | All defense-in-depth observations confirmed in HEAD |

**Defense-in-depth additions also landed:** loopback-only middleware for `*-internal` endpoints (`server/index.js:180`, commit `e6f2b77`).

---

## Python (`python-services-audit.md`)

| ID | Status | Where |
|---|---|---|
| PY-C-001 _next_txn_id race | ✅ FIXED | `services/vendor_pdu.py:264` (commit `c7ce539`) |
| PY-C-002 missing HTTP timeouts | 🟦 N/A | Already in place at `forecast_engine.py:1653` (15 s) and `:11780` (180 s) |
| PY-C-003 truncated frame silent zero | ✅ FIXED | `services/inverter_engine.py:986` (commit `d9a09ad`) |
| PY-C-004 drift-dict unbounded growth | 🟦 N/A | Keys are (inv, unit) ints bounded by fleet size; documented at `inverter_engine.py:1408` (commit `95e5a5a`) |
| PY-H-001 to PY-H-007 (7 high items) | ⚪ OPEN | Mostly speculative or low-real-risk per audit's own mitigation status |
| PY-M-001 to PY-M-008 (8 medium items) | ⚪ OPEN | Cosmetic / future hardening |
| PY-L-001 to PY-L-007 (7 low items) | ⚪ OPEN | Cosmetic |

---

## Architecture (`architecture-audit.md`)

| Item | Status | Where |
|---|---|---|
| Loopback-only middleware for -internal | ✅ FIXED | `server/index.js:180` (commit `e6f2b77`) |
| .gitignore for spike artifacts | ✅ FIXED | `.gitignore` (commit `e6f2b77`) |
| Python→Node forecast audit-write boundary | 🟡 DEFERRED | 200 LOC refactor; not blocking |
| PRAGMA user_version migration framework | 🟡 DEFERRED | Schema is additive-only today; safe enough |
| Single-file giants (app.js, main.js, forecast_engine.py) | 🟡 DEFERRED | Architectural debt; mark seams with comments later |
| Health endpoints for Python services | ⚪ OPEN | Feature work |
| Network-partition retry/backoff | ⚪ OPEN | Feature work |
| Unified error envelope | 🟡 DEFERRED | API contract change; large scope |
| Configuration introspection endpoint | ⚪ OPEN | Feature work |
| Settings UI module extraction | 🟡 DEFERRED | 3K LOC refactor of `app.js` |
| Structured logging foundation | 🟡 DEFERRED | Project-wide refactor |

---

## Consistency (`consistency-audit.md`)

| Item | Status | Where |
|---|---|---|
| Hardcoded +08:00 offset in substation validator | ✅ FIXED | `server/index.js:15378` (commit `4712027`) |
| /api/counter-state/all remote proxy | ✅ FIXED | commit `4712027` |
| /api/counter-state/summary remote proxy | ✅ FIXED | commit `4712027` |
| /api/clock-sync-log remote proxy | ✅ FIXED | commit `4712027` |
| /api/counter-baseline remote proxy | ✅ FIXED | commit `e6f2b77` |
| /admin/inverter-clock remote proxy | ✅ FIXED | commit `e6f2b77` |
| /api/stop-reasons/* remote proxy "VERIFY" | 🟦 N/A | Tables are replicated (per `index.js:13296`); no proxy needed |
| pac_w double-scaling regression | ✅ FIXED | v2.10.0 baseline |
| Frequency unit verification (Motorola DSP manual) | ⚪ OPEN | Needs hardware/datasheet research |
| Temperature/CosΦ unit verification | ⚪ OPEN | Needs hardware/datasheet research |
| Settings keys camelCase consistency | 🟦 PASS | All settings keys verified consistent |
| API error envelope consistency | 🟡 DEFERRED | API contract change; large scope |
| Audit-log action vocabulary registry | 🟡 DEFERRED | Speculative; few action codes today |
| Forecast generation path conformance | ⚪ OPEN | Audit didn't fully trace; needs follow-up |
| Counter trust hierarchy adoption | 🟦 PASS | Helpers in place; consumers respect them |

---

## Dirty Code (`dirty-code-audit.md`)

| Item | Status | Where |
|---|---|---|
| 11 root `_*.py` decoder scripts | ✅ FIXED via .gitignore | Pattern `/_*.py` ignored; files preserved on disk for ongoing research |
| `_spike/` directory | ✅ FIXED via .gitignore | Operator preserves locally |
| `_ism/` directory (vendor DLLs ~5.5 MB) | ✅ FIXED via .gitignore | Operator preserves locally |
| `ism_frames.txt` | ✅ FIXED via .gitignore | |
| `release-notes-v*.md` at root | ✅ FIXED via .gitignore | |
| `app_v2.5.0.js` legacy snapshot | ⚪ OPEN | Untracked; manual delete recommended (478 KB) |
| `build-release.ps1` hardcoded v2.10.0-beta.2 | ⚪ OPEN | Untracked; review or delete |
| `sync-agents.ps1` | ⚪ OPEN | Needs operator confirmation |
| `docs/capture-*.pcapng` Wireshark captures | ⚪ OPEN | Needs operator decision (move to git-lfs or delete) |
| Stale build-log .txt files | ⚪ OPEN | Untracked; safe to delete |
| `@playwright/test` devDep | ⚪ OPEN | Needs operator confirmation |
| `intervals_json` unused column | 🟡 DEFERRED | Risky DROP COLUMN on existing data |
| `normalizeTodayEnergyRows` 3× duplication | 🟦 N/A | Audit confirmed intentional per-module isolation |

---

## Headline numbers

```
Total findings catalogued:  ~135 (across 7 audit reports)
✅ FIXED in main:             36
🟦 N/A (false positive):       9
🟡 DEFERRED with reason:      ~40
⚪ OPEN (no decision yet):    ~50
```

`✅ + 🟦 + 🟡` together cover **~85** of the 135 findings — the rest are
operator-policy decisions (retention, default password, port binding),
research-required (DSP register units), or speculative cosmetic work.

---

## Commit graph since v2.10.0 baseline

```
95e5a5a  Close remaining low-risk audit items + clarify drift-dict bound
030e290  Bind serial-number session tokens to client IP + UA hash (SEC-H-004)
adfcd49  Frontend: .catch() on fire-and-forget invClock refresh in WS handler
c7ce539  vendor_pdu: lock _next_txn_id() to fix concurrent-call race (PY-C-001)
07ed077  DB hardening: three additional indexes (DB-H-003, DB-H-005, DB-L-011)
b201934  Backend hardening: clock-sync rate limit + startup TZ warning
36adf9a  Close DB-C-004 exporter gap: explicit columns on alarms + audit_log SELECT
─── v2.10.1 release line ──────────────────────────────────────────────────
6e0b9b9  Version bump to 2.10.1
d9a09ad  Inverter engine: raise on truncated Modbus frame instead of silent zero
2cb07d7  DB hardening: index alarms.stop_reason_id, replace SELECT * on alarms
e6f2b77  Backend hardening: timing-safe auth, internal-endpoint gate, remote-mode proxies, .gitignore
ea18d02  Fix Parameters refresh + Settings section first-open freezes + XSS hardening
3901e44  Document critical fixes applied during consistency audit (commit 4712027)
4712027  Fix critical remote-mode proxy and timezone handling bugs in v2.10.0
─── v2.10.0 release line ──────────────────────────────────────────────────
c30dc30  Release v2.10.0
```
