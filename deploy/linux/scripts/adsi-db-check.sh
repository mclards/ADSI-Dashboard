#!/usr/bin/env bash
# =============================================================================
# adsi-db-check.sh — ADSI SQLite Startup Integrity Check
# =============================================================================
# Called by adsi-server.service ExecStartPre= before Node.js starts.
# Runs PRAGMA quick_check on the ADSI database and automatically performs
# a dump-and-restore repair if corruption is detected.
# Exits 0 always so it never blocks service start.
# =============================================================================

DB_PATH="/var/lib/adsi-dashboard/db/adsi.db"
LOG_FILE="/var/log/adsi-dashboard/db-check.log"
TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"

log() { echo "[${TIMESTAMP}] $*" >> "${LOG_FILE}"; }

# ── Ensure log directory exists ───────────────────────────────────────────────
mkdir -p "$(dirname "${LOG_FILE}")" 2>/dev/null || true

log "--- ADSI DB integrity check started ---"

# ── Database existence check ──────────────────────────────────────────────────
if [[ ! -f "${DB_PATH}" ]]; then
  log "INFO: Database not found at ${DB_PATH} — skipping check (first-run or clean install)"
  log "--- ADSI DB integrity check finished (no db) ---"
  exit 0
fi

# ── PRAGMA quick_check ────────────────────────────────────────────────────────
log "INFO: Running PRAGMA quick_check on ${DB_PATH}..."
CHECK_RESULT="$(sqlite3 "${DB_PATH}" "PRAGMA quick_check;" 2>>"${LOG_FILE}" || echo "error")"

if [[ "${CHECK_RESULT}" == "ok" ]]; then
  log "OK:   Database integrity check passed."
  log "--- ADSI DB integrity check finished (ok) ---"
  exit 0
fi

# ── Corruption detected — attempt automatic dump-and-restore repair ───────────
log "WARN: Integrity check failed! Result: ${CHECK_RESULT}"
log "WARN: Attempting automatic dump-and-restore repair..."

DB_DIR="$(dirname "${DB_PATH}")"
DB_BASENAME="$(basename "${DB_PATH}")"
DB_NEW="${DB_DIR}/adsi_new.db"
DB_BAK="${DB_DIR}/${DB_BASENAME}.auto-repaired.bak"

# Clean up any leftover temp db from a previous failed attempt
rm -f "${DB_NEW}" 2>/dev/null || true

if sqlite3 "${DB_PATH}" ".dump" 2>>"${LOG_FILE}" | sqlite3 "${DB_NEW}" 2>>"${LOG_FILE}"; then
  mv "${DB_PATH}" "${DB_BAK}" 2>>"${LOG_FILE}" && \
  mv "${DB_NEW}" "${DB_PATH}" 2>>"${LOG_FILE}"
  # Restore ownership (service runs as adsi)
  chown adsi:adsi "${DB_PATH}" 2>/dev/null || true
  log "OK:   Repair successful. Corrupt original backed up to ${DB_BAK}"
else
  log "ERROR: Dump-and-restore repair FAILED. Manual intervention required."
  log "ERROR: Service will attempt to start anyway — check ${DB_BAK} if issues persist."
  rm -f "${DB_NEW}" 2>/dev/null || true
fi

log "--- ADSI DB integrity check finished (repaired) ---"

# Always exit 0 — never block service start
exit 0
