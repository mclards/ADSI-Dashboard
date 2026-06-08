# ADSI Inverter Dashboard — Security Audit Report

**Date:** 2026-04-28  
**Version Audited:** 2.10.0 (Release build)  
**Scope:** Full codebase review including Express backend, Electron main process, Python services, and frontend  
**Methodology:** Static analysis, dependency scanning, auth flow verification, IPC contract review

---

## Executive Summary

The ADSI Inverter Dashboard implements robust authentication and authorization controls for privileged operations (bulk inverter control, serial number writes, IP config changes, clock synchronization). Security-critical functionality is properly gated and uses parameterized database queries throughout. However, **9 high-severity dependency vulnerabilities** present direct risks to the installer, build process, and Electron runtime. Additionally, **3 medium-severity issues** warrant attention before the next production release.

**Overall Risk Profile:** HIGH (primarily from unpatched dependencies)

---

## Critical Findings

### SEC-C-001: Unpatched Electron Security Vulnerabilities

**File:** package.json:41  
**Severity:** CRITICAL  
**Dependency:** electron <=39.8.4  
**Affected Versions:** Current pinned version appears vulnerable

**Problem:**  
The npm audit reveals 17 documented CVEs in the pinned Electron version, including:
- ASAR integrity bypass via resource modification (GHSA-vmqv-hx8q-j7mg)
- Service worker IPC reply spoofing (GHSA-xj5x-m3f3-5x3h)
- Incorrect origin validation for iframe permission requests (GHSA-r5p7-gp4j-qhrx)
- Out-of-bounds read in second-instance IPC on macOS/Linux
- Multiple use-after-free vulnerabilities in callbacks and dialogs

**Attack Scenario:**  
An attacker exploiting the ASAR integrity bypass could modify the app.asar package during distribution or installation. Despite the existing SHA-512 integrity gate in v2.8.11, an ASAR-aware attacker could circumvent integrity checks by replacing the sidecar `.sha512` file itself if they gain write access to the installation directory. A second-instance IPC vulnerability could allow a local process to inject malicious data into the running dashboard.

**Impact:**  
- Malicious modification of executable code post-installation
- Local privilege escalation via IPC injection
- Credential harvesting from OAuth flows if webSecurity can be disabled
- Integrity gate rendered ineffective against sophisticated attackers

**Mitigation:**  
- Upgrade to electron@41.3.0 or later (breaking change per npm audit)
- Review MEMORY.md `feedback_native_rebuild` rule after upgrade
- Test Electron ABI compatibility after forced upgrade
- Consider secondary code-signing verification at runtime as defense-in-depth

---

### SEC-C-002: High-Severity Transitive Dependencies (tar, basic-ftp, @xmldom/xmldom)

**File:** package.json dependencies tree  
**Severity:** CRITICAL  
**Packages:** tar <=7.5.10 (8 CVEs), basic-ftp <=5.2.2 (3 CVEs), @xmldom/xmldom <=0.8.12 (4 CVEs)

**Problem:**  
While these packages are not directly imported by the dashboard, they are pulled into the dependency tree via electron-builder and AWS SDK:
- **tar**: Used during build process for extraction/packaging; CVEs include hardlink path traversal, symlink poisoning, race conditions
- **basic-ftp**: Transitive via electron-builder; CRLF injection allows arbitrary FTP command execution
- **@xmldom/xmldom**: Uncontrolled recursion in XML serialization (DoS) + XML injection via DocumentType/PI/comment nodes

**Attack Scenario:**  
During the build phase (`npm run build:win`), an attacker who can intercept or cache a malicious tar file could exploit hardlink path traversal to write files outside the intended archive directory. This could overwrite NSIS installer scripts or DLLs. For @xmldom: if the dashboard processes untrusted XML (unlikely in this app), an attacker could cause unbounded recursion leading to crash.

**Impact:**  
- Supply-chain compromise during installer build
- Potential arbitrary code execution in the built installer
- Denial of service if any XML processing occurs

**Mitigation:**  
- Run `npm audit fix --force` to upgrade to tar@7.6.0+, basic-ftp@5.3.0+, @xmldom/xmldom@0.8.13+
- Verify installer integrity with SHA-256 after each build
- Consider pinning build-tool versions separately from runtime versions
- Implement pre-build validation of tar files

---

### SEC-C-003: Lodash Prototype Pollution via _.unset / _.omit

**File:** package.json (transitive via exceljs)  
**Severity:** CRITICAL  
**Dependency:** lodash <=4.17.23

**Problem:**  
lodash has a documented prototype pollution vulnerability (GHSA-f23m-r3pf-42rh) in `_.unset` and `_.omit` when called with array path bypasses (e.g., `path = ['__proto__', 'key']`). This allows overwriting Object.prototype properties.

**Attack Scenario:**  
If the dashboard exports XLSX files via exceljs and an operator crafts a malicious payload that reaches lodash path manipulation, they could pollute Object.prototype. This would then affect all subsequent object operations — potentially allowing auth bypass, property enumeration attacks, or unexpected behavior in security-critical functions like auth validation.

**Impact:**  
- Object.prototype pollution affecting the entire Node process
- Potential bypass of auth checks that use object property lookups
- Cache-poisoning of internal object states

**Mitigation:**  
- Upgrade lodash to 4.17.24+
- Audit all XLSX export paths (exceljs) to ensure operator-supplied data cannot reach lodash path functions
- Consider removing lodash if not directly used (exceljs may not require it in newer versions)

---

## High-Severity Findings

### SEC-H-001: Timing Attack Risk in Auth Key Comparison

**File:** server/bulkControlAuth.js:116-117  
**Severity:** HIGH  
**Code:**
```javascript
if (entry.bindings.ip && entry.bindings.ip !== callerBindings.ip) return false;
if (entry.bindings.uaHash && entry.bindings.uaHash !== callerBindings.uaHash) return false;
```

**Problem:**  
String comparison of authentication bindings (IP address, User-Agent hash) uses strict `!==` operator, which is not timing-safe. An attacker with microsecond-precision network timing could potentially distinguish valid from invalid IP/UA combinations through timing side-channels.

**Attack Scenario:**  
An attacker with local network access or cloud co-location could measure response time variance of failed auth attempts. By comparing the elapsed time before rejection, they could enumerate which parts of a binding string are "correct" (longer comparison = more matching characters before mismatch).

**Impact:**  
- Potential bypass of client-binding checks on auth sessions
- Leakage of valid IP/User-Agent pairs

**Mitigation:**  
- Replace `!==` with `crypto.timingSafeEqual()` for all security-critical comparisons
- Example fix:
```javascript
if (entry.bindings.ip && !crypto.timingSafeEqual(
  Buffer.from(entry.bindings.ip),
  Buffer.from(callerBindings.ip)
)) return false;
```

---

### SEC-H-002: Rotation Window for `sacupsMM` Allows 2-Minute Replay

**File:** server/bulkControlAuth.js:35-38 + server/index.js:12351-12357  
**Severity:** HIGH  
**Code:**
```javascript
const now = new Date(baseMs);
const prev = new Date(baseMs - 60000);
return new Set([
  `${PLANT_WIDE_AUTH_PREFIX}${String(now.getMinutes()).padStart(2, "0")}`,
  `${PLANT_WIDE_AUTH_PREFIX}${String(prev.getMinutes()).padStart(2, "0")}`,
]);
```

**Problem:**  
The bulk auth key (`sacupsMM`) is valid for 2 minutes: current minute + previous minute. An attacker who captures a valid key has a ~60-second window to replay it (until the previous minute rolls out of the valid set). Additionally, the key rotates every minute based on system time, creating a predictable renewal pattern.

**Attack Scenario:**  
1. Attacker sniffs traffic and captures `sacups15` (issued at 14:15)
2. Attacker has until 14:17 to use this key (as both 14:15 and 14:16 minutes accept it)
3. If the attacker compromises a router or gateway between 14:15–14:17, they can issue privileged commands (inverter control, clock sync)
4. System clock adjustments (NTP, manual correction) could extend the window unpredictably

**Impact:**  
- Ability to control 27 inverters for ~60 seconds if key is captured
- Potential for coordinated attacks across multiple stolen keys
- Clock-skew attacks if NTP is not properly hardened

**Mitigation:**  
- Consider per-operation nonce or HMAC instead of pure time-based rotation
- Log all uses of `sacupsMM` with source IP + timestamp to audit_log for forensics
- Implement rate-limiting on bulk auth attempts (e.g., max 10 ops per minute per IP)
- Document the 2-minute window prominently in the manual; recommend air-gapping the gateway during sensitive operations
- Add server-side session tracking: after a key is used, mark it as "consumed" and reject immediate re-use from the same IP within 10 seconds

---

### SEC-H-003: Weak Topology Auth (`adsiM` / `adsiMM`)

**File:** server/index.js:12351-12357  
**Severity:** HIGH  
**Code:**
```javascript
const m = new Date().getMinutes();
const valid = new Set([
  `adsi${m}`, `adsi${String(m).padStart(2, "0")}`,
]);
const mPrev = (m + 59) % 60;
valid.add(`adsi${mPrev}`);
valid.add(`adsi${String(mPrev).padStart(2, "0")}`);
if (!valid.has(key)) return res.status(403).json({ ok: false, error: "Invalid authorization key." });
```

**Problem:**  
Topology auth accepts both single-digit and zero-padded minute values (e.g., both `adsi5` and `adsi05` for 05:xx). This doubles the brute-force search space. Additionally, both current and previous minutes are accepted, creating a 2-minute window.

**Attack Scenario:**  
An attacker who does not know the system time precisely can brute-force the valid key:
- If current time is minute 5: valid keys = `adsi5`, `adsi05`, `adsi4`, `adsi04` (4 options out of ~120 possibilities)
- Within 60 seconds, probability of randomly guessing correct key = 4/120 ≈ 3.3%
- With continuous attempts every 30 seconds, attacker has ~50% chance within 5 minutes

**Impact:**  
- Unauthorized access to Settings → Inverter Clocks page
- Ability to read IP configurations and modify inverter clock settings
- Elevation to full admin functions if Settings page leads to other admin operations

**Mitigation:**  
- Remove the single-digit variant; enforce zero-padded format only: `adsiMM`
- Consider reducing the window to 1 minute (current only) if the use-case permits
- Implement rate-limiting per IP: max 5 failed attempts per minute, exponential backoff
- Log all topology auth attempts (success + failure) with IP + timestamp
- Consider requiring the user to re-enter the key every 10 minutes (re-validate session)

---

### SEC-H-004: Serial Number Session Token Not Bound to Operator IP

**File:** server/serialNumber.js:76-87  
**Severity:** HIGH  
**Code:**
```javascript
function mintSession({ inverterIp, slave, oldSerial, fmt, actedBy }) {
  _purgeExpiredSessions();
  const token = crypto.randomBytes(16).toString("hex");
  _sessions.set(token, {
    inverterIp: String(inverterIp),
    slave: Number(slave),
    oldSerial: String(oldSerial || ""),
    fmt: String(fmt || "auto"),
    actedBy: String(actedBy || ""),
    mintedAt: Date.now(),
  });
  return { token, expiresAt: Date.now() + SESSION_TTL_MS };
}
```

**Problem:**  
Unlike bulk auth sessions (which use `_bindingsFromReq` to bind IP + User-Agent hash), the serial-number session token is **not bound** to the operator's client. An attacker who captures the token (via XSS, log disclosure, or network sniffing) can send it from any IP/browser without triggering a binding check.

**Attack Scenario:**  
1. Operator at IP 192.168.1.100 reads serial number → receives token `abc123`
2. An attacker on a different network (e.g., 10.0.0.50) captures the token via compromised log aggregation
3. Attacker sends the token with the serial number edit from their own IP — no binding check prevents this
4. Serial number is changed, potentially creating fleet uniqueness conflicts

**Impact:**  
- Unauthorized serial number modifications
- Cross-network relay attacks
- Impersonation of operators from different network segments

**Mitigation:**  
- Bind serial session tokens to client IP + User-Agent hash, matching the bulk auth pattern:
```javascript
function mintSession({ inverterIp, slave, oldSerial, fmt, actedBy, req }) {
  const token = crypto.randomBytes(16).toString("hex");
  const bindings = _bindingsFromReq(req);  // Reuse bulk auth's function
  _sessions.set(token, {
    inverterIp, slave, oldSerial, fmt, actedBy, mintedAt: Date.now(),
    bindings  // Add this line
  });
  return { token, expiresAt: Date.now() + SESSION_TTL_MS, bindings: !!bindings };
}
```
- Update `consumeSession` to validate bindings match the current request

---

### SEC-H-005: Modbus Broadcast Clock Sync Commands Not Rate-Limited

**File:** server/index.js:12812-12856 (broadcast sync endpoints)  
**Severity:** HIGH  
**Code:**
```javascript
app.post(
  "/api/sync-clock/broadcast",
  _requireBulkAuth,
  async (req, res) => { ... broadcast to unit 0 ... }
);
```

**Problem:**  
Clock synchronization commands are broadcast to unit 0 (all inverters) and trigger 27 units × 4 nodes ≈ 108 Modbus FC16 writes. There is **no rate-limiting** on these commands. An operator (or attacker with bulk auth key) could hammer the system with rapid clock-sync requests, saturating the RS485 bus and causing legitimate polling to fail.

**Attack Scenario:**  
1. Attacker obtains `sacups<MM>` key (60-second window after capture)
2. Attacker crafts 100 rapid `/api/sync-clock/broadcast` requests within 10 seconds
3. Each request sends 108 Modbus writes, totaling 10,800 frames in rapid succession
4. RS485 bus becomes congested; normal 5-minute polling begins failing with timeout/CRC errors
5. Plant goes blind to inverter data for minutes; forecast exports become stale

**Impact:**  
- Denial of service to data collection and forecasting
- Potential data corruption if writes interleave with reads
- Loss of audit trail due to database contention

**Mitigation:**  
- Implement rate-limiting on sync-clock endpoints: max 1 broadcast per minute per operator IP
- Add a circuit-breaker: if 3 clock-sync calls fail in a row, disable auto-sync for 5 minutes and alert
- Log all clock-sync attempts with IP + success/failure + duration
- Consider implementing sequential queuing: sync only 4 units per request, operator must repeat to sync the full fleet

---

## Medium-Severity Findings

### SEC-M-001: `inverter_5min_param` Not Gated for Remote Viewers

**File:** server/index.js:13139-13193, 13283  
**Severity:** MEDIUM  
**Status:** Fixed in v2.10.0-beta.4 per memory, but verify in current main branch

**Problem:**  
The `/api/params/:inverter/:slave` and `/api/params/:inverter` endpoints query and return `inverter_5min_param` table data **without checking** `isRemoteMode()`. In remote viewer mode, the local database contains no 5min params (they come from the gateway), so returning empty is correct — but the **endpoint should proxy to the gateway**, not return silent null.

**Attack Scenario:**  
A remote viewer operator navigates to the Parameters page expecting to see inverter diagnostics but gets a blank page. They assume the inverter is offline and manually control it. Meanwhile, the gateway is still collecting data. This misaligns situational awareness and could cause double-controlling or missed alarms.

**Impact:**  
- UI shows false "no data" for remote viewers
- Operator confusion and potential misoperation
- Forecast engine cannot see inverter capabilities

**Mitigation:**  
- Add `isRemoteMode()` guard at the top of both `/api/params/` endpoints
- If remote, proxy to gateway's same endpoint with remoteApiToken
- Return a consistent "remote data" response indicating data is from gateway, not local DB

---

### SEC-M-002: Platform Suffix / Serialization Not Validated in Player IPC

**File:** electron/main.js (multiple `ipcMain.on/handle` calls)  
**Severity:** MEDIUM

**Problem:**  
IPC handlers accept arbitrary payloads without strict validation. For example:
- `ipcMain.handle("pick-folder", ...)` accepts `startPath` parameter from renderer
- `ipcMain.handle("save-text-file", ...)` accepts `{ filePath, content, ... }` from renderer
- `ipcMain.on("open-logs-folder", (_, folder) => ...)` trusts `folder` parameter

While preload.js restricts which functions are exposed, a compromised renderer process can still bypass these restrictions if `contextIsolation` is disabled or exploited. Parameter validation is minimal.

**Attack Scenario:**  
If a renderer is compromised (e.g., via XSS in the dashboard UI), it can call:
```javascript
// Via compromised frontend JS
electronAPI.saveTextFile({
  filePath: "C:\\Windows\\System32\\drivers\\etc\\hosts",  // Path traversal
  content: "127.0.0.1 gateway.local"  // DNS hijacking payload
});
```
While `path.resolve` is used in some handlers, not all inputs are validated.

**Impact:**  
- Arbitrary file write access on the system (if renderer is compromised)
- Potential DNS hijacking, system config modification, malware injection

**Mitigation:**  
- Validate all IPC parameters against a whitelist:
  - For file paths: only allow writes under `PROGRAMDATA_ROOT/dashboard/exports/`
  - For folder paths: only allow navigation under `PROGRAMDATA_ROOT/dashboard/`
  - For URLs: enforce http/https and validate against known domains
- Reject any path containing `..` or drive-letter prefixes outside the app's directory
- Log all IPC calls with origin details for forensics
- Example:
```javascript
function validateExportPath(filePath) {
  const resolved = path.resolve(filePath);
  const allowedBase = path.resolve(PROGRAMDATA_ROOT, "exports");
  if (!resolved.startsWith(allowedBase)) {
    throw new Error("Path traversal detected");
  }
  return resolved;
}
```

---

### SEC-M-003: OAuth Window Partition Not Isolated from Main App Session

**File:** electron/main.js (oauth-start handler around line 400+)  
**Severity:** MEDIUM  
**Code:**
```javascript
const oauthWin = new BrowserWindow({
  partition: "persist:oauth-temp",  // isolated session
  nodeIntegration: false,
  contextIsolation: true,
  webSecurity: true,
});
```

**Problem:**  
The OAuth window uses a separate partition (`persist:oauth-temp`) which is good for isolation. However, the partition is **persistent** — OAuth tokens are cached on disk in that session directory. If the dashboard is later compromised and an attacker gains local file access, they can read the OAuth token from `%APPDATA%/Electron/oauth-temp/Default/`.

**Attack Scenario:**  
1. Dashboard is compromised via an XSS in a future version
2. Attacker enumerates the Electron data directories on the system
3. Attacker reads cached OAuth token from `persist:oauth-temp` session storage
4. Attacker uses the token to authenticate against the cloud provider (OneDrive, Google Drive, S3) and exfiltrates backups

**Impact:**  
- Cloud backup compromise
- Credential theft for cloud providers
- Exfiltration of sensitive historical data

**Mitigation:**  
- Change partition to non-persistent: `partition: "oauth-temp"` (without `persist:`)
- Clear all session data after OAuth flow completes (call `ses.clearCache()`)
- Implement token encryption at rest in the session store
- Consider storing OAuth token in OS keychain (via `keytar` module) instead of session storage
- Log all OAuth token usage with timestamp and cloud operation performed

---

### SEC-M-004: Hardcoded Default Credentials in Production Installer

**File:** CLAUDE.md (documented in project rules)  
**Severity:** MEDIUM  
**Credentials:** admin / 1234 (default login); ADSI-2026 (reset key)

**Problem:**  
While the dashboard allows password changes, the **installer provides default credentials** that many operators never change. These defaults are widely known (documented in CLAUDE.md, visible in this audit). An attacker who gains network access to the dashboard port (3500) can attempt login with `admin / 1234`.

**Attack Scenario:**  
1. Attacker scans for dashboard instances on a network (port 3500)
2. Attacker connects to a dashboard that hasn't changed default password
3. Attacker logs in and gains access to inverter monitoring and control
4. Attacker examines audit logs, disables alarms, or controls production

**Impact:**  
- Unauthorized access to production inverter control
- Data exfiltration from audit logs and energy records
- Loss of visibility into plant operations

**Mitigation:**  
- Installer should **require** password change on first login (not optional)
- Add a banner to Settings if admin password is still the default
- Consider implementing LDAP/OAuth integration for larger deployments
- Document password policy in User Guide: minimum 12 characters, complexity requirements
- Implement account lockout: disable account after 5 failed login attempts for 10 minutes

---

### SEC-M-005: Dashboard Binds to All Network Interfaces by Default

**File:** server/index.js:216 (PORT binding)  
**Severity:** MEDIUM  
**Code:**
```javascript
const PORT = Math.max(1, Math.min(65535, Number(process.env.ADSI_SERVER_PORT || 3500) || 3500));
```

**Problem:**  
The Express server binds to `0.0.0.0:3500` by default (specified in the startup), which means it listens on all network interfaces. If the gateway PC is connected to a network (LAN, WAN, or even the internet via misconfigured firewall), the dashboard is accessible from any network segment with routing.

**Attack Scenario:**  
1. Gateway PC is on a corporate LAN
2. A contractor's laptop gets access to the LAN (via WiFi, VPN, or physical access)
3. Contractor's machine can reach the gateway on `<gateway-ip>:3500`
4. Contractor attempts login with `admin / 1234`
5. If password hasn't been changed, contractor gains access to inverter control

**Impact:**  
- Unauthorized network access to inverter control from any network segment
- Increased attack surface if the gateway is accessible via VPN or WAN

**Mitigation:**  
- Document security recommendation: bind to `127.0.0.1:3500` if the gateway is local-only
- Provide an environment variable override: `DASHBOARD_BIND_HOST` to allow operator to restrict binding
- Default to binding to loopback + specific LAN interface, not all interfaces
- Add a warning banner in Settings if the dashboard is accessible from a non-local IP
- Implement firewall rules documentation in the User Guide

---

## Low-Severity Findings

### SEC-L-001: Topology Auth Window Cannot Prevent Brute-Force Guessing

**File:** server/index.js:12343-12360  
**Severity:** LOW  
**Problem:**  
While topology auth uses a 2-minute rotation window, there is **no rate-limiting** on failed attempts. An attacker can continuously guess the key without penalty.

**Mitigation:**  
Implement rate-limiting: max 5 failed topology auth attempts per minute per IP, with exponential backoff.

---

### SEC-L-002: Audit Log Contains Operator Usernames

**File:** server/db.js, server/index.js (audit_log table)  
**Severity:** LOW  
**Problem:**  
The audit log records `acted_by` (operator username) for all actions. If logs are disclosed, usernames are exposed. This is low-risk because usernames alone don't grant access, but combined with other data could aid social engineering.

**Mitigation:**  
Consider hashing usernames in audit logs (non-recoverable), or storing only "Operator 1, Operator 2, ..." identifiers. Document that operators should use pseudonyms if anonymity is a concern.

---

### SEC-L-003: Solcast API Credentials Not Rotated

**File:** server/cloudBackup.js (OAuth token storage)  
**Severity:** LOW  
**Problem:**  
OAuth tokens from cloud providers (OneDrive, Google Drive, S3) are stored on disk. While encrypted in transit, there is no documented token rotation policy. Long-lived tokens increase the impact if disclosed.

**Mitigation:**  
Implement automatic token rotation: refresh every 7 days even if not used. Log token refresh operations for forensics.

---

## Informational Findings

### SEC-I-001: escapeHtml() Function Used Correctly for XSS Prevention

**File:** public/js/app.js:21441  
**Status:** PASS

All user-supplied error messages, operator inputs, and server data are properly escaped via `escapeHtml()` before being inserted into the DOM. No instances of `innerHTML` with unescaped user data were found. The project uses prepared statements for all SQL queries, preventing SQL injection.

---

### SEC-I-002: Integrity Gate for app.asar Works As Designed

**File:** electron/integrityGate.js, electron/main.js:86-131  
**Status:** PASS

The power-loss resilience chain (v2.8.11+) correctly:
- Verifies app.asar SHA-512 before loading third-party modules
- Falls back to the last-good installer from the stash
- Records startup failures synchronously so recovery dialog can appear
- Uses `original-fs` instead of shimmed `fs` to avoid Electron's ASAR virtualization bug

This is a strong mitigation for post-installation tampering.

---

### SEC-I-003: CORS Properly Restricted to Localhost

**File:** server/index.js:160-168  
**Status:** PASS

CORS is configured to only accept requests from `localhost` and `127.0.0.1`. Remote gateway mode uses explicit API token gating (`remoteApiTokenGate`), not CORS.

---

### SEC-I-004: Prepared Statements Used Throughout Database Layer

**File:** server/db.js  
**Status:** PASS

All database queries use `db.prepare()` with parameterized placeholders. No string concatenation in SQL queries found. The codebase is protected against SQL injection attacks.

---

## Defense-in-Depth Observations (Strengths)

1. **Hoisted Exception Handlers (main.js):**  
   The survival-boot pattern in Electron's main process ensures that corrupted app.asar doesn't crash with cryptic SyntaxError. Errors are caught, logged, and the recovery dialog is shown. This is excellent design for resilience.

2. **Single-Instance Lock (T6.1 fix):**  
   The application correctly prevents multiple dashboard instances from running against the same database. This prevents SQLite locking errors and data corruption.

3. **Bulk Auth Session Binding (T2.3 fix):**  
   Bulk auth sessions are properly bound to client IP + User-Agent hash. This is a strong defense against token replay from different networks.

4. **Isolated OAuth Partition:**  
   The OAuth flow uses a separate, isolated partition with `webSecurity: true` and `nodeIntegration: false`. URL scheme is validated (http/https only).

5. **Archive File Sanitization:**  
   All archive filenames are sanitized against path traversal via `sanitizeArchiveFileName()`, which only accepts `YYYY-MM.db` format. Excellent input validation.

6. **Rate-Limited API Endpoints:**  
   Many endpoints (backup, forecast generation) include request size limits and queue management to prevent resource exhaustion.

7. **Secure HTTP Headers:**  
   Static assets are served with `no-store`, `no-cache`, `must-revalidate` cache headers, preventing browser caching of sensitive data.

---

## Top-3 Priorities for Next Release

### 1. **URGENT: Upgrade Electron to 41.3.0+**  
   **Why:** Current version has 17 documented CVEs including ASAR integrity bypass, IPC reply spoofing, and use-after-free bugs.  
   **Effort:** Medium (may require breaking changes; test ABI compatibility)  
   **Timeline:** Before v2.10.0 is distributed to production

### 2. **HIGH: Implement Timing-Safe Auth Comparisons**  
   **Why:** Current bulk auth and topology auth use `!==` for string comparison, allowing timing attacks on IP/UA bindings.  
   **Effort:** Low (one function change across two modules)  
   **Timeline:** Patch release (v2.10.1)

### 3. **HIGH: Bind Serial Session Tokens to Client IP**  
   **Why:** Unlike bulk auth, serial-number edit tokens are not bound to the requesting IP. Captured tokens can be replayed from any network.  
   **Effort:** Low (mirror bulk auth's `_bindingsFromReq` function)  
   **Timeline:** Patch release (v2.10.1)

---

## Dependency Remediation Roadmap

| Severity | Package | Current | Fixed | Effort | Timeline |
|----------|---------|---------|-------|--------|----------|
| CRITICAL | electron | ≤39.8.4 | 41.3.0+ | Medium | Immediate |
| CRITICAL | tar | ≤7.5.10 | 7.6.0+ | Low | Before next build |
| CRITICAL | basic-ftp | ≤5.2.2 | 5.3.0+ | Low | Before next build |
| CRITICAL | @xmldom/xmldom | ≤0.8.12 | 0.8.13+ | Low | Before next build |
| CRITICAL | lodash | ≤4.17.23 | 4.17.24+ | Low | Before next build |
| HIGH | fast-xml-parser | <5.7.0 | 5.7.0+ | Low | Next update |
| MODERATE | uuid | <14.0.0 | 14.0.0+ | Low | Next major version |

**Action:** Run `npm audit fix --force` to apply all non-breaking fixes. Then manually test installer build and smoke tests.

---

## Audit Confidence & Scope Limitations

**Confidence Level:** HIGH (static analysis + dependency scanning)

**Scope Limitations:**
- No runtime testing (DAST) was performed — only static code review
- Python FastAPI endpoints (`/serial/`, `/inverter/`) were reviewed at a high level but detailed Modbus protocol fuzzing was not performed
- Electron's renderer process security was reviewed but not deeply tested against CSP bypasses or preload-bridge exploits
- No penetration testing was conducted on the gateway network interface
- Cloud backup OAuth flows were reviewed for SSRF/scheme validation but not tested end-to-end

**Test Recommendations for Next Audit:**
1. Network-level fuzzing of Modbus FC16 commands to the inverter
2. Renderer-process compromise scenario (RCE → IPC), then sandbox escape attempts
3. OAuth token storage forensics (where are tokens persisted? How are they cleared?)
4. Load testing of bulk auth to verify rate-limiting (future implementation)

---

## Report Sign-Off

**Auditor:** Claude Security Reviewer (Automated Analysis)  
**Date Completed:** 2026-04-28  
**Codebase Version:** v2.10.0-beta.4 (main branch)  
**Next Review:** Recommended after Electron upgrade + auth fixes

**Verification Steps for Operator:**
- [ ] Run `npm audit` and verify no CRITICAL/HIGH vulnerabilities remain
- [ ] Verify default admin password is changed at first login (recommend enforcement)
- [ ] Test topology auth and bulk auth with invalid keys; verify they fail securely
- [ ] Check installer SHA-256 after each build
- [ ] Review `electron/main.js` lines 86–131 to confirm integrity gate is active
- [ ] Audit logs (via `/api/audit`) should show all auth attempts, not just successes

---

**End of Report**
