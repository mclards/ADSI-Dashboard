# CLAUDE.md

This file exists as a fallback in case `SKILL.md` is not consumed automatically.
**Read `SKILL.md` first** — it is the canonical codebase reference for this project.

Skill locations:
- `d:\ADSI-Dashboard\SKILL.md` (repo root)
- `.agents/skills/adsi-dashboard/SKILL.md` (Codex)
- `.claude/skills/adsi-dashboard/SKILL.md` (Claude Code)

Behavioral rules and constraints live in `CLAUDE.md` (this file) and `AGENTS.md`.
Detailed history and working notes live in `MEMORY.md`.

---

## Project Snapshot

| Field | Value |
|---|---|
| Product | ADSI Inverter Dashboard |
| Author | Engr. Clariden Montaño REE (Engr. M.) |
| Package | `inverter-dashboard` |
| Updater app ID | `com.engr-m.inverter-dashboard` — do not rename |
| Repo version baseline | `2.4.33` in `package.json` (source of truth) |
| Deployed server version | `2.2.32` (may legitimately lag) |
| Latest published release | `v2.4.33` |
| GitHub release channel | `mclards/ADSI-Dashboard` |

---

## Default Credentials and Access Keys

*(Internal only — do not mirror into public docs.)*

| Key | Value / Pattern |
|---|---|
| Login username | `admin` |
| Login password | `1234` |
| Admin auth key | `ADSI-2026` (resets to `admin` / `1234`) |
| Bulk inverter control | `sacupsMM` (MM = current minute ±1) |
| Topology / IP Config auth | `adsiM` or `adsiMM` |
| IP Config session | 1 hour |
| Topology session | 10 minutes |

No built-in defaults for: remote gateway API token, Solcast credentials, cloud-backup OAuth.
Live secrets go only in git-ignored `private/*.md`.

---

---

## Forecast Day-Ahead Generation Architecture (v2.4.31+)

All four generation paths route through the same Node orchestrator (`runDayAheadGenerationPlan`). Provider routing and Solcast freshness decisions are always made by Node. Python owns ML execution only.

| Path | Trigger | Audit |
|------|---------|-------|
| Manual UI | `POST /api/forecast/generate` | Node |
| Auto scheduler | Python loop → `_delegate_run_dayahead()` | Node |
| Python CLI | `--generate-date` → `_delegate_run_dayahead()` | Node |
| Python CLI fallback | Node unreachable, direct `run_dayahead(write_audit=True)` | Python |
| Node cron | 04:30/18:30/20:00/22:00, quality-aware | Node |

`_delegate_run_dayahead()` uses `ADSI_SERVER_PORT` (default 3500). Node cron classifies tomorrow quality (`missing`/`incomplete`/`wrong_provider`/`stale_input`/`weak_quality`/`healthy`) — only `healthy` suppresses regeneration.

---

## Solcast Reliability Dimensions (v2.4.33+)

`build_solcast_reliability_artifact()` produces a multi-dimensional trust profile at 5-min slot resolution:

| Dimension | Artifact Key | Effect |
|---|---|---|
| Weather regime | `regimes` (clear/mixed/overcast/rainy) | Per-regime bias_ratio + reliability |
| Season | `seasons` (dry/wet), `season_regimes` (dry:clear, etc.) | Season-aware lookup in `lookup_solcast_reliability()` |
| Time-of-day | `time_of_day` (morning/midday/afternoon), `time_of_day_by_regime` | Per-slot blend and floor modulation |
| Trend | `trend` (improving/stable/degrading) | Blend ±6-8%, residual damping adjustment |

All lookups have backward-compatible fallbacks — old artifacts without new keys load safely.

---

All other reference knowledge — architecture, data model, replication, forecast engine,
UI patterns, storage paths, build commands, smoke sequences — is in `SKILL.md`.
Do not duplicate it here.