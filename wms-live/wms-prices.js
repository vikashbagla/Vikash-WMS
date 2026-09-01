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

async function freshToken() {
  const { rows } = await pool.query(
    `select api_access_token
       from investor_broker_accounts
      where api_access_token is not null and api_token_date = current_date
      order by api_token_generated_at desc nulls last
      limit 1`);
  return rows[0]?.api_access_token || null;
}

async function scalpSymbols() {
  // Phase-1 universe: the contracts of currently-open AT2 SCALP rungs — the
  // exact set the dashboard P&L cares about. Phase 2 widens to the full display
  // universe (watchlist / portfolio / F&O).
  const { rows } = await pool.query(
    `select distinct s.symbol
       from at2_trade t
       join securities_nfo s        on s.id  = t.security_id
       join at2_strategy st         on st.id = t.strategy_id
       join at2_strategy_family f   on f.id  = st.family_id
      where f.code = 'SCALP' and t.status like 'open%' and s.symbol is not null`);
  return rows.map((r) => r.symbol);
}

async function start() {
  let token;
  try { token = await freshToken(); }
  catch (e) { state.lastError = 'token read: ' + String(e && e.message || e); console.error('[wms-prices]', state.lastError); return void setTimeout(start, 30000); }

  if (!token) { console.log('[wms-prices] no Fyers token for today yet — retry in 60s'); return void setTimeout(start, 60000); }

  let symbols = [];
  try { symbols = await scalpSymbols(); } catch (e) { console.error('[wms-prices] symbol query failed:', String(e && e.message || e)); }
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
    if (state.ticks <= 20 || state.ticks % 50 === 0) console.log('[tick]', JSON.stringify(msg));
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
