# ADSI Inverter Dashboard — Auto-Update Flow (Documentary)

> Internal engineering reference. Not a user-facing document.
> Covers the full update pipeline: **detect → download → verify → install → relaunch**,
> plus the offline-recovery fallback that re-runs the last good installer after a
> torn-write event.
>
> Source of truth is the code; every claim below is anchored to a file and line.
> Primary files:
> - [electron/main.js](electron/main.js) — updater wiring, IPC, install shutdown
> - [electron/preload.js](electron/preload.js) — renderer ↔ main IPC bridge
> - [public/js/app.js](public/js/app.js) — UI state, toasts, modals
> - [electron/recoveryDialog.js](electron/recoveryDialog.js) — offline reinstall
> - [package.json](package.json) — electron-builder publish + NSIS config

---

## 0. TL;DR

1. On a normal NSIS install the app runs in **`installer`** mode and uses
   `electron-updater` pointed at the GitHub release channel
   `mclards/ADSI-Dashboard`.
2. **One** automatic check runs **8 seconds after startup** (no polling, no
   overnight timer — both removed in v2.10.5). The renderer adds a soft
   **24-hour** re-check driven from `localStorage`.
3. If a newer release (or opt-in pre-release) exists, the app shows it but does
   **not** download unless the **Auto-download** preference is on. Otherwise the
   operator clicks **Download Update**.
4. Download is verified two ways: **SHA-512** from `latest.yml` (automatic) plus
   a **defence-in-depth Authenticode thumbprint pin** (custom override).
5. Install **never** happens silently or on quit. It requires an explicit
   **Restart & Install** click, gated by a confirmation modal warning of a ~60 s
   monitoring outage.
6. Install = graceful stop of Python services → force-kill stragglers → NTFS
   handle-release grace → `quitAndInstall(silent, forceRunAfter)` → NSIS replaces
   files → app relaunches automatically.
7. Every verified installer is stashed to
   `%PROGRAMDATA%\InverterDashboard\updates\last-good-installer.exe` so the
   **recovery dialog** can re-run it offline if `app.asar` is later found damaged.

---

## 1. Runtime mode — which updater is active

`getAppUpdateMode()` at [electron/main.js:817](electron/main.js#L817) decides
the entire strategy:

| Condition | Mode | Updater behaviour |
|---|---|---|
| `!app.isPackaged` | `dev` | Disabled — "Update checks are disabled in development mode." |
| `PORTABLE_EXECUTABLE_DIR`/`_FILE` set | `portable` | Manual: GitHub API lookup → opens the release download page in the browser |
| Packaged NSIS install (default) | `installer` | Full `electron-updater` auto-update pipeline |

The product ships **only** as a signed NSIS installer (Windows-only by design),
so `installer` is the real-world path. `portable` and `dev` are described where
relevant but the rest of this document is about `installer` mode.

### Channel & feed configuration
Constants at [electron/main.js:539-567](electron/main.js#L539-L567):

- `UPDATE_REPO_OWNER` = `mclards`, `UPDATE_REPO_NAME` = `ADSI-Dashboard`
  (overridable via `ADSI_UPDATE_REPO_OWNER`/`_NAME`).
- `UPDATE_CHANNEL` — `stable` (default) or `beta`. **Beta requires an explicit
  `ADSI_UPDATE_FEED_URL`**; without it, beta silently falls back to stable
  (`UPDATE_CHANNEL_FALLBACK_NOTE`).
- `UPDATE_FEED_URL` — defaults to
  `https://github.com/mclards/ADSI-Dashboard/releases/latest/download`, only used
  when the generic provider is selected.
- `UPDATE_GITHUB_TOKEN` — optional bearer token for the portable-mode GitHub API
  call (avoids rate limits); not required for the GitHub provider.
- `UPDATE_CHECK_TIMEOUT_MS` = `10000`.

---

## 2. Initialization — `initAppUpdater()`

[electron/main.js:1291](electron/main.js#L1291). On `installer` mode it:

1. Calls `bindAutoUpdaterEventsOnce()` (event wiring — §3).
2. If `electron-updater` failed to load (`autoUpdater === null`, e.g. corrupt
   `app.asar`), it records an error state and returns — the recovery dialog has
   already been scheduled in the survival-boot block
   ([electron/main.js:106-131](electron/main.js#L106-L131)).
3. Selects the feed provider ([main.js:1308-1335](electron/main.js#L1308)):
   - **GitHub provider** by default (`owner`/`repo`) — the only path that honors
     `allowPrerelease` for the public repo, so pre-release tags can surface.
   - **Generic provider** with `UPDATE_FEED_URL` **only** if
     `ADSI_UPDATE_FEED_URL` is explicitly set (beta channel / air-gapped mirror).

`autoUpdater` itself is required defensively via `safeRequire`
([main.js:135-136](electron/main.js#L135-L136)) so a broken module can never
crash the survival boot.

---

## 3. Event wiring — `bindAutoUpdaterEventsOnce()`

[electron/main.js:1019](electron/main.js#L1019). Bound exactly once. Key setup:

- `autoUpdater.autoDownload = getAutoDownloadPref()` — **default OFF**
  (bandwidth-conscious gateway). Persisted in
  `userData/update-prefs.json` ([main.js:823-853](electron/main.js#L823)).
- `autoUpdater.autoInstallOnAppQuit = false` — **never** auto-install on a window
  close; this is a 24/7 monitoring box ([main.js:1034-1037](electron/main.js#L1034)).
- `autoUpdater.allowPrerelease = true` — pre-releases become **opt-in** prompts;
  this changes **visibility only**, not auto-install ([main.js:1039-1047](electron/main.js#L1039)).
- File logger → `userData/updater.log` for field diagnosis without a console
  ([main.js:1049-1069](electron/main.js#L1049)).

### Event → state transitions
All events call `setAppUpdateState(...)`, which merges into the global
`appUpdateState` ([main.js:647-663](electron/main.js#L647)) and broadcasts the
public shape to every renderer over the `app-update-status` IPC channel
([main.js:885-904](electron/main.js#L885)).

| `electron-updater` event | `status` | Notable fields | Code |
|---|---|---|---|
| `checking-for-update` | `checking` | `checking:true` | [main.js:1141](electron/main.js#L1141) |
| `update-available` | `update-available` | `canDownload:true`, `latestVersion` | [main.js:1155](electron/main.js#L1155) |
| `update-not-available` | `up-to-date` | `updateAvailable:false` | [main.js:1172](electron/main.js#L1172) |
| `download-progress` | `downloading` | `downloadPercent` (0-100) | [main.js:1190](electron/main.js#L1190) |
| `update-downloaded` | `downloaded` | `canInstall:true`, stashes installer, pushes `app-update-ready` | [main.js:1205](electron/main.js#L1205) |
| `error` | `error` | sanitized `message`/`error` via `getUpdateErrorMessage()` | [main.js:1241](electron/main.js#L1241) |

> Note: if **Auto-download** is ON, `electron-updater` proceeds straight from
> `update-available` → `download-progress` → `update-downloaded` on its own. If
> OFF (default), it stops at `update-available` and waits for an explicit
> `downloadUpdate()` call.

---

## 4. Detection (when checks fire)

There are exactly **two** triggers in production plus manual:

1. **Startup one-shot** — `scheduleAutoUpdateCheck()`
   ([main.js:1563-1578](electron/main.js#L1563)): a single `setTimeout` 8 s after
   launch, `unref()`-ed, **never re-armed**. The v2.10.5 comment block above it
   explains the deliberate removal of the polling timer and the overnight
   auto-install timer (they were suspected overnight-crash contributors).
2. **Renderer daily check** — `scheduleDailyUpdateCheck()`
   ([app.js:1366-1384](public/js/app.js#L1366)): every 24 h, gated by a
   `lastUpdateCheckTs` localStorage timestamp, invokes the `checkForUpdates` IPC.
3. **Manual** — operator clicks **Check for Updates** (Settings → App Updates, or
   the About panel) → `checkForUpdatesNow()` ([app.js:1704](public/js/app.js#L1704)).

All paths land in `checkForAppUpdates()` ([main.js:1388](electron/main.js#L1388)),
which guards against re-entrancy (`appUpdateState.checking`), routes `portable`
to `checkPortableUpdates()`, and otherwise calls `autoUpdater.checkForUpdates()`.

### Portable detection (alternate path)
`checkPortableUpdates()` ([main.js:967](electron/main.js#L967)) hits the GitHub
REST API `releases/latest`, parses `tag_name`, compares with `compareVersions()`
([main.js:799](electron/main.js#L799)), and resolves the best `.exe` asset via
`findPortableAssetUrl()` ([main.js:946](electron/main.js#L946)). It only exposes a
**download URL** — install is manual.

---

## 5. Download

`downloadAppUpdate()` ([main.js:1456](electron/main.js#L1456)):

- **installer mode** — validates `updateAvailable`, sets `status:"downloading"`,
  calls `autoUpdater.downloadUpdate()`. Progress flows back through the
  `download-progress` event. On completion the `update-downloaded` event fires.
- **portable mode** — whitelists the URL via `isSafeExternalUrl()` (defence
  against a compromised feed) and `shell.openExternal()` opens the release page.

During download, `electron-updater`:
1. Pulls the **`.blockmap`** to attempt a **differential download** (only changed
   blocks vs the currently installed installer) — minimizes bandwidth.
2. Validates the downloaded installer's **SHA-512** against the digest published
   in `latest.yml`.
3. Calls the **custom `verifyUpdateCodeSignature` override** (§6).

---

## 6. Signature verification (defence in depth)

Custom override at [electron/main.js:1091-1139](electron/main.js#L1091).

**Why it exists:** the stock verifier runs `Get-AuthenticodeSignature` and demands
`Status=Valid`. With the project's self-signed cert, machines missing the root in
*Trusted Root Certification Authorities* return `Status=UnknownError`, which the
stock verifier treats as a hard failure — breaking auto-update entirely.

**What the override does** (`EXPECTED_SIGNER_THUMBPRINT = 44CD054E69D04011DAA8FB2B60127F1F6EB99C0E`):

| Outcome of reading the signer thumbprint | Decision |
|---|---|
| Thumbprint **matches** the pinned value | **Accept** (returns `null`) |
| Thumbprint **mismatches** | **Reject** — logs ERROR, returns the message (a swapped binary in a compromised `latest.yml` is refused) |
| Thumbprint **unreadable** (PowerShell missing / error) | **Accept** — SHA-512 remains the authoritative integrity check |

On accept, it records `lastVerifiedInstallerPath = tempUpdateFile`
([main.js:1118](electron/main.js#L1118) / [main.js:1125](electron/main.js#L1125)) —
consumed by the offline-recovery stash (§9).

`getUpdateErrorMessage()` ([main.js:1580](electron/main.js#L1580)) translates raw
errors into operator-friendly guidance (missing root cert, 404 feed, etc.) and
strips internal URLs/paths before they reach the UI.

---

## 7. Install (operator-gated, destructive)

Install **always** requires an explicit click. Auto-install is impossible
(`autoInstallOnAppQuit = false`, and the overnight timer was removed).

### Renderer side
- `update-downloaded` pushes the `app-update-ready` IPC → renderer shows the
  **Update Ready modal** (`initUpdateReadyModal()`,
  [app.js:1578](public/js/app.js#L1578)), with a 24 h **snooze**.
- Clicking **Install** → `installUpdateNow()` ([app.js:1747](public/js/app.js#L1747))
  → `showInstallConfirmModal()` ([app.js:1423](public/js/app.js#L1423)). The modal
  warns of a **~60 s monitoring outage**; if the modal HTML is missing it falls
  back to a native `window.confirm()` — confirmation is never skipped.
- On confirm → `_doInstallUpdateConfirmed()` ([app.js:1759](public/js/app.js#L1759))
  → `installUpdate` IPC, guarded against double-click by `_installInProgress`.

### Main side
`installAppUpdateNow()` ([main.js:1530](electron/main.js#L1530)) requires
`canInstall`, sets `status:"installing"`, then calls
`requestAppShutdown({ action: { type: "install" } })`.

The shutdown machine ranks actions (`install` > `relaunch` > `exit` > `quit`,
[main.js:1614](electron/main.js#L1614)) so an install request wins over any
concurrent quit. `finalizeAppShutdown()` ([main.js:1831](electron/main.js#L1831))
dispatches `type === "install"` to **`finalizeInstallShutdown()`**.

### `finalizeInstallShutdown()` — the critical ordering
[electron/main.js:1885](electron/main.js#L1885). The installer will overwrite
`dist/InverterCoreService.exe` and `dist/ForecastCoreService.exe`; if a Python
child still holds those handles the install fails and leaves a broken app. So:

1. Runtime services are stopped gracefully first via stop files
   (`backend.stop` / `forecast.stop`) so Python exits cleanly
   ([main.js:1816-1828](electron/main.js#L1816)) — **no unconditional `taskkill`**.
2. Any **lingering** backend/forecast process is force-killed.
3. `waitForProcessGone()` ([main.js:1863](electron/main.js#L1863)) polls until the
   OS confirms each child has exited (up to 4 s each).
4. An extra **1500 ms** grace lets NTFS finish releasing handles.
5. `autoUpdater.quitAndInstall(true, true)` ([main.js:1929](electron/main.js#L1929)):
   - `isSilent = true` → NSIS runs unattended (matches `oneClick:true`).
   - `isForceRunAfter = true` → the app relaunches automatically post-install.
6. If `quitAndInstall` throws, state flips to `error` and `app.exit(1)`.

NSIS then swaps the install dir (`perMachine` / `oneClick`,
[package.json:134-141](package.json#L134)) and relaunches the new version.

---

## 8. IPC contract & UI surface

**Preload bridge** ([electron/preload.js:61-76](electron/preload.js#L61)) exposes
on `window.electronAPI`:

| Renderer call | IPC channel | Main handler |
|---|---|---|
| `getUpdateState()` | `app-update-get-state` | [main.js:5506](electron/main.js#L5506) |
| `checkForUpdates()` | `app-update-check` | [main.js:5519](electron/main.js#L5519) |
| `downloadUpdate()` | `app-update-download` | [main.js:5524](electron/main.js#L5524) |
| `installUpdate()` | `app-update-install` | [main.js:5528](electron/main.js#L5528) |
| `setAutoDownload(b)` | `app-update-set-auto-download` | [main.js:5532](electron/main.js#L5532) |
| `onUpdateStatus(cb)` | listens `app-update-status` (push) | [main.js:901](electron/main.js#L901) |
| `onUpdateReady(cb)` | listens `app-update-ready` (push) | [main.js:1232](electron/main.js#L1232) |

> `setAutoInstallOvernight` survives as an inert shim
> ([main.js:856-861](electron/main.js#L856)) to keep the IPC contract stable for
> older renderers — overnight auto-install was removed in v2.10.5.

**Renderer state & widgets** (`initAppUpdateBridge()`,
[app.js:1677](public/js/app.js#L1677)):
- `applyAppUpdateState()` ([app.js:1306](public/js/app.js#L1306)) fans out to:
  - **Settings summary** `renderAppUpdateSummary()` — version/mode/status fields +
    Check/Download/Install buttons ([app.js:1623](public/js/app.js#L1623)).
  - **Progress toast** `_renderUpdateToast()` — bottom-left pill showing
    checking / available / `Downloading… N%` / ready / installing / error
    ([app.js:1461](public/js/app.js#L1461)).
  - **Update-available modal** with channel badge + releases link (rollback path)
    ([app.js:1327](public/js/app.js#L1327)).
- Buttons wired at [app.js:26830-26834](public/js/app.js#L26830):
  `btnCheckAppUpdate`, `btnDownloadAppUpdate`, `btnInstallAppUpdate`,
  `btnAboutCheckUpdate`.

---

## 9. Offline-recovery fallback (torn-write resilience)

This is the safety net that ties the updater into the power-loss resilience chain.

1. On `update-downloaded`, `stashLastGoodInstaller()`
   ([main.js:1260](electron/main.js#L1260)) atomically copies the
   signature-verified installer (`lastVerifiedInstallerPath`) to
   `%PROGRAMDATA%\InverterDashboard\updates\last-good-installer.exe` (+ a
   `.meta.json` with version/size/timestamp). Write is temp-file + rename so an
   interrupted copy never leaves a partial.
2. If a later boot finds `app.asar` damaged, the survival-boot integrity gate
   ([main.js:106-131](electron/main.js#L106)) opens the **recovery dialog**
   ([electron/recoveryDialog.js](electron/recoveryDialog.js)).
3. **Reinstall Now** spawns the stashed installer with `/S`
   ([recoveryDialog.js:143-152](electron/recoveryDialog.js#L143)) — silent,
   offline, no network needed — converting a torn-write into a ~60 s recovery.

The NSIS `customInstall` seeds the first stash, and every signed auto-update
refreshes it — do **not** remove the stash path, the `app.asar.sha512` sidecar,
or the hoisted `uncaughtException` handler (see `CLAUDE.md` → Power-Loss
Resilience).

---

## 10. Build & publish side (how releases reach the updater)

From [package.json:134-149](package.json#L134) and the release workflow
(`.claude/skills/adsi-dashboard/references/build-release.md`):

- **electron-builder** publishes with `provider: github`, `owner: mclards`,
  `repo: ADSI-Dashboard`, `releaseType: release`.
- **NSIS**: `oneClick: true`, `perMachine: true`,
  `artifactName: Inverter-Dashboard-Setup-${version}.exe`,
  custom `scripts/installer.nsh`.
- A published release carries exactly three assets the updater consumes:
  - `Inverter-Dashboard-Setup-<version>.exe` — the installer
  - `Inverter-Dashboard-Setup-<version>.exe.blockmap` — differential-download map
  - `latest.yml` — version + path + **SHA-512** that `electron-updater` reads to
    decide "is there an update?" and to verify the download.
- The signed-build gates (signing required → post-build signature verification →
  size floor + SHA-512 log) guarantee the published binary matches what
  `latest.yml` claims, so the runtime SHA-512 + thumbprint checks pass.

> Unsigned builds (`ADSI_ALLOW_UNSIGNED=1`) break auto-update for existing signed
> installs — never publish one.

---

## 11. End-to-end sequence (happy path, installer mode)

```
                          ┌──────────────────────────────────────────────┐
 App launch (packaged) ──▶│ getAppUpdateMode() = "installer"             │
                          │ initAppUpdater() → setFeedURL(github)        │
                          └──────────────────────────────────────────────┘
                                          │  (+8s, one-shot)
                                          ▼
        autoUpdater.checkForUpdates() ── reads latest.yml on GitHub
                                          │
                   ┌──────────────────────┴───────────────────────┐
        up-to-date │                                               │ update-available
                   ▼                                               ▼
            status "up-to-date"                      status "update-available"
            toast: "Up to date"                      modal + toast "vX available"
                                                                   │
                                          autoDownload?  ──────────┤
                                              OFF (default)        │ ON
                                                   │               │
                                  operator clicks  │               │ (auto)
                                  "Download Update"▼               ▼
                                       autoUpdater.downloadUpdate()
                                                   │
                              download-progress ──▶ toast "Downloading N%"
                                                   │
                              SHA-512 (latest.yml) + thumbprint pin verify
                                                   │
                                          update-downloaded
                                   ├─ stashLastGoodInstaller() → ProgramData
                                   └─ status "downloaded", push app-update-ready
                                                   │
                                   Update-Ready modal / Install button
                                                   │ operator clicks "Restart & Install"
                                                   ▼
                                   Install-confirm modal (~60s outage warning)
                                                   │ Proceed
                                                   ▼
                          requestAppShutdown({action:"install"})
                            └─ stop files → graceful Python exit
                            └─ force-kill stragglers + waitForProcessGone
                            └─ +1500ms NTFS handle grace
                                                   ▼
                          autoUpdater.quitAndInstall(silent=true, forceRunAfter=true)
                                                   ▼
                          NSIS replaces files (perMachine, oneClick)
                                                   ▼
                          App relaunches on the new version automatically
```

---

## 12. Key invariants (do not regress)

- **Install is never automatic.** `autoInstallOnAppQuit = false`; no polling/overnight
  timer. Only an explicit click installs.
- **Confirmation is never skipped** before install (modal, or native `confirm`
  fallback).
- **Two integrity checks** on every download: SHA-512 (authoritative) + Authenticode
  thumbprint pin (defence-in-depth). Unreadable thumbprint degrades to SHA-512, a
  *mismatch* hard-refuses.
- **Python services must be fully stopped** (handles released) before
  `quitAndInstall`, or the installer fails to overwrite `dist/*.exe`.
- **Preserve updater compatibility with old installed builds** (CLAUDE.md priority
  #3) — keep the `app-update-*` IPC channels and the inert overnight shim.
- **Keep the offline stash + recovery chain intact** — it is what turns a corrupt
  `app.asar` into a 60-second recovery instead of a dead gateway.
