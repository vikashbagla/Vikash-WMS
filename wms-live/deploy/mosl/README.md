# wms-mosl — MOSL relay service (read-only phase)

Plan: `WMS Claude/MOSL Broker Addition/MOSL Droplet Relay Plan v1.md`.

- **Why:** MOSL's moAPI only accepts IPv4 callers sending `User-Agent: MOSL/V.1.1.0`. Supabase rewrites the header and Cloudflare uses IPv6, so MOSL calls go out from this Droplet.
- **What:** `../../wms-mosl.js` LISTENs on Postgres channel `mosl_relay`. On a notify it gets a prepared login from the `mosl-probe` Edge Function (HMAC), calls MOSL (read-only: login, books, reports), and posts a scrubbed result plus per-step timings back. `mosl-probe` writes them to `mosl_relay_runs`.
- **Isolation:** it's a separate unit (`wms-mosl.service`, 128 MB cap). It uses the existing `.env` (read-only) and the existing `pg` package. No changes to `index.js`, `wms-scalp-ws.js`, the packages or the auto-deploy.
- **Updates:** the auto-deploy doesn't restart it. When a pull changes `wms-mosl.js`, the service exits 90 seconds later and systemd starts the new code.
- **No orders:** the code refuses `/rest/trans` (MOSL's order endpoints).

## Install / remove (once, as a sudoer on the Droplet)

```
sudo bash /opt/Vikash-WMS/wms-live/deploy/mosl/install.sh
sudo bash /opt/Vikash-WMS/wms-live/deploy/mosl/uninstall.sh
```

## Trigger a probe (SQL)

```sql
select pg_notify('mosl_relay', json_build_object(
  't', (extract(epoch from clock_timestamp())*1000)::bigint, 'reps', 5)::text);
-- then:
select id, created_at, kind, ok, step, timings from mosl_relay_runs order by id desc limit 5;
```
