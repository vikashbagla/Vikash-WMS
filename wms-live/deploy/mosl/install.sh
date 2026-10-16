#!/bin/bash
# One-time installer for the wms-mosl relay service (MOSL Droplet Relay Plan v1).
#
#   sudo bash /opt/Vikash-WMS/wms-live/deploy/mosl/install.sh
#
# PURE ADDITION: installs ONE new unit (wms-mosl.service) and starts it.
# Does NOT touch wms-live, wms-scalp-ws, the auto-deploy, .env, sudoers or
# node_modules. Undo with:  sudo bash /opt/Vikash-WMS/wms-live/deploy/mosl/uninstall.sh
set -euo pipefail
if [ "$EUID" -ne 0 ]; then echo "Run with sudo:  sudo bash $0"; exit 1; fi

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"      # .../wms-live/deploy
APP_DIR="$(cd "$SRC_DIR/.." && pwd)"             # .../wms-live
UNIT=/etc/systemd/system/wms-mosl.service

echo "[mosl-install] checking files"
test -f "$APP_DIR/wms-mosl.js"         || { echo "wms-mosl.js not found in $APP_DIR (has the auto-deploy pulled yet?)"; exit 2; }
test -f "$APP_DIR/.env"                || { echo ".env not found in $APP_DIR"; exit 2; }
test -d "$APP_DIR/node_modules/pg"     || { echo "pg not installed in $APP_DIR/node_modules"; exit 2; }
node --check "$APP_DIR/wms-mosl.js"    || { echo "syntax check failed — not installing"; exit 2; }

echo "[mosl-install] installing $UNIT"
install -m 0644 -o root -g root "$SRC_DIR/wms-mosl.service" "$UNIT"
systemctl daemon-reload
systemctl enable --now wms-mosl.service
sleep 4

echo
echo "[mosl-install] status of all three services (wms-live and wms-scalp-ws should be unchanged):"
for s in wms-live wms-scalp-ws wms-mosl; do
  printf '  %-14s %s\n' "$s" "$(systemctl is-active $s.service 2>/dev/null || true)"
done
echo
echo "[mosl-install] last wms-mosl log lines:"
journalctl -u wms-mosl.service -n 8 --no-pager -o cat || true
echo
echo "[mosl-install] done. Expect a line like: listening on 'mosl_relay'"
