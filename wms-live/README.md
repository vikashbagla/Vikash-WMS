# wms-live

Phase 13 production order-placer service. Runs on the DigitalOcean Droplet
(`wms-live-1`, Bangalore BLR1, IP `139.59.67.107`). Polls the Supabase
`wms-live-cmd-poll` Edge Function via HMAC-authenticated requests, places
orders on the broker indicated in each command from the Droplet's whitelisted
IP, writes results back via `wms-live-cmd-complete`.

Broker-agnostic by design — Fyers today; Zerodha / Angel One / Aliceblue
tomorrow without changes to the queue or the Edge Functions, just a new
adapter function in `index.js` and a new IBA row in the DB.

## Architecture

```
┌──────────────────┐   HMAC-signed POST   ┌─────────────────────────┐
│ wms-live service │ ───────────────────→ │ wms-live-cmd-poll       │ (Edge Function)
│ (Node 22, this   │ ←─────────────────── │ → atomic claim          │
│  service)        │   {kill_switch,      │ → JOIN IBA+brokers+token│
│                  │    command, broker}  │ → return next pending   │
│  /opt/Vikash-    │                      └─────────────────────────┘
│  WMS/wms-live/   │
│                  │   HTTPS POST         ┌─────────────────────────┐
│                  │ ───────────────────→ │ Fyers /api/v3/orders/   │
│                  │ ←─────────────────── │ sync (from whitelisted  │
│                  │   {s,code,id,...}    │ IP 139.59.67.107)       │
│                  │                      └─────────────────────────┘
│                  │
│                  │   HMAC-signed POST   ┌─────────────────────────┐
│                  │ ───────────────────→ │ wms-live-cmd-complete   │
│                  │                      │ → UPDATE wms_live_      │
│                  │                      │   commands (status,     │
│                  │                      │   broker_order_id, ...) │
│                  │                      └─────────────────────────┘
└──────────────────┘
```

The Droplet holds **NO Supabase `service_role` key**. Only `WMS_LIVE_HMAC_SECRET`.
Compromise of the Droplet = attacker can poll commands and place orders, but
CANNOT read transactions, ledgers, or any other WMS data.

## Status

| Stage | Status |
|---|---|
| Stage 1: HTTP `/health` skeleton | ✅ Stream 1 (2026-06-18 morning) |
| Stage 2: HMAC client + poll loop + Fyers v3 client + cmd-complete writeback | ✅ Stream C (2026-06-18 afternoon) |
| Stage 3: Order status monitoring (poll broker for fills, push updates) | ⏳ Stream C v2 (post first-test) |
| Stage 4: Multi-broker adapters (Zerodha, Angel One) | ⏳ Future, when needed |
| Stage 5: Reconnect from cold start (rehydrate working orders) | ⏳ Future |

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Operational metrics — version, uptime, poll counters, last-poll/claim/place timestamps, current backoff. Safe to expose publicly (only operational signals, no secrets). |

The polling loop runs in-process — no other HTTP endpoints. Order commands
flow IN via Supabase → cmd-poll, never via direct HTTPS to this Droplet (ufw
only allows port 22 SSH).

## Running

On the Droplet, as the `wms` user:

```bash
cd /opt/Vikash-WMS/wms-live

# First-time setup — populate .env from template
cp .env.example .env
nano .env                  # fill SUPABASE_URL, WMS_LIVE_HMAC_SECRET, FYERS_APP_ID
chmod 600 .env

# Install deps (deterministic via lockfile)
npm ci

# Run in the foreground for testing
node index.js

# Or run as the systemd service (production)
sudo systemctl restart wms-live
sudo systemctl status wms-live
sudo journalctl -u wms-live -f
```

## Required env vars

| Name | Description | Example |
|---|---|---|
| `SUPABASE_URL` | Supabase project URL | `https://lynvrwteylgpwlwbslse.supabase.co` |
| `WMS_LIVE_HMAC_SECRET` | 32-byte hex shared with Supabase Edge Functions (same value set as Supabase Secret `WMS_LIVE_HMAC_SECRET`) | (output of `openssl rand -hex 32`) |
| `FYERS_APP_ID` | SEBI-compliant -200 App ID | `CSEZBR93R3-200` |
| `PORT` | HTTP server port for `/health` | `3000` (default) |
| `DROPLET_ID` | Identifier written to `wms_live_commands.claimed_by` | `wms-live-1` (default) |
| `POLL_INTERVAL_MS` | Main poll cadence | `1500` (default) |
| `POLL_BACKOFF_MAX_MS` | Cap on exponential backoff during outages | `30000` (default) |

## Deploying code changes

Per WMS-LESSONS §A.12 (the canonical deploy workflow):

1. Edit code on Vikash's Mac in `/Users/vikashbagla/.../Vikash-WMS/wms-live/`
2. Commit + push to `dev` branch
3. On the Droplet:
   ```bash
   cd /opt/Vikash-WMS && git pull
   cd wms-live && npm ci    # only if package*.json changed
   sudo systemctl restart wms-live
   sudo systemctl status wms-live --no-pager | head -12
   curl -s http://127.0.0.1:3000/health | python3 -m json.tool
   ```

Hard rules (see WMS-LESSONS §A.12):

- ⛔ NEVER edit code directly on the Droplet (deploy key is read-only)
- ⛔ NEVER use `npm install` after the first time (use `npm ci` for deterministic builds)
- ⛔ NEVER push the Droplet's `/opt/Vikash-WMS/wms-live/.env` to git (`.gitignore`'d for a reason)

## Files

| Path | Purpose |
|---|---|
| `index.js` | Main entry — HTTP server + HMAC client + poll loop + Fyers v3 adapter + cmd-complete writeback. |
| `scripts/place-test-order.js` | Standalone test script (Stream 1 era). Direct Fyers call, hardcoded SILVERM order. Useful for ad-hoc broker testing; NOT the production order path. |
| `package.json` | Node 22 project. `express` + `dotenv`. |
| `package-lock.json` | Committed (`npm ci` requires it). |
| `.env.example` | Template — see required env vars above. |
| `deploy/wms-live.service` | systemd unit template. Source-of-truth for the active `/etc/systemd/system/wms-live.service` per WMS-LESSONS §A.12.6. |

## How to inject a manual test command (Phase E)

After Phase C is deployed, INSERT a command directly into `wms_live_commands`
via Supabase Studio SQL Editor:

```sql
-- Replace <fyers-iba-uuid> with the UUID of your Fyers IBA row from
--   SELECT id FROM investor_broker_accounts WHERE broker_id IN (
--     SELECT id FROM brokers WHERE broker_code = 'fyers'
--   ) LIMIT 1;

INSERT INTO wms_live_commands (signal_source, signal_ref, strategy_name, iba_id, payload)
VALUES (
  'manual',
  'phase-13-first-prod-test',
  NULL,
  '<fyers-iba-uuid>'::uuid,
  '{
    "symbol":       "MCX:SILVERM26JUNFUT",
    "side":         1,
    "qty":          1,
    "type":         2,
    "productType":  "MARGIN",
    "limitPrice":   0,
    "stopPrice":    0,
    "disclosedQty": 0,
    "validity":     "DAY",
    "offlineOrder": false,
    "stopLoss":     0,
    "takeProfit":   0
  }'::jsonb
);
```

Within 1.5s (one poll cycle), the Droplet should:

1. Claim the row (`status='claimed'`, `claimed_by='wms-live-1'`)
2. Place the order on Fyers
3. UPDATE the row to `status='placed'`, `broker_order_id='<fyers id>'`, `broker_status='PENDING'`

Verify via:

```sql
SELECT id, signal_source, status, broker_status, broker_order_id, error_code, error_message,
       claimed_at, placed_at
FROM wms_live_commands
WHERE signal_ref = 'phase-13-first-prod-test';
```

Or watch the Droplet's logs in real time:

```bash
sudo journalctl -u wms-live -f
```
