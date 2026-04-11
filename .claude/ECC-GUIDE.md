# Everything Claude Code (ECC) — Usage Guide for ADSI Dashboard

Source: [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) v1.8.0  
Additional plugins: `ui-ux-pro-max`, `claude-mem`, `skill-creator`

ECC skills expand into detailed prompt instructions that shape how Claude approaches a task.
They are invoked inline — no extra tooling needed. The marketplace is wired into
`.claude/settings.json` so all skills are available in every Claude Code session.

---

## How to Invoke

```
/everything-claude-code:<skill-name>
```

Or use short aliases where registered (e.g. `/plan`, `/tdd`, `/docs`).
Append your task description after the skill name on the same line.

---

## Planning & Architecture

| Skill | Shorthand | Use When |
|---|---|---|
| `everything-claude-code:plan` | `/plan` | Starting any non-trivial feature — structured step-by-step plan |
| `everything-claude-code:blueprint` | — | Turn a one-liner into a multi-PR plan with dependencies |
| `everything-claude-code:planner` | — | Complex refactors spanning many files; generates ordered task list |
| `everything-claude-code:architecture-decision-records` | — | Documenting major architectural decisions |
| `everything-claude-code:codebase-onboarding` | — | Fast overview of a codebase area (forecast engine, Node server, etc.) |
| `everything-claude-code:project-guidelines-example` | — | Create structured project guidelines from observed patterns |

**Examples:**

```
/everything-claude-code:plan add per-inverter export limit enforcement to the energy authority

/everything-claude-code:blueprint rework intraday adjuster to use season-aware bias correction

/everything-claude-code:architecture-decision-records
Decision: switching from raw SQLite WAL to cloud-sync hybrid for audit trail
Context: compliance requirement for 30-day audit retention
Options considered: WAL-only, cloud-only, hybrid
Chosen: hybrid SQLite (hot) + PostgreSQL (cloud)

/everything-claude-code:codebase-onboarding
how does the forecast engine communicate with the Node server?
```

---

## Code Review & Quality

| Skill | Shorthand | Use When |
|---|---|---|
| `everything-claude-code:python-review` | — | After any edit to `forecast_engine.py` or `inverter_engine.py` |
| `everything-claude-code:security-review` | — | After auth changes, new API endpoints, bulk control, token handling |
| `everything-claude-code:plankton-code-quality` | — | Thorough multi-lens quality review (complexity, coupling, debt) |
| `everything-claude-code:tdd` | `/tdd` | Before writing new logic — RED-GREEN-REFACTOR discipline |
| `everything-claude-code:tdd-workflow` | — | Full TDD cycle including scaffold + coverage check |
| `everything-claude-code:coding-standards` | — | Reference style conventions for a new module |
| `everything-claude-code:rules-distill` | — | Extract cross-cutting principles from multiple skills |
| `everything-claude-code:simplify` | `/simplify` | Post-implementation cleanup — remove duplication, dead code |

**Examples:**

```
# After modifying services/inverter_engine.py
/everything-claude-code:python-review

# After adding a new Express route to server/index.js
/everything-claude-code:security-review server/index.js

# Deep quality audit across a module
/everything-claude-code:plankton-code-quality services/forecast_engine.py

# Before implementing a new forecast quality classifier
/everything-claude-code:tdd

# Full TDD workflow for a new Python function
/everything-claude-code:tdd-workflow
implement lookup_solcast_tod_reliability() with morning/midday/afternoon fallback chain
```

---

## UI / Frontend

| Skill | Use When |
|---|---|
| `ui-ux-pro-max:ui-ux-pro-max` | Any UI design work — layout, theme, components, UX flows |
| `everything-claude-code:frontend-patterns` | Dashboard JS — chart rendering, card updates, WS subscriptions |
| `everything-claude-code:simplify` | After a long CSS/JS implementation — reduce bloat |

**Examples:**

```
# Design a new panel or component before implementation
/ui-ux-pro-max:ui-ux-pro-max
design a compact forecast performance panel: MAPE gauge, regime breakdown, confidence bands

# Improving how inverter cards subscribe to live WS data
/everything-claude-code:frontend-patterns
WebSocket subscription lifecycle for 27 inverter cards with partial updates

# Clean up public/css/style.css after a large theming pass
/everything-claude-code:simplify public/css/style.css
```

> **Reminder:** Any visible UI change must also update:
> `docs/ADSI-Dashboard-User-Manual.md`, `docs/ADSI-Dashboard-User-Guide.html`, and `.pdf`

---

## Node.js / Backend / API

| Skill | Use When |
|---|---|
| `everything-claude-code:backend-patterns` | Express middleware, WebSocket handlers, async job queues |
| `everything-claude-code:api-design` | Designing new REST endpoints — naming, error shapes, auth |
| `everything-claude-code:mcp-server-patterns` | Building or extending MCP server integrations |
| `everything-claude-code:docker-patterns` | Containerization or deployment patterns |

**Examples:**

```
# Before adding a new API endpoint for alarm history
/everything-claude-code:api-design
design GET /api/alarms/history with filtering by inverter, severity, date range

# Designing a background job pattern (like the forecast generation queue)
/everything-claude-code:backend-patterns
async job queue with status polling for long-running Python calls

# Working with MCP integrations
/everything-claude-code:mcp-server-patterns
MCP server for inverter status exposing read-only tool endpoints
```

---

## Database

| Skill | Use When |
|---|---|
| `everything-claude-code:postgres-patterns` | Cloud DB (Supabase/Neon) queries in `server/cloudDb.js` |
| `everything-claude-code:database-migrations` | SQLite schema changes — additive column, index, table |

**Examples:**

```
# Adding a new column to the cloud-synced readings table
/everything-claude-code:database-migrations
add daily_energy_kwh column to readings table, backfill from existing rows

# Optimizing the cloud push cursor query
/everything-claude-code:postgres-patterns
cursor-based pagination for bulk INSERT ... ON CONFLICT DO UPDATE
```

---

## Research & Documentation

| Skill | Shorthand | Use When |
|---|---|---|
| `everything-claude-code:docs` | `/docs` | Current API docs for a specific library method |
| `everything-claude-code:documentation-lookup` | — | Alt to `docs` — uses Context7 MCP for richer results |
| `everything-claude-code:exa-search` | — | Exa-powered web search for technical research |
| `everything-claude-code:deep-research` | — | Multi-source research on a technical topic |
| `everything-claude-code:search-first` | — | Before implementing — find prior art or existing libraries |
| `everything-claude-code:iterative-retrieval` | — | When one search round isn't enough |

**Examples:**

```
/everything-claude-code:docs pymodbus async ModbusTcpClient

/everything-claude-code:docs electron auto-updater differential updates

/everything-claude-code:exa-search
real-world LightGBM hyperparameter tuning for solar irradiance forecasting

/everything-claude-code:deep-research Solcast API rooftop vs advanced hobbyist accuracy comparison

/everything-claude-code:search-first best approach for SQLite WAL checkpoint on Windows

# When initial docs search is incomplete:
/everything-claude-code:iterative-retrieval
scikit-learn GradientBoostingRegressor partial_fit incremental training options
```

---

## Python-Specific

| Skill | Use When |
|---|---|
| `everything-claude-code:python-patterns` | Idiomatic Python for new modules |
| `everything-claude-code:python-testing` | Writing pytest tests for inverter or forecast engine |
| `everything-claude-code:tdd-workflow` | TDD cycle for any Python feature |
| `everything-claude-code:python-review` | Quality check after any Python change |

**Examples:**

```
/everything-claude-code:python-patterns write an async context manager for the Modbus connection pool

/everything-claude-code:python-testing add coverage for auto-reset state machine in inverter_engine.py

/everything-claude-code:tdd-workflow implement a new forecast quality dimension: cloud_cover_variance
```

---

## Testing & Verification

| Skill | Use When |
|---|---|
| `everything-claude-code:tdd-workflow` | Write tests before implementing any feature |
| `everything-claude-code:python-testing` | pytest for Python services |
| `everything-claude-code:e2e` | End-to-end test scenarios for UI flows |
| `everything-claude-code:e2e-testing` | Full E2E test suite generation and maintenance |
| `everything-claude-code:verification-loop` | Before tagging any release — build + syntax + lint + tests |

**Examples:**

```
# End-to-end test for the bulk control flow
/everything-claude-code:e2e
test: login → navigate to bulk control → send ON command → verify inverter state updates

# Full verification pass before release
/everything-claude-code:verification-loop
```

---

## Security

| Skill | Use When |
|---|---|
| `everything-claude-code:security-review` | Auth, tokens, API keys, user input, bulk control gate |
| `everything-claude-code:security-scan` | Audit `.claude/` config and workspace for exposed secrets |

**Examples:**

```
# After changing the admin auth flow
/everything-claude-code:security-review server/auth.js

# After adding the bulk control endpoint
/everything-claude-code:security-review server/index.js

# Periodic config audit
/everything-claude-code:security-scan
```

---

## Release & Deployment

| Skill | Use When |
|---|---|
| `everything-claude-code:verification-loop` | Pre-release build + lint + syntax check |
| `everything-claude-code:deployment-patterns` | Installer, Electron auto-update, CI/CD patterns |
| `everything-claude-code:docker-patterns` | If containerizing any service |
| `everything-claude-code:security-scan` | Audit workspace before release |

**Examples:**

```
# Run before bumping version and building release
/everything-claude-code:verification-loop

# Electron auto-update channel configuration reference
/everything-claude-code:deployment-patterns
Electron auto-updater with GitHub releases, pre-release vs stable channels

# Full pre-release sequence:
/everything-claude-code:security-scan
/everything-claude-code:verification-loop
/sub_smoker
/sub_releaser
```

---

## Session & Context Management

| Skill | Shorthand | Use When |
|---|---|---|
| `everything-claude-code:save-session` | — | Checkpoint before a long multi-step task |
| `everything-claude-code:resume-session` | — | Returning to a prior session's context |
| `everything-claude-code:sessions` | — | Browse all saved session history |
| `everything-claude-code:strategic-compact` | — | Context window getting large mid-task |
| `everything-claude-code:context-budget` | — | Audit context window usage broken down by source |
| `everything-claude-code:configure-ecc` | — | Configure ECC settings and behavior |

**Examples:**

```
# Before starting a multi-hour forecast engine rework
/everything-claude-code:save-session

# After a break — reload last checkpoint
/everything-claude-code:resume-session

# Browse all prior sessions (useful after a compaction)
/everything-claude-code:sessions

# Context is getting heavy mid-implementation
/everything-claude-code:strategic-compact

# See what's consuming tokens (skills, memory, conversation)
/everything-claude-code:context-budget
```

---

## Memory Management (`claude-mem` plugin)

| Skill | Use When |
|---|---|
| `claude-mem:mem-search` | Search project memory for relevant past context |
| `claude-mem:smart-explore` | Intelligently explore memory graph for a topic |
| `claude-mem:make-plan` | Generate a plan grounded in accumulated project memory |
| `claude-mem:do` | Execute memory-backed actions directly |
| `claude-mem:timeline-report` | View a chronological report from memory |

**Examples:**

```
# Find what was learned about the Solcast reliability artifact
/claude-mem:mem-search Solcast reliability artifact

# Smart explore the forecast engine memory
/claude-mem:smart-explore forecast engine training pipeline

# Generate a plan informed by project memory
/claude-mem:make-plan add intraday correction to the auto scheduler
```

---

## Learning & Instincts

| Skill | Use When |
|---|---|
| `everything-claude-code:learn-eval` | After a complex session — extract reusable patterns |
| `everything-claude-code:continuous-learning-v2` | Bootstrap or manage the instinct learning system |
| `everything-claude-code:instinct-status` | See what Claude has learned about this project |
| `everything-claude-code:evolve` | Cluster related instincts into skills/commands/agents |
| `everything-claude-code:promote` | Promote a project instinct to global scope |
| `everything-claude-code:instinct-export` | Export instincts for backup or sharing |
| `everything-claude-code:instinct-import` | Import instincts from a file or URL |
| `everything-claude-code:projects` | List all known projects and their instinct counts |
| `everything-claude-code:skill-health` | Skill portfolio health dashboard |
| `everything-claude-code:skill-create` | Create a new project skill from git history patterns |
| `everything-claude-code:rules-distill` | Extract cross-cutting principles from existing skills |

**Examples:**

```
# After a complex session — extract what was learned
/everything-claude-code:learn-eval

# See all instincts for this project + global
/everything-claude-code:instinct-status

# Cluster instincts into a new forecast-patterns skill
/everything-claude-code:evolve

# Export ADSI-specific instincts for backup
/everything-claude-code:instinct-export
```

---

## Orchestration & Autonomous Work

| Skill | Use When |
|---|---|
| `everything-claude-code:orchestrate` | Multi-agent pipeline with dependency tracking |
| `everything-claude-code:autonomous-loops` | Long-running multi-step autonomous tasks |
| `everything-claude-code:prompt-optimize` | Refine prompts for better agent delegation |
| `everything-claude-code:skill-stocktake` | Audit installed skills for relevance and gaps |
| `everything-claude-code:agentic-engineering` | Design and build reliable agentic workflows |
| `everything-claude-code:ai-first-engineering` | Apply AI-first patterns to new features |

**Examples:**

```
# Orchestrate a sub_forecaster → python-review → sub_smoker pipeline
/everything-claude-code:orchestrate
run sub_forecaster to implement seasonal blending, then python-review, then sub_smoker

# Refine a vague forecast engine prompt before delegating
/everything-claude-code:prompt-optimize
"make the forecast better for cloudy days"

# Audit which ECC skills are being used vs installed
/everything-claude-code:skill-stocktake
```

---

## Recommended Workflows

### Starting a New Feature

```
1. /everything-claude-code:blueprint <feature description>
2. Review the plan, refine scope
3. /everything-claude-code:tdd-workflow   (write tests first)
4. Implement (sub_engr / sub_forecaster / sub_fronter as appropriate)
5. /everything-claude-code:python-review  (if Python touched)
6. /everything-claude-code:security-review  (if auth/API touched)
7. /sub_smoker
```

### New UI Feature

```
1. /ui-ux-pro-max:ui-ux-pro-max <describe the component/panel>
2. → implement with sub_fronter
3. /everything-claude-code:simplify
4. /sub_smoker
5. Update User Guide (HTML + MD + PDF)
```

### Pre-Release Checklist

```
1. /everything-claude-code:security-scan
2. /everything-claude-code:verification-loop
3. /sub_smoker
4. /sub_releaser
```

### Debugging a Tricky Bug

```
1. /everything-claude-code:search-first <symptom>
2. → isolate with sub_engr / sub_forecaster / sub_fronter
3. /everything-claude-code:python-review  (if root cause is in Python)
4. /sub_smoker
```

### After a Complex Session

```
1. /everything-claude-code:learn-eval        (extract patterns)
2. /everything-claude-code:instinct-status   (see what was learned)
3. /everything-claude-code:evolve            (cluster into skills if warranted)
```

---

## Project-Specific Agents

These are invoked automatically by Claude based on context, not via `/skill`:

| Agent | Scope |
|---|---|
| `sub_engr` | `services/inverter_engine.py`, Modbus, FastAPI inverter service |
| `sub_forecaster` | `services/forecast_engine.py`, Solcast, ML training, day-ahead |
| `sub_fronter` | `public/js/app.js`, `public/index.html`, `public/css/style.css` |
| `sub_releaser` | Version bumping, EXE rebuild, installer build, GitHub release |
| `sub_smoker` | Post-change validation, smoke test sequencing |

---

## Quick Reference — "Which skill for X?"

| I need to... | Use this |
|---|---|
| Plan a feature | `/everything-claude-code:blueprint <feature>` |
| Design a UI component | `/ui-ux-pro-max:ui-ux-pro-max <description>` |
| Look up pymodbus/electron/sklearn docs | `/everything-claude-code:docs <lib> <topic>` |
| Research with web search (Exa) | `/everything-claude-code:exa-search <topic>` |
| Research Solcast or ML approaches | `/everything-claude-code:deep-research <topic>` |
| Write Python tests | `/everything-claude-code:python-testing` |
| Write tests first (TDD) | `/everything-claude-code:tdd-workflow` |
| E2E test a UI flow | `/everything-claude-code:e2e <scenario>` |
| Review Python code quality | `/everything-claude-code:python-review` |
| Deep quality audit | `/everything-claude-code:plankton-code-quality <file>` |
| Review Express/Node security | `/everything-claude-code:security-review <file>` |
| Scan workspace for secrets | `/everything-claude-code:security-scan` |
| Design a REST endpoint | `/everything-claude-code:api-design` |
| Design Express middleware | `/everything-claude-code:backend-patterns` |
| Improve dashboard JS | `/everything-claude-code:frontend-patterns` |
| Clean up messy code | `/everything-claude-code:simplify` |
| Plan a DB schema change | `/everything-claude-code:database-migrations` |
| Work on cloud DB queries | `/everything-claude-code:postgres-patterns` |
| Run final verification | `/everything-claude-code:verification-loop` |
| Check context window | `/everything-claude-code:context-budget` |
| Save session checkpoint | `/everything-claude-code:save-session` |
| Return to prior session | `/everything-claude-code:resume-session` |
| Browse session history | `/everything-claude-code:sessions` |
| Search project memory | `/claude-mem:mem-search <topic>` |
| Extract session learnings | `/everything-claude-code:learn-eval` |
| See what Claude learned | `/everything-claude-code:instinct-status` |
| Promote instinct to global | `/everything-claude-code:promote` |
| Health check skills | `/everything-claude-code:skill-health` |
| Optimize a prompt | `/everything-claude-code:prompt-optimize` |
| Document an arch decision | `/everything-claude-code:architecture-decision-records` |
| MCP server patterns | `/everything-claude-code:mcp-server-patterns` |

---

## Guide Index

| Guide | Content |
|---|---|
| `ECC-GUIDE.md` | This file — skill index with examples |
| `ECC-SKILLS-CATALOG.md` | All skills rated for ADSI relevance |
| `ECC-TASK-MATRIX.md` | "What am I doing?" → exact skill sequence |
| `ECC-WORKFLOWS.md` | Copy-paste command sequences for common tasks |
