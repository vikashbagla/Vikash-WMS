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
// Poke policy (LEVEL-AWARE, mig 114): per contract the engine publishes the next
// armed entry level (at2_book.next_entry_level, surfaced via at2_scalp_ws_universe).
// The driver pokes `tick` when price CROSSES that level from the actionable side
// (long: <=, short: >=), inside the band + market hours; a flat first-entry book is
// poked on the next in-band tick. NO idle heartbeat (owner 03-Sep). The engine is
// idempotent + run-locked + single-cover-guarded, so an extra poke is harmless. A
// pre-mig-114 universe (no band) falls back to poke-on-move so deploy order is safe.
// ============================================================================

import 'dotenv/config';
import http from 'node:http';
import pg from 'pg';
import fyers from 'fyers-api-v3';
const { fyersDataSocket } = fyers;
import { decidePoke } from './scalp-poke.js';   // pure poke-decision (level-aware, mig 114) — unit-tested separately

const FYERS_APP_ID      = process.env.FYERS_APP_ID;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const CRON_SECRET_KEY   = process.env.CRON_SECRET_KEY;          // to auth the `tick` call
const HEALTH_PORT       = Number(process.env.SCALP_WS_HEALTH_PORT) || 3003;
// Level-aware poking (mig 114): no idle heartbeat. A flat first-entry book is poked
// on the next in-band tick, throttled by this cooldown until the entry books + the
// universe refreshes. The safety re-derive is a slow catch for a SILENT LISTEN stall
// (a detectable drop re-derives on reconnect — see startListener); D6 = reconnect + 30 min.
const FIRST_ENTRY_COOLDOWN_MS = Number(process.env.SCALP_WS_FIRST_ENTRY_COOLDOWN_MS) || 3000;
const SAFETY_REDERIVE_MS      = Number(process.env.SCALP_WS_SAFETY_REDERIVE_MS) || 1800000; // 30 min
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
let socket = null;              // hoisted: the LISTEN handler re-subscribes on the LIVE socket
let refreshTimer = null;        // debounce for wms_ws_refresh notifications

async function universe() {
  const { rows } = await pool.query('select public.at2_scalp_ws_universe() as u');
  const u = rows[0]?.u || {};
  return { token: u.token || null, strategies: Array.isArray(u.strategies) ? u.strategies : [] };
}

// Reconcile the live subscription to the strategies' contracts WITHOUT a restart.
// Additions are subscribed, removals unsubscribed, on the live socket; a symbol
// that persists keeps its poke state (lastPokePrice/lastPokeMs). Returns the diff.
function applyStrategies(strategies) {
  const desired = new Map();
  for (const s of strategies) {
    if (!s.symbol) continue;
    const bandLo = Number(s.band_lower), bandHi = Number(s.band_upper);
    const levelAware = Number.isFinite(bandLo) && Number.isFinite(bandHi);   // false on a pre-mig-114 universe
    const step = Math.min(Number(s.entry_interval) || Infinity, Number(s.target_interval) || Infinity);
    const threshold = Number.isFinite(step) ? Math.max(step * 0.4, 0) : 0;   // legacy fallback only
    desired.set(s.symbol, {
      code: s.code, levelAware,
      direction: s.direction === 'short' ? 'short' : 'long',
      bandLo: levelAware ? bandLo : null, bandHi: levelAware ? bandHi : null,
      trigger: (s.trigger === null || s.trigger === undefined) ? null : Number(s.trigger),
      target: (s.target_trigger === null || s.target_trigger === undefined) ? null : Number(s.target_trigger),
      firstEntry: !!s.first_entry, threshold,
    });
  }
  const added = [], removed = [];
  for (const [sym, cfg] of desired) {
    const cur = bySymbol.get(sym);
    if (!cur) { bySymbol.set(sym, { ...cfg, lastPokePrice: null, lastCrossTrigger: null, lastCrossTarget: null, lastFirstPokeMs: 0 }); added.push(sym); }
    else { cur.code = cfg.code; cur.levelAware = cfg.levelAware; cur.direction = cfg.direction; cur.bandLo = cfg.bandLo; cur.bandHi = cfg.bandHi; cur.trigger = cfg.trigger; cur.target = cfg.target; cur.firstEntry = cfg.firstEntry; cur.threshold = cfg.threshold; }   // persist poke state (lastCrossTrigger etc.)
  }
  for (const sym of Array.from(bySymbol.keys())) {
    if (!desired.has(sym)) { bySymbol.delete(sym); removed.push(sym); }
  }
  state.symbols = Array.from(bySymbol.keys());
  if (socket && state.connected) {
    if (added.length)   { try { socket.subscribe(added);     console.log('[scalp-ws] +subscribe', added.join(',')); }   catch (e) { console.error('[scalp-ws] subscribe(add) failed:', String(e && e.message || e)); } }
    if (removed.length) { try { socket.unsubscribe(removed); console.log('[scalp-ws] -unsubscribe', removed.join(',')); } catch (e) { console.warn('[scalp-ws] unsubscribe unsupported/failed (harmless until restart):', String(e && e.message || e)); } }
  }
  return { added, removed };
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
  const d = decidePoke(st, price, Date.now(), FIRST_ENTRY_COOLDOWN_MS, istActiveHours());
  if (d.set) Object.assign(st, d.set);
  if (d.poke) pokeTick(st.code, price);
}

async function start() {
  let u;
  try { u = await universe(); }
  catch (e) { state.lastError = 'universe: ' + String(e && e.message || e); console.error('[scalp-ws]', state.lastError); return void setTimeout(start, 30000); }
  if (!u.token) { console.log('[scalp-ws] no token yet — retry 60s'); return void setTimeout(start, 60000); }
  if (!u.strategies.length) { console.log('[scalp-ws] no enabled scalp strategies — idle, recheck in 60s'); liveToken = u.token; return void setTimeout(start, 60000); }
  liveToken = u.token;
  applyStrategies(u.strategies);
  console.log(`[scalp-ws] connecting Fyers Data WS — ${state.symbols.length} contract(s): ${state.symbols.join(', ')}`);

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

// Re-derive the universe and reconcile the live subscription. Token rotation
// still forces a clean restart (the socket must re-auth); a symbol-set change is
// now applied INCREMENTALLY (no restart). Called instantly by the LISTEN handler
// on any wms_ws_refresh, and every 60s as a safety net.
async function refreshUniverse() {
  let u;
  try { u = await universe(); } catch (e) { return; }
  if (u.token && liveToken && u.token !== liveToken) { console.log('[scalp-ws] token rotated — restarting'); process.exit(1); }
  const { added, removed } = applyStrategies(u.strategies);
  if (added.length || removed.length) console.log(`[scalp-ws] universe refresh: +${added.length} -${removed.length} -> ${state.symbols.length} live`);
}
let _refreshInFlight = false;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    if (_refreshInFlight) { scheduleRefresh(); return; }
    _refreshInFlight = true;
    try { await refreshUniverse(); } finally { _refreshInFlight = false; }
  }, 600);   // debounce a burst (e.g. multi-rung open) into one refresh
}
// Event-driven: LISTEN on a dedicated pg client; migration 108 NOTIFYs on
// at2_strategy(enabled) / at2_trade(status) changes. Reconnects on drop.
function startListener() {
  const client = new pg.Client({
    host: process.env.PG_HOST, port: Number(process.env.PG_PORT) || 5432,
    database: process.env.PG_DATABASE || 'postgres', user: process.env.PG_USER,
    password: process.env.PG_PASSWORD, ssl: { rejectUnauthorized: false },
    application_name: 'wms-scalp-ws-listen',
  });
  client.on('notification', (msg) => { if (msg.channel === 'wms_ws_refresh') scheduleRefresh(); });
  client.on('error', (e) => { console.error('[scalp-ws] LISTEN error:', String(e && e.message || e)); try { client.end(); } catch (_) {} setTimeout(startListener, 5000); });
  client.connect()
    .then(() => client.query('LISTEN wms_ws_refresh'))
    .then(() => { console.log('[scalp-ws] LISTEN wms_ws_refresh — event-driven re-subscribe armed'); scheduleRefresh(); })   // re-derive on (re)connect: recover any NOTIFY missed during a drop (D6)
    .catch((e) => { console.error('[scalp-ws] LISTEN connect failed:', String(e && e.message || e)); try { client.end(); } catch (_) {} setTimeout(startListener, 5000); });
}
// stale-feed watchdog window (also the coarse market-hours gate used by onTick).
function istActiveHours() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) return false;
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 540 && m <= 1415;
}

// Runtime side effects — skipped when the module is imported for tests (SCALP_WS_IMPORT_ONLY=1).
function main() {
  setInterval(refreshUniverse, SAFETY_REDERIVE_MS);   // slow silent-stall catch (D6); LISTEN is the instant path + reconnect re-derives
  setInterval(() => {
    if (state.connected && istActiveHours() && lastTickMs && (Date.now() - lastTickMs) > 120000) {
      console.log('[scalp-ws] no ticks >120s during market hours — restarting'); process.exit(1);
    }
  }, 30000);
  http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, ...state })); })
    .listen(HEALTH_PORT, '127.0.0.1', () => console.log(`[scalp-ws] health on 127.0.0.1:${HEALTH_PORT}`));
  process.on('SIGTERM', () => { console.log('[scalp-ws] SIGTERM — bye'); process.exit(0); });
  start();
  startListener();
}
if (!process.env.SCALP_WS_IMPORT_ONLY) main();
