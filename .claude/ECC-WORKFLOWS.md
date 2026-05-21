# ECC Workflows — ADSI Dashboard

Copy-paste command sequences for the most common ADSI Dashboard work types.
Each workflow is a complete sequence — run from top to bottom.

---

## 1. Feature → Ship (Full Lifecycle)

For any non-trivial new capability touching Python or Node.

```
/everything-claude-code:blueprint add <your feature description here>

# Review the plan output, then:
/everything-claude-code:tdd-workflow

# After implementing:
/everything-claude-code:python-review
/everything-claude-code:security-review
/everything-claude-code:verification-loop
/sub_smoker

# When ready:
/sub_releaser
```

---

## 2. Pre-Release (No New Code)

When code is already written and you only need to validate + ship.

```
/everything-claude-code:security-scan
/everything-claude-code:verification-loop
/sub_smoker
/sub_releaser
```

---

## 3. Forecast Engine Change

Anything in `services/forecast_engine.py` — ML tuning, Solcast logic, day-ahead paths, audit.

```
# Start with memory and research:
/claude-mem:mem-search <topic e.g. "Solcast reliability artifact">
/everything-claude-code:exa-search <topic e.g. "LightGBM solar irradiance forecasting">

# Design the change:
/everything-claude-code:blueprint <change description>

# Write tests first:
/everything-claude-code:tdd-workflow

# Delegate implementation:
# → Claude will invoke sub_forecaster automatically

# Review Python quality:
/everything-claude-code:python-review

# Verify end-to-end:
/everything-claude-code:verification-loop
/sub_smoker
```

**Example prompt after blueprint:**
```
/everything-claude-code:tdd-workflow
implement tests for lookup_solcast_tod_reliability() covering
morning/midday/afternoon zones with missing artifact fallback
```

---

## 4. Inverter Engine / Modbus Change

Anything in `services/inverter_engine.py`, Modbus TCP polling, write commands, auto-reset.

```
# If touching pymodbus API:
/everything-claude-code:docs pymodbus <method>

# Design:
/everything-claude-code:blueprint <change>

# Write tests:
/everything-claude-code:python-testing

# Delegate:
# → Claude will invoke sub_engr automatically

# Review:
/everything-claude-code:python-review

# Validate:
/sub_smoker
```

---

## 5. UI Change (Dashboard / Cards / Sidebar)

Anything in `public/js/app.js`, `public/index.html`, `public/css/style.css`.

```
# Design first (new components or significant layout changes):
/ui-ux-pro-max:ui-ux-pro-max <describe the component, layout, or UX goal>

# Delegate implementation:
# → Claude will invoke sub_fronter automatically

# After implementation — clean up:
/everything-claude-code:simplify

# Validate:
/sub_smoker
```

**Mandatory after any visible UI change:**
- Update `docs/ADSI-Dashboard-User-Manual.md`
- Update `docs/ADSI-Dashboard-User-Guide.html`
- Regenerate `docs/ADSI-Dashboard-User-Guide.pdf`

**Example:**
```
/ui-ux-pro-max:ui-ux-pro-max
design a compact forecast performance panel showing:
- MAPE gauge (0–100%)
- Regime breakdown (clear/mixed/overcast/rainy) with % weights
- Confidence band (P10/P90) as a toggle overlay
- Collapse on first load, expand on click
```

---

## 6. SQLite Schema Migration

Adding or changing a column, index, or table in `adsi.db`.

```
# Plan the migration strategy:
/everything-claude-code:database-migrations

# Design:
/everything-claude-code:plan <schema change>

# After implementing:
/sub_smoker
```

---

## 7. PostgreSQL / Cloud DB Work

Work in `server/cloudDb.js` — synced tables, cursor push, Supabase/Neon queries.

```
# Reference patterns:
/everything-claude-code:postgres-patterns

# If writing queries that touch user input:
/everything-claude-code:security-review server/cloudDb.js

# Validate push/pull:
/sub_smoker
```

---

## 8. Research Spike

Investigating a new approach, library, or algorithm before committing to implementation.

```
# Fast web search:
/everything-claude-code:exa-search <topic>

# Broad multi-source exploration:
/everything-claude-code:deep-research <topic>

# Focused API / library:
/everything-claude-code:docs <library> <feature>

# Check existing solutions:
/everything-claude-code:search-first <specific question>
```

**Example:**
```
/everything-claude-code:exa-search
LightGBM hyperparameter tuning for solar PV energy forecasting 2024

/everything-claude-code:deep-research
approaches to adaptive Solcast trust decay under persistent overcast regimes

/everything-claude-code:docs lightgbm LGBMRegressor early_stopping num_boost_round

/everything-claude-code:search-first
Python exponential decay weighting for time-series reliability estimation
```

---

## 9. Auth / Security Change

New endpoint, auth flow change, token handling, bulk control gate.

```
# After implementing:
/everything-claude-code:security-review <changed file>

# Full workspace audit (periodically):
/everything-claude-code:security-scan
```

**Files most likely to need review:**
- `server/index.js` — Express routes, auth middleware
- `server/auth.js` — session / token logic
- `public/js/app.js` — client-side auth gates

---

## 10. Session Management

### Starting a long task — save your checkpoint first:
```
/everything-claude-code:save-session
```

### Returning after a break:
```
/everything-claude-code:resume-session
```

### Browse all saved session history:
```
/everything-claude-code:sessions
```

### Context window getting heavy:
```
/everything-claude-code:strategic-compact
```

### Check what context you're spending:
```
/everything-claude-code:context-budget
```

---

## 11. Memory-First Research

Before diving into a task, search accumulated project memory first.

```
# What do we already know about this topic?
/claude-mem:mem-search <topic>

# Broader memory exploration:
/claude-mem:smart-explore <topic>

# Generate a plan grounded in project memory:
/claude-mem:make-plan <feature or change>

# View what happened over time on this topic:
/claude-mem:timeline-report
```

**Example:**
```
/claude-mem:mem-search Solcast reliability
/claude-mem:smart-explore forecast engine training pipeline
/claude-mem:make-plan improve intraday correction for wet season
```

---

## 12. Instinct / Learning Loop

Extract patterns from what Claude learned this session.

```
# After completing a non-trivial session:
/everything-claude-code:learn-eval

# See accumulated instincts:
/everything-claude-code:instinct-status

# Cluster related instincts into a skill or command:
/everything-claude-code:evolve

# Promote a useful project instinct to global:
/everything-claude-code:promote
```

---

## 13. Code Cleanup

After a long implementation pass — remove dead code, reduce duplication, fix style.

```
# Identify cleanup targets:
/everything-claude-code:simplify

# Deep quality audit (if needed):
/everything-claude-code:plankton-code-quality <file or module>

# If Python was changed, confirm quality:
/everything-claude-code:python-review

# Reference style rules:
/everything-claude-code:coding-standards

# Extract generalizable principles from the session:
/everything-claude-code:rules-distill

# Run smoke tests:
/sub_smoker
```

---

## 14. New Express API Endpoint

Designing and shipping a new REST endpoint end-to-end.

```
# Design the route/schema:
/everything-claude-code:api-design
<describe: resource, method, parameters, response shape, auth requirement>

# Reference middleware/async patterns:
/everything-claude-code:backend-patterns

# Write tests first:
/everything-claude-code:tdd-workflow

# After implementing:
/everything-claude-code:security-review server/index.js

# Smoke:
/sub_smoker
```

**Example:**
```
/everything-claude-code:api-design
design GET /api/alarms/history with filtering by inverter ID, severity level,
and date range — returns paginated JSON, requires admin auth

/everything-claude-code:backend-patterns
Express route with async SQLite query, pagination cursor, and input validation

/everything-claude-code:tdd-workflow
write tests for GET /api/alarms/history covering: valid filter, missing auth,
invalid inverter ID, empty result set
```

---

## 15. Codebase Onboarding

Getting a quick overview of a part of the codebase before diving in.

```
/everything-claude-code:codebase-onboarding
<specific area or question, e.g.:
  "how does the forecast engine communicate with the Node server?"
  "what is the energy authority and where does it live?"
  "explain the Solcast reliability artifact structure"
  "how does the cloud DB push cursor work?"
>
```

---

## 16. Architectural Decision Record

When a non-obvious architectural choice was made — document it for future reference.

```
/everything-claude-code:architecture-decision-records
Decision: <one-liner>
Context: <why this was being decided>
Options considered: <list>
Chosen: <what was picked>
Rationale: <why>
Consequences: <tradeoffs accepted>
```

**Example:**
```
/everything-claude-code:architecture-decision-records
Decision: Use async job queue (POST + poll) for forecast generation instead of SSE
Context: Day-ahead generation takes 30–120s; blocking HTTP would timeout in the UI
Options considered: SSE streaming, blocking POST, async job queue with status polling
Chosen: Async job queue with UUID job ID and 2-second polling
Rationale: Simple to implement, works across all browsers, survives UI reload
Consequences: 2s polling lag; client must handle timeout (15 min max) and GC on server
```

---

## 17. Multi-Agent Orchestration

Running a coordinated pipeline of specialized agents.

```
/everything-claude-code:orchestrate
<describe the pipeline, e.g.:>
run sub_forecaster to implement seasonal blending →
then /everything-claude-code:python-review →
then /sub_smoker

# For designing a reliable agentic workflow:
/everything-claude-code:agentic-engineering
<describe the autonomous task>
```

---

## Quick Reference Card

| I want to... | Run this |
|---|---|
| Plan a feature | `/everything-claude-code:blueprint <feature>` |
| Design a UI component | `/ui-ux-pro-max:ui-ux-pro-max <description>` |
| Look up library docs | `/everything-claude-code:docs <lib> <topic>` |
| Web research (Exa) | `/everything-claude-code:exa-search <topic>` |
| Write tests first | `/everything-claude-code:tdd-workflow` |
| Review Python code | `/everything-claude-code:python-review` |
| Deep quality audit | `/everything-claude-code:plankton-code-quality <file>` |
| Design a new API endpoint | `/everything-claude-code:api-design` |
| Design Express middleware | `/everything-claude-code:backend-patterns` |
| Improve dashboard JS | `/everything-claude-code:frontend-patterns` |
| Check security | `/everything-claude-code:security-review <file>` |
| Scan workspace for secrets | `/everything-claude-code:security-scan` |
| Clean up code | `/everything-claude-code:simplify` |
| Run final verification | `/everything-claude-code:verification-loop` |
| Publish a release | `/sub_releaser` |
| Run smoke tests | `/sub_smoker` |
| Save session | `/everything-claude-code:save-session` |
| Resume session | `/everything-claude-code:resume-session` |
| Browse sessions | `/everything-claude-code:sessions` |
| Compress context | `/everything-claude-code:strategic-compact` |
| Search project memory | `/claude-mem:mem-search <topic>` |
| Explore memory graph | `/claude-mem:smart-explore <topic>` |
| Plan from memory | `/claude-mem:make-plan <task>` |
| Extract session learnings | `/everything-claude-code:learn-eval` |
| See learned patterns | `/everything-claude-code:instinct-status` |
| Cluster instincts into skill | `/everything-claude-code:evolve` |
| Promote instinct to global | `/everything-claude-code:promote` |
| Check skill health | `/everything-claude-code:skill-health` |
| Document arch decision | `/everything-claude-code:architecture-decision-records` |
| Optimize a delegation prompt | `/everything-claude-code:prompt-optimize` |
