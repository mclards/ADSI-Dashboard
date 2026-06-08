; installer.nsh — v2.8.10 power-loss resilience (Phase B2)
;
; Seeds %PROGRAMDATA%\InverterDashboard\updates\last-good-installer.exe
; with a copy of the current installer at install time. This guarantees a
; fresh install has a local installer available for offline recovery even
; before the first auto-update cycle runs.
;
; Wired via package.json "build.nsis.include": "scripts/installer.nsh".
; electron-builder injects this into the generated NSIS script.
;
; PROGRAMDATA resolves via $APPDATA\..\..\ProgramData on Windows — we use
; explicit environment lookup ($%PROGRAMDATA%) for clarity and correctness
; on Windows 10/11 under both standard and domain profiles.

!macro customInstall
  ; %PROGRAMDATA% is the per-machine shared data root (C:\ProgramData)
  ReadEnvStr $0 "PROGRAMDATA"
  StrCmp $0 "" skipStash 0

  ; Ensure updates directory exists
  CreateDirectory "$0\InverterDashboard"
  CreateDirectory "$0\InverterDashboard\updates"

  ; Copy the currently-running installer to the recovery stash location.
  ; $EXEPATH is NSIS's canonical path of this installer's own EXE.
  CopyFiles /SILENT "$EXEPATH" "$0\InverterDashboard\updates\last-good-installer.exe"
  DetailPrint "Seeded recovery installer at $0\InverterDashboard\updates\last-good-installer.exe"

  skipStash:
!macroend

!macro customUnInstall
  ; Do NOT delete the stashed installer on uninstall — the operator may
  ; want to reinstall later without downloading. The stash lives in
  ; ProgramData which survives uninstall per our deleteAppDataOnUninstall=false.
!macroend
