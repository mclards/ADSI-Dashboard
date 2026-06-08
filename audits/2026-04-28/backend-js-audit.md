# Backend JS Audit - 2026-04-28

Scope: Node.js/Express backend of ADSI Inverter Dashboard
Branch: main
Review Type: Post-release verification + pac_w decascale completeness

---

## Executive Summary

0 CRITICAL | 2 HIGH | 8 MEDIUM | 6 LOW

All pac_w units verified correct after v2.10.0 decascale fix.

## CRITICAL FINDINGS

None.

## HIGH FINDINGS

### HI-001 - Missing remote-mode proxy on /api/counter-baseline/:date_key

**File:** server/index.js:12427  
**Severity:** HIGH  

The endpoint reads inverter_counter_baseline (gateway-local only). Remote viewers receive data from their HTTP gateway, not the actual inverter gateway.

Missing guard:
```
if (isRemoteMode()) return proxyToRemote(req, res);
```

Impact: Remote-viewer counter-baseline queries return stale/blank data.

### HI-002 - Missing remote-mode proxy on /admin/inverter-clock

**File:** server/index.js:12856  
**Severity:** HIGH  

Same issue: inverter_counter_state is gateway-local. Admin page reads and renders clock state without checking if requester is remote.

Impact: Settings > Inverter Clocks page is blank/stale for remote users.

## MEDIUM FINDINGS

### MD-001 - Silent catch on audit log write in poller.js:520-534

If SQLite fails, recovery-seed clamp event logged only to console.

### MD-002 - Stale frame guard relies on Python pre-filter (poller.js:481-487)

Node should independently check dtSec <= 0 || dtSec > 180.

### MD-003 - Missing input validation on /api/settings POST (index.js:15719)

No validation on plantLatitude/Longitude, inverterClockDriftThresholdS, etc. Should use Zod/Joi schema.

### MD-004 - No sanity ceiling on per-row PAC energy (exporter.js:2967)

If corrupted pac_w bypasses poller clamp, exporter serializes inflated kWh to XLSX. Add Math.min(pacW, 260_000).

### MD-005 - getCounterStateAll() not paginated (db.js, index.js:12503)

For 100+ units returns 400 rows repeatedly, causing memory churn. Add limit/offset.

### MD-006 - Race condition in dailyAggregator reaped-slot LRU (js:306-318)

Multiple async callbacks call markSlotReaped concurrently without locking. Can overflow 256-entry LRU.

### MD-007 - Timezone assumption not validated at startup

No check that TZ is set to Asia/Manila. If gateway runs UTC, all slots mis-bin silently.

### MD-008 - Missing await on _isRemoteMode() in cloudBackup.js:1841, 1942

Currently synchronous (safe), but fragile for future async refactor.

## LOW FINDINGS

### LO-001 - var usage in legacy code
Use const/let in Node.js v14+.

### LO-002 - Magic number 256 for reaped-slot LRU
Add comment explaining ~4.7h coverage for 27 units x 4 nodes.

### LO-003 - Inconsistent auth error codes
Some use 401, others 403. Standardize: 401 if missing/bad, 403 if insufficient.

### LO-004 - JSON.parse() in settings without try/catch
Wrap in try/catch with fallback.

### LO-005 - Comment drift on PAC units (dailyAggregator.js:267)
Original buggy comment was removed. Restore context: frame.pac is WATTS, do NOT multiply by 10.

### LO-006 - No rate-limiting on /api/sync-clock/:inv/:unit
Operator can spam requests. Add per-(inv, unit) 60s limit, reject with 429.

## PAC UNITS VERIFICATION

Convention: frame.pac is WATTS after poller.parseRow:596.

All consumers verified:
- db.js:2518 (counter persist): frame.pac as-is (W) CORRECT
- db.js:2717 (EOD snapshot): pac_w as-is (W) CORRECT
- dailyAggregator.js:267 (5-min aggregate): NO *10 multiplication CORRECT
- dailyAggregator.js:177 (range gate): [0, 260_000] watts CORRECT
- index.js:12974 (parameter totals): W to kWh conversion CORRECT
- exporter.js:2967 (daily export): W to kWh conversion CORRECT
- dailyAggregatorCore.test.js:234: pac_w=1000 for input pac=1000 CORRECT

v2.10.0 pac_w decascale fix is COMPLETE and VERIFIED.

## SUMMARY

CRITICAL: 0
HIGH: 2 (HI-001, HI-002 - remote-mode proxy gates)
MEDIUM: 8 (MD-001 through MD-008)
LOW: 6 (LO-001 through LO-006)
TOTAL: 16 findings

Audit Date: 2026-04-28
Reviewer: Claude Code
