// wms-scalp-ws.js — SCALP-ENGINE TICK DRIVER (Option A: own Fyers socket)
// ============================================================================
// The THIRD independent Droplet service (owner rule 2026-09-01): separate from
// wms-live (orders) and wms-prices (display feed). Own Fyers Data WebSocket for
// just the enabled scalp contracts; on a meaningful price move it pokes the
// at2-scalp `tick` action so the engine reacts in ~real time instead of on the
// 2-minute cron. The GRID BRAIN stays in the Edge Function — this is a thin
// trigger, it never decides a trade itself.
//
// Why its own socket (not sharing wms-prices): latency is equal either way
// (both raw off Fyers), but a separate socket keeps this fully independent — a
// fault in the display feed can't blind the engine, and vice versa.
//
// Poke policy (bounds Edge-Function calls): per contract, call `tick` when the
// price has moved >= threshold since the last poke (threshold = 0.4 x the
// strategy's smaller interval, so it fires ~2-3x per grid step), OR at least
// every HEARTBEAT_MS (catches a flat/fresh first-buy and slow drifts). The
// engine is idempotent (re-derives from state), so an extra poke is harmless.
// ============================================================================

import 'dotenv/config';
import http from 'node:http';
import pg from 'pg';
import fyers from 'fyers-api-v3';
const { fyersDataSocket } = fyers;

const FYERS_APP_ID      = process.env.FYERS_APP_ID;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const CRON_SECRET_KEY   = process.env.CRON_SECRET_KEY;          // to auth the `tick` call
const HEALTH_PORT       = Number(process.env.SCALP_WS_HEALTH_PORT) || 3003;
const HEARTBEAT_MS      = Number(process.env.SCALP_WS_HEARTBEAT_MS) || 20000;
const LOG_PATH          = process.env.FYERS_WS_LOG_PATH || '/tmp';

if (!FYERS_APP_ID)     { console.error('[scalp-ws] FYERS_APP_ID missing'); process.exit(1); }
if (!CRON_SECRET_KEY)  { console.error('[scalp-ws] CRON_SECRET_KEY missing — cannot auth tick calls'); process.exit(1); }

const pool = new pg.Pool({
  host: process.env.PG_HOST, port: Number(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE || 'postgres', user: process.env.PG_USER,
  password: process.env.PG_PASSWORD, max: 2, ssl: { rejectUnauthorized: false },
  application_name: 'wms-scalp-ws',
});

let liveToken = null;
let lastTickMs = 0;
const bySymbol = new Map();     // symbol -> { code, threshold, lastPokePrice, lastPokeMs }
const state = { service: 'wms-scalp-ws', connected: false, ticks: 0, pokes: 0, lastPokeAt: null, symbols: [], startedAt: new Date().toISOString(), lastError: null };

async function universe() {
  const { rows } = await pool.query('select public.at2_scalp_ws_universe() as u');
  const u = rows[0]?.u || {};
  return { token: u.token || null, strategies: Array.isArray(u.strategies) ? u.strategies : [] };
}

function buildMap(strategies) {
  bySymbol.clear();
  for (const s of strategies) {
    if (!s.symbol) continue;
    const step = Math.min(Number(s.entry_interval) || Infinity, Number(s.target_interval) || Infinity);
    const threshold = Number.isFinite(step) ? Math.max(step * 0.4, 0) : 0;
    bySymbol.set(s.symbol, { code: s.code, threshold, lastPokePrice: null, lastPokeMs: 0 });
  }
  state.symbols = Array.from(bySymbol.keys());
}

async function pokeTick(code, price) {
  state.pokes++; state.lastPokeAt = new Date().toISOString();
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/at2-scalp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'x-cron-key': CRON_SECRET_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'tick', price, strategy: code }),
    });
    if (!res.ok && (state.pokeErrors = (state.pokeErrors || 0) + 1) <= 5) console.error('[scalp-ws] tick HTTP', res.status, (await res.text()).slice(0, 200));
  } catch (e) {
    if ((state.pokeErrors = (state.pokeErrors || 0) + 1) <= 5) console.error('[scalp-ws] tick call failed:', String(e && e.message || e));
  }
}

function onTick(msg) {
  if (!msg || msg.type !== 'sf' || !msg.symbol) return;
  const st = bySymbol.get(msg.symbol);
  if (!st) return;
  state.ticks++; lastTickMs = Date.now();
  const price = Number(msg.ltp);
  if (!Number.isFinite(price) || price <= 0) return;
  const moved = st.lastPokePrice == null || Math.abs(price - st.lastPokePrice) >= st.threshold;
  const stale = (Date.now() - st.lastPokeMs) >= HEARTBEAT_MS;
  if (moved || stale) {
    st.lastPokePrice = price; st.lastPokeMs = Date.now();
    pokeTick(st.code, price);
  }
}

async function start() {
  let u;
  try { u = await universe(); }
  catch (e) { state.lastError = 'universe: ' + String(e && e.message || e); console.error('[scalp-ws]', state.lastError); return void setTimeout(start, 30000); }
  if (!u.token) { console.log('[scalp-ws] no token yet — retry 60s'); return void setTimeout(start, 60000); }
  if (!u.strategies.length) { console.log('[scalp-ws] no enabled scalp strategies — idle, recheck in 60s'); liveToken = u.token; return void setTimeout(start, 60000); }
  liveToken = u.token;
  buildMap(u.strategies);
  console.log(`[scalp-ws] connecting Fyers Data WS — ${state.symbols.length} contract(s): ${state.symbols.join(', ')}`);

  let socket;
  try { socket = fyersDataSocket.getInstance(`${FYERS_APP_ID}:${liveToken}`, LOG_PATH); }
  catch (e) { state.lastError = 'getInstance: ' + String(e && e.message || e); console.error('[scalp-ws]', state.lastError); return void setTimeout(start, 30000); }

  socket.on('connect', () => {
    state.connected = true; state.lastError = null;
    console.log('[scalp-ws] CONNECTED — subscribing');
    try { if (socket.SymbolUpdateMode) socket.mode(socket.SymbolUpdateMode); } catch (e) {}
    try { socket.subscribe(state.symbols); } catch (e) { console.error('[scalp-ws] subscribe failed:', String(e && e.message || e)); }
    try { socket.autoreconnect(6); } catch (e) {}
  });
  socket.on('message', onTick);
  socket.on('error', (e) => { state.connected = false; state.lastError = typeof e === 'string' ? e : JSON.stringify(e); console.error('[scalp-ws] ws error:', state.lastError); });
  socket.on('close', () => { state.connected = false; console.log('[scalp-ws] ws closed'); });
  try { socket.connect(); } catch (e) { state.lastError = 'connect: ' + String(e && e.message || e); setTimeout(start, 30000); }
}

// token rotation + universe-change guard: re-check every 60s; restart on change
setInterval(async () => {
  try {
    const u = await universe();
    if (u.token && liveToken && u.token !== liveToken) { console.log('[scalp-ws] token rotated — restarting'); process.exit(1); }
    const nowSet = u.strategies.map((s) => s.symbol).sort().join(',');
    if (state.symbols.length && nowSet !== state.symbols.slice().sort().join(',')) { console.log('[scalp-ws] scalp universe changed — restarting to re-subscribe'); process.exit(1); }
  } catch (e) { /* transient */ }
}, 60000);

// stale-feed watchdog (market hours)
function istActiveHours() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) return false;
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 540 && m <= 1415;
}
setInterval(() => {
  if (state.connected && istActiveHours() && lastTickMs && (Date.now() - lastTickMs) > 120000) {
    console.log('[scalp-ws] no ticks >120s during market hours — restarting'); process.exit(1);
  }
}, 30000);

http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, ...state })); })
  .listen(HEALTH_PORT, '127.0.0.1', () => console.log(`[scalp-ws] health on 127.0.0.1:${HEALTH_PORT}`));
process.on('SIGTERM', () => { console.log('[scalp-ws] SIGTERM — bye'); process.exit(0); });

start();
