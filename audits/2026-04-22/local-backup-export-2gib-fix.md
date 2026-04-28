# Local Backup Export — 2 GiB Cap Hotfix

**Date:** 2026-04-22
**Status:** Implemented + tested
**Severity:** Production blocker — full-system .adsibak export unusable on any plant whose data has grown past ~2 GiB

---

## 1. The incident

Operator clicked **Export .adsibak** on a real plant install. The UI returned:

```
Failed: File size (2239365120) is greater than 2 GiB
```

That's 2.085 GiB. The export aborted entirely — no `.adsibak` was produced.
The whole point of this feature is migration / OS-reinstall recovery, so a
hard cap that grows naturally with plant lifetime is a complete blocker.

---

## 2. Root cause — TWO separate 2 GiB ceilings

It wasn't one bug. It was two stacked ones.

### Cap #1 — PowerShell `Compress-Archive` on Windows PowerShell 5.1

`createPortableBackup` was zipping the package via:

```js
execFileSync("powershell", [
  "-NoProfile", "-Command",
  `Compress-Archive -Path '...\\*' -DestinationPath '...' -Force`,
], { timeout: 300000 });
```

Windows PowerShell 5.1 ships .NET Framework 4.x, whose
`System.IO.Compression.ZipFile` does NOT enable Zip64 extensions on writes.
Any source larger than `System.Int32.MaxValue` (~2 GiB) throws
`File size (...) is greater than 2 GiB` and refuses to write the archive.

`importPortableBackup` and `validatePortableBackup` had the same defect on
the read side via `Expand-Archive`.

### Cap #2 — `fs.readFileSync` in `sha256File`

Even with the zip step fixed, the manifest's checksum collection still hit:

```js
function sha256File(filePath) {
  const data = fs.readFileSync(filePath);   // ← caps at Buffer.constants.MAX_LENGTH ≈ 2 GiB
  return crypto.createHash("sha256").update(data).digest("hex");
}
```

Node's `fs.readFileSync` allocates one contiguous Buffer for the entire
file. Above ~2 GiB it throws
`RangeError [ERR_FS_FILE_TOO_LARGE]: File size (...) is greater than 2 GiB`.
The plant DB itself was over 2 GiB on the operator's machine, so even the
LOCAL backup chain (createLocalBackup → sha256File of `adsi.db`) would have
failed before ever reaching the zip step.

The first regression test I wrote exposed this second ceiling immediately —
it was hidden in production only because the operator typically clicked
Export instead of waiting for an automated checksum.

---

## 3. The fix

### Cap #1 — switch to Node `archiver` + `extract-zip`

Both libraries support Zip64 transparently (archiver auto-enables it the
moment any entry or the cumulative archive crosses the 32-bit threshold;
yauzl/extract-zip read Zip64 archives natively). Both were already
present in `node_modules` as transitive deps:

| Module | Pulled in by | Now |
|---|---|---|
| `archiver` | `exceljs` (runtime) + `electron-builder` (devDep) | **Pinned as direct dependency** to immunise against a future exceljs upgrade dropping it |
| `extract-zip` | `electron` (devDep) + `puppeteer` (devDep) | **Pinned as direct dependency** because both parents are devDeps and electron-builder would NOT have packaged it for production |

Two new helpers on `CloudBackupService`:

| Helper | Replaces | Behaviour |
|---|---|---|
| `_zipDirectory(srcDir, destZip, onProgress)` | `powershell Compress-Archive` | Streams the directory to a `.zip` via archiver. Auto-Zip64. Reports progress as `(processedBytes, totalBytes)` — wired into the existing progress UI for the long compression step. Aborts cleanly + cleans up partial output on error |
| `_extractZip(srcZip, destDir)` | `powershell Expand-Archive` | Streams via yauzl. Honours Zip64 transparently. Async — does NOT block the event loop |

Three call sites swapped:

1. [server/cloudBackup.js createPortableBackup](../../server/cloudBackup.js) — Compress-Archive → `_zipDirectory`
2. [server/cloudBackup.js importPortableBackup](../../server/cloudBackup.js) — Expand-Archive → `_extractZip` (also dropped the temp-zip copy step that doubled disk I/O)
3. [server/cloudBackup.js validatePortableBackup](../../server/cloudBackup.js) — Expand-Archive → `_extractZip` (same simplification)

Also removed the now-unused `execFileSync` import.

### Cap #2 — streaming sha256

```js
function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024); // 1 MiB chunks
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
      if (bytesRead > 0) hash.update(buf.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}
```

Same SHA-256 output, constant memory, works for arbitrarily large files.
Still synchronous — by design, since manifest checksum collection is a
synchronous batch and doesn't benefit from yielding the loop here.

---

## 4. Side benefits of the fix

| Old behaviour | New behaviour |
|---|---|
| Whole-archive size capped at ~2 GiB (PowerShell) and ~2 GiB per file (sha256) | Limited only by available disk + filesystem (NTFS: 256 TB) |
| Compression step `execFileSync` blocked the entire Node event loop for the duration (often 30-60 sec on a 500 MB+ archive). The bootstrap-restore wizard window appeared frozen. | Streaming through Node — event loop stays responsive. WS broadcasts, IPC, UI repaints all keep ticking |
| Import path copied the source `.adsibak` to a tmp `.zip` before extracting (full archive size of disk I/O) | extract-zip reads the archive in place — half the disk I/O, faster on large archives |
| Compression progress reported only as a single "Compressing backup…" string — no bytes-so-far feedback | `_zipDirectory` exposes `(processed, total)` callback wired into the local-backup progress slice (70-90%) so the UI moves through compression |
| `Expand-Archive` would emit Windows-y stderr noise into the parent's stderr stream on any zip warning | yauzl reports warnings as JS events; we filter ENOENT (sub-file rotated mid-zip) and reject on real failures |

---

## 5. Test coverage

New file [server/tests/portableBackupRoundTrip.test.js](../../server/tests/portableBackupRoundTrip.test.js):

| Test | Verifies |
|---|---|
| `_zipDirectory + _extractZip handle deep trees` | zip header (PK\x03\x04) is real; round-trip preserves nested files |
| `_zipDirectory onProgress fired` | progress callback is monotonic and runs at least once per multi-file archive |
| `Streaming sha256 handles >2 GiB files` | builds a 2.5 GiB sparse file, runs `_verifyChecksums` against it, asserts no `ERR_FS_FILE_TOO_LARGE` |
| `createLocalBackup + restoreBackup round-trip` | end-to-end of the in-app local backup chain via the new helpers |

```
node server/tests/portableBackupRoundTrip.test.js   PASS (4/4)
node server/tests/cloudBackupRestoreSafety.test.js  PASS (8/8 — pre-existing)
node server/tests/backupHealthRegistry.test.js      PASS (pre-existing)
```

### What's NOT automated

- Full `createPortableBackup → importPortableBackup → restorePortableBackup`
  end-to-end on a real machine. `createPortableBackup` reads
  `archive/license/auth` directly from `getNewRoot()` (a static resolver
  pointing at the real `%PROGRAMDATA%\InverterDashboard`), which makes
  unit-isolation awkward. Covered by manual smoke per audit §6.
- A real >2 GiB end-to-end zip+unzip. The sparse-file test proves the
  sha256 path doesn't choke; the small round-trip proves the zip path
  works; combining the two is left to manual smoke on the operator's
  actual ~2.2 GiB plant DB.

---

## 6. Manual smoke checklist

On a Windows machine WITH a real plant install:

- [ ] `npm run rebuild:native:electron` (after the `npm install` that
      added `archiver`/`extract-zip` as direct deps — needed because
      the postinstall hook re-runs electron-builder install-app-deps)
- [ ] Launch dashboard → Settings → Local Backup
- [ ] Click **Export .adsibak** → choose a destination
- [ ] Watch progress bar advance through compression (should be smooth, not frozen)
- [ ] Verify the produced `.adsibak` is `> 2 GiB` if your plant DB is that big
- [ ] **Validate on a different machine:** copy the file to another box, click Import → preview should show real manifest, file count, row counts
- [ ] Click Restore → dashboard restarts → verify DB and settings landed
- [ ] Bootstrap restore: clean install on a second VM → click "Restore from Backup…" on the license prompt → wizard validates the same `.adsibak` cleanly

---

## 7. Risks accepted

| Risk | Mitigation |
|---|---|
| `archiver`'s default zlib level 6 is slower than PowerShell's default level 1 | Trade-off accepted: smaller archives matter for migration; CPU cost is bounded by Node streaming |
| Pinned versions (`^5.3.2`, `^2.0.1`) could pick up a breaking minor in the future | Caret allows patches and minors; standard risk profile |
| `archiver` aborts cleanly on error but the partial `.zip` cleanup uses `fs.unlinkSync` which can race with antivirus | Wrapped in try/catch — leaves the file behind only in catastrophic cases. The next export overwrites |

---

## 8. Lessons learned

1. **Never trust PowerShell built-ins for production data plumbing.** They
   bring along whatever .NET ceiling the host's PowerShell version was
   compiled against.
2. **A streaming-vs-bulk audit is overdue.** Anywhere we call
   `fs.readFileSync` on an unknown-size file is a latent ERR_FS_FILE_TOO_LARGE
   bomb. Searching the rest of the codebase: only small JSON / config files
   today, no other large-file reads.
3. **Transitive deps are not safe to depend on.** `extract-zip` was only
   pulled in by devDependencies — electron-builder would have shipped a
   build that DID NOT include it. Any direct `require("extract-zip")` in
   production code MUST have an explicit entry in `dependencies`.
4. **The first failing test is a feature, not an irritation.** Writing the
   round-trip test surfaced the second 2 GiB cap (sha256File) immediately —
   if I'd skipped tests, the operator would have hit it on their next
   export attempt with the "fixed" code.

---

## 9. Files changed

| File | Change |
|---|---|
| [package.json](../../package.json) | Pinned `archiver` + `extract-zip` as direct production deps |
| [server/cloudBackup.js](../../server/cloudBackup.js) | New `_zipDirectory` + `_extractZip` helpers; replaced 3 PowerShell call sites; rewrote `sha256File` to streaming I/O; removed unused `execFileSync` import |
| [server/tests/portableBackupRoundTrip.test.js](../../server/tests/portableBackupRoundTrip.test.js) | New — covers zip helpers, progress callback, streaming sha256 against 2.5 GiB sparse file, and the local-backup round-trip via new helpers |
| [public/bootstrap-restore.js](../../public/bootstrap-restore.js) | Updated comment that referenced the old `execFileSync(PowerShell)` freeze (no longer accurate) |
| [audits/2026-04-22/bootstrap-restore-audit.md](bootstrap-restore-audit.md) | Marked the "execFileSync blocks main process" risk as Resolved |
