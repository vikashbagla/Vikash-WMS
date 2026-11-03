#!/bin/bash
#
# wms-live auto-deploy script — Phase 13 Task #26.
#
# Runs every 60s via wms-live-deploy.timer. Fetches origin/dev and, if there's
# an update, pulls it (fast-forward only). It then RESTARTS the Droplet services
# ONLY IF the Droplet's own code changed (3-Nov-2026, owner request):
#
#   Restart-relevant = files under wms-live/ EXCEPT
#     *.md, *.test.mjs, wms-live/scripts/, wms-live/deploy/   (never run by the services)
#     wms-live/wms-mosl.js                                    (self-restarts on its own change)
#
# Front-end / other-module pushes to dev (e.g. screen tweaks) are pulled but do
# NOT restart wms-live or wms-scalp-ws.
#
# "Changed" is measured against the commit the services were LAST RESTARTED on
# (marker file .git/wms-live-deployed-sha), not just the previous HEAD — so a
# deploy that failed half-way (e.g. a syntax error) is retried on the next fix.
# No marker yet (first run after install) = one full deploy, then the marker exists.
#
# When the Droplet code did change:
#   1. cd wms-live && npm ci            (uses lockfile, exact versions)
#   2. node --check index.js            (syntax-check before restart)
#   3. sudo -n systemctl restart wms-live (+ wms-scalp-ws)
#   4. write the marker
#
# On ANY failure, exits non-zero; systemd logs the failure to journald and
# the OLD wms-live process keeps running. That commit is not retried
# (.git/wms-live-failed-sha); the next push to dev is.
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
# Force a full redeploy + restart on the next tick:
#   rm /opt/Vikash-WMS/.git/wms-live-deployed-sha
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
MARKER=$REPO_DIR/.git/wms-live-deployed-sha
FAILED=$REPO_DIR/.git/wms-live-failed-sha   # a commit whose deploy failed — not retried until a newer commit lands

cd "$REPO_DIR"

# Fetch latest from origin (uses the deploy SSH key).
# --quiet so we don't spam the journal on every 60s tick.
git fetch --quiet origin dev

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/dev)

if [ "$LOCAL" != "$REMOTE" ]; then
    echo "[auto-deploy] Update detected: $LOCAL → $REMOTE"
    # Fast-forward only. If dev has been force-pushed or rebased (which we
    # don't allow per A.8), the pull will refuse and we'll halt loudly until
    # a human investigates.
    echo "[auto-deploy] git pull --ff-only origin dev"
    git pull --ff-only origin dev
fi

HEAD_NOW=$(git rev-parse HEAD)
DEPLOYED=$(cat "$MARKER" 2>/dev/null || true)

# Nothing new since the services were last restarted → done (silent).
if [ "$DEPLOYED" = "$HEAD_NOW" ]; then
    exit 0
fi

# Don't retry a commit whose deploy already failed (same as the old behaviour:
# a failed deploy waits for the next push rather than looping every 60s).
if [ "$(cat "$FAILED" 2>/dev/null || true)" = "$HEAD_NOW" ]; then
    exit 0
fi

# Did the Droplet's own code change since the last restart?
NEED_RESTART=yes
if [ -n "$DEPLOYED" ] && git cat-file -e "${DEPLOYED}^{commit}" 2>/dev/null; then
    RELEVANT=$(git diff --name-only "$DEPLOYED" "$HEAD_NOW" -- wms-live/ \
        | grep -vE '\.md$|\.test\.mjs$|^wms-live/(scripts|deploy)/|^wms-live/wms-mosl\.js$' || true)
    if [ -z "$RELEVANT" ]; then
        NEED_RESTART=no
    else
        echo "[auto-deploy] Droplet code changed:"
        echo "$RELEVANT" | sed 's/^/[auto-deploy]   /'
    fi
else
    echo "[auto-deploy] No (valid) deployed-commit marker — doing a full deploy."
fi

if [ "$NEED_RESTART" = "no" ]; then
    echo "[auto-deploy] Pulled $HEAD_NOW — no Droplet code changed; services NOT restarted."
    echo "$HEAD_NOW" > "$MARKER"
    exit 0
fi

echo "$HEAD_NOW" > "$FAILED"   # cleared below on success

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

# Also restart the INDEPENDENT scalp-engine tick driver (wms-scalp-ws) so its
# code updates land the same way. Syntax-check first; a broken/uninstalled
# wms-scalp-ws must NOT fail the deploy that already restarted the others.
if [ -f "$WMS_LIVE_DIR/wms-scalp-ws.js" ]; then
    if node --check "$WMS_LIVE_DIR/wms-scalp-ws.js"; then
        echo "[auto-deploy] Restarting wms-scalp-ws service..."
        sudo -n /bin/systemctl restart wms-scalp-ws.service || echo "[auto-deploy] wms-scalp-ws restart skipped (not installed yet?)"
    else
        echo "[auto-deploy] SYNTAX ERROR in wms-scalp-ws.js — NOT restarting wms-scalp-ws."
    fi
fi

echo "$HEAD_NOW" > "$MARKER"
rm -f "$FAILED"
echo "[auto-deploy] ✓ Deployed $HEAD_NOW successfully"
