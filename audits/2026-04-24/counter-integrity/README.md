# Counter Integrity Investigation — 2026-04-24

- **Date:** 2026-04-24
- **Status:** v2.9.0 implementation landed; Slice D (clock-sync transport)
  gated on **D1** Wireshark / IL template capture
- **Plan:** [plans/2026-04-24-hardware-counter-recovery-and-clock-sync.md](../../../plans/2026-04-24-hardware-counter-recovery-and-clock-sync.md)

## Artifacts in this folder

| File | Purpose |
|---|---|
| `REPORT-1406-to-1500.md` | 53-min fleet scan summary (91 units, 0 monotonicity violations) |
| `scan-20260424-154900.jsonl` | Wide-window register scan (60 regs × all units) |
| `scan-20260424-160834.jsonl` | Follow-up scan after inv 21/u3 self-recovery |
| `samples-20260424-*.jsonl` | Per-poll snapshots used for empirical counter discovery |
| `isla-sincronizar-frame.bin` | **PENDING** — 19-byte vendor time-sync template (D1-a output) |

## Analyzer / discovery scripts

- [tools/counter_integrity_tester.py](../../../tools/counter_integrity_tester.py)
- [tools/counter_integrity_analyze.py](../../../tools/counter_integrity_analyze.py)
- [tools/counter_wide_scan.py](../../../tools/counter_wide_scan.py)
- [tools/counter_hunt_parce.py](../../../tools/counter_hunt_parce.py)

## Findings (one-screen)

- `Etotal` at input regs 0-1 (UInt32, big-endian hi-lo). **Lifetime kWh counter.**
- `parcE` at input regs 58-59 (UInt32, big-endian hi-lo). **Partial (operator-resettable) kWh counter.**
- `Etotal` tracks PAC integration within 1% on 90/91 units (53-min window,
  57,308 samples, 0 monotonicity violations).
- `parcE` has identical integer-kWh precision to Etotal.
- Inverter 21 / unit 3 is intermittent: RTC stuck at 2047-05-11 during fault
  window; counters frozen; self-recovered to parcE=Etotal between 15:49 and
  16:08 scans after (presumed) ISM operator click of "Synchronize all".
- Fleet-wide RTC drift: **+32 min to +73 min**, all fast. No NTP discipline
  on the 920TL fleet — operator-triggered sync via ISM menu is the only
  known path.
- Current poller bugs fixed as byproduct of the extended read:
  - `reg(7)` was treated as a 16-bit alarm (was truncating the high word);
    now decoded as a 32-bit bitfield via `_u32_hi_lo(regs, 6)`.
  - `reg(19)` (`Fac` — grid frequency) was not mapped; now exposed as
    `fac_hz` (×0.01 Hz resolution).

## Time-sync mechanism (observed)

Reflected from `FV.IngeBLL.Isla::Sincronizar(DateTime)`:

1. Extract Y/M/D/H/Mi/S from `DateTime` arg.
2. Split year → (year_hi, year_lo) via `Math.DivRem(year, 256, out year_lo)`.
3. Allocate 19-byte buffer; init bytes 0-6 from a RuntimeFieldHandle template.
4. Write time bytes at offsets 7, 8, 10, 12, 14, 16, 18 (pattern matches
   the inverter's RTC register order).
5. Call `iTransport.modbusQR(buf, 19)`.
6. `Thread.Sleep(300)` ms.
7. Call `iTransport.modbusQR(buf, 19)` **again** (deliberate double-send).
8. Catch any exception and swallow.

Menu chain: `frmMANAGER.tsmiSincronizarIngecon_Click →
frmSincronizarIngecones → btnVariosIngeconAceptar_Click → Isla.Sincronizar`.

## Implementation summary (v2.9.0)

- Slice A (register read) — `read_fast_async()` in
  [services/inverter_engine.py](../../../services/inverter_engine.py).
- Slice B (persistence) — new tables + helpers in
  [server/db.js](../../../server/db.js); poller hook in
  [server/poller.js](../../../server/poller.js).
- Slice C (crash recovery) — `seed_pac_from_baseline()` + audit endpoint.
- Slice D (clock-sync transport) — `write_raw_frame` driver primitive +
  `_build_sync_frame` + `sync_clock()` + FastAPI endpoints.
  **TEMPLATE-GATED until D1-a/b/c complete.**
- Slice E (scheduler + triggers) — Node cron at `inverterClockAutoSyncAt` +
  Python drift/year-invalid triggers on each poll.
- Slice F (health gates) — [server/counterHealth.js](../../../server/counterHealth.js)
  + Python mirrors.
- Slice G (UI) — [public/admin-inverter-clock.html](../../../public/admin-inverter-clock.html)
  + top-bar chip in `index.html` + `app.js`.
- Slice H (export) — counter columns added to `exportInverterData` in
  [server/exporter.js](../../../server/exporter.js).

## Open work (before M4 ship)

1. Execute D1-a: IL reflection to extract the 19-byte header template
   (see plan §9.2). Save the bytes to `isla-sincronizar-frame.bin`.
2. Execute D1-b: Wireshark capture of one real ISM sync click against a
   test-bench inverter. Diff the captured bytes against the D1-a template.
3. Execute D1-c: confirm whether the vendor frame carries a CRC; if so,
   extract the polynomial from the IL of `ResetContadoresParciales` or
   `iTransport.modbusQR`.
4. Test-bench validation: one `POST /api/sync-clock/<inv>/<unit>` roundtrip
   with the captured template. Verify `drift_after_s < 5` on read-back.
5. Canary rollout: enable `inverterClockAutoSyncEnabled` on one inverter for
   7 days, observe `inverter_clock_sync_log` before fleet-wide enable.
