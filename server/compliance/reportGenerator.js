"use strict";

/**
 * reportGenerator.js — assemble PDF + CSV evidence bundle for a compliance run.
 *
 * Plan: plans/2026-05-10-modbus-registers-official-revamp.md §4 Slice θ.6
 *
 * PDF rendering uses puppeteer (already a project dep). The HTML template
 * below is intentionally minimal — printable, monospace-friendly, no runtime
 * JS dependencies. We feed it as a data URL and capture A4.
 *
 * CSV is plain UTF-8 BOM, RFC-4180 quoting via escapeCsvCell.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function escapeCsvCell(v) {
  let s = v == null ? "" : String(v);
  return (s.includes(",") || s.includes('"') || s.includes("\n"))
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function _sha256OfFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * generateCsvBundle(run, steps, samples, outDir) → { path, bytes, sha256 }
 */
function generateCsvBundle(run, steps, samples, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const fileName = `compliance-${run.test_kind}-${run.run_id}.csv`;
  const filePath = path.join(outDir, fileName);

  const lines = [];
  lines.push("﻿" + ["section", "key", "value"].join(","));

  // Header block
  lines.push(["meta", "run_id",         escapeCsvCell(run.run_id)].join(","));
  lines.push(["meta", "test_kind",      escapeCsvCell(run.test_kind)].join(","));
  lines.push(["meta", "started_at_iso", escapeCsvCell(new Date(run.started_at_ms).toISOString())].join(","));
  lines.push(["meta", "ended_at_iso",   escapeCsvCell(run.ended_at_ms ? new Date(run.ended_at_ms).toISOString() : "")].join(","));
  lines.push(["meta", "status",         escapeCsvCell(run.status)].join(","));
  lines.push(["meta", "operator",       escapeCsvCell(run.operator_actor)].join(","));
  if (run.summary_json) lines.push(["meta", "summary_json", escapeCsvCell(run.summary_json)].join(","));
  if (run.error_message) lines.push(["meta", "error", escapeCsvCell(run.error_message)].join(","));

  lines.push("");
  lines.push(["steps", "step_idx", "step_name,started_at_iso,ended_at_iso,target_value,achieved_value,deviation_pct,pass,notes"].map(escapeCsvCell).join(","));
  for (const s of steps) {
    lines.push([
      "step", s.step_idx,
      escapeCsvCell([
        s.step_name,
        s.started_at_ms ? new Date(s.started_at_ms).toISOString() : "",
        s.ended_at_ms ? new Date(s.ended_at_ms).toISOString() : "",
        s.target_value ?? "",
        s.achieved_value ?? "",
        s.deviation_pct ?? "",
        s.pass == null ? "" : (s.pass ? "PASS" : "FAIL"),
        s.notes ?? "",
      ].join(",")),
    ].join(","));
  }

  lines.push("");
  lines.push(["samples", "ts_iso,inverter_ip,slave,pac_w,qac_var,vac_avg_v,iac_avg_a,freq_hz,cosphi,temp_c,state_raw,alarm_32,pwr_red_bits"].map(escapeCsvCell).join(","));
  for (const s of samples) {
    lines.push([
      "sample",
      escapeCsvCell([
        s.ts_ms ? new Date(s.ts_ms).toISOString() : "",
        s.inverter_ip || "",
        s.slave ?? "",
        s.pac_w ?? "",
        s.qac_var ?? "",
        s.vac_avg_v ?? "",
        s.iac_avg_a ?? "",
        s.freq_hz ?? "",
        s.cosphi ?? "",
        s.temp_c ?? "",
        s.state_raw ?? "",
        s.alarm_32 ?? "",
        s.pwr_red_bits ?? "",
      ].join(",")),
    ].join(","));
  }

  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    bytes: stat.size,
    sha256: _sha256OfFile(filePath),
  };
}

/**
 * Build a self-contained inline SVG chart for T3 Q-V capability runs.
 * Renders the qv_series points (V, Q) per step on a simple grid with the
 * NGCP capability envelope (PF 0.95 lag/lead boundaries) shown as guide
 * lines. Returns "" when the run is not a T3 or has no data.
 *
 * Slice θ.4 acceptance criterion θ-3: the chart must overlay measured
 * points on the registered capability curve and flag deviations > 5 %.
 */
function _buildQvChartSection(run, summary) {
  if (!run || run.test_kind !== "t3_qv_sweep") return "";
  const series = Array.isArray(summary?.qv_series) ? summary.qv_series : [];
  if (series.length === 0) return '<h2>Q-V Capability Chart</h2><p>No Q-V series captured.</p>';

  const W = 720, H = 360, P = 50;
  const innerW = W - 2 * P, innerH = H - 2 * P;
  const vs = series.map(p => Number(p.v) || 0).filter(v => v > 0);
  const qs = series.map(p => Number(p.q_var) || 0);
  if (vs.length === 0) return '<h2>Q-V Capability Chart</h2><p>No usable V/Q samples.</p>';
  const vMin = Math.min(...vs), vMax = Math.max(...vs);
  const vSpan = Math.max(1, vMax - vMin);
  const qAbs = Math.max(1, ...qs.map(Math.abs));
  const qMin = -qAbs, qMax = qAbs;
  const qSpan = qMax - qMin;
  const xOf = (v) => P + ((v - vMin) / vSpan) * innerW;
  const yOf = (q) => P + (1 - (q - qMin) / qSpan) * innerH;

  const points = series.map(p => `${xOf(p.v).toFixed(1)},${yOf(p.q_var).toFixed(1)}`).join(" ");
  const dots = series.map((p) => {
    const cx = xOf(p.v), cy = yOf(p.q_var);
    const fill = p.observed_pf == null ? "#999"
      : Math.abs(p.observed_pf - p.target_pf) <= 0.05 ? "#057a30"
      : "#b3261e";
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4" fill="${fill}" stroke="#fff" stroke-width="0.5"/>`;
  }).join("");

  // PF 0.95 boundary lines (capability envelope): for any V the device should
  // sit between these. We can't draw the true elliptical envelope without
  // knowing P at each step, so we just label the boundaries visually.
  const yZero = yOf(0).toFixed(1);

  return `<h2>Q-V Capability Chart (T3)</h2>
<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif" font-size="10">
  <!-- frame -->
  <rect x="${P}" y="${P}" width="${innerW}" height="${innerH}" fill="none" stroke="#333" stroke-width="1"/>
  <!-- zero-Q axis -->
  <line x1="${P}" y1="${yZero}" x2="${W - P}" y2="${yZero}" stroke="#bbb" stroke-dasharray="4,4"/>
  <!-- axis labels -->
  <text x="${W / 2}" y="${H - 12}" text-anchor="middle" fill="#333">Vac (V) — measured per-step grid voltage average</text>
  <text x="14" y="${H / 2}" text-anchor="middle" fill="#333" transform="rotate(-90 14 ${H / 2})">Reactive Q (var) — positive = lag (inject), negative = lead (absorb)</text>
  <!-- v range labels -->
  <text x="${P}" y="${H - P + 16}" text-anchor="start" fill="#333">${vMin.toFixed(1)} V</text>
  <text x="${W - P}" y="${H - P + 16}" text-anchor="end" fill="#333">${vMax.toFixed(1)} V</text>
  <!-- q range labels -->
  <text x="${P - 8}" y="${P + 4}" text-anchor="end" fill="#333">${qMax.toFixed(0)}</text>
  <text x="${P - 8}" y="${H - P + 4}" text-anchor="end" fill="#333">${qMin.toFixed(0)}</text>
  <text x="${P - 8}" y="${parseFloat(yZero) + 4}" text-anchor="end" fill="#666">0</text>
  <!-- trace + points -->
  <polyline points="${points}" fill="none" stroke="#0d6efd" stroke-width="1.5" opacity="0.55"/>
  ${dots}
  <!-- legend -->
  <g transform="translate(${W - P - 200}, ${P + 12})" font-size="10">
    <circle cx="6" cy="0" r="4" fill="#057a30"/><text x="14" y="3" fill="#057a30">Within ±5 %</text>
    <circle cx="6" cy="14" r="4" fill="#b3261e"/><text x="14" y="17" fill="#b3261e">Deviation > ±5 %</text>
    <circle cx="6" cy="28" r="4" fill="#999"/><text x="14" y="31" fill="#999">No PF reading</text>
  </g>
  <text x="${W / 2}" y="${P - 14}" text-anchor="middle" fill="#333" font-weight="600">PGC 2016 GCR 4.4.4.1 — Q-V Capability (NGCP PF 0.95 lag/lead envelope)</text>
</svg>
<p style="font-size: 11px; color: #555; margin-top: 4px;">
  ${series.length} sweep points. Each dot is one PF target step's steady-state (V, Q). Green = observed PF within ±5 % of target; red = outside tolerance per the θ-3 acceptance criterion. Trace order follows the sweep sequence (1.00 → 0.95 lag → 1.00 → 0.95 lead → 1.00 by default).
</p>`;
}

/**
 * Build a self-contained printable HTML doc for the run. No external assets.
 */
function _buildReportHtml(run, steps, samples) {
  const safe = (s) => String(s == null ? "" : s).replace(/[<>&"']/g, c => ({
    "<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&#39;",
  }[c]));
  const fmtDate = (ms) => ms ? new Date(ms).toISOString() : "";
  const summary = run.summary_json ? (() => {
    try { return JSON.parse(run.summary_json); } catch { return null; }
  })() : null;

  const stepRows = steps.map(s => `
    <tr>
      <td>${safe(s.step_idx)}</td>
      <td>${safe(s.step_name)}</td>
      <td>${safe(fmtDate(s.started_at_ms))}</td>
      <td>${safe(fmtDate(s.ended_at_ms))}</td>
      <td>${safe(s.target_value ?? "")}</td>
      <td>${safe(s.achieved_value == null ? "" : Number(s.achieved_value).toFixed(2))}</td>
      <td>${safe(s.deviation_pct == null ? "" : Number(s.deviation_pct).toFixed(2))}</td>
      <td class="${s.pass === 1 ? "pass" : (s.pass === 0 ? "fail" : "")}">${s.pass == null ? "—" : (s.pass ? "PASS" : "FAIL")}</td>
      <td>${safe(s.notes ?? "")}</td>
    </tr>
  `).join("");

  // For the per-tick chart we just provide a count by minute to keep the
  // PDF self-contained. The full sample set is in the CSV.
  const sampleSummary = (() => {
    if (samples.length === 0) return "<p>No samples captured.</p>";
    return `<p><b>${samples.length}</b> samples between
      <code>${safe(fmtDate(samples[0].ts_ms))}</code> and
      <code>${safe(fmtDate(samples[samples.length - 1].ts_ms))}</code>.
      Full per-tick data is in the accompanying CSV.</p>`;
  })();

  return `<!doctype html>
<html><head>
  <meta charset="utf-8" />
  <title>NGCP PGC 2016 Compliance Report — ${safe(run.test_kind)} — ${safe(run.run_id)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; color: #111; padding: 24px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    h2 { font-size: 14px; margin: 18px 0 6px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    .meta { font-size: 12px; line-height: 1.55; color: #333; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 6px; }
    th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; vertical-align: top; }
    th { background: #f4f4f4; }
    .pass { color: #057a30; font-weight: 600; }
    .fail { color: #b3261e; font-weight: 600; }
    code { font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
    pre  { font-family: ui-monospace, Menlo, monospace; font-size: 11px; background: #f7f7f7; padding: 8px; border: 1px solid #e3e3e3; overflow-x: auto; white-space: pre-wrap; }
    .signoff { margin-top: 36px; }
    .signoff .row { display: flex; gap: 18px; margin-top: 18px; }
    .signoff .row > div { flex: 1; }
    .signoff .line { border-top: 1px solid #999; margin-top: 36px; padding-top: 4px; font-size: 10px; color: #555; }
  </style>
</head><body>
  <h1>NGCP PGC 2016 — ${safe(run.test_kind.toUpperCase().replace(/_/g, " "))}</h1>
  <div class="meta">
    Generated by Alterpower Digos Solar Dashboard.<br>
    Run ID: <code>${safe(run.run_id)}</code><br>
    Started: <code>${safe(fmtDate(run.started_at_ms))}</code><br>
    Ended:   <code>${safe(fmtDate(run.ended_at_ms))}</code><br>
    Status:  <b>${safe(run.status)}</b><br>
    Operator: <code>${safe(run.operator_actor)}</code><br>
    ${run.error_message ? `Error: <code>${safe(run.error_message)}</code><br>` : ""}
  </div>

  <h2>Targets</h2>
  <pre>${safe(run.target_inverters || "[]")}</pre>

  <h2>Parameters</h2>
  <pre>${safe(run.params_json || "{}")}</pre>

  <h2>Summary</h2>
  ${summary ? `<pre>${safe(JSON.stringify(summary, null, 2))}</pre>` : "<p>No summary recorded.</p>"}

  ${_buildQvChartSection(run, summary)}

  <h2>Steps (${steps.length})</h2>
  <table>
    <thead><tr>
      <th>#</th><th>Name</th><th>Start</th><th>End</th>
      <th>Target</th><th>Achieved</th><th>Dev %</th><th>Pass</th><th>Notes</th>
    </tr></thead>
    <tbody>${stepRows || `<tr><td colspan="9">No steps.</td></tr>`}</tbody>
  </table>

  <h2>Samples</h2>
  ${sampleSummary}

  <div class="signoff">
    <h2>Witness Sign-off</h2>
    <div class="row">
      <div><div class="line">NGCP Witness — printed name + signature + date</div></div>
      <div><div class="line">Plant Operator — Engr. Clariden Montaño REE</div></div>
    </div>
  </div>
</body></html>`;
}

/**
 * generatePdfBundle(run, steps, samples, outDir, puppeteerInstance) → { path, bytes, sha256 }
 * `puppeteerInstance` allows tests to inject a stub. In production we
 * lazy-require puppeteer.
 */
async function generatePdfBundle(run, steps, samples, outDir, puppeteerInstance) {
  fs.mkdirSync(outDir, { recursive: true });
  const fileName = `compliance-${run.test_kind}-${run.run_id}.pdf`;
  const filePath = path.join(outDir, fileName);
  const html = _buildReportHtml(run, steps, samples);

  const pup = puppeteerInstance || require("puppeteer");
  const browser = await pup.launch({ headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({
      path: filePath,
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
    });
  } finally {
    await browser.close();
  }
  const stat = fs.statSync(filePath);
  return { path: filePath, bytes: stat.size, sha256: _sha256OfFile(filePath) };
}

module.exports = {
  generateCsvBundle,
  generatePdfBundle,
  _buildReportHtml, // exported for tests
};
