#!/bin/bash
# Removes the wms-mosl relay service. Leaves everything else exactly as it was.
#   sudo bash /opt/Vikash-WMS/wms-live/deploy/mosl/uninstall.sh
set -euo pipefail
if [ "$EUID" -ne 0 ]; then echo "Run with sudo:  sudo bash $0"; exit 1; fi
systemctl disable --now wms-mosl.service 2>/dev/null || true
rm -f /etc/systemd/system/wms-mosl.service
systemctl daemon-reload
systemctl reset-failed wms-mosl.service 2>/dev/null || true
echo "[mosl-uninstall] wms-mosl removed."
for s in wms-live wms-scalp-ws; do
  printf '  %-14s %s\n' "$s" "$(systemctl is-active $s.service 2>/dev/null || true)"
done
