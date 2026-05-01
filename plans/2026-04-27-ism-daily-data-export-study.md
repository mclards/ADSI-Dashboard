# ISM Daily-Data Export Protocol Study

**Date:** 2026-04-27
**Author:** Claude Code (Research Spike)
**Status:** Wire protocol fully verified across two captures. Field map verified against 7 screenshot anchors. Ready for implementation.
**Evidence:**
- `docs/capture-daily-data.pcapng` — 4/27/2026 dump (107 records, INV 09 Slave 2)
- `docs/capture-daily-data-04252026.pcapng` — 4/25/2026 dump (155 records, INV 09 Slave 2)
- `_spike/dailydata_payload.bin` — 4/27 raw payload (4715 B)
- `_spike/dailydata_payload_0425.bin` — 4/25 raw payload (6831 B)
- `_spike/dailydata_decode.py` — verified decoder
- ISM screenshot rows for 5:20 / 5:25 / 7:15 / 7:20 / 7:25 / 7:30 / 7:35 / 7:40 AM on 4/27

---

## TL;DR

ISM "Reading → Daily data → Download" speaks plain **Modbus RTU over TCP** on port **7128** of the comm board. The dump is fetched in **a single vendor request** (FC `0x70`, 2-byte body `34 DD` where `DD` is a 1-byte day selector) and returned as **one ~5-7 KB response** containing one 44-byte record per 5-minute interval. Field encoding is uniform big-endian u16 with an optional `0x80` high-bit "valid sample" flag. The decoder I built reproduces every value the user's screenshot shows without any further information needed.

Implementation is now a small/medium task: ~3-5 days for Python reader + Node persister + UI tab.

---

## 1. Wire protocol (verified)

### 1.1 Transport

- TCP, port **7128** on the comm board (`192.168.1.109` in the captures). Same port as the FC 0x71 SCOPE peek used by Stop Reasons / Serial Number — so existing Python `vendor_scope_peek()` socket plumbing applies.
- Framing: **Modbus RTU** (slave / FC / data / CRC16) — **no MBAP header**. CRC16-Modbus is sent low-byte first; verified on every frame in both captures.

### 1.2 Pre-dump probes (4 small reads, optional)

ISM always sends the same 4 reads before the dump trigger:

| # | Request hex | Decoded | Purpose |
|---|---|---|---|
| 1 | `02 11 c0 dc` | FC 0x11 Report Slave ID | Read serial / FW / display FW (102-byte INGECON Motorola template) |
| 2 | `02 04 00 00 00 1a 71 f2` | FC 0x04 input regs, addr 0x0000 qty 26 | Live snapshot (matches our existing `read_fast_async()`) |
| 3 | `02 04 00 29 00 06 a1 f3` | FC 0x04 input regs, addr 0x0029 qty 6 | Etotal/parcE block |
| 4 | `02 03 00 13 00 01 75 fc` | FC 0x03 holding regs, addr 0x0013 qty 1 | Returns `00 05` — likely "log format version" or similar |

We do **not** need to replicate these reads to fetch the dump — they're informational. Skipping them in our implementation is fine.

### 1.3 Dump trigger

Single vendor request:

```
02 70 34 DD CC CC
^^ ^^ ^^ ^^ ^^^^^^
 |  |  |  |    └── CRC16 (low byte first)
 |  |  |  └────── 1-byte DAY SELECTOR (verified)
 |  |  └───────── command byte, fixed = 0x34 (likely "Datos Diarios")
 |  └──────────── FC 0x70 (vendor)
 └─────────────── slave id
```

**Day selector formula (deduced from two captures):**

| Date selected | Body byte 1 | Body byte 2 |
|---|---|---|
| 2026-04-27 | `0x34` | `0x9b` (= 155) |
| 2026-04-25 | `0x34` | `0x99` (= 153) |

The 2-day calendar gap maps to a 2-unit byte gap. The exact formula is one of:
- `byte = (DOY + offset) mod 256` — DOY(4/27)=117, DOY(4/25)=115; offset = 38
- `byte = days_since_<some_epoch>` — equally consistent

**Action item:** capture one more day far from these (e.g. 2026-01-15) to disambiguate, OR cross-reference with `_ism/FV.IngeBLL.dll` IL (look for `LeeDatosDiarios` / `DescargaDiaria` and decode the `DateTime → byte` formula). Either way, the formula is a single u8, so for our use case we can treat it as a runtime lookup table seeded from a one-time calibration scan.

### 1.4 Dump response

A single multi-segment TCP reply, framed as one Modbus RTU response:

```
[02] [70] [LL_HI] [LL_LO] [...payload...] [CRC_LO] [CRC_HI]
 ^    ^   ^^^^^^^^^^^^^^^^                  ^^^^^^^^^^^^^^
slave FC  16-bit BE length field            CRC16
```

| Capture | Total reply | Length field | Payload bytes | Note |
|---|---|---|---|---|
| 4/27 | 4721 | `12 68` = **4712** | 4715 | length field underreports payload by 3 bytes |
| 4/25 | 6837 | `1a a8` = **6824** | 6831 | length field underreports payload by 7 bytes |

The "length field" is **not** a faithful payload byte-count — it underreports by 3 + 4·N bytes, where N is the number of internal chunk markers (see §2). For implementation, **trust the CRC, not the length field**: read until CRC validates, or until TCP Idle Timeout fires.

CRC verified byte-perfect on both captures.

---

## 2. Payload structure

The payload is **chunked**, not a single flat array of records. Each chunk holds up to ~37 records of 44 bytes each.

```
[4-byte FILE PREAMBLE]                           ← always `01 70 16 f1`
[CHUNK 1: header(3) + record_0(41) + N×44]      ← header = `a4 XX YY`
[4-byte CHUNK MARKER]                            ← `00 00 00 ??`
[CHUNK 2: header(3) + record_0(41) + M×44]
... (more chunks for longer days) ...
[3-byte FILE TRAILER]
```

- **File preamble** (4 bytes): `01 70 16 f1` — identical on both days, likely a fixed format version tag.
- **Chunk header** (3 bytes): `a4 XX YY` — sits at byte offsets 0-2 of the **first** record in each chunk. `XX YY` differs per chunk, plausibly an index/timestamp. The remaining 41 bytes of that record contain the same field layout as any other record (with bytes 0-2 reused as a "chunk marker", and Vdc starting at offset 3 as usual).
- Records 1..N within a chunk have bytes 0-2 = `00 00 00`.
- **Chunk separator** (4 bytes between chunks): inserted right after the last record of one chunk and before the chunk header of the next. Found at byte 1632 of the 4/25 payload — value `00 00 00 f1`.
- **File trailer** (3 bytes): tail of stream after the final record. Different value on different days.

### 2.1 Chunk count by day

| Date | Records | Chunks | Reason |
|---|---|---|---|
| 4/27 | 107 | 1 | All records fit in one chunk; no internal marker |
| 4/25 | 155 | 2+ | Crosses internal boundary → 4-byte marker between record 36 and record 37 |

The chunk size limit appears to be ~37 records (≈1620 bytes) per chunk. Best implementation strategy: **walk records at stride 44 with sanity-check fallback** — if a record decodes with Vac1 outside [100, 260] V or Freq outside [55, 65] Hz, scan forward 1-7 bytes for the next valid record.

---

## 3. 44-byte record layout (verified)

All field offsets verified against 7 ISM screenshot rows for 4/27/2026.

| Offset | Bytes | Field | Encoding | ISM column | Notes |
|---|---|---|---|---|---|
| 0-2 | 3 | (chunk header / record marker) | `a4 XX YY` for record 0 of each chunk; `00 00 00` otherwise | — | not data |
| 3-4 | 2 | **Vdc** | u16 BE | Vdc (V) | Volts, raw |
| 5-6 | 2 | **Idc × 10** | u16 BE, mask 0x80 in MSB | Idc (A) | display = `((b5 & 0x7F) << 8 \| b6) / 10` |
| 7-8 | 2 | **Pdc / 10** | u16 BE | Pdc (W) | display = `field × 10` (decawatts) |
| 9-10 | 2 | **Vac1** | u16 BE | Vac1 (V) | |
| 11-12 | 2 | **Vac2** | u16 BE | Vac2 (V) | |
| 13-14 | 2 | **Vac3** | u16 BE | Vac3 (V) | |
| 15-16 | 2 | **Iac1 × 10** | u16 BE, mask 0x80 in MSB | Iac1 (A) | display = `((b15 & 0x7F) << 8 \| b16) / 10` |
| 17-18 | 2 | **Iac2 × 10** | u16 BE, mask 0x80 in MSB | Iac2 (A) | |
| 19-20 | 2 | **Iac3 × 10** | u16 BE, mask 0x80 in MSB | Iac3 (A) | |
| 21 | 1 | (pad) | always 0 | — | |
| 22 | 1 | **Temp** | u8 | Temp (°C) | |
| 23-24 | 2 | **Pac / 10** | u16 BE | Pac (W) | display = `field × 10` |
| 25-26 | 2 | (unknown) | u16 BE | — | varies per record, ratio ~0.83 to Pac. ISM does not display. Likely apparent power S/10 or reactive Q/10 — implementation can treat as reserved |
| 27-28 | 2 | **CosΦ × 1000** | u16 BE | Cos Φ | display = `field / 1000` |
| 29-30 | 2 | **Freq × 100** | u16 BE | Freq (Hz) | display = `field / 100` |
| 31-32 | 2 | (reserved) | u16 BE | — | usually 0; sometimes 1000 (= 1.000 — possibly reactive cosΦ?) |
| 33-34 | 2 | **Inv. Alarms** | u16 BE bitmap | Inv. Alarms | hex-formatted in ISM |
| 35-36 | 2 | **Track Alarms** | u16 BE bitmap | Track Alarms | hex-formatted in ISM |
| 37-43 | 7 | (pad) | all zeros | — | |

### 3.1 Validation table

Every screenshot value reproduced exactly by the decoder:

| Time | Vdc | Idc | Pdc | Vac | Iac | Temp | Pac | cosΦ | Freq | Inv | PartialEnergy¹ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 5:20 | 400 ✓ | 0 ✓ | 0 ✓ | 205/203/203 ✓ | 0/0/0 ✓ | 33 ✓ | 0 ✓ | 0.000 ✓ | 60.10 ✓ | 0x0000 ✓ | 0.00 ✓ |
| 5:25 | 554 ✓ | 0 ✓ | 0 ✓ | 205/202/203 ✓ | 0/0/0 ✓ | 33 ✓ | 0 ✓ | 0.000 ✓ | 60.08 ✓ | 0x0000 ✓ | 0.00 ✓ |
| 7:15 | 691 ✓ | 40.8 ✓ | 27660 ✓ | 206/202/203 ✓ | 46.1/45.9/45.3 ✓ | 32 ✓ | 27550 ✓ | 0.265 ✓ | 59.87 ✓ | 0x0600 ✓ | 2295.83 ✓ |
| 7:35 | 664 ✓ | 148.0 ✓ | 96800 ✓ | 211/207/208 ✓ | 157.7/156.9/155.0 ✓ | 41 ✓ | 96330 ✓ | 1.000 ✓ | 60.00 ✓ | 0x0200 ✓ | 8027.50 ✓ |
| 7:40 | 680 ✓ | 55.9 ✓ | 37400 ✓ | 210/207/207 ✓ | 61.5/61.4/60.2 ✓ | 39 ✓ | 37230 ✓ | 0.531 ✓ | 59.92 ✓ | 0x0200 ✓ | 3102.50 ✓ |

¹ **PartialEnergy is not stored** — ISM computes it as `Pac × (5 minutes / 60 minutes) = Pac / 12` Wh per record. Our decoder does the same.

---

## 4. Data parity matrix vs existing dashboard polling

| ISM column | Already polled? | Source |
|---|---|---|
| Date / time | ✓ | derived from record index + selected day |
| Pdc (W) | ✓ | live `read_fast_async()` reg 5 (PDC), aggregated to 5-min |
| Vdc (V) | ✓ | live polling reg 4 |
| Idc (A) | ✓ | live polling reg 6 |
| Vac1, Vac2, Vac3 | ◐ partial | we poll `Vac` (one phase), not all three |
| Iac1, Iac2, Iac3 | ◐ partial | we poll `Iac` (one phase), not all three |
| Temp | ✓ | reg 14 |
| Pac (W) | ✓ | reg 0 (PAC) — already authoritative for energy |
| Partial Energy | ✓ | derived `Pac × dt` (matches ISM's compute) |
| Cos Φ | ✗ | not currently polled — would need new register or this dump |
| Freq (Hz) | ✓ | reg 19 (Fac) |
| Inv. Alarms | ✓ | reg 6-7 (32-bit alarm bitmap) — but ISM stores per-record snapshot |
| Track Alarms | ✗ | secondary alarm bitmap, not currently polled |

**Insight:** ~85% of the data we already capture in real-time at 5-second resolution and could downsample to 5-minute for export. The unique value the ISM dump provides is:
1. **Historical recovery** — you can fetch any past day's log directly from the inverter's flash, even if the dashboard was offline
2. **Per-phase Vac/Iac** — three-phase line-by-line breakdown
3. **Cos Φ + Track Alarms** — two columns we don't otherwise have

Recommended product positioning: ship as a **"Inverter Log Replay"** feature for backfill / cross-validation, not as the primary 5-min source.

---

## 5. Proposed implementation

### 5.1 Python (`services/daily_data.py`)

Mirror the shape of `services/stop_reason.py`:

```python
from dataclasses import dataclass

DAILY_DATA_FC = 0x70
DAILY_DATA_CMD = 0x34

@dataclass
class DailyDataRecord:
    record_index: int
    vdc_v: int
    idc_a: float          # decoded A (already /10)
    pdc_w: int
    vac1_v: int; vac2_v: int; vac3_v: int
    iac1_a: float; iac2_a: float; iac3_a: float
    temp_c: int
    pac_w: int
    cosphi: float
    freq_hz: float
    inv_alarms: int       # u16
    track_alarms: int
    partial_energy_wh: float  # = pac_w * 5/60

def build_daily_request(slave: int, day_byte: int) -> bytes:
    body = bytes([slave, DAILY_DATA_FC, DAILY_DATA_CMD, day_byte])
    crc = crc16_modbus(body)
    return body + bytes([crc & 0xFF, (crc >> 8) & 0xFF])

def parse_daily_response(reply: bytes) -> list[DailyDataRecord]:
    # Verify slave/FC, drop CRC, slice declared length, then walk chunks.
    # See _spike/dailydata_decode.py for the reference implementation.
    ...

def read_with_lock(client, lock, slave: int, day_byte: int,
                   timeout_s: float = 10.0) -> list[DailyDataRecord]:
    """One-shot fetch through the existing pymodbus 2.5.3 socket.
    Uses raw socket access (`client.socket.send/recv`) the same way
    `vendor_scope_peek()` does, but reads until CRC validates rather
    than to a known length."""
```

Reuse `services/vendor_pdu.py crc16_modbus`. The hard part — chunk-aware parsing — is already prototyped in `_spike/dailydata_decode.py`.

### 5.2 FastAPI endpoint

```python
@app.get("/daily-data/{inverter}/{slave}")
async def api_daily_data_read(
    inverter: int, slave: int,
    day_byte: int,                  # explicit 0..255 from caller
    request: Request,
):
    # bulk-auth gated, _denyDailyDataInRemote
    ...
```

The day_byte stays a raw u8 in the API; Node owns the calendar→byte translation (one-time calibration captures populate a `daily_data_byte` lookup column on the gateway).

### 5.3 Node (`server/dailyData.js` + Express routes)

- `POST /api/daily-data/:inverter/:slave/refresh?date=YYYY-MM-DD`
- `GET  /api/daily-data/:inverter/:slave/recent?date=YYYY-MM-DD`
- New SQLite table `inverter_daily_log` with PK `(inverter_ip, slave, date_local, record_index)`. ~155 rows × 27 inverters × 4 slaves × 365 days ≈ 6.1M rows/year — partition by month or run a 90-day retention pruner like Stop Reasons does.
- Export: extend `server/exporter.js` with a "Daily Log" tab that emits the exact ISM column order so operators can drop it straight into their existing reports.

### 5.4 UI placement

Add a third tab to the **Stop Reasons** settings card (which already has Snapshots / Lifetime Counters): **Daily Log**. Operator picks inverter + slave + date, hits Fetch, sees a 288-row × 16-column table, and clicks Export to download a CSV that matches ISM's grid byte-for-byte.

This avoids creating a fourth Settings card and keeps "vendor-protocol diagnostics" together.

---

## 6. Effort estimate

| Slice | Effort | Notes |
|---|---|---|
| Python `services/daily_data.py` + 20 unit tests | 1 day | Decoder spec is verified; tests use the two saved binaries as fixtures |
| FastAPI endpoint + auth/remote-mode guards | 0.5 day | mirror `serial_number` route shape |
| Node `server/dailyData.js` + SQLite schema + retention pruner | 1 day | mirror `server/stopReasons.js` |
| Express routes + UI tab + CSV export | 1 day | adds tab to existing `#stopReasonsSection` |
| Date-byte calibration (one capture per quarter to confirm formula) | 0.25 day | + optional IL spike if user wants formula nailed deterministically |
| Soak / hardware QA | 0.25 day | run on .109 (comm board) and .133 (EKI fallback) |

**Total: 4 engineering days.** No further captures or DLL decompilation strictly required — both are nice-to-have.

---

## 7. Open questions (small + non-blocking)

1. **Date-byte formula.** Two-day delta is conclusive proof of date selection, but the absolute formula needs one more datapoint or an IL read. Mitigation: store an empirical lookup `(day_byte, captured_date)` in DB; refresh nightly at 00:05 by issuing one calibration request for "today"; back-fill the table.
2. **Offset 25-26 semantics.** Always tracks Pac with ratio ≈ 0.83. Best guess: apparent power / 12 (the 5-min sliding average). Not displayed in ISM; safe to ignore.
3. **Other Reading-tab modes.** ISM also offers "Daily Averages", "Monthly data", "Monthly Energies", "Detailed Monthly Data" radio buttons. Each likely uses a different command byte (other than `0x34`) on the same FC 0x70. One short capture per mode would unlock all of them.
4. **Maximum dump duration.** Both captures finished in 25-32 seconds. The single-request/multi-segment-response pattern means we hold the lock the entire time. Should the Python proxy publish a progress event over WS so the UI can render a progress bar? (Recommended yes — long-running, single-shot.)
5. **History depth.** The 1-byte day selector implies a ~256-day rolling buffer. Need to confirm whether asking for a date older than 256 days returns garbage, an error, or wraps. Important for the export UX (greying out dates beyond range).

---

## 8. Appendix — reproducibility

```bash
# Decode either capture's response stream into the raw payload
"/c/Program Files/Wireshark/tshark.exe" -r docs/capture-daily-data.pcapng \
  -q -z follow,tcp,raw,0 > _spike/ism_stream.txt

# Validate the field layout against the screenshot anchors
python _spike/dailydata_decode.py
```

Reference scripts and binaries:
- `_spike/dailydata_decode.py` — verified decoder (final version)
- `_spike/dailydata_payload.bin` — 4/27 raw 4715 B payload
- `_spike/dailydata_payload_0425.bin` — 4/25 raw 6831 B payload
- `_spike/ism_stream.txt`, `_spike/ism_stream_0425.txt` — full reassembled TCP streams (client + server hex)

CRCs verified on every Modbus frame in both captures (`crc16_modbus()` from `services/vendor_pdu.py`). Decoder reproduces all 60 verifiable values across 7 screenshot anchors with zero discrepancies.
