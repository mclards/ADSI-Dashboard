'use strict';
/**
 * exporter.js Ã¢â‚¬â€ Production CSV export engine
 * All exports use plant-standard filename conventions
 */

const fs   = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const {
  db,
  stmts,
  getSetting,
  queryReadingsRangeAll,
  queryReadingsRange,
  queryEnergy5minRange,
  queryEnergy5minRangeAll,
} = require('./db');
const { formatAlarmHex, decodeAlarm } = require('./alarms');

const PORTABLE_ROOT = String(process.env.IM_PORTABLE_DATA_DIR || '').trim();
const PROGRAMDATA_ROOT = PORTABLE_ROOT
  ? path.join(PORTABLE_ROOT, 'programdata')
  : path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'InverterDashboard');
const FORECAST_CTX_PATH = path.join(
  PROGRAMDATA_ROOT,
  'forecast',
  'context',
  'global',
  'global.json',
);

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function pad2(n) { return String(n).padStart(2,'0'); }

function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}
function fmtDDMMYY(ts) {
  const d = new Date(ts);
  const dd = pad2(d.getDate());
  const mm = pad2(d.getMonth() + 1);
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}${mm}${yy}`;
}
function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function fmtDateTime(ts) { return `${fmtDate(ts)} ${fmtTime(ts)}`; }
function startOfLocalDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function getSolarWindowBoundsForTs(ts) {
  const day = fmtDate(ts);
  return {
    startTs: new Date(`${day}T05:00:00.000`).getTime(),
    endTs: new Date(`${day}T18:00:00.000`).getTime(),
  };
}

function isWithinSolarWindowTs(ts) {
  const n = Number(ts || 0);
  if (!Number.isFinite(n) || n <= 0) return false;
  const { startTs, endTs } = getSolarWindowBoundsForTs(n);
  return n >= startTs && n <= endTs;
}

function formatDurationMs(ms) {
  const totalSec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return days > 0 ? `${days}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

const COMPUTED_ENERGY_MAX_DT_MS = 30000;

function annotateReadingsWithComputedEnergy(rowsRaw) {
  const rows = Array.isArray(rowsRaw) ? rowsRaw.slice() : [];
  const lastByKey = new Map();
  const totalByKey = new Map();
  return rows.map((row) => {
    const ts = Number(row?.ts || 0);
    const inverter = Number(row?.inverter || 0);
    const unit = Number(row?.unit || 0);
    const pac = Math.max(0, Number(row?.pac || 0));
    const day = fmtDate(ts);
    const key = `${day}|${inverter}|${unit}`;
    const prev = lastByKey.get(key);
    let totalKwh = Number(totalByKey.get(key) || 0);

    if (prev && ts > prev.ts) {
      const dtMs = ts - prev.ts;
      if (dtMs > 0 && dtMs <= COMPUTED_ENERGY_MAX_DT_MS) {
        const avgPac = (prev.pac + pac) / 2;
        totalKwh += (avgPac * dtMs) / 3600000000.0;
      }
    }

    totalKwh = Number(totalKwh.toFixed(6));
    lastByKey.set(key, { ts, pac });
    totalByKey.set(key, totalKwh);
    return {
      ...row,
      computed_kwh: totalKwh,
    };
  });
}

// Daily report metric constants aligned with dashboard computation semantics.
const REPORT_SOLAR_WINDOW_H = 13;     // 05:00Ã¢â‚¬â€œ18:00
const REPORT_INVERTER_KW = 997;       // one inverter rated capacity in kW

function clampPct(v) {
  return Math.max(0, Math.min(100, safeNum(v, 0)));
}

// Daily availability:
// uptime time ratio over the fixed solar window.
function calcDailyAvailabilityPct(row) {
  const explicit = Number(row?.availability_pct);
  if (Number.isFinite(explicit)) return clampPct(explicit);
  const uptimeH = Math.max(0, safeNum(row?.uptime_s) / 3600); // s -> h
  if (REPORT_SOLAR_WINDOW_H <= 0) return 0;
  return clampPct((uptimeH / REPORT_SOLAR_WINDOW_H) * 100);
}

// Daily performance:
// actual energy vs rated inverter output during online uptime.
function calcDailyPerformancePct(row) {
  const explicit = Number(row?.performance_pct);
  if (Number.isFinite(explicit)) return clampPct(explicit);
  const kwh = Math.max(0, safeNum(row?.kwh_total));
  const uptimeH = Math.max(0, safeNum(row?.uptime_s) / 3600); // s -> h
  const denom = REPORT_INVERTER_KW * uptimeH;
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  return clampPct((kwh / denom) * 100);
}
function deriveReportRatedKw(row) {
  const explicit = safeNum(row?.rated_kw);
  if (explicit > 0) return explicit;
  const expectedNodes = Math.max(0, Math.trunc(safeNum(row?.expected_nodes)));
  if (expectedNodes > 0) {
    return REPORT_INVERTER_KW * (expectedNodes / 4);
  }
  return REPORT_INVERTER_KW;
}
function buildDailyReportTotalRow(rows, date, plantName) {
  const dayRows = Array.isArray(rows) ? rows : [];
  const inverterSlots = dayRows.length;
  let totalKwh = 0;
  let totalUptimeS = 0;
  let totalAlarms = 0;
  let totalPerfDenom = 0;
  for (const row of dayRows) {
    const kwhTotal = Math.max(0, safeNum(row?.kwh_total));
    const uptimeS = Math.max(0, safeNum(row?.uptime_s));
    totalKwh += kwhTotal;
    totalUptimeS += uptimeS;
    totalAlarms += Math.max(0, Math.trunc(safeNum(row?.alarm_count)));
    totalPerfDenom += deriveReportRatedKw(row) * (uptimeS / 3600);
  }
  const availabilityDenomS = inverterSlots * REPORT_SOLAR_WINDOW_H * 3600;
  const availabilityPct =
    availabilityDenomS > 0 ? clampPct((totalUptimeS / availabilityDenomS) * 100) : 0;
  const performancePct =
    totalPerfDenom > 0 ? clampPct((totalKwh / totalPerfDenom) * 100) : 0;
  return {
    Date:             date,
    Plant:            plantName,
    Inverter:         'TOTAL',
    Energy_kWh:       totalKwh.toFixed(3),
    Energy_MWh:       (totalKwh / 1000).toFixed(6),
    Peak_Pac_kW:      '',
    Avg_Pac_kW:       '',
    Availability_pct: availabilityPct.toFixed(2),
    Performance_pct:  performancePct.toFixed(2),
    Uptime_h:         (totalUptimeS / 3600).toFixed(2),
    Alarm_Count:      totalAlarms,
    Status:           'TOTAL',
  };
}

function toCsv(headers, rows) {
  const escape = v => {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  const headerRow = headers.map(h => typeof h === 'object' ? h.label : h).join(',');
  const keys      = headers.map(h => typeof h === 'object' ? h.key   : h);
  return [headerRow, ...rows.map(r => keys.map(k => escape(r[k])).join(','))].join('\r\n');
}

function parseDateSortValue(v) {
  const s = String(v ?? '').trim();
  if (!s) return Number.POSITIVE_INFINITY;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T00:00:00`).getTime();
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s)) {
    const [mStr, dStr, yRaw] = s.split('/');
    const m = Number(mStr);
    const d = Number(dStr);
    if (m < 1 || m > 12 || d < 1 || d > 31) return Number.POSITIVE_INFINITY;
    const y = yRaw.length === 2 ? Number(`20${yRaw}`) : Number(yRaw);
    return new Date(y, m - 1, d).getTime();
  }
  const ts = Date.parse(s);
  return Number.isFinite(ts) ? ts : Number.POSITIVE_INFINITY;
}

function parseTimeSortValue(v) {
  const s = String(v ?? '').trim();
  if (!s) return Number.POSITIVE_INFINITY;
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return Number.POSITIVE_INFINITY;
  const hh = Number(m[1] || 0);
  const mm = Number(m[2] || 0);
  const ss = Number(m[3] || 0);
  return (hh * 3600) + (mm * 60) + ss;
}

function parseInverterSortValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v ?? '').trim();
  if (!s) return Number.POSITIVE_INFINITY;
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

function parseNodeSortValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v ?? '').trim();
  if (!s) return Number.POSITIVE_INFINITY;
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

function sortRowsDateInverterTime(
  rows,
  { dateKey = 'Date', inverterKey = 'Inverter', timeKey = 'Time', tieBreakerKeys = [] } = {},
) {
  return (rows || [])
    .map((row, idx) => ({ row, idx }))
    .sort((a, b) => {
      const da = parseDateSortValue(a.row?.[dateKey]);
      const db = parseDateSortValue(b.row?.[dateKey]);
      if (da !== db) return da - db;

      const ia = parseInverterSortValue(a.row?.[inverterKey]);
      const ib = parseInverterSortValue(b.row?.[inverterKey]);
      if (ia !== ib) return ia - ib;

      if (timeKey) {
        const ta = parseTimeSortValue(a.row?.[timeKey]);
        const tb = parseTimeSortValue(b.row?.[timeKey]);
        if (ta !== tb) return ta - tb;
      }

      for (const k of tieBreakerKeys) {
        const va = String(a.row?.[k] ?? '');
        const vb = String(b.row?.[k] ?? '');
        if (va < vb) return -1;
        if (va > vb) return 1;
      }

      return a.idx - b.idx;
    })
    .map((x) => x.row);
}

function insertBlankRowsByGroup(
  rows,
  { groupKeys = ['Date', 'Inverter'], headerKeys = [] } = {},
) {
  const out = [];
  if (!Array.isArray(rows) || !rows.length) return out;

  const blank = {};
  headerKeys.forEach((k) => {
    blank[k] = '';
  });

  let prevGroup = null;
  for (const row of rows) {
    const group = groupKeys.map((k) => String(row?.[k] ?? '')).join('|');
    if (prevGroup !== null && group !== prevGroup) {
      out.push({ ...blank });
    }
    out.push(row);
    prevGroup = group;
  }
  return out;
}

function readForecastContext() {
  try {
    if (!fs.existsSync(FORECAST_CTX_PATH)) return {};
    return JSON.parse(fs.readFileSync(FORECAST_CTX_PATH, 'utf8'));
  } catch (err) {
    console.warn('[exporter] readForecastContext failed:', err.message);
    return {};
  }
}

function parseForecastTs(dayStr, timeText) {
  const day = String(dayStr || '').trim();
  const time = String(timeText || '').trim();
  const mDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const mTime = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!mDay || !mTime) return null;
  const y = Number(mDay[1]);
  const mo = Number(mDay[2]) - 1;
  const d = Number(mDay[3]);
  const hh = Number(mTime[1]);
  const mm = Number(mTime[2]);
  const ss = Number(mTime[3] || 0);
  return new Date(y, mo, d, hh, mm, ss, 0).getTime();
}

function iterateLocalDates(startTs, endTs) {
  const out = [];
  const d = new Date(startOfLocalDay(startTs));
  const end = startOfLocalDay(endTs);
  while (d.getTime() <= end) {
    out.push(
      `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    );
    d.setDate(d.getDate() + 1);
  }
  return out;
}


function normalizeFormat(format) {
  const f = String(format || 'csv').trim().toLowerCase();
  return f === 'xlsx' ? 'xlsx' : 'csv';
}

async function writeExport(headers, rows, dir, filenameBase, format) {
  const fmt = normalizeFormat(format);
  if (fmt === 'xlsx') {
    const labels = headers.map((h) => (typeof h === 'object' ? h.label : h));
    const keys = headers.map((h) => (typeof h === 'object' ? h.key : h));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Export', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    ws.addRow(labels);
    for (const r of rows) {
      ws.addRow(keys.map((k) => r[k] ?? ''));
    }

    if (keys.length) {
      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: keys.length },
      };
    }

    // Center all cells; bold and center header row.
    ws.eachRow((row, rowNumber) => {
      row.eachCell((cell) => {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        if (rowNumber === 1) {
          cell.font = { bold: true };
        }
      });
    });

    // Auto-fit column widths based on header + content length.
    keys.forEach((k, idx) => {
      const headerLen = String(labels[idx] ?? '').length;
      const dataLen = rows.reduce((max, r) => {
        const len = String(r[k] ?? '').length;
        return len > max ? len : max;
      }, 0);
      const width = Math.min(64, Math.max(10, Math.max(headerLen, dataLen) + 2));
      ws.getColumn(idx + 1).width = width;
    });

    const xlsxPath = path.join(dir, `${filenameBase}.xlsx`);
    await wb.xlsx.writeFile(xlsxPath);
    return xlsxPath;
  }

  const csvPath = path.join(dir, `${filenameBase}.csv`);
  fs.writeFileSync(csvPath, '\uFEFF' + toCsv(headers, rows)); // BOM for Excel
  return csvPath;
}

const EXPORT_FOLDERS = {
  alarms: 'Alarms',
  energy: 'Energy',
  inverterData: 'Inverter Data',
  audits: 'Audits',
  daily: 'Daily Report',
  forecast: 'Forecast',
};

function inverterFolderLabel(inverter) {
  if (!inverter || inverter === 'all') return 'All Inverters';
  const n = Number(inverter);
  return Number.isFinite(n) && n > 0 ? `Inverter ${n}` : 'All Inverters';
}

function exportTargetName(inverter) {
  if (!inverter || inverter === 'all') return 'All Inverters';
  const n = Number(inverter);
  return Number.isFinite(n) && n > 0 ? `Inverter ${n}` : 'All Inverters';
}

function exportFileBase(startTs, endTs, inverter, suffix) {
  const s = fmtDDMMYY(startTs);
  const e = fmtDDMMYY(endTs);
  const target = exportTargetName(inverter);
  const base = `${s}-${e} ${target} ${suffix}`;
  // Truncate to leave buffer under Windows 260-char path limit.
  return base.length > 200 ? base.slice(0, 200) : base;
}

function normalizeEnergyResolution(resolution) {
  const raw = String(resolution || '5min').trim().toLowerCase().replace(/\s+/g, '');
  if (raw === '15' || raw === '15min' || raw === '15m') {
    return { mode: 'bucket', minutes: 15, label: '15min', suffix: 'Recorded Energy 15min' };
  }
  if (raw === '30' || raw === '30min' || raw === '30m') {
    return { mode: 'bucket', minutes: 30, label: '30min', suffix: 'Recorded Energy 30min' };
  }
  if (raw === '60' || raw === '1hr' || raw === '1h' || raw === '1hour') {
    return { mode: 'bucket', minutes: 60, label: '1hr', suffix: 'Recorded Energy 1hr' };
  }
  if (raw === 'daily') {
    return { mode: 'day', label: 'Daily', suffix: 'Recorded Energy Daily' };
  }
  // Backward compatibility for previously used values.
  if (raw === '1day' || raw === 'day' || raw === '24h') {
    return { mode: 'day', label: 'Daily', suffix: 'Recorded Energy Daily' };
  }
  if (raw === 'entireday' || raw === 'entire' || raw === 'total') {
    return { mode: 'day', label: 'Daily', suffix: 'Recorded Energy Daily' };
  }
  return { mode: 'bucket', minutes: 5, label: '5min', suffix: 'Recorded Energy 5min' };
}

function normalizeInverterDataInterval(intervalMin) {
  const raw = Number(intervalMin);
  const minutes = Math.min(60, Math.max(1, Math.trunc(Number.isFinite(raw) ? raw : 1)));
  return {
    minutes,
    bucketMs: minutes * 60000,
    label: `${minutes}min`,
    suffix: `Recorded Inverter Data ${minutes}min`,
  };
}

function aggregateEnergyRows(rows, resolutionSpec, rangeStart) {
  const out = new Map();
  const bucketMs = (resolutionSpec.minutes || 5) * 60000;

  for (const r of rows) {
    const inv = safeNum(r.inverter);
    const ts  = safeNum(r.ts);
    const inc = Math.max(0, safeNum(r.kwh_inc));   // kWh increment is never negative
    if (!inv || !ts) continue;

    let bucketTs;
    if (resolutionSpec.mode === 'day') {
      const d = new Date(ts);
      bucketTs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    } else {
      bucketTs = Math.floor(ts / bucketMs) * bucketMs;
    }
    const key = `${inv}|${bucketTs}`;
    const prev = out.get(key);
    if (prev) prev.kwh_inc += inc;
    else out.set(key, { inverter: inv, ts: bucketTs, kwh_inc: inc });
  }

  return Array.from(out.values()).sort((a, b) => (a.inverter - b.inverter) || (a.ts - b.ts));
}

function sampleReadingsByInterval(rowsRaw, intervalSpec) {
  const rows = annotateReadingsWithComputedEnergy(rowsRaw);
  if (!Array.isArray(rows) || !rows.length) return [];
  const bucketMs = Math.max(60000, Number(intervalSpec?.bucketMs || 60000));
  const sampled = [];
  let currentKey = '';
  let currentRow = null;

  for (const row of rows) {
    const inv = Number(row?.inverter || 0);
    const unit = Number(row?.unit || 0);
    const ts = Number(row?.ts || 0);
    if (!(inv > 0) || !(unit > 0) || !(ts > 0)) continue;
    const bucketTs = Math.floor(ts / bucketMs) * bucketMs;
    const key = `${inv}|${unit}|${bucketTs}`;
    if (currentKey && key !== currentKey && currentRow) sampled.push(currentRow);
    currentKey = key;
    currentRow = row;
  }
  if (currentRow) sampled.push(currentRow);
  return sampled;
}

function aggregateKwhByResolution(rows, resolutionSpec) {
  const out = new Map();
  const bucketMs = (resolutionSpec.minutes || 5) * 60000;

  for (const r of rows || []) {
    const ts  = safeNum(r?.ts);
    const kwh = Math.max(0, safeNum(r?.kwh_inc));   // increment never negative
    if (!ts) continue;

    let bucketTs;
    if (resolutionSpec.mode === 'day') {
      bucketTs = startOfLocalDay(ts);
    } else {
      bucketTs = Math.floor(ts / bucketMs) * bucketMs;
    }
    out.set(bucketTs, safeNum(out.get(bucketTs)) + kwh);
  }

  return Array.from(out.entries())
    .map(([ts, kwh]) => ({
      ts:      safeNum(ts),
      kwh_inc: Number(kwh.toFixed(6)),
    }))
    .sort((a, b) => a.ts - b.ts);
}

function collectDayAheadRowsForRange(startTs, endTs) {
  try {
    const dbRows = db
      .prepare(
        'SELECT ts, kwh_inc FROM forecast_dayahead WHERE ts BETWEEN ? AND ? ORDER BY ts ASC',
      )
      .all(startTs, endTs);
    if (Array.isArray(dbRows) && dbRows.length) {
      return dbRows
        .map((r) => ({
          ts: Number(r?.ts || 0),
          kwh_inc: Number(Number(r?.kwh_inc || 0).toFixed(6)),
        }))
        .filter((r) => Number(r.ts) > 0);
    }
  } catch (err) {
    console.warn('[exporter] collectDayAheadRowsForRange DB query failed, using context fallback:', err.message);
  }

  const ctx = readForecastContext();
  const root = ctx && typeof ctx === 'object' ? ctx.PacEnergy_DayAhead : null;
  if (!root || typeof root !== 'object') return [];

  const out = [];
  const dates = iterateLocalDates(startTs, endTs);
  for (const day of dates) {
    const series = root[day];
    if (!Array.isArray(series)) continue;
    for (const rec of series) {
      const ts = parseForecastTs(day, rec?.time);
      if (!ts || ts < startTs || ts > endTs) continue;
      const kwh = Number(rec?.kWh_inc ?? rec?.kwh_inc ?? 0);
      out.push({
        ts: Number(ts),
        kwh_inc: Number.isFinite(kwh) ? Number(kwh.toFixed(6)) : 0,
      });
    }
  }
  out.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  return out;
}

function resolveExportDir(inverter, categoryFolder) {
  const validFolders = new Set(Object.values(EXPORT_FOLDERS));
  if (!validFolders.has(categoryFolder)) {
    throw new Error(`[exporter] Invalid export category folder: "${categoryFolder}"`);
  }

  const base = getSetting('csvSavePath', 'C:\\Logs\\InverterDashboard');
  const invDir = path.join(base, inverterFolderLabel(inverter));
  ensureDir(invDir);

  // Create standard category tree for consistency.
  Object.values(EXPORT_FOLDERS).forEach((name) => ensureDir(path.join(invDir, name)));

  const target = path.join(invDir, categoryFolder);
  ensureDir(target);
  return target;
}

function readInverterIpMap() {
  try {
    const raw = JSON.parse(String(getSetting('ipConfigJson', '{}') || '{}'));
    const src = raw && typeof raw === 'object' ? raw.inverters || {} : {};
    const map = {};
    for (let inv = 1; inv <= 27; inv++) {
      const v = String(src[inv] ?? src[String(inv)] ?? '').trim();
      if (v) map[inv] = v;
    }
    return map;
  } catch (err) {
    console.warn('[exporter] readInverterIpMap failed:', err.message);
    return {};
  }
}

// Returns { invCount, units: { [inv]: number[] } } from ipConfigJson.
function readInverterConfig() {
  const invCount = Math.max(1, Number(getSetting('inverterCount', 27)) || 27);
  const defaultNodeCount = Math.max(1, Number(getSetting('nodeCount', 4)) || 4);
  const defaultUnits = Array.from({ length: defaultNodeCount }, (_, idx) => idx + 1);
  const units = {};
  try {
    const raw = JSON.parse(String(getSetting('ipConfigJson', '{}') || '{}'));
    const src = raw && typeof raw === 'object' ? raw : {};
    for (let inv = 1; inv <= invCount; inv++) {
      const unitsRaw = src?.units?.[inv] ?? src?.units?.[String(inv)];
      const parsed = Array.isArray(unitsRaw)
        ? unitsRaw.map((n) => Number(n)).filter((n) => n >= 1 && n <= 16)
        : [];
      units[inv] = parsed.length ? [...new Set(parsed)] : defaultUnits.slice();
    }
  } catch {
    for (let inv = 1; inv <= invCount; inv++) units[inv] = defaultUnits.slice();
  }
  return { invCount, units };
}

// Safe finite-number helper Ã¢â‚¬â€ never returns NaN or Infinity.
function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function resolveAuditIp(ipMap, inverter, currentIp) {
  const cur = String(currentIp || '').trim();
  const low = cur.toLowerCase();
  if (cur && !['::1', '127.0.0.1', 'localhost', '::ffff:127.0.0.1'].includes(low)) {
    return cur;
  }
  const inv = Number(inverter || 0);
  if (!inv) return '';
  return String(ipMap[inv] || '').trim();
}

function endOfLocalDay(startTs) {
  const d = new Date(Number(startTs || 0));
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function summarizeReadingsForEnergy(rowsRaw) {
  const rows = annotateReadingsWithComputedEnergy(rowsRaw);
  const states = new Map();
  for (const row of rows) {
    const ts = Number(row?.ts || 0);
    const inverter = Number(row?.inverter || 0);
    const unit = Number(row?.unit || 0);
    if (!(ts > 0) || !(inverter > 0) || !(unit > 0)) continue;
    const key = `${inverter}|${unit}`;
    let state = states.get(key);
    if (!state) {
      state = {
        inverter,
        unit,
        first_ts: ts,
        last_ts: ts,
        sample_count: 0,
        online_samples: 0,
        pac_peak: 0,
        energy_kwh: 0,
      };
      states.set(key, state);
    }
    state.sample_count += 1;
    if (Number(row?.online || 0) === 1) state.online_samples += 1;
    state.pac_peak = Math.max(state.pac_peak, Math.max(0, Number(row?.pac || 0)));
    if (ts < state.first_ts) state.first_ts = ts;
    if (ts >= state.last_ts) {
      state.last_ts = ts;
      state.energy_kwh = Math.max(0, Number(row?.computed_kwh || 0));
    }
  }
  return states;
}

function getSummaryEnergyKwh(row) {
  const first = Number(row?.first_kwh || 0);
  const last = Number(row?.last_kwh || first);
  const diff = last - first;
  if (Number.isFinite(diff) && diff > 0) return diff;
  return Math.max(0, Number(last || 0));
}

function collectEnergyExportRows(startTs, endTs, inverter) {
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  const invNum = inverter && inverter !== 'all' ? Number(inverter) : null;
  const { invCount, units: invUnits } = readInverterConfig();
  const selectedInvs = invNum ? [invNum] : Array.from({ length: invCount }, (_, idx) => idx + 1);
  const mapped = [];

  for (const day of iterateLocalDates(s, e)) {
    const summaryRows = stmts.getDailyReadingsSummaryDay
      .all(day)
      .filter((row) => !invNum || Number(row?.inverter || 0) === invNum);
    const summaryMap = new Map(
      summaryRows.map((row) => [`${Number(row?.inverter || 0)}|${Number(row?.unit || 0)}`, row]),
    );

    let fallbackMap = null;
    const needsFallback = selectedInvs.some((inv) =>
      (invUnits[inv] || []).some((unit) => !summaryMap.has(`${inv}|${unit}`)),
    );
    if (needsFallback) {
      const dayStart = new Date(`${day}T00:00:00`).getTime();
      const dayEnd = endOfLocalDay(dayStart);
      const rows = invNum
        ? queryReadingsRange(invNum, dayStart, dayEnd)
        : queryReadingsRangeAll(dayStart, dayEnd);
      fallbackMap = summarizeReadingsForEnergy(rows);
    }

    for (const inv of selectedInvs) {
      const units = (invUnits[inv] || []).slice().sort((a, b) => a - b);
      let subtotalKwh = 0;
      for (const unit of units) {
        const key = `${inv}|${unit}`;
        const summary = summaryMap.get(key);
        const fallback = fallbackMap?.get(key) || null;
        const firstTs = Number(summary?.first_ts || fallback?.first_ts || 0);
        const lastTs = Number(summary?.last_ts || fallback?.last_ts || 0);
        const sampleCount = Math.max(
          0,
          Math.trunc(Number(summary?.sample_count || fallback?.sample_count || 0)),
        );
        const onlineSamples = Math.max(
          0,
          Math.trunc(Number(summary?.online_samples || fallback?.online_samples || 0)),
        );
        const pacPeakW = Math.max(0, Number(summary?.pac_peak || fallback?.pac_peak || 0));
        const energyKwh = summary
          ? Math.max(0, getSummaryEnergyKwh(summary))
          : Math.max(0, Number(fallback?.energy_kwh || 0));
        subtotalKwh += energyKwh;
        mapped.push({
          Date: day,
          Inverter: `INV-${String(inv).padStart(2, '0')}`,
          Node: unit,
          First_Seen: firstTs ? fmtTime(firstTs) : '',
          Last_Seen: lastTs ? fmtTime(lastTs) : '',
          Samples: sampleCount,
          Online_Samples: onlineSamples,
          Peak_Pac_kW: (pacPeakW / 1000).toFixed(3),
          Energy_kWh: Number(energyKwh).toFixed(3),
          Energy_MWh: Number(energyKwh / 1000).toFixed(6),
          Status: energyKwh > 0 || onlineSamples > 0 ? 'ACTIVE' : 'INACTIVE',
        });
      }

      mapped.push({
        Date: `Total for ${day} (Inverter ${inv})`,
        Inverter: '',
        Node: '',
        First_Seen: '',
        Last_Seen: '',
        Samples: '',
        Online_Samples: '',
        Peak_Pac_kW: '',
        Energy_kWh: Number(subtotalKwh).toFixed(3),
        Energy_MWh: Number(subtotalKwh / 1000).toFixed(6),
        Status: subtotalKwh > 0 ? 'ACTIVE' : 'INACTIVE',
      });
      mapped.push({
        Date: '',
        Inverter: '',
        Node: '',
        First_Seen: '',
        Last_Seen: '',
        Samples: '',
        Online_Samples: '',
        Peak_Pac_kW: '',
        Energy_kWh: '',
        Energy_MWh: '',
        Status: '',
      });
    }
  }

  return mapped;
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Alarms CSV Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
async function exportAlarms({ startTs, endTs, inverter, format }) {
  const dir = resolveExportDir(inverter, EXPORT_FOLDERS.alarms);

  const s = startTs || Date.now()-86400000;
  const e = endTs   || Date.now();
  const nowTs = Date.now();

  const raw = inverter && inverter !== 'all'
    ? db.prepare('SELECT * FROM alarms WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts ASC').all(Number(inverter),s,e)
    : db.prepare('SELECT * FROM alarms WHERE ts BETWEEN ? AND ? ORDER BY ts ASC').all(s,e);

  const rows = raw.map(r => {
    const operator = getSetting('operatorName', 'OPERATOR');
    const occurredTs = Number(r.ts || 0) || 0;
    const clearedTs = r.cleared_ts ? Number(r.cleared_ts) : null;
    const status = clearedTs ? 'CLEARED' : 'ACTIVE';
    const durationEndTs = clearedTs || nowTs;
    const durationMs = occurredTs ? Math.max(0, durationEndTs - occurredTs) : 0;
    return ({
    Date:         fmtDate(occurredTs),
    Time:         fmtTime(occurredTs),
    DateTime:     fmtDateTime(occurredTs),
    Plant:        getSetting('plantName','ADSI Plant'),
    Operator:     operator,
    Inverter:     `INV-${String(r.inverter).padStart(2,'0')}`,
    Unit:         r.unit,
    AlarmCode:    formatAlarmHex(r.alarm_value),
    AlarmValue:   r.alarm_value || 0,
    Severity:     (r.severity || 'fault').toUpperCase(),
    Description:  decodeAlarm(r.alarm_value).map(b=>b.label).join('; ') || 'No alarm',
    ClearedDate:  clearedTs ? fmtDate(clearedTs)  : '',
    ClearedTime:  clearedTs ? fmtTime(clearedTs)  : '',
    Duration:     formatDurationMs(durationMs),
    Duration_min: Number((durationMs / 60000).toFixed(2)),
    Status:       status,
    Acknowledged: r.acknowledged ? 'YES' : 'NO',
  })});

  const headers = [
    {key:'Date',label:'Date'},{key:'Time',label:'Time'},{key:'Plant',label:'Plant'},
    {key:'Operator',label:'Operator'},
    {key:'Inverter',label:'Inverter'},{key:'Unit',label:'Unit/Node'},
    {key:'AlarmCode',label:'Alarm Code (Hex)'},{key:'Severity',label:'Severity'},
    {key:'Description',label:'Description'},{key:'ClearedDate',label:'Cleared Date'},
    {key:'ClearedTime',label:'Cleared Time'},{key:'Duration',label:'Duration (HH:MM:SS)'},
    {key:'Duration_min',label:'Duration (min)'},
    {key:'Status',label:'Status'},{key:'Acknowledged',label:'Acknowledged'},
  ];
  const headerKeys = headers.map((h) => h.key);
  const sortedRows = sortRowsDateInverterTime(rows, {
    dateKey: 'Date',
    inverterKey: 'Inverter',
    timeKey: 'Time',
    tieBreakerKeys: ['Unit', 'AlarmCode'],
  });
  const finalRows = insertBlankRowsByGroup(sortedRows, {
    groupKeys: ['Date', 'Inverter'],
    headerKeys,
  });

  const fileBase = exportFileBase(s, e, inverter, 'Recorded Alarms');
  return await writeExport(headers, finalRows, dir, fileBase, format);
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Energy CSV Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// Per-unit (node) rows showing computed energy only.
// Energy is derived from PAC trapezoidal integration with a 30 000 ms gap cap,
// aligned with the poller and energy_5min computation path.
async function exportEnergy({ startTs, endTs, inverter, format }) {
  const dir = resolveExportDir(inverter, EXPORT_FOLDERS.energy);

  const s = startTs || Date.now() - 86400000;
  const e = endTs   || Date.now();
  const invNum = inverter && inverter !== 'all' ? Number(inverter) : null;
  const mapped = collectEnergyExportRows(s, e, inverter);
  const grandComp = mapped.reduce((sum, row) => {
    if (String(row?.Date || '').startsWith('Total for ')) {
      return sum + Math.max(0, safeNum(row?.Energy_kWh));
    }
    return sum;
  }, 0);

  mapped.push({
    Date:       `GRAND TOTAL ${fmtDDMMYY(s)}-${fmtDDMMYY(e)} (${invNum ? `INVERTER ${invNum}` : 'ALL INVERTERS'})`,
    Inverter:   '',
    Node:       '',
    First_Seen: '',
    Last_Seen: '',
    Samples: '',
    Online_Samples: '',
    Peak_Pac_kW: '',
    Energy_kWh: Number(grandComp).toFixed(3),
    Energy_MWh: Number((grandComp / 1000).toFixed(6)),
    Status:     '',
  });

  const headers = [
    { key: 'Date',       label: 'Date' },
    { key: 'Inverter',   label: 'Inverter' },
    { key: 'Node',       label: 'Node' },
    { key: 'First_Seen', label: 'First Seen' },
    { key: 'Last_Seen', label: 'Last Seen' },
    { key: 'Samples', label: 'Samples' },
    { key: 'Online_Samples', label: 'Online Samples' },
    { key: 'Peak_Pac_kW', label: 'Peak Pac (kW)' },
    { key: 'Energy_kWh', label: 'Computed PAC (kWh)' },
    { key: 'Energy_MWh', label: 'Computed PAC (MWh)' },
    { key: 'Status',     label: 'Status' },
  ];

  const fileBase = exportFileBase(s, e, inverter, 'Recorded Energy');
  return await writeExport(headers, mapped, dir, fileBase, format);
}

// Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€ Inverter Data (raw readings) Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€Ã¢â‚¬â€
async function exportInverterData({ startTs, endTs, inverter, format, intervalMin }) {
  const dir = resolveExportDir(inverter, EXPORT_FOLDERS.inverterData);

  const s = startTs || Date.now() - 86400000;
  const e = endTs || Date.now();
  const interval = normalizeInverterDataInterval(intervalMin);
  const invList = (inverter && inverter !== 'all')
    ? [Number(inverter)]
    : [...Array(Number(getSetting('inverterCount', 27)))].map((_, i) => i + 1);

  const rowsOut = [];
  for (const inv of invList) {
    for (const r of sampleReadingsByInterval(queryReadingsRange(inv, s, e), interval)) {
      const alarmValue = Number(r.alarm || 0);
      rowsOut.push({
        Date: fmtDate(r.ts),
        Time: fmtTime(r.ts),
        Interval: interval.label,
        Plant: getSetting('plantName', 'ADSI Plant'),
        Inverter: `INV-${String(r.inverter).padStart(2,'0')}`,
        UnitNode: r.unit,
        Pac_W: Number(r.pac || 0).toFixed(1),
        Pac_kW: (Number(r.pac || 0) / 1000).toFixed(3),
        Energy_kWh: Number(r.computed_kwh || 0).toFixed(3),
        AlarmCode: formatAlarmHex(alarmValue),
        AlarmDescription: decodeAlarm(alarmValue).map((b) => b.label).join('; ') || 'No alarm',
        Online: r.online ? 'YES' : 'NO',
      });
    }
  }

  const headers = [
    { key: 'Date', label: 'Date' },
    { key: 'Time', label: 'Time' },
    { key: 'Interval', label: 'Interval' },
    { key: 'Plant', label: 'Plant' },
    { key: 'Inverter', label: 'Inverter' },
    { key: 'UnitNode', label: 'Unit/Node' },
    { key: 'Pac_W', label: 'Pac (W)' },
    { key: 'Pac_kW', label: 'Pac (kW)' },
    { key: 'Energy_kWh', label: 'Computed Energy (kWh)' },
    { key: 'AlarmCode', label: 'Alarm Code' },
    { key: 'AlarmDescription', label: 'Alarm Description' },
    { key: 'Online', label: 'Online' },
  ];
  const headerKeys = headers.map((h) => h.key);
  const sortedRows = rowsOut
    .map((row, idx) => ({ row, idx }))
    .sort((a, b) => {
      const da = parseDateSortValue(a.row?.Date);
      const db = parseDateSortValue(b.row?.Date);
      if (da !== db) return da - db;

      const ia = parseInverterSortValue(a.row?.Inverter);
      const ib = parseInverterSortValue(b.row?.Inverter);
      if (ia !== ib) return ia - ib;

      const na = parseNodeSortValue(a.row?.UnitNode);
      const nb = parseNodeSortValue(b.row?.UnitNode);
      if (na !== nb) return na - nb;

      const ta = parseTimeSortValue(a.row?.Time);
      const tb = parseTimeSortValue(b.row?.Time);
      if (ta !== tb) return ta - tb;

      return a.idx - b.idx;
    })
    .map((entry) => entry.row);
  const finalRows = insertBlankRowsByGroup(sortedRows, {
    groupKeys: ['Date', 'Inverter'],
    headerKeys,
  });

  const fileBase = exportFileBase(s, e, inverter, interval.suffix);
  return await writeExport(headers, finalRows, dir, fileBase, format);
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ 5-min Energy CSV Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
async function export5min({ startTs, endTs, inverter, format, resolution }) {
  const dir = resolveExportDir(inverter, EXPORT_FOLDERS.energy);

  const s = startTs || Date.now()-86400000;
  const e = endTs   || Date.now();
  const spec = normalizeEnergyResolution(resolution);
  const rows = !inverter || inverter === 'all'
    ? queryEnergy5minRangeAll(s, e)
    : queryEnergy5minRange(Number(inverter), s, e);
  const aggregated = aggregateEnergyRows(rows, spec, s);

  // For "all inverters" daily-mode export, zero-fill inverters that had no data.
  if ((!inverter || inverter === 'all') && spec.mode === 'day') {
    const { invCount } = readInverterConfig();
    const covered = new Set(aggregated.map((r) => `${r.inverter}|${r.ts}`));
    for (const d of iterateLocalDates(s, e)) {
      const bucketTs = new Date(`${d}T00:00:00`).getTime();
      for (let inv = 1; inv <= invCount; inv++) {
        if (!covered.has(`${inv}|${bucketTs}`)) {
          aggregated.push({ inverter: inv, ts: bucketTs, kwh_inc: 0 });
        }
      }
    }
    aggregated.sort((a, b) => (a.inverter - b.inverter) || (a.ts - b.ts));
  }

  const plantName = getSetting('plantName', 'ADSI Plant');
  const mapped = aggregated.map((r) => ({
    Date:          fmtDate(r.ts),
    Time:          fmtTime(r.ts),
    Resolution:    spec.label,
    Plant:         plantName,
    Inverter:      `INV-${String(r.inverter).padStart(2, '0')}`,
    kWh_Increment: Math.max(0, safeNum(r.kwh_inc)).toFixed(6),
    MWh_Increment: (Math.max(0, safeNum(r.kwh_inc)) / 1000).toFixed(9),
  }));

  const headers = [
    { key: 'Date',          label: 'Date' },
    { key: 'Time',          label: 'Time' },
    { key: 'Resolution',    label: 'Resolution' },
    { key: 'Plant',         label: 'Plant' },
    { key: 'Inverter',      label: 'Inverter' },
    { key: 'kWh_Increment', label: 'Energy Increment (kWh)' },
    { key: 'MWh_Increment', label: 'Energy Increment (MWh)' },
  ];
  const headerKeys = headers.map((h) => h.key);
  const sortedRows = sortRowsDateInverterTime(mapped, {
    dateKey: 'Date',
    inverterKey: 'Inverter',
    timeKey: 'Time',
  });
  const finalRows = insertBlankRowsByGroup(sortedRows, {
    groupKeys: ['Date', 'Inverter'],
    headerKeys,
  });
  const fileBase = exportFileBase(s, e, inverter, spec.suffix);
  return await writeExport(headers, finalRows, dir, fileBase, format);
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Audit Log CSV Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
async function exportAudit({ startTs, endTs, inverter, format }) {
  const dir = resolveExportDir(inverter, EXPORT_FOLDERS.audits);

  const s = startTs || Date.now()-7*86400000;
  const e = endTs   || Date.now();
  const ipMap = readInverterIpMap();

  const raw = inverter && inverter !== 'all'
    ? db.prepare('SELECT * FROM audit_log WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts ASC').all(Number(inverter),s,e)
    : db.prepare('SELECT * FROM audit_log WHERE ts BETWEEN ? AND ? ORDER BY ts ASC').all(s,e);

  const mapped = raw.map(r => ({
    Date: fmtDate(r.ts), Time: fmtTime(r.ts), Plant: getSetting('plantName','ADSI Plant'),
    Operator: r.operator || 'OPERATOR',
    Inverter: `INV-${String(r.inverter).padStart(2,'0')}`,
    Node: r.node === 0 ? 'ALL' : `Node-${r.node}`,
    Action: r.action, Scope: (r.scope||'single').toUpperCase(),
    Result: r.result || 'ok', IP: resolveAuditIp(ipMap, r.inverter, r.ip),
  }));

  const headers = [
    {key:'Date',label:'Date'},{key:'Time',label:'Time'},{key:'Plant',label:'Plant'},
    {key:'Operator',label:'Operator'},{key:'Inverter',label:'Inverter'},{key:'Node',label:'Node'},
    {key:'Action',label:'Action'},{key:'Scope',label:'Scope'},{key:'Result',label:'Result'},{key:'IP',label:'IP Address'},
  ];
  const headerKeys = headers.map((h) => h.key);
  const sortedRows = sortRowsDateInverterTime(mapped, {
    dateKey: 'Date',
    inverterKey: 'Inverter',
    timeKey: 'Time',
    tieBreakerKeys: ['Node', 'Action'],
  });
  const finalRows = insertBlankRowsByGroup(sortedRows, {
    groupKeys: ['Date', 'Inverter'],
    headerKeys,
  });
  const fileBase = exportFileBase(s, e, inverter, 'Recorded Audits');
  return await writeExport(headers, finalRows, dir, fileBase, format);
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Daily Generation Report CSV Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
async function exportDailyReport({ startTs, endTs, date, format }) {
  const dir = resolveExportDir('all', EXPORT_FOLDERS.daily);
  const { invCount } = readInverterConfig();
  const plantName = getSetting('plantName', 'ADSI Plant');

  let dbRows;
  let s;
  let e;
  if (date) {
    dbRows = stmts.getDailyReport.all(date);
    s = new Date(`${date}T00:00:00`).getTime();
    e = s;
  } else {
    s = startTs || (Date.now() - 7 * 86400000);
    e = endTs || Date.now();
    dbRows = stmts.getDailyReportRange.all(fmtDate(s), fmtDate(e));
  }

  const existing = new Map();
  for (const r of dbRows) {
    existing.set(`${r.date}|${Number(r.inverter)}`, r);
  }

  const headers = [
    { key: 'Date',             label: 'Date' },
    { key: 'Plant',            label: 'Plant' },
    { key: 'Inverter',         label: 'Inverter' },
    { key: 'Energy_kWh',       label: 'Energy (kWh)' },
    { key: 'Energy_MWh',       label: 'Energy (MWh)' },
    { key: 'Peak_Pac_kW',      label: 'Peak Pac (kW)' },
    { key: 'Avg_Pac_kW',       label: 'Avg Pac (kW)' },
    { key: 'Availability_pct', label: 'Availability (%)' },
    { key: 'Performance_pct',  label: 'Performance (%)' },
    { key: 'Uptime_h',         label: 'Uptime (h)' },
    { key: 'Alarm_Count',      label: 'Alarm Count' },
    { key: 'Status',           label: 'Status' },
  ];
  const headerKeys = headers.map((h) => h.key);
  const blankRow = Object.fromEntries(headerKeys.map((k) => [k, '']));
  const finalRows = [];
  const reportDates = Array.from(iterateLocalDates(s, e));

  for (let dayIdx = 0; dayIdx < reportDates.length; dayIdx++) {
    const d = reportDates[dayIdx];
    const dayRows = [];
    for (let inv = 1; inv <= invCount; inv++) {
      const key = `${d}|${inv}`;
      dayRows.push(
        existing.get(key) || {
          date: d,
          inverter: inv,
          kwh_total: 0,
          pac_peak: 0,
          pac_avg: 0,
          uptime_s: 0,
          alarm_count: 0,
        },
      );
    }

    const mappedDayRows = sortRowsDateInverterTime(
      dayRows.map((r) => {
        const kwhTotal = Math.max(0, safeNum(r.kwh_total));
        const pacPeakW = Math.max(0, safeNum(r.pac_peak));
        const pacAvgW = Math.max(0, safeNum(r.pac_avg));
        const uptimeS = Math.max(0, safeNum(r.uptime_s));
        const alarms = Math.max(0, Math.trunc(safeNum(r.alarm_count)));
        return {
          Date:             r.date,
          Plant:            plantName,
          Inverter:         `INV-${String(r.inverter).padStart(2, '0')}`,
          Energy_kWh:       kwhTotal.toFixed(3),
          Energy_MWh:       (kwhTotal / 1000).toFixed(6),
          Peak_Pac_kW:      (pacPeakW / 1000).toFixed(3),
          Avg_Pac_kW:       (pacAvgW / 1000).toFixed(3),
          Availability_pct: calcDailyAvailabilityPct(r).toFixed(2),
          Performance_pct:  calcDailyPerformancePct(r).toFixed(2),
          Uptime_h:         (uptimeS / 3600).toFixed(2),
          Alarm_Count:      alarms,
          Status:           kwhTotal > 0 || uptimeS > 0 ? 'ACTIVE' : 'INACTIVE',
        };
      }),
      {
        dateKey: 'Date',
        inverterKey: 'Inverter',
        timeKey: null,
      },
    );

    finalRows.push(...mappedDayRows);
    finalRows.push(buildDailyReportTotalRow(dayRows, d, plantName));
    if (dayIdx < reportDates.length - 1) {
      finalRows.push({ ...blankRow });
    }
  }

  const fileBase = exportFileBase(s, e, 'all', 'Daily Report');
  return await writeExport(headers, finalRows, dir, fileBase, format);
}
async function exportForecastActual({ startTs, endTs, format, resolution }) {
  const dir = resolveExportDir('all', EXPORT_FOLDERS.forecast);
  const s = startTs || Date.now() - 86400000;
  const e = endTs || Date.now();
  const spec = normalizeEnergyResolution(resolution);

  const actualRaw = queryEnergy5minRangeAll(s, e).map((r) => ({
    ts: Number(r?.ts || 0),
    kwh_inc: Number(r?.kwh_inc || 0),
  })).filter((r) => isWithinSolarWindowTs(r.ts));
  const dayAheadRaw = collectDayAheadRowsForRange(s, e).filter((r) =>
    isWithinSolarWindowTs(r.ts),
  );

  const actualAgg = aggregateKwhByResolution(actualRaw, spec);
  const dayAheadAgg = aggregateKwhByResolution(dayAheadRaw, spec);

  const actualMap = new Map(actualAgg.map((r) => [Number(r.ts), Number(r.kwh_inc || 0)]));
  const dayAheadMap = new Map(dayAheadAgg.map((r) => [Number(r.ts), Number(r.kwh_inc || 0)]));
  const allTs = Array.from(new Set([...actualMap.keys(), ...dayAheadMap.keys()])).sort(
    (a, b) => a - b,
  );

  const plantName = getSetting('plantName', 'ADSI Plant');
  const rows = allTs.map((ts) => {
    const actualKwh   = Math.max(0, safeNum(actualMap.get(ts)));
    const dayAheadKwh = Math.max(0, safeNum(dayAheadMap.get(ts)));
    const deltaKwh    = actualKwh - dayAheadKwh;          // can be negative (under-forecast)
    return {
      Date:        fmtDate(ts),
      Time:        spec.mode === 'day' ? 'Daily' : fmtTime(ts),
      Resolution:  spec.mode === 'day' ? 'Daily' : spec.label,
      Plant:       plantName,
      ActualKWh:   actualKwh.toFixed(6),
      ActualMWh:   (actualKwh   / 1000).toFixed(6),
      DayAheadKWh: dayAheadKwh.toFixed(6),
      DayAheadMWh: (dayAheadKwh / 1000).toFixed(6),
      DeltaKWh:    deltaKwh.toFixed(6),
      DeltaMWh:    (deltaKwh    / 1000).toFixed(6),
    };
  });

  const headers = [
    { key: 'Date',        label: 'Date' },
    { key: 'Time',        label: 'Time' },
    { key: 'Resolution',  label: 'Resolution' },
    { key: 'Plant',       label: 'Plant' },
    { key: 'ActualKWh',   label: 'Actual (kWh)' },
    { key: 'ActualMWh',   label: 'Actual (MWh)' },
    { key: 'DayAheadKWh', label: 'Day-Ahead (kWh)' },
    { key: 'DayAheadMWh', label: 'Day-Ahead (MWh)' },
    { key: 'DeltaKWh',    label: 'Delta (kWh)' },
    { key: 'DeltaMWh',    label: 'Delta (MWh)' },
  ];
  const headerKeys = headers.map((h) => h.key);
  const sortedRows = sortRowsDateInverterTime(rows, {
    dateKey: 'Date',
    inverterKey: 'Plant',
    timeKey: 'Time',
  });
  const finalRows = insertBlankRowsByGroup(sortedRows, {
    groupKeys: ['Date'],
    headerKeys,
  });

  const resLabel = spec.mode === 'day' ? 'Daily' : spec.label;
  const fileBase = exportFileBase(s, e, 'all', `Day-Ahead vs Actual ${resLabel}`);
  return await writeExport(headers, finalRows, dir, fileBase, format);
}

module.exports = {
  exportAlarms,
  exportEnergy,
  exportInverterData,
  export5min,
  exportAudit,
  exportDailyReport,
  exportForecastActual,
};
