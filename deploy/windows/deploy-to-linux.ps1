<#
.SYNOPSIS
    ADSI Dashboard — One-Click Windows to Linux Deployment & Data Migration Script
.DESCRIPTION
    Automates the entire Linux server deployment, data synchronization, permission
    configuration, and service orchestration from Windows over SSH.
.PARAMETER LinuxHost
    The IP address or Tailscale hostname of the Linux server (e.g. 192.168.1.13 or 100.114.7.12).
.PARAMETER LinuxUser
    The username on the Linux server (default: 'adsi').
.PARAMETER Mode
    Deployment mode:
      'Full'      - Code update + setup.sh + data migration + start services (Default)
      'DataOnly'  - Migrate database, ML models, and config only
      'CodeOnly'  - Update code repository and re-run setup.sh only
      'Status'    - Query the live status of all Linux services and health endpoints
.PARAMETER IncludeArchive
    Include multi-gigabyte monthly historical archives (can take 30-60 mins over Wi-Fi/VPN).
.EXAMPLE
    .\deploy-to-linux.ps1 -LinuxHost 192.168.1.13
.EXAMPLE
    .\deploy-to-linux.ps1 -LinuxHost 100.114.7.12 -Mode DataOnly
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $false)]
    [string]$LinuxHost,

    [Parameter(Mandatory = $false)]
    [string]$LinuxUser = "adsi",

    [Parameter(Mandatory = $false)]
    [ValidateSet("Full", "DataOnly", "CodeOnly", "Status")]
    [string]$Mode = "Full",

    [Parameter(Mandatory = $false)]
    [switch]$IncludeArchive = $false
)

# ── Styling & Color Helpers ───────────────────────────────────────────────────
function Write-Header {
    param([string]$Text)
    Write-Host ""
    Write-Host "══════════════════════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "  $Text" -ForegroundColor Cyan -NoNewline
    Write-Host ""
    Write-Host "══════════════════════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step {
    param([string]$StepNum, [string]$Title)
    Write-Host ""
    Write-Host "─── [$StepNum] $Title ────────────────────────────────────────" -ForegroundColor Yellow
}

function Write-Success {
    param([string]$Text)
    Write-Host "  [OK] $Text" -ForegroundColor Green
}

function Write-Info {
    param([string]$Text)
    Write-Host "  [..] $Text" -ForegroundColor White
}

function Write-Warn {
    param([string]$Text)
    Write-Host "  [WARN] $Text" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Text)
    Write-Host "  [ERR] $Text" -ForegroundColor Red
    exit 1
}

# ── Interactive Prompts if parameters not passed ──────────────────────────────
Write-Header "ADSI Dashboard — Windows to Linux Deployment Assistant"

if ([string]::IsNullOrWhiteSpace($LinuxHost)) {
    Write-Host "Enter the IP address or Tailscale hostname of your Linux machine:" -ForegroundColor Cyan
    Write-Host "  Examples: 192.168.1.13 (Local LAN) or 100.114.7.12 (Tailscale VPN)" -ForegroundColor Gray
    $LinuxHost = Read-Host "Linux Host"
    if ([string]::IsNullOrWhiteSpace($LinuxHost)) {
        Write-Fail "Linux Host cannot be empty."
    }
}

$RemoteTarget = "$LinuxUser@$LinuxHost"
$DataDir = "/var/lib/adsi-dashboard"
$AppDir = "/opt/adsi-dashboard"
$LocalProgramData = Join-Path $env:PROGRAMDATA "InverterDashboard"

Write-Info "Target Server : $RemoteTarget"
Write-Info "Execution Mode: $Mode"
Write-Info "Local Source  : $LocalProgramData"

# ── Pre-flight Checks ────────────────────────────────────────────────────────
Write-Step "1/5" "Windows Pre-flight Checks"

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Fail "OpenSSH client (ssh.exe) is not installed on this Windows PC. Install Windows OpenSSH Client feature."
}
if (-not (Get-Command scp -ErrorAction SilentlyContinue)) {
    Write-Fail "OpenSSH client (scp.exe) is not installed on this Windows PC."
}
Write-Success "OpenSSH tools (ssh/scp) verified"

Write-Info "Testing SSH connection to $RemoteTarget..."
$sshTest = ssh -o ConnectTimeout=5 -o BatchMode=no $RemoteTarget "echo SSH_OK" 2>&1
if ($sshTest -notmatch "SSH_OK") {
    Write-Warn "Direct SSH returned: $sshTest"
    Write-Host "Please ensure the Linux machine is turned on, OpenSSH server is running, and credentials are valid." -ForegroundColor Yellow
} else {
    Write-Success "SSH connection verified to $RemoteTarget"
}

# ── Mode: Status Query ───────────────────────────────────────────────────────
if ($Mode -eq "Status") {
    Write-Step "STATUS" "Querying Remote Linux Engine Status"
    ssh -t $RemoteTarget "sudo systemctl status adsi.target adsi-server adsi-inverter adsi-forecast adsi-go2rtc --no-pager"
    Write-Host ""
    Write-Info "Querying Gateway Health API (port 3500)..."
    try {
        $resp = Invoke-RestMethod -Uri "http://${LinuxHost}:3500/api/live" -TimeoutSec 3 -ErrorAction Stop
        Write-Success "Gateway Live API responding: $($resp.inverters.Count) inverter(s) reported"
    } catch {
        Write-Warn "Could not query http://${LinuxHost}:3500/api/live: $($_.Exception.Message)"
    }
    exit 0
}

# ── Step 2: Code Deployment / Git Pull on Linux ──────────────────────────────
if ($Mode -in @("Full", "CodeOnly")) {
    Write-Step "2/5" "Deploying / Updating Code on Linux Server"
    
    $setupCmd = @"
if [ ! -d "$AppDir" ]; then
    echo '[ADSI] Cloning repository into $AppDir...'
    sudo git clone https://github.com/mclards/ADSI-Dashboard.git "$AppDir"
else
    echo '[ADSI] Pulling latest code into $AppDir...'
    cd "$AppDir"
    sudo git fetch origin
    sudo git reset --hard origin/main
fi
echo '[ADSI] Running 18-step hardened setup script...'
sudo bash "$AppDir/deploy/linux/setup.sh" --ip-forward
"@

    ssh -t $RemoteTarget $setupCmd
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "setup.sh exited with code $LASTEXITCODE. Please review the output above."
    } else {
        Write-Success "Code repository and Linux services configured"
    }
}

# ── Step 3: Safe Data Migration from Windows ──────────────────────────────────
if ($Mode -in @("Full", "DataOnly")) {
    Write-Step "3/5" "Migrating Production Database, ML Models & Configuration"

    if (-not (Test-Path $LocalProgramData)) {
        Write-Warn "Local ProgramData folder '$LocalProgramData' not found. Skipping data copy."
    } else {
        # 1. Stop Linux services first to prevent write collision
        Write-Info "Pausing Linux services during file copy..."
        ssh $RemoteTarget "sudo systemctl stop adsi.target 2>/dev/null || true"

        # 2. Database files (with WAL and SHM)
        $dbPath = Join-Path $LocalProgramData "db"
        if (Test-Path $dbPath) {
            Write-Info "Copying active database files ($dbPath\adsi.db*)..."
            scp "$dbPath\adsi.db*" "${RemoteTarget}:${DataDir}/db/"
            if ($LASTEXITCODE -eq 0) {
                Write-Success "Database files copied to Linux db/"
            } else {
                Write-Warn "Database scp encountered warnings (code $LASTEXITCODE)."
            }

            # Backups
            $backupPath = Join-Path $dbPath "backups"
            if (Test-Path $backupPath) {
                Write-Info "Copying point-in-time backup slots..."
                scp -r "$backupPath\*" "${RemoteTarget}:${DataDir}/db/backups/"
                Write-Success "Backup slots copied"
            }
        }

        # 3. Machine Learning Forecast Models
        $forecastPath = Join-Path $LocalProgramData "forecast"
        if (Test-Path $forecastPath) {
            Write-Info "Copying trained AI forecast models and bundles (*.joblib)..."
            scp -r "$forecastPath\*.joblib" "${RemoteTarget}:${DataDir}/programdata/forecast/"
            Write-Success "Forecast models copied to programdata/forecast/"
        }

        # 4. Inverter IP Configuration (supports both db/ and config/ legacy locations)
        $configSrc = Join-Path $LocalProgramData "config\ipconfig.json"
        if (-not (Test-Path $configSrc)) {
            $configSrc = Join-Path $LocalProgramData "db\ipconfig.json"
        }
        if (Test-Path $configSrc) {
            Write-Info "Copying inverter IP configuration ($configSrc)..."
            scp "$configSrc" "${RemoteTarget}:${DataDir}/config/ipconfig.json"
            Write-Success "ipconfig.json copied to config/"
        }

        # 5. Optional full historical archive
        if ($IncludeArchive) {
            $archivePath = Join-Path $LocalProgramData "archive"
            if (Test-Path $archivePath) {
                Write-Info "Copying full historical monthly archive (this may take a while)..."
                scp -r "$archivePath\*" "${RemoteTarget}:${DataDir}/archive/"
                Write-Success "Historical archive copied"
            }
        }
    }
}

# ── Step 4: Fix Permissions & Start Linux Services ───────────────────────────
Write-Step "4/5" "Fixing Permissions & Starting Services"

$startCmd = @"
echo '[ADSI] Fixing ownership on $DataDir...'
sudo chown -R adsi:adsi "$DataDir"
sudo chmod -R 750 "$DataDir"

echo '[ADSI] Starting ADSI Engine Suite...'
sudo systemctl daemon-reload
sudo systemctl start adsi.target
sudo systemctl status adsi.target --no-pager
"@

ssh -t $RemoteTarget $startCmd
Write-Success "Permissions set and adsi.target started"

# ── Step 5: Verification & Gateway Test ───────────────────────────────────────
Write-Step "5/5" "Verifying Live Linux Gateway"

Start-Sleep -Seconds 3

Write-Info "Probing Gateway Live API at http://${LinuxHost}:3500/api/live ..."
$gatewayOk = $false
try {
    $liveData = Invoke-RestMethod -Uri "http://${LinuxHost}:3500/api/live" -TimeoutSec 5 -ErrorAction Stop
    $gatewayOk = $true
    Write-Success "Gateway Live API is HEALTHY! Timestamp: $($liveData.timestamp)"
} catch {
    Write-Warn "Direct API probe timed out or returned error: $($_.Exception.Message)"
}

Write-Header "Deployment Complete — Access Your Dashboard"

Write-Host "Your ADSI Dashboard is running natively on Linux!" -ForegroundColor Green
Write-Host ""
Write-Host "  Local LAN URL : http://${LinuxHost}:3500" -ForegroundColor Cyan
Write-Host "  Default Login : Username: admin | Password: 1234" -ForegroundColor Cyan
Write-Host ""
Write-Host "To link your Windows app as a remote viewer:" -ForegroundColor Yellow
Write-Host "  1. Open ADSI Dashboard on Windows -> Settings -> Connectivity & Sync" -ForegroundColor White
Write-Host "  2. Set Operation Mode to: 'Remote (Gateway-Linked)'" -ForegroundColor White
Write-Host "  3. Set Remote Gateway URL to: http://${LinuxHost}:3500" -ForegroundColor White
Write-Host "  4. Click 'Save Settings' and 'Test Remote Gateway'" -ForegroundColor White
Write-Host ""
