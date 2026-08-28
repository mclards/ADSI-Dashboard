export const meta = {
  name: 'freeze-crash-audit',
  description: 'Deep audit of all causes of ADSI Dashboard UI freezes + whole-PC crashes, with adversarial verification',
  phases: [
    { title: 'Investigate', detail: 'one deep-reading investigator per freeze/crash vector' },
    { title: 'Verify', detail: 'adversarially verify each finding is real and the fix is safe' },
  ],
}

const PREAMBLE = `
You are auditing the ADSI Inverter Dashboard codebase at d:/ADSI-Dashboard for the root causes of TWO observed symptoms:
  (A) the entire dashboard UI freezes / becomes unresponsive for periods of time, intermittently; and
  (B) SOMETIMES the freeze escalates to crashing the ENTIRE Windows computer (not just the app).

STACK & DEPLOYMENT FACTS (critical for judging mechanisms):
- Electron 29 desktop shell (electron/main.js, electron/preload.js).
- Express 4 API server on port 3500 (server/index.js ~25k lines, server/db.js ~7k lines).
- SQLite via better-sqlite3 (SYNCHRONOUS — every query blocks the Node event loop while it runs).
- Frontend: vanilla JS + Chart.js 4 in public/js/app.js (~34k lines).
- Python FastAPI inverter engine on port 9000 (services/inverter_engine.py) doing Modbus TCP polling; Python forecast engine (services/forecast_engine.py).
- Camera streaming via bundled go2rtc + FFmpeg (server/go2rtcManager.js, server/streaming.js).
- CRITICAL: The dashboard UI (browser/renderer) runs ON THE SAME gateway PC as Node + Python + the poller. WebSocket is localhost. Therefore UI-lag bugs are CPU/memory contention on one box, NOT network backpressure. A runaway Node/Python process, an OOM, a disk-full, or CPU saturation on the gateway will freeze the UI AND can crash Windows.

WHOLE-PC CRASH (symptom B) almost always means one of: (1) memory exhaustion / OOM (unbounded cache, leak, giant allocation, giant JSON.stringify/parse), (2) runaway process/thread spawning (spawn in a loop, restart storm, zombie FFmpeg/go2rtc/python), (3) disk-space exhaustion (unbounded logs, WAL growth, backup/temp accumulation), (4) sustained 100% CPU across all cores (busy loop, overlapping heavy cron jobs, synchronous mega-query). Weight your analysis toward these for symptom B.

UI FREEZE (symptom A) means the Node event loop is blocked (synchronous fs, synchronous large SQLite query, huge JSON serialize, synchronous crypto/hash, long sync loop) OR the renderer main thread is blocked (huge DOM rebuild, layout thrash, Chart.js leak, timer pileup, giant array work).

NON-NEGOTIABLE CONSTRAINTS (any proposed fix must NOT break these): live polling, inverter write control, replication (gateway/remote), reporting, CSV/xlsx export, cloud backup, restore, licensing, auto-update flows, power-loss resilience chain (hoisted uncaughtException handler + safeRequire + app.asar SHA-512 integrity gate + installer stash + SQLite auto-restore), PAC-integration authority.

YOUR JOB: Read the ACTUAL code in your assigned target files (use Read/Grep/Glob — do NOT guess from filenames). For every concrete freeze/crash contributor you can substantiate with code, produce a finding. Be specific: cite file + line numbers and quote the offending code. Explain the exact mechanism and what triggers it in production. Propose a MINIMAL, surgical fix that respects the non-negotiables. Distinguish genuine contributors from theoretical nits — but err toward reporting anything that could realistically block the event loop, leak memory, spawn unboundedly, or saturate CPU/disk. Do NOT edit files; you are read-only. Return ONLY the structured object.
`

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimension', 'findings'],
  properties: {
    dimension: { type: 'string' },
    summary: { type: 'string', description: 'one-paragraph overview of what you found in this vector' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'symptom', 'file', 'lines', 'mechanism', 'evidence', 'trigger', 'proposedFix', 'confidence'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          symptom: { type: 'string', enum: ['freeze', 'pc-crash', 'both', 'app-crash'] },
          file: { type: 'string' },
          lines: { type: 'string', description: 'line numbers, e.g. 4197-4220' },
          mechanism: { type: 'string', description: 'precise causal chain from code to freeze/crash' },
          evidence: { type: 'string', description: 'quoted offending code or concrete reasoning' },
          trigger: { type: 'string', description: 'production conditions that fire it' },
          proposedFix: { type: 'string', description: 'minimal surgical fix' },
          confidence: { type: 'number', description: '0..1 that this is a real contributor' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'isReal', 'realSeverity', 'realSymptom', 'reasoning', 'fixSafe', 'fixNotes'],
        properties: {
          title: { type: 'string' },
          isReal: { type: 'boolean', description: 'true if the code path genuinely executes in production and causes the claimed effect' },
          realSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'not-a-bug'] },
          realSymptom: { type: 'string', enum: ['freeze', 'pc-crash', 'both', 'app-crash', 'none'] },
          reasoning: { type: 'string', description: 'why real or not; trace the actual call path / data sizes' },
          fixSafe: { type: 'boolean', description: 'true if proposed fix does not risk any non-negotiable' },
          fixNotes: { type: 'string', description: 'refined/corrected fix, or risk if unsafe' },
        },
      },
    },
  },
}

const DIMENSIONS = [
  {
    key: 'node-eventloop-block',
    label: 'node-eventloop-blocking',
    prompt: `VECTOR: Node.js EVENT-LOOP BLOCKING in the main Express/Electron process (causes symptom A freeze; a huge sync op can also OOM => symptom B).
Hunt for synchronous operations on the request/poll/broadcast hot paths and in scheduled jobs:
- Synchronous fs in hot paths: readFileSync/writeFileSync/appendFileSync/readdirSync/statSync/existsSync called per-request, per-poll, per-broadcast, or inside loops over many files.
- Synchronous SQLite (better-sqlite3 is sync): .all()/.get()/.run()/.exec()/.iterate() over large/unbounded result sets executed on a request handler or interval; transactions that hold the loop; VACUUM/ANALYZE/integrity_check on the main loop.
- Giant JSON.stringify / JSON.parse on large payloads (exports, analytics, replication snapshots, WS enrichment).
- Synchronous crypto/hashing (createHash over large files/buffers, pbkdf2Sync, signing) on hot paths.
- Long synchronous for/while loops building big arrays/strings (CSV/xlsx assembly, aggregation) without yielding.
- spawnSync/execFileSync/execSync on a request or interval.
PRIMARY TARGETS: server/index.js (route handlers, the spawnSync at lines ~13/14/351), server/db.js (query helpers, queryReadingsRangeAll ~4197-4220 reportedly has NO row cap, ARCHIVE_DB_CACHE ~115), server/exporter.js, server/cloudBackup.js, server/dailyAggregator.js, server/plantCapController.js. Also scan server/poller.js for sync work per poll.
For each, estimate the data size at scale (e.g., readings table can be very large) and whether it runs on the request thread.`,
  },
  {
    key: 'node-memory-leak',
    label: 'node-memory-leak',
    prompt: `VECTOR: UNBOUNDED MEMORY GROWTH / LEAKS in the Node process (primary cause of symptom B whole-PC crash via OOM; severe GC pauses also freeze = symptom A).
Hunt for:
- Caches / Maps / Sets / arrays that grow without eviction or TTL. Known suspect: ARCHIVE_DB_CACHE in server/db.js (~line 115) reportedly never evicts. Find ALL module-level Map/Set/{} used as caches and check for bounds.
- Arrays that .push() in an interval/loop/event without ever shrinking (in-memory histories, recent-frames buffers, episode buffers, ws stats arrays, rolling windows).
- Event listener leaks: .on()/addListener/ws.on/emitter.on registered per request/per connection/per poll without matching removal => listener accumulation + retained closures.
- Retained large objects in closures captured by long-lived timers.
- Accumulating timers themselves (see timers vector but note any setInterval whose callback retains growing state).
- Opened-but-never-closed handles: better-sqlite3 connections (attach without detach), file streams, child processes kept in arrays.
PRIMARY TARGETS: server/db.js (ARCHIVE_DB_CACHE and any other cache, attach/detach), server/index.js (module-level state, listeners, in-memory buffers), server/poller.js (per-poll accumulation), server/plantCapController.js, server/dailyAggregator.js, server/alarmEpisodeCore.js, server/criticalPatternEnforcer.js, server/ws.js (wsStats), server/cloudBackup.js. Confirm each cache's growth bound and whether it can grow over days of uptime.`,
  },
  {
    key: 'sqlite-contention',
    label: 'sqlite-runaway-queries',
    prompt: `VECTOR: SQLITE RUNAWAY QUERIES & CONTENTION (better-sqlite3 is synchronous => a slow query freezes the whole API = symptom A; a query that loads millions of rows into JS arrays = symptom B OOM).
Hunt for:
- SELECTs with no LIMIT / no row cap over hot tables (readings, energy_5min). Known suspect: queryReadingsRangeAll server/db.js ~4197-4220.
- Full-table scans / missing indexes on frequently-queried columns (ts, inverter, day_key) — check CREATE INDEX vs WHERE clauses.
- Wide analytics reads that pull entire date ranges into memory then map/aggregate in JS.
- Long write transactions or many small writes per poll that contend with reads; WAL checkpoint behavior; busy_timeout config.
- VACUUM / integrity_check / quick_check / ANALYZE executed at runtime (not just boot) on the main loop.
- The archive DB attach/detach pattern (server/cloudBackup.js ~1843-1892, server/db.js ~3964/5581) holding locks.
- Retention/cleanup DELETEs that scan large tables without batching.
PRIMARY TARGETS: server/db.js (all query* helpers, retention/cleanup, indexes via db.exec CREATE TABLE/INDEX), server/dailyAggregator.js, server/exporter.js, server/index.js analytics/report/export endpoints. Quote the SQL and the JS that consumes the rows; estimate row counts at a plant running for months.`,
  },
  {
    key: 'renderer-freeze-leak',
    label: 'renderer-freeze-and-leak',
    prompt: `VECTOR: RENDERER (browser) FREEZE & MEMORY LEAK in public/js/app.js (~34k lines). Because the UI runs on the gateway, a renderer leak/CPU-spin contributes to BOTH symptom A and (via OOM of the renderer process) symptom B.
Hunt for:
- Chart.js instances created with new Chart(...) that are NOT destroyed before recreation => GPU/CPU + memory leak. There are ~14 new Chart / .destroy occurrences — verify every new Chart() has a matching .destroy() on its prior instance, especially in re-render/refresh/poll paths.
- setInterval/setTimeout (there are ~103) that are never cleared: intervals started on page nav/section-open without clearInterval on leave => stacking duplicate pollers each WS/poll tick; recursive setTimeout polls that can double up; intervals re-created on reconnect.
- Heavy synchronous DOM work on the WS message handler or on every poll: full innerHTML rebuilds of large tables/lists, re-creating all inverter cards each tick, layout thrash (read-then-write loops), sorting/mapping large arrays on the main thread each frame.
- Unbounded in-renderer arrays (chart data points, log/notification lists, history) that grow over days without trimming.
- Event listeners (addEventListener) attached repeatedly (per render/per card) without removal => accumulation.
- Large WS payload handling: JSON already parsed by browser, but re-rendering everything per message at high frequency.
PRIMARY TARGETS: public/js/app.js. Identify the WS onmessage handler and the polling/refresh functions; map which run every tick and how expensive they are. Quote function names + line numbers.`,
  },
  {
    key: 'ws-streaming-load',
    label: 'ws-and-camera-streaming',
    prompt: `VECTOR: WEBSOCKET BROADCAST LOAD + CAMERA STREAMING (CPU saturation => symptom A; process/zombie accumulation + memory => symptom B).
Hunt for:
- WebSocket broadcast cadence vs payload size: server/ws.js broadcastUpdate does JSON.stringify(finalPayload) on EVERY broadcast for ALL clients. Find WHO calls broadcastUpdate and HOW OFTEN (poller cadence?), and how big the payload is (does it include full per-inverter param history, all alarms, etc.). High frequency * large payload * stringify = main-loop CPU. Also check the payloadEnricher cost.
- WebSocket server config: is there a maxPayload limit? Is permessage-deflate enabled (CPU/memory heavy under load)? Are inbound messages bounded?
- Camera streaming: server/go2rtcManager.js spawns go2rtc (line ~198) and FFmpeg. Look for: respawn loops on crash (restart storm), multiple FFmpeg processes per camera, processes never killed on stop/teardown, no backoff, accumulating child handles, HLS segment files filling disk. server/streaming.js too.
- Any broadcast or stream work that scales with number of inverters/cameras and could pin a core.
PRIMARY TARGETS: server/ws.js, server/poller.js (broadcast callers + cadence), server/index.js (ws setup, enricher), server/go2rtcManager.js, server/streaming.js. Quantify frequency and payload size where possible.`,
  },
  {
    key: 'process-spawn-native',
    label: 'process-spawn-and-native-crash',
    prompt: `VECTOR: CHILD-PROCESS / NATIVE CRASH / RESTART STORMS (top suspects for symptom B whole-PC crash).
Hunt for:
- Process restart storms: any place that respawns a child (python InverterCoreService/ForecastCoreService EXEs, go2rtc, FFmpeg, calibrator) on exit/crash WITHOUT backoff or a max-retry cap => tight spawn loop that forks hundreds of processes and saturates the machine.
- electron/main.js (~6k lines, 54 spawn/webContents refs): the survival-boot, watchdogs (20s self-exit watchdog noted), relaunch logic (app.relaunch). Check for relaunch loops, repeated BrowserWindow creation, will-quit/before-quit handlers that re-spawn, webContents that reload in a loop.
- spawnSync/execFileSync blocking the main process (server/index.js ~351, server/db.js ~83).
- Python service health-check/restart logic in server/index.js that could hammer-restart a service that keeps dying.
- Native module crash: better-sqlite3 ABI mismatch (Node vs Electron) causing hard renderer/main crashes; uncaughtException handler that logs but leaves process in a zombie/looping state.
- Zombie processes: children spawned without being tracked/killed on app quit.
PRIMARY TARGETS: electron/main.js, server/index.js (python service lifecycle, spawn/spawnSync), server/go2rtcManager.js, server/calibratorServer.js. Trace each spawn to its restart/backoff policy.`,
  },
  {
    key: 'python-services',
    label: 'python-modbus-and-forecast',
    prompt: `VECTOR: PYTHON SERVICES — Modbus poller + forecast engine (CPU/memory on the gateway => contributes to symptom A freeze and symptom B crash, since they share the box).
Hunt for:
- Polling loops in services/inverter_engine.py / drivers/modbus_tcp.py that can busy-spin (no sleep on the failure path), spawn unbounded threads/tasks, or accumulate per-poll memory; connection retries with no backoff hammering dead inverters; thread/lock pile-up (per-IP threading.Lock noted) where a stuck Modbus read blocks others.
- async tasks created but never awaited/cancelled; ThreadPoolExecutor with unbounded queue; event-loop blocking sync calls inside async handlers.
- Memory growth: large reads (60 input registers x N inverters) accumulated in lists/DataFrames that never free; pandas/numpy in forecast_engine.py allocating large frames; model training (LightGBM) memory spikes that could OOM the box.
- forecast_engine.py: training/backtest loops that load wide analytics ranges into memory; repeated retraining; runaway retry.
- FastAPI handlers doing heavy synchronous CPU work blocking the single worker.
PRIMARY TARGETS: services/inverter_engine.py (~4.8k lines, read_fast_async, polling loop, threading), drivers/modbus_tcp.py, services/forecast_engine.py (~12k lines, training/backtest/memory). Quote loop structures, sleep/backoff presence, and any unbounded growth.`,
  },
  {
    key: 'disk-io-logs',
    label: 'disk-and-log-growth',
    prompt: `VECTOR: DISK / LOG GROWTH & I/O STORMS (disk-full or I/O saturation freezes Windows => symptom B; heavy fsync => symptom A stalls).
Hunt for:
- Unbounded log files: console output redirected to a file, custom logger appendFileSync/createWriteStream with no rotation/size cap; per-poll or per-request log lines that accumulate forever.
- audit_log / clock_sync_log / drift_log / grid_control_verify_log and similar tables: growth rate vs retention; any logging on every poll/tick.
- SQLite WAL/SHM growth without checkpoint; backups (backups/adsi_backup_{0,1}.db) and cloud-backup temp files accumulating; export temp files / forecast export files never cleaned.
- HLS camera segments / FFmpeg output piling on disk.
- Frequent fsync/flush or synchronous writes per poll.
- Any writeFileSync/appendFileSync inside an interval or per-request handler that writes to the same growing file.
PRIMARY TARGETS: server/storagePaths.js, server/index.js (logging setup, any file logger), server/db.js (WAL config, backup rotation, retention DELETEs), server/cloudBackup.js (temp files), server/go2rtcManager.js (segment output), electron/main.js (log files). Estimate growth per day and whether anything bounds it.`,
  },
  {
    key: 'timers-cron-overlap',
    label: 'timers-cron-overlap',
    prompt: `VECTOR: TIMER / CRON / SCHEDULER OVERLAP & STACKING (overlapping heavy jobs => CPU storm freeze = symptom A; re-entrant jobs that pile up => runaway = symptom B).
Hunt across the ~114 server-side setInterval/setTimeout for:
- setInterval whose callback can take longer than the interval (heavy DB aggregation, export, backup, forecast regen) with NO re-entrancy guard => overlapping executions stack up and compound CPU/memory.
- Multiple heavy scheduled jobs that can fire at the same wall-clock time (forecast regen crons 04:30/09:30/18:30/20:00/22:00, dailyAggregator rollups, plantCapController tick, criticalPatternEnforcer enforcer tick, clock auto-sync 04:25, cloud backup, retention cleanup) — do they serialize or can they collide and all run heavy work simultaneously?
- Intervals created more than once (e.g., re-initialized on reconnect/mode-switch/settings-change) without clearing the previous => duplicate timers.
- Recursive setTimeout that can double-schedule.
- Timers not unref'd that also do heavy work; timers that never stop on shutdown causing work during teardown.
PRIMARY TARGETS: server/index.js (the 57 setInterval/setTimeout — find each scheduler and its guard), server/poller.js, server/dailyAggregator.js, server/plantCapController.js, server/criticalPatternEnforcer.js, server/gridControlVerifier.js, server/cloudBackup.js, server/go2rtcManager.js. For each heavy interval, state interval period, worst-case duration, and whether re-entrancy/overlap is guarded.`,
  },
]

phase('Investigate')
log(`Fanning out ${DIMENSIONS.length} investigators across freeze/crash vectors...`)

const results = await pipeline(
  DIMENSIONS,
  (d) =>
    agent(`${PREAMBLE}\n\n${d.prompt}\n\nSet dimension="${d.label}" in your output.`, {
      label: `investigate:${d.key}`,
      phase: 'Investigate',
      schema: FINDING_SCHEMA,
    }),
  (report, d) => {
    if (!report || !report.findings || report.findings.length === 0) {
      return { dimension: d.label, summary: report ? report.summary : 'no findings', findings: [], verdicts: [] }
    }
    // Adversarially verify ALL findings for this dimension in one focused verifier call.
    const findingsBlock = report.findings
      .map(
        (f, i) =>
          `[#${i + 1}] TITLE: ${f.title}\n  severity=${f.severity} symptom=${f.symptom} confidence=${f.confidence}\n  file=${f.file} lines=${f.lines}\n  mechanism: ${f.mechanism}\n  evidence: ${f.evidence}\n  trigger: ${f.trigger}\n  proposedFix: ${f.proposedFix}`
      )
      .join('\n\n')
    return agent(
      `${PREAMBLE}\n\nYou are an ADVERSARIAL VERIFIER. Below are candidate freeze/crash findings from the "${d.label}" investigation. For EACH finding, OPEN THE CITED FILE/LINES YOURSELF (Read/Grep) and confirm or refute:\n` +
        `1) Does the cited code actually exist as described and execute on a real production path (request handler, poll tick, interval, startup)? If it's dead/test-only/guarded-off, mark isReal=false.\n` +
        `2) Does the claimed mechanism really cause a UI freeze or whole-PC crash at realistic scale? Trace data sizes / frequencies. Downgrade theoretical nits.\n` +
        `3) Is the proposedFix SAFE against the non-negotiables, and is it correct? If not, give a corrected fix in fixNotes.\n` +
        `Default to skepticism: if you cannot substantiate it from the code, mark isReal=false. Return one verdict per finding, in order, with matching title.\n\nFINDINGS:\n${findingsBlock}`,
      {
        label: `verify:${d.key}`,
        phase: 'Verify',
        schema: VERDICT_SCHEMA,
      }
    ).then((v) => ({
      dimension: d.label,
      summary: report.summary || '',
      findings: report.findings,
      verdicts: (v && v.verdicts) || [],
    }))
  }
)

// Merge findings with their verdicts; keep everything for the main loop to synthesize.
const merged = []
for (const r of results.filter(Boolean)) {
  const byTitle = {}
  for (const v of r.verdicts || []) byTitle[v.title] = v
  for (const f of r.findings || []) {
    const v = byTitle[f.title] || null
    merged.push({
      dimension: r.dimension,
      title: f.title,
      claimedSeverity: f.severity,
      claimedSymptom: f.symptom,
      file: f.file,
      lines: f.lines,
      mechanism: f.mechanism,
      evidence: f.evidence,
      trigger: f.trigger,
      proposedFix: f.proposedFix,
      confidence: f.confidence,
      verified: v ? v.isReal : null,
      realSeverity: v ? v.realSeverity : null,
      realSymptom: v ? v.realSymptom : null,
      verifyReasoning: v ? v.reasoning : null,
      fixSafe: v ? v.fixSafe : null,
      fixNotes: v ? v.fixNotes : null,
    })
  }
}

const confirmed = merged.filter((m) => m.verified === true && m.realSeverity !== 'not-a-bug')
const rejected = merged.filter((m) => m.verified === false || m.realSeverity === 'not-a-bug')

const sevRank = { critical: 0, high: 1, medium: 2, low: 3, 'not-a-bug': 9, null: 8 }
confirmed.sort((a, b) => (sevRank[a.realSeverity] ?? 5) - (sevRank[b.realSeverity] ?? 5))

log(`Audit complete: ${confirmed.length} confirmed, ${rejected.length} rejected, ${merged.length} total candidates.`)

return {
  totals: { candidates: merged.length, confirmed: confirmed.length, rejected: rejected.length },
  dimensionSummaries: results.filter(Boolean).map((r) => ({ dimension: r.dimension, summary: r.summary, count: (r.findings || []).length })),
  confirmed,
  rejected,
}
