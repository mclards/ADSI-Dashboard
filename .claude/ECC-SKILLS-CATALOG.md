# ECC Skills Catalog — ADSI Dashboard Relevance Ratings

ECC v1.8.0 + `ui-ux-pro-max` v2.5.0 + `claude-mem` v10.6.3 + `skill-creator`

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
| `everything-claude-code:planner` | ✅ | Complex multi-file refactors with ordered task list |
| `everything-claude-code:architecture-decision-records` | ⚠️ | Document big decisions (cloud DB, Solcast tier, auth design) |
| `everything-claude-code:codebase-onboarding` | ⚠️ | Fast codebase overview for new developer or re-orientation |
| `everything-claude-code:project-guidelines-example` | ⚠️ | Derive project-level guidelines from observed patterns |

---

## Code Review & Quality

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:python-review` | ✅ | After any `forecast_engine.py` or `inverter_engine.py` edit |
| `everything-claude-code:security-review` | ✅ | After auth, API, bulk control, or token changes |
| `everything-claude-code:plankton-code-quality` | ✅ | Multi-lens quality review — complexity, coupling, tech debt |
| `everything-claude-code:simplify` | ✅ | Post-implementation cleanup of Node.js routes, CSS, Python |
| `everything-claude-code:coding-standards` | ⚠️ | Reference when unsure about style conventions for a new module |
| `everything-claude-code:tdd` | ✅ | TDD cycle — shorthand `/tdd` |
| `everything-claude-code:tdd-workflow` | ✅ | Full TDD workflow before implementing a feature |
| `everything-claude-code:rules-distill` | ⚠️ | Extract cross-cutting principles from existing skills |

---

## UI / Frontend

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `ui-ux-pro-max:ui-ux-pro-max` | ✅ | Design inverter cards, panels, sidebars, themes, modals |
| `everything-claude-code:frontend-patterns` | ✅ | Dashboard JS patterns, chart updates, card rendering, WS subscriptions |
| `everything-claude-code:frontend-slides` | ❌ | Presentation slides — no use case here |
| `everything-claude-code:nuxt4-patterns` | ❌ | No Nuxt — plain HTML/JS frontend |
| `everything-claude-code:nextjs-turbopack` | ❌ | No Next.js |

---

## Python

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:python-patterns` | ✅ | Idiomatic Python for new modules in forecast/inverter engine |
| `everything-claude-code:python-testing` | ✅ | pytest coverage for inverter or forecast engine |
| `everything-claude-code:pytorch-patterns` | ❌ | No PyTorch — uses LightGBM / scikit-learn |
| `everything-claude-code:django-patterns` | ❌ | No Django — uses FastAPI (Python) + Express (Node) |
| `everything-claude-code:django-tdd` | ❌ | — |
| `everything-claude-code:django-security` | ❌ | — |
| `everything-claude-code:django-verification` | ❌ | — |

---

## JavaScript / Node.js

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:backend-patterns` | ✅ | Express route design, middleware, async job queues, WS patterns |
| `everything-claude-code:api-design` | ✅ | Designing new REST endpoints — resource naming, error shapes |
| `everything-claude-code:mcp-server-patterns` | ⚠️ | MCP server integrations (Neon, Context7, claude-mem wiring) |
| `everything-claude-code:bun-runtime` | ❌ | Uses npm/Node, not Bun |

---

## Database

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:postgres-patterns` | ✅ | Cloud DB (Supabase/Neon) queries in `server/cloudDb.js` |
| `everything-claude-code:database-migrations` | ⚠️ | SQLite schema changes — patterns transfer from PG reference |
| `everything-claude-code:clickhouse-io` | ❌ | Uses SQLite hot DB + PostgreSQL cloud, not ClickHouse |

---

## Security

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:security-review` | ✅ | Auth endpoints, bulk control gate, token handling, UUID validation |
| `everything-claude-code:security-scan` | ✅ | Periodic audit of `.claude/` config and workspace |

---

## Testing & Verification

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:tdd-workflow` | ✅ | Full TDD cycle for Python and Node features |
| `everything-claude-code:python-testing` | ✅ | pytest for inverter/forecast engine |
| `everything-claude-code:e2e` | ✅ | End-to-end test scenarios for UI flows and API calls |
| `everything-claude-code:e2e-testing` | ✅ | Full E2E test suite generation with Playwright |
| `everything-claude-code:verification-loop` | ✅ | Pre-release build + syntax + lint + test checkpoint |
| `everything-claude-code:ai-regression-testing` | ⚠️ | Regression test harness for AI-generated outputs (forecast quality) |

---

## Research & Documentation

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:docs` | ✅ | pymodbus, better-sqlite3, electron-updater, scikit-learn, LightGBM |
| `everything-claude-code:documentation-lookup` | ✅ | Alt to `docs` — Context7 MCP for richer results |
| `everything-claude-code:exa-search` | ✅ | Exa-powered web search for technical research (ML, Solcast, Modbus) |
| `everything-claude-code:deep-research` | ✅ | Multi-source research (Solcast, ML approaches, Modbus protocols) |
| `everything-claude-code:search-first` | ✅ | Before implementing any non-trivial algorithm |
| `everything-claude-code:iterative-retrieval` | ⚠️ | Progressive narrowing when initial search is insufficient |

---

## Release / Deployment

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:verification-loop` | ✅ | Pre-release verification checkpoint |
| `everything-claude-code:deployment-patterns` | ⚠️ | Reference for installer / Electron auto-update patterns |
| `everything-claude-code:docker-patterns` | ⚠️ | If any future containerization of Node or Python service |

---

## Session & Context

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:save-session` | ✅ | Checkpoint before long multi-step tasks |
| `everything-claude-code:resume-session` | ✅ | Return to a prior session |
| `everything-claude-code:sessions` | ✅ | Browse all saved session history |
| `everything-claude-code:strategic-compact` | ✅ | Compress context mid-task when window is getting large |
| `everything-claude-code:context-budget` | ✅ | Audit context window usage by source |
| `everything-claude-code:configure-ecc` | ✅ | Configure ECC behavior and settings per project |

---

## Memory Management (`claude-mem` plugin)

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `claude-mem:mem-search` | ✅ | Find past context on forecast engine, Solcast, auth decisions |
| `claude-mem:smart-explore` | ✅ | Explore memory graph for a topic before deep work |
| `claude-mem:make-plan` | ✅ | Plan grounded in accumulated project memory |
| `claude-mem:do` | ✅ | Execute memory-backed actions |
| `claude-mem:timeline-report` | ⚠️ | Chronological audit of project decisions |

---

## Learning & Instincts

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:learn-eval` | ✅ | Extract reusable patterns after complex sessions |
| `everything-claude-code:continuous-learning-v2` | ✅ | Instinct-based learning — bootstrap, configure, manage |
| `everything-claude-code:continuous-learning` | ⚠️ | Basic learning variant (use v2 instead) |
| `everything-claude-code:instinct-status` | ✅ | See what Claude has learned about this project |
| `everything-claude-code:evolve` | ✅ | Cluster related instincts into skills, commands, or agents |
| `everything-claude-code:promote` | ⚠️ | Promote project instinct to global when seen across projects |
| `everything-claude-code:instinct-export` | ⚠️ | Export instincts to file for backup or sharing |
| `everything-claude-code:instinct-import` | ⚠️ | Import instincts from a file or URL |
| `everything-claude-code:projects` | ✅ | List all known projects and their instinct counts |
| `everything-claude-code:skill-health` | ✅ | Skill portfolio health dashboard |
| `everything-claude-code:skill-create` | ⚠️ | Create a new project-specific skill from local git history |
| `everything-claude-code:rules-distill` | ⚠️ | Extract cross-cutting principles into a condensed reference |

---

## Orchestration / Agents

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:orchestrate` | ✅ | Multi-agent pipelines (sub_forecaster → review → smoke) |
| `everything-claude-code:autonomous-loops` | ⚠️ | Long-running multi-step autonomous tasks with checkpoints |
| `everything-claude-code:agentic-engineering` | ⚠️ | Design reliable agentic workflows for complex ADSI tasks |
| `everything-claude-code:ai-first-engineering` | ⚠️ | Apply AI-first patterns to new feature development |
| `everything-claude-code:enterprise-agent-ops` | ❌ | Enterprise multi-team agent orchestration — overkill here |
| `everything-claude-code:claude-devfleet` | ❌ | tmux multi-terminal fleet — not needed here |
| `everything-claude-code:devfleet` | ❌ | — |
| `everything-claude-code:dmux-workflows` | ❌ | — |

---

## Prompting & Skills

| Skill | Rating | ADSI Use Case |
|---|---|---|
| `everything-claude-code:prompt-optimize` | ⚠️ | Refine prompts for better sub_forecaster / sub_engr delegation |
| `everything-claude-code:prompt-optimizer` | ⚠️ | Alt version of above |
| `everything-claude-code:skill-stocktake` | ⚠️ | Audit skills for relevance and gaps |
| `skill-creator:skill-creator` | ⚠️ | Create new skills from scratch |

---

## Not Applicable to This Project

| Category | Skills |
|---|---|
| Mobile (iOS/Android/KMP) | `swiftui-patterns`, `swift-concurrency-6-2`, `swift-actor-persistence`, `swift-protocol-di-testing`, `kotlin-patterns`, `kotlin-coroutines-flows`, `kotlin-exposed-patterns`, `kotlin-ktor-patterns`, `compose-multiplatform-patterns`, `android-clean-architecture`, `flutter-dart-code-review` |
| Java / Spring | `springboot-patterns`, `springboot-security`, `springboot-tdd`, `springboot-verification`, `jpa-patterns`, `java-coding-standards` |
| PHP / Laravel / Perl | `laravel-patterns`, `laravel-security`, `laravel-tdd`, `perl-patterns`, `perl-security`, `perl-testing` |
| Rust / C++ / Go | `rust-patterns`, `rust-testing`, `cpp-coding-standards`, `cpp-testing`, `golang-patterns`, `golang-testing` |
| Unrelated domains | `logistics-exception-management`, `customs-trade-compliance`, `carrier-relationship-management`, `inventory-demand-planning`, `production-scheduling`, `quality-nonconformance`, `returns-reverse-logistics`, `energy-procurement` |
| Media / Social / Content | `fal-ai-media`, `videodb`, `x-api`, `crosspost`, `video-editing`, `content-engine`, `article-writing`, `investor-materials`, `investor-outreach`, `market-research` |
| Other | `liquid-glass-design`, `visa-doc-translate`, `nanoclaw-repl`, `nutrient-document-processing`, `foundation-models-on-device`, `data-scraper-agent`, `ralphinho-rfc-pipeline` |

---

## Quick Reference: "Which skill for X?"

| I need to... | Use this skill |
|---|---|
| Plan a feature | `plan` or `blueprint` |
| Design a UI component | `ui-ux-pro-max:ui-ux-pro-max` |
| Look up pymodbus/electron/sklearn docs | `docs` or `documentation-lookup` |
| Web search for research | `exa-search` |
| Research Solcast or ML approaches | `deep-research` |
| Write Python tests | `python-testing` |
| Write tests first | `tdd` or `tdd-workflow` |
| E2E test a UI flow | `e2e` |
| Review Python code quality | `python-review` |
| Deep quality audit | `plankton-code-quality` |
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
| Search project memory | `claude-mem:mem-search` |
| Extract session learnings | `learn-eval` |
| See what Claude learned | `instinct-status` |
| Cluster instincts into skill | `evolve` |
| Promote instinct to global | `promote` |
| Check skill portfolio health | `skill-health` |
| Document arch decision | `architecture-decision-records` |
| Optimize a delegation prompt | `prompt-optimize` |
| MCP server work | `mcp-server-patterns` |
