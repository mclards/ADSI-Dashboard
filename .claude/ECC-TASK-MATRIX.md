# ECC Task Matrix — ADSI Dashboard

"What am I about to do?" → exact skills to invoke, in order.

---

## New Feature

### New Feature — Forecast Engine (Python)
```
1. /everything-claude-code:blueprint <feature>
2. /everything-claude-code:search-first <topic>        (prior art / library options)
3. /everything-claude-code:tdd-workflow                (write tests first)
4. → implement with sub_forecaster
5. /everything-claude-code:python-review
6. /everything-claude-code:verification-loop
7. /sub_smoker
```

### New Feature — Inverter Engine (Python / Modbus)
```
1. /everything-claude-code:blueprint <feature>
2. /everything-claude-code:docs pymodbus <topic>       (if Modbus API involved)
3. /everything-claude-code:tdd-workflow
4. → implement with sub_engr
5. /everything-claude-code:python-review
6. /sub_smoker
```

### New Feature — Server / API (Node.js / Express)
```
1. /everything-claude-code:plan <feature>
2. /everything-claude-code:api-design                  (route/schema design)
3. /everything-claude-code:backend-patterns            (async patterns, middleware)
4. /everything-claude-code:tdd-workflow
5. → implement
6. /everything-claude-code:security-review server/     (if auth/input handling)
7. /sub_smoker
```

### New Feature — UI / Dashboard (HTML/CSS/JS)
```
1. /everything-claude-code:blueprint <feature>
2. /everything-claude-code:frontend-patterns           (card/chart/WS patterns)
3. → implement with sub_fronter
4. /everything-claude-code:simplify                    (cleanup after implementation)
5. /sub_smoker
```

### New Feature — Cloud DB / PostgreSQL
```
1. /everything-claude-code:plan <feature>
2. /everything-claude-code:postgres-patterns           (query / schema design)
3. → implement in server/cloudDb.js
4. /everything-claude-code:security-review             (if query takes user input)
5. /sub_smoker
```

---

## Bug Fix

### Bug Fix — Inverter / Modbus
```
1. /everything-claude-code:search-first <symptom>
2. → isolate with sub_engr
3. /everything-claude-code:python-review               (confirm fix is clean)
4. /sub_smoker
```

### Bug Fix — Forecast Engine / ML
```
1. /everything-claude-code:search-first <symptom>
2. → isolate with sub_forecaster
3. /everything-claude-code:python-review
4. /sub_smoker
```

### Bug Fix — UI
```
1. → isolate with sub_fronter
2. /everything-claude-code:simplify                    (if surrounding code messy)
3. /sub_smoker
```

### Bug Fix — Node.js Server
```
1. /everything-claude-code:search-first <symptom>
2. → fix
3. /everything-claude-code:security-review             (if auth-adjacent)
4. /sub_smoker
```

---

## Forecast Engine Changes

### Tune ML Model / Error Memory / Solcast Reliability
```
1. /everything-claude-code:deep-research <topic>
2. /everything-claude-code:python-patterns             (idiomatic approach)
3. /everything-claude-code:tdd-workflow
4. → implement with sub_forecaster
5. /everything-claude-code:python-review
6. /sub_smoker
```

### Update Day-Ahead Generation / Audit Logic
```
1. /everything-claude-code:blueprint <change>
2. → implement with sub_forecaster
3. /everything-claude-code:python-review
4. /everything-claude-code:verification-loop
5. /sub_smoker
```

---

## Release

### Publish a Release
```
1. /everything-claude-code:verification-loop
2. /sub_smoker
3. /sub_releaser
```

### Pre-Release Audit Only
```
1. /everything-claude-code:security-scan
2. /everything-claude-code:verification-loop
3. /sub_smoker
```

---

## Database / Schema

### SQLite Schema Change
```
1. /everything-claude-code:plan <schema change>
2. /everything-claude-code:database-migrations         (migration strategy)
3. → implement
4. /sub_smoker
```

### Cloud DB / PostgreSQL Query Work
```
1. /everything-claude-code:postgres-patterns
2. → implement in server/cloudDb.js
3. /everything-claude-code:security-review             (if query takes user input)
```

---

## Research / Investigation

### Technical Research Spike
```
1. /everything-claude-code:deep-research <topic>
2. /everything-claude-code:search-first <specific question>
3. /everything-claude-code:docs <library> <topic>
```

### Library / API Docs Lookup
```
/everything-claude-code:docs <library> <method or feature>
```
Examples:
```
/everything-claude-code:docs pymodbus ModbusTcpClient reconnect
/everything-claude-code:docs better-sqlite3 WAL checkpoint
/everything-claude-code:docs electron-updater autoDownload
/everything-claude-code:docs scikit-learn GradientBoostingRegressor warm_start
```

### When Docs Search Is Insufficient (Iterative)
```
1. /everything-claude-code:docs <library> <topic>           (first pass)
2. /everything-claude-code:documentation-lookup <topic>     (Context7 MCP)
3. /everything-claude-code:iterative-retrieval <topic>      (progressive narrowing)
```

---

## Security & Config Audit

### Auth / Token / API Key Change
```
1. → implement change
2. /everything-claude-code:security-review <file>
```

### Full Workspace Security Audit
```
/everything-claude-code:security-scan
```

---

## Code Cleanup

### Cleanup After Implementation
```
1. /everything-claude-code:simplify                    (remove duplication, dead code)
2. /everything-claude-code:python-review               (if Python was touched)
3. /sub_smoker
```

### Style Conventions Reference
```
/everything-claude-code:coding-standards
```

### Extract Principles From Skills
```
/everything-claude-code:rules-distill
```

---

## Architectural Decisions

### Record an Architectural Decision
```
/everything-claude-code:architecture-decision-records
<describe: what was decided, why, and what alternatives were considered>
```

### Onboard to the Codebase
```
/everything-claude-code:codebase-onboarding
<specific area: forecast engine, inverter engine, or Node server>
```

---

## Skill / Agent Maintenance

### Create a New Project Skill
```
/everything-claude-code:skill-create
```

### Check What Skills Are Available
```
/everything-claude-code:skill-health
```

### Review Learned Instincts
```
/everything-claude-code:instinct-status
```

### Cluster Instincts into a Skill
```
/everything-claude-code:evolve
```

### Promote Project Instinct to Global
```
/everything-claude-code:promote <instinct-id>
```

### Audit Installed Skills for Gaps
```
/everything-claude-code:skill-stocktake
```

### Export Instincts for Backup
```
/everything-claude-code:instinct-export
```

---

## Context / Session Management

### Session Getting Large
```
/everything-claude-code:strategic-compact
```

### Save Checkpoint Before Long Task
```
/everything-claude-code:save-session
```

### Resume a Previous Session
```
/everything-claude-code:resume-session
```

### Browse Session History
```
/everything-claude-code:sessions
```

### Audit Context Usage
```
/everything-claude-code:context-budget
```

---

## Instinct / Learning Loop

### After a Complex Session
```
1. /everything-claude-code:learn-eval                  (extract reusable patterns)
2. /everything-claude-code:instinct-status             (verify they were saved)
3. /everything-claude-code:evolve                      (optional: cluster into skill)
```

### Promote a Strong Instinct to Global
```
/everything-claude-code:promote <instinct-id>
```

### Optimize a Delegation Prompt
```
/everything-claude-code:prompt-optimize
<paste the vague prompt you were about to send to sub_forecaster or sub_engr>
```
