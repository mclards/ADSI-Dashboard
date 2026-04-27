"use strict";

/**
 * server/dailyAggregator.js — All Parameters Data 5-min aggregator.
 *
 * Bucketizes the live poll stream into one 5-minute row per (inverter_ip,
 * slave, date_local, slot_index) and persists to `inverter_5min_param`.
 * Replaces the on-screen Energy table (UI only — the existing
 * `inverter_5min` and `energy_5min` tables stay untouched).
 *
 * Flow:
 *   poller.js parsed-row loop  →  ingestLiveSample(parsed)
 *      └─ accumulate into in-memory bucket
 *      └─ when slot rolls (or 30s grace after slot end), flushBucket()
 *
 * Reads (REST/WS) come from the persisted table; the in-progress bucket
 * is exposed via `getCurrentBucket(ip, slave)` for the live UI tile.
 *
 * Solar-window filter is stamped at flush time (in_solar_window column).
 * Read-side queries filter by that flag — see /api/params/* in index.js.
 *
 * Track Alarms is not exposed by the standard FC04 register block; we
 * always store 0 to keep the column count matching ISM's grid + export.
 */

const FLUSH_GRACE_MS = 30_000;          // reap a bucket 30s after its slot ended
const REAP_INTERVAL_MS = 30_000;        // run the reaper every 30s
const SLOT_MIN = 5;                     // bucket size (minutes)

// Per-(inverter_ip, slave) in-progress bucket.
const buckets = new Map();              // key="ip|slave" -> Bucket

// Captured config — set by init().
let _db = null;
let _getSetting = null;                 // (key, def) => string

function _solarWindowStartHour() {
  const v = Number(_getSetting?.("solarWindowStartHour", 5));
  return Number.isFinite(v) && v >= 0 && v <= 23 ? Math.trunc(v) : 5;
}
function _eodSnapshotHour() {
  const v = Number(_getSetting?.("eodSnapshotHourLocal", 18));
  return Number.isFinite(v) && v >= 0 && v <= 23 ? Math.trunc(v) : 18;
}

function init({ db, getSetting }) {
  if (!db || typeof db.prepare !== "function") {
    throw new Error("dailyAggregator.init: db is required");
  }
  if (typeof getSetting !== "function") {
    throw new Error("dailyAggregator.init: getSetting is required");
  }
  _db = db;
  _getSetting = getSetting;

  // Reaper — every 30s force-flush any bucket whose slot has rolled past
  // its grace window. Catches the case where an inverter goes silent
  // mid-bucket and would otherwise sit unflushed forever.
  const t = setInterval(() => {
    try { reapStale(); } catch (err) {
      console.warn("[dailyAgg] reaper error:", err?.message || err);
    }
  }, REAP_INTERVAL_MS);
  if (typeof t.unref === "function") t.unref();

  return { ingestLiveSample, flushAll, getCurrentBucket };
}

// ─── Slot math (Asia/Manila wall clock) ────────────────────────────────────

function _localParts(tsMs) {
  const d = new Date(Number(tsMs) || Date.now());
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,    // 1..12
    day: d.getDate(),           // 1..31
    hour: d.getHours(),         // 0..23
    minute: d.getMinutes(),     // 0..59
    second: d.getSeconds(),
  };
}
function _formatDateLocal(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}
function _slotIndex(parts) {
  return Math.floor((parts.hour * 60 + parts.minute) / SLOT_MIN);
}
function _slotEndMs(dateLocal, slotIndex) {
  // Slot N covers [slotStart, slotStart + 5min). slot_end = slotStart + 5min.
  const [y, m, d] = dateLocal.split("-").map(Number);
  const startMin = slotIndex * SLOT_MIN;
  const startH = Math.floor(startMin / 60);
  const startMm = startMin % 60;
  return new Date(y, m - 1, d, startH, startMm, 0, 0).getTime() + SLOT_MIN * 60_000;
}
function _hourOfSlot(slotIndex) {
  return Math.floor(slotIndex / (60 / SLOT_MIN));   // 60/5 = 12 slots per hour
}
function _isSolarWindow(slotIndex) {
  const h = _hourOfSlot(slotIndex);
  return h >= _solarWindowStartHour() && h < _eodSnapshotHour();
}

// ─── Bucket lifecycle ─────────────────────────────────────────────────────

function _newBucket(ip, slave, dateLocal, slotIndex, tsMs) {
  return {
    ip,
    slave: Number(slave) || 0,
    dateLocal,
    slotIndex,
    tsMs: Number(tsMs) || Date.now(),

    // Sums for averaging
    sumVdc: 0, nVdc: 0,
    sumIdc: 0, nIdc: 0,
    sumPdc: 0, nPdc: 0,
    sumVac1: 0, nVac1: 0,
    sumVac2: 0, nVac2: 0,
    sumVac3: 0, nVac3: 0,
    sumIac1: 0, nIac1: 0,
    sumIac2: 0, nIac2: 0,
    sumIac3: 0, nIac3: 0,
    sumPac: 0, nPac: 0,
    sumCos: 0, nCos: 0,
    sumFreq: 0, nFreq: 0,
    sumTemp: 0, nTemp: 0,

    // Bitmaps: max-merge over the bucket
    invAlarms: 0,
    trackAlarms: 0,

    sampleCount: 0,
  };
}

function _accum(b, row) {
  // row = the parsed object that the poller broadcasts. Field names mirror
  // services/inverter_engine.py read_fast_async output.
  const v = (k) => {
    const x = Number(row?.[k]);
    return Number.isFinite(x) ? x : null;
  };
  const vdc = v("vdc"), idc = v("idc"), pac = v("pac"), fac = v("fac_hz");
  const vac1 = v("vac1"), vac2 = v("vac2"), vac3 = v("vac3");
  const iac1 = v("iac1"), iac2 = v("iac2"), iac3 = v("iac3");
  const cosphi = v("cosphi");                     // added to read_fast_async (reg 16 / 1000)
  const tempC = v("temp_c");                      // future: NULL until source identified
  const alarm32 = v("alarm_32");

  if (vdc != null)  { b.sumVdc += vdc;   b.nVdc++; }
  if (idc != null)  { b.sumIdc += idc;   b.nIdc++; }
  if (vdc != null && idc != null) {
    // Pdc computed from Vdc × Idc (matches ISM display within ~2%; ISM derives
    // it from these same fields). Stored as integer W.
    b.sumPdc += vdc * idc;  b.nPdc++;
  }
  if (vac1 != null) { b.sumVac1 += vac1; b.nVac1++; }
  if (vac2 != null) { b.sumVac2 += vac2; b.nVac2++; }
  if (vac3 != null) { b.sumVac3 += vac3; b.nVac3++; }
  if (iac1 != null) { b.sumIac1 += iac1; b.nIac1++; }
  if (iac2 != null) { b.sumIac2 += iac2; b.nIac2++; }
  if (iac3 != null) { b.sumIac3 += iac3; b.nIac3++; }
  if (pac != null)  { b.sumPac += pac * 10; b.nPac++; }   // reg 18 is deca-watts
  if (cosphi != null) { b.sumCos += cosphi; b.nCos++; }
  if (fac != null)  { b.sumFreq += fac; b.nFreq++; }
  if (tempC != null){ b.sumTemp += tempC; b.nTemp++; }
  if (alarm32 != null) {
    b.invAlarms = (Number(b.invAlarms) | (alarm32 >>> 0)) >>> 0;
  }

  b.sampleCount += 1;
  b.tsMs = Number(row?.ts) || b.tsMs;
}

function _avg(sum, n, fixed = null) {
  if (!n) return null;
  const x = sum / n;
  return fixed == null ? x : Math.round(x * (10 ** fixed)) / (10 ** fixed);
}

function _flush(b) {
  if (!_db || b.sampleCount === 0) return;
  const inSolar = _isSolarWindow(b.slotIndex) ? 1 : 0;
  const row = {
    inverter_ip: b.ip,
    slave: b.slave,
    date_local: b.dateLocal,
    slot_index: b.slotIndex,
    ts_ms: b.tsMs,
    vdc_v:    _avg(b.sumVdc,  b.nVdc,  1),
    idc_a:    _avg(b.sumIdc,  b.nIdc,  2),
    pdc_w:    b.nPdc ? Math.round(b.sumPdc / b.nPdc) : null,
    vac1_v:   _avg(b.sumVac1, b.nVac1, 1),
    vac2_v:   _avg(b.sumVac2, b.nVac2, 1),
    vac3_v:   _avg(b.sumVac3, b.nVac3, 1),
    iac1_a:   _avg(b.sumIac1, b.nIac1, 2),
    iac2_a:   _avg(b.sumIac2, b.nIac2, 2),
    iac3_a:   _avg(b.sumIac3, b.nIac3, 2),
    temp_c:   b.nTemp ? Math.round(b.sumTemp / b.nTemp) : null,
    pac_w:    b.nPac ? Math.round(b.sumPac / b.nPac) : null,
    cosphi:   _avg(b.sumCos, b.nCos, 3),
    freq_hz:  _avg(b.sumFreq, b.nFreq, 2),
    inv_alarms: Number(b.invAlarms) >>> 0,
    track_alarms: Number(b.trackAlarms) >>> 0,
    sample_count: b.sampleCount,
    is_complete: 1,
    in_solar_window: inSolar,
  };
  try {
    _db.prepare(`
      INSERT OR REPLACE INTO inverter_5min_param (
        inverter_ip, slave, date_local, slot_index, ts_ms,
        vdc_v, idc_a, pdc_w,
        vac1_v, vac2_v, vac3_v,
        iac1_a, iac2_a, iac3_a,
        temp_c, pac_w, cosphi, freq_hz,
        inv_alarms, track_alarms,
        sample_count, is_complete, in_solar_window,
        updated_ts
      ) VALUES (
        @inverter_ip, @slave, @date_local, @slot_index, @ts_ms,
        @vdc_v, @idc_a, @pdc_w,
        @vac1_v, @vac2_v, @vac3_v,
        @iac1_a, @iac2_a, @iac3_a,
        @temp_c, @pac_w, @cosphi, @freq_hz,
        @inv_alarms, @track_alarms,
        @sample_count, @is_complete, @in_solar_window,
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      )
    `).run(row);
  } catch (err) {
    console.warn(`[dailyAgg] flush failed for ${b.ip}|${b.slave} slot ${b.slotIndex}:`, err?.message || err);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

function ingestLiveSample(row) {
  if (!row || !row.source_ip || row.unit == null) return;
  // Skip offline frames — they have pac=0 and online=0 but no real samples.
  if (Number(row.online) === 0 && Number(row.pac || 0) === 0
      && Number(row.vdc || 0) === 0 && Number(row.vac1 || 0) === 0) {
    return;
  }
  const tsMs = Number(row.ts) || Date.now();
  const parts = _localParts(tsMs);
  const dateLocal = _formatDateLocal(parts);
  const slot = _slotIndex(parts);
  const key = `${row.source_ip}|${row.unit}`;

  let b = buckets.get(key);
  if (!b || b.dateLocal !== dateLocal || b.slotIndex !== slot) {
    if (b) _flush(b);     // close out the previous slot before starting the new one
    b = _newBucket(row.source_ip, row.unit, dateLocal, slot, tsMs);
    buckets.set(key, b);
  }
  _accum(b, row);
}

function flushAll() {
  for (const [, b] of buckets) _flush(b);
}

function reapStale() {
  const now = Date.now();
  for (const [key, b] of buckets) {
    const slotEnd = _slotEndMs(b.dateLocal, b.slotIndex);
    if (now > slotEnd + FLUSH_GRACE_MS) {
      _flush(b);
      buckets.delete(key);
    }
  }
}

// Expose the in-progress bucket for the live UI tile. Returns the
// CURRENTLY filling row's averages (sample_count > 0) — never persisted
// data. Read-side endpoints should union this with the persisted rows
// to render today's table without a 5-minute gap at the bottom.
function getCurrentBucket(ip, slave) {
  const b = buckets.get(`${ip}|${Number(slave)}`);
  if (!b || b.sampleCount === 0) return null;
  return {
    inverter_ip: b.ip,
    slave: b.slave,
    date_local: b.dateLocal,
    slot_index: b.slotIndex,
    ts_ms: b.tsMs,
    vdc_v:    _avg(b.sumVdc,  b.nVdc,  1),
    idc_a:    _avg(b.sumIdc,  b.nIdc,  2),
    pdc_w:    b.nPdc ? Math.round(b.sumPdc / b.nPdc) : null,
    vac1_v:   _avg(b.sumVac1, b.nVac1, 1),
    vac2_v:   _avg(b.sumVac2, b.nVac2, 1),
    vac3_v:   _avg(b.sumVac3, b.nVac3, 1),
    iac1_a:   _avg(b.sumIac1, b.nIac1, 2),
    iac2_a:   _avg(b.sumIac2, b.nIac2, 2),
    iac3_a:   _avg(b.sumIac3, b.nIac3, 2),
    temp_c:   b.nTemp ? Math.round(b.sumTemp / b.nTemp) : null,
    pac_w:    b.nPac ? Math.round(b.sumPac / b.nPac) : null,
    cosphi:   _avg(b.sumCos, b.nCos, 3),
    freq_hz:  _avg(b.sumFreq, b.nFreq, 2),
    inv_alarms: Number(b.invAlarms) >>> 0,
    track_alarms: Number(b.trackAlarms) >>> 0,
    sample_count: b.sampleCount,
    is_complete: 0,
    in_solar_window: _isSolarWindow(b.slotIndex) ? 1 : 0,
  };
}

// ─── Retention pruner ──────────────────────────────────────────────────────

function pruneRetention(retainDays) {
  if (!_db) return { deleted: 0 };
  const days = Math.max(7, Math.min(3650, Number(retainDays) || 365));
  const cutoff = new Date(Date.now() - days * 86400_000);
  const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  try {
    const r = _db.prepare(`DELETE FROM inverter_5min_param WHERE date_local < ?`).run(cutoffStr);
    return { deleted: r.changes || 0, cutoff: cutoffStr };
  } catch (err) {
    console.warn("[dailyAgg] prune failed:", err?.message || err);
    return { deleted: 0, error: String(err?.message || err) };
  }
}

module.exports = {
  init,
  ingestLiveSample,
  flushAll,
  getCurrentBucket,
  pruneRetention,
  // exposed for tests
  _internal: { buckets, _slotIndex, _formatDateLocal, _localParts, _isSolarWindow, _slotEndMs },
};
