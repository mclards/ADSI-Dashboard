'use strict';
/**
 * exporter.js Ã¢â‚¬â€ Production CSV export engine
 * All exports use plant-standard filename conventions
 */

const fs   = require('fs');
const path = require('path');
const { once } = require('events');
const ExcelJS = require('exceljs');
const { getPortableDataRoot } = require('./runtimeEnvPaths');
const {
  db,
  stmts,
  getSetting,
  queryReadingsRangeAll,
  queryReadingsRange,
  queryEnergy5minRange,
  queryEnergy5minRangeAll,
  sumEnergy5minByInverterRange,
} = require('./db');
const { formatAlarmHex, decodeAlarm } = require('./alarms');

const PORTABLE_ROOT = getPortableDataRoot();
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

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

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

function escapeCsvCell(v) {
  const s = String(v ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g, '""')}"`
    : s;
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

const EXPORT_WRITE_YIELD_EVERY = 250;
const XLSX_NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

async function writeCsvExport(headers, rows, csvPath) {
  const keys = headers.map((h) => (typeof h === 'object' ? h.key : h));
  const labels = headers.map((h) => (typeof h === 'object' ? h.label : h));
  const stream = fs.createWriteStream(csvPath, { encoding: 'utf8' });
  const done = new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
  const writeChunk = async (chunk) => {
    if (!stream.write(chunk)) {
      await once(stream, 'drain');
    }
  };

  try {
    await writeChunk('\uFEFF');
    await writeChunk(`${labels.join(',')}\r\n`);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const line = `${keys.map((k) => escapeCsvCell(row[k])).join(',')}\r\n`;
      await writeChunk(line);
      if ((i + 1) % EXPORT_WRITE_YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }
    }
    stream.end();
    await done;
    return csvPath;
  } catch (err) {
    stream.destroy(err);
    throw err;
  }
}

function inferXlsxNumericFormat(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return null;
  const raw = String(value ?? '').trim();
  if (!XLSX_NUMERIC_RE.test(raw)) return null;
  const normalized = raw.replace(/^[+-]/, '');
  if (!normalized.includes('.')) return '0';
  const decimals = normalized.split('.')[1] || '';
  return decimals.length > 0 ? `0.${'0'.repeat(decimals.length)}` : '0';
}

function normalizeXlsxCellValue(value, header = null) {
  const forceText = String(header?.xlsxType || '').trim().toLowerCase() === 'string';
  if (forceText) {
    return { value: value ?? '', numFmt: null };
  }
  if (typeof value === 'number') {
    return {
      value: Number.isFinite(value) ? value : '',
      numFmt: Number.isFinite(value) ? null : null,
    };
  }
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return { value: '', numFmt: null };
    if (XLSX_NUMERIC_RE.test(raw)) {
      const numeric = Number(raw);
      if (Number.isFinite(numeric)) {
        return {
          value: numeric,
          numFmt: inferXlsxNumericFormat(value),
        };
      }
    }
    return { value, numFmt: null };
  }
  return { value: value ?? '', numFmt: null };
}

const XLSX_THEME = {
  headerFill: {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF24435C' },
  },
  headerFont: {
    bold: true,
    color: { argb: 'FFFFFFFF' },
  },
  headerBorder: {
    top: { style: 'thin', color: { argb: 'FF1B3145' } },
    left: { style: 'thin', color: { argb: 'FF1B3145' } },
    bottom: { style: 'medium', color: { argb: 'FF1B3145' } },
    right: { style: 'thin', color: { argb: 'FF1B3145' } },
  },
  cellBorder: {
    top: { style: 'thin', color: { argb: 'FFD4DCE6' } },
    left: { style: 'thin', color: { argb: 'FFD4DCE6' } },
    bottom: { style: 'thin', color: { argb: 'FFD4DCE6' } },
    right: { style: 'thin', color: { argb: 'FFD4DCE6' } },
  },
  altRowFill: {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF7FAFD' },
  },
  summaryMetricFill: {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFEAF1F8' },
  },
  summaryValueFill: {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFCFDFE' },
  },
  highlightFill: {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFF2CC' },
  },
  separatorFill: {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF2F4F7' },
  },
};

function setWorkbookMetadata(wb, title = 'ADSI Dashboard Export') {
  if (!wb) return;
  wb.creator = 'ADSI Inverter Dashboard';
  wb.lastModifiedBy = 'ADSI Inverter Dashboard';
  wb.created = new Date();
  wb.modified = new Date();
  wb.subject = title;
  wb.company = 'ADSI Plant';
}

function columnNumberToLetter(colNumber) {
  let n = Math.max(1, Number(colNumber || 1));
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function isBlankXlsxRow(row, keys) {
  return keys.every((key) => String(row?.[key] ?? '').trim() === '');
}

function isHighlightXlsxRow(row, keys, options = {}) {
  if (options?.worksheetKind === 'summary') return false;
  return keys.some((key) => /^(TOTAL|DAY TOTAL|SUBTOTAL)$/i.test(String(row?.[key] ?? '').trim()));
}

function isSummaryHighlightMetric(metricLabel) {
  return /(total|variance|absolute error|wape|mean ape|peak interval|data rows)/i.test(
    String(metricLabel || '').trim(),
  );
}

function inferXlsxColumnWidth(value, header, options = {}) {
  const label = String(typeof header === 'object' ? header.label : header || '').trim();
  const raw = String(value ?? '');
  const needsWideText = /(description|message|notes?|reason|status|path|url|range|label|site|operator|plant)/i.test(label);
  const maxWidth = needsWideText ? 72 : 44;
  const minWidth = options?.worksheetKind === 'summary' ? 16 : 10;
  return Math.min(maxWidth, Math.max(minWidth, raw.length + 2, label.length + 2));
}

function inferXlsxCellAlignment(value, header, options = {}) {
  const label = String(typeof header === 'object' ? header.label : header || '').trim();
  const raw = String(value ?? '').trim();
  const isNumeric = typeof value === 'number' || XLSX_NUMERIC_RE.test(raw);
  if (options?.worksheetKind === 'summary' && label === 'Metric') {
    return { horizontal: 'left', vertical: 'middle' };
  }
  if (!raw) {
    return { horizontal: 'center', vertical: 'middle' };
  }
  if (isNumeric) {
    return { horizontal: 'right', vertical: 'middle' };
  }
  if (/(date|time|period|duration|status|severity|resolution|unit|node|inverter|plant|operator|acknowledged|window)/i.test(label)) {
    return { horizontal: 'center', vertical: 'middle' };
  }
  return { horizontal: 'left', vertical: 'middle' };
}

function shouldWrapXlsxCell(value, header) {
  const label = String(typeof header === 'object' ? header.label : header || '').trim();
  const raw = String(value ?? '');
  return /(description|message|notes?|reason|path|url|range)/i.test(label) && raw.length > 28;
}

async function writeXlsxWorksheet(wb, sheetName, headers, rows, options = {}) {
  const labels = headers.map((h) => (typeof h === 'object' ? h.label : h));
  const keys = headers.map((h) => (typeof h === 'object' ? h.key : h));
  const widths = labels.map((label) =>
    inferXlsxColumnWidth(label, label, options),
  );
  const ws = wb.addWorksheet(String(sheetName || 'Export').slice(0, 31), {
    views: [{ state: 'frozen', ySplit: Number(options?.freezeHeader ? 1 : 0) }],
  });

  ws.columns = keys.map((key, idx) => ({
    key,
    width: widths[idx],
    style: { alignment: { horizontal: 'left', vertical: 'middle' } },
  }));
  ws.properties.defaultRowHeight = 20;
  if (options?.autoFilter !== false && keys.length > 0) {
    ws.autoFilter = `A1:${columnNumberToLetter(keys.length)}1`;
  }

  const headerRow = ws.addRow(
    Object.fromEntries(keys.map((key, idx) => [key, labels[idx]])),
  );
  headerRow.height = 22;
  for (let colIdx = 0; colIdx < keys.length; colIdx++) {
    const cell = headerRow.getCell(colIdx + 1);
    cell.font = XLSX_THEME.headerFont;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.fill = XLSX_THEME.headerFill;
    cell.border = XLSX_THEME.headerBorder;
  }
  headerRow.commit();

  let visibleRowCount = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const xlsxRow = {};
    const numFmts = new Map();
    const blankSeparator = isBlankXlsxRow(row, keys);
    const highlightRow = isHighlightXlsxRow(row, keys, options);
    const summaryHighlight =
      options?.worksheetKind === 'summary' &&
      isSummaryHighlightMetric(row?.[keys[0]]);
    for (let colIdx = 0; colIdx < keys.length; colIdx++) {
      const key = keys[colIdx];
      const normalized = normalizeXlsxCellValue(row[key], headers[colIdx]);
      xlsxRow[key] = normalized.value;
      if (normalized.numFmt) {
        numFmts.set(colIdx + 1, normalized.numFmt);
      }
    }
    const worksheetRow = ws.addRow(xlsxRow);
    worksheetRow.height = blankSeparator ? 8 : 20;
    const rowIsStriped =
      !blankSeparator &&
      !highlightRow &&
      options?.worksheetKind !== 'summary' &&
      visibleRowCount % 2 === 1;
    for (let colIdx = 0; colIdx < keys.length; colIdx++) {
      const cell = worksheetRow.getCell(colIdx + 1);
      const header = headers[colIdx];
      const value = xlsxRow[keys[colIdx]];
      if (numFmts.has(colIdx + 1)) {
        cell.numFmt = numFmts.get(colIdx + 1);
      }
      cell.border = XLSX_THEME.cellBorder;
      cell.alignment = {
        ...inferXlsxCellAlignment(value, header, options),
        wrapText: shouldWrapXlsxCell(value, header),
      };

      if (blankSeparator) {
        cell.fill = XLSX_THEME.separatorFill;
      } else if (options?.worksheetKind === 'summary') {
        if (summaryHighlight) {
          cell.fill = XLSX_THEME.highlightFill;
          cell.font = { bold: true };
        } else if (colIdx === 0) {
          cell.fill = XLSX_THEME.summaryMetricFill;
          cell.font = { bold: true };
        } else {
          cell.fill = XLSX_THEME.summaryValueFill;
        }
      } else if (highlightRow) {
        cell.fill = XLSX_THEME.highlightFill;
        cell.font = { bold: true };
      } else if (rowIsStriped) {
        cell.fill = XLSX_THEME.altRowFill;
      }
    }

    worksheetRow.commit();
    for (let colIdx = 0; colIdx < keys.length; colIdx++) {
      const inferredWidth = inferXlsxColumnWidth(row[keys[colIdx]], headers[colIdx], options);
      if (inferredWidth > widths[colIdx]) {
        widths[colIdx] = inferredWidth;
      }
    }
    if (!blankSeparator) visibleRowCount += 1;
    if ((i + 1) % EXPORT_WRITE_YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
  }

  widths.forEach((width, idx) => {
    ws.getColumn(idx + 1).width = width;
  });

  ws.commit();
}

async function writeXlsxExport(headers, rows, xlsxPath, options = {}) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: xlsxPath,
    useStyles: true,
    useSharedStrings: false,
  });
  setWorkbookMetadata(wb, options?.title || 'ADSI Dashboard Export');

  const summaryHeaders = Array.isArray(options?.summaryHeaders)
    ? options.summaryHeaders
    : null;
  const summaryRows = Array.isArray(options?.summaryRows)
    ? options.summaryRows
    : null;
  if (summaryHeaders && summaryRows && summaryRows.length) {
    await writeXlsxWorksheet(
      wb,
      options?.summarySheetName || 'Summary',
      summaryHeaders,
      summaryRows,
      { freezeHeader: true, autoFilter: false, worksheetKind: 'summary' },
    );
  }

  await writeXlsxWorksheet(
    wb,
    options?.dataSheetName || 'Export',
    headers,
    rows,
    {
      freezeHeader: true,
      autoFilter: options?.autoFilter !== false,
      worksheetKind: options?.worksheetKind || 'data',
    },
  );

  await wb.commit();
  return xlsxPath;
}

async function writeExport(headers, rows, dir, filenameBase, format, options = {}) {
  const fmt = normalizeFormat(format);
  if (fmt === 'xlsx') {
    const xlsxPath = path.join(dir, `${filenameBase}.xlsx`);
    return writeXlsxExport(headers, rows, xlsxPath, options);
  }

  const csvPath = path.join(dir, `${filenameBase}.csv`);
  return writeCsvExport(headers, rows, csvPath);
}

const EXPORT_FOLDERS = {
  alarms: 'Alarms',
  energy: 'Energy',
  inverterData: 'Inverter Data',
  audits: 'Audits',
  daily: 'Daily Report',
  forecast: 'Forecast',
};
const FORECAST_EXPORT_SUBFOLDERS = {
  analytics: 'Analytics',
  solcast: 'Solcast',
};

function normalizeForecastExportSubfolder(subFolder) {
  const raw = String(subFolder || '').trim().toLowerCase();
  if (raw === 'analytics') return FORECAST_EXPORT_SUBFOLDERS.analytics;
  if (raw === 'solcast') return FORECAST_EXPORT_SUBFOLDERS.solcast;
  if (Object.values(FORECAST_EXPORT_SUBFOLDERS).includes(String(subFolder || '').trim())) {
    return String(subFolder || '').trim();
  }
  throw new Error(`[exporter] Invalid forecast export subfolder: "${subFolder}"`);
}

function isPathInsideBase(baseDir, targetPath) {
  const base = path.resolve(String(baseDir || ''));
  const target = path.resolve(String(targetPath || ''));
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function rewriteForecastExportRelativePath(relativePath, subFolder) {
  const normalizedSubFolder = normalizeForecastExportSubfolder(subFolder);
  const parts = String(relativePath || '')
    .trim()
    .split(/[\\/]+/)
    .filter(Boolean);
  if (!parts.length) return '';

  const forecastRootIdx = parts.findIndex((part) => part === EXPORT_FOLDERS.forecast);
  if (forecastRootIdx < 0) {
    return path.normalize(parts.join(path.sep));
  }

  const nextPart = parts[forecastRootIdx + 1] || '';
  if (Object.values(FORECAST_EXPORT_SUBFOLDERS).includes(nextPart)) {
    parts[forecastRootIdx + 1] = normalizedSubFolder;
  } else {
    parts.splice(forecastRootIdx + 1, 0, normalizedSubFolder);
  }
  return path.normalize(parts.join(path.sep));
}

async function ensureForecastExportSubfolder(outPath, subFolder) {
  const absolute = path.resolve(String(outPath || ''));
  if (!absolute) throw new Error('[exporter] Forecast export path is missing.');

  const base = path.resolve(
    String(getSetting('csvSavePath', 'C:\\Logs\\InverterDashboard') || 'C:\\Logs\\InverterDashboard'),
  );
  if (!isPathInsideBase(base, absolute)) {
    return absolute;
  }

  const relative = path.relative(base, absolute);
  const targetRelative = rewriteForecastExportRelativePath(relative, subFolder);
  const targetAbsolute = path.resolve(base, targetRelative);
  if (!targetRelative || targetAbsolute === absolute) {
    return absolute;
  }

  await fs.promises.mkdir(path.dirname(targetAbsolute), { recursive: true });
  try {
    await fs.promises.unlink(targetAbsolute);
  } catch (err) {
    if (String(err?.code || '').toUpperCase() !== 'ENOENT') throw err;
  }
  await fs.promises.rename(absolute, targetAbsolute);
  return targetAbsolute;
}

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

function exportSingleDateFileBase(dayTs, inverter, suffix) {
  const day = fmtDDMMYY(dayTs);
  const target = exportTargetName(inverter);
  const base = `${day} ${target} ${suffix}`;
  return base.length > 200 ? base.slice(0, 200) : base;
}

function exportDateAwareFileBase(startTs, endTs, inverter, suffix) {
  const s = Number(startTs || 0) || Date.now();
  const e = Number(endTs || 0) || s;
  return fmtDate(s) === fmtDate(e)
    ? exportSingleDateFileBase(s, inverter, suffix)
    : exportFileBase(s, e, inverter, suffix);
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

function resolveExportSubDir(inverter, categoryFolder, subFolder = '') {
  const baseDir = resolveExportDir(inverter, categoryFolder);
  const normalizedSubFolder = String(subFolder || '').trim();
  if (!normalizedSubFolder) return baseDir;
  if (normalizedSubFolder.includes('\\') || normalizedSubFolder.includes('/')) {
    throw new Error(`[exporter] Invalid export subfolder: "${subFolder}"`);
  }
  const target = path.join(baseDir, normalizedSubFolder);
  ensureDir(target);
  return target;
}

function resolveForecastExportDir(subFolder) {
  return resolveExportSubDir('all', EXPORT_FOLDERS.forecast, subFolder);
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

function buildTodaySupplementMap(rowsRaw) {
  const out = new Map();
  for (const row of rowsRaw || []) {
    const inv = Number(row?.inverter || 0);
    const totalKwh = Number(row?.total_kwh || 0);
    if (!(inv > 0) || !(totalKwh >= 0)) continue;
    out.set(inv, Math.max(0, Number(totalKwh.toFixed(6))));
  }
  return out;
}

function buildAuthoritativeTodayRangeMap(startTs, rowsRaw) {
  const todayMap = buildTodaySupplementMap(rowsRaw);
  if (!todayMap.size) return todayMap;

  const today = fmtDate(Date.now());
  const dayStartTs = new Date(`${today}T00:00:00.000`).getTime();
  const rangeStartTs = Number(startTs || 0);
  if (!(rangeStartTs > dayStartTs)) return todayMap;

  const beforeRangeMap = sumEnergy5minByInverterRange(
    dayStartTs,
    Math.max(dayStartTs, rangeStartTs - 1),
  );
  for (const [inv, totalKwh] of todayMap.entries()) {
    const adjusted = Math.max(0, totalKwh - Number(beforeRangeMap.get(inv) || 0));
    todayMap.set(inv, Number(adjusted.toFixed(6)));
  }

  return todayMap;
}

function buildEnergySummaryExportRows(startTs, endTs, inverter, options = {}) {
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  const invNum = inverter && inverter !== 'all' ? Number(inverter) : null;
  const { invCount, units: invUnits } = readInverterConfig();
  const selectedInvs = invNum ? [invNum] : Array.from({ length: invCount }, (_, idx) => idx + 1);
  const mapped = [];
  const today = fmtDate(Date.now());
  const rangeRows = invNum
    ? queryReadingsRange(invNum, s, e)
    : queryReadingsRangeAll(s, e);
  const rowsByDay = new Map();
  for (const row of rangeRows) {
    const ts = Number(row?.ts || 0);
    if (!(ts > 0)) continue;
    const day = fmtDate(ts);
    if (!rowsByDay.has(day)) rowsByDay.set(day, []);
    rowsByDay.get(day).push(row);
  }

  for (const day of iterateLocalDates(s, e)) {
    const dayRows = rowsByDay.get(day) || [];
    const dayMap = summarizeReadingsForEnergy(dayRows);
    let dayTotalMwh = 0;
    const dayStart = new Date(`${day}T00:00:00.000`).getTime();
    const dayEnd = new Date(`${day}T23:59:59.999`).getTime();
    const dayRangeStart = Math.max(s, dayStart);
    const dayRangeEnd = Math.min(e, dayEnd);
    const authoritativeByInv = sumEnergy5minByInverterRange(dayRangeStart, dayRangeEnd);
    if (day === today) {
      const supplementalTodayMap = buildAuthoritativeTodayRangeMap(
        dayRangeStart,
        options?.supplementalTodayRows,
      );
      for (const [inv, totalKwh] of supplementalTodayMap.entries()) {
        authoritativeByInv.set(inv, Math.max(authoritativeByInv.get(inv) || 0, totalKwh));
      }
    }

    for (const inv of selectedInvs) {
      const units = (invUnits[inv] || []).slice().sort((a, b) => a - b);
      const detailRows = [];
      let rawSubtotalKwh = 0;
      for (const unit of units) {
        const key = `${inv}|${unit}`;
        const summary = dayMap.get(key) || null;
        if (!summary) continue;
        const firstTs = Number(summary?.first_ts || 0);
        const lastTs = Number(summary?.last_ts || 0);
        const pacPeakW = Math.max(0, Number(summary?.pac_peak || 0));
        const energyKwh = Math.max(0, Number(summary?.energy_kwh || 0));
        rawSubtotalKwh += energyKwh;
        detailRows.push({
          Date: day,
          Inverter_Number: inv,
          Node_Number: unit,
          First_Seen: firstTs ? fmtTime(firstTs) : '',
          Last_Seen: lastTs ? fmtTime(lastTs) : '',
          Peak_Pac_kW: Number((pacPeakW / 1000).toFixed(3)),
          rawEnergyKwh: energyKwh,
        });
      }

      const authoritativeKwh = Math.max(0, Number(authoritativeByInv.get(inv) || 0));
      if (!(authoritativeKwh > 0) && !detailRows.length) continue;

      const scale =
        authoritativeKwh > 0 && rawSubtotalKwh > 0
          ? authoritativeKwh / rawSubtotalKwh
          : 1;
      let subtotalMwh = 0;
      for (const row of detailRows) {
        const energyMwh = (Number(row.rawEnergyKwh || 0) * scale) / 1000;
        subtotalMwh += energyMwh;
        mapped.push({
          Date: row.Date,
          Inverter_Number: row.Inverter_Number,
          Node_Number: row.Node_Number,
          First_Seen: row.First_Seen,
          Last_Seen: row.Last_Seen,
          Peak_Pac_kW: row.Peak_Pac_kW,
          Total_MWh: Number(energyMwh.toFixed(6)),
        });
      }
      if (authoritativeKwh > 0) {
        subtotalMwh = authoritativeKwh / 1000;
      }
      dayTotalMwh += subtotalMwh;

    }

    mapped.push({
      Date: day,
      Inverter_Number: 'DAY TOTAL',
      Node_Number: '',
      First_Seen: '',
      Last_Seen: '',
      Peak_Pac_kW: '',
      Total_MWh: Number(dayTotalMwh.toFixed(6)),
    });
  }

  return mapped;
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Alarms CSV Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function normalizeAlarmExportMinDurationSec(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(86400, Math.max(0, Math.trunc(raw)));
}

async function exportAlarms({ startTs, endTs, inverter, format, minAlarmDurationSec }) {
  const dir = resolveExportDir(inverter, EXPORT_FOLDERS.alarms);

  const s = startTs || Date.now()-86400000;
  const e = endTs   || Date.now();
  const nowTs = Date.now();
  const minDurationSec = normalizeAlarmExportMinDurationSec(minAlarmDurationSec);

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
    const durationSec = Math.floor(durationMs / 1000);
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
    Duration_sec: durationSec,
    Duration:     formatDurationMs(durationMs),
    Duration_min: Number((durationMs / 60000).toFixed(2)),
    Status:       status,
    Acknowledged: r.acknowledged ? 'YES' : 'NO',
  })}).filter((row) => Number(row.Duration_sec || 0) >= minDurationSec)
    .map(({ Duration_sec, ...row }) => row);

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

  const fileBase = exportDateAwareFileBase(s, e, inverter, 'Recorded Alarms');
  return await writeExport(headers, finalRows, dir, fileBase, format);
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Energy CSV Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// Per-unit (node) rows showing computed energy only.
// Energy is derived from PAC trapezoidal integration with a 30 000 ms gap cap,
// aligned with the poller and energy_5min computation path.
function writeEnergySummaryExport({ startTs, endTs, inverter, format, rows }) {
  const s = startTs || Date.now() - 86400000;
  const e = endTs || Date.now();
  const dir = resolveExportDir(inverter, EXPORT_FOLDERS.energy);
  const headers = [
    { key: 'Date',       label: 'Date' },
    { key: 'Inverter_Number',   label: 'Inverter Number' },
    { key: 'Node_Number',       label: 'Node Number' },
    { key: 'First_Seen', label: '1st Seen' },
    { key: 'Last_Seen', label: 'Last Seen' },
    { key: 'Peak_Pac_kW', label: 'Peak Pac (kW)' },
    { key: 'Total_MWh', label: 'Total MWh' },
  ];

  const fileBase = exportDateAwareFileBase(s, e, inverter, 'Energy Summary');
  return writeExport(headers, Array.isArray(rows) ? rows : [], dir, fileBase, format, {
    autoFilter: false,
  });
}

async function exportEnergy({ startTs, endTs, inverter, format, supplementalTodayRows }) {
  const s = startTs || Date.now() - 86400000;
  const e = endTs || Date.now();
  const mapped = buildEnergySummaryExportRows(s, e, inverter, {
    supplementalTodayRows,
  });
  return await writeEnergySummaryExport({
    startTs: s,
    endTs: e,
    inverter,
    format,
    rows: mapped,
  });
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

  const fileBase = exportDateAwareFileBase(s, e, inverter, interval.suffix);
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
  const fileBase = exportDateAwareFileBase(s, e, inverter, spec.suffix);
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
  const fileBase = exportDateAwareFileBase(s, e, inverter, 'Recorded Audits');
  return await writeExport(headers, finalRows, dir, fileBase, format);
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Daily Generation Report CSV Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
async function exportDailyReport({ startTs, endTs, date, format, rowsByDate }) {
  const dir = resolveExportDir('all', EXPORT_FOLDERS.daily);
  const { invCount } = readInverterConfig();
  const plantName = getSetting('plantName', 'ADSI Plant');

  let dbRows;
  let s;
  let e;
  if (date) {
    const overrideRows = rowsByDate && typeof rowsByDate === 'object'
      ? rowsByDate[date]
      : null;
    dbRows = Array.isArray(overrideRows) ? overrideRows : stmts.getDailyReport.all(date);
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
    const overrideRows = rowsByDate && typeof rowsByDate === 'object'
      ? rowsByDate[d]
      : null;
    const overrideByInv = Array.isArray(overrideRows)
      ? new Map(
        overrideRows.map((row) => [Number(row?.inverter || 0), row]),
      )
      : null;
    const dayRows = [];
    for (let inv = 1; inv <= invCount; inv++) {
      const key = `${d}|${inv}`;
      dayRows.push(
        (overrideByInv && overrideByInv.get(inv)) ||
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

  const fileBase = exportDateAwareFileBase(s, e, 'all', 'Daily Report');
  return await writeExport(headers, finalRows, dir, fileBase, format);
}
async function exportForecastActual({
  startTs,
  endTs,
  format,
  resolution,
  exportFormat,
  supplementalActualRows,
}) {
  const dir = resolveForecastExportDir(FORECAST_EXPORT_SUBFOLDERS.analytics);
  const s = startTs || Date.now() - 86400000;
  const e = endTs || Date.now();
  const spec = normalizeEnergyResolution(resolution);
  const extraActualRows = Array.isArray(supplementalActualRows)
    ? supplementalActualRows
    : [];

  const actualRaw = queryEnergy5minRangeAll(s, e)
    .map((r) => ({
      ts: Number(r?.ts || 0),
      kwh_inc: Number(r?.kwh_inc || 0),
    }))
    .concat(
      extraActualRows.map((r) => ({
        ts: Number(r?.ts || 0),
        kwh_inc: Number(r?.kwh_inc || 0),
      })),
    )
    .filter((r) => isWithinSolarWindowTs(r.ts));
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
    const deltaKwh    = actualKwh - dayAheadKwh;          // negative = over-forecast
    const absDeltaKwh = Math.abs(deltaKwh);
    const apePct = actualKwh > 0
      ? (absDeltaKwh / actualKwh) * 100
      : null;
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
      AbsDeltaKWh: absDeltaKwh.toFixed(6),
      AbsDeltaMWh: (absDeltaKwh / 1000).toFixed(6),
      ErrorPct:    apePct == null ? '' : apePct.toFixed(3),
    };
  });

  const actualTotalKwh = rows.reduce((sum, row) => sum + safeNum(row.ActualKWh), 0);
  const dayAheadTotalKwh = rows.reduce((sum, row) => sum + safeNum(row.DayAheadKWh), 0);
  const varianceTotalKwh = actualTotalKwh - dayAheadTotalKwh;
  const absErrorTotalKwh = rows.reduce((sum, row) => sum + safeNum(row.AbsDeltaKWh), 0);
  const mapeValues = rows
    .map((row) => safeNum(row.ErrorPct, Number.NaN))
    .filter((value) => Number.isFinite(value));
  const peakRow = rows.reduce((best, row) =>
    safeNum(row.ActualKWh) >= safeNum(best?.ActualKWh) ? row : best,
  null);
  const summaryHeaders = [
    { key: 'Metric', label: 'Metric', xlsxType: 'string' },
    { key: 'Value', label: 'Value', xlsxType: 'string' },
  ];
  const normalizedExportFormat = normalizeSolcastPreviewExportFormat(exportFormat);
  const useAverageTable = normalizedExportFormat === 'average-table' && spec.mode !== 'day';
  const summaryRows = [
    { Metric: 'Plant', Value: plantName },
    { Metric: 'Range Start', Value: fmtDateTime(s) },
    { Metric: 'Range End', Value: fmtDateTime(e) },
    { Metric: 'Resolution', Value: spec.mode === 'day' ? 'Daily' : spec.label },
    { Metric: 'Export Format', Value: useAverageTable ? 'Average Table' : 'Standard' },
    { Metric: 'Actual Total (MWh)', Value: (actualTotalKwh / 1000).toFixed(6) },
    { Metric: 'Day-Ahead Total (MWh)', Value: (dayAheadTotalKwh / 1000).toFixed(6) },
    { Metric: 'Variance (MWh)', Value: (varianceTotalKwh / 1000).toFixed(6) },
    { Metric: 'Absolute Error Total (MWh)', Value: (absErrorTotalKwh / 1000).toFixed(6) },
    {
      Metric: 'WAPE (%)',
      Value: actualTotalKwh > 0 ? ((absErrorTotalKwh / actualTotalKwh) * 100).toFixed(3) : '',
    },
    {
      Metric: 'Mean APE (%)',
      Value: mapeValues.length ? (mapeValues.reduce((sum, value) => sum + value, 0) / mapeValues.length).toFixed(3) : '',
    },
    { Metric: 'Peak Interval Actual (MWh)', Value: peakRow ? safeNum(peakRow.ActualMWh).toFixed(6) : '' },
    { Metric: 'Peak Interval Time', Value: peakRow ? String(peakRow.Time || '') : '' },
    { Metric: 'Data Rows', Value: String(rows.length) },
  ];

  const headers = [
    { key: 'Date',        label: 'Date' },
    { key: 'Time',        label: 'Time' },
    { key: 'Resolution',  label: 'Resolution' },
    { key: 'Plant',       label: 'Plant' },
    { key: 'ActualMWh',   label: 'Actual (MWh)' },
    { key: 'DayAheadMWh', label: 'Day-Ahead (MWh)' },
    { key: 'DeltaMWh',    label: 'Delta (MWh)' },
    { key: 'AbsDeltaMWh', label: 'Absolute Delta (MWh)' },
    { key: 'ErrorPct',    label: 'Absolute Error (%)' },
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
  const averageResolutionCode = `PT${Math.max(5, Number(spec.minutes || 5))}M`;
  const fileBase = exportDateAwareFileBase(
    s,
    e,
    'all',
    useAverageTable
      ? `Day-Ahead ${averageResolutionCode} AvgTable 05-18`
      : `Day-Ahead vs Actual ${resLabel}`,
  );
  if (useAverageTable) {
    return writeDayAheadAverageTableXlsx({
      startTs: s,
      endTs: e,
      resolution: averageResolutionCode,
      fileBase,
      dayAheadRawRows: dayAheadRaw,
    });
  }
  return await writeExport(headers, finalRows, dir, fileBase, format, {
    summaryHeaders,
    summaryRows,
    summarySheetName: 'Summary',
    dataSheetName: 'Intervals',
  });
}

function parseIsoDayStart(day) {
  const s = String(day || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return 0;
  return new Date(`${s}T00:00:00`).getTime();
}

const SOLCAST_PREVIEW_RESOLUTIONS = new Set(['PT5M', 'PT10M', 'PT15M', 'PT30M', 'PT60M']);
const SOLCAST_AVERAGE_TABLE_MINUTES = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];

function normalizeSolcastPreviewResolution(value) {
  const raw = String(value || 'PT5M')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  return SOLCAST_PREVIEW_RESOLUTIONS.has(raw) ? raw : 'PT5M';
}

function getSolcastPreviewBucketMinutes(resolution) {
  const normalized = normalizeSolcastPreviewResolution(resolution);
  const minutes = Number.parseInt(
    normalized.replace(/^PT/i, '').replace(/M$/i, ''),
    10,
  );
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 5;
}

function normalizeSolcastPreviewExportFormat(value) {
  const raw = String(value || 'standard')
    .trim()
    .toLowerCase();
  return raw === 'average-table' ? 'average-table' : 'standard';
}

function roundSolcastExportNumber(value, digits = 6) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(digits)) : null;
}

function buildSolcastPreviewStandardRows(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  return safeRows.map((row) => ({
    Date: String(row?.date || '').trim(),
    Time: String(row?.time || '').trim(),
    Period: String(row?.period || 'PT5M').trim() || 'PT5M',
    ForecastMW:
      row?.forecastMw == null || row?.forecastMw === ''
        ? ''
        : Number(row.forecastMw).toFixed(6),
    ForecastLowMW:
      row?.forecastLoMw == null || row?.forecastLoMw === ''
        ? ''
        : Number(row.forecastLoMw).toFixed(6),
    ForecastHighMW:
      row?.forecastHiMw == null || row?.forecastHiMw === ''
        ? ''
        : Number(row.forecastHiMw).toFixed(6),
    EstimatedActualMW:
      row?.actualMw == null || row?.actualMw === ''
        ? ''
        : Number(row.actualMw).toFixed(6),
    ForecastMWh:
      row?.forecastMwh == null || row?.forecastMwh === ''
        ? ''
        : Number(row.forecastMwh).toFixed(6),
    ForecastLowMWh:
      row?.forecastLoMwh == null || row?.forecastLoMwh === ''
        ? ''
        : Number(row.forecastLoMwh).toFixed(6),
    ForecastHighMWh:
      row?.forecastHiMwh == null || row?.forecastHiMwh === ''
        ? ''
        : Number(row.forecastHiMwh).toFixed(6),
    EstimatedActualMWh:
      row?.actualMwh == null || row?.actualMwh === ''
        ? ''
        : Number(row.actualMwh).toFixed(6),
  }));
}

function buildSolcastPreviewFileBase(startDay, endDay, resolution, exportFormat) {
  const s = parseIsoDayStart(startDay) || Date.now();
  const e = parseIsoDayStart(endDay || startDay) || s;
  const normalizedResolution = normalizeSolcastPreviewResolution(resolution);
  const normalizedExportFormat = normalizeSolcastPreviewExportFormat(exportFormat);
  const suffix =
    normalizedExportFormat === 'average-table'
      ? `Solcast Toolkit ${normalizedResolution} AvgTable 05-18`
      : `Solcast Toolkit ${normalizedResolution} 05-18`;
  return exportDateAwareFileBase(s, e, 'all', suffix);
}

function buildSolcastAverageTableBuckets(values, bucketMinutes) {
  const span = Math.max(1, Math.floor(bucketMinutes / 5));
  const ordered = SOLCAST_AVERAGE_TABLE_MINUTES.map((minute) => values.get(minute));
  const buckets = [];
  for (let i = 0; i < ordered.length; i += span) {
    const slice = ordered
      .slice(i, i + span)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (!slice.length) continue;
    const avg = slice.reduce((sum, value) => sum + value, 0) / slice.length;
    buckets.push(avg);
  }
  if (!buckets.length) return null;
  return roundSolcastExportNumber(
    buckets.reduce((sum, value) => sum + value, 0) / buckets.length,
  );
}

function buildSolcastAverageTableDays(rawRows, resolution) {
  const bucketMinutes = getSolcastPreviewBucketMinutes(resolution);
  const grouped = new Map();
  for (const row of Array.isArray(rawRows) ? rawRows : []) {
    const day = String(row?.date || '').trim();
    const time = String(row?.time || '').trim();
    const match = /^(\d{2}):(\d{2})$/.exec(time);
    if (!day || !match) continue;
    const hour = Number(match[1] || 0);
    const minuteRaw = Number(match[2] || 0);
    const hourLabel = hour === 0 ? 24 : hour;
    const minuteLabel = minuteRaw === 0 ? 60 : minuteRaw;
    if (!SOLCAST_AVERAGE_TABLE_MINUTES.includes(minuteLabel)) continue;
    let dayEntry = grouped.get(day);
    if (!dayEntry) {
      dayEntry = {
        day,
        hours: Array.from({ length: 24 }, (_, idx) => ({
          hour: idx + 1,
          values: new Map(),
        })),
        totalMwh: 0,
      };
      grouped.set(day, dayEntry);
    }
    const hourEntry = dayEntry.hours[hourLabel - 1];
    const forecastMw = roundSolcastExportNumber(row?.forecastMw);
    if (forecastMw != null) {
      hourEntry.values.set(minuteLabel, forecastMw);
    }
    const forecastMwh = Number(row?.forecastMwh);
    if (Number.isFinite(forecastMwh)) {
      dayEntry.totalMwh += forecastMwh;
    }
  }

  return Array.from(grouped.values())
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((entry) => ({
      day: entry.day,
      totalMwh: roundSolcastExportNumber(entry.totalMwh),
      rows: entry.hours.map((hourEntry) => ({
        hour: hourEntry.hour,
        values: SOLCAST_AVERAGE_TABLE_MINUTES.map((minute) =>
          hourEntry.values.has(minute) ? hourEntry.values.get(minute) : null,
        ),
        average: buildSolcastAverageTableBuckets(hourEntry.values, bucketMinutes),
      })),
    }));
}

const AVERAGE_TABLE_HEADER_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF4B183' },
};
const AVERAGE_TABLE_SUB_HEADER_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFCE4D6' },
};
const AVERAGE_TABLE_TOTAL_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFEB84' },
};
const AVERAGE_TABLE_SIDE_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFDEBD3' },
};
const AVERAGE_TABLE_ALT_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFFAF2' },
};
const AVERAGE_TABLE_AVG_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFF1DF' },
};
const AVERAGE_TABLE_BORDER = {
  top: { style: 'thin', color: { argb: 'FF808080' } },
  left: { style: 'thin', color: { argb: 'FF808080' } },
  bottom: { style: 'thin', color: { argb: 'FF808080' } },
  right: { style: 'thin', color: { argb: 'FF808080' } },
};

function createAverageTableDayEntry(dayLabel = '') {
  return {
    day: String(dayLabel || fmtDate(Date.now())).trim(),
    rows: Array.from({ length: 24 }, (_, idx) => ({
      hour: idx + 1,
      values: Array(12).fill(null),
      average: null,
    })),
    totalMwh: 0,
  };
}

function averageTableRowHasNonZeroValue(row) {
  const values = Array.isArray(row?.values) ? row.values : [];
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && Math.abs(num) > 1e-12) return true;
  }
  const avg = Number(row?.average);
  return Number.isFinite(avg) && Math.abs(avg) > 1e-12;
}

function renderAverageTableDayWorksheet(wb, dayEntry, options = {}) {
  const resolvedDayEntry =
    dayEntry && Array.isArray(dayEntry?.rows)
      ? dayEntry
      : createAverageTableDayEntry(options?.dayLabel || '');
  const dayLabel = String(options?.dayLabel || resolvedDayEntry.day || '').trim();
  const sheetName = String(options?.sheetName || dayLabel || 'Average Table').slice(0, 31);
  const averageLabel = String(options?.averageLabel || 'Average').trim() || 'Average';
  const totalLabel = String(options?.totalLabel || 'TOTAL (MWh)').trim() || 'TOTAL (MWh)';

  const ws = wb.addWorksheet(sheetName, {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }],
  });
  ws.columns = [
    { width: 10 },
    ...SOLCAST_AVERAGE_TABLE_MINUTES.map(() => ({ width: 11 })),
    { width: 18 },
  ];
  ws.properties.defaultRowHeight = 20;
  ws.getRow(1).height = 24;
  ws.getRow(2).height = 21;

  ws.mergeCells(1, 1, 2, 1);
  ws.getCell(1, 1).value = 'HOURS';
  ws.getCell(1, 1).alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell(1, 1).font = { bold: true };
  ws.getCell(1, 1).fill = AVERAGE_TABLE_HEADER_FILL;
  ws.getCell(1, 1).border = AVERAGE_TABLE_BORDER;

  ws.mergeCells(1, 2, 1, 13);
  ws.getCell(1, 2).value = dayLabel;
  ws.getCell(1, 2).alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell(1, 2).font = { bold: true };
  ws.getCell(1, 2).fill = AVERAGE_TABLE_HEADER_FILL;
  ws.getCell(1, 2).border = AVERAGE_TABLE_BORDER;

  ws.mergeCells(1, 14, 2, 14);
  ws.getCell(1, 14).value = averageLabel;
  ws.getCell(1, 14).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  ws.getCell(1, 14).font = { bold: true };
  ws.getCell(1, 14).fill = AVERAGE_TABLE_HEADER_FILL;
  ws.getCell(1, 14).border = AVERAGE_TABLE_BORDER;

  SOLCAST_AVERAGE_TABLE_MINUTES.forEach((minute, idx) => {
    const cell = ws.getCell(2, idx + 2);
    cell.value = minute;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.font = { bold: true };
    cell.fill = AVERAGE_TABLE_SUB_HEADER_FILL;
    cell.border = AVERAGE_TABLE_BORDER;
  });

  const lastNonZeroRowIndex = resolvedDayEntry.rows.reduce(
    (lastIdx, row, idx) => (averageTableRowHasNonZeroValue(row) ? idx : lastIdx),
    -1,
  );
  const renderedRows =
    lastNonZeroRowIndex >= 0
      ? resolvedDayEntry.rows.slice(0, lastNonZeroRowIndex + 1)
      : [];

  renderedRows.forEach((row, idx) => {
    const rowIndex = idx + 3;
    const hourCell = ws.getCell(rowIndex, 1);
    hourCell.value = row.hour;
    hourCell.alignment = { horizontal: 'center', vertical: 'middle' };
    hourCell.border = AVERAGE_TABLE_BORDER;
    hourCell.fill = AVERAGE_TABLE_SIDE_FILL;
    const rowStripeFill = idx % 2 === 1 ? AVERAGE_TABLE_ALT_FILL : null;
    row.values.forEach((value, valueIdx) => {
      const cell = ws.getCell(rowIndex, valueIdx + 2);
      cell.value = value == null ? '' : value;
      cell.numFmt = value == null ? 'General' : '0.000000';
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = AVERAGE_TABLE_BORDER;
      if (rowStripeFill) cell.fill = rowStripeFill;
    });
    const avgCell = ws.getCell(rowIndex, 14);
    avgCell.value = row.average == null ? '' : row.average;
    avgCell.numFmt = row.average == null ? 'General' : '0.000000';
    avgCell.alignment = { horizontal: 'center', vertical: 'middle' };
    avgCell.border = AVERAGE_TABLE_BORDER;
    avgCell.fill = AVERAGE_TABLE_AVG_FILL;
  });

  const totalRowIndex = renderedRows.length + 4;
  ws.getRow(totalRowIndex).height = 22;
  ws.mergeCells(totalRowIndex, 1, totalRowIndex, 13);
  const totalLabelCell = ws.getCell(totalRowIndex, 1);
  totalLabelCell.value = totalLabel;
  totalLabelCell.alignment = { horizontal: 'center', vertical: 'middle' };
  totalLabelCell.font = { bold: true };
  totalLabelCell.fill = AVERAGE_TABLE_TOTAL_FILL;
  totalLabelCell.border = AVERAGE_TABLE_BORDER;

  const totalValueCell = ws.getCell(totalRowIndex, 14);
  totalValueCell.value = resolvedDayEntry.totalMwh == null ? 0 : resolvedDayEntry.totalMwh;
  totalValueCell.numFmt = '0.000000';
  totalValueCell.alignment = { horizontal: 'center', vertical: 'middle' };
  totalValueCell.font = { bold: true };
  totalValueCell.fill = AVERAGE_TABLE_TOTAL_FILL;
  totalValueCell.border = AVERAGE_TABLE_BORDER;
}

function buildForecastActualAverageTableRows(rawRows) {
  const dedupedRows = aggregateKwhByResolution(
    Array.isArray(rawRows) ? rawRows : [],
    { minutes: 5, mode: 'interval' },
  );
  return dedupedRows
    .map((row) => {
      const ts = Number(row?.ts || 0);
      const kwh = Math.max(0, safeNum(row?.kwh_inc));
      if (!(ts > 0) || !isWithinSolarWindowTs(ts)) return null;
      return {
        date: fmtDate(ts),
        time: fmtTime(ts).slice(0, 5),
        forecastMw: roundSolcastExportNumber((kwh * 12) / 1000),
        forecastMwh: roundSolcastExportNumber(kwh / 1000),
      };
    })
    .filter(Boolean);
}

async function writeSolcastAverageTableXlsx(rawRows, startDay, endDay, resolution, exportFormat) {
  const normalizedResolution = normalizeSolcastPreviewResolution(resolution);
  const days = buildSolcastAverageTableDays(rawRows, normalizedResolution);
  const dir = resolveForecastExportDir(FORECAST_EXPORT_SUBFOLDERS.solcast);
  const fileBase = buildSolcastPreviewFileBase(
    startDay,
    endDay,
    normalizedResolution,
    exportFormat,
  );
  const xlsxPath = path.join(dir, `${fileBase}.xlsx`);
  const wb = new ExcelJS.Workbook();
  setWorkbookMetadata(wb, 'Solcast Average Table Export');

  for (const dayEntry of days.length ? days : [createAverageTableDayEntry(startDay || fmtDate(Date.now()))]) {
    renderAverageTableDayWorksheet(wb, dayEntry, {
      sheetName: String(dayEntry.day || 'Solcast').slice(0, 31),
      dayLabel: String(dayEntry.day || '').trim(),
      averageLabel: `${normalizedResolution} Average`,
      totalLabel: 'GENERATION FORECAST (MWh)',
    });
  }

  await wb.xlsx.writeFile(xlsxPath);
  return xlsxPath;
}

async function writeDayAheadAverageTableXlsx({
  startTs,
  endTs,
  resolution,
  fileBase,
  dayAheadRawRows,
}) {
  const startDay = fmtDate(startTs || Date.now());
  const endDay = fmtDate(endTs || startTs || Date.now());
  const normalizedResolution = normalizeSolcastPreviewResolution(resolution);
  const dayAheadDays = buildSolcastAverageTableDays(
    buildForecastActualAverageTableRows(dayAheadRawRows),
    normalizedResolution,
  );
  const dayAheadDayMap = new Map(dayAheadDays.map((entry) => [String(entry.day || '').trim(), entry]));
  const allDays = Array.from(
    new Set([
      ...dayAheadDayMap.keys(),
      ...iterateLocalDates(startTs, endTs),
    ]),
  )
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const dir = resolveForecastExportDir(FORECAST_EXPORT_SUBFOLDERS.analytics);
  const xlsxPath = path.join(dir, `${fileBase}.xlsx`);
  const wb = new ExcelJS.Workbook();
  setWorkbookMetadata(wb, 'Day-Ahead Average Table Export');

  for (const day of allDays.length ? allDays : [startDay || endDay || fmtDate(Date.now())]) {
    const dayAheadEntry = dayAheadDayMap.get(day) || createAverageTableDayEntry(day);
    renderAverageTableDayWorksheet(wb, dayAheadEntry, {
      sheetName: day,
      dayLabel: day,
      averageLabel: `${normalizedResolution} Average`,
      totalLabel: 'GENERATION FORECAST (MWh)',
    });
  }

  await wb.xlsx.writeFile(xlsxPath);
  return xlsxPath;
}

async function exportSolcastPreview({
  rawRows,
  rows,
  startDay,
  endDay,
  resolution,
  exportFormat,
  format,
}) {
  const dir = resolveForecastExportDir(FORECAST_EXPORT_SUBFOLDERS.solcast);
  const normalizedResolution = normalizeSolcastPreviewResolution(resolution);
  const normalizedExportFormat = normalizeSolcastPreviewExportFormat(exportFormat);
  if (normalizedExportFormat === 'average-table') {
    return writeSolcastAverageTableXlsx(
      Array.isArray(rawRows) && rawRows.length ? rawRows : rows,
      startDay,
      endDay,
      normalizedResolution,
      normalizedExportFormat,
    );
  }

  const mapped = buildSolcastPreviewStandardRows(rows);

  const headers = [
    { key: 'Date', label: 'Date' },
    { key: 'Time', label: 'Time' },
    { key: 'Period', label: 'Period' },
    { key: 'ForecastMW', label: 'Forecast (MW)' },
    { key: 'ForecastLowMW', label: 'Forecast Low (MW)' },
    { key: 'ForecastHighMW', label: 'Forecast High (MW)' },
    { key: 'EstimatedActualMW', label: 'Estimated Actual (MW)' },
    { key: 'ForecastMWh', label: 'Forecast (MWh)' },
    { key: 'ForecastLowMWh', label: 'Forecast Low (MWh)' },
    { key: 'ForecastHighMWh', label: 'Forecast High (MWh)' },
    { key: 'EstimatedActualMWh', label: 'Estimated Actual (MWh)' },
  ];
  const headerKeys = headers.map((h) => h.key);
  const sortedRows = sortRowsDateInverterTime(mapped, {
    dateKey: 'Date',
    inverterKey: 'Period',
    timeKey: 'Time',
  });
  const finalRows = insertBlankRowsByGroup(sortedRows, {
    groupKeys: ['Date'],
    headerKeys,
  });

  const fileBase = buildSolcastPreviewFileBase(
    startDay,
    endDay,
    normalizedResolution,
    normalizedExportFormat,
  );
  return await writeExport(headers, finalRows, dir, fileBase, format || 'xlsx');
}

module.exports = {
  exportAlarms,
  exportEnergy,
  buildEnergySummaryExportRows,
  buildForecastActualAverageTableRows,
  buildSolcastAverageTableDays,
  rewriteForecastExportRelativePath,
  ensureForecastExportSubfolder,
  writeEnergySummaryExport,
  exportInverterData,
  export5min,
  exportAudit,
  exportDailyReport,
  exportForecastActual,
  exportSolcastPreview,
};
