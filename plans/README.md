# Plans Index

Working documents that describe **what we intend to do** (proposed audits, blueprints, patch plans) — distinct from `audits/` (which records what was actually executed and shipped).

## Convention

- **Filename:** `YYYY-MM-DD-<topic-kebab-case>.md` — date prefix sorts chronologically and makes the timestamp visible in every reference.
- **Mandatory header metadata** at the top of every file:
  - `**Date:** YYYY-MM-DD` — when the plan was drafted (immutable).
  - `**Status:** <DRAFT | OPEN | PENDING | APPLIED | REVERTED | DEFERRED | OBSOLETE>` — current state. Update in place as the plan evolves; record the deciding commit hash next to APPLIED / REVERTED.
- Recommended header metadata when relevant:
  - `**Author:**`, `**Target version:**`, `**Target file:**`, `**Risk level:**`, `**Rollback:**`, `**Companion doc:**`.
- **Cross-references** between plans use the full filename (`plans/YYYY-MM-DD-topic.md`) so they survive file moves and grep cleanly.
- **When a plan ships**, update `Status:` to `APPLIED` and add the commit hash. Do NOT delete the plan — its presence in the repo is the historical record.
- **When a plan is abandoned**, set `Status: OBSOLETE` and add a one-line reason at the top.

## Current plans

| Date | Status | Plan |
|---|---|---|
| 2026-04-12 | OPEN | [SQLite Connection Patterns Audit — v2.8](2026-04-12-audit-sqlite-connection-patterns.md) |
| 2026-04-12 | OPEN | [ML Error Correction Reliability Audit — v2.8](2026-04-12-audit-ml-error-correction-reliability.md) |
| 2026-04-11 | OPEN | [Solcast Data Feed Reliability Audit (v2.8)](2026-04-11-audit-solcast-data-feed-reliability.md) |
| 2026-04-11 | OPEN | [Solcast Data Feed Efficiency Audit — v2.8](2026-04-11-audit-solcast-data-feed-efficiency.md) |
| 2026-04-11 | DRAFT | [Day-Ahead Locked Snapshot + Analytics Chart + Active Learning](2026-04-11-dayahead-locked-snapshot.md) |
| 2026-04-11 | PENDING | [FEATURE_COLS Slim-Down Patch (v2.8)](2026-04-11-feature-cols-slim.md) |
| 2026-04-10 | Draft | [Rainy/Overcast Error Memory Hardening](2026-04-10-rainy-overcast-error-memory-hardening.md) |

## When to file a plan vs an audit

- **Plan** = forward-looking; "we should look at X" or "we should change Y".
- **Audit** = backward-looking record of an executed sweep + remediation; lives in `audits/<YYYY-MM-DD>/`.

A plan that is fully executed and shipped becomes the *source* for an audit folder, but the original plan stays in `plans/` with its status updated to APPLIED so the historical decision-trail is preserved.

## Naming patterns to AVOID

The following filename patterns are **gitignored at the repo root** (per `.gitignore`) and would silently fail to commit if used inside `plans/`:

- `IMPLEMENTATION_*.md` / `IMPLEMENTATION_*.txt`
- `SOLCAST_TRI_BAND_*.md`

If you have a plan in those topic areas, prefix with the date and use a descriptive kebab-case name instead (e.g. `2026-04-15-implementation-x.md`, `2026-04-15-solcast-tri-band-x.md`).
