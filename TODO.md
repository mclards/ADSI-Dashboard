## Cloud Backup + Restore Implementation Prompt

Implement an MVP “Cloud Backup + Restore” feature for this Electron + Node dashboard app.

Main goal:
Support OneDrive and Google Drive backups, allow provider selection, include email guidance, add date-based selection, and make downloaded/pulled backups usable by the dashboard again.

Requirements

1) Cloud providers
- Support OneDrive and Google Drive.
- Add provider selector:
  - Auto
  - OneDrive
  - Google Drive
  - Both

2) Email input + recommendation
- Add email input field (`type="email"`).
- Analyze domain and suggest provider:
  - outlook/hotmail/live/msn => suggest OneDrive
  - gmail/googlemail => suggest Google Drive
  - others => neutral suggestion
- Do not force provider choice.

3) Backup scope + schedule
- Scope selector:
  - Database
  - Config files
  - Logs (optional)
- Schedule selector:
  - Manual
  - Daily
  - Every 6 hours

4) Date selector (new)
- Add “Backup Date” selector for manual backup metadata/tagging.
- Add “Restore Date” selector to filter/select cloud backup snapshots by date.
- Show backup list with date/time, provider, size, and status.

5) Backup actions
- “Backup Now” button.
- Local-first flow:
  - create local snapshot package
  - verify checksum
  - upload to selected provider(s)
- Keep backup history in app.

6) Pull/Download + use again in dashboard (new)
- Add “Pull from Cloud” / “Download Backup” action.
- Add “Restore to Dashboard” action that can apply pulled backup to active app data.
- Restore must support:
  - DB restore
  - config restore
  - compatibility checks (schema/app version)
- Before restore, auto-create a safety local backup for rollback.

7) Security
- OAuth 2.0 for both providers (no cloud password input).
- Secure token storage (encrypted at rest).
- Never log tokens/secrets.

8) Reliability
- Retry queue for failed uploads.
- Integrity validation (checksum/hash + manifest).
- Clear success/failure UI with last backup/restore timestamps.

9) Upload progress + non-blocking operation (new)
- Show a visible upload/backup progress icon and status:
  - queued
  - uploading/backing up
  - success
  - failed
- Include progress percentage and latest activity timestamp.
- Backup/upload must run in background during normal dashboard operation.
- User must still be able to use the dashboard while backup/upload is in progress.
- Automatic background backup/upload should continue based on selected schedule.
- If app is busy, queue and resume automatically without blocking core UI.

Technical expectation
- Backup package must be restorable by this dashboard app after pull/download.
- Include manifest metadata:
  - app version
  - schema version
  - created_at
  - provider
  - scope
  - checksum

Deliverables
1. UI updates in Settings (Cloud Backup panel).
2. Backend services for backup, upload adapters, pull/download, and restore.
3. Token security utility.
4. Migration-safe restore logic with rollback safeguard.
5. Short test checklist (backup, pull, restore, rollback, provider switching).

At the end, include:
- What was implemented
- Known limitations
- Recommended architecture and why (local-first + cloud sync vs cloud-only)
