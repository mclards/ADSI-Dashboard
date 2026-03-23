# ECC Skills Catalog — ADSI Dashboard Relevance Ratings

Legend:
- ✅ Relevant — useful for this project regularly
- ⚠️ Situational — useful in specific scenarios
- ❌ Not applicable — unrelated tech stack or domain

---

## Planning & Architecture

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:plan` | ✅ | Any feature planning — shorthand `/plan` |
| `everything-claude-code:blueprint` | ✅ | Turn a one-liner into a step-by-step multi-PR plan |
| `everything-claude-code:planner` | ✅ | Complex multi-file refactors |
| `everything-claude-code:architecture-decision-records` | ⚠️ | Document big architectural decisions (e.g. adding cloud DB, switching Solcast tier) |
| `everything-claude-code:codebase-onboarding` | ⚠️ | Useful when onboarding a new developer, or re-orienting after a long break |

---

## Code Review

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:python-review` | ✅ | After any `forecast_engine.py` or `inverter_engine.py` edit |
| `everything-claude-code:security-review` | ✅ | After auth, API, bulk control, or token changes |
| `everything-claude-code:simplify` | ✅ | Post-implementation cleanup of Node.js routes or CSS |
| `everything-claude-code:coding-standards` | ⚠️ | Reference when unsure about style conventions for a new module |
| `everything-claude-code:tdd` | ✅ | TDD cycle — shorthand `/tdd` |
| `everything-claude-code:tdd-workflow` | ✅ | Full TDD workflow before implementing a feature |
| `everything-claude-code:rules-distill` | ⚠️ | Extract cross-cutting principles from existing skills into one guide |

---

## Python

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:python-patterns` | ✅ | Idiomatic Python for new modules in forecast/inverter engine |
| `everything-claude-code:python-testing` | ✅ | pytest coverage for inverter or forecast engine |
| `everything-claude-code:pytorch-patterns` | ❌ | No PyTorch used — uses scikit-learn GradientBoosting |
| `everything-claude-code:django-patterns` | ❌ | No Django — uses FastAPI (Python) + Express (Node) |
| `everything-claude-code:django-tdd` | ❌ | — |
| `everything-claude-code:django-security` | ❌ | — |
| `everything-claude-code:django-verification` | ❌ | — |

---

## JavaScript / Node.js

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:backend-patterns` | ✅ | Express route design, middleware, async job queues, WS patterns |
| `everything-claude-code:frontend-patterns` | ✅ | Dashboard JS patterns, chart updates, card rendering, WS subscriptions |
| `everything-claude-code:api-design` | ✅ | Designing new REST endpoints in server/index.js — resource naming, error shapes |
| `everything-claude-code:bun-runtime` | ❌ | Uses npm/Node, not Bun |
| `everything-claude-code:nuxt4-patterns` | ❌ | No Nuxt — plain HTML/JS frontend |
| `everything-claude-code:nextjs-turbopack` | ❌ | — |

---

## Database

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:postgres-patterns` | ✅ | Cloud DB (Supabase/Neon) queries in server/cloudDb.js |
| `everything-claude-code:database-migrations` | ⚠️ | SQLite schema changes — patterns transfer even if not PG |
| `everything-claude-code:clickhouse-io` | ❌ | Uses SQLite hot DB, not ClickHouse |

---

## Security

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:security-review` | ✅ | Auth endpoints, bulk control gate, token handling, UUID validation |
| `everything-claude-code:security-scan` | ✅ | Periodic audit of `.claude/` config and workspace |

---

## Research & Documentation

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:docs` | ✅ | pymodbus, better-sqlite3, electron-updater, scikit-learn |
| `everything-claude-code:documentation-lookup` | ✅ | Alt to `docs` — uses Context7 MCP for richer, up-to-date results |
| `everything-claude-code:search-first` | ✅ | Before implementing any non-trivial algorithm |
| `everything-claude-code:deep-research` | ✅ | Multi-source research (Solcast, ML approaches, Modbus protocols) |
| `everything-claude-code:iterative-retrieval` | ⚠️ | When a single search isn't enough — iterative narrowing across cycles |

---

## Session & Context

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:save-session` | ✅ | Checkpoint before long multi-step tasks |
| `everything-claude-code:resume-session` | ✅ | Return to a prior session |
| `everything-claude-code:sessions` | ✅ | Browse all saved session history |
| `everything-claude-code:strategic-compact` | ✅ | Compress context mid-task when window is getting large |
| `everything-claude-code:context-budget` | ✅ | Audit context window usage by source (skills, memory, conversation) |

---

## Learning & Instincts

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:learn-eval` | ✅ | Extract reusable patterns after complex sessions |
| `everything-claude-code:continuous-learning-v2` | ✅ | Instinct-based learning — bootstrap, configure, manage learning system |
| `everything-claude-code:instinct-status` | ✅ | See what Claude has learned about this project (project + global) |
| `everything-claude-code:evolve` | ✅ | Cluster related instincts into skills, commands, or agents |
| `everything-claude-code:promote` | ⚠️ | Promote a project instinct to global scope when seen in multiple projects |
| `everything-claude-code:instinct-export` | ⚠️ | Export instincts to file for backup or sharing |
| `everything-claude-code:instinct-import` | ⚠️ | Import instincts from a file or URL |
| `everything-claude-code:projects` | ✅ | List all known projects and their instinct counts |
| `everything-claude-code:skill-health` | ✅ | Skill portfolio health dashboard — what's installed, used, stale |
| `everything-claude-code:skill-create` | ⚠️ | Create a new project-specific skill from local git history |
| `everything-claude-code:rules-distill` | ⚠️ | Extract cross-cutting principles from skills into one condensed reference |

---

## Release / Verification

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:verification-loop` | ✅ | Pre-release verification checkpoint (syntax + lint + tests) |
| `everything-claude-code:deployment-patterns` | ⚠️ | Reference for installer / Electron auto-update patterns |

---

## Orchestration / Agents

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:orchestrate` | ⚠️ | Running multiple agents in sequence with dependency tracking |
| `everything-claude-code:autonomous-loops` | ⚠️ | Long-running multi-step autonomous tasks with checkpoints |
| `everything-claude-code:devfleet` | ❌ | tmux-based multi-agent — not needed here |
| `everything-claude-code:dmux-workflows` | ❌ | — |

---

## Prompting & Skills

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:prompt-optimize` | ⚠️ | Refine prompts for better agent delegation (e.g. sub_forecaster tasks) |
| `everything-claude-code:prompt-optimizer` | ⚠️ | Alt version of above |
| `everything-claude-code:skill-stocktake` | ⚠️ | Audit Claude skills for relevance and gaps |

---

## Not Applicable to This Project

The following skill groups are not applicable to the ADSI Dashboard tech stack:

| Category | Skills |
|---|---|
| Mobile (iOS/Android) | `swiftui-patterns`, `swift-concurrency-6-2`, `swift-actor-persistence`, `swift-protocol-di-testing`, `kotlin-patterns`, `kotlin-coroutines-flows`, `kotlin-exposed-patterns`, `kotlin-ktor-patterns`, `compose-multiplatform-patterns`, `android-clean-architecture`, `flutter-dart-code-review` |
| Java / Spring | `springboot-patterns`, `springboot-security`, `springboot-tdd`, `springboot-verification`, `jpa-patterns`, `java-coding-standards` |
| PHP / Laravel / Perl | `laravel-patterns`, `laravel-security`, `laravel-tdd`, `perl-patterns`, `perl-security`, `perl-testing` |
| Rust / C++ / Go | `rust-patterns`, `rust-testing`, `cpp-coding-standards`, `cpp-testing`, `golang-patterns`, `golang-testing` |
| Unrelated domains | `logistics-exception-management`, `customs-trade-compliance`, `carrier-relationship-management`, `inventory-demand-planning`, `production-scheduling`, `quality-nonconformance`, `returns-reverse-logistics`, `energy-procurement` |
| Media / Social | `fal-ai-media`, `videodb`, `x-api`, `crosspost`, `video-editing`, `content-engine` |
| Other | `liquid-glass-design`, `visa-doc-translate`, `nanoclaw-repl`, `nutrient-document-processing` |

---

## Quick: "Which skill for X?"

| I need to... | Use this skill |
|---|---|
| Plan a feature | `plan` or `blueprint` |
| Look up pymodbus/electron/sklearn docs | `docs` or `documentation-lookup` |
| Research Solcast or ML approaches | `deep-research` |
| Write Python tests | `python-testing` |
| Write tests first | `tdd` or `tdd-workflow` |
| Review Python code quality | `python-review` |
| Review Express/Node security | `security-review` |
| Scan workspace for secrets | `security-scan` |
| Design a REST endpoint | `api-design` |
| Design Express middleware/jobs | `backend-patterns` |
| Improve dashboard JS/cards | `frontend-patterns` |
| Clean up messy code | `simplify` |
| Plan a DB schema change | `database-migrations` |
| Work on cloud DB queries | `postgres-patterns` |
| Run final verification | `verification-loop` |
| Check context window | `context-budget` |
| Save session checkpoint | `save-session` |
| Return to prior session | `resume-session` |
| Browse session history | `sessions` |
| Extract session learnings | `learn-eval` |
| See what Claude learned | `instinct-status` |
| Promote instinct to global | `promote` |
| Cluster instincts into skill | `evolve` |
| Health check skill portfolio | `skill-health` |
| Document arch decision | `architecture-decision-records` |
| Optimize a delegation prompt | `prompt-optimize` |
