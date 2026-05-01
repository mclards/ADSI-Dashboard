# Security Audit — 2026-04-28

**ADSI Inverter Dashboard v2.10.0 — Comprehensive Security Review**

This directory contains the complete security audit findings for the ADSI Inverter Dashboard released on 2026-04-28.

## Files

### security-audit.md (Main Report — 653 lines)
Complete security audit report covering:
- **Executive Summary** — 16 findings (3 CRITICAL, 5 HIGH, 5 MEDIUM, 3 LOW)
- **CRITICAL Findings** (3):
  - SEC-C-001: Electron vulnerabilities (17 CVEs)
  - SEC-C-002: Transitive dependencies (tar, basic-ftp, @xmldom/xmldom)
  - SEC-C-003: Lodash prototype pollution
- **HIGH Findings** (5):
  - SEC-H-001: Timing attack in auth comparison
  - SEC-H-002: 2-minute replay window for sacupsMM
  - SEC-H-003: Weak topology auth format (adsiM/adsiMM)
  - SEC-H-004: Serial tokens not bound to client IP
  - SEC-H-005: Clock-sync endpoints not rate-limited
- **MEDIUM Findings** (5):
  - SEC-M-001: inverter_5min_param not remote-gated (fixed in beta.4)
  - SEC-M-002: Weak IPC parameter validation
  - SEC-M-003: OAuth partition persistent
  - SEC-M-004: Hardcoded default credentials
  - SEC-M-005: Binds to all network interfaces
- **LOW Findings** (3):
  - SEC-L-001: Topology auth no brute-force rate-limit
  - SEC-L-002: Audit log exposes operator usernames
  - SEC-L-003: No token rotation policy
- **Informational Findings** (4 PASS):
  - escapeHtml() XSS prevention ✓
  - Integrity gate works ✓
  - CORS restricted ✓
  - Prepared statements ✓
- **Defense-in-Depth Observations** — 7 strengths documented
- **Top-3 Priorities** for next release
- **Dependency Remediation Roadmap** with timeline
- **Test Recommendations** and scope limitations

### security-audit-verification.txt (Verification Checklist — 111 lines)
Per-finding verification steps taken during audit with:
- Confirmation of each critical, high, and medium finding
- Code references and evidence
- Action items with effort estimates
- Testing recommendations after fixes
- Timeline for remediation (18 hours total)

## Key Statistics

| Category | Count | Status |
|----------|-------|--------|
| Critical Findings | 3 | Action required before release |
| High Findings | 5 | Must fix in v2.10.1 patch |
| Medium Findings | 5 | Fix in next release cycle |
| Low Findings | 3 | Address opportunistically |
| Positive Findings | 4 | Working as designed ✓ |
| **Total Audit Coverage** | **16 findings** | **HIGH confidence** |

## Quick Remediation Checklist

### Before v2.10.1 Release (4 hours)
- [ ] Upgrade electron to 41.3.0+ (test ABI)
- [ ] Implement crypto.timingSafeEqual() for all auth comparisons
- [ ] Bind serial session tokens to client IP/UA hash

### Before v2.11.0 Release (14 hours)
- [ ] Run `npm audit fix --force` for dependency vulnerabilities
- [ ] Reduce sacupsMM replay window or implement per-op nonce
- [ ] Add rate-limiting to topology auth and clock-sync endpoints
- [ ] Add IPC parameter validation with whitelist
- [ ] Change OAuth partition to non-persistent
- [ ] Enforce password change on first login
- [ ] Document binding configuration best practices

## Risk Assessment

**Overall Risk Profile:** HIGH (primarily from unpatched dependencies)

### Critical Risk Factors
1. **Electron 29.4.6** — 17 documented CVEs including ASAR bypass, IPC spoofing
2. **Transitive dependencies** — tar, basic-ftp, @xmldom/xmldom, lodash all have HIGH CVEs
3. **Timing attack** — Auth comparison uses non-constant-time operators
4. **Replay window** — sacupsMM key valid for 60+ seconds if captured
5. **Unbound tokens** — Serial session tokens allow cross-network replay

### Mitigating Factors
- All SQL queries properly parameterized (no injection risk)
- XSS prevention via escapeHtml() consistently applied
- Integrity gate (v2.8.11+) protects against post-install tampering
- Bulk auth session binding (IP+UA) prevents basic replay attacks
- Archive file sanitization prevents path traversal
- CORS restricted to localhost

## Audit Methodology

- **Static Code Analysis** — Manual review of auth flows, encryption, validation
- **Dependency Scanning** — npm audit + analysis of transitive dependencies
- **OWASP Top 10 Review** — Injection, auth, sensitive data, XXE, access control, config, XSS, deserialization, vulnerable dependencies, logging
- **Scope:** Express backend, Electron main/preload, Python FastAPI (high-level), frontend JavaScript, SQLite schema, build process

## Audit Confidence

**Confidence Level:** HIGH

**Not Tested (DAST out of scope):**
- Runtime fuzzing of Modbus FC16 commands
- Renderer process RCE → IPC sandbox escape
- OAuth token storage forensics (live test)
- Network-level penetration testing
- Load testing of rate-limiting (not yet implemented)

## Next Steps

1. **Review findings** with development team
2. **Prioritize Electron upgrade** as blocking issue for v2.10.0 distribution
3. **Create GitHub issues** using verification checklist as template
4. **Schedule patch release** (v2.10.1) for auth fixes
5. **Plan v2.11.0** for dependency upgrades and medium-priority fixes
6. **Re-audit** after fixes merged to main branch

## Report Metadata

| Field | Value |
|-------|-------|
| Audit Date | 2026-04-28 |
| Codebase Version | v2.10.0 (Release) |
| Git Commit | c30dc30 (main branch) |
| Auditor | Claude Security Reviewer |
| Report Status | COMPLETE |
| Distribution | Internal — Development Team Only |

## Contact

For questions about these findings or remediation approach:
- See security-audit.md for detailed explanations
- See security-audit-verification.txt for step-by-step verification
- All code references use absolute paths (D:\ADSI-Dashboard\...)

---

**Audit completed:** 2026-04-28 16:08 UTC+8  
**Report generated:** security-audit.md (653 lines, 30 KB)  
**Verification checklist:** security-audit-verification.txt (111 lines, 6.6 KB)
