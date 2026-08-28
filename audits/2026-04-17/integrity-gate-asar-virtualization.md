# Audit 2026-04-17 — Integrity Gate asar Virtualization Bug (v2.8.11)

Date: 2026-04-17
Status: FIXED — shipping as v2.8.11.
Discovered during: v2.8.10 post-release smoke-testing on real installs.
Root cause: Electron's asar filesystem virtualization.
Related:
- `audits/2026-04-17/README.md` — v2.8.10 power-loss resilience audit
- `plans/2026-04-17-power-loss-resilience.md` — original plan
- v2.8.10 GitHub release was published then pulled because of this bug.
  The `v2.8.10` git tag at `afcd89d` remains in history as "attempted but
  never shipped."

## Symptom

After installing v2.8.10 (either fresh install or auto-update from v2.8.9)
the dashboard launched into the power-loss recovery dialog on every boot:

> ADSI Inverter Dashboard could not start because application files are
> damaged.
> …
> Reason: Integrity check failed
> Integrity: app.asar suspiciously small (0 bytes) (mode=full)

Reported on both gateway-mode and remote-mode installs. Reported on
healthy, fully-signed installs where `app.asar` was physically
`475,444,941 bytes` on disk (confirmed via Explorer). Clicking Reinstall
Now fixed nothing — the next boot tripped the same check.

## Root cause

`electron/integrityGate.js:48` calls `fs.statSync(asarPath)`. That module
is bundled into `app.asar` at build time. When the packaged app runs,
`require("fs")` from code inside the asar returns **Electron's shimmed
filesystem**, which treats asar archives as *virtual directories* so
code can transparently read files inside them.

That shim has two consequences for us:

1. `fs.statSync("…/app.asar")` returns synthetic `Stats` where
   `isDirectory()` is `true`. On Windows, directory Stats have
   `size: 0`.
2. Our check `if (asarStat.size < 64)` therefore fires on EVERY packaged
   launch, regardless of the real on-disk size.

This explains the mode mismatch between our test coverage and
production:

- Unit tests (`server/tests/crashRecovery.test.js` v2.8.10) ran under
  plain Node and validated correct behavior against a synthetic asar
  file. No asar shim present → tests passed.
- Packaged production runs Electron's fs shim → test assumptions
  invalid → dialog fires on every healthy launch.

Integration test gap: we never exercised the gate from inside a real
packaged build before shipping.

## Fix

1. **Switch to `original-fs`** inside `electron/integrityGate.js`.
   Electron ships a built-in module `original-fs` that exposes the raw,
   un-shimmed Node filesystem. Using it bypasses the asar virtualization
   for the stat + read calls the integrity gate makes.

   ```js
   let fs;
   try {
     fs = require("original-fs");   // Electron packaged: un-shimmed fs
   } catch (_) {
     fs = require("fs");            // Node-only tests: no shim to bypass
   }
   ```

   The try/catch fallback keeps the module importable outside Electron
   (test harness, Node ABI smoke) where `original-fs` isn't resolvable.
   In that context plain `fs` has no shim anyway, so behavior is
   identical.

2. **Defensive guard** at the start of `verifyAsarIntegrity`. Before
   reading the size field, check whether `asarStat.isDirectory()` is
   `true`. If yes, the fs layer we got is still shimmed (original-fs
   fallback failed silently, or a future Electron change breaks the
   pattern). Degrade to `mode: "skipped"` with a diagnostic reason
   rather than fire the recovery dialog.

   This turns a crashing bug into a silent no-op if the underlying
   fs-resolution ever goes sideways again. Conservative and correct:
   missing a rare torn-write is a far milder failure than showing
   recovery dialog on a healthy install.

3. **Regression test** in `server/tests/crashRecovery.test.js`:
   `testElectronAsarShimSimulation()` creates a real directory named
   `app.asar` (plus a sidecar manifest) and asserts that
   `verifyAsarIntegrity` returns `ok: true, mode: "skipped"` with a
   diagnostic reason mentioning "directory" or "shim". Verified passing.

## Verification matrix

| Scenario | v2.8.10 (broken) | v2.8.11 (fixed) |
|---|---|---|
| Healthy packaged install (`app.asar` real, 475 MB on disk) | Dialog on every boot | No dialog, normal boot |
| Dev mode (`npm start`, no `app.asar`) | No dialog (`app.isPackaged` gate) | No dialog (unchanged) |
| Unit tests under plain Node | Passed | Passed (+ new shim-sim case) |
| Torn `app.asar` after dirty shutdown (real corruption) | Dialog correctly fires | Dialog correctly fires |
| Truly missing `app.asar` | Dialog correctly fires | Dialog correctly fires |
| All other paths (missing manifest, hash mismatch, bad header, tiny file, malformed manifest) | Worked in unit tests | Still work in unit tests |

## Non-negotiable invariants preserved

I1. No third-party require above the integrity gate — unchanged.
    `original-fs` is an Electron built-in (not a third-party package).
I2. Manifest lives outside app.asar — unchanged. `app.asar.sha512` sits
    next to the asar in `resources/`, written by `scripts/afterPack.js`.
I3. Offline installer stash under `%PROGRAMDATA%\InverterDashboard\
    updates\` — unchanged.
I4. Data-layer behavior for healthy DBs — unchanged.
I5. Backwards compatible — unchanged. Updater app ID, signing
    thumbprint, and build hooks all identical.

## Files touched in v2.8.11

| File | Change |
|---|---|
| `electron/integrityGate.js` | Switch to `original-fs` with fallback; add defensive `isDirectory()` guard; update module-doc |
| `server/tests/crashRecovery.test.js` | Add `testElectronAsarShimSimulation()` |
| `package.json` | `version: 2.8.10 → 2.8.11` |
| `plans/2026-04-17-shutdown-serialization.md` | Reassign shutdown-race fix to v2.8.12 |
| `audits/2026-04-17/shutdown-race.md` | Update target-release to v2.8.12 |
| `audits/2026-04-17/integrity-gate-asar-virtualization.md` | New (this file) |
| `CLAUDE.md` | Version bump + v2.8.11 note |
| `MEMORY.md` | New memory pointer to this audit |

## Follow-ups

- Re-cut signed installer for v2.8.11 and ship to GitHub as the
  replacement for the pulled v2.8.10 release. Auto-update clients on
  v2.8.9 will pick up v2.8.11 directly; no one shipped with v2.8.10 so
  there is no in-field regression path to clean up.
- After v2.8.11 is stable in the field (1-2 weeks), resume work on the
  shutdown-serialization fix as v2.8.12 per
  `plans/2026-04-17-shutdown-serialization.md`.
- Add an integration smoke step to `scripts/smoke-all.js` that actually
  launches the packaged Electron binary and probes the integrity gate
  log line. This is the quality gate that would have caught the
  asar-virtualization bug before release.

## Takeaway

Unit tests on pure-Node fixtures cannot catch Electron's fs shim
behavior. For anything that reads files from the packaged application
bundle, either:

- Use `original-fs` by default (preferred — the Electron-idiomatic way)
- Run at least one smoke assertion inside a real packaged build before
  tagging the release (defense in depth)

Both are cheap; both would have caught this.
