"use strict";

/**
 * Phase θ.6 TDD — report generator (CSV path + HTML template shape).
 *
 * The PDF path goes through puppeteer + a real browser launch, which is too
 * heavy for a unit test. We test the CSV bundle (filesystem round-trip) and
 * the HTML template builder (string assertions only).
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
delete require.cache[require.resolve("../compliance/reportGenerator")];
const { generateCsvBundle, _buildReportHtml } = require("../compliance/reportGenerator");

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log("\n  complianceReportGenCore.test.js — Slice θ.6\n");

const fakeRun = {
  run_id: "t5_apc_sweep-1717000000000-abc123",
  test_kind: "t5_apc_sweep",
  started_at_ms: 1717000000000,
  ended_at_ms:   1717000600000,
  status: "completed",
  operator_actor: "operator",
  target_inverters: '[{"inverter":1,"ip":"1.1.1.1","slave":1}]',
  params_json: '{"ramp_pct":[100,50,100],"hold_sec":120}',
  summary_json: '{"steps":3,"passes":3,"fails":0}',
  error_message: null,
};
const fakeSteps = [
  { step_idx: 0, step_name: "ramp_100pct", started_at_ms: 1717000000000, ended_at_ms: 1717000120000, target_value: 100, achieved_value: 99.5, deviation_pct: 0.5, pass: 1, notes: "ok" },
  { step_idx: 1, step_name: "ramp_50pct",  started_at_ms: 1717000120000, ended_at_ms: 1717000240000, target_value: 50,  achieved_value: 50.2, deviation_pct: 0.4, pass: 1, notes: "ok" },
  { step_idx: 2, step_name: "ramp_100pct", started_at_ms: 1717000240000, ended_at_ms: 1717000360000, target_value: 100, achieved_value: 99.9, deviation_pct: 0.1, pass: 1, notes: "ok" },
];
const fakeSamples = [
  { ts_ms: 1717000000000, inverter_ip: "1.1.1.1", slave: 1, pac_w: 240000, freq_hz: 60.05 },
  { ts_ms: 1717000060000, inverter_ip: "1.1.1.1", slave: 1, pac_w: 122000, freq_hz: 60.02 },
];

let tmpDir;

test("generateCsvBundle writes a UTF-8 BOM file containing meta + steps + samples", () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-cmp-test-"));
  const out = generateCsvBundle(fakeRun, fakeSteps, fakeSamples, tmpDir);
  assert.ok(out.path.endsWith(".csv"));
  assert.ok(out.bytes > 0);
  assert.match(out.sha256, /^[0-9a-f]{64}$/);
  const content = fs.readFileSync(out.path, "utf8");
  assert.ok(content.charCodeAt(0) === 0xFEFF, "expected UTF-8 BOM");
  assert.ok(/run_id,t5_apc_sweep-/.test(content), "meta section missing run_id");
  assert.ok(/test_kind,t5_apc_sweep/.test(content), "meta section missing test_kind");
  assert.ok(/ramp_100pct/.test(content), "step row missing");
  assert.ok(/1\.1\.1\.1/.test(content), "sample row missing");
});

test("_buildReportHtml escapes injection-prone characters", () => {
  const evilRun = { ...fakeRun, error_message: '<script>alert("xss")</script>' };
  const html = _buildReportHtml(evilRun, fakeSteps, fakeSamples);
  assert.ok(!html.includes('<script>alert("xss")</script>'), "raw script tag must be escaped");
  assert.ok(html.includes("&lt;script&gt;"), "expected escaped script");
});

test("_buildReportHtml shows pass + fail counts visually", () => {
  const html = _buildReportHtml(fakeRun, fakeSteps, fakeSamples);
  assert.ok(html.includes("PASS"), "expected PASS marker");
  assert.ok(html.includes('class="pass"'), "expected .pass css class");
});

test("_buildReportHtml includes the witness sign-off block", () => {
  const html = _buildReportHtml(fakeRun, fakeSteps, fakeSamples);
  assert.ok(/Witness Sign-off/.test(html));
  assert.ok(/Engr\. Clariden Monta(ñ|n)o/.test(html));
});

test("_buildReportHtml handles empty steps + samples gracefully", () => {
  const html = _buildReportHtml(fakeRun, [], []);
  assert.ok(/No steps/.test(html));
  assert.ok(/No samples captured/.test(html));
});

test("generateCsvBundle handles empty steps + samples", () => {
  const out = generateCsvBundle({ ...fakeRun, summary_json: null }, [], [], tmpDir);
  assert.ok(out.bytes > 0);
  const content = fs.readFileSync(out.path, "utf8");
  // Just header + meta lines — no exception.
  assert.ok(/run_id/.test(content));
});

// Cleanup
try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
