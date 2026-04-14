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

function issuePlantWideAuthSession(nowMs = Date.now()) {
  cleanupExpiredEntries(authSessions, nowMs);
  const issuedAt = Number(nowMs || Date.now());
  const expiresAt = issuedAt + BULK_AUTH_SESSION_TTL_MS;
  const token = crypto.randomBytes(24).toString("hex");
  authSessions.set(token, { issuedAt, expiresAt });
  return { token, issuedAt, expiresAt, ttlMs: BULK_AUTH_SESSION_TTL_MS };
}

function isValidPlantWideAuthSession(value, nowMs = Date.now()) {
  const token = normalizeAuthValue(value);
  if (!token) return false;
  cleanupExpiredEntries(authSessions, nowMs);
  return authSessions.has(token);
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
