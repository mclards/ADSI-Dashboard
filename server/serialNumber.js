"use strict";

/**
 * server/serialNumber.js — Slice C of v2.10.0.
 *
 * Operator-driven Read / Edit / Send pipeline mirroring ISM's
 * `frmSetSerial` form.  Backed by Python's `/serial/{inv}/{slave}`
 * endpoints (FC11 read + FC16 unlock+write+verify).
 *
 * Architecture decisions (carried over from Slice B):
 *   • Python is read-only for SQLite — Node owns serial_change_log writes.
 *   • Python serializes Modbus per-IP via thread_locks[ip]; Node must NOT
 *     issue parallel /serial calls for the same inverter (the server
 *     guarantees this by sequencing inside _proxy*).
 *   • "Must Read before Send" gate enforced via a short-lived session
 *     token minted by Read and required by Send.
 *
 * The fleet uniqueness scan lives entirely in Node (cache + topology
 * traversal + concurrency cap).  Python only sees one (inv, slave) per
 * call.
 */

const crypto = require("crypto");
const { lookupMotiveLabel } = require("./motiveLabels");
const { bindingsFromReq } = require("./bulkControlAuth");

// Session token TTL — operator must issue Send within this window.
const SESSION_TTL_MS = 5 * 60 * 1000;

// Fleet-uniqueness cache TTL — re-scans freshen entries older than this.
const FLEET_CACHE_TTL_MS = 5 * 60 * 1000;

// Concurrency cap for fleet uniqueness sweeps.  Python serializes per-IP
// internally, but the comm board / EKI gateway shares a single RS485 bus
// across 4 daisy-chained inverters — slamming 8 parallel TCP requests at
// 27 inverters hammers those gateways, which then return Modbus
// exception 0x0B (gateway target failed to respond).  Conservative
// concurrency = 3 keeps the bus quiet enough for FC11 to land cleanly.
const FLEET_SCAN_CONCURRENCY = 3;

// Per-target retry policy for transient soft errors during a fleet scan.
// We re-read on classic "bus was busy" symptoms (FC11 exception 0x0B,
// timed out, broken pipe, etc.) — these are routinely cleared by waiting
// 600 ms and trying again.  Bounded so a genuinely-dead inverter doesn't
// stall the whole sweep.
const FLEET_SCAN_RETRY_LIMIT = 2;
const FLEET_SCAN_RETRY_BACKOFF_MS = 600;
function _isTransientSerialError(msg) {
  const s = String(msg || "").toLowerCase();
  return (
    s.includes("code=0x0b") ||           // gateway target failed to respond
    s.includes("0x0b") ||
    s.includes("gateway target") ||
    s.includes("timed out") ||
    s.includes("timeout") ||
    s.includes("connection reset") ||
    s.includes("broken pipe") ||
    s.includes("recv failed") ||
    s.includes("engine unreachable")
  );
}
function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── Session-token store ──────────────────────────────────────────────────
// Keyed by token; value = { inverterIp, slave, oldSerial, fmt, mintedAt }.
// In-memory by design — restarts invalidate every pending Send, which is
// the safe behaviour (operator must Read again).
const _sessions = new Map();

function _purgeExpiredSessions() {
  const now = Date.now();
  for (const [tok, sess] of _sessions.entries()) {
    if (now - sess.mintedAt > SESSION_TTL_MS) _sessions.delete(tok);
  }
}

function mintSession({ inverterIp, slave, oldSerial, fmt, actedBy, req }) {
  _purgeExpiredSessions();
  const token = crypto.randomBytes(16).toString("hex");
  // SEC-H-004 — bind the session to the requesting client (IP + UA hash) so
  // captured tokens cannot be replayed from a different network segment.
  // Mirrors the binding pattern used by issuePlantWideAuthSession.
  const bindings = req ? bindingsFromReq(req) : null;
  _sessions.set(token, {
    inverterIp: String(inverterIp),
    slave: Number(slave),
    oldSerial: String(oldSerial || ""),
    fmt: String(fmt || "auto"),
    actedBy: String(actedBy || ""),
    mintedAt: Date.now(),
    bindings,
  });
  return { token, expiresAt: Date.now() + SESSION_TTL_MS, bound: !!bindings };
}

function _bindingsMatch(a, b) {
  if (!a) return true; // unbound session — backward compatible
  if (!b) return false;
  if (a.ip) {
    const ba = Buffer.from(a.ip);
    const bb = Buffer.from(b.ip);
    if (ba.length !== bb.length || !crypto.timingSafeEqual(ba, bb)) return false;
  }
  if (a.uaHash) {
    const ba = Buffer.from(a.uaHash);
    const bb = Buffer.from(b.uaHash);
    if (ba.length !== bb.length || !crypto.timingSafeEqual(ba, bb)) return false;
  }
  return true;
}

function consumeSession(token, { inverterIp, slave, req }) {
  _purgeExpiredSessions();
  const sess = _sessions.get(String(token || ""));
  if (!sess) return { ok: false, error: "session_not_found" };
  if (sess.inverterIp !== String(inverterIp) || sess.slave !== Number(slave)) {
    return { ok: false, error: "session_target_mismatch" };
  }
  if (Date.now() - sess.mintedAt > SESSION_TTL_MS) {
    _sessions.delete(String(token));
    return { ok: false, error: "session_expired" };
  }
  // SEC-H-004 — verify the caller fingerprint matches what minted the token.
  if (sess.bindings) {
    const callerBindings = req ? bindingsFromReq(req) : null;
    if (!_bindingsMatch(sess.bindings, callerBindings)) {
      _sessions.delete(String(token));
      return { ok: false, error: "session_binding_mismatch" };
    }
  }
  // One-shot: token consumed on Send so it can't be replayed.
  _sessions.delete(String(token));
  return { ok: true, session: sess };
}

// ─── Fleet uniqueness cache ───────────────────────────────────────────────
// (inverterIp + "|" + slave) → { serial, scannedAt, error }
const _fleetCache = new Map();

function _cacheKey(ip, slave) { return `${ip}|${slave}`; }

function getCachedSerial(ip, slave) {
  const v = _fleetCache.get(_cacheKey(ip, slave));
  if (!v) return null;
  if (Date.now() - v.scannedAt > FLEET_CACHE_TTL_MS) return null;
  return v;
}

function setCachedSerial(ip, slave, serial, error = null) {
  _fleetCache.set(_cacheKey(ip, slave), {
    serial: String(serial || ""),
    scannedAt: Date.now(),
    error: error ? String(error) : null,
  });
}

function invalidateCachedSerial(ip, slave) {
  _fleetCache.delete(_cacheKey(ip, slave));
}

function getFleetCacheSnapshot() {
  const out = [];
  for (const [k, v] of _fleetCache.entries()) {
    const [ip, slave] = k.split("|");
    out.push({
      inverter_ip: ip,
      slave: Number(slave),
      serial: v.serial,
      scanned_at_ms: v.scannedAt,
      ttl_remaining_ms: Math.max(0, FLEET_CACHE_TTL_MS - (Date.now() - v.scannedAt)),
      error: v.error,
    });
  }
  return out;
}

// ─── Persistence ──────────────────────────────────────────────────────────

function logSerialChange(db, {
  inverterId, inverterIp, slave, actedAtMs, actedBy,
  fmt, oldSerial, newSerial, verifyPassed, outcome, errorDetail,
}) {
  const r = db.prepare(`
    INSERT INTO serial_change_log
      (inverter_id, inverter_ip, slave, acted_at_ms, acted_by,
       fmt, old_serial, new_serial, verify_passed, outcome, error_detail, updated_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(inverterId) || 0,
    String(inverterIp),
    Number(slave) || 0,
    Number(actedAtMs) || Date.now(),
    String(actedBy || ""),
    String(fmt || ""),
    String(oldSerial || ""),
    String(newSerial || ""),
    verifyPassed ? 1 : 0,
    String(outcome || ""),
    errorDetail ? String(errorDetail) : null,
    Date.now(),
  );
  return Number(r.lastInsertRowid);
}

function getRecentChangesForInverter(db, inverterIp, limit = 100) {
  const cap = Math.max(1, Math.min(1000, Number(limit) || 100));
  return db.prepare(`
    SELECT id, inverter_id, inverter_ip, slave, acted_at_ms, acted_by,
           fmt, old_serial, new_serial, verify_passed, outcome, error_detail
    FROM serial_change_log
    WHERE inverter_ip = ?
    ORDER BY acted_at_ms DESC
    LIMIT ?
  `).all(String(inverterIp), cap);
}

function getRecentChangesAll(db, limit = 200) {
  const cap = Math.max(1, Math.min(2000, Number(limit) || 200));
  return db.prepare(`
    SELECT id, inverter_id, inverter_ip, slave, acted_at_ms, acted_by,
           fmt, old_serial, new_serial, verify_passed, outcome, error_detail
    FROM serial_change_log
    ORDER BY acted_at_ms DESC
    LIMIT ?
  `).all(cap);
}

// ─── Fleet-wide uniqueness scan ───────────────────────────────────────────
//
// `topology` shape: [{ inverterId, inverterIp, slave }, ...]
// `readOne(inverterId, slave, opts)` is injected so this stays testable —
// in production it proxies to Python's /serial/{inv}/{slave}.

async function _runWithConcurrency(items, concurrency, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function pump() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.max(1, concurrency) }, pump);
  await Promise.all(runners);
  return out;
}

async function fleetUniquenessCheck({
  candidateSerial, excludeSelf, topology, readOne,
  bypassCache = false, concurrency = FLEET_SCAN_CONCURRENCY,
}) {
  const targets = (topology || []).filter(
    (t) => !(t.inverterIp === excludeSelf?.inverterIp
              && Number(t.slave) === Number(excludeSelf?.slave)),
  );
  const candidate = String(candidateSerial || "").trim();

  const results = await _runWithConcurrency(targets, concurrency, async (t) => {
    const cached = bypassCache ? null : getCachedSerial(t.inverterIp, t.slave);
    if (cached) {
      return cached.error
        ? { kind: "unreachable", target: t, error: cached.error }
        : { kind: cached.serial === candidate ? "conflict" : "ok",
            target: t, existing_serial: cached.serial };
    }
    let info;
    try {
      info = await readOne(t.inverterId, t.slave, { fmt: "auto" });
    } catch (err) {
      setCachedSerial(t.inverterIp, t.slave, "", err?.message || String(err));
      return { kind: "unreachable", target: t, error: err?.message || String(err) };
    }
    if (!info?.ok) {
      setCachedSerial(t.inverterIp, t.slave, "", info?.error || "read_failed");
      return { kind: "unreachable", target: t, error: info?.error || "read_failed" };
    }
    setCachedSerial(t.inverterIp, t.slave, info.serial);
    return {
      kind: info.serial === candidate ? "conflict" : "ok",
      target: t,
      existing_serial: info.serial,
    };
  });

  const conflicts = results.filter((r) => r.kind === "conflict")
    .map((r) => ({
      inverter_id: r.target.inverterId,
      inverter_name: r.target.inverterName || `Inverter ${r.target.inverterId}`,
      inverter_ip: r.target.inverterIp,
      slave: r.target.slave,
      existing_serial: r.existing_serial,
    }));
  const unreachable = results.filter((r) => r.kind === "unreachable")
    .map((r) => ({
      inverter_id: r.target.inverterId,
      inverter_name: r.target.inverterName || `Inverter ${r.target.inverterId}`,
      inverter_ip: r.target.inverterIp,
      slave: r.target.slave,
      error: r.error,
    }));

  return {
    unique: conflicts.length === 0,
    candidate_serial: candidate,
    scanned: results.length - unreachable.length,
    total_targets: results.length,
    conflicts,
    unreachable,
  };
}

/**
 * Plain fleet scan — read every (inverter, slave) in `topology` via
 * `readOne(inverterId, slave, opts)`, populate the cache as a side effect,
 * return the assembled map.  No candidate comparison (use
 * `fleetUniquenessCheck` for that).
 *
 * Used by:
 *   • POST /api/serial/fleet/scan       — operator-driven Plant Serial Map
 *   • Stale-cache freshen on any Read   — caller passes bypassCache=false
 */
async function fleetScan({
  topology, readOne,
  bypassCache = false, concurrency = FLEET_SCAN_CONCURRENCY,
  retryLimit = FLEET_SCAN_RETRY_LIMIT,
  retryBackoffMs = FLEET_SCAN_RETRY_BACKOFF_MS,
}) {
  const targets = Array.isArray(topology) ? topology : [];
  const startedAt = Date.now();
  // Per-target read with bounded retry on transient soft errors.  Returns
  // the same row shape on success or terminal failure; never throws.
  async function readWithRetry(t) {
    let lastMsg = "unknown";
    for (let attempt = 0; attempt <= retryLimit; attempt++) {
      let info;
      try {
        info = await readOne(t.inverterId, t.slave, { fmt: "auto" });
      } catch (err) {
        lastMsg = err?.message || String(err);
        if (attempt < retryLimit && _isTransientSerialError(lastMsg)) {
          await _sleep(retryBackoffMs * (attempt + 1));
          continue;
        }
        setCachedSerial(t.inverterIp, t.slave, "", lastMsg);
        return { target: t, ok: false, error: lastMsg, scanned_at_ms: Date.now(), from_cache: false };
      }
      if (!info?.ok) {
        lastMsg = info?.error || "read_failed";
        if (attempt < retryLimit && _isTransientSerialError(lastMsg)) {
          await _sleep(retryBackoffMs * (attempt + 1));
          continue;
        }
        setCachedSerial(t.inverterIp, t.slave, "", lastMsg);
        return { target: t, ok: false, error: lastMsg, scanned_at_ms: Date.now(), from_cache: false };
      }
      setCachedSerial(t.inverterIp, t.slave, info.serial);
      return {
        target: t, ok: true,
        serial: info.serial,
        serial_format: info.serial_format,
        model_code: info.model_code,
        firmware_main: info.firmware_main,
        firmware_aux: info.firmware_aux,
        scanned_at_ms: Date.now(),
        from_cache: false,
      };
    }
    // Should not reach — defensive fallback.
    setCachedSerial(t.inverterIp, t.slave, "", lastMsg);
    return { target: t, ok: false, error: lastMsg, scanned_at_ms: Date.now(), from_cache: false };
  }
  const results = await _runWithConcurrency(targets, concurrency, async (t) => {
    const cached = bypassCache ? null : getCachedSerial(t.inverterIp, t.slave);
    if (cached) {
      return cached.error
        ? {
            target: t, ok: false,
            error: cached.error, scanned_at_ms: cached.scannedAt,
            from_cache: true,
          }
        : {
            target: t, ok: true,
            serial: cached.serial, scanned_at_ms: cached.scannedAt,
            from_cache: true,
          };
    }
    return readWithRetry(t);
  });
  return {
    started_at_ms: startedAt,
    finished_at_ms: Date.now(),
    total_targets: results.length,
    successful: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    rows: results.map((r) => ({
      inverter_id: r.target.inverterId,
      inverter_name: r.target.inverterName || `Inverter ${r.target.inverterId}`,
      inverter_ip: r.target.inverterIp,
      slave: r.target.slave,
      ok: Boolean(r.ok),
      serial: r.serial || null,
      serial_format: r.serial_format || null,
      model_code: r.model_code || null,
      firmware_main: r.firmware_main || null,
      firmware_aux: r.firmware_aux || null,
      from_cache: Boolean(r.from_cache),
      scanned_at_ms: r.scanned_at_ms || null,
      error: r.error || null,
    })),
  };
}

module.exports = {
  // Session tokens
  SESSION_TTL_MS,
  mintSession,
  consumeSession,
  // Fleet cache
  FLEET_CACHE_TTL_MS,
  FLEET_SCAN_CONCURRENCY,
  getCachedSerial,
  setCachedSerial,
  invalidateCachedSerial,
  getFleetCacheSnapshot,
  // Persistence
  logSerialChange,
  getRecentChangesForInverter,
  getRecentChangesAll,
  // Uniqueness + fleet scan
  fleetUniquenessCheck,
  fleetScan,
};
