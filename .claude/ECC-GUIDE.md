# Everything Claude Code (ECC) — Usage Guide for ADSI Dashboard

Source: [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)

ECC skills expand into detailed prompt instructions that shape how Claude approaches a task.
They are invoked inline — no extra tooling needed. The marketplace is already wired into
`.claude/settings.json` so all skills are available in every Claude Code session.

---

## How to Invoke

```
/everything-claude-code:<skill-name>
```

Or use the short alias where one is registered (e.g. `/plan`, `/tdd`).
Append your task description after the skill name on the same line.

---

## Skills Most Relevant to This Project

### Planning & Architecture

| Skill | Shorthand | Use When |
|---|---|---|
| `everything-claude-code:plan` | `/plan` | Starting any non-trivial feature or fix — gets a structured plan |
| `everything-claude-code:blueprint` | — | Turning a one-liner into a step-by-step multi-PR plan |
| `everything-claude-code:planner` | — | Complex refactors spanning many files; generates ordered task list |
| `everything-claude-code:architecture-decision-records` | — | Documenting a major architectural decision (e.g. adding cloud DB, switching providers) |
| `everything-claude-code:codebase-onboarding` | — | When a new developer (or you in a new session) needs a fast codebase overview |

**Examples:**

```
/everything-claude-code:plan add per-inverter export limit enforcement to the energy authority

/everything-claude-code:blueprint rework intraday adjuster to use season-aware bias correction

/everything-claude-code:planner refactor forecast engine so all four generation paths share a single audit writer

/everything-claude-code:architecture-decision-records
Document: switching from raw SQLite WAL to cloud-sync hybrid for audit trail

/everything-claude-code:codebase-onboarding
give an overview of how the forecast engine communicates with the Node server
```

---

### Code Review

| Skill | Shorthand | Use When |
|---|---|---|
| `everything-claude-code:python-review` | — | After editing any Python service file (forecast_engine.py, inverter_engine.py) |
| `everything-claude-code:security-review` | — | After auth changes, new API endpoints, bulk control, or token handling |
| `everything-claude-code:tdd` | `/tdd` | Before writing new logic — forces RED-GREEN-REFACTOR discipline |
| `everything-claude-code:tdd-workflow` | — | Full TDD cycle including scaffold + coverage check |
| `everything-claude-code:coding-standards` | — | When unsure about style conventions for a new module |

**Examples:**

```
# After modifying services/inverter_engine.py
/everything-claude-code:python-review

# After adding a new Express route to server/index.js
/everything-claude-code:security-review server/index.js

# Before implementing a new forecast quality classifier
/everything-claude-code:tdd

# Full TDD workflow for a new Python function
/everything-claude-code:tdd-workflow
implement lookup_solcast_tod_reliability() with morning/midday/afternoon fallback chain
```

---

### Code Cleanup & Style

| Skill | Use When |
|---|---|
| `everything-claude-code:simplify` | After implementing — remove duplication, dead code, over-engineering |
| `everything-claude-code:coding-standards` | Reference for naming, error handling, and comment conventions |
| `everything-claude-code:rules-distill` | Extract cross-cutting principles from multiple skills into one reference |

**Examples:**

```
# After a long UI implementation pass
/everything-claude-code:simplify

# Check what style patterns ECC has for this project
/everything-claude-code:rules-distill

# Before a PR — clean up server/index.js routes section
/everything-claude-code:simplify server/index.js
```

---

### Node.js / Backend / Frontend

| Skill | Use When |
|---|---|
| `everything-claude-code:backend-patterns` | Designing Express middleware, WebSocket handlers, async job queues |
| `everything-claude-code:frontend-patterns` | Dashboard JS — chart rendering, card updates, WS subscriptions |
| `everything-claude-code:api-design` | Designing new REST endpoints — resource naming, error shapes, versioning |

**Examples:**

```
# Before adding a new API endpoint for alarm history
/everything-claude-code:api-design
design GET /api/alarms/history with filtering by inverter, severity, date range

# Designing a new background job pattern (like the forecast generation job queue)
/everything-claude-code:backend-patterns
async job queue with status polling for long-running Python calls

# Improving how inverter cards subscribe to live WS data
/everything-claude-code:frontend-patterns
WebSocket subscription lifecycle for 27 inverter cards with partial updates
```

---

### Database

| Skill | Use When |
|---|---|
| `everything-claude-code:postgres-patterns` | Cloud DB (Supabase/Neon) queries in server/cloudDb.js |
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

### Research & Documentation Lookup

| Skill | Shorthand | Use When |
|---|---|---|
| `everything-claude-code:docs` | `/docs` | Need current API docs for a specific library method |
| `everything-claude-code:documentation-lookup` | — | Alt to `docs` — uses Context7 MCP for richer results |
| `everything-claude-code:search-first` | — | Before implementing — find prior art or existing libraries first |
| `everything-claude-code:deep-research` | — | Multi-source research on a technical topic (Solcast, ML, Modbus) |
| `everything-claude-code:iterative-retrieval` | — | When one search round isn't enough — progressively narrows context |

**Examples:**

```
/everything-claude-code:docs pymodbus async ModbusTcpClient

/everything-claude-code:docs electron auto-updater differential updates

/everything-claude-code:documentation-lookup
better-sqlite3 WAL mode checkpoint, pragma settings, write performance

/everything-claude-code:search-first best approach for SQLite WAL checkpoint on Windows

/everything-claude-code:deep-research Solcast API rooftop vs advanced hobbyist accuracy comparison

# When initial docs search is incomplete:
/everything-claude-code:iterative-retrieval
scikit-learn GradientBoostingRegressor partial_fit incremental training options
```

---

### Release & Verification

| Skill | Use When |
|---|---|
| `everything-claude-code:verification-loop` | Before tagging any release — build + syntax + lint + tests |
| `everything-claude-code:security-scan` | Periodic audit of `.claude/` config and workspace for exposed secrets |
| `everything-claude-code:context-budget` | Session feels sluggish or context-heavy — audit token consumption |
| `everything-claude-code:deployment-patterns` | Reference for installer patterns, Electron auto-update, CI/CD |

**Examples:**

```
# Run before bumping version and building release
/everything-claude-code:verification-loop

# Audit the .claude/ folder for API keys or secrets before a PR
/everything-claude-code:security-scan

# Check how much context is being consumed across agents
/everything-claude-code:context-budget

# Reference for auto-update channel configuration
/everything-claude-code:deployment-patterns
Electron auto-updater with GitHub releases, pre-release vs stable channels
```

---

### Python-Specific

| Skill | Use When |
|---|---|
| `everything-claude-code:python-patterns` | Unsure about idiomatic Python for a new module |
| `everything-claude-code:python-testing` | Writing pytest tests for inverter engine or forecast engine |
| `everything-claude-code:tdd-workflow` | TDD cycle for any Python or Node feature |

**Examples:**

```
/everything-claude-code:python-patterns write an async context manager for the Modbus connection pool

/everything-claude-code:python-testing add coverage for auto-reset state machine in inverter_engine.py

/everything-claude-code:tdd-workflow implement a new forecast quality dimension: cloud_cover_variance
```

---

### Security

| Skill | Use When |
|---|---|
| `everything-claude-code:security-review` | Any change touching auth, tokens, API keys, user input |
| `everything-claude-code:security-scan` | Audit the full `.claude/` config for exposed secrets |

**Examples:**

```
# After changing the admin auth flow
/everything-claude-code:security-review server/auth.js

# Periodic config audit
/everything-claude-code:security-scan

# After adding the bulk control endpoint
/everything-claude-code:security-review server/index.js
# (checks UUID validation, auth gate, rate limiting)
```

---

### Session & Context Management

| Skill | Use When |
|---|---|
| `everything-claude-code:save-session` | Checkpoint before a long multi-step task |
| `everything-claude-code:resume-session` | Returning to a prior session's context |
| `everything-claude-code:sessions` | Browse all saved session history, switch between them |
| `everything-claude-code:strategic-compact` | Context window is getting large mid-task |
| `everything-claude-code:context-budget` | Audit context window usage broken down by source |

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

### Learning & Instincts

| Skill | Use When |
|---|---|
| `everything-claude-code:learn-eval` | After a complex session — extract reusable patterns |
| `everything-claude-code:continuous-learning-v2` | Bootstrap or manage the instinct learning system |
| `everything-claude-code:instinct-status` | See what Claude has learned about this project |
| `everything-claude-code:evolve` | Cluster related instincts into skills/commands/agents |
| `everything-claude-code:promote` | Promote a project instinct to global scope |
| `everything-claude-code:instinct-export` | Export instincts to a file for backup or sharing |
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

# See instinct counts across all projects
/everything-claude-code:projects

# Promote the "delegate-forecast-to-sub-forecaster" instinct to global
/everything-claude-code:promote delegate-forecast-to-sub-forecaster

# Cluster instincts into a new forecast-patterns skill
/everything-claude-code:evolve

# Health check on all installed skills
/everything-claude-code:skill-health

# Export ADSI-specific instincts for backup
/everything-claude-code:instinct-export
```

---

### Orchestration & Advanced

| Skill | Use When |
|---|---|
| `everything-claude-code:orchestrate` | Running multiple sub-agents in sequence with dependency tracking |
| `everything-claude-code:autonomous-loops` | Long-running multi-step autonomous tasks (e.g. a 10-step refactor) |
| `everything-claude-code:prompt-optimize` | Refine a prompt for better agent delegation results |
| `everything-claude-code:skill-stocktake` | Audit installed ECC skills for relevance and gaps |

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
4. Implement
5. /everything-claude-code:python-review  (if Python touched)
6. /everything-claude-code:security-review  (if auth/API touched)
7. /sub_smoker                            (run project smoke tests)
```

### Pre-Release Checklist

```
1. /everything-claude-code:verification-loop
2. /sub_smoker
3. /sub_releaser  (bump version, build, publish)
```

### Debugging a Tricky Bug

```
1. /everything-claude-code:search-first <symptom description>
2. Narrow to files with sub_engr / sub_forecaster / sub_fronter
3. /everything-claude-code:python-review  (if root cause is in Python)
```

### After a Complex Session

```
1. /everything-claude-code:learn-eval        (extract patterns)
2. /everything-claude-code:instinct-status   (see what was learned)
3. /everything-claude-code:evolve            (cluster into skills if warranted)
```

---

## Project-Specific Agents (not ECC — built into this repo)

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
| Look up pymodbus/electron/sklearn docs | `/everything-claude-code:docs <lib> <topic>` |
| Research Solcast or ML approaches | `/everything-claude-code:deep-research <topic>` |
| Write Python tests | `/everything-claude-code:python-testing` |
| Write tests first (TDD) | `/everything-claude-code:tdd-workflow` |
| Review Python code quality | `/everything-claude-code:python-review` |
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
| Extract session learnings | `/everything-claude-code:learn-eval` |
| See what Claude learned | `/everything-claude-code:instinct-status` |
| Promote instinct to global | `/everything-claude-code:promote` |
| Health check skills | `/everything-claude-code:skill-health` |
| Optimize a prompt | `/everything-claude-code:prompt-optimize` |
| Document an arch decision | `/everything-claude-code:architecture-decision-records` |

---

## Full Skill Catalog

All available skills: `https://github.com/affaan-m/everything-claude-code`

For ratings specific to this project, see `ECC-SKILLS-CATALOG.md`.
For task-to-skill mapping, see `ECC-TASK-MATRIX.md`.
For copy-paste command sequences, see `ECC-WORKFLOWS.md`.
