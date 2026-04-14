# ADSI Dashboard Docs Index

## Operator / user-facing

- [ADSI-Dashboard-User-Manual.md](ADSI-Dashboard-User-Manual.md) — end-user operator manual
- [ADSI-Dashboard-User-Guide.html](ADSI-Dashboard-User-Guide.html) / `.pdf` — same content, pre-rendered
- [ADSI-Dashboard-Pricing-Summary.pdf](ADSI-Dashboard-Pricing-Summary.pdf)
- [ADSI_Dashboard_Presentation.pptx](ADSI_Dashboard_Presentation.pptx)

## Developer reference

- [CODE_SIGNING.md](CODE_SIGNING.md) — certificate decisions, SmartScreen guidance

## v2.8.8 confidence release (2026-04-14)

The four files below form a **linked set** documenting the comprehensive bug sweep and Phase-1 remediation. Read in this order:

1. [**CHANGELOG_v2.8.8.md**](CHANGELOG_v2.8.8.md) — short release summary, one-liner per fix, upgrade notes
2. [**BUG_SWEEP_2026-04-14.md**](BUG_SWEEP_2026-04-14.md) — the full 123-finding audit (frozen baseline; do not edit)
3. [**FIXES_PROGRESS_2026-04-14.md**](FIXES_PROGRESS_2026-04-14.md) — what shipped, commit by commit
4. [**FIX_DEBUG_INDEX_2026-04-14.md**](FIX_DEBUG_INDEX_2026-04-14.md) — per-fix file:line anchors, log signatures, rollback commands, symptom-if-misbehaving table, post-release monitoring checklist
5. [**KNOWN_GAPS_2026-04-14.md**](KNOWN_GAPS_2026-04-14.md) — what was deliberately NOT fixed (100-item HIGH/MED/LOW backlog, partial fixes, audit coverage gaps, verification gaps, tooling gaps, "is this a known gap?" symptom → gap grep table)

**If you're debugging something post-v2.8.8**, start with CHANGELOG → FIX_DEBUG_INDEX. If the symptom isn't listed there, check KNOWN_GAPS §7 (symptom → known gap quick reference) before filing a new bug.

**If you're planning v2.8.9**, start with KNOWN_GAPS §1 and §2 (untouched backlog + partial fixes) and BUG_SWEEP tracks T1-T6 for HIGH findings.
