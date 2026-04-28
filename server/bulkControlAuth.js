"use strict";

const crypto = require("crypto");

const PLANT_WIDE_AUTH_PREFIX = "sacups";
const BULK_AUTH_KEY_LEASE_MS = 10 * 60 * 1000;
const BULK_AUTH_SESSION_TTL_MS = 10 * 60 * 1000;

const authKeyLeases = new Map();
const authSessions = new Map();

function normalizeAuthValue(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanupExpiredEntries(store, nowMs = Date.now()) {
  const now = Number(nowMs || Date.now());
  for (const [key, entry] of store.entries()) {
    if (Number(entry?.expiresAt || 0) <= now) {
      store.delete(key);
    }
  }
}

function getPlantWideAuthKeys(nowMs = Date.now()) {
  // T2.1 fix: capture the clock value exactly once. `prev` is derived from
  // `now.getTime()`, never from a second Date.now() call, so the ±1-minute
  // contract is stable across a single invocation even if the system clock
  // steps between outer-scope reads. Callers that perform paired auth
  // operations (e.g. route handler that validates a key and then issues a
  // session) must capture nowMs once and thread it through both calls.
  const baseMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const now = new Date(baseMs);
  const prev = new Date(baseMs - 60000);
  return new Set([
    `${PLANT_WIDE_AUTH_PREFIX}${String(now.getMinutes()).padStart(2, "0")}`,
    `${PLANT_WIDE_AUTH_PREFIX}${String(prev.getMinutes()).padStart(2, "0")}`,
  ]);
}

function activatePlantWideAuthKeyLease(value, nowMs = Date.now()) {
  const key = normalizeAuthValue(value);
  if (!key) return null;
  cleanupExpiredEntries(authKeyLeases, nowMs);
  const issuedAt = Number(nowMs || Date.now());
  const expiresAt = issuedAt + BULK_AUTH_KEY_LEASE_MS;
  authKeyLeases.set(key, { issuedAt, expiresAt });
  return { key, issuedAt, expiresAt };
}

function hasActivePlantWideAuthKeyLease(value, nowMs = Date.now()) {
  const key = normalizeAuthValue(value);
  if (!key) return false;
  cleanupExpiredEntries(authKeyLeases, nowMs);
  return authKeyLeases.has(key);
}

function isValidPlantWideAuthKey(value, nowMs = Date.now()) {
  const key = normalizeAuthValue(value);
  if (!key) return false;
  if (getPlantWideAuthKeys(nowMs).has(key)) {
    activatePlantWideAuthKeyLease(key, nowMs);
    return true;
  }
  return hasActivePlantWideAuthKeyLease(key, nowMs);
}

// T2.3 fix (Phase 5, 2026-04-14): derive a per-session client fingerprint
// from the inbound request — IP plus a hash of the User-Agent.  The session
// is bound to this fingerprint at issue time and validated on every
// subsequent privileged call, so a token leaked via XSS / log inclusion /
// MITM cannot be replayed from a different client until TTL expiry.
//
// Bindings are OPTIONAL for backward compatibility:
//   - issuePlantWideAuthSession(nowMs)            -> unbound (legacy / tests)
//   - issuePlantWideAuthSession(nowMs, req)       -> bound to req.ip + UA hash
//   - isValidPlantWideAuthSession(token, nowMs)            -> accepts unbound only
//   - isValidPlantWideAuthSession(token, nowMs, req)       -> requires match if bound
//
// If a session is stored WITH bindings and the validator is called WITHOUT
// req, the call is rejected (fail-closed) — that path is reserved for
// internal/test code that should never validate user-bound tokens.
function _normIp(value) {
  return String(value || "").replace(/^::ffff:/, "").trim().toLowerCase();
}
function _bindingsFromReq(req) {
  if (!req) return null;
  const ip = _normIp(req.ip || req.connection?.remoteAddress);
  const ua = String(req.headers?.["user-agent"] || "").trim();
  if (!ip && !ua) return null;
  const uaHash = ua ? crypto.createHash("sha256").update(ua).digest("hex").slice(0, 16) : "";
  return { ip, uaHash };
}

function issuePlantWideAuthSession(nowMs = Date.now(), req) {
  cleanupExpiredEntries(authSessions, nowMs);
  const issuedAt = Number(nowMs || Date.now());
  const expiresAt = issuedAt + BULK_AUTH_SESSION_TTL_MS;
  const token = crypto.randomBytes(24).toString("hex");
  const bindings = _bindingsFromReq(req);
  authSessions.set(token, { issuedAt, expiresAt, bindings });
  return { token, issuedAt, expiresAt, ttlMs: BULK_AUTH_SESSION_TTL_MS };
}

function isValidPlantWideAuthSession(value, nowMs = Date.now(), req) {
  const token = normalizeAuthValue(value);
  if (!token) return false;
  cleanupExpiredEntries(authSessions, nowMs);
  const entry = authSessions.get(token);
  if (!entry) return false;
  // Backward-compatible path: unbound session accepts any caller.
  if (!entry.bindings) return true;
  // Bound session: require a request and matching fingerprint (fail-closed).
  const callerBindings = _bindingsFromReq(req);
  if (!callerBindings) return false;
  // Use timing-safe comparison to prevent side-channel attacks on IP + UA hash.
  if (entry.bindings.ip) {
    const a = Buffer.from(entry.bindings.ip);
    const b = Buffer.from(callerBindings.ip);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  }
  if (entry.bindings.uaHash) {
    const a = Buffer.from(entry.bindings.uaHash);
    const b = Buffer.from(callerBindings.uaHash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  }
  return true;
}

function __resetForTests() {
  authKeyLeases.clear();
  authSessions.clear();
}

module.exports = {
  PLANT_WIDE_AUTH_PREFIX,
  getPlantWideAuthKeys,
  isValidPlantWideAuthKey,
  issuePlantWideAuthSession,
  isValidPlantWideAuthSession,
  __resetForTests,
};
