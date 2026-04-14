# Audit 2026-04-14 — v2.8.8 Confidence Release

Self-contained record of the comprehensive bug sweep and Phase-1 remediation that shipped as v2.8.8 on 2026-04-14.

## Reading order

| Order | File | Purpose |
|---|---|---|
| 1 | [CHANGELOG_v2.8.8.md](CHANGELOG_v2.8.8.md) | Short release summary, one-liner per fix, upgrade notes |
| 2 | [BUG_SWEEP.md](BUG_SWEEP.md) | The full 123-finding audit (frozen baseline; do not edit) |
| 3 | [FIXES_PROGRESS.md](FIXES_PROGRESS.md) | What shipped, commit by commit |
| 4 | [FIX_DEBUG_INDEX.md](FIX_DEBUG_INDEX.md) | Per-fix file:line anchors, log signatures, rollback commands, symptom-if-misbehaving table, post-release monitoring checklist |
| 5 | [KNOWN_GAPS.md](KNOWN_GAPS.md) | What was deliberately NOT fixed (100-item HIGH/MED/LOW backlog, partial fixes, audit coverage gaps, verification gaps, tooling gaps, symptom → known-gap grep table) |
| 6 | [PHASE2_FIXES.md](PHASE2_FIXES.md) | Post-v2.8.8 session that closed T4.4 (Node-side lock), verified T6.3 thumbprint, and fixed T2.10/T2.11/T2.12/T5.4. Read alongside KNOWN_GAPS.md — its "closed" table amends that doc until it is regenerated. |
| 7 | [PHASE3_FIXES.md](PHASE3_FIXES.md) | Post-Phase-2 session that closed Electron hardening (T6.7/T6.9/T6.10/T6.11) and frontend tail (T5.5/T5.6/T5.7/T5.8). Same amend convention as Phase 2. |
| 8 | [SMOKE_BASELINE.md](SMOKE_BASELINE.md) | First end-to-end run of the new T7.3 smoke harness (`scripts/smoke-all.js`). Records Phase-2/3 verification result (zero regressions) and catalogues 5 pre-existing Node-test failures for triage. |
| 9 | [PHASE5_FIXES.md](PHASE5_FIXES.md) | Phase 5 — Node subsystem hardening: T2.3 (token bind), T2.4 (token-store key), T2.5 (alarm dedup on restart), T2.6 (cap math clamp), T2.7 (go2rtc spawn cleanup), T2.8 (snapshot capture serialisation), T2.9 (streaming backoff cap). Smoke-verified zero regressions. |

## When to use which file

- **Debugging something post-v2.8.8** → [FIX_DEBUG_INDEX.md](FIX_DEBUG_INDEX.md) § Post-release monitoring; then [KNOWN_GAPS.md](KNOWN_GAPS.md) § 7 (symptom → gap) before filing a new bug.
- **Planning v2.8.9** → [KNOWN_GAPS.md](KNOWN_GAPS.md) § 1 and § 2 (untouched backlog + partial fixes); then [BUG_SWEEP.md](BUG_SWEEP.md) tracks T1–T6 for HIGH findings.
- **Running the next audit** → [KNOWN_GAPS.md](KNOWN_GAPS.md) § 5.3 (agent-orchestration lessons).
- **Writing release notes** → copy [CHANGELOG_v2.8.8.md](CHANGELOG_v2.8.8.md).
- **Rolling back a fix** → [FIX_DEBUG_INDEX.md](FIX_DEBUG_INDEX.md) § Rollback tips.

## Commit index for this audit

Phase 1 (v2.8.8 release):

```
b153d69  Document v2.8.8 gaps + per-fix debug index + changelog + docs README
0d4f8b9  Document v2.8.8 CRITICAL-fix progress log
8d9e949  Fix Phase 1F (v2.8.8): Electron hardening + version sync
250cdd4  Fix Phase 1E (v2.8.8): Frontend memory/integrity hardening
9fcd6bf  Fix Phase 1D (v2.8.8): Node subsystem security
0402ff7  Fix Phase 1C (v2.8.8): Forecast ML correctness
d1c6081  Fix Phase 1B (v2.8.8): Inverter write-control safety
974be7f  Fix Phase 1A (v2.8.8): SQL injection, export yields, pressure-retry
1d88c8e  Document comprehensive v2.8.8 bug sweep: 123 findings across 8 tracks
```

Phase 2 + Phase 3 + Phase 4 + Phase 5 (post-v2.8.8, pre-v2.8.9):

```
6ca5a66  Fix Phase 2 backend: T4.4 forecast lock + T2.10/T2.11/T2.12
eb1057b  Fix Phase 3 Electron: T6.7/T6.9/T6.10/T6.11 hardening
f83c131  Fix Phase 2+3 frontend: T5.4/T5.5/T5.6/T5.7/T5.8
fb36a19  Document Phase 2 + Phase 3 fixes
a5fed94  Add T7.3 smoke harness + first baseline run (Phase 4)
(next)   Fix Phase 5 Node subsystem: T2.3-T2.9
(next)   Document Phase 5 fixes
```

---

**Heads-up when reading older commit messages** — these audit docs lived under `docs/` (with longer `*_2026-04-14.md` filenames) in commits `1d88c8e` through `b153d69`. They moved to this folder after the fix commits; filenames were simplified since the folder now carries the date. Use `git log --follow audits/2026-04-14/<file>` to walk the history across the rename.
