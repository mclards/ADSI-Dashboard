#!/usr/bin/env bash
# =============================================================================
# ADSI Dashboard — Linux Production Setup Script
# =============================================================================
# Supports : Ubuntu 22.04 / 24.04 LTS, Debian 12, Raspberry Pi OS 64-bit
# Author   : Engr. Clariden Montaño REE
# Plan ref : plans/2026-08-23-linux-environment-deployment-and-remote-streaming.md
# =============================================================================
#
# USAGE
#   sudo bash deploy/linux/setup.sh [OPTIONS]
#
# OPTIONS
#   --app-dir   <path>   App install dir      (default: /opt/adsi-dashboard)
#   --data-dir  <path>   Persistent data dir  (default: /var/lib/adsi-dashboard)
#   --skip-ufw           Skip UFW firewall configuration
#   --skip-chrony        Skip Chrony RTC offline clock configuration
#   --skip-tailscale     Skip Tailscale installation
#   --skip-go2rtc        Skip go2rtc binary download
#   --skip-npm           Skip npm install (use if node_modules already present)
#   --skip-python        Skip Python virtualenv/pip (use if venv already present)
#   --ip-forward         Enable Linux IP forwarding (required for Tailscale subnet routing)
#
# WHAT THIS SCRIPT DOES (in order)
#    1. Install OS packages (build tools, python3, ffmpeg, sqlite3, chrony, ufw …)
#    2. Set timezone to Asia/Manila (UTC+8) — mandatory for slot-binning parity
#    3. Install Node.js 20 LTS via NodeSource
#    4. Create 'adsi' system user + add to 'dialout' group (RS-485 serial)
#    5. Create all persistent storage directories under DATA_DIR
#    6. Install /etc/default/adsi-dashboard environment file
#    7. Install all Systemd unit files + adsi.target, reload daemon
#    8. npm install --omit=dev + npm rebuild better-sqlite3 (Node ABI)
#    9. Create Python venv + pip install -r requirements.txt
#   10. Download go2rtc_linux_amd64 binary (camera streaming workaround)
#   11. UFW firewall: lock ports 3500 & 8555 open; deny 9100, 9200 externally
#   12. Chrony: configure hardware RTC as stratum-10 offline clock fallback
#   13. Tailscale: install daemon + enable subnet routing (optional)
#   14. Linux IP forwarding for Tailscale subnet routing (optional)
#   15. SSD/NVMe write-barrier flush via hdparm (power-loss resilience)
#   16. Enable all Systemd services (does NOT auto-start — operator confirms)
#   17. Print post-setup checklist (data migration, go2rtc config, verification)
#
# =============================================================================

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
APP_DIR="/opt/adsi-dashboard"
DATA_DIR="/var/lib/adsi-dashboard"
LOG_DIR="/var/log/adsi-dashboard"
ETC_DEFAULT="/etc/default/adsi-dashboard"
SYSTEMD_DIR="/etc/systemd/system"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SKIP_UFW=false
SKIP_CHRONY=false
SKIP_TAILSCALE=false
SKIP_GO2RTC=false
SKIP_NPM=false
SKIP_PYTHON=false
ENABLE_IP_FORWARD=false

GO2RTC_VERSION="v1.9.8"
GO2RTC_ARCH="amd64"   # change to arm64 for Raspberry Pi / ARM servers

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir)       APP_DIR="$2";       shift 2 ;;
    --data-dir)      DATA_DIR="$2";      shift 2 ;;
    --skip-ufw)      SKIP_UFW=true;      shift   ;;
    --skip-chrony)   SKIP_CHRONY=true;   shift   ;;
    --skip-tailscale)SKIP_TAILSCALE=true;shift   ;;
    --skip-go2rtc)   SKIP_GO2RTC=true;   shift   ;;
    --skip-npm)      SKIP_NPM=true;      shift   ;;
    --skip-python)   SKIP_PYTHON=true;   shift   ;;
    --ip-forward)    ENABLE_IP_FORWARD=true; shift ;;
    --arm64)         GO2RTC_ARCH="arm64";shift   ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${GREEN}[ADSI]${NC} $*"; }
step()    { echo -e "\n${CYAN}━━━ $* ━━━${NC}"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERR]${NC}  $*"; exit 1; }
success() { echo -e "${GREEN}  ✔${NC} $*"; }
skip()    { echo -e "${YELLOW}  ↷${NC} $* (skipped)"; }

# ── Root check ────────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || error "Run as root: sudo bash deploy/linux/setup.sh"

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║         ADSI Dashboard — Linux Production Setup          ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
info "App directory  : ${APP_DIR}"
info "Data directory : ${DATA_DIR}"
info "go2rtc version : ${GO2RTC_VERSION} (${GO2RTC_ARCH})"
echo ""

# ── Detect OS ─────────────────────────────────────────────────────────────────
. /etc/os-release 2>/dev/null || true
OS_ID="${ID:-unknown}"
OS_CODENAME="${VERSION_CODENAME:-}"
info "Detected OS: ${PRETTY_NAME:-Linux}"

# ── Step 1: OS packages ───────────────────────────────────────────────────────
step "1 / 17  OS packages"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  curl wget git build-essential ufw chrony \
  python3 python3-venv python3-dev python3-pip \
  ffmpeg sqlite3 libsqlite3-dev \
  pkg-config libopenblas-dev gfortran \
  tzdata ca-certificates hdparm lsof
success "Base OS packages installed"

# Electron / GUI display libs (safe on headless — just unused)
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 libasound2 2>/dev/null || true
success "Display libraries installed (GUI mode optional support)"

# ── Step 2: Timezone ──────────────────────────────────────────────────────────
step "2 / 17  Timezone → Asia/Manila (UTC+8)"
timedatectl set-timezone Asia/Manila
TZ_CHECK=$(date +%z)
if [[ "$TZ_CHECK" == "+0800" ]]; then
  success "Timezone set to Asia/Manila (+08:00) — slot-binning invariant satisfied"
else
  warn "Timezone check returned '${TZ_CHECK}' (expected +0800). Verify with: timedatectl"
fi

# ── Step 3: Node.js 20 LTS ────────────────────────────────────────────────────
step "3 / 17  Node.js 20 LTS"
CURRENT_NODE_MAJOR=""
if command -v node &>/dev/null; then
  CURRENT_NODE_MAJOR=$(node --version | cut -d. -f1 | tr -d 'v')
fi
if [[ "$CURRENT_NODE_MAJOR" == "20" ]]; then
  success "Node.js $(node --version) already installed"
else
  info "Installing Node.js 20 LTS via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>&1 | tail -3
  apt-get install -y nodejs 2>&1 | tail -3
  success "Node.js $(node --version) installed"
fi

# ── Step 4: System user ───────────────────────────────────────────────────────
step "4 / 17  System user 'adsi'"
if ! id adsi &>/dev/null; then
  useradd -r -s /bin/false -d "${DATA_DIR}" -m adsi
  success "System user 'adsi' created"
else
  success "System user 'adsi' already exists"
fi
usermod -a -G dialout adsi 2>/dev/null && \
  success "User 'adsi' added to 'dialout' group (RS-485 serial access)" || true

# ── Step 5: Storage directories ───────────────────────────────────────────────
step "5 / 17  Storage directories"
mkdir -p "${DATA_DIR}"/{db,db/backups,archive,forecast,weather,config,cloud_backups}
mkdir -p "${DATA_DIR}/programdata/go2rtc"
mkdir -p "${DATA_DIR}/lifecycle"
mkdir -p "${LOG_DIR}"
chown -R adsi:adsi "${DATA_DIR}" "${LOG_DIR}"
chmod -R 750 "${DATA_DIR}" "${LOG_DIR}"
success "Storage tree created at ${DATA_DIR}"
success "Log directory created at ${LOG_DIR}"

# ── Step 6: Environment file ──────────────────────────────────────────────────
step "6 / 17  /etc/default/adsi-dashboard"
if [[ -f "${ETC_DEFAULT}" ]]; then
  cp "${ETC_DEFAULT}" "${ETC_DEFAULT}.bak.$(date +%Y%m%d%H%M%S)"
  warn "Existing env file backed up to ${ETC_DEFAULT}.bak.*"
fi
cp "${SCRIPT_DIR}/default/adsi-dashboard" "${ETC_DEFAULT}"
# Patch DATA_DIR into env file in case --data-dir override was used
sed -i "s|ADSI_DATA_DIR=.*|ADSI_DATA_DIR=${DATA_DIR}/db|" "${ETC_DEFAULT}"
sed -i "s|ADSI_PORTABLE_DATA_DIR=.*|ADSI_PORTABLE_DATA_DIR=${DATA_DIR}|" "${ETC_DEFAULT}"
sed -i "s|PROGRAMDATA=.*|PROGRAMDATA=${DATA_DIR}/programdata|" "${ETC_DEFAULT}"
chmod 644 "${ETC_DEFAULT}"
success "Environment file installed → ${ETC_DEFAULT}"

# ── Step 7: Systemd unit files ────────────────────────────────────────────────
step "7 / 17  Systemd unit files"
for unit in adsi-inverter.service adsi-forecast.service adsi-server.service adsi-go2rtc.service adsi.target; do
  SRC="${SCRIPT_DIR}/systemd/${unit}"
  DST="${SYSTEMD_DIR}/${unit}"
  if [[ ! -f "$SRC" ]]; then
    warn "Missing unit file: ${SRC} — skipping"
    continue
  fi
  cp "$SRC" "$DST"
  # Patch APP_DIR into unit files in case --app-dir override was used
  sed -i "s|/opt/adsi-dashboard|${APP_DIR}|g" "$DST"
  chmod 644 "$DST"
  success "Installed ${unit}"
done
systemctl daemon-reload
success "Systemd daemon reloaded"

# ── Step 8: npm install ───────────────────────────────────────────────────────
step "8 / 17  npm install + rebuild better-sqlite3"
if $SKIP_NPM; then
  skip "npm install"
elif [[ -f "${APP_DIR}/package.json" ]]; then
  cd "${APP_DIR}"
  info "Running npm install --omit=dev..."
  npm install --omit=dev 2>&1 | tail -5
  info "Rebuilding better-sqlite3 native binding for Node.js ABI..."
  npm rebuild better-sqlite3 2>&1 | tail -3
  success "npm install + native rebuild complete"
else
  warn "package.json not found at ${APP_DIR}"
  warn "Copy the codebase to ${APP_DIR} first, then run: sudo npm install --omit=dev && npm rebuild better-sqlite3"
fi

# ── Step 9: Python virtualenv ─────────────────────────────────────────────────
step "9 / 17  Python virtualenv + pip install"
VENV="${APP_DIR}/venv"
if $SKIP_PYTHON; then
  skip "Python virtualenv"
else
  if [[ ! -f "${VENV}/bin/activate" ]]; then
    info "Creating Python virtualenv at ${VENV}..."
    python3 -m venv "${VENV}"
  else
    info "Virtualenv already exists at ${VENV}"
  fi
  info "Upgrading pip, setuptools, and wheel..."
  "${VENV}/bin/pip" install --upgrade pip setuptools wheel -q
  if [[ -f "${APP_DIR}/requirements.txt" ]]; then
    info "Installing from requirements.txt..."
    "${VENV}/bin/pip" install -r "${APP_DIR}/requirements.txt"
    success "Python dependencies installed"
  else
    warn "requirements.txt not found at ${APP_DIR}/requirements.txt"
    warn "Run manually: ${VENV}/bin/pip install -r requirements.txt"
  fi
fi

# ── Step 10: go2rtc binary ────────────────────────────────────────────────────
step "10 / 17  go2rtc ${GO2RTC_VERSION} binary (camera streaming)"
GO2RTC_DIR="${APP_DIR}/server/go2rtc"
GO2RTC_BIN="${GO2RTC_DIR}/go2rtc_linux_${GO2RTC_ARCH}"
if $SKIP_GO2RTC; then
  skip "go2rtc download"
elif [[ -f "$GO2RTC_BIN" ]]; then
  success "go2rtc binary already exists at ${GO2RTC_BIN}"
else
  GO2RTC_URL="https://github.com/AlexxIT/go2rtc/releases/download/${GO2RTC_VERSION}/go2rtc_linux_${GO2RTC_ARCH}"
  mkdir -p "${GO2RTC_DIR}"
  info "Downloading go2rtc from GitHub..."
  if wget -q --show-progress -O "${GO2RTC_BIN}" "${GO2RTC_URL}"; then
    chmod +x "${GO2RTC_BIN}"
    chown adsi:adsi "${GO2RTC_BIN}"
    success "go2rtc downloaded → ${GO2RTC_BIN}"
  else
    warn "go2rtc download failed. Download manually:"
    warn "  wget -O ${GO2RTC_BIN} ${GO2RTC_URL}"
    warn "  chmod +x ${GO2RTC_BIN}"
  fi
fi

# Create a minimal go2rtc.yaml if none exists (prevents crash-loop on first start)
GO2RTC_CFG="${DATA_DIR}/programdata/go2rtc/go2rtc.yaml"
if [[ ! -f "$GO2RTC_CFG" ]]; then
  cat > "$GO2RTC_CFG" <<'YAML'
# go2rtc configuration — ADSI Dashboard
# Add RTSP camera streams here. Example:
# streams:
#   plant_cam: rtsp://admin:password@192.168.1.200:554/stream1
api:
  listen: ":1984"
webrtc:
  listen: ":8555"
YAML
  chown adsi:adsi "$GO2RTC_CFG"
  chmod 640 "$GO2RTC_CFG"
  success "Default go2rtc.yaml created at ${GO2RTC_CFG}"
fi

# ── Step 11: UFW firewall ─────────────────────────────────────────────────────
step "11 / 17  UFW firewall hardening"
if $SKIP_UFW; then
  skip "UFW firewall"
else
  ufw --force reset > /dev/null
  ufw default deny incoming  > /dev/null
  ufw default allow outgoing > /dev/null

  # SSH must stay open before enabling
  ufw allow 22/tcp    comment 'SSH Administration'

  # ADSI locked ports
  ufw allow 3500/tcp  comment 'ADSI Dashboard Gateway (LOCKED)'
  ufw allow 8555/tcp  comment 'go2rtc WebRTC TCP (LOCKED)'
  ufw allow 8555/udp  comment 'go2rtc WebRTC UDP (LOCKED)'

  # Tailscale WireGuard
  ufw allow 41641/udp comment 'Tailscale WireGuard Mesh'

  # Explicit external block for internal-only engine ports
  ufw deny 9100/tcp   comment 'Block external: Inverter Engine (loopback only)'
  ufw deny 9200/tcp   comment 'Block external: Calibrator Engine (loopback only)'
  ufw deny 1984/tcp   comment 'Block external: go2rtc API (loopback only)'

  ufw --force enable  > /dev/null
  success "UFW enabled — ports 3500 & 8555 open; 9100, 9200, 1984 blocked externally"
  ufw status numbered
fi

# ── Step 12: Chrony offline RTC clock ─────────────────────────────────────────
step "12 / 17  Chrony hardware RTC offline timekeeping"
if $SKIP_CHRONY; then
  skip "Chrony configuration"
else
  CHRONY_CONF="/etc/chrony/chrony.conf"
  if [[ ! -f "$CHRONY_CONF" ]]; then
    CHRONY_CONF="/etc/chrony.conf"
  fi
  if [[ -f "$CHRONY_CONF" ]]; then
    # Backup original
    cp "$CHRONY_CONF" "${CHRONY_CONF}.bak.$(date +%Y%m%d%H%M%S)"

    # Remove any existing local / rtconcpu lines to avoid duplication
    sed -i '/^local stratum/d; /^rtconcpu/d; /^rtconutc/d' "$CHRONY_CONF"

    # Append offline RTC fallback block
    cat >> "$CHRONY_CONF" <<'CHRONY'

# ── ADSI Offline RTC Fallback ───────────────────────────────────────────────
# When all upstream NTP servers are unreachable (WAN outage, air-gapped plant),
# Chrony falls back to the hardware CMOS/DS3231 RTC as stratum-10 local source.
# This keeps Asia/Manila clock discipline accurate during extended offline periods.
local stratum 10
rtconcpu
CHRONY
    systemctl enable chrony 2>/dev/null || true
    systemctl restart chrony
    success "Chrony configured with hardware RTC stratum-10 offline fallback"
  else
    warn "chrony.conf not found — skipping Chrony configuration"
    warn "Install chrony first: sudo apt install -y chrony"
  fi
fi

# ── Step 13: Tailscale ────────────────────────────────────────────────────────
step "13 / 17  Tailscale mesh VPN"
if $SKIP_TAILSCALE; then
  skip "Tailscale installation"
else
  if command -v tailscale &>/dev/null; then
    success "Tailscale already installed ($(tailscale version | head -1))"
  else
    info "Installing Tailscale..."
    curl -fsSL https://tailscale.com/install.sh | sh
    systemctl enable --now tailscaled
    success "Tailscale installed and daemon enabled"
  fi
  echo ""
  warn "ACTION REQUIRED: Authenticate Tailscale with your account:"
  warn "  sudo tailscale up --advertise-routes=192.168.1.0/24 --accept-dns=true"
  warn "Then approve subnet routes in the Tailscale admin console."
fi

# ── Step 14: IP forwarding (Tailscale subnet routing) ─────────────────────────
step "14 / 17  Linux IP forwarding (Tailscale subnet routing)"
if $ENABLE_IP_FORWARD; then
  SYSCTL_FILE="/etc/sysctl.d/99-adsi-tailscale.conf"
  cat > "$SYSCTL_FILE" <<'SYSCTL'
# ADSI Dashboard — Linux IP forwarding for Tailscale subnet routing
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
SYSCTL
  sysctl -p "$SYSCTL_FILE" > /dev/null
  success "IP forwarding enabled (${SYSCTL_FILE})"
else
  skip "IP forwarding (pass --ip-forward to enable subnet routing)"
fi

# ── Step 15: SSD/NVMe write-barrier ──────────────────────────────────────────
step "15 / 17  SSD / NVMe write-cache barrier (power-loss resilience)"
# Enable write-cache barrier on all detected SATA/NVMe block devices
# This ensures fsync() calls flush all pending writes to stable storage
# before SQLite WAL transactions are considered committed.
BLOCK_DEVS=$(lsblk -d -o NAME,TYPE | awk '$2=="disk"{print $1}' 2>/dev/null || true)
if [[ -n "$BLOCK_DEVS" ]]; then
  for dev in $BLOCK_DEVS; do
    hdparm -W1 "/dev/${dev}" 2>/dev/null && \
      success "Write-cache barrier enabled: /dev/${dev}" || \
      warn "hdparm -W1 /dev/${dev} failed (may not apply to NVMe — this is OK)"
  done
else
  warn "No block devices detected for hdparm — skipping"
fi

# ── Step 16: Enable services ──────────────────────────────────────────────────
step "16 / 17  Enable Systemd services (auto-start on boot)"
systemctl enable adsi.target adsi-inverter adsi-forecast adsi-server adsi-go2rtc 2>/dev/null
success "All ADSI services enabled for auto-start on boot"
info "Services are NOT started yet — start manually after data migration (see below)"

# ── Step 17: Post-setup summary ───────────────────────────────────────────────
step "17 / 17  Setup complete"

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║          ADSI Dashboard — Linux Setup Complete ✔                ║${NC}"
echo -e "${CYAN}╠══════════════════════════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║  POST-SETUP CHECKLIST (complete in order):                      ║${NC}"
echo -e "${CYAN}╠══════════════════════════════════════════════════════════════════╣${NC}"
echo ""
echo -e "  ${GREEN}Step A — Data Migration (Windows → Linux)${NC}"
echo -e "  Run from your Windows machine:"
echo ""
echo -e "  ${YELLOW}scp \"%PROGRAMDATA%\\InverterDashboard\\db\\adsi.db\" \\${NC}"
echo -e "  ${YELLOW}    adsi@<linux-ip>:${DATA_DIR}/db/${NC}"
echo ""
echo -e "  ${YELLOW}scp -r \"%PROGRAMDATA%\\InverterDashboard\\db\\backups\\*\" \\${NC}"
echo -e "  ${YELLOW}    adsi@<linux-ip>:${DATA_DIR}/db/backups/${NC}"
echo ""
echo -e "  ${YELLOW}scp -r \"%PROGRAMDATA%\\InverterDashboard\\forecast\\*.joblib\" \\${NC}"
echo -e "  ${YELLOW}    adsi@<linux-ip>:${DATA_DIR}/forecast/${NC}"
echo ""
echo -e "  ${YELLOW}scp \"%PROGRAMDATA%\\InverterDashboard\\config\\ipconfig.json\" \\${NC}"
echo -e "  ${YELLOW}    adsi@<linux-ip>:${DATA_DIR}/config/${NC}"
echo ""
echo -e "  Then fix permissions on Linux:"
echo -e "  ${YELLOW}sudo chown -R adsi:adsi ${DATA_DIR}${NC}"
echo ""

echo -e "  ${GREEN}Step B — Configure go2rtc camera streams${NC}"
echo -e "  Edit: ${YELLOW}${DATA_DIR}/programdata/go2rtc/go2rtc.yaml${NC}"
echo -e "  Add your plant camera RTSP stream URLs."
echo ""

echo -e "  ${GREEN}Step C — (Optional) fstab mount flags for ext4${NC}"
echo -e "  For maximum power-loss resilience on the data partition:"
echo -e "  ${YELLOW}UUID=<your-uuid>  ${DATA_DIR}  ext4  noatime,nodiratime,barrier=1,data=ordered,commit=5  0  2${NC}"
echo -e "  Check: ${YELLOW}findmnt ${DATA_DIR}${NC}"
echo ""

echo -e "  ${GREEN}Step D — Start all services${NC}"
echo -e "  ${YELLOW}sudo systemctl start adsi.target${NC}"
echo -e "  ${YELLOW}sudo systemctl status adsi.target${NC}"
echo ""

echo -e "  ${GREEN}Step E — Verify ports are locked${NC}"
echo -e "  ${YELLOW}ss -tulpn | grep -E '3500|9100|9200|8555'${NC}"
echo ""

echo -e "  ${GREEN}Step F — View live logs${NC}"
echo -e "  ${YELLOW}journalctl -u adsi-server -f${NC}"
echo -e "  ${YELLOW}journalctl -u adsi-inverter -f${NC}"
echo -e "  ${YELLOW}tail -f ${LOG_DIR}/server.log${NC}"
echo ""

echo -e "  ${GREEN}Step G — (Optional) Tailscale subnet routing${NC}"
echo -e "  ${YELLOW}sudo tailscale up --advertise-routes=192.168.1.0/24 --accept-dns=true${NC}"
echo -e "  Then pass ${YELLOW}--ip-forward${NC} flag and re-run this script, or:"
echo -e "  ${YELLOW}echo 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-adsi-tailscale.conf${NC}"
echo -e "  ${YELLOW}sudo sysctl -p /etc/sysctl.d/99-adsi-tailscale.conf${NC}"
echo ""

echo -e "  ${GREEN}Step H — Access the dashboard${NC}"
echo -e "  Local LAN :  ${YELLOW}http://$(hostname -I | awk '{print $1}'):3500${NC}"
echo -e "  Tailscale  :  ${YELLOW}http://<tailscale-ip>:3500${NC}"
echo ""

echo -e "${CYAN}╚══════════════════════════════════════════════════════════════════╝${NC}"
echo ""
