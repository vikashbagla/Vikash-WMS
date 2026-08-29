// wms-live — Phase 13 production order-placer service (F2 architecture).
//
// Runs on the DigitalOcean Droplet (wms-live-1, IP 139.59.67.107). Receives
// new-command notifications via Postgres LISTEN/NOTIFY (push, not poll),
// places orders on the broker indicated in each command from the Droplet's
// whitelisted IP, writes results back via wms-live-cmd-complete, then tracks
// every placed order's lifecycle (PENDING → OPEN → PARTIAL → FILLED / etc.)
// via TWO redundant paths: a per-IBA Fyers Order WebSocket (push) and a
// REST safety-net poll (pull).
//
// Broker-agnostic by design — Fyers today; Zerodha / Angel One / Aliceblue
// tomorrow without changes to the queue or the Edge Functions, just a new
// place + status adapter in this file and a new IBA row in the DB.
//
// Security model — THREE independent credentials, NONE is service_role:
//   1. WMS_LIVE_HMAC_SECRET — used to call wms-live-cmd-poll +
//      wms-live-cmd-complete + wms-live-orders-monitoring Edge Functions.
//      Compromise = attacker can poll commands + place orders, but CANNOT
//      read any other WMS data.
//   2. PG_PASSWORD for the wms_live_notify_only role — used for the LISTEN
//      connection. Compromise = attacker can receive notifications about
//      new commands BUT can read no data (the role has NO SELECT/INSERT/
//      UPDATE/DELETE on any table).
//   3. SUPABASE_ANON_KEY — public anon key, used only as gateway apikey on
//      EF calls. NOT secret — it carries no auth on its own.
//
// Loops:
//   1. Postgres LISTEN client (persistent connection, push-based):
//        → connect as wms_live_notify_only to Supabase Postgres (session
//          pooler port 5432, SSL required)
//        → LISTEN wms_live_commands_new
//        → on every NOTIFY (or gap-fill on reconnect): call cmd-poll
//          (atomic claim + broker creds), place order, call cmd-complete
//        → reconnect on disconnect with exponential backoff (capped 30s)
//   2. Safety-net Edge Function poll for command intake (every
//      PG_POLL_SAFETY_NET_MS, default 60000): regardless of NOTIFY activity,
//      call cmd-poll once to catch any missed notifications. Usually returns
//      null when LISTEN is healthy.
//   3. Phase F2 — Orders monitoring loop (every MONITORING_POLL_BUSY_MS=30s
//      when working orders exist; MONITORING_POLL_IDLE_MS=5min when idle):
//        → call wms-live-orders-monitoring (HMAC) to fetch all working
//          orders grouped by IBA + each IBA's current Fyers access_token
//        → reconcile per-IBA Fyers Order WebSocket pool (open new, restart
//          on token rotation)
//        → for each working order: GET Fyers /api/v3/orders?id=… and
//          cmd-complete (flavor B) with the latest status — gap-fill against
//          missed WS events
//   4. Phase F2 — Per-IBA Fyers Order WebSocket (push-based):
//        → wss://socket.fyers.in/trade/v3, auth header
//          'Authorization: ${APP_ID}:${access_token}'
//        → subscribe { T:'SUB_ORD', SLIST:['orders','trades'], SUB_T:1 }
//        → text "ping" every 10s
//        → on each orders event: resolve broker_order_id → command_id via
//          brokerOrderIdToCommandId map, derive broker_status from Fyers
//          status code, cmd-complete (flavor B). Reconnect on disconnect
//          with exponential backoff (capped 30s); kick a REST gap-fill on
//          (re)connect to catch anything missed while disconnected.
//   5. HEALTH endpoint on PORT (default 3000) — operational metrics +
//      ws_pool view, no auth.
//
// Required env (in /opt/Vikash-WMS/wms-live/.env):
//   PORT                       — HTTP server port (default 3000)
//   SUPABASE_URL               — Supabase project URL
//   SUPABASE_ANON_KEY          — public anon key, used as gateway apikey on EF calls
//   WMS_LIVE_HMAC_SECRET       — 32-byte hex, same as Supabase Secrets
//   FYERS_APP_ID               — CSEZBR93R3-200
//   DROPLET_ID                 — identifier for claimed_by (default 'wms-live-1')
//   PG_HOST                    — Supabase Postgres session pooler host
//   PG_PORT                    — 5432 (session pooler; NOT 6543 transaction pooler)
//   PG_DATABASE                — 'postgres'
//   PG_USER                    — 'wms_live_notify_only.<project-ref>' (see Supabase Studio "Session pooler" string)
//   PG_PASSWORD                — set via ALTER USER in Supabase Studio (NOT in this repo)
//   PG_POLL_SAFETY_NET_MS      — safety-net poll cadence (default 60000)
//   PG_RECONNECT_BACKOFF_MAX_MS — max reconnect backoff (default 30000)
//   MONITORING_POLL_BUSY_MS    — F2 cadence when working orders exist (default 30000)
//   MONITORING_POLL_IDLE_MS    — F2 cadence when no working orders (default 300000)
//   FYERS_ORDER_WS_URL         — default wss://socket.fyers.in/trade/v3
//   FYERS_WS_PING_INTERVAL_MS  — WS keep-alive cadence (default 10000)
//   FYERS_WS_RECONNECT_BACKOFF_MAX_MS — max WS reconnect backoff (default 30000)

import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));

// ── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL              = required('SUPABASE_URL');
const SUPABASE_ANON_KEY         = required('SUPABASE_ANON_KEY');
const WMS_LIVE_HMAC_SECRET      = required('WMS_LIVE_HMAC_SECRET');
const FYERS_APP_ID              = required('FYERS_APP_ID');
const PORT                      = Number(process.env.PORT) || 3000;
const DROPLET_ID                = process.env.DROPLET_ID || 'wms-live-1';
const PG_HOST                   = required('PG_HOST');
const PG_PORT                   = Number(process.env.PG_PORT) || 5432;
const PG_DATABASE               = process.env.PG_DATABASE || 'postgres';
const PG_USER                   = required('PG_USER');
const PG_PASSWORD               = required('PG_PASSWORD');
const PG_POLL_SAFETY_NET_MS     = Number(process.env.PG_POLL_SAFETY_NET_MS) || 60_000;
const PG_RECONNECT_BACKOFF_MAX_MS = Number(process.env.PG_RECONNECT_BACKOFF_MAX_MS) || 30_000;

// Phase F2 — orders monitoring + Fyers Order WS
const MONITORING_POLL_BUSY_MS   = Number(process.env.MONITORING_POLL_BUSY_MS) || 30_000;
const MONITORING_POLL_IDLE_MS   = Number(process.env.MONITORING_POLL_IDLE_MS) || 5 * 60_000;
const FYERS_ORDER_WS_URL        = process.env.FYERS_ORDER_WS_URL || 'wss://socket.fyers.in/trade/v3';
const FYERS_WS_PING_INTERVAL_MS = Number(process.env.FYERS_WS_PING_INTERVAL_MS) || 10_000;
const FYERS_WS_RECONNECT_BACKOFF_MAX_MS = Number(process.env.FYERS_WS_RECONNECT_BACKOFF_MAX_MS) || 30_000;

const POLL_URL        = `${SUPABASE_URL}/functions/v1/wms-live-cmd-poll`;
const COMPLETE_URL    = `${SUPABASE_URL}/functions/v1/wms-live-cmd-complete`;
const MONITORING_URL  = `${SUPABASE_URL}/functions/v1/wms-live-orders-monitoring`;
const HEARTBEAT_URL   = `${SUPABASE_URL}/functions/v1/wms-live-heartbeat`;
const HEARTBEAT_MS    = Number(process.env.HEARTBEAT_MS) || 120_000;   // 2 min — checker staleness threshold is 5 min
const LISTEN_CHANNEL  = 'wms_live_commands_new';

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[wms-live] FATAL: env var ${name} is required but missing.`);
    process.exit(1);
  }
  return v;
}

const START_TIME = Date.now();
let running = true;

// Liveness metrics for /health
let lastNotificationAt   = null;
let lastSafetyNetPollAt  = null;
let lastClaimAt          = null;
let lastPlaceAt          = null;
let totalNotificationsReceived = 0;
let totalSafetyNetPolls        = 0;
let totalCommandsClaimed       = 0;
let totalCommandsPlaced        = 0;
let totalCommandsErrored       = 0;
let pgConnected = false;
let pgReconnectAttempts = 0;
let edgeFunctionConsecutiveErrors = 0;

// In-flight command IDs — prevents double-processing when both the LISTEN
// event AND the safety-net poll trigger a claim at the same time.
// cmd-poll's atomic claim already handles this server-side, but we add
// client-side dedup to avoid pointless cmd-poll requests.
const inFlightTriggers = new Set();

// ── Phase F2 state ──────────────────────────────────────────────────────────
//
// brokerOrderIdToCommandId: reverse-lookup populated at two points —
//   1. Placement-time: when processCommand gets back broker_order_id from Fyers
//   2. Monitoring-poll-time: from groups[].orders[].(command_id, broker_order_id)
// WS message handler uses this to resolve which WMS command to update.
// Entries persist for the process lifetime (small RAM footprint per order).
const brokerOrderIdToCommandId = new Map();   // broker_order_id → command_id

// WS-3 (2026-07-10) — early-arrival buffer.
//
// Fyers pushes a market order's events within ~100ms of placement. Our HTTP
// placement call has not even returned, so we do not yet know the broker_order_id
// and cannot map the event to a command. Before this buffer existed those events
// were dropped on the floor, silently, and the fill was rediscovered minutes
// later by the REST safety-net.
//
// So: park an unmatched order event here, keyed by broker_order_id. The moment
// that id is registered, replay it. Last event wins — Fyers sends PENDING then
// FILLED, and the terminal one is the one that matters.
const pendingWsEvents = new Map();   // broker_order_id → { fields, at }
const PENDING_WS_EVENT_TTL_MS = 60_000;
let totalWsEventsBuffered = 0;
let totalWsEventsReplayed = 0;

function bufferWsEvent(brokerOrderId, fields) {
  pendingWsEvents.set(String(brokerOrderId), { fields, at: Date.now() });
  totalWsEventsBuffered++;
  // Opportunistic sweep — this map should never hold more than a few entries.
  if (pendingWsEvents.size > 50) {
    const cutoff = Date.now() - PENDING_WS_EVENT_TTL_MS;
    for (const [k, v] of pendingWsEvents) if (v.at < cutoff) pendingWsEvents.delete(k);
  }
}

// Register a broker_order_id → command_id mapping, and immediately drain any
// event that arrived before we knew the id. Call this the INSTANT the id is
// known — before any await, before any writeback.
function registerBrokerOrder(brokerOrderId, commandId) {
  const id = String(brokerOrderId);
  brokerOrderIdToCommandId.set(id, commandId);

  const buffered = pendingWsEvents.get(id);
  if (!buffered) return;
  pendingWsEvents.delete(id);

  const ageMs = Date.now() - buffered.at;
  if (ageMs > PENDING_WS_EVENT_TTL_MS) {
    console.warn(`[ws replay] dropping stale buffered event for ${id} (${ageMs}ms old)`);
    return;
  }
  totalWsEventsReplayed++;
  console.log(`[ws replay] cmd=${commandId} broker_order_id=${id} — event arrived ${ageMs}ms before we knew the id`);
  applyWsOrderFields(commandId, id, buffered.fields).catch((err) => {
    console.error(`[ws replay] cmd-complete failed for ${commandId}:`, err.message);
  });
}

// ── External-fill forwarding (unified booking) ──────────────────────────────
// Every fill on the account WS that is NOT one of our commands (Fyers app,
// manual, any non-module source) is booked through the SAME cmd-complete booker
// as our own fills — one function, no drift. An unmatched event might still be
// OURS racing its placement mapping (WS-3), so we forward only after
// EXTERNAL_FORWARD_DELAY_MS with the id STILL unmapped. Our placements register
// their id within ~1.5s (and the monitoring poll re-maps within 30s), so a 20s
// delay never mis-books our own order as external.
//
// LATENCY: this runs on its own 5s timer, entirely off the placement path, and
// only ever POSTs to cmd-complete (which books in the background). It cannot add
// any latency to order placement. Gated by BOOK_EXTERNAL_FILLS so it can be
// disabled instantly without a redeploy.
// Default ON: the droplet auto-deploys from git and has no per-env toggle set,
// so git is the enable lever. Kill switch = set BOOK_EXTERNAL_FILLS=false in the
// droplet .env, or revert this commit (auto-deploys within ~60s).
const BOOK_EXTERNAL_FILLS       = String(process.env.BOOK_EXTERNAL_FILLS ?? 'true').toLowerCase() !== 'false';
const EXTERNAL_FORWARD_DELAY_MS = Number(process.env.EXTERNAL_FORWARD_DELAY_MS) || 20_000;
let totalExternalFillsForwarded = 0;

// 2026-07-20 — the WS event is now ONLY A TRIGGER. We do not parse it for booking.
//
// WHY: the Fyers order-WS payload does not carry the side under `side` or
// `transaction_type` (the two keys readFyersOrderFields guesses at). It arrived as
// null, cmd-complete coerced it via `Number(null) === 1 ? 'BUY' : 'SELL'` — and
// Number(null) is 0 — so a BUY was booked as a SELL. Those keys were added
// speculatively for external fills and had never executed until 2026-07-20.
//
// FIX: stop guessing. The TRADEBOOK is the authoritative record of executions, and
// fyers-tradebook-import already parses side/qty/price, computes charges and dedupes
// — correctly, nightly, for months. So an unmatched fill just tells that importer to
// run now instead of at 23:55. Nothing here reads a field off the WS object, so this
// class of bug cannot recur.
//
// AUTH: fyers-tradebook-import accepts ONLY x-cron-key, and this droplet has no
// CRON_SECRET_KEY. We therefore ask cmd-complete — which we already authenticate to
// over HMAC, and which can read the project secret — to fan out. No new droplet secret.
//
// DEBOUNCED: several fills seconds apart produce ONE import run, not N. Each run
// re-reads the whole tradebook anyway, so extra runs buy nothing and only add
// read-then-write overlap risk.
let lastExternalTriggerAt   = 0;
let externalTriggerPending  = false;
const EXTERNAL_TRIGGER_MIN_GAP_MS = Number(process.env.EXTERNAL_TRIGGER_MIN_GAP_MS) || 60_000;

async function triggerTradebookImport(sampleOrderId) {
  await callCmdComplete({
    external_fill_trigger: {
      broker_order_id: sampleOrderId,          // for the log trail only — NOT used to book
      detected_at:     new Date().toISOString(),
    },
  });
  totalExternalFillsForwarded++;
  console.log(`[external-fill] import triggered (sample order=${sampleOrderId})`);
}

function maybeFireExternalTrigger(sampleOrderId) {
  if (!externalTriggerPending) return;
  if (Date.now() - lastExternalTriggerAt < EXTERNAL_TRIGGER_MIN_GAP_MS) return;  // too soon — a later sweep retries
  externalTriggerPending = false;
  lastExternalTriggerAt  = Date.now();
  triggerTradebookImport(sampleOrderId).catch((e) => {
    externalTriggerPending = true;    // put it back; the next sweep retries. 23:55 is the backstop.
    console.error('[external-fill] trigger failed:', e.message);
  });
}

function sweepExternalFills() {
  if (!BOOK_EXTERNAL_FILLS) return;
  let sampleId = null;
  if (pendingWsEvents.size > 0) {
    const now = Date.now();
    for (const [id, v] of pendingWsEvents) {
      if (brokerOrderIdToCommandId.has(id)) { pendingWsEvents.delete(id); continue; }  // it was ours after all
      if (now - v.at < EXTERNAL_FORWARD_DELAY_MS) continue;                            // still inside the our-order grace window
      const f = v.fields;
      const bs = mapFyersStatusCode(f.status_code, f.filled_qty);
      const isFill = Number(f.filled_qty || 0) > 0 && (bs === 'FILLED' || bs === 'PARTIAL');
      pendingWsEvents.delete(id);                                                       // consume it either way
      if (!isFill) continue;                                                            // nothing to book (unfilled / cancelled)
      externalTriggerPending = true;
      if (!sampleId) sampleId = id;
    }
  }
  maybeFireExternalTrigger(sampleId);   // also flushes a trigger deferred by the debounce
}
const externalFillSweepTimer = setInterval(sweepExternalFills, 5_000);
if (typeof externalFillSweepTimer.unref === 'function') externalFillSweepTimer.unref();

// wsPool: per-IBA Fyers Order WebSocket connection state.
//   Key: iba_id (UUID).  Value: see makeIbaWsState() shape.
// Connections are reconciled on each orders-monitoring poll: ensure one WS
// per IBA appearing in the response with the latest access_token. WS stays
// up while running, auto-reconnects on disconnect with backoff.
const wsPool = new Map();

// Monitoring-loop metrics
let lastMonitoringPollAt        = null;
let lastMonitoringPollMode      = null;   // 'busy' | 'idle'
let totalMonitoringPolls        = 0;
let totalStatusUpdatesFromWs    = 0;
let totalStatusUpdatesFromRest  = 0;
let totalIbaWsOpens             = 0;
let totalIbaWsCloses            = 0;
let totalIbaWsErrors            = 0;
let totalGapFillRestCalls       = 0;
let totalGapFillRestErrors      = 0;
let totalDedupSkips             = 0;   // cmd-complete calls saved by snapshot dedup

// F2 dedup cache: when the broker reports a status tuple identical to the
// last value we successfully wrote, the cmd-complete round-trip is skipped
// (idempotent PATCH at the EF would no-op anyway, but the EF call still
// burns 1 invocation). Populated AFTER a successful writeback, so a failed
// writeback retries on the next sweep. Shared between the REST safety-net
// path and the WS push path, so duplicate WS events also dedup.
// Snapshot key: "broker_status|filled_qty|avg_fill_price" (empty string for nulls).
const lastStatusSnapshot = new Map();   // command_id → snapshot string

// ── HMAC signing (mirrors supabase/functions/_shared/hmac.ts) ───────────────

function sha256Hex(message) {
  return crypto.createHash('sha256').update(message).digest('hex');
}

function hmacSha256Hex(key, message) {
  return crypto.createHmac('sha256', key).update(message).digest('hex');
}

function signHmacRequest(method, _path, body) {
  // Canonical string: METHOD\nTIMESTAMP\nNONCE\nSHA256(body) — no path.
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyHash = sha256Hex(body || '');
  const canonical = [method.toUpperCase(), timestamp, nonce, bodyHash].join('\n');
  const signature = hmacSha256Hex(WMS_LIVE_HMAC_SECRET, canonical);
  return {
    'X-WMS-Timestamp': timestamp,
    'X-WMS-Nonce':     nonce,
    'X-WMS-Signature': signature,
  };
}

// ── Supabase Edge Function clients ──────────────────────────────────────────

async function callCmdPoll() {
  const body = JSON.stringify({ claimed_by: DROPLET_ID });
  const path = new URL(POLL_URL).pathname;
  const sigHeaders = signHmacRequest('POST', path, body);

  const res = await fetch(POLL_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      ...sigHeaders,
    },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}

  if (!res.ok) {
    throw new Error(`cmd-poll ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

async function callCmdComplete(payload) {
  const body = JSON.stringify(payload);
  const path = new URL(COMPLETE_URL).pathname;
  const sigHeaders = signHmacRequest('POST', path, body);

  const res = await fetch(COMPLETE_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      ...sigHeaders,
    },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}

  if (!res.ok) {
    throw new Error(`cmd-complete ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

// ── Broker adapters ─────────────────────────────────────────────────────────

const FYERS_BASE = 'https://api-t1.fyers.in';
function mapFyersAcceptStatus() { return 'PENDING'; }
function mapFyersRejectStatus() { return 'REJECTED'; }

async function placeOrderFyers(command, broker) {
  const url = `${FYERS_BASE}/api/v3/orders/sync`;
  // Per WMS-LESSONS §A.16 — strip any signal-source private metadata keys
  // (prefix `_`) from the payload before sending to Fyers. The katalysthive
  // webhook stores `_kh_meta` for its own bookkeeping; other future analyst
  // EFs may use `_<prefix>_meta` similarly. Fyers's order endpoint either
  // rejects or silently logs unknown fields — neither is what we want.
  const cleanPayload = Object.fromEntries(
    Object.entries(command.payload || {}).filter(([k]) => !k.startsWith('_')),
  );
  const body = JSON.stringify(cleanPayload);

  console.log(`[place ${command.id}] →`, url);
  console.log(`[place ${command.id}] payload:`, body);

  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `${FYERS_APP_ID}:${broker.api_access_token}`,
    },
    body,
  });
  const dt = Date.now() - t0;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}

  console.log(`[place ${command.id}] response (${res.status}, ${dt}ms):`, text.slice(0, 500));

  if (res.ok && json?.s === 'ok' && json?.id) {
    return {
      outcome:          'placed',
      broker_order_id:  String(json.id),
      broker_response:  json,
      broker_status:    mapFyersAcceptStatus(),
      error_code:       null,
      error_message:    null,
    };
  }

  if (json?.s === 'error' || json?.code) {
    return {
      outcome:          'rejected',
      broker_order_id:  null,
      broker_response:  json,
      broker_status:    mapFyersRejectStatus(),
      error_code:       'BROKER_REJECT',
      error_message:    json?.message || `Fyers code ${json?.code}` || `HTTP ${res.status}`,
    };
  }

  return {
    outcome:          'error',
    broker_order_id:  null,
    broker_response:  json ?? { raw: text.slice(0, 1000) },
    broker_status:    null,
    error_code:       'BROKER_UNKNOWN_RESPONSE',
    error_message:    `HTTP ${res.status}: ${text.slice(0, 200)}`,
  };
}

const BROKER_ADAPTERS = {
  fyers: placeOrderFyers,
  // zerodha:  placeOrderZerodha,   // future
  // angelone: placeOrderAngelOne,  // future
};

// ── modifyOrderFyers — Phase 13 Task #32 ─────────────────────────────────────
// Fyers v3 modify endpoint: PATCH /api/v3/orders/sync
// Body: { id: <broker_order_id>, qty?, type?, limitPrice?, stopPrice? }
// Keeps the SAME broker_order_id — the modify happens in-place at the broker.
// See WMS-LESSONS §A.16.7 for the modify-row semantics.
//
// ⚠️ 2026-07-22 — was PUT, which the Fyers WAF rejected with a 403 Cloudflare
// HTML page (not a JSON error), so EVERY trailing-SL modify failed and stops
// froze at their initial level (GS-LIVE-2026-07-22-ISSUES Fix 3). On the same
// endpoint place=POST and cancel=DELETE work; Fyers v3 modify is PATCH. The
// non-JSON guard below (cf. LESSONS §A.1.10 — Fyers returns HTML on token
// expiry) turns any future WAF/HTML response into a clear error instead of 500
// chars of markup in error_message.
async function modifyOrderFyers(command, broker) {
  const url = `${FYERS_BASE}/api/v3/orders/sync`;
  const cleanPayload = Object.fromEntries(
    Object.entries(command.payload || {}).filter(([k]) => !k.startsWith('_')),
  );
  const body = JSON.stringify(cleanPayload);

  console.log(`[modify ${command.id}] →`, url);
  console.log(`[modify ${command.id}] payload:`, body);

  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `${FYERS_APP_ID}:${broker.api_access_token}`,
    },
    body,
  });
  const dt = Date.now() - t0;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}

  console.log(`[modify ${command.id}] response (${res.status}, ${dt}ms):`, text.slice(0, 500));

  // Non-JSON body = not the Fyers API talking (WAF / Cloudflare / gateway HTML).
  // Surface it as a clear, distinct error rather than dumping HTML into the row.
  if (!json) {
    const looksHtml = /^\s*<(?:!doctype|html)/i.test(text);
    return {
      outcome:          'error',
      broker_order_id:  null,
      broker_response:  { raw: text.slice(0, 500) },
      broker_status:    null,
      error_code:       looksHtml ? 'BROKER_NON_JSON_HTML' : 'BROKER_NON_JSON',
      error_message:    `HTTP ${res.status} non-JSON modify response${looksHtml ? ' (WAF/HTML — wrong method or endpoint?)' : ''}`,
    };
  }

  if (res.ok && json?.s === 'ok') {
    return {
      outcome:          'modified',
      broker_order_id:  String(json.id ?? cleanPayload.id ?? ''),
      broker_response:  json,
      broker_status:    null,                 // intentional: modify row stays out of F2 working filter
      error_code:       null,
      error_message:    null,
    };
  }

  if (json?.s === 'error' || json?.code) {
    return {
      outcome:          'rejected',
      broker_order_id:  null,
      broker_response:  json,
      broker_status:    null,
      error_code:       'BROKER_MODIFY_REJECT',
      error_message:    json?.message || `Fyers code ${json?.code}` || `HTTP ${res.status}`,
    };
  }

  return {
    outcome:          'error',
    broker_order_id:  null,
    broker_response:  json ?? { raw: text.slice(0, 1000) },
    broker_status:    null,
    error_code:       'BROKER_UNKNOWN_RESPONSE',
    error_message:    `HTTP ${res.status}: ${text.slice(0, 200)}`,
  };
}

// ── cancelOrderFyers — Phase 13 Task #48a (SL cancel then market on exit) ────
// Fyers v3 cancel endpoint: DELETE /api/v3/orders/sync
// Body: { id: <broker_order_id> }
// Response on success: { s: 'ok', id: '...', message: '...' }
// Response on reject:  { s: 'error', code: <n>, message: '...' }
//
// The "already filled" case (Fyers refuses cancel because the order just filled
// on its own) is the critical race that handleExit must detect — hence the
// distinct error_code 'CANCEL_ALREADY_FILLED' vs 'BROKER_CANCEL_REJECT'.
// Fyers doesn't have one universal code for this, so we belt-and-suspenders:
// check both the numeric code AND the message text.
async function cancelOrderFyers(command, broker) {
  const url = `${FYERS_BASE}/api/v3/orders/sync`;
  const cleanPayload = Object.fromEntries(
    Object.entries(command.payload || {}).filter(([k]) => !k.startsWith('_')),
  );
  const body = JSON.stringify(cleanPayload);

  console.log(`[cancel ${command.id}] →`, url);
  console.log(`[cancel ${command.id}] payload:`, body);

  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `${FYERS_APP_ID}:${broker.api_access_token}`,
    },
    body,
  });
  const dt = Date.now() - t0;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}

  console.log(`[cancel ${command.id}] response (${res.status}, ${dt}ms):`, text.slice(0, 500));

  if (res.ok && json?.s === 'ok') {
    return {
      outcome:          'cancelled',
      broker_order_id:  String(json.id ?? cleanPayload.id ?? ''),
      broker_response:  json,
      broker_status:    'CANCELLED',
      error_code:       null,
      error_message:    null,
    };
  }

  // Race case: SL filled between our read + our cancel. handleExit uses the
  // distinct error_code to decide whether to place the market exit or skip it.
  // Codes are seeded conservatively; adjust in follow-up once we've observed
  // real Fyers cancel-race responses in production.
  const CANCEL_ALREADY_FILLED_CODES = [-1103];
  const msg = json?.message || '';
  const looksAlreadyFilled = (
    (json?.code && CANCEL_ALREADY_FILLED_CODES.includes(json.code)) ||
    /filled|not open|already executed|complete/i.test(msg)
  );

  if (json?.s === 'error' || json?.code) {
    return {
      outcome:          'error',
      broker_order_id:  null,
      broker_response:  json,
      broker_status:    null,
      error_code:       looksAlreadyFilled ? 'CANCEL_ALREADY_FILLED' : 'BROKER_CANCEL_REJECT',
      error_message:    msg || `Fyers code ${json?.code}` || `HTTP ${res.status}`,
    };
  }

  return {
    outcome:          'error',
    broker_order_id:  null,
    broker_response:  json ?? { raw: text.slice(0, 1000) },
    broker_status:    null,
    error_code:       'BROKER_UNKNOWN_RESPONSE',
    error_message:    `HTTP ${res.status}: ${text.slice(0, 200)}`,
  };
}

// ── Command processing ──────────────────────────────────────────────────────

async function processCommand(command, broker) {
  // Broker code lookup is case-insensitive — WMS DB has 'FYERS' uppercase,
  // adapters map keys are 'fyers' lowercase.
  const adapterKey = (broker.broker_code || '').toLowerCase();
  const adapter = BROKER_ADAPTERS[adapterKey];
  if (!adapter) {
    console.error(`[cmd ${command.id}] no adapter for broker_code='${broker.broker_code}' (looked up as '${adapterKey}')`);
    await callCmdComplete({
      command_id:    command.id,
      outcome:       'error',
      error_code:    'NO_BROKER_ADAPTER',
      error_message: `No adapter registered for broker_code='${broker.broker_code}'`,
      attempts:      command.attempts,
    });
    totalCommandsErrored++;
    return;
  }

  // Dispatch by _kh_meta.action_type (default 'place'). Per WMS-LESSONS §A.16.7.
  const actionType = command.payload?._kh_meta?.action_type ?? 'place';

  let result;
  try {
    if (actionType === 'modify') {
      // modifyOrderFyers is Fyers-specific for now; broker-agnostic refactor when 2nd
      // broker adds modify support.
      if (adapterKey === 'fyers') {
        result = await modifyOrderFyers(command, broker);
      } else {
        throw new Error(`modify not supported for broker_code='${broker.broker_code}'`);
      }
    } else if (actionType === 'cancel') {
      // cancelOrderFyers is Fyers-specific for now; broker-agnostic refactor when 2nd
      // broker adds cancel support. Phase 13 Task #48a.
      if (adapterKey === 'fyers') {
        result = await cancelOrderFyers(command, broker);
      } else {
        throw new Error(`cancel not supported for broker_code='${broker.broker_code}'`);
      }
    } else {
      result = await adapter(command, broker);
    }
    lastPlaceAt = Date.now();
  } catch (err) {
    console.error(`[cmd ${command.id}] ${actionType} threw:`, err);
    result = {
      outcome:       'error',
      error_code:    actionType === 'modify' ? 'MODIFY_EXCEPTION'
                   : actionType === 'cancel' ? 'CANCEL_EXCEPTION'
                   : 'PLACE_EXCEPTION',
      error_message: String(err?.message || err).slice(0, 500),
      broker_status: null,
    };
  }

  // Build cmd-complete payload. For 'modified', include the parent_command_id +
  // new prices so cmd-complete can ALSO update the parent SL row's payload.
  // For 'cancelled', include parent_command_id so cmd-complete can flip the
  // parent SL's broker_status to CANCELLED (out of F2 orders-monitoring's filter).
  const completePayload = {
    command_id:      command.id,
    outcome:         result.outcome,
    broker_order_id: result.broker_order_id ?? null,
    broker_response: result.broker_response ?? null,
    broker_status:   result.broker_status ?? null,
    error_code:      result.error_code ?? null,
    error_message:   result.error_message ?? null,
    attempts:        command.attempts,
  };
  if (result.outcome === 'modified') {
    completePayload.parent_command_id = command.payload?._kh_meta?.parent_command_id ?? null;
    completePayload.new_payload = {
      stopPrice:  command.payload?.stopPrice,
      limitPrice: command.payload?.limitPrice,
      type:       command.payload?.type,
    };
  }
  if (result.outcome === 'cancelled') {
    completePayload.parent_command_id = command.payload?._kh_meta?.parent_command_id ?? null;
  }

  // ── WS-3 (2026-07-10) — REGISTER THE ORDER ID BEFORE THE WRITEBACK ──────────
  // This used to sit AFTER `callCmdComplete`, i.e. after a network round-trip.
  // Fyers places a market order in ~46ms and pushes its order + trade events
  // immediately. Every one of those events arrived while the reverse-lookup was
  // still empty, so `handleFyersWsMessage` failed the `commandId` lookup and
  // returned SILENTLY — no log, no counter, nothing. The fill was then found
  // minutes later by the REST safety-net, which is why the WebSocket looked dead
  // even after we opened it.
  //
  // Proven 2026-07-10 on order 26071000332245: placed 13:13:20 (46ms), 3 order
  // events + 1 trade event received, `status_updates_ws` stayed 0, and the
  // command row sat at PENDING with filled_qty NULL for minutes.
  //
  // Registering first shrinks the window but cannot close it: an event can
  // arrive while we are still awaiting the placement response, before we know
  // the id at all. `registerBrokerOrder` therefore also REPLAYS any event that
  // was buffered for this id. Never re-order these two calls.
  if (result.outcome === 'placed' && result.broker_order_id) {
    registerBrokerOrder(result.broker_order_id, command.id);
  }

  try {
    await callCmdComplete(completePayload);
  } catch (err) {
    console.error(`[cmd ${command.id}] cmd-complete writeback FAILED:`, err);
  }

  if (result.outcome === 'placed') {
    totalCommandsPlaced++;
    console.log(`[cmd ${command.id}] ✅ placed — broker_order_id=${result.broker_order_id}`);
  } else if (result.outcome === 'modified') {
    totalCommandsPlaced++;
    console.log(`[cmd ${command.id}] ✅ modified — broker_order_id=${result.broker_order_id} (parent=${command.payload?._kh_meta?.parent_command_id})`);
    // Note: do NOT add modify row's broker_order_id to brokerOrderIdToCommandId
    // (it's the same as parent's; the parent row is the F2 tracker, not us).
  } else if (result.outcome === 'rejected') {
    totalCommandsErrored++;
    console.log(`[cmd ${command.id}] ❌ rejected — ${result.error_message}`);
  } else {
    totalCommandsErrored++;
    console.log(`[cmd ${command.id}] ⚠️  error — ${result.error_code}: ${result.error_message}`);
  }
}

// ── Trigger entry point — called by BOTH the LISTEN client and the safety-net poll
async function triggerClaimAttempt(reason) {
  // Defensive dedup — if a claim attempt is already in flight, skip.
  // cmd-poll's atomic claim handles concurrent invocations correctly server-
  // side; this client-side guard saves us a pointless RTT when the LISTEN
  // event and the safety-net poll fire at the same instant.
  if (inFlightTriggers.has(reason)) return;
  inFlightTriggers.add(reason);

  try {
    // Drain the queue: one wake (a NOTIFY, or the safety-net poll) keeps claiming
    // until nothing pending remains. A grid enqueues several commands in ONE
    // transaction, so their NOTIFYs arrive together; claiming one per wake left the
    // LAST of a burst for the 60s safety-net poll (the 29-Aug ~1-min lag on the last
    // grid order). The loop drains the whole burst in seconds, and a lost claim race
    // (cmd-poll returns null while rows remain) is retried by the loop rather than
    // waiting for the poll. cmd-poll's atomic claim still guarantees each command is
    // processed exactly once across concurrent wakes; a claimed command is no longer
    // 'pending', so the loop can neither re-claim it nor spin.
    for (let drained = 0; ; drained++) {
      let resp;
      try {
        resp = await callCmdPoll();
        edgeFunctionConsecutiveErrors = 0;
      } catch (err) {
        edgeFunctionConsecutiveErrors++;
        console.error(`[poll:${reason}] cmd-poll error #${edgeFunctionConsecutiveErrors} — ${err.message}`);
        return;
      }

      if (resp.kill_switch) {
        console.log(`[poll:${reason}] kill_switch=true — skipping`);
        return;
      }
      if (!resp.command) {
        if (drained > 0) console.log(`[poll:${reason}] queue drained — ${drained} command(s) this wake`);
        return;   // nothing pending left
      }

      lastClaimAt = Date.now();
      totalCommandsClaimed++;
      console.log(`[poll:${reason}] claimed command ${resp.command.id} — signal_source=${resp.command.signal_source}, iba_id=${resp.command.iba_id}, broker=${resp.broker?.broker_code}`);

      await processCommand(resp.command, resp.broker);
    }
  } finally {
    inFlightTriggers.delete(reason);
  }
}

// ── Postgres LISTEN client ──────────────────────────────────────────────────

const { Client } = pg;
let pgClient = null;

async function startListenClient() {
  while (running) {
    pgReconnectAttempts++;
    const attemptId = pgReconnectAttempts;

    try {
      pgClient = new Client({
        host:     PG_HOST,
        port:     PG_PORT,
        database: PG_DATABASE,
        user:     PG_USER,
        password: PG_PASSWORD,
        ssl:      { rejectUnauthorized: false }, // Supabase uses self-signed cert; common pattern
        keepAlive: true,
        application_name: `wms-live-${DROPLET_ID}`,
      });

      pgClient.on('error', (err) => {
        console.error('[pg] client error:', err.message);
        // Connection errors trigger the catch block below via reject;
        // 'end' triggers reconnection.
      });

      pgClient.on('notification', (msg) => {
        // msg = { channel: '...', payload: '...', processId: ... }
        if (msg.channel !== LISTEN_CHANNEL) return;
        lastNotificationAt = Date.now();
        totalNotificationsReceived++;
        const commandId = msg.payload;
        console.log(`[pg] NOTIFY ${LISTEN_CHANNEL} payload=${commandId}`);
        // Fire-and-forget — triggerClaimAttempt internally handles errors + dedup
        triggerClaimAttempt(`notify-${commandId}`).catch((err) => {
          console.error(`[pg] triggerClaimAttempt failed for ${commandId}:`, err);
        });
      });

      pgClient.on('end', () => {
        console.warn('[pg] connection ended');
        pgConnected = false;
      });

      console.log(`[pg] connecting (attempt #${attemptId}) to ${PG_HOST}:${PG_PORT} as ${PG_USER}...`);
      await pgClient.connect();
      console.log(`[pg] connected. LISTENing on '${LISTEN_CHANNEL}'.`);
      pgConnected = true;
      pgReconnectAttempts = 0; // reset backoff after a successful connect

      await pgClient.query(`LISTEN ${LISTEN_CHANNEL}`);

      // Gap-fill on (re)connect — anything inserted while we were disconnected
      // is invisible to LISTEN. Run one cmd-poll to catch up.
      console.log('[pg] connected — running gap-fill cmd-poll');
      triggerClaimAttempt('gap-fill-on-connect').catch((err) => {
        console.error('[pg] gap-fill failed:', err);
      });

      // Block here until the connection ends. pg.Client doesn't have an
      // explicit "wait for end" promise, so we wrap the events.
      await new Promise((resolve) => {
        pgClient.once('end', resolve);
        pgClient.once('error', resolve);
      });

      pgConnected = false;
      console.warn('[pg] connection terminated, will reconnect');
    } catch (err) {
      pgConnected = false;
      console.error(`[pg] connect failed (attempt #${attemptId}):`, err.message);
    }

    if (!running) break;

    // Exponential backoff before reconnect
    const backoffMs = Math.min(
      PG_RECONNECT_BACKOFF_MAX_MS,
      1000 * Math.pow(2, Math.min(pgReconnectAttempts, 5)),
    );
    console.log(`[pg] reconnecting in ${backoffMs}ms`);
    await sleep(backoffMs);
  }

  console.log('[pg] listen loop exiting');
}

// ── Safety-net poll loop ────────────────────────────────────────────────────

async function safetyNetPollLoop() {
  console.log(`[safety-net] starting — every ${PG_POLL_SAFETY_NET_MS}ms`);
  while (running) {
    await sleep(PG_POLL_SAFETY_NET_MS);
    if (!running) break;

    lastSafetyNetPollAt = Date.now();
    totalSafetyNetPolls++;
    try {
      await triggerClaimAttempt('safety-net');
    } catch (err) {
      console.error('[safety-net] poll failed:', err);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ════════════════════════════════════════════════════════════════════════════
// Phase F2 — order status tracking
//
// Two parallel paths keep wms_live_commands.broker_status in sync with the
// broker's truth, redundantly:
//
//   (a) Fyers Order WebSocket (push, low latency) — per-IBA persistent
//       connection. On every order event we resolve broker_order_id back to
//       command_id via brokerOrderIdToCommandId, derive broker_status from
//       Fyers's status code, and PATCH via wms-live-cmd-complete (flavor B).
//
//   (b) REST safety-net (pull, every MONITORING_POLL_BUSY_MS=30s) — calls the
//       wms-live-orders-monitoring Edge Function, which atomically returns
//       all working orders grouped by IBA along with each IBA's broker code
//       and current API access token. For each working order, the Droplet
//       GETs the broker's /orders?id=… and PATCHes back if the status differs.
//
// The two paths are idempotent at the writeback layer (cmd-complete just
// overwrites broker_status/filled_qty/avg_fill_price). The WS is the primary
// path; the REST loop is the catch-up if the WS missed a message or was
// disconnected. When no working orders exist anywhere, the monitoring loop
// drops to MONITORING_POLL_IDLE_MS=5min to conserve Edge Function quota.
// ════════════════════════════════════════════════════════════════════════════

// ── HMAC client: orders-monitoring + cmd-complete flavor B ──────────────────

async function callOrdersMonitoring() {
  const body = JSON.stringify({ droplet_id: DROPLET_ID });
  const path = new URL(MONITORING_URL).pathname;
  const sigHeaders = signHmacRequest('POST', path, body);

  const res = await fetch(MONITORING_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      ...sigHeaders,
    },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}

  if (!res.ok) {
    throw new Error(`orders-monitoring ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

async function callCmdCompleteStatus({ command_id, broker_status, filled_qty, avg_fill_price, broker_fill_time }) {
  const body = JSON.stringify({
    command_id,
    broker_status,
    filled_qty,
    avg_fill_price,
    last_status_check_at: new Date().toISOString(),
    ...(broker_fill_time ? { broker_fill_time } : {}),   // #4: exchange fill stamp when we have one
  });
  const path = new URL(COMPLETE_URL).pathname;
  const sigHeaders = signHmacRequest('POST', path, body);

  const res = await fetch(COMPLETE_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      ...sigHeaders,
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`cmd-complete(status) ${res.status}: ${text.slice(0, 300)}`);
  }
  try { return JSON.parse(text); } catch { return null; }
}

// Build the snapshot key. nulls become empty strings so "OPEN|0|0" and
// "OPEN|null|null" don't compare as different on the first ever sweep.
function makeStatusSnapshot(broker_status, filled_qty, avg_fill_price) {
  const fq = (filled_qty === null || filled_qty === undefined) ? '' : String(filled_qty);
  const ap = (avg_fill_price === null || avg_fill_price === undefined) ? '' : String(avg_fill_price);
  return `${broker_status}|${fq}|${ap}`;
}

// Push a status update to wms-live-cmd-complete UNLESS the tuple matches what
// we last wrote for this command. Returns true if the writeback was actually
// sent, false if it was skipped by dedup. The cache is only updated on
// SUCCESS, so a failed writeback retries on the next sweep automatically.
async function pushStatusIfChanged({ command_id, broker_status, filled_qty, avg_fill_price, broker_fill_time }) {
  // Dedup key stays (broker_status, filled_qty, avg_fill_price) — broker_fill_time
  // is passthrough context, never a reason to re-send.
  const snapshot = makeStatusSnapshot(broker_status, filled_qty, avg_fill_price);
  if (lastStatusSnapshot.get(command_id) === snapshot) {
    totalDedupSkips++;
    return false;
  }
  await callCmdCompleteStatus({ command_id, broker_status, filled_qty, avg_fill_price, broker_fill_time });
  lastStatusSnapshot.set(command_id, snapshot);
  return true;
}

// ── Status mapping ──────────────────────────────────────────────────────────

// Fyers org_ord_status codes → WMS broker_status.
//   1 = Cancelled
//   2 = Traded (fully filled)
//   4 = Transit (in our system before exchange)
//   5 = Rejected
//   6 = Pending in market (could be partially filled, see filled_qty)
//   7 = Expired
function mapFyersStatusCode(code, filledQty) {
  const c = Number(code);
  switch (c) {
    case 1: return 'CANCELLED';
    case 2: return 'FILLED';
    case 4: return 'PENDING';
    case 5: return 'REJECTED';
    case 6: return Number(filledQty || 0) > 0 ? 'PARTIAL' : 'OPEN';
    case 7: return 'EXPIRED';
    default:
      console.warn(`[fyers-map] unknown status code ${code} — leaving status untouched`);
      return null;
  }
}

// Read both raw and friendly Fyers field names (raw from WS, friendly from REST).
function readFyersOrderFields(o) {
  return {
    broker_order_id: o.id ?? o.broker_order_id ?? null,
    status_code:     o.org_ord_status ?? o.status ?? null,
    filled_qty:      o.qty_filled ?? o.filledQty ?? 0,
    avg_fill_price:  o.price_traded ?? o.tradedPrice ?? null,
    broker_fill_time: extractFyersOrderTime(o),   // #4: exchange fill stamp (or null)
    // symbol/side/segment — unused for OUR orders (context comes from the command
    // payload), but REQUIRED to book an EXTERNAL fill that has no command row.
    symbol:          o.symbol ?? o.sym ?? o.ex_sym ?? null,
    side:            o.side ?? o.transaction_type ?? null,   // Fyers: 1 = BUY, -1 = SELL
    segment:         o.segment ?? o.seg ?? null,             // 10 equity · 11 NSE F&O · 20 MCX
  };
}

// #4 (2026-07-13) — the exchange's own fill timestamp, for transaction_time.
// DELIBERATELY CONSERVATIVE: accept ONLY unambiguous forms — a numeric epoch
// (seconds or ms) or an ISO-8601 string carrying a timezone (Z or ±hh:mm). A
// naive "DD-MMM-YYYY HH:MM:SS" / "YYYY-MM-DD HH:MM:SS" (Fyers' usual orderDateTime,
// in IST but with NO tz marker) is SKIPPED — parsing it wrong is a silent 5.5h
// error that would slip past the fill-writer's validation window. When we return
// null the fill-writer falls back to our fill-notice time, which post-WS is ~1s
// accurate — so skipping loses ~1s, guessing wrong loses 5.5h. Returns a UTC ISO
// string or null.
function extractFyersOrderTime(o) {
  const cands = [o.orderDateTime, o.order_date_time, o.tradedTime, o.traded_time,
                 o.orderTime, o.order_time, o.tradeDateTime, o.exch_ord_time, o.epoch];
  for (const v of cands) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'number' && Number.isFinite(v)) {
      const ms = v > 1e12 ? v : v * 1000;               // s vs ms
      const d = new Date(ms);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^\d{10,13}$/.test(s)) {                       // numeric-string epoch
        const n = Number(s); const ms = n > 1e12 ? n : n * 1000;
        const d = new Date(ms); if (!isNaN(d.getTime())) return d.toISOString();
      }
      if (/T.*(Z|[+\-]\d{2}:?\d{2})$/.test(s)) {          // ISO WITH timezone
        const d = new Date(s); if (!isNaN(d.getTime())) return d.toISOString();
      }
      // else: naive/ambiguous string — skip (fill-writer uses fill-notice time).
    }
  }
  return null;
}

// ── Fyers REST: orderbook by ID (for REST safety-net gap-fill) ──────────────

async function fetchFyersOrderStatus(accessToken, brokerOrderId) {
  const url = `${FYERS_BASE}/api/v3/orders?id=${encodeURIComponent(brokerOrderId)}`;
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `${FYERS_APP_ID}:${accessToken}`,
    },
  });
  const dt = Date.now() - t0;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}

  if (!res.ok || !json || json.s !== 'ok') {
    throw new Error(`fyers /orders ${res.status} (${dt}ms): ${text.slice(0, 200)}`);
  }

  const orderBook = Array.isArray(json.orderBook) ? json.orderBook : [];
  if (orderBook.length === 0) {
    throw new Error(`fyers /orders returned empty orderBook for id=${brokerOrderId}`);
  }
  return orderBook[0];
}

// ── Fyers Order WebSocket pool (per IBA) ────────────────────────────────────

function makeIbaWsState(group) {
  return {
    iba_id:           group.iba_id,
    broker_code:      group.broker_code,
    account_number:   group.account_number,
    access_token:     group.api_access_token,
    api_token_date:   group.api_token_date,
    ws:               null,
    status:           'init',          // 'init'|'connecting'|'open'|'subscribed'|'closed'
    pingInterval:     null,
    reconnectTimer:   null,
    reconnectAttempts:0,
    connectedAt:      null,
    lastMessageAt:    null,
    lastOrderEventAt: null,
    totalOrdersEvents:0,
    totalTradesEvents:0,
  };
}

function reconcileIbaWsPool(groups) {
  // Ensure one WS per group with the latest token.
  for (const group of groups) {
    if ((group.broker_code || '').toLowerCase() !== 'fyers') {
      // No WS adapter for other brokers yet — REST safety-net still polls them.
      continue;
    }
    const existing = wsPool.get(group.iba_id);
    if (!existing) {
      const state = makeIbaWsState(group);
      wsPool.set(group.iba_id, state);
      console.log(`[ws ${group.iba_id}] new IBA detected (${group.account_number}) — connecting`);
      connectFyersOrderWs(state);
    } else if (existing.access_token !== group.api_access_token) {
      // WS-4 (2026-07-13) — reconnect EXPLICITLY. The old code called
      // closeIbaWs() and relied on "the close-handler's reconnect timer". But
      // closeIbaWs() does `ws.removeAllListeners()` (killing the very close
      // handler that would reconnect) AND `clearTimeout(reconnectTimer)`
      // (cancelling any pending retry). So a token rotation FROZE the socket —
      // it logged "restarting WS" and then never tried again.
      //
      // Real damage: the token rotates every morning (~08:00 IST auto-login).
      // From 2026-07-11 to 2026-07-13 the Fyers order WS sat dead across THREE
      // rotations — status 'reconnecting', 172 stale-token 403s, zero fills
      // pushed — until the service was manually restarted. Every fill in that
      // window came from the REST safety-net (8–257s), invisibly.
      console.log(`[ws ${group.iba_id}] token rotated — restarting WS`);
      existing.access_token = group.api_access_token;
      existing.api_token_date = group.api_token_date;
      existing.reconnectAttempts = 0;                 // fresh token — start the backoff clean
      closeIbaWs(existing, /* permanent */ false);    // tears down + removes listeners
      // closeIbaWs leaves status untouched. connectFyersOrderWs early-returns on
      // 'subscribed'/'open'/'connecting', so we MUST demote status first or the
      // reconnect silently no-ops (the bug we are fixing, reborn).
      existing.status = 'reconnecting';
      connectFyersOrderWs(existing);                  // ...nothing else will
    } else if (existing.status !== 'subscribed' && existing.status !== 'connecting' && !existing.reconnectTimer && !existing.ws) {
      // WS-4 liveness net. If a pool entry is not connected, not connecting, and
      // has NO pending retry, it is FROZEN — some path tore it down without
      // rescheduling. This is the state that went unnoticed for 2.5 days.
      // Revive it on the next poll (≤5 min idle / ≤30s busy), whatever the cause.
      console.warn(`[ws ${group.iba_id}] frozen (status=${existing.status}, no ws, no timer) — forcing reconnect`);
      existing.reconnectAttempts = 0;
      existing.status = 'reconnecting';               // pass connect's early-return guard
      connectFyersOrderWs(existing);
    }
    // else: WS already up (or actively connecting/backing-off) — nothing to do
  }
}

function closeIbaWs(state, permanent) {
  if (state.pingInterval) { clearInterval(state.pingInterval); state.pingInterval = null; }
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  if (state.ws) {
    try { state.ws.removeAllListeners?.(); } catch {}
    try { state.ws.close(); } catch {}
    state.ws = null;
  }
  if (permanent) {
    state.status = 'closed';
    totalIbaWsCloses++;
  }
}

function connectFyersOrderWs(state) {
  if (!running) return;
  if (state.status === 'connecting' || state.status === 'open' || state.status === 'subscribed') {
    return; // already underway
  }
  state.status = 'connecting';
  state.reconnectAttempts++;
  const attemptId = state.reconnectAttempts;

  const ws = new WebSocket(FYERS_ORDER_WS_URL, {
    headers: {
      // Fyers expects "${APP_ID}:${access_token}" with NO 'Bearer' prefix.
      'Authorization': `${FYERS_APP_ID}:${state.access_token}`,
    },
    handshakeTimeout: 15_000,
  });
  state.ws = ws;
  totalIbaWsOpens++;
  console.log(`[ws ${state.iba_id}] connecting (attempt #${attemptId}) → ${FYERS_ORDER_WS_URL}`);

  ws.on('open', () => {
    state.status = 'open';
    state.connectedAt = Date.now();
    state.reconnectAttempts = 0;
    console.log(`[ws ${state.iba_id}] connected — sending SUB_ORD`);

    try {
      // Subscribe to orders + trades streams. SUB_T=1 means subscribe.
      ws.send(JSON.stringify({ T: 'SUB_ORD', SLIST: ['orders', 'trades'], SUB_T: 1 }));
      state.status = 'subscribed';
    } catch (err) {
      console.error(`[ws ${state.iba_id}] subscribe send failed:`, err.message);
    }

    // Start keep-alive ping — Fyers wants the literal text "ping" every ~10s.
    state.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send('ping'); } catch (err) { /* will surface as error event */ }
      }
    }, FYERS_WS_PING_INTERVAL_MS);

    // On (re)connect, kick a gap-fill — anything that changed while we were
    // disconnected won't replay over WS, so the REST loop catches up.
    // We don't await; just nudge the monitoring loop.
    triggerMonitoringGapFill(state.iba_id).catch((err) => {
      console.error(`[ws ${state.iba_id}] post-connect gap-fill failed:`, err.message);
    });
  });

  ws.on('message', (raw) => {
    state.lastMessageAt = Date.now();
    let text;
    try { text = raw.toString('utf8'); } catch { return; }

    // Fyers sends "pong" replies as plain text — ignore.
    if (text === 'pong' || text === 'ping') return;

    let msg;
    try { msg = JSON.parse(text); } catch {
      // Non-JSON heartbeat or unknown — log and skip
      return;
    }

    handleFyersWsMessage(state, msg).catch((err) => {
      console.error(`[ws ${state.iba_id}] message handler error:`, err.message);
    });
  });

  ws.on('error', (err) => {
    totalIbaWsErrors++;
    console.error(`[ws ${state.iba_id}] error:`, err.message);
    // 'close' will follow and trigger reconnect.
  });

  ws.on('close', (code, reasonBuf) => {
    const reason = reasonBuf?.toString?.('utf8') || '';
    console.warn(`[ws ${state.iba_id}] closed (code=${code}, reason="${reason.slice(0,120)}")`);
    if (state.pingInterval) { clearInterval(state.pingInterval); state.pingInterval = null; }
    state.ws = null;
    if (state.status !== 'closed') state.status = 'reconnecting';
    totalIbaWsCloses++;

    if (!running) return;

    const backoffMs = Math.min(
      FYERS_WS_RECONNECT_BACKOFF_MAX_MS,
      1000 * Math.pow(2, Math.min(state.reconnectAttempts, 5)),
    );
    console.log(`[ws ${state.iba_id}] reconnect in ${backoffMs}ms`);
    state.reconnectTimer = setTimeout(() => connectFyersOrderWs(state), backoffMs);
  });
}

// Turn one Fyers order event into a cmd-complete writeback. ONE implementation,
// shared by the live WS path and the replay path — a second copy is how the two
// drift apart (LESSONS A.17.9).
async function applyWsOrderFields(commandId, brokerOrderId, fields, ibaId) {
  const brokerStatus = mapFyersStatusCode(fields.status_code, fields.filled_qty);
  if (!brokerStatus) return false;   // unknown code — mapFyersStatusCode already warned

  const filledQty    = fields.filled_qty !== null && fields.filled_qty !== undefined ? Number(fields.filled_qty) : null;
  const avgFillPrice = fields.avg_fill_price !== null && fields.avg_fill_price !== undefined ? Number(fields.avg_fill_price) : null;

  const wrote = await pushStatusIfChanged({
    command_id:      commandId,
    broker_status:   brokerStatus,
    filled_qty:      filledQty,
    avg_fill_price:  avgFillPrice,
    broker_fill_time: fields.broker_fill_time,
  });
  if (wrote) {
    totalStatusUpdatesFromWs++;
    console.log(`[ws ${ibaId ?? 'replay'}] cmd=${commandId} broker_order_id=${brokerOrderId} → ${brokerStatus} (filled=${filledQty}, avg=${avgFillPrice})`);
  }
  // If !wrote, the event matched our cached snapshot — silent skip.
  return wrote;
}

async function handleFyersWsMessage(state, msg) {
  // Per the Fyers SDK, an order event looks like { orders: {...} } and a
  // trade event looks like { trades: {...} }. SDK wrappers also emit
  // { S: 'CONNECTED', ... } and { S: 'SUB_ACK', ... }-style envelopes;
  // those are informational.
  if (msg && msg.orders) {
    state.totalOrdersEvents++;
    state.lastOrderEventAt = Date.now();

    const o = msg.orders;
    const fields = readFyersOrderFields(o);
    if (!fields.broker_order_id) {
      console.warn(`[ws ${state.iba_id}] order event with no id:`, JSON.stringify(o).slice(0, 200));
      return;
    }
    const brokerOrderId = String(fields.broker_order_id);
    const commandId = brokerOrderIdToCommandId.get(brokerOrderId);
    if (!commandId) {
      // Either (a) not a WMS-placed order — someone traded in the Fyers app, and
      // we legitimately ignore it; or (b) OUR order, whose id we have not
      // registered yet because the placement HTTP call has not returned.
      //
      // (b) is the common case for market orders: Fyers fills in ~100ms. We
      // cannot tell (a) from (b) here, so buffer it. If it was ours,
      // registerBrokerOrder() replays it within milliseconds. If it was not,
      // it expires quietly. Before WS-3 this branch just `return`ed and every
      // fill for our own orders was lost to it.
      bufferWsEvent(brokerOrderId, fields);
      return;
    }

    try {
      await applyWsOrderFields(commandId, brokerOrderId, fields, state.iba_id);
    } catch (err) {
      console.error(`[ws ${state.iba_id}] cmd-complete failed for ${commandId}:`, err.message);
    }
    return;
  }

  if (msg && msg.trades) {
    state.totalTradesEvents++;
    // We don't persist trade-by-trade rows yet — Fyers's order event already
    // gives us filled_qty + avg price which is what wms_live_commands stores.
    // Future: persist trades to a separate table for audit.
    return;
  }

  // Envelopes like {S:'CONNECTED'} or {S:'SUB_ACK'} — log at debug.
  if (msg && msg.S) {
    console.log(`[ws ${state.iba_id}] envelope: ${msg.S}`);
    return;
  }
}

// Trigger a single-IBA gap-fill on WS (re)connect — fire-and-forget.
// Doesn't drive the main loop's cadence, just an extra REST sweep.
async function triggerMonitoringGapFill(ibaId) {
  try {
    const resp = await callOrdersMonitoring();
    if (resp.kill_switch) return;
    const group = (resp.groups || []).find((g) => g.iba_id === ibaId);
    if (!group) return;
    populateReverseLookupFromGroups([group]);
    await gapFillGroupViaRest(group);
  } catch (err) {
    console.error(`[monitor:gap-fill iba=${ibaId}] failed:`, err.message);
  }
}

function populateReverseLookupFromGroups(groups) {
  for (const g of groups || []) {
    for (const o of g.orders || []) {
      if (o.broker_order_id && o.command_id) {
        // registerBrokerOrder, not a bare .set — after a restart the map is empty
        // and a WS event may already be buffered for this order. Replay it.
        registerBrokerOrder(o.broker_order_id, o.command_id);
      }
    }
  }
}

// REST safety-net gap-fill for one group: GET each working order's status
// from the broker and PATCH via cmd-complete (flavor B).
async function gapFillGroupViaRest(group) {
  if ((group.broker_code || '').toLowerCase() !== 'fyers') {
    // Only Fyers REST implemented today; other brokers will be plugged in here
    // alongside their WS adapter.
    return;
  }
  for (const o of group.orders || []) {
    totalGapFillRestCalls++;
    try {
      const broker = await fetchFyersOrderStatus(group.api_access_token, o.broker_order_id);
      const fields = readFyersOrderFields(broker);
      const brokerStatus = mapFyersStatusCode(fields.status_code, fields.filled_qty);
      if (!brokerStatus) continue;

      const filledQty    = fields.filled_qty !== null && fields.filled_qty !== undefined ? Number(fields.filled_qty) : null;
      const avgFillPrice = fields.avg_fill_price !== null && fields.avg_fill_price !== undefined ? Number(fields.avg_fill_price) : null;

      const wrote = await pushStatusIfChanged({
        command_id:      o.command_id,
        broker_status:   brokerStatus,
        filled_qty:      filledQty,
        avg_fill_price:  avgFillPrice,
        broker_fill_time: fields.broker_fill_time,
      });
      if (wrote) {
        totalStatusUpdatesFromRest++;
        console.log(`[rest gap-fill] cmd=${o.command_id} broker_order_id=${o.broker_order_id} → ${brokerStatus} (filled=${filledQty}, avg=${avgFillPrice})`);
      }
      // If !wrote, status unchanged from last sweep — silent skip (saves EF quota).
    } catch (err) {
      totalGapFillRestErrors++;
      console.error(`[rest gap-fill] cmd=${o.command_id} broker_order_id=${o.broker_order_id} FAILED: ${err.message}`);
    }
  }
}

// ── Main monitoring loop — runs forever ─────────────────────────────────────
async function ordersMonitoringLoop() {
  // Initial small delay so HTTP server + LISTEN client log first.
  await sleep(2000);
  console.log(`[monitor] starting — busy=${MONITORING_POLL_BUSY_MS}ms idle=${MONITORING_POLL_IDLE_MS}ms`);

  while (running) {
    let nextDelay = MONITORING_POLL_IDLE_MS;
    let mode = 'idle';

    try {
      lastMonitoringPollAt = Date.now();
      totalMonitoringPolls++;
      const resp = await callOrdersMonitoring();
      edgeFunctionConsecutiveErrors = 0;

      if (resp.kill_switch) {
        console.log('[monitor] kill_switch=true — sleeping idle');
        nextDelay = MONITORING_POLL_IDLE_MS;
      } else {
        const groups = resp.groups || [];
        populateReverseLookupFromGroups(groups);
        reconcileIbaWsPool(groups);

        const totalOrders = groups.reduce((sum, g) => sum + (g.orders?.length || 0), 0);
        if (totalOrders > 0) {
          mode = 'busy';
          nextDelay = MONITORING_POLL_BUSY_MS;
          // Run REST gap-fill concurrently across groups (rare to have >1 today
          // but keeps multi-broker future-proof).
          await Promise.all(groups.map((g) => gapFillGroupViaRest(g)));
        }
      }
    } catch (err) {
      edgeFunctionConsecutiveErrors++;
      console.error(`[monitor] poll error #${edgeFunctionConsecutiveErrors}: ${err.message}`);
      // Back off briefly on errors but don't go full idle — operator might
      // be debugging.
      nextDelay = Math.min(nextDelay, MONITORING_POLL_BUSY_MS);
    }

    lastMonitoringPollMode = mode;
    await sleep(nextDelay);
  }
  console.log('[monitor] loop exiting');
}

// ── HTTP server (/health) ───────────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.get('/health', (_req, res) => {
  const wsPoolView = [...wsPool.values()].map((s) => ({
    iba_id:              s.iba_id,
    broker_code:         s.broker_code,
    account_number:      s.account_number,
    status:              s.status,
    connected_at:        s.connectedAt ? new Date(s.connectedAt).toISOString() : null,
    last_message_at:     s.lastMessageAt ? new Date(s.lastMessageAt).toISOString() : null,
    last_order_event_at: s.lastOrderEventAt ? new Date(s.lastOrderEventAt).toISOString() : null,
    reconnect_attempts:  s.reconnectAttempts,
    api_token_date:      s.api_token_date,
    orders_events:       s.totalOrdersEvents,
    trades_events:       s.totalTradesEvents,
  }));

  res.json({
    status:                'ok',
    service:               pkg.name,
    version:               pkg.version,
    node:                  process.version,
    uptime_seconds:        Math.round((Date.now() - START_TIME) / 1000),
    started_at:            new Date(START_TIME).toISOString(),
    now:                   new Date().toISOString(),
    droplet_id:            DROPLET_ID,
    architecture:          'F2-ws+rest-safety-net',
    pg_connected:          pgConnected,
    pg_reconnect_attempts: pgReconnectAttempts,
    last_notification_at:  lastNotificationAt ? new Date(lastNotificationAt).toISOString() : null,
    last_safety_net_poll_at: lastSafetyNetPollAt ? new Date(lastSafetyNetPollAt).toISOString() : null,
    last_claim_at:         lastClaimAt ? new Date(lastClaimAt).toISOString() : null,
    last_place_at:         lastPlaceAt ? new Date(lastPlaceAt).toISOString() : null,
    last_monitoring_poll_at: lastMonitoringPollAt ? new Date(lastMonitoringPollAt).toISOString() : null,
    last_monitoring_poll_mode: lastMonitoringPollMode,
    safety_net_interval_ms: PG_POLL_SAFETY_NET_MS,
    monitoring_busy_ms:     MONITORING_POLL_BUSY_MS,
    monitoring_idle_ms:     MONITORING_POLL_IDLE_MS,
    edge_function_consecutive_errors: edgeFunctionConsecutiveErrors,
    counters: {
      notifications_received: totalNotificationsReceived,
      safety_net_polls:       totalSafetyNetPolls,
      claimed:                totalCommandsClaimed,
      placed:                 totalCommandsPlaced,
      errored:                totalCommandsErrored,
      monitoring_polls:       totalMonitoringPolls,
      status_updates_ws:      totalStatusUpdatesFromWs,
      status_updates_rest:    totalStatusUpdatesFromRest,
      dedup_skips:            totalDedupSkips,
      iba_ws_opens:           totalIbaWsOpens,
      iba_ws_closes:          totalIbaWsCloses,
      iba_ws_errors:          totalIbaWsErrors,
      gap_fill_rest_calls:    totalGapFillRestCalls,
      gap_fill_rest_errors:   totalGapFillRestErrors,
      tracked_broker_orders:  brokerOrderIdToCommandId.size,
      cached_status_snapshots: lastStatusSnapshot.size,
      // WS-3: events that beat their own placement response, and how many were
      // replayed once the id landed. buffered >> replayed means someone is
      // trading in the Fyers app (fine) — or that registerBrokerOrder isn't
      // being reached (not fine).
      ws_events_buffered:     totalWsEventsBuffered,
      ws_events_replayed:     totalWsEventsReplayed,
      ws_events_awaiting_id:  pendingWsEvents.size,
    },
    ws_pool: wsPoolView,
  });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[wms-live] v${pkg.version} listening on 0.0.0.0:${PORT} (node ${process.version})`);
  console.log(`[wms-live]   architecture              = F2-ws+rest-safety-net`);
  console.log(`[wms-live]   supabase_url              = ${SUPABASE_URL}`);
  console.log(`[wms-live]   fyers_app_id              = ${FYERS_APP_ID}`);
  console.log(`[wms-live]   fyers_order_ws_url        = ${FYERS_ORDER_WS_URL}`);
  console.log(`[wms-live]   droplet_id                = ${DROPLET_ID}`);
  console.log(`[wms-live]   pg_host                   = ${PG_HOST}`);
  console.log(`[wms-live]   pg_port                   = ${PG_PORT}`);
  console.log(`[wms-live]   pg_database               = ${PG_DATABASE}`);
  console.log(`[wms-live]   pg_user                   = ${PG_USER}`);
  console.log(`[wms-live]   pg_poll_safety_net_ms     = ${PG_POLL_SAFETY_NET_MS}`);
  console.log(`[wms-live]   monitoring_poll_busy_ms   = ${MONITORING_POLL_BUSY_MS}`);
  console.log(`[wms-live]   monitoring_poll_idle_ms   = ${MONITORING_POLL_IDLE_MS}`);
  console.log(`[wms-live]   fyers_ws_ping_interval_ms = ${FYERS_WS_PING_INTERVAL_MS}`);
});

// Start the LISTEN client + safety-net loop + F2 monitoring loop AFTER the
// HTTP server is listening.
startListenClient().catch((err) => {
  console.error('[wms-live] LISTEN client crashed:', err);
  process.exit(1);
});

safetyNetPollLoop().catch((err) => {
  console.error('[wms-live] safety-net loop crashed:', err);
  process.exit(1);
});

ordersMonitoringLoop().catch((err) => {
  console.error('[wms-live] orders-monitoring loop crashed:', err);
  process.exit(1);
});

// ── WS-alert (2026-07-13) — heartbeat beacon ────────────────────────────────
// Post our Fyers-order-WS health to wms_live_heartbeat every ~60s (via HMAC).
// An external scheduled task reads that row during market hours and alerts if it
// is STALE (this process is dead) or NOT SUBSCRIBED (the socket is down). This
// is the visibility that was missing when the WS sat dead for 2.5 days
// (2026-07-11..13). MUST NOT throw into the process — a heartbeat failure is
// itself only a monitoring gap, never a reason to crash the order placer.
async function postHeartbeat() {
  try {
    const fyers = [...wsPool.values()].find((s) => (s.broker_code || '').toLowerCase() === 'fyers');
    const subscribed = fyers ? fyers.status === 'subscribed' : false;
    // Startup grace: after a restart (every auto-deploy) the socket isn't up
    // until the first monitoring poll reopens it (~seconds). Report 'starting'
    // during the first 120s of uptime so the watchdog doesn't cry wolf on every
    // deploy. A socket still down PAST 120s reports its real status and alerts.
    let wsStatus = fyers ? fyers.status : 'no-pool-entry';
    if (!subscribed && process.uptime() < 120) wsStatus = 'starting';
    const payload = {
      droplet_id:          DROPLET_ID,
      ws_subscribed:       subscribed,
      ws_status:           wsStatus,
      reconnect_attempts:  fyers ? fyers.reconnectAttempts : null,
      status_updates_ws:   totalStatusUpdatesFromWs,
      last_order_event_at: fyers && fyers.lastOrderEventAt ? new Date(fyers.lastOrderEventAt).toISOString() : null,
      last_message_at:     fyers && fyers.lastMessageAt ? new Date(fyers.lastMessageAt).toISOString() : null,
      uptime_seconds:      Math.round(process.uptime()),
    };
    const body = JSON.stringify(payload);
    const path = new URL(HEARTBEAT_URL).pathname;
    const sigHeaders = signHmacRequest('POST', path, body);
    const res = await fetch(HEARTBEAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, ...sigHeaders },
      body,
    });
    if (!res.ok) console.error(`[heartbeat] POST failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  } catch (err) {
    console.error('[heartbeat] threw (ignored):', err.message);
  }
}
setInterval(() => { if (running) postHeartbeat(); }, HEARTBEAT_MS);
postHeartbeat();   // one immediately so the beacon is fresh from startup

// ── Graceful shutdown ───────────────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`[wms-live] received ${signal}, shutting down`);
  running = false;

  // Close all Fyers Order WebSockets so reconnect timers don't fire
  for (const state of wsPool.values()) {
    try {
      closeIbaWs(state, /* permanent */ true);
    } catch (err) {
      console.error(`[wms-live] closing WS iba_id=${state.iba_id}:`, err.message);
    }
  }
  wsPool.clear();

  // Close pg client first so the LISTEN loop exits cleanly
  if (pgClient && pgConnected) {
    try {
      await pgClient.end();
      console.log('[wms-live] pg client closed');
    } catch (err) {
      console.error('[wms-live] pg client close error:', err);
    }
  }

  server.close((err) => {
    if (err) {
      console.error('[wms-live] HTTP server close error:', err);
      process.exit(1);
    }
    console.log('[wms-live] closed cleanly');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[wms-live] shutdown timed out, forcing exit');
    process.exit(1);
  }, 15_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
