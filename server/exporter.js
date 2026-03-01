'use strict';
/**
 * exporter.js — Production CSV export engine
 * All exports use plant-standard filename conventions
 */

const fs   = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { db, stmts, getSetting } = require('./db');
const { formatAlarmHex, decodeAlarm } = require('./alarms');

const PORTABLE_ROOT = String(process.env.ADSI_PORTABLE_DATA_DIR || '').trim();
const PROGRAMDATA_ROOT = PORTABLE_ROOT
  ? path.join(PORTABLE_ROOT, 'programdata')
  : path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'ADSI-InverterDashboard');
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

function aggregateEnergyRows(rows, resolutionSpec, rangeStart) {
  const out = new Map();
  const bucketMs = (resolutionSpec.minutes || 5) * 60000;

  for (const r of rows) {
    const inv = Number(r.inverter || 0);
    const ts = Number(r.ts || 0);
    const inc = Number(r.kwh_inc || 0);
    if (!inv || !ts) continue;

    let key;
    let bucketTs;
    if (resolutionSpec.mode === 'day') {
      const d = new Date(ts);
      bucketTs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      key = `${inv}|${bucketTs}`;
    } else {
      bucketTs = Math.floor(ts / bucketMs) * bucketMs;
      key = `${inv}|${bucketTs}`;
    }

    const prev = out.get(key);
    if (prev) prev.kwh_inc += inc;
    else out.set(key, { inverter: inv, ts: bucketTs, kwh_inc: inc });
  }

  return Array.from(out.values()).sort((a, b) => (a.inverter - b.inverter) || (a.ts - b.ts));
}

function aggregateKwhByResolution(rows, resolutionSpec) {
  const out = new Map();
  const bucketMs = (resolutionSpec.minutes || 5) * 60000;

  for (const r of rows || []) {
    const ts = Number(r?.ts || 0);
    const kwh = Number(r?.kwh_inc || 0);
    if (!ts) continue;

    let bucketTs;
    if (resolutionSpec.mode === 'day') {
      bucketTs = startOfLocalDay(ts);
    } else {
      bucketTs = Math.floor(ts / bucketMs) * bucketMs;
    }
    out.set(bucketTs, Number(out.get(bucketTs) || 0) + kwh);
  }

  return Array.from(out.entries())
    .map(([ts, kwh]) => ({
      ts: Number(ts),
      kwh_inc: Number(Number(kwh || 0).toFixed(6)),
    }))
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
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

  const base = getSetting('csvSavePath', 'C:\\Logs\\ADSI');
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

// ─── Alarms CSV ───────────────────────────────────────────────────────────────
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
    Plant:        getSetting('plantName','ADSI Solar Plant'),
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

// ─── Energy CSV ───────────────────────────────────────────────────────────────
async function exportEnergy({ startTs, endTs, inverter, format }) {
  const dir = resolveExportDir(inverter, EXPORT_FOLDERS.energy);

  const s = startTs || Date.now()-86400000;
  const e = endTs   || Date.now();
  const invNum = inverter && inverter !== 'all' ? Number(inverter) : null;
  const sql = `
    WITH base AS (
      SELECT
        date(ts/1000, 'unixepoch', 'localtime') AS day,
        inverter,
        unit,
        ts,
        kwh
      FROM readings
      WHERE ts BETWEEN ? AND ?
      ${invNum ? 'AND inverter = ?' : ''}
    ),
    agg AS (
      SELECT
        day,
        inverter,
        unit,
        MIN(kwh) AS min_kwh,
        MAX(kwh) AS max_kwh,
        MAX(ts)  AS last_ts
      FROM base
      GROUP BY day, inverter, unit
    )
    SELECT
      day,
      inverter,
      unit,
      last_ts,
      CASE WHEN (max_kwh - min_kwh) < 0 THEN 0 ELSE (max_kwh - min_kwh) END AS reg_kwh
    FROM agg
    ORDER BY day, inverter, unit
  `;
  const params = invNum ? [s, e, invNum] : [s, e];
  const groups = db.prepare(sql).all(...params);
  groups.sort((a, b) => {
    const d = parseDateSortValue(a.day) - parseDateSortValue(b.day);
    if (d !== 0) return d;
    const invCmp = Number(a.inverter || 0) - Number(b.inverter || 0);
    if (invCmp !== 0) return invCmp;
    const t = Number(a.last_ts || 0) - Number(b.last_ts || 0);
    if (t !== 0) return t;
    return Number(a.unit || 0) - Number(b.unit || 0);
  });

  const mapped = [];
  let curDay = '';
  let curInv = -1;
  let subReg = 0;
  let subCalc = 0;
  let grandReg = 0;
  let grandCalc = 0;

  const pushSubtotal = () => {
    if (!curDay || curInv < 0) return;
    mapped.push({
      Date: `Total for ${curDay} (Inverter ${curInv})`,
      LastReadingTime: '',
      Inverter: '',
      Node: '',
      TotalKWhRegister: Number(subReg.toFixed(0)),
      TotalKWhCalc: Number(subCalc.toFixed(3)),
    });
    mapped.push({
      Date: '',
      LastReadingTime: '',
      Inverter: '',
      Node: '',
      TotalKWhRegister: '',
      TotalKWhCalc: '',
    });
  };

  for (const g of groups) {
    const regVal = Number(g.reg_kwh || 0);
    const calcVal = regVal; // keep matching export format; calc mirrors aggregated register delta

    if (curDay !== g.day || curInv !== Number(g.inverter)) {
      pushSubtotal();
      curDay = g.day;
      curInv = Number(g.inverter);
      subReg = 0;
      subCalc = 0;
    }

    subReg += regVal;
    subCalc += calcVal;
    grandReg += regVal;
    grandCalc += calcVal;

    mapped.push({
      Date: g.day,
      LastReadingTime: fmtTime(g.last_ts),
      Inverter: Number(g.inverter),
      Node: Number(g.unit),
      TotalKWhRegister: Number(regVal.toFixed(0)),
      TotalKWhCalc: Number(calcVal.toFixed(3)),
    });
  }
  pushSubtotal();

  mapped.push({
    Date: `GRAND TOTAL for ${fmtDDMMYY(s)}-${fmtDDMMYY(e)} (ALL INVERTERS)`,
    LastReadingTime: '',
    Inverter: '',
    Node: '',
    TotalKWhRegister: Number(grandReg.toFixed(0)),
    TotalKWhCalc: Number(grandCalc.toFixed(3)),
  });

  const headers = [
    { key: 'Date', label: 'Date' },
    { key: 'LastReadingTime', label: 'Last Reading Time' },
    { key: 'Inverter', label: 'Inverter' },
    { key: 'Node', label: 'Node' },
    { key: 'TotalKWhRegister', label: 'Total kWh (Register)' },
    { key: 'TotalKWhCalc', label: 'Total kWh (Calc)' },
  ];

  const fileBase = exportFileBase(s, e, inverter, 'Recorded Energy');
  return await writeExport(headers, mapped, dir, fileBase, format);
}

// ——— Inverter Data (raw readings) ———————————————————————————————————————————
async function exportInverterData({ startTs, endTs, inverter, format }) {
  const dir = resolveExportDir(inverter, EXPORT_FOLDERS.inverterData);

  const s = startTs || Date.now() - 86400000;
  const e = endTs || Date.now();
  const invList = (inverter && inverter !== 'all')
    ? [Number(inverter)]
    : [...Array(Number(getSetting('inverterCount', 27)))].map((_, i) => i + 1);

  const rowsOut = [];
  for (const inv of invList) {
    for (const r of stmts.getReadingsRange.all(inv, s, e)) {
      rowsOut.push({
        Date: fmtDate(r.ts),
        Time: fmtTime(r.ts),
        Plant: getSetting('plantName', 'ADSI Solar Plant'),
        Inverter: `INV-${String(r.inverter).padStart(2,'0')}`,
        UnitNode: r.unit,
        Vdc_V: Number(r.vdc || 0).toFixed(1),
        Idc_A: Number(r.idc || 0).toFixed(2),
        Vac1_V: Number(r.vac1 || 0).toFixed(1),
        Vac2_V: Number(r.vac2 || 0).toFixed(1),
        Vac3_V: Number(r.vac3 || 0).toFixed(1),
        Iac1_A: Number(r.iac1 || 0).toFixed(2),
        Iac2_A: Number(r.iac2 || 0).toFixed(2),
        Iac3_A: Number(r.iac3 || 0).toFixed(2),
        Pac_W: Number(r.pac || 0).toFixed(1),
        Pac_kW: (Number(r.pac || 0) / 1000).toFixed(3),
        Pdc_W: (Number(r.vdc || 0) * Number(r.idc || 0)).toFixed(1),
        Energy_kWh: Number(r.kwh || 0).toFixed(3),
        AlarmCode: formatAlarmHex(r.alarm),
        Online: r.online ? 'YES' : 'NO',
      });
    }
  }

  const headers = [
    { key: 'Date', label: 'Date' },
    { key: 'Time', label: 'Time' },
    { key: 'Plant', label: 'Plant' },
    { key: 'Inverter', label: 'Inverter' },
    { key: 'UnitNode', label: 'Unit/Node' },
    { key: 'Vdc_V', label: 'Vdc (V)' },
    { key: 'Idc_A', label: 'Idc (A)' },
    { key: 'Vac1_V', label: 'Vac1 (V)' },
    { key: 'Vac2_V', label: 'Vac2 (V)' },
    { key: 'Vac3_V', label: 'Vac3 (V)' },
    { key: 'Iac1_A', label: 'Iac1 (A)' },
    { key: 'Iac2_A', label: 'Iac2 (A)' },
    { key: 'Iac3_A', label: 'Iac3 (A)' },
    { key: 'Pac_W', label: 'Pac (W)' },
    { key: 'Pac_kW', label: 'Pac (kW)' },
    { key: 'Pdc_W', label: 'Pdc (W)' },
    { key: 'Energy_kWh', label: 'Energy (kWh)' },
    { key: 'AlarmCode', label: 'Alarm Code' },
    { key: 'Online', label: 'Online' },
  ];
  const headerKeys = headers.map((h) => h.key);
  const sortedRows = sortRowsDateInverterTime(rowsOut, {
    dateKey: 'Date',
    inverterKey: 'Inverter',
    timeKey: 'Time',
    tieBreakerKeys: ['UnitNode'],
  });
  const finalRows = insertBlankRowsByGroup(sortedRows, {
    groupKeys: ['Date', 'Inverter'],
    headerKeys,
  });

  const fileBase = exportFileBase(s, e, inverter, 'Recorded Inverter Data');
  return await writeExport(headers, finalRows, dir, fileBase, format);
}

// ─── 5-min Energy CSV ─────────────────────────────────────────────────────────
async function export5min({ startTs, endTs, inverter, format, resolution }) {
  const dir = resolveExportDir(inverter, EXPORT_FOLDERS.energy);

  const s = startTs || Date.now()-86400000;
  const e = endTs   || Date.now();
  const spec = normalizeEnergyResolution(resolution);
  const rows = !inverter || inverter === 'all'
    ? stmts.get5minRangeAll.all(s, e)
    : stmts.get5minRange.all(Number(inverter), s, e);
  const aggregated = aggregateEnergyRows(rows, spec, s);

  const mapped = aggregated.map(r => ({
    Date: fmtDate(r.ts),
    Time: fmtTime(r.ts),
    Resolution: spec.label,
    Plant: getSetting('plantName','ADSI Solar Plant'),
    Inverter: `INV-${String(r.inverter).padStart(2,'0')}`,
    kWh_Increment: Number(r.kwh_inc).toFixed(6),
  }));

  const headers = [
    {key:'Date',label:'Date'},
    {key:'Time',label:'Time'},
    {key:'Resolution',label:'Resolution'},
    {key:'Plant',label:'Plant'},
    {key:'Inverter',label:'Inverter'},
    {key:'kWh_Increment',label:'Energy Increment (kWh)'},
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

// ─── Audit Log CSV ────────────────────────────────────────────────────────────
async function exportAudit({ startTs, endTs, inverter, format }) {
  const dir = resolveExportDir(inverter, EXPORT_FOLDERS.audits);

  const s = startTs || Date.now()-7*86400000;
  const e = endTs   || Date.now();
  const ipMap = readInverterIpMap();

  const raw = inverter && inverter !== 'all'
    ? db.prepare('SELECT * FROM audit_log WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts ASC').all(Number(inverter),s,e)
    : db.prepare('SELECT * FROM audit_log WHERE ts BETWEEN ? AND ? ORDER BY ts ASC').all(s,e);

  const mapped = raw.map(r => ({
    Date: fmtDate(r.ts), Time: fmtTime(r.ts), Plant: getSetting('plantName','ADSI Solar Plant'),
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

// ─── Daily Generation Report CSV ──────────────────────────────────────────────
async function exportDailyReport({ startTs, endTs, date, format }) {
  const dir = resolveExportDir('all', EXPORT_FOLDERS.daily);

  let rows;
  let s;
  let e;
  if (date) {
    rows = stmts.getDailyReport.all(date);
    const dayStart = new Date(`${date}T00:00:00`).getTime();
    s = dayStart;
    e = dayStart;
  } else {
    s = startTs || (Date.now() - 7 * 86400000);
    e = endTs || Date.now();
    rows = stmts.getDailyReportRange.all(fmtDate(s), fmtDate(e));
  }

  const mapped = rows.map(r => ({
    Date: r.date, Plant: getSetting('plantName','ADSI Solar Plant'),
    Inverter: `INV-${String(r.inverter).padStart(2,'0')}`,
    Energy_kWh:   Number(r.kwh_total||0).toFixed(3),
    Peak_Pac_kW:  (Number(r.pac_peak||0)/1000).toFixed(3),
    Avg_Pac_kW:   (Number(r.pac_avg||0)/1000).toFixed(3),
    Uptime_h:     (Number(r.uptime_s||0)/3600).toFixed(2),
    Alarm_Count:  r.alarm_count || 0,
  }));

  const headers = [
    {key:'Date',label:'Date'},{key:'Plant',label:'Plant'},{key:'Inverter',label:'Inverter'},
    {key:'Energy_kWh',label:'Energy (kWh)'},{key:'Peak_Pac_kW',label:'Peak Pac (kW)'},
    {key:'Avg_Pac_kW',label:'Avg Pac (kW)'},{key:'Uptime_h',label:'Uptime (h)'},{key:'Alarm_Count',label:'Alarm Count'},
  ];
  const headerKeys = headers.map((h) => h.key);
  const sortedRows = sortRowsDateInverterTime(mapped, {
    dateKey: 'Date',
    inverterKey: 'Inverter',
    timeKey: null,
  });
  const finalRows = insertBlankRowsByGroup(sortedRows, {
    groupKeys: ['Date'],
    headerKeys,
  });

  const fileBase = exportFileBase(s, e, 'all', 'Daily Report');
  return await writeExport(headers, finalRows, dir, fileBase, format);
}

async function exportForecastActual({ startTs, endTs, format, resolution }) {
  const dir = resolveExportDir('all', EXPORT_FOLDERS.forecast);
  const s = startTs || Date.now() - 86400000;
  const e = endTs || Date.now();
  const spec = normalizeEnergyResolution(resolution);

  const actualRaw = stmts.get5minRangeAll.all(s, e).map((r) => ({
    ts: Number(r?.ts || 0),
    kwh_inc: Number(r?.kwh_inc || 0),
  }));
  const dayAheadRaw = collectDayAheadRowsForRange(s, e);

  const actualAgg = aggregateKwhByResolution(actualRaw, spec);
  const dayAheadAgg = aggregateKwhByResolution(dayAheadRaw, spec);

  const actualMap = new Map(actualAgg.map((r) => [Number(r.ts), Number(r.kwh_inc || 0)]));
  const dayAheadMap = new Map(dayAheadAgg.map((r) => [Number(r.ts), Number(r.kwh_inc || 0)]));
  const allTs = Array.from(new Set([...actualMap.keys(), ...dayAheadMap.keys()])).sort(
    (a, b) => a - b,
  );

  const rows = allTs.map((ts) => {
    const actualKwh = Number(actualMap.get(ts) || 0);
    const dayAheadKwh = Number(dayAheadMap.get(ts) || 0);
    return {
      Date: fmtDate(ts),
      Time: spec.mode === 'day' ? 'Daily' : fmtTime(ts),
      Resolution: spec.mode === 'day' ? 'Daily' : spec.label,
      Plant: getSetting('plantName', 'ADSI Solar Plant'),
      ActualMWh: Number((actualKwh / 1000).toFixed(6)),
      DayAheadMWh: Number((dayAheadKwh / 1000).toFixed(6)),
      DeltaMWh: Number(((actualKwh - dayAheadKwh) / 1000).toFixed(6)),
    };
  });

  const headers = [
    { key: 'Date', label: 'Date' },
    { key: 'Time', label: 'Time' },
    { key: 'Resolution', label: 'Resolution' },
    { key: 'Plant', label: 'Plant' },
    { key: 'ActualMWh', label: 'Actual MWh' },
    { key: 'DayAheadMWh', label: 'Day-Ahead MWh' },
    { key: 'DeltaMWh', label: 'Delta MWh' },
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
