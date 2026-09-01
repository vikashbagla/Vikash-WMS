#!/bin/bash
#
# One-time installer for wms-live auto-deploy — Phase 13 Task #26.
#
# Run this ONCE on the Droplet, as a sudoer:
#   sudo bash /opt/Vikash-WMS/wms-live/deploy/auto-deploy/install.sh
#
# After install, any commit pushed to origin/dev on GitHub will be
# pulled and deployed to this Droplet within ~60s automatically. No
# more manual ssh + git pull + systemctl restart.
#
# Reverses cleanly with:
#   sudo systemctl disable --now wms-live-deploy.timer
#   sudo rm /etc/systemd/system/wms-live-deploy.timer
#   sudo rm /etc/systemd/system/wms-live-deploy.service
#   sudo rm /usr/local/bin/wms-live-autodeploy.sh
#   sudo systemctl daemon-reload

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
    echo "Must run as root. Run:"
    echo "  sudo bash $0"
    exit 1
fi

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[install] Source: $SRC_DIR"

# 1. Install the script into /usr/local/bin/ (executable, root-owned)
echo "[install] Installing /usr/local/bin/wms-live-autodeploy.sh"
install -m 0755 -o root -g root \
    "$SRC_DIR/wms-live-autodeploy.sh" \
    /usr/local/bin/wms-live-autodeploy.sh

# 2. Install the systemd units
echo "[install] Installing /etc/systemd/system/wms-live-deploy.service"
install -m 0644 -o root -g root \
    "$SRC_DIR/wms-live-deploy.service" \
    /etc/systemd/system/wms-live-deploy.service

echo "[install] Installing /etc/systemd/system/wms-live-deploy.timer"
install -m 0644 -o root -g root \
    "$SRC_DIR/wms-live-deploy.timer" \
    /etc/systemd/system/wms-live-deploy.timer

# 3. Ensure the wms user can run `sudo systemctl restart wms-live.service`
#    without a password. Most Droplets already have a sudoers rule for the
#    wms user — we add a dedicated, minimal one just in case.
SUDOERS_FILE=/etc/sudoers.d/wms-live-restart
if [ ! -f "$SUDOERS_FILE" ]; then
    echo "[install] Adding passwordless sudo for systemctl restart wms-live"
    cat > "$SUDOERS_FILE" <<'EOF'
# Allow the wms user to restart the wms-live service without password,
# so the auto-deploy script can finish a deployment unattended.
# Installed by wms-live/deploy/auto-deploy/install.sh — Phase 13 Task #26.
wms ALL=(root) NOPASSWD: /bin/systemctl restart wms-live.service
wms ALL=(root) NOPASSWD: /bin/systemctl restart wms-live
EOF
    chmod 0440 "$SUDOERS_FILE"
    # visudo -c verifies syntax; bail out if broken
    if ! visudo -c -f "$SUDOERS_FILE" > /dev/null; then
        echo "[install] sudoers syntax check FAILED — removing the file."
        rm "$SUDOERS_FILE"
        exit 2
    fi
else
    echo "[install] $SUDOERS_FILE already exists — leaving alone."
fi

# 3b. Passwordless sudo for restarting wms-prices (the live-prices feed), so the
#     auto-deploy can restart it unattended too. Separate file so re-running this
#     installer adds it even when the wms-live-restart file already exists.
SUDOERS_PRICES=/etc/sudoers.d/wms-prices-restart
if [ ! -f "$SUDOERS_PRICES" ]; then
    echo "[install] Adding passwordless sudo for systemctl restart wms-prices"
    cat > "$SUDOERS_PRICES" <<'EOF'
# Installed by wms-live/deploy/auto-deploy/install.sh
wms ALL=(root) NOPASSWD: /bin/systemctl restart wms-prices.service
wms ALL=(root) NOPASSWD: /bin/systemctl restart wms-prices
EOF
    chmod 0440 "$SUDOERS_PRICES"
    if ! visudo -c -f "$SUDOERS_PRICES" > /dev/null; then
        echo "[install] wms-prices sudoers syntax check FAILED — removing."
        rm "$SUDOERS_PRICES"; exit 2
    fi
else
    echo "[install] $SUDOERS_PRICES already exists — leaving alone."
fi

# 4. Reload systemd, enable + start the timer
echo "[install] systemctl daemon-reload"
systemctl daemon-reload

echo "[install] systemctl enable --now wms-live-deploy.timer"
systemctl enable --now wms-live-deploy.timer

# 5. Verify
echo
echo "[install] ✓ Auto-deploy installed and started."
echo
echo "------- Timer status -------"
systemctl status wms-live-deploy.timer --no-pager || true
echo
echo "------- Next scheduled trigger -------"
systemctl list-timers wms-live-deploy.timer --no-pager || true
echo
echo "Tail the deploy log with:"
echo "  sudo journalctl -u wms-live-deploy.service -n 30 --no-pager"
echo
echo "Trigger an immediate test run:"
echo "  sudo systemctl start wms-live-deploy.service"
echo "  sudo journalctl -u wms-live-deploy.service -n 30 --no-pager"
