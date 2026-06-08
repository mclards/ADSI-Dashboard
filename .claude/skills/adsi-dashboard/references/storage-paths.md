# Storage Paths and Export Reference

## File and Directory Paths

| Path | Purpose |
|---|---|
| `C:\ProgramData\ADSI-InverterDashboard\license` | License root |
| `C:\ProgramData\ADSI-InverterDashboard\license\license-state.json` | License state |
| `C:\ProgramData\ADSI-InverterDashboard\license\license.dat` | License mirror |
| `HKCU\Software\ADSI\InverterDashboard\License` | Registry mirror |
| `C:\ProgramData\InverterDashboard` | Server and export root (hot DB) |
| `C:\ProgramData\InverterDashboard\archive` | Archive root |
| `C:\Logs\InverterDashboard` | Default export path |
| `C:\Logs\InverterDashboard\All Inverters\Forecast\Analytics` | Forecast analytics export |
| `C:\Logs\InverterDashboard\All Inverters\Forecast\Solcast` | Forecast Solcast export |
| `InverterDashboardBackups` | Cloud provider backup folder |
| `<portable exe dir>\InverterDashboardData` | Legacy portable data root (older deployments only) |

Legacy flat `...\Forecast\<file>` results are relocated automatically into the matching forecast subfolder.

## Forecast Export Naming

Three distinct sources — do not merge prefixes:

| Source | Prefix | Folder |
|---|---|---|
| Trained Day-Ahead (ML, `forecast_dayahead`) | `Trained Day-Ahead vs Actual <res>` / `Trained Day-Ahead <PTxM> AvgTable` | `...\Forecast\Analytics` |
| Solcast Day-Ahead (stored snapshots, `solcast_snapshots`) | `Solcast Day-Ahead vs Actual <res>` / `Solcast Day-Ahead <PTxM> AvgTable` | `...\Forecast\Solcast` |
| Solcast Toolkit (live API preview) | `Solcast Toolkit <PTxM>` / `Solcast Toolkit <PTxM> AvgTable` | `...\Forecast\Solcast` |

## Solcast Toolkit URL Construction

Built server-side from structured settings. Operators enter only:
- **Plant Resource ID** → `solcastToolkitSiteRef`
- **Forecast Days** (1–7, default 2) → `solcastToolkitDays`
- **Resolution** (PT5M/PT10M/PT15M/PT30M/PT60M, default PT5M) → `solcastToolkitPeriod`

Constructed pattern:
```
https://api.solcast.com.au/utility_scale_sites/{resourceId}/recent?view=Toolkit&theme=light&hours={days*24}&period={period}
```

Do not reintroduce a raw URL input field.

## Cloud Backup

OAuth flow: `frontend → /api/backup/auth/:provider/start → Electron BrowserWindow → intercepts localhost:3500/oauth/callback/:provider → returns callbackUrl → frontend POSTs code to callback → server exchanges for tokens`

- **OneDrive**: Azure AD app, PKCE public client, redirect `http://localhost:3500/oauth/callback/onedrive`
- **Google Drive**: GCP project, Desktop app type, redirect `http://localhost:3500/oauth/callback/gdrive`
- **S3**: `server/cloudProviders/s3.js` present as of v2.4.30 baseline
- Token storage: AES-256-GCM in `server/tokenStore.js` with machine-derived key

## Hardware Reference

27 inverters (Ingeteam INGECON), 2–4 nodes each, Modbus TCP, IP range `192.168.1.x`. Default polling interval 0.05 s per inverter.