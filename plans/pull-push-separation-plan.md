# Pull / Push Separation Plan

## Goal

Make manual replication actions explicit and one-directional.

- `Pull` must be download-only.
- `Push` must be upload-only.
- Gateway data must change only during an explicit `Push`.
- Local data must change only during an explicit `Pull` or normal local live mirroring.

Apply the same no-side-effect rule to startup auto-sync checks as well: startup may inspect gateway state, but it must not auto-push local data to the gateway.

## Current Problem

The current manual flows are not cleanly separated.

- Manual `Pull` in `runManualPullSync()` first calls `reconcileRemoteBeforePull()`.
- `reconcileRemoteBeforePull()` can call `pushDeltaInChunks()` when the remote has local-newer replicated data.
- Result: a user-initiated `Pull` can modify the gateway before the gateway DB is downloaded.

The reverse is also true.

- Manual `Push` in `runManualPushSync()` uploads local data to the gateway.
- After that, it pulls the gateway main DB back down and stages it locally.
- Result: a user-initiated `Push` also becomes an implicit local overwrite on restart.

That behavior is operationally confusing and violates the intended model:

- gateway is authoritative
- `Pull` means "replace my local state from gateway"
- `Push` means "send my local replicated changes to gateway"

## Required End State

### Manual Pull

- Reads gateway replication summary only.
- If local replicated data is newer than gateway data:
  - stop
  - return `LOCAL_NEWER_PUSH_FAILED`
  - allow the existing `Force Pull` path to proceed if the operator chooses to overwrite local state
- If allowed to proceed:
  - stage gateway main DB locally
  - stage archive files locally if requested
- Must never push any data to the gateway as a side effect.

### Manual Push

- Uploads local replicated hot-data delta to the gateway.
- Uploads local archive files if requested.
- Returns without pulling the gateway DB back down.
- Must not stage a local DB replacement.
- Must not require restart after push unless some unrelated future behavior explicitly needs it.

## Scope

Files to change:

- [server/index.js](/d:/ADSI-Dashboard/server/index.js)
- [public/js/app.js](/d:/ADSI-Dashboard/public/js/app.js)
- [SKILL.md](/d:/ADSI-Dashboard/SKILL.md)
- [CLAUDE.md](/d:/ADSI-Dashboard/CLAUDE.md)
- [MEMORY.md](/d:/ADSI-Dashboard/MEMORY.md)

## Server Changes

### 1. Add a pure pre-pull check

Add a new helper near `reconcileRemoteBeforePull()`:

- name: `checkLocalNewerBeforePull(baseUrl)`
- purpose: compare local replication summary against gateway replication summary
- behavior:
  - fetch `GET /api/replication/summary` from the gateway
  - build local summary with `buildReplicationSummary()`
  - compare with `hasLocalNewerReplicationData(...)`
  - return:
    - `{ ok: true, localNewer: false }`
    - `{ ok: true, localNewer: true }`
    - `{ ok: false, error }`

Important:

- this helper must not call `pushDeltaInChunks()`
- this helper must not modify gateway state
- use the same gateway auth/header path already used elsewhere:
  - `fetchWithRetry(...)`
  - `buildRemoteProxyHeaders()`

### 2. Refactor `runManualPullSync()`

Replace the current Step 0 reconcile block.

Current behavior:

- label: `Reconciling with gateway`
- calls `reconcileRemoteBeforePull(baseUrl)`
- may push local data to gateway

New behavior:

- label: `Checking gateway state`
- call `checkLocalNewerBeforePull(baseUrl)` instead
- if `localNewer === true` and `forcePull === false`:
  - throw `LOCAL_NEWER_PUSH_FAILED`
  - set `canForcePull = true`
  - message must clearly say:
    - local data is newer
    - `Force Pull` will overwrite local data
    - `Push` should be used first if the operator wants to preserve local changes
- if `forcePull === true`, skip the check and proceed

Everything after that stays the same:

- pull main DB with `pullMainDbFromRemote(...)`
- pull archive files with `pullArchiveFilesFromRemote(...)` when requested
- return `needsRestart: true`

### 3. Refactor `runManualPushSync()`

Keep:

- `runRemotePushFull(baseUrl)`
- optional `pushArchiveFilesToRemote(baseUrl)`

Remove:

- post-push `pullMainDbFromRemote(...)`
- post-push `pullArchiveFilesFromRemote(...)`

New return shape:

- `needsRestart: false`
- `mode: "push"`
- include pushed row count, chunk count, and archive push result
- do not include staged local DB replacement details

New summary text must clearly say:

- local data was sent to gateway
- local DB was left unchanged

### 4. Apply the same read-only rule to startup auto-sync

Update `runRemoteStartupAutoSync()` so startup also uses the same read-only local-newer check.

Required behavior:

- startup may fetch gateway replication summary
- startup may detect that local data is newer
- startup must not auto-push local data to the gateway
- if local data is newer, startup auto-sync should stop and report that manual operator action is required

## Frontend Changes

### 5. Update pull wording in `runReplicationPullNow()`

Change the confirmation and status text so it matches the new behavior.

Required wording intent:

- `Pull` stages the gateway main DB for restart-safe local replacement
- `Pull` does not reconcile or push anything automatically
- if local data is newer, the operator will be warned and can choose `Force Pull`

The existing `LOCAL_NEWER_PUSH_FAILED` handling should stay in place.

Only the message text needs to change:

- no "reconcile first" wording
- no implication that local data is pushed automatically during pull

### 6. Update push wording in `runReplicationPushNow()`

Change the confirmation and status text so it matches the new behavior.

Required wording intent:

- `Push` sends local replicated data to the gateway
- `Push` does not replace local DB afterward
- `Push` does not require restart after completion

Also verify `handleReplicationJobUpdate()`:

- a completed push should not show restart-required wording
- restart-required messaging should remain only for flows that actually stage DB replacement

## Documentation Changes

### 7. Update replication rules in `SKILL.md` and `CLAUDE.md`

Replace the current manual-flow wording with the actual rule:

- manual `Pull` is pure download
- manual `Push` is pure upload
- gateway changes only on explicit push
- pull must never push as a side effect

Be specific that:

- local-newer detection before pull is allowed
- auto-pushing during pull is not allowed

### 8. Add a memory note in `MEMORY.md`

Record the behavioral rule and the implementation change:

- manual pull no longer modifies gateway
- manual push no longer stages a gateway DB replacement locally

## Existing Code to Reuse

Reuse the current building blocks instead of introducing parallel logic:

- `buildReplicationSummary()`
- `hasLocalNewerReplicationData(...)`
- `fetchWithRetry(...)`
- `buildRemoteProxyHeaders()`
- `pullMainDbFromRemote(...)`
- `pullArchiveFilesFromRemote(...)`
- `runRemotePushFull(...)`
- `pushArchiveFilesToRemote(...)`
- `LOCAL_NEWER_PUSH_FAILED`

## Out of Scope

Do not change these in this task:

- live bridge polling
- incremental background replication
- archive staging model
- transfer-speed optimization logic
- transfer monitor transport internals except where manual pull/push labels need updating

## Acceptance Criteria

1. Manual `Pull` never calls any push path.
2. Manual `Push` never stages a local main DB replacement.
3. With local-newer data present:
   - `Pull` returns `LOCAL_NEWER_PUSH_FAILED`
   - gateway data remains unchanged
4. `Force Pull` still works and only overwrites local state.
5. `Push` updates gateway data and leaves local DB unchanged.
6. Pull UI text no longer mentions reconcile/push side effects.
7. Push UI text no longer mentions pulling gateway DB back for consistency.
8. Restart-required UI appears for pull, not for push.
9. Startup auto-sync never pushes local data to the gateway as a side effect.

## Verification

Minimum checks:

1. `node --check server/index.js`
2. `node --check public/js/app.js`
3. Manual pull smoke:
   - no local-newer data
   - transfer monitor shows pull-only phases
4. Manual pull smoke with local-newer data:
   - returns `LOCAL_NEWER_PUSH_FAILED`
   - gateway unchanged
5. Manual push smoke:
   - gateway receives rows
   - local DB unchanged
   - no restart-required result
6. Run the required isolated server smoke test before any EXE build
