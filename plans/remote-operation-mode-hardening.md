# Remote Operation Mode Hardening Plan

## Status

- Implemented in `v2.2.29`:
  - Phase 1: server-side remote health model
  - Phase 2: explicit live-bridge failure classification
  - Phase 3: bounded stale snapshot retention for remote live data
  - Phase 5: reconnect path now reports degraded/stale honestly
  - Phase 7: Replication Health card consumes the richer health state
  - Phase 8: inverter cards show `STALE` instead of blanking on short outages
  - Phase 10: isolated smoke coverage for healthy, degraded, and auth-error bridge transitions
- Not implemented in this pass:
  - Phase 4 side-fetch split
  - Phase 6 lightweight heartbeat endpoint
  - deeper wording cleanup beyond the shipped status labels

## Goal

Make `remote` mode behave like a stable supervised client, not a fragile live tunnel.

Required outcomes:

- short gateway hiccups must not immediately feel like a full disconnect
- inverter cards must keep a clear, bounded last-good live state during transient failures
- `Gateway Link` status must reflect the real runtime condition, not just a binary up/down guess
- manual `Pull` / `Push` must remain independent from live-bridge health
- operators must know whether the issue is:
  - bad URL / token
  - gateway unreachable
  - Tailscale path OK but live bridge stale
  - replication healthy but live polling degraded

## Current Problem

`remote` mode currently mixes several different concerns into one visible status:

- fast live polling from `GET /api/live`
- piggyback fetch of `GET /api/energy/today`
- optional startup incremental replication
- manual pull / push workflows
- UI card rendering decisions

That causes operational confusion:

- manual `Pull` can still work while `Gateway Link` says `Disconnected`
- `Test Remote Gateway` can pass while the live bridge is still stale or in backoff
- the inverter cards can blank too aggressively after bridge failure handling
- the health card does not clearly distinguish:
  - transient live poll failure
  - degraded but still usable state
  - hard disconnect
  - bad config / auth

## Current Code Facts

Relevant current behavior in [server/index.js](/d:/ADSI-Dashboard/server/index.js):

- live bridge tick interval:
  - `REMOTE_BRIDGE_INTERVAL_MS = 1200`
- max backoff after repeated live failures:
  - `REMOTE_BRIDGE_MAX_BACKOFF_MS = 30000`
- live request timeout:
  - `REMOTE_FETCH_TIMEOUT_MS = 5000`
- live retries:
  - `REMOTE_LIVE_FETCH_RETRIES = 2`
- degraded grace:
  - `REMOTE_LIVE_DEGRADED_GRACE_MS = 45000`
- offline threshold:
  - controlled by `REMOTE_LIVE_FAILURES_BEFORE_OFFLINE` and the sync-aware variant

Main runtime paths:

- live bridge:
  - `pollRemoteLiveOnce()`
  - `startRemoteBridge()`
  - `stopRemoteBridge()`
- manual reconnect:
  - `kickRemoteBridgeNow()`
- startup replication:
  - `runRemoteStartupAutoSync()`
- manual pull:
  - `runManualPullSync()`
- manual push:
  - `runManualPushSync()`
- runtime health API:
  - `GET /api/runtime/network`

Relevant frontend behavior in [public/js/app.js](/d:/ADSI-Dashboard/public/js/app.js):

- health card display:
  - `refreshReplicationHealth()`
- remote gateway test:
  - `testRemoteGateway()`
- settings save:
  - `saveSettings()`
- mode transition handling:
  - `handleOperationModeTransition()`

## Root Causes To Address

### 1. Status model is too coarse

Current runtime state is mainly:

- `connected = true/false`
- `liveFailureCount`
- `lastError`

That is not enough to model:

- connected and fresh
- connected but stale
- degraded but usable
- disconnected due to auth
- disconnected due to route timeout
- disconnected due to invalid config

### 2. Live data and replication are operationally separate, but visually conflated

Today the operator can see:

- manual replication works
- Tailscale is connected
- gateway test works
- live cards are empty

This is possible because those are different paths, but the UI makes them look like one health result.

### 3. Temporary live failures still lead to overly harsh user-visible effects

The bridge can drop into offline handling even when the gateway is only briefly slow.

Operationally, the safer behavior is:

- preserve last-good live data for a bounded stale window
- mark it stale clearly
- only blank or force offline after a stronger threshold

### 4. One tick does too much

The live bridge tick currently does:

- `GET /api/live`
- local persistence / totals rebuild
- periodic `GET /api/energy/today`
- optional startup incremental replication trigger

That is workable, but not ideal for resilience.

### 5. Recovery is still too passive

Even with the new reconnect path, sustained reliability still depends heavily on the polling loop and backoff behavior.

## Required End State

### Live Bridge Semantics

`remote` mode must have explicit runtime states:

- `connected`
  - live data fresh and updating normally
- `degraded`
  - last-good live data still within allowed stale window
  - bridge retries ongoing
- `stale`
  - no fresh live update recently, but last-good snapshot still retained
- `disconnected`
  - no usable live snapshot
- `config-error`
  - bad gateway URL or loopback misuse
- `auth-error`
  - token rejected / unauthorized

These states must drive both:

- the Replication Health card
- inverter card behavior

### Inverter Card Behavior

During short outages:

- keep the last-good remote live snapshot
- mark cards stale visually
- do not instantly wipe all cards to zero

During hard disconnect:

- switch to clear offline state only after the hard threshold is crossed

### Manual Actions

- `Test Remote Gateway` remains a one-shot connectivity check
- `Pull` remains data-copy / staging only
- `Push` remains upload only
- neither manual action should be used as a substitute for live-bridge health

### Diagnostics

The operator must be able to tell exactly why `remote` mode is unhealthy:

- gateway unreachable
- request timeout
- HTTP non-200
- unauthorized / bad token
- local invalid config
- stale bridge due to repeated live failures

## Scope

Files expected to change:

- [server/index.js](/d:/ADSI-Dashboard/server/index.js)
- [public/js/app.js](/d:/ADSI-Dashboard/public/js/app.js)
- [public/index.html](/d:/ADSI-Dashboard/public/index.html)
- [public/css/style.css](/d:/ADSI-Dashboard/public/css/style.css)
- [SKILL.md](/d:/ADSI-Dashboard/SKILL.md)
- [CLAUDE.md](/d:/ADSI-Dashboard/CLAUDE.md)
- [MEMORY.md](/d:/ADSI-Dashboard/MEMORY.md)

Out of scope for this hardening pass:

- redesigning gateway replication architecture
- changing manual pull/push directionality again
- changing cloud backup behavior
- changing forecast generation mode rules

## Plan

### Phase 1. Introduce a proper remote health state model

Add a normalized health classifier on the server.

Suggested shape:

```text
remoteHealth = {
  mode,
  state,              // connected | degraded | stale | disconnected | auth-error | config-error
  reasonCode,         // TIMEOUT | HTTP_401 | HTTP_403 | ECONNREFUSED | INVALID_URL | LOOPBACK_URL | ...
  reasonText,
  liveFreshMs,
  lastAttemptTs,
  lastSuccessTs,
  lastFailureTs,
  failureStreak,
  backoffMs,
  lastLatencyMs,
  liveNodeCount,
}
```

Implementation notes:

- keep the existing raw bridge counters
- derive a higher-level state from them
- expose it from `GET /api/runtime/network`
- do not make the UI infer semantics from `connected` alone anymore

### Phase 2. Classify failures explicitly inside `pollRemoteLiveOnce()`

The live bridge should stop treating most failures as generic strings.

Classify at least:

- invalid / missing gateway URL
- unsafe loopback URL
- timeout
- connection refused
- DNS / route failure
- HTTP 401 / 403
- other HTTP error
- bad JSON payload

Server behavior:

- store structured reason code
- store concise operator-safe message
- track `failureStreak` and `lastLatencyMs`

This phase should also separate:

- hard failures that should immediately force offline
- soft failures that should only mark degraded / stale first

### Phase 3. Split bridge freshness from card invalidation

Current bridge logic can broadcast offline too aggressively.

New rule:

- if there is a recent last-good live snapshot:
  - keep it
  - mark it stale
  - keep cards populated
- only clear cards when:
  - no valid live snapshot remains inside the hard stale threshold
  - or config/auth error makes the bridge definitively unusable

Recommended thresholds:

- `fresh`: last success <= 10 s
- `degraded`: > 10 s and <= 45 s
- `stale`: > 45 s and <= 120 s
- `hard offline`: > 120 s or fatal config/auth failure

Exact thresholds can be tuned, but the main rule is:

- stale is not the same as empty

### Phase 4. Separate the fast live loop from slower side fetches

The live bridge tick should prioritize only the essentials.

Refactor:

- keep `GET /api/live` as the fast bridge loop
- move `GET /api/energy/today` to its own timed worker or clearly isolated branch
- keep startup incremental replication independent from the steady-state live poll loop

Target effect:

- slow `today` or replication operations must not make the live cards feel disconnected

### Phase 5. Improve reconnect behavior

Reconnect should happen faster and more deliberately after transient failure.

Required changes:

- keep the new manual reconnect path
- reset backoff more aggressively after:
  - successful `Test Remote Gateway`
  - successful settings save in `remote` mode
  - transition into `remote` mode
  - browser tab return / page focus if the bridge is stale
- only escalate to max backoff for repeated true transport failures

This phase should also ensure:

- if runtime values already match saved settings and the gateway test passes,
  the live bridge is refreshed immediately

### Phase 6. Add a lightweight bridge heartbeat path

Optional but recommended:

- add a very small gateway endpoint such as `/api/runtime/health-lite` or `/api/live/meta`
- return:
  - server reachable
  - auth accepted
  - node count
  - gateway timestamp
  - maybe latest live timestamp

Use cases:

- distinguish "gateway alive but live payload temporarily problematic"
- reduce the need to treat full `/api/live` as the only liveness signal

This endpoint must not replace `/api/live`; it should complement it.

### Phase 7. Harden the UI status model

Update `refreshReplicationHealth()` in [public/js/app.js](/d:/ADSI-Dashboard/public/js/app.js).

Required UI states:

- `Connected`
- `Connected (degraded)`
- `Stale live data`
- `Disconnected`
- `Auth error`
- `Config error`

Also show:

- last good live update age
- failure streak
- last error reason

Important:

- do not show `Disconnected` for every non-green state
- distinguish:
  - bridge degraded
  - bridge stale
  - gateway unreachable

### Phase 8. Add stale-state presentation to inverter cards

The cards need a visible stale mode.

Proposed behavior:

- last-good values stay visible
- a stale overlay or badge appears
- command actions remain disabled if the bridge is not actually healthy

Required styling direction:

- visually obvious
- not alarm-red unless truly disconnected
- easy to distinguish from a real plant offline state

### Phase 9. Improve operator actions and wording

Update UX copy so operators understand the separation between:

- gateway reachability
- live bridge status
- manual pull / push availability

Examples:

- `Gateway reachable, live bridge reconnecting`
- `Live bridge stale, using last-good snapshot`
- `Gateway test used unsaved settings`
- `Replication available even though live bridge is degraded`

### Phase 10. Add targeted smoke tests

This hardening must be verified with isolated server smoke tests.

Minimum test scenarios:

1. transient live timeout
- bridge remains in `degraded` or `stale`
- cards keep last-good values
- no immediate blanking

2. hard gateway unreachable
- state becomes `disconnected`
- cards eventually clear after hard threshold

3. auth failure
- state becomes `auth-error`
- UI message is explicit

4. bad config
- state becomes `config-error`
- UI message is explicit

5. successful reconnect after stale period
- `Gateway Link` flips back to connected quickly
- inverter cards repopulate without needing manual pull

6. manual pull still works while live bridge is stale
- confirms path separation is preserved

## Implementation Sequence

Recommended order:

1. Phase 1: health-state model
2. Phase 2: failure classification
3. Phase 3: stale snapshot retention for cards
4. Phase 5: reconnect behavior
5. Phase 7: health-card UI
6. Phase 8: inverter-card stale presentation
7. Phase 4: side-fetch split if still needed after measurement
8. Phase 6: lightweight heartbeat endpoint
9. Phase 9: wording cleanup
10. Phase 10: smoke-test coverage

## Acceptance Criteria

This plan is complete only if all of these are true:

- short live gateway interruptions do not immediately blank inverter cards
- `Gateway Link` no longer flips straight from healthy to generic `Disconnected`
- operator can distinguish:
  - stale
  - disconnected
  - auth/config error
- successful gateway test with saved settings causes immediate live-bridge recovery
- manual pull / push behavior remains independent from live-bridge health
- smoke tests exist for transient failure, hard failure, auth error, config error, and reconnect

## Risks

### Risk 1. Too much stale retention hides real disconnects

Mitigation:

- use bounded stale windows
- label stale state clearly
- disable unsafe actions while stale/disconnected

### Risk 2. More status states confuse the UI

Mitigation:

- keep the internal state model rich
- keep displayed labels concise and operator-focused

### Risk 3. Reconnect logic causes duplicated bridge loops

Mitigation:

- reuse the existing single bridge timer
- never spawn parallel background loops
- keep `kickRemoteBridgeNow()` one-shot and loop-safe

## Notes

This plan is specifically for `remote` mode reliability polish.

It is not a replication-direction plan, and it is not a forecast plan.

The main architectural principle is:

- replication can be successful while live bridge is unhealthy
- live bridge can be healthy while manual replication is idle

The UI and runtime should make that distinction obvious.
