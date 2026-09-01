// wms-prices.js — LIVE MARKET-DATA FEED (dashboard display prices)
// ============================================================================
// An INDEPENDENT service. It is NOT the order-placer (index.js / wms-live) and
// NOT the scalp-engine tick-driver (a future, separate service). Owner rule
// 01-Sep-2026: live-prices, order-placement, and scalp-price must be three
// independent services, never merged — a fault in one must never take the
// others down.
//
// What it does: holds ONE Fyers **Data** WebSocket from the Droplet's static IP
// via the official fyers-api-v3 SDK (the browser cannot reach Fyers' socket —
// undocumented protobuf; see Documentation/Archive/LIVE-PRICES-WS-SPEC.md), and
//   PHASE 1 (this file, now): connects, subscribes to the open scalp contracts,
//     and LOGS ticks to journald so we confirm the wire shape.
//   PHASE 2 (next): relays throttled tick snapshots to the browser over
//     Supabase Realtime (outbound only — the firewall stays SSH-in only).
//
// Token: FYERS_APP_ID from env + the freshest api_access_token from the DB
// (same source the order-placer uses). Auth string is `${APP_ID}:${token}`.
// ============================================================================

import 'dotenv/config';
import http from 'node:http';
import pg from 'pg';
import fyers from 'fyers-api-v3';
const { fyersDataSocket } = fyers;

const FYERS_APP_ID = process.env.FYERS_APP_ID;
const HEALTH_PORT  = Number(process.env.PRICES_HEALTH_PORT) || 3002;
const LOG_PATH     = process.env.FYERS_WS_LOG_PATH || '/tmp';   // PrivateTmp makes /tmp writable + isolated
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const RT_CHANNEL        = process.env.PRICES_RT_CHANNEL || 'wms-prices';
const BROADCAST_MS      = Number(process.env.PRICES_BROADCAST_MS) || 1000;   // relay the latest snapshot at most once/sec

if (!FYERS_APP_ID) { console.error('[wms-prices] FYERS_APP_ID missing — exiting'); process.exit(1); }

const pool = new pg.Pool({
  host:     process.env.PG_HOST,
  port:     Number(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE || 'postgres',
  user:     process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  max: 2,
  ssl: { rejectUnauthorized: false },          // Supabase self-signed cert (same as index.js)
  application_name: 'wms-prices',
});

const state = {
  service: 'wms-prices', phase: 1,
  connected: false, ticks: 0, lastTickAt: null,
  symbols: [], startedAt: new Date().toISOString(), lastError: null,
};

// The Droplet role (wms_live_notify_only) has NO table SELECT by design, so we
// read the token + open scalp symbols through a SECURITY DEFINER function it is
// granted to EXECUTE. One round-trip; nothing else is exposed.
// ── Phase 2: relay throttled tick snapshots to the browser over Supabase
// Realtime (outbound POST only — no inbound port opened on the firewall). ──
const latest = new Map();   // symbol -> { s, lp, ch, chp, h, l, t }
let dirty = false;
function noteTick(msg) {
  if (!msg || msg.type !== 'sf' || !msg.symbol) return;
  latest.set(msg.symbol, {
    s: msg.symbol, lp: msg.ltp, ch: msg.ch, chp: msg.chp,
    h: msg.high_price, l: msg.low_price, t: msg.exch_feed_time || msg.last_traded_time,
  });
  dirty = true;
}
async function broadcast() {
  if (!dirty) return;
  dirty = false;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  const ticks = Array.from(latest.values());
  try {
    const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ topic: RT_CHANNEL, event: 'ticks', payload: { ts: Date.now(), t: ticks }, private: false }] }),
    });
    state.lastBroadcast = { at: new Date().toISOString(), status: res.status, n: ticks.length };
    if (!res.ok && (state.bcErrors = (state.bcErrors || 0) + 1) <= 3) console.error('[wms-prices] broadcast HTTP', res.status, (await res.text()).slice(0, 200));
  } catch (e) {
    if ((state.bcErrors = (state.bcErrors || 0) + 1) <= 3) console.error('[wms-prices] broadcast failed:', String(e && e.message || e));
  }
}
setInterval(broadcast, BROADCAST_MS);

async function bootstrap() {
  const { rows } = await pool.query('select public.at2_ws_bootstrap() as b');
  const b = rows[0]?.b || {};
  return { token: b.token || null, symbols: Array.isArray(b.symbols) ? b.symbols : [] };
}

async function start() {
  let token, symbols = [];
  try { const b = await bootstrap(); token = b.token; symbols = b.symbols; }
  catch (e) { state.lastError = 'bootstrap: ' + String(e && e.message || e); console.error('[wms-prices]', state.lastError); return void setTimeout(start, 30000); }

  if (!token) { console.log('[wms-prices] no Fyers token for today yet — retry in 60s'); return void setTimeout(start, 60000); }

  if (!symbols.length) symbols = ['MCX:SILVERMIC26NOVFUT'];   // fallback so the socket is still proven
  state.symbols = symbols;

  console.log(`[wms-prices] connecting Fyers Data WS — ${symbols.length} symbol(s): ${symbols.join(', ')}`);

  let socket;
  try { socket = fyersDataSocket.getInstance(`${FYERS_APP_ID}:${token}`, LOG_PATH); }
  catch (e) { state.lastError = 'getInstance: ' + String(e && e.message || e); console.error('[wms-prices]', state.lastError); return void setTimeout(start, 30000); }

  socket.on('connect', () => {
    state.connected = true; state.lastError = null;
    console.log('[wms-prices] CONNECTED — subscribing (SymbolUpdate mode)');
    try { if (socket.SymbolUpdateMode) socket.mode(socket.SymbolUpdateMode); } catch (e) { console.warn('[wms-prices] mode() skipped:', String(e && e.message || e)); }
    try { socket.subscribe(symbols); } catch (e) { console.error('[wms-prices] subscribe failed:', String(e && e.message || e)); }
    try { socket.autoreconnect(6); } catch (e) {}
  });

  socket.on('message', (msg) => {
    state.ticks++; state.lastTickAt = new Date().toISOString();
    noteTick(msg);                                   // Phase 2: queue for the Realtime relay
    if (state.ticks <= 6 || state.ticks % 500 === 0) console.log('[tick]', JSON.stringify(msg));
  });

  socket.on('error', (e) => { state.connected = false; state.lastError = typeof e === 'string' ? e : JSON.stringify(e); console.error('[wms-prices] ws error:', state.lastError); });
  socket.on('close', () => { state.connected = false; console.log('[wms-prices] ws closed'); });

  try { socket.connect(); } catch (e) { state.lastError = 'connect: ' + String(e && e.message || e); console.error('[wms-prices]', state.lastError); setTimeout(start, 30000); }
}

http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, ...state }));
}).listen(HEALTH_PORT, '127.0.0.1', () => console.log(`[wms-prices] health on 127.0.0.1:${HEALTH_PORT}`));

process.on('SIGTERM', () => { console.log('[wms-prices] SIGTERM — bye'); process.exit(0); });

start();
