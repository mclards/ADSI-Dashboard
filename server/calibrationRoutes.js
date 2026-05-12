// Field Calibration routes — Phases 1-4.
//
// Phase 1: read-only (state, full-config, fleet-summary, feature-status)
// Phase 2: session lifecycle + single-register write + audit log
// Phase 3: consign-mode (10/20/60/70 % via cmd-3 APC) under active session
// Phase 4: bulk copy with hardware-fingerprint match
//
// Plan: plans/2026-05-12-inverter-calibration-tool.md
//
// All write surfaces are gated by:
//   • calibrationWritesEnabled feature flag (default OFF)
//   • topology-auth (adsiM/adsiMM) for session start/end
//   • sacupsMM bulk auth per write call
//   • active calibration_session_id whose target matches the write target
//   • critical-block check on the target inverter
//   • range guard (≤ 50 % delta unless operator overrides)
//   • read-back verify with sentinel preservation check
//
// Phase 1 endpoints stay open as before (topology auth only — read-only).

"use strict";

const calibrationSession = require("./calibrationSession");

const KNOWN_INVERTERS_MAX = 27;
const KNOWN_NODES_PER_INV = [1, 2, 3, 4];

function registerCalibrationRoutes(app, deps) {
  const {
    isRemoteMode,
    proxyToRemote,
    requireTopologyAuth,
    callPython,
    loadIpConfigFromDb,
    getConfiguredNodeSet,
    isAuthorizedPlantWideControl,
    getActiveCriticalBlock,
    isCalibrationWritesEnabled,    // feature-flag getter (default false)
    setSetting,                     // settings persister (calibration-feature toggle)
    insertCalibrationSnapshot,
    getLatestCalibrationSnapshot,
    listCalibrationSnapshots,
    getCalibrationSnapshotById,
    deleteCalibrationSnapshotById,
    insertCalibrationWriteLog,
    listCalibrationWriteLog,
    insertCalibrationSession,
    updateCalibrationSessionEnd,
    getCalibrationSession,
    listRecentCalibrationSessions,
    insertAuditLogRow,
    broadcastUpdate,                // WS push for session banner
    setActivePowerPct,               // existing cmd-3 wrapper (Python POST /write)
  } = deps;

  // ── Helpers ──────────────────────────────────────────────────────────

  function resolveIp(inv) {
    const cfg = loadIpConfigFromDb();
    return cfg?.inverters?.[inv] || cfg?.inverters?.[String(inv)] || null;
  }

  function validateInvSlave(req, res) {
    const inv = Number(req.params.inverter);
    const slave = Number(req.params.slave);
    if (!Number.isInteger(inv) || inv < 1 || inv > KNOWN_INVERTERS_MAX) {
      res.status(400).json({ ok: false, error: `inverter must be 1..${KNOWN_INVERTERS_MAX}` });
      return null;
    }
    if (!KNOWN_NODES_PER_INV.includes(slave)) {
      res.status(400).json({ ok: false, error: `slave must be one of ${KNOWN_NODES_PER_INV.join(",")}` });
      return null;
    }
    const ip = resolveIp(inv);
    if (!ip) {
      res.status(404).json({ ok: false, error: `no IP configured for inverter ${inv}` });
      return null;
    }
    return { inv, slave, ip };
  }

  function requireWritesEnabled(req, res, next) {
    if (typeof isCalibrationWritesEnabled === "function" && !isCalibrationWritesEnabled()) {
      return res.status(503).json({
        ok: false,
        error: "Calibration writes are disabled. Set `calibrationWritesEnabled` in Settings after sign-off.",
      });
    }
    next();
  }

  function requireBulkAuth(req, res, next) {
    if (typeof isAuthorizedPlantWideControl !== "function" || !isAuthorizedPlantWideControl(req.body || {}, req)) {
      return res.status(403).json({ ok: false, error: "Authorization required (sacupsMM)." });
    }
    next();
  }

  function requireActiveSession(req, res, next) {
    if (!calibrationSession.isActive()) {
      return res.status(409).json({ ok: false, error: "No active calibration session. Start one first." });
    }
    const body = req.body || {};
    const sid = String(body.session_id || "").trim();
    const cur = calibrationSession.currentSession();
    if (!sid || sid !== cur.session_id) {
      return res.status(409).json({ ok: false, error: "Session id mismatch — heartbeat may have expired." });
    }
    req._session = cur;
    next();
  }

  function checkCriticalBlock(inv) {
    if (typeof getActiveCriticalBlock !== "function") return null;
    try {
      const blk = getActiveCriticalBlock(inv);
      if (blk && !blk.acked_at_ms) {
        return {
          status: 423,
          error: `Inverter ${inv} is critically-blocked (${blk.pattern_hex}). Acknowledge the block first.`,
          pattern_hex: blk.pattern_hex,
          pattern_key: blk.pattern_key,
        };
      }
    } catch (_) {}
    return null;
  }

  function broadcastSessionState(eventKind = "update") {
    if (typeof broadcastUpdate !== "function") return;
    try {
      broadcastUpdate({
        type: "calibration_session",
        kind: eventKind,
        active: calibrationSession.isActive(),
        session: calibrationSession.currentSession(),
        at_ms: Date.now(),
      });
    } catch (_) {}
  }

  // Push lockdown state to the Python service on every lifecycle event
  // so the auto-reset loop (and any future Python guards) can suspend
  // their tick against the target inverter.
  async function _pushLockdown(active, session) {
    try {
      await callPython("/calibration/lockdown", "POST", active ? {
        active: true,
        inverter: session?.inverter,
        slave:    session?.slave,
        session_id: session?.session_id,
      } : { active: false });
    } catch (err) {
      console.warn("[calibration] lockdown push failed:", err?.message);
    }
  }

  // Auto-broadcast session lifecycle events from the session module.
  calibrationSession.subscribe((ev) => {
    broadcastSessionState(ev.kind);
    if (ev.kind === "begin") {
      _pushLockdown(true, ev.session);
    } else if (ev.kind === "end" || ev.kind === "abort" || ev.kind === "auto_end") {
      _pushLockdown(false, null);
    }
  });

  // ── PHASE 1: read endpoints ──────────────────────────────────────────

  app.get("/api/calibration/state/:inverter/:slave", requireTopologyAuth, async (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    const t = validateInvSlave(req, res); if (!t) return;
    try {
      const result = await callPython(
        `/calibration/state/${encodeURIComponent(t.ip)}/${t.slave}`, "GET");
      if (result?.ok) result.inverter = t.inv;
      // If session is active for this target, surface session state so the
      // UI doesn't have to make a second call.
      result.session = calibrationSession.isTargetUnderCalibration(t.inv, t.slave)
        ? calibrationSession.currentSession()
        : null;
      return res.json(result);
    } catch (err) {
      return res.status(502).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.get("/api/calibration/full-config/:inverter/:slave", requireTopologyAuth, async (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    const t = validateInvSlave(req, res); if (!t) return;
    try {
      const result = await callPython(
        `/calibration/full-config/${encodeURIComponent(t.ip)}/${t.slave}`, "GET");
      if (result?.ok) result.inverter = t.inv;
      return res.json(result);
    } catch (err) {
      return res.status(502).json({ ok: false, error: err?.message || String(err) });
    }
  });

  let _fleetScanInFlight = false;
  app.get("/api/calibration/fleet-summary", requireTopologyAuth, async (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    if (_fleetScanInFlight) {
      return res.status(429).json({ ok: false, error: "fleet scan already running" });
    }
    _fleetScanInFlight = true;
    try {
      const cfg = loadIpConfigFromDb();
      const inverters = cfg?.inverters || {};
      const units = cfg?.units || {};
      const perNode = [];
      const failures = [];
      const sortedInvs = Object.keys(inverters).map(Number)
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= KNOWN_INVERTERS_MAX)
        .sort((a, b) => a - b);
      for (const inv of sortedInvs) {
        const ip = inverters[inv] || inverters[String(inv)];
        if (!ip) continue;
        const unitsRaw = units?.[inv] ?? units?.[String(inv)] ?? KNOWN_NODES_PER_INV;
        const unitList = Array.isArray(unitsRaw)
          ? unitsRaw.map(Number).filter((n) => KNOWN_NODES_PER_INV.includes(n))
          : KNOWN_NODES_PER_INV.slice();
        for (const slave of unitList) {
          try {
            const r = await callPython(`/calibration/state/${encodeURIComponent(ip)}/${slave}`, "GET");
            if (r?.ok) {
              perNode.push({ inverter: inv, slave, ip, calibration: r.calibration, read_at_ms: r.read_at_ms });
            } else {
              failures.push({ inverter: inv, slave, ip, error: r?.error || "unknown" });
            }
          } catch (err) {
            failures.push({ inverter: inv, slave, ip, error: err?.message || String(err) });
          }
        }
      }
      const summary = _aggregateFleet(perNode);
      return res.json({
        ok: true,
        scanned: perNode.length,
        failed:  failures.length,
        medians: summary.medians,
        per_node: summary.per_node,
        failures,
        completed_at_ms: Date.now(),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || String(err) });
    } finally {
      _fleetScanInFlight = false;
    }
  });

  app.get("/api/calibration/feature-status", (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    const writesEnabled = typeof isCalibrationWritesEnabled === "function"
      ? !!isCalibrationWritesEnabled() : false;
    res.json({
      ok: true,
      phase: writesEnabled ? "writes-enabled" : "read-only",
      writes_enabled: writesEnabled,
      session_active: calibrationSession.isActive(),
      session: calibrationSession.currentSession(),
      fleet_scan_busy: _fleetScanInFlight,
    });
  });

  // Toggle `calibrationWritesEnabled` from the Field Calibration page.
  // Gateway-only (remote mode proxies). Topology-auth gated. Refuses
  // disable while a session is active.
  app.post("/api/calibration/feature-toggle", requireTopologyAuth, (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    if (typeof setSetting !== "function") {
      return res.status(500).json({ ok: false, error: "setSetting_unavailable" });
    }
    const enable = req.body?.enable === true || req.body?.enable === "1" || req.body?.enable === 1;
    if (!enable && calibrationSession.isActive()) {
      return res.status(409).json({ ok: false, error: "session_active" });
    }
    setSetting("calibrationWritesEnabled", enable ? "1" : "0");
    try {
      if (typeof insertAuditLogRow === "function") {
        insertAuditLogRow({
          actor: "operator",
          action: enable ? "calib_writes_enabled" : "calib_writes_disabled",
          detail: JSON.stringify({ via: "field_calibration_page" }),
        });
      }
    } catch (_) {}
    res.json({ ok: true, writes_enabled: enable });
  });

  app.get("/api/calibration/audit-log", requireTopologyAuth, (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    try {
      const filters = {
        session_id: req.query?.session_id,
        inverter_id: req.query?.inverter ? Number(req.query.inverter) : undefined,
        slave: req.query?.slave ? Number(req.query.slave) : undefined,
        limit: req.query?.limit ? Number(req.query.limit) : 100,
      };
      const rows = listCalibrationWriteLog(filters);
      const sessions = listRecentCalibrationSessions(20);
      res.json({ ok: true, rows, sessions });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // ── BACKUP / RESTORE ─────────────────────────────────────────────────
  //
  // Snapshot lifecycle:
  //   1. Session start → auto baseline snapshot (already wired)
  //   2. Session end   → auto post-write snapshot (already wired)
  //   3. Operator clicks "Backup Now" → manual snapshot (this section)
  //   4. Operator clicks "Restore" on a row → replays the 14 values via
  //      bulk write (requires active session + sacupsMM auth).
  //
  // Snapshots are kept for 5 years (DB retention policy) and surfaced
  // per (inverter, slave) so the operator can compare or roll back at
  // any point.

  // Decode the space-delimited `reg_block_hex` field (15 decimal UInt16
  // values for offsets 80..94, stored in ascending-offset order) back
  // into a writable list of (offset, value) pairs for offsets 81..94.
  // Offset 80 (ValidCfgCode) is intentionally excluded — it's a sentinel,
  // not a writable scale factor.
  function _decodeSnapshotWrites(reg_block_hex) {
    const tokens = String(reg_block_hex || "")
      .split(/\s+/).filter(Boolean);
    if (tokens.length < 15) return [];
    const writes = [];
    for (let i = 0; i < 15; i++) {
      const off = 80 + i;
      if (off === 80) continue;            // skip ValidCfgCode
      const raw = Number(tokens[i]);
      if (!Number.isFinite(raw)) continue;
      const u16 = raw & 0xFFFF;
      // Re-decode signed offsets (92, 94) so the Python write path
      // sign-encodes them correctly. Mirrors calibration_decoder.SIGNED.
      const signed = (off === 92 || off === 94)
        ? (u16 >= 0x8000 ? u16 - 0x10000 : u16) : u16;
      writes.push({ offset: off, value: signed });
    }
    return writes;
  }

  // GET — list snapshots for one (inverter, slave). Topology-auth gated.
  app.get("/api/calibration/snapshots/:inverter/:slave",
    requireTopologyAuth, (req, res) => {
      if (isRemoteMode()) return proxyToRemote(req, res);
      const inv = Number(req.params.inverter);
      const slave = Number(req.params.slave);
      if (!Number.isInteger(inv) || !KNOWN_NODES_PER_INV.includes(slave)) {
        return res.status(400).json({ ok: false, error: "invalid inverter/slave" });
      }
      try {
        const rows = listCalibrationSnapshots(inv, slave,
          Number(req.query?.limit) || 50);
        const decoded = rows.map((r) => ({
          ...r,
          writes_preview: _decodeSnapshotWrites(r.reg_block_hex),
        }));
        res.json({ ok: true, snapshots: decoded });
      } catch (err) {
        res.status(500).json({ ok: false, error: err?.message || String(err) });
      }
    });

  // POST — capture an on-demand backup of the current calibration block.
  // No session required (read-only operation + DB write); topology auth only.
  app.post("/api/calibration/snapshot/:inverter/:slave",
    requireTopologyAuth, async (req, res) => {
      if (isRemoteMode()) return proxyToRemote(req, res);
      const inv = Number(req.params.inverter);
      const slave = Number(req.params.slave);
      if (!Number.isInteger(inv) || !KNOWN_NODES_PER_INV.includes(slave)) {
        return res.status(400).json({ ok: false, error: "invalid inverter/slave" });
      }
      const ip = resolveIp(inv);
      if (!ip) return res.status(404).json({ ok: false, error: `no IP for inverter ${inv}` });
      const note = String((req.body && req.body.note) || "").slice(0, 200);

      let preflight;
      try {
        preflight = await callPython(`/calibration/preflight/${encodeURIComponent(ip)}/${slave}`, "GET");
      } catch (err) {
        return res.status(502).json({ ok: false, error: `preflight failed: ${err?.message || err}` });
      }
      if (!preflight?.ok || !preflight.by_offset) {
        return res.status(424).json({
          ok: false,
          error: `read failed: ${preflight?.error || "unknown"}`,
        });
      }
      const regBlockHex = Object.keys(preflight.by_offset)
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => String(preflight.by_offset[k] & 0xFFFF).padStart(4, "0"))
        .join(" ");

      // Best-effort: enrich with model/firmware if available via full-config.
      let model_code = null, firmware_main = null, serial = null;
      try {
        const fc = await callPython(`/calibration/full-config/${encodeURIComponent(ip)}/${slave}`, "GET");
        if (fc?.ok && fc.decoded?.context) {
          // Pull whatever the context block exposes — names match
          // calibration_decoder.CONTEXT_FIELDS.
          for (const c of fc.decoded.context) {
            if (c.field === "CountryCode") model_code = String(c.value || "");
          }
        }
      } catch (_) { /* metadata is best-effort */ }

      try {
        const id = insertCalibrationSnapshot({
          ts_utc: Date.now(),
          inverter_id: inv, inverter_ip: ip, slave,
          source: "manual",
          session_id: calibrationSession.isActive() && calibrationSession.isTargetUnderCalibration(inv, slave)
            ? calibrationSession.currentSession().session_id
            : null,
          reg_block_hex: regBlockHex,
          valid_cfg_code: preflight.sentinel,
          model_code, firmware_main, serial,
          notes: note || null,
        });
        try {
          insertAuditLogRow?.({
            ts: Date.now(),
            operator: String((req.body && req.body.operator) || "operator"),
            inverter: inv, node: slave,
            action: "calibration.snapshot.manual",
            scope: "calibration", result: "ok", ip,
            reason: `manual snapshot id=${id}${note ? ` note="${note}"` : ""}`,
          });
        } catch (_) {}
        res.json({
          ok: true, id, ts_utc: Date.now(), source: "manual",
          inverter: inv, slave, valid_cfg_code: preflight.sentinel,
          writes_preview: _decodeSnapshotWrites(regBlockHex),
        });
      } catch (err) {
        res.status(500).json({ ok: false, error: err?.message || String(err) });
      }
    });

  // POST — restore a snapshot by id. Replays the 14 scale-factor writes
  // through the same bulk-write pipeline used by the operator-facing
  // Write button (UNLOCK → WRITE → 1 s settle → VERIFY per register).
  //
  // Gated identically to a normal bulk write:
  //   • calibrationWritesEnabled feature flag
  //   • sacupsMM bulk-control auth
  //   • active calibration_session on the target (inverter, slave)
  //   • critical-block check on target
  //   • range guard (configurable via body.max_delta_pct; null disables)
  app.post("/api/calibration/restore",
    requireWritesEnabled,
    require("express").json(),
    requireBulkAuth,
    requireActiveSession,
    async (req, res) => {
      if (isRemoteMode()) return proxyToRemote(req, res);
      const body = req.body || {};
      const cur = req._session;
      const snapshotId = Number(body.snapshot_id);
      if (!Number.isInteger(snapshotId) || snapshotId <= 0) {
        return res.status(400).json({ ok: false, error: "snapshot_id required" });
      }
      const snap = typeof getCalibrationSnapshotById === "function"
        ? getCalibrationSnapshotById(snapshotId) : null;
      if (!snap) {
        return res.status(404).json({ ok: false, error: "snapshot not found" });
      }
      // The active session's target must match the snapshot's target,
      // otherwise restoring would write the wrong electronic block.
      if (Number(snap.inverter_id) !== Number(cur.inverter) ||
          Number(snap.slave) !== Number(cur.slave)) {
        return res.status(409).json({
          ok: false,
          error: `Snapshot belongs to Inv ${snap.inverter_id}/Node ${snap.slave} but session is on Inv ${cur.inverter}/Node ${cur.slave}.`,
        });
      }
      if (snap.valid_cfg_code != null && Number(snap.valid_cfg_code) !== 0x1F1F) {
        return res.status(424).json({
          ok: false,
          error: `Snapshot ValidCfgCode = 0x${Number(snap.valid_cfg_code).toString(16).toUpperCase()} (expected 0x1F1F). Refusing to restore.`,
        });
      }
      const writes = _decodeSnapshotWrites(snap.reg_block_hex);
      if (!writes.length) {
        return res.status(424).json({ ok: false, error: "snapshot reg_block_hex unreadable" });
      }
      const ip = resolveIp(cur.inverter);
      if (!ip) return res.status(404).json({ ok: false, error: `no IP for inverter ${cur.inverter}` });
      const cb = checkCriticalBlock(cur.inverter);
      if (cb) return res.status(cb.status).json({ ok: false, ...cb });

      try {
        const result = await callPython("/calibration/write-bulk", "POST", {
          ip, slave: cur.slave, writes,
          // Restores can move by more than 50 % vs current if the live
          // state has drifted significantly; allow caller to widen the
          // guard via body.max_delta_pct=null when they're confident.
          max_delta_pct: body.max_delta_pct === null
            ? null
            : (body.max_delta_pct == null ? 50.0 : Number(body.max_delta_pct)),
          verify_delay_s: 1.0,
        });
        try {
          for (const w of (result?.writes || [])) {
            insertCalibrationWriteLog({
              ts_utc: Date.now(),
              session_id: cur.session_id,
              inverter_id: cur.inverter, inverter_ip: ip, slave: cur.slave,
              reg_offset: w.offset, param_name: w.field || "",
              value_before: w.value_before,
              value_requested: w.value_requested,
              value_after: w.value_after,
              verify_ok: w.verify_ok ? 1 : 0,
              operator: cur.operator,
              auth_method: "sacupsMM+session+restore",
              error_detail: result?.error || null,
              notes: `restore from snapshot id=${snapshotId} (${snap.source})`,
            });
            if (w.verify_ok) calibrationSession.incrementWrite();
          }
          insertAuditLogRow?.({
            ts: Date.now(),
            operator: cur.operator,
            inverter: cur.inverter, node: cur.slave,
            action: "calibration.snapshot.restore",
            scope: "calibration", result: result?.ok ? "ok" : "partial", ip,
            reason: `snapshot id=${snapshotId} source=${snap.source} writes=${writes.length}`,
          });
        } catch (e) {
          console.warn("[calibration] restore log failed:", e?.message);
        }
        return res.json({ ...result, snapshot_id: snapshotId });
      } catch (err) {
        return res.status(502).json({ ok: false, error: err?.message || String(err) });
      }
    });

  // DELETE — remove a snapshot. Topology-auth gated. Refuses to delete
  // baseline/post-write snapshots that are tied to a session — only
  // manual snapshots are operator-removable.
  app.delete("/api/calibration/snapshot/:id",
    requireTopologyAuth, (req, res) => {
      if (isRemoteMode()) return proxyToRemote(req, res);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ ok: false, error: "id required" });
      }
      const snap = typeof getCalibrationSnapshotById === "function"
        ? getCalibrationSnapshotById(id) : null;
      if (!snap) return res.status(404).json({ ok: false, error: "snapshot not found" });
      if (snap.source !== "manual") {
        return res.status(409).json({
          ok: false,
          error: `Cannot delete ${snap.source} snapshot — it's part of the session audit trail.`,
        });
      }
      try {
        const changes = deleteCalibrationSnapshotById(id);
        res.json({ ok: true, deleted: changes });
      } catch (err) {
        res.status(500).json({ ok: false, error: err?.message || String(err) });
      }
    });

  // ── PHASE 2: session lifecycle ───────────────────────────────────────

  app.post("/api/calibration/session/start", requireTopologyAuth, async (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    const body = req.body || {};
    const inv = Number(body.inverter);
    const slave = Number(body.slave);
    if (!Number.isInteger(inv) || inv < 1 || inv > KNOWN_INVERTERS_MAX) {
      return res.status(400).json({ ok: false, error: "inverter required" });
    }
    if (!KNOWN_NODES_PER_INV.includes(slave)) {
      return res.status(400).json({ ok: false, error: "slave required" });
    }
    const ip = resolveIp(inv);
    if (!ip) return res.status(404).json({ ok: false, error: `no IP for inverter ${inv}` });
    if (calibrationSession.isActive()) {
      return res.status(409).json({
        ok: false,
        error: "Another calibration session is already active.",
        active: calibrationSession.currentSession(),
      });
    }
    const cb = checkCriticalBlock(inv);
    if (cb) return res.status(cb.status).json({ ok: false, ...cb });

    // Capture baseline snapshot via Python preflight
    let baseline = null;
    try {
      baseline = await callPython(`/calibration/preflight/${encodeURIComponent(ip)}/${slave}`, "GET");
    } catch (err) {
      return res.status(502).json({ ok: false, error: `preflight failed: ${err?.message || err}` });
    }
    if (!baseline?.ok) {
      return res.status(424).json({
        ok: false,
        error: `Preflight failed: ${baseline?.error || "unknown"}. Cannot start session.`,
      });
    }

    const operator = String(body.operator || "operator").slice(0, 64);
    let session;
    try {
      session = calibrationSession.begin({
        inverter: inv, slave, operator,
        idle_timeout_ms: Number(body.idle_timeout_ms) || undefined,
        hard_ceiling_ms: Number(body.hard_ceiling_ms) || undefined,
      });
    } catch (err) {
      return res.status(409).json({ ok: false, error: err?.message || String(err) });
    }

    // Persist baseline snapshot + session row
    try {
      const regBlockHex = Object.keys(baseline.by_offset).sort((a, b) => Number(a) - Number(b))
        .map((k) => String(baseline.by_offset[k] & 0xFFFF).padStart(4, "0"))
        .join(" ");
      insertCalibrationSnapshot({
        ts_utc: Date.now(),
        inverter_id: inv, inverter_ip: ip, slave,
        source: "baseline", session_id: session.session_id,
        reg_block_hex: regBlockHex,
        valid_cfg_code: baseline.sentinel,
      });
      insertCalibrationSession({
        session_id: session.session_id,
        inverter_id: inv, slave, operator,
        started_at_ms: Date.now(),
      });
      insertAuditLogRow?.({
        ts: Date.now(),
        operator,
        inverter: inv, node: slave,
        action: "calibration.session.start",
        scope: "calibration", result: "ok",
        ip,
        reason: `session ${session.session_id} baseline snapshot captured`,
      });
    } catch (err) {
      console.warn("[calibration] persist session-start failed:", err?.message);
    }

    return res.json({
      ok: true,
      session_id: session.session_id,
      idle_timeout_ms: session.idle_timeout_ms,
      hard_ceiling_ms: session.hard_ceiling_ms,
      baseline,
      session: calibrationSession.currentSession(),
    });
  });

  app.post("/api/calibration/session/heartbeat", (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    const sid = String((req.body && req.body.session_id) || "").trim();
    if (!sid) return res.status(400).json({ ok: false, error: "session_id required" });
    const r = calibrationSession.heartbeat(sid);
    return res.json(r);
  });

  app.post("/api/calibration/session/end", requireTopologyAuth, async (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    const body = req.body || {};
    const sid = String(body.session_id || "").trim();
    if (!sid) return res.status(400).json({ ok: false, error: "session_id required" });
    if (!calibrationSession.isActive()) {
      return res.status(404).json({ ok: false, error: "no active session" });
    }
    const cur = calibrationSession.currentSession();
    if (cur.session_id !== sid) {
      return res.status(409).json({ ok: false, error: "session_id mismatch" });
    }
    // Release consign (return to 100 %) if any consign writes happened.
    if (cur.consign_writes > 0 && typeof setActivePowerPct === "function") {
      try {
        const ip = resolveIp(cur.inverter);
        if (ip) await setActivePowerPct(ip, cur.slave, 100);
      } catch (err) {
        console.warn(`[calibration] release-consign on end failed: ${err?.message}`);
      }
    }
    // Capture post-session snapshot
    try {
      const ip = resolveIp(cur.inverter);
      if (ip) {
        const post = await callPython(`/calibration/preflight/${encodeURIComponent(ip)}/${cur.slave}`, "GET");
        if (post?.ok) {
          const hex = Object.keys(post.by_offset).sort((a, b) => Number(a) - Number(b))
            .map((k) => String(post.by_offset[k] & 0xFFFF).padStart(4, "0"))
            .join(" ");
          insertCalibrationSnapshot({
            ts_utc: Date.now(),
            inverter_id: cur.inverter, inverter_ip: ip, slave: cur.slave,
            source: "post-write", session_id: sid,
            reg_block_hex: hex, valid_cfg_code: post.sentinel,
          });
        }
      }
    } catch (err) {
      console.warn("[calibration] post-session snapshot failed:", err?.message);
    }

    const ended = calibrationSession.end(sid, body.reason || "operator");
    try {
      updateCalibrationSessionEnd(sid, ended.end_reason, {
        write_count: ended.write_count,
        consign_writes: ended.consign_writes,
      });
      insertAuditLogRow?.({
        ts: Date.now(),
        operator: cur.operator,
        inverter: cur.inverter, node: cur.slave,
        action: "calibration.session.end",
        scope: "calibration",
        result: "ok",
        reason: `reason=${ended.end_reason} writes=${ended.write_count} consign=${ended.consign_writes} dur_s=${(ended.duration_ms/1000)|0}`,
      });
    } catch (_) {}
    return res.json({ ok: true, ...ended });
  });

  // ── PHASE 2: write paths ─────────────────────────────────────────────

  app.post("/api/calibration/write",
    requireWritesEnabled,
    require("express").json(),
    requireBulkAuth,
    requireActiveSession,
    async (req, res) => {
      if (isRemoteMode()) return proxyToRemote(req, res);
      const body = req.body || {};
      const cur = req._session;
      // Force target to match the active session — operator can't write to a
      // different inverter without ending the session first.
      const inv = cur.inverter, slave = cur.slave;
      const ip = resolveIp(inv);
      if (!ip) return res.status(404).json({ ok: false, error: `no IP for inverter ${inv}` });
      const cb = checkCriticalBlock(inv);
      if (cb) return res.status(cb.status).json({ ok: false, ...cb });

      const offset = Number(body.offset);
      const value = Number(body.value);
      if (!Number.isInteger(offset)) {
        return res.status(400).json({ ok: false, error: "offset required" });
      }
      if (!Number.isFinite(value)) {
        return res.status(400).json({ ok: false, error: "value required" });
      }
      try {
        const result = await callPython("/calibration/write", "POST", {
          ip, slave, offset, value: Math.trunc(value),
          max_delta_pct: body.max_delta_pct == null ? 50.0 : Number(body.max_delta_pct),
          verify_delay_s: 1.0,
        });
        try {
          insertCalibrationWriteLog({
            ts_utc: Date.now(),
            session_id: cur.session_id,
            inverter_id: inv, inverter_ip: ip, slave,
            reg_offset: offset,
            param_name: result?.field || "",
            value_before: result?.value_before,
            value_requested: Math.trunc(value),
            value_after: result?.value_after,
            verify_ok: result?.verify_ok ? 1 : 0,
            operator: cur.operator,
            auth_method: "sacupsMM+session",
            error_detail: result?.error || null,
          });
          if (result?.verify_ok) calibrationSession.incrementWrite();
        } catch (e) {
          console.warn("[calibration] write log failed:", e?.message);
        }
        return res.json(result);
      } catch (err) {
        return res.status(502).json({ ok: false, error: err?.message || String(err) });
      }
    });

  app.post("/api/calibration/write-bulk",
    requireWritesEnabled,
    require("express").json(),
    requireBulkAuth,
    requireActiveSession,
    async (req, res) => {
      if (isRemoteMode()) return proxyToRemote(req, res);
      const body = req.body || {};
      const cur = req._session;
      const inv = cur.inverter, slave = cur.slave;
      const ip = resolveIp(inv);
      if (!ip) return res.status(404).json({ ok: false, error: `no IP for inverter ${inv}` });
      const cb = checkCriticalBlock(inv);
      if (cb) return res.status(cb.status).json({ ok: false, ...cb });

      const writes = Array.isArray(body.writes) ? body.writes : null;
      if (!writes || !writes.length) {
        return res.status(400).json({ ok: false, error: "writes (non-empty list) required" });
      }
      try {
        const result = await callPython("/calibration/write-bulk", "POST", {
          ip, slave, writes,
          max_delta_pct: body.max_delta_pct == null ? 50.0 : Number(body.max_delta_pct),
          verify_delay_s: 1.0,
        });
        try {
          for (const w of (result?.writes || [])) {
            insertCalibrationWriteLog({
              ts_utc: Date.now(),
              session_id: cur.session_id,
              inverter_id: inv, inverter_ip: ip, slave,
              reg_offset: w.offset, param_name: w.field || "",
              value_before: w.value_before,
              value_requested: w.value_requested,
              value_after: w.value_after,
              verify_ok: w.verify_ok ? 1 : 0,
              operator: cur.operator,
              auth_method: "sacupsMM+session+bulk",
              error_detail: result?.error || null,
            });
            if (w.verify_ok) calibrationSession.incrementWrite();
          }
        } catch (e) {
          console.warn("[calibration] bulk write log failed:", e?.message);
        }
        return res.json(result);
      } catch (err) {
        return res.status(502).json({ ok: false, error: err?.message || String(err) });
      }
    });

  // ── PHASE 3: consign mode (drive APC cmd-3 under active session) ────

  // Tracks last consign timestamp per inverter for the dwell timer.
  const _consignDwell = new Map();   // `${inv}/${slave}` -> { pct, ts_ms }
  const CONSIGN_MIN_DWELL_MS = 30_000;

  app.post("/api/calibration/consign",
    requireWritesEnabled,
    require("express").json(),
    requireBulkAuth,
    requireActiveSession,
    async (req, res) => {
      if (isRemoteMode()) return proxyToRemote(req, res);
      const body = req.body || {};
      const cur = req._session;
      const inv = cur.inverter, slave = cur.slave;
      const ip = resolveIp(inv);
      if (!ip) return res.status(404).json({ ok: false, error: `no IP for inverter ${inv}` });
      const cb = checkCriticalBlock(inv);
      if (cb) return res.status(cb.status).json({ ok: false, ...cb });

      const pct = Number(body.percent);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        return res.status(400).json({ ok: false, error: "percent must be 0..100" });
      }

      // Dwell guard: between distinct setpoints we require 30 s minimum so the
      // PAC has time to settle before the operator does the next measurement.
      // The "release to 100 %" case is exempt.
      const key = `${inv}/${slave}`;
      const last = _consignDwell.get(key);
      if (last && pct !== 100 && last.pct !== pct) {
        const since = Date.now() - last.ts_ms;
        if (since < CONSIGN_MIN_DWELL_MS) {
          return res.status(429).json({
            ok: false,
            error: `Wait ${Math.ceil((CONSIGN_MIN_DWELL_MS - since) / 1000)} s for the previous setpoint to settle.`,
            since_last_ms: since,
            min_dwell_ms: CONSIGN_MIN_DWELL_MS,
          });
        }
      }

      try {
        if (typeof setActivePowerPct !== "function") {
          return res.status(500).json({ ok: false, error: "consign path not wired (setActivePowerPct missing)" });
        }
        const r = await setActivePowerPct(ip, slave, pct);
        if (r?.ok) {
          _consignDwell.set(key, { pct, ts_ms: Date.now() });
          calibrationSession.incrementConsign();
          insertAuditLogRow?.({
            ts: Date.now(), operator: cur.operator,
            inverter: inv, node: slave,
            action: "calibration.consign",
            scope: "calibration", result: "ok",
            ip,
            reason: `pct=${pct} session=${cur.session_id}`,
          });
        }
        return res.json(r);
      } catch (err) {
        return res.status(502).json({ ok: false, error: err?.message || String(err) });
      }
    });

  // ── PHASE 4: bulk copy with hardware-fingerprint match ──────────────

  app.post("/api/calibration/copy",
    requireWritesEnabled,
    require("express").json(),
    requireBulkAuth,
    requireActiveSession,
    async (req, res) => {
      if (isRemoteMode()) return proxyToRemote(req, res);
      const body = req.body || {};
      const cur = req._session;
      const dstInv = cur.inverter, dstSlave = cur.slave;
      const srcInv = Number(body.source_inverter);
      const srcSlave = Number(body.source_slave);
      if (!Number.isInteger(srcInv) || !KNOWN_NODES_PER_INV.includes(srcSlave)) {
        return res.status(400).json({ ok: false, error: "source_inverter + source_slave required" });
      }
      if (srcInv === dstInv && srcSlave === dstSlave) {
        return res.status(400).json({ ok: false, error: "source and destination are identical" });
      }
      const dstIp = resolveIp(dstInv);
      const srcIp = resolveIp(srcInv);
      if (!srcIp || !dstIp) {
        return res.status(404).json({ ok: false, error: "source or destination IP not configured" });
      }
      const cb = checkCriticalBlock(dstInv);
      if (cb) return res.status(cb.status).json({ ok: false, ...cb });

      // Read both sides
      let srcState, dstState;
      try {
        [srcState, dstState] = await Promise.all([
          callPython(`/calibration/state/${encodeURIComponent(srcIp)}/${srcSlave}`, "GET"),
          callPython(`/calibration/state/${encodeURIComponent(dstIp)}/${dstSlave}`, "GET"),
        ]);
      } catch (err) {
        return res.status(502).json({ ok: false, error: err?.message || String(err) });
      }
      if (!srcState?.ok || !dstState?.ok) {
        return res.status(424).json({ ok: false, error: "could not read source and/or destination state" });
      }
      if (!srcState?.calibration?.valid_cfg_code_ok || !dstState?.calibration?.valid_cfg_code_ok) {
        return res.status(424).json({ ok: false, error: "ValidCfgCode sentinel not 0x1F1F on one side; refusing copy" });
      }

      // Hardware fingerprint check: verify source and destination are the
      // same inverter model + firmware before copying scale factors. A
      // calibration block from a different module would silently produce
      // wrong readings. Caller can pass `force_fingerprint=true` to
      // bypass after explicit operator acknowledgment (e.g. after
      // confirming both modules are physically identical).
      const forceFingerprint = body.force_fingerprint === true
        || body.force_fingerprint === "1" || body.force_fingerprint === 1;
      if (!forceFingerprint) {
        try {
          const [srcFc, dstFc] = await Promise.all([
            callPython(`/calibration/full-config/${encodeURIComponent(srcIp)}/${srcSlave}`, "GET"),
            callPython(`/calibration/full-config/${encodeURIComponent(dstIp)}/${dstSlave}`, "GET"),
          ]);
          const fpOf = (fc) => {
            const ctx = fc?.decoded?.context || [];
            const pick = (name) => ctx.find((c) => c.field === name)?.value ?? null;
            return {
              country:        pick("CountryCode"),
              nominal_power:  pick("PotenciaNominal"),
              vac_min:        pick("Vacmin"),
              vac_max:        pick("Vacmax"),
              fac_min:        pick("Facmin"),
              fac_max:        pick("Facmax"),
            };
          };
          const srcFp = fpOf(srcFc);
          const dstFp = fpOf(dstFc);
          const mismatched = Object.keys(srcFp).filter((k) => {
            return srcFp[k] != null && dstFp[k] != null && String(srcFp[k]) !== String(dstFp[k]);
          });
          if (mismatched.length) {
            return res.status(409).json({
              ok: false,
              error: `Hardware fingerprint mismatch on: ${mismatched.join(", ")}. Pass force_fingerprint=true to override after confirming the modules are identical.`,
              source_fingerprint: srcFp,
              dest_fingerprint: dstFp,
              mismatched_fields: mismatched,
            });
          }
        } catch (err) {
          return res.status(502).json({
            ok: false,
            error: `Fingerprint read failed: ${err?.message || err}. Pass force_fingerprint=true to skip the check.`,
          });
        }
      }

      // Build writes — only fields where source ≠ destination, to minimize bus traffic.
      const writes = [];
      for (const sf of (srcState.calibration.fields || [])) {
        const dfMatch = (dstState.calibration.fields || []).find((d) => d.offset === sf.offset);
        if (!dfMatch) continue;
        const srcVal = sf.is_signed ? sf.signed : sf.raw_u16;
        const dstVal = dfMatch.is_signed ? dfMatch.signed : dfMatch.raw_u16;
        if (srcVal !== dstVal) writes.push({ offset: sf.offset, value: srcVal });
      }
      if (!writes.length) {
        return res.json({ ok: true, status: "noop", writes: [], note: "source and destination already identical" });
      }

      try {
        const result = await callPython("/calibration/write-bulk", "POST", {
          ip: dstIp, slave: dstSlave, writes,
          max_delta_pct: body.max_delta_pct == null ? 50.0 : Number(body.max_delta_pct),
          verify_delay_s: 1.0,
        });
        try {
          for (const w of (result?.writes || [])) {
            insertCalibrationWriteLog({
              ts_utc: Date.now(),
              session_id: cur.session_id,
              inverter_id: dstInv, inverter_ip: dstIp, slave: dstSlave,
              reg_offset: w.offset, param_name: w.field || "",
              value_before: w.value_before,
              value_requested: w.value_requested,
              value_after: w.value_after,
              verify_ok: w.verify_ok ? 1 : 0,
              operator: cur.operator,
              auth_method: "sacupsMM+session+copy",
              error_detail: result?.error || null,
              notes: `copied from inv ${srcInv} / node ${srcSlave}`,
            });
            if (w.verify_ok) calibrationSession.incrementWrite();
          }
        } catch (e) {
          console.warn("[calibration] copy log failed:", e?.message);
        }
        return res.json({ ...result, source: { inverter: srcInv, slave: srcSlave } });
      } catch (err) {
        return res.status(502).json({ ok: false, error: err?.message || String(err) });
      }
    });
}

// Fleet aggregation (pure) — same as Phase 1.
function _aggregateFleet(perNode) {
  const byField = new Map();
  for (const st of perNode) {
    const fields = st?.calibration?.fields || [];
    for (const f of fields) {
      const arr = byField.get(f.field) || [];
      arr.push(Number(f.signed ?? f.raw_u16));
      byField.set(f.field, arr);
    }
  }
  const medians = {};
  for (const [k, vals] of byField) {
    const sorted = vals.slice().sort((a, b) => a - b);
    const n = sorted.length;
    if (!n) continue;
    medians[k] = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  }
  const out = [];
  for (const st of perNode) {
    const fields = st?.calibration?.fields || [];
    const deltas = {};
    for (const f of fields) {
      const med = medians[f.field];
      if (med == null || med === 0) {
        deltas[f.field] = null;
      } else {
        const v = Number(f.signed ?? f.raw_u16);
        deltas[f.field] = Number((((v - med) / med) * 100).toFixed(3));
      }
    }
    out.push({
      inverter:           st.inverter,
      slave:              st.slave,
      ip:                 st.ip,
      deltas_pct:         deltas,
      valid_cfg_code_ok:  st?.calibration?.valid_cfg_code_ok ?? null,
    });
  }
  return { medians, per_node: out };
}

module.exports = { registerCalibrationRoutes };
