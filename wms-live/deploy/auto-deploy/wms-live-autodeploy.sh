#!/bin/bash
#
# wms-live auto-deploy script — Phase 13 Task #26.
#
# Runs every 60s via wms-live-deploy.timer. Fetches origin/dev, compares to
# local HEAD, and if there's an update:
#   1. git pull --ff-only origin dev    (refuses force-pushes)
#   2. cd wms-live && npm ci            (uses lockfile, exact versions)
#   3. node --check index.js            (syntax-check before restart)
#   4. sudo -n systemctl restart wms-live
#
# On ANY failure, exits non-zero; systemd logs the failure to journald and
# the OLD wms-live process keeps running. The next 60s tick will retry.
#
# Runs as the wms user. Requires:
#   - /opt/Vikash-WMS owned by wms:wms
#   - SSH deploy key configured for git fetch from origin (read-only is fine)
#   - Passwordless sudo for: /bin/systemctl restart wms-live.service
#
# View activity:
#   sudo journalctl -u wms-live-deploy.service -n 50 --no-pager
#   sudo systemctl list-timers wms-live-deploy.timer
#
# Emergency disable (e.g., if Vikash pushed code he wants to roll back):
#   sudo systemctl stop wms-live-deploy.timer
#   sudo systemctl disable wms-live-deploy.timer
# Re-enable later:
#   sudo systemctl enable --now wms-live-deploy.timer

set -euo pipefail

REPO_DIR=/opt/Vikash-WMS
WMS_LIVE_DIR=$REPO_DIR/wms-live
SERVICE_NAME=wms-live.service

cd "$REPO_DIR"

# Fetch latest from origin (uses the deploy SSH key).
# --quiet so we don't spam the journal on every 60s tick.
git fetch --quiet origin dev

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/dev)

if [ "$LOCAL" = "$REMOTE" ]; then
    # No update available — exit silently. journald sees the unit complete
    # in <1s; no log noise.
    exit 0
fi

echo "[auto-deploy] Update detected: $LOCAL → $REMOTE"

# Fast-forward only. If dev has been force-pushed or rebased (which we
# don't allow per A.8), the pull will refuse and we'll halt loudly until
# a human investigates.
echo "[auto-deploy] git pull --ff-only origin dev"
git pull --ff-only origin dev

# npm ci is faster than install AND enforces lockfile match — any drift
# fails here rather than at runtime.
echo "[auto-deploy] npm ci --no-audit --no-fund"
cd "$WMS_LIVE_DIR"
npm ci --no-audit --no-fund

# Syntax-check the new index.js before restarting the service. Catches
# the most common "I broke something" — unclosed braces, undefined identifier
# at parse time, missing import, etc. NOT a substitute for testing, but a
# cheap safety belt against the most obvious deploy-breaking bugs.
echo "[auto-deploy] node --check index.js"
if ! node --check index.js; then
    echo "[auto-deploy] SYNTAX ERROR in new index.js — refusing to restart wms-live."
    echo "[auto-deploy] The OLD process is still running. Push a fix to origin/dev to recover."
    exit 2
fi

echo "[auto-deploy] Restarting wms-live service..."
sudo -n /bin/systemctl restart "$SERVICE_NAME"

# Also restart the INDEPENDENT live-prices feed (wms-prices) so its code updates
# land the same way. Syntax-check first; a broken/uninstalled wms-prices must NOT
# fail the deploy that already restarted wms-live.
if [ -f "$WMS_LIVE_DIR/wms-prices.js" ]; then
    if node --check "$WMS_LIVE_DIR/wms-prices.js"; then
        echo "[auto-deploy] Restarting wms-prices service..."
        sudo -n /bin/systemctl restart wms-prices.service || echo "[auto-deploy] wms-prices restart skipped (not installed yet?)"
    else
        echo "[auto-deploy] SYNTAX ERROR in wms-prices.js — NOT restarting wms-prices."
    fi
fi

echo "[auto-deploy] ✓ Deployed $REMOTE successfully"
