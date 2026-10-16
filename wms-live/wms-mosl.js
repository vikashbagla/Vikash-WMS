// wms-mosl.js — MOSL (Motilal Oswal) relay service. READ-ONLY phase.
// =============================================================================
// WHY THIS EXISTS (HISTORY 2026-10-16)
//   MOSL's moAPI accepts calls only from an IPv4 machine that sends the exact
//   header `User-Agent: MOSL/V.1.1.0`. Supabase Edge Functions rewrite that
//   header (MO2004) and Cloudflare Workers connect over IPv6 (MO2039). This
//   Droplet (139.59.67.107, IPv4, registered on the MOSL app) is the only place
//   WMS can reach MOSL from. Plan: WMS Claude/MOSL Broker Addition/
//   "MOSL Droplet Relay Plan v1".
//
// WHAT IT DOES
//   1. LISTENs on Postgres channel `mosl_relay` (existing listen-only role,
//      same PG_* settings as wms-live). Zero calls while idle.
//   2. On a notify, asks the existing `mosl-probe` Edge Function (HMAC, same
//      WMS_LIVE_HMAC_SECRET as wms-live) for a prepared login — kept in memory
//      only, never written to disk or logged.
//   3. Calls MOSL from this Droplet: login, profile, margin, books, MCX contract
//      list, one LTP, then N timed repeats (latency measurement).
//   4. Posts a scrubbed summary + per-leg timings back to `mosl-probe`, which
//      writes one row to `mosl_relay_runs` (no secrets, no tokens).
//
// ISOLATION — this file is a PURE ADDITION:
//   - Separate systemd unit (wms-mosl.service), own memory cap. It does not
//     import, read or signal index.js / wms-scalp-ws.js.
//   - Uses only Node built-ins + the already-installed `pg`. No package changes.
//   - Never touches wms_live_commands (the order queue).
//   - The auto-deploy script does NOT restart this service. Instead it watches
//     its own file: when a git pull changes it, it exits 90s later (after the
//     auto-deploy's npm ci has finished) and systemd starts the new code.
//
// ☠️ ORDERS: moslPost() refuses any path outside /rest/login, /rest/book and
//    /rest/report. The ONLY route to /rest/trans is transPost() — the owner-
//    approved ORDER TEST MODE (16-Oct-2026): far-from-market, 1 lot, one
//    contract, never MARKET, and it self-disables after ORDER_TEST_UNTIL.
//
// Order test (until ORDER_TEST_UNTIL; contract SILVERMIC | GOLDPETAL):
//   select pg_notify('mosl_relay', '{"mode":"order_test","contract":"GOLDPETAL"}');
//   modes: order_test | overnight_place | order_status | cancel_tests
//
// Trigger (from SQL):
//   select pg_notify('mosl_relay', json_build_object(
//     't', (extract(epoch from clock_timestamp())*1000)::bigint, 'reps', 5)::text);
// =============================================================================

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { watchFile } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const VERSION = 'wms-mosl/1.2.0';

// ── Config (all existing .env values; nothing new) ──────────────────────────
const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const CFG = {
  supabaseUrl: env('SUPABASE_URL'),
  anonKey:     env('SUPABASE_ANON_KEY'),
  hmacSecret:  env('WMS_LIVE_HMAC_SECRET'),
  pgHost:      env('PG_HOST'),
  pgPort:      Number(env('PG_PORT', '5432')) || 5432,
  pgDatabase:  env('PG_DATABASE', 'postgres'),
  pgUser:      env('PG_USER'),
  pgPassword:  env('PG_PASSWORD'),
  moslBase:    env('MOSL_BASE_URL', 'https://openapi.motilaloswal.com'),  // override only for offline tests
  ipUrl:       env('MOSL_IP_URL', 'https://api4.ipify.org'),
};
const LISTEN_CHANNEL = 'mosl_relay';
const USER_AGENT = 'MOSL/V.1.1.0';
const ALLOWED_PREFIXES = ['/rest/login/', '/rest/book/', '/rest/report/'];
const WANT = ['GOLDM', 'SILVERM', 'SILVERMIC', 'GOLDPETAL'];
const RUN_TIMEOUT_MS = 60_000;
const MOSL_CALL_TIMEOUT_MS = 15_000;
const SELF_RESTART_DELAY_MS = 90_000;

const log = (...a) => console.log('[wms-mosl]', ...a);
const warn = (...a) => console.warn('[wms-mosl]', ...a);

// ── HMAC (identical to index.js signHmacRequest / _shared/hmac.ts) ──────────
export function signHmac(method, body, secret = CFG.hmacSecret) {
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');
  const canonical = [method.toUpperCase(), timestamp, nonce, bodyHash].join('\n');
  const signature = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
  return { 'X-WMS-Timestamp': timestamp, 'X-WMS-Nonce': nonce, 'X-WMS-Signature': signature };
}

// ── Edge Function client (mosl-probe relay modes) ───────────────────────────
async function callEf(payload) {
  const url = `${CFG.supabaseUrl}/functions/v1/mosl-probe`;
  const body = JSON.stringify(payload);
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: CFG.anonKey,
      Authorization: `Bearer ${CFG.anonKey}`,
      ...signHmac('POST', body),
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, ms: Date.now() - t0, json, err: res.ok ? null : text.slice(0, 200) };
}

// ── MOSL caller (IPv4 only, exact User-Agent, keep-alive like a real order path)
const agentFor = (u) => (u.startsWith('https:')
  ? new https.Agent({ keepAlive: true, family: 4, maxSockets: 4 })
  : new http.Agent({ keepAlive: true, family: 4, maxSockets: 4 }));

export function buildHeaders(ctx) {
  // Same header set as supabase/functions/mosl-probe (OpenAlgo-proven).
  // Login must NOT carry Authorization/accesstoken.
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    ApiKey: ctx.apiKey,
    apisecretkey: ctx.apiSecret,
    ClientLocalIp: '127.0.0.1',
    ClientPublicIp: ctx.publicIp,
    MacAddress: '00:00:00:00:00:00',
    SourceId: 'WEB',
    vendorinfo: ctx.clientId,
    osname: 'Windows 10',
    osversion: '10.0.19041',
    devicemodel: 'AHV',
    manufacturer: 'DELL',
    productname: 'WMS',
    productversion: '1.0.0',
    browsername: 'Chrome',
    browserversion: '120.0',
  };
  if (ctx.authToken) h.Authorization = ctx.authToken;
  if (ctx.accessToken) h.accesstoken = ctx.accessToken;
  return h;
}

export function moslPost(ctx, path, body) {
  if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
    return Promise.reject(new Error(`wms-mosl refuses path ${path} — read-only phase`));
  }
  return rawPost(ctx, path, body);
}

// ── ORDER TEST MODE (owner-approved 16-Oct-2026, personal MOSL account) ─────
// The ONLY route to MOSL's order endpoints. Locked down in code:
//   - self-disables after ORDER_TEST_UNTIL (no config can extend it)
//   - only place / modify / cancel; place only 1 lot of the ONE contract the
//     test picked (front-month SILVERMIC on MCX), never a MARKET order
//   - prices must sit far from the market (checked here, not just by the caller)
export const ORDER_TEST_UNTIL = Date.parse('2026-10-23T18:30:00Z');   // Sat 24-Oct 00:00 IST
const MIN_DISTANCE = 0.02;            // every price/trigger at least 2% from LTP
const TOWARD_CIRCUIT = 0.9;           // place 90% of the way from LTP to the daily price limit
const TEST_CONTRACTS = ['SILVERMIC', 'GOLDPETAL'];
const TAG_RE = /^WMS(T|O)/;            // only orders carrying our test tags are ever cancelled
const TRANS_PATHS = {
  place: '/rest/trans/v2/placeorder',
  modify: '/rest/trans/v5/modifyorder',
  cancel: '/rest/trans/v2/cancelorder',
};
export function transPost(ctx, kind, body, now = Date.now()) {
  const path = TRANS_PATHS[kind];
  if (!path) return Promise.reject(new Error(`order test: unknown call ${kind}`));
  if (!(now < ORDER_TEST_UNTIL)) return Promise.reject(new Error('order test mode has expired'));
  const t = ctx.orderTest;
  if (!t || !t.token || !t.ltp) return Promise.reject(new Error('order test: not armed'));
  if (kind === 'place') {
    if (body.exchange !== 'MCX' || Number(body.symboltoken) !== t.token) return Promise.reject(new Error('order test: wrong contract'));
    if (Number(body.quantityinlot) !== 1) return Promise.reject(new Error('order test: quantity must be 1 lot'));
    if (String(body.ordertype).toUpperCase() === 'MARKET') return Promise.reject(new Error('order test: MARKET orders are never sent'));
  }
  if (kind === 'place' || kind === 'modify') {
    const px = Number(kind === 'place' ? body.price : body.newprice);
    const trg = Number(kind === 'place' ? body.triggerprice : body.newtriggerprice) || 0;
    const far = (v) => v === 0 || Math.abs(v - t.ltp) / t.ltp >= MIN_DISTANCE;
    if (!far(px) || !far(trg)) return Promise.reject(new Error(`order test: price/trigger too close to market (<${MIN_DISTANCE * 100}%)`));
  }
  return rawPost(ctx, path, body);
}

function rawPost(ctx, path, body) {
  const u = new URL(CFG.moslBase + path);
  const mod = u.protocol === 'https:' ? https : http;
  const payload = JSON.stringify(body);
  const headers = { ...buildHeaders(ctx), 'Content-Length': String(Buffer.byteLength(payload)) };
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const req = mod.request({
      method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, headers, agent: ctx.agent, family: 4, timeout: MOSL_CALL_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const ms = Date.now() - t0;
        let json = null;
        try { json = JSON.parse(text); } catch { /* keep raw */ }
        resolve({ http: res.statusCode ?? 0, ms, json, raw: json ? undefined : text.slice(0, 300) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getText(url) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get({ hostname: u.hostname, port: u.port || undefined, path: u.pathname, family: 4, timeout: 5000 }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve(s.trim()));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Strip anything token-like before it leaves this process.
export function scrub(o) {
  if (o === null || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(scrub);
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    out[k] = /token|secret|password|totp|2fa|apikey/i.test(k) ? '[hidden]' : scrub(v);
  }
  return out;
}
const brief = (r) => ({ http: r.http, ms: r.ms, status: r.json?.status ?? null,
  message: r.json?.message ?? r.raw ?? null, errorcode: r.json?.errorcode ?? null });
const stats = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1], all: a };
};

// ── One probe run ───────────────────────────────────────────────────────────
export async function runProbe(trigger = {}) {
  const tReceived = Date.now();
  const timings = { received_at: new Date(tReceived).toISOString() };
  if (Number.isFinite(Number(trigger.t))) timings.wake_ms = tReceived - Number(trigger.t);
  const reps = Math.min(20, Math.max(1, Number(trigger.reps) || 5));
  const report = { version: VERSION, read_only: true, reps };
  let step = 'prepare';
  const ctx = { agent: agentFor(CFG.moslBase), apiKey: '', apiSecret: '', clientId: '', publicIp: '0.0.0.0', authToken: '', accessToken: '' };

  try {
    try { ctx.publicIp = await getText(CFG.ipUrl); } catch { /* keep 0.0.0.0 */ }
    report.droplet_public_ip = ctx.publicIp;

    // 1) Prepared login from Supabase (memory only)
    const prep = await callEf({ mode: 'relay_prepare' });
    timings.prepare_ms = prep.ms;
    if (prep.status !== 200 || !prep.json?.ok) {
      report.prepare = { http: prep.status, error: prep.json?.error ?? prep.err ?? null, missing: prep.json?.missing ?? null };
      return { ok: false, step, timings, report };
    }
    const p = prep.json;
    Object.assign(ctx, { apiKey: p.apiKey, apiSecret: p.apiSecret, clientId: p.clientId });

    // 2) Login
    step = 'login';
    const login = await moslPost(ctx, '/rest/login/v7/authdirectapi', { userid: p.clientId, password: p.pwHash, '2FA': p.twoFA, totp: p.totp });
    timings.login_ms = login.ms;
    report.login = brief(login);
    if (login.json?.status !== 'SUCCESS' || !login.json?.AuthToken) {
      report.login_response_fields = login.json ? Object.keys(login.json) : null;
      return { ok: false, step, timings, report };
    }
    ctx.authToken = login.json.AuthToken;

    step = 'access_token';
    const at = await moslPost(ctx, '/rest/login/v1/getaccesstoken', { clientcode: '' });
    timings.get_access_ms = at.ms;
    report.get_access = brief(at);
    if (at.json?.accesstoken) ctx.accessToken = at.json.accesstoken;

    // 3) Reads
    step = 'reads';
    const prof = await moslPost(ctx, '/rest/login/v5/getprofile', { clientcode: '' });
    timings.profile_ms = prof.ms;
    report.profile = { ...brief(prof), fields: prof.json?.data ? Object.keys(prof.json.data) : null,
      segments: prof.json?.data?.exchanges ?? prof.json?.data?.products ?? null };

    const ms = await moslPost(ctx, '/rest/report/v3/getreportmarginsummary', { clientcode: '' });
    timings.margin_ms = ms.ms;
    report.margin_summary = { ...brief(ms), rows: Array.isArray(ms.json?.data) ? ms.json.data.length : null,
      sample: Array.isArray(ms.json?.data) ? scrub(ms.json.data.slice(0, 6)) : scrub(ms.json?.data ?? null) };

    const ob = await moslPost(ctx, '/rest/book/v5/getorderbook', { clientcode: '', dateandtime: '' });
    timings.order_book_ms = ob.ms;
    report.order_book = { ...brief(ob), count: Array.isArray(ob.json?.data) ? ob.json.data.length : 0,
      fields: Array.isArray(ob.json?.data) && ob.json.data[0] ? Object.keys(ob.json.data[0]) : null };

    const pos = await moslPost(ctx, '/rest/book/v4/getposition', { clientcode: '' });
    timings.positions_ms = pos.ms;
    report.positions = { ...brief(pos), count: Array.isArray(pos.json?.data) ? pos.json.data.length : 0,
      fields: Array.isArray(pos.json?.data) && pos.json.data[0] ? Object.keys(pos.json.data[0]) : null };

    const tb = await moslPost(ctx, '/rest/book/v4/gettradebook', { clientcode: '' });
    timings.trade_book_ms = tb.ms;
    report.trade_book = { ...brief(tb), count: Array.isArray(tb.json?.data) ? tb.json.data.length : 0 };

    // 4) MCX contract list → our contracts
    step = 'instruments';
    const inst = await moslPost(ctx, '/rest/report/v3/getscripsbyexchangename', { clientcode: '', exchangename: 'MCX' });
    timings.instruments_ms = inst.ms;
    const rows = Array.isArray(inst.json?.data) ? inst.json.data : [];
    const nameOf = (r) => String(r.scripname ?? r.scripshortname ?? r.symbol ?? r.name ?? '');
    const matches = rows.filter((r) => {
      const n = nameOf(r).toUpperCase();
      const isFut = /FUT/i.test(String(r.instrumentname ?? r.instrumenttype ?? n));
      return isFut && WANT.some((w) => new RegExp(`^${w}\\b`).test(n));
    });
    report.mcx_instruments = {
      ...brief(inst), total_rows: rows.length, fields: rows[0] ? Object.keys(rows[0]) : null,
      matches: matches.slice(0, 40).map((r) => ({
        name: nameOf(r), scripcode: r.scripcode ?? r.symboltoken ?? null,
        lot: r.marketlot ?? r.lotsize ?? null, tick: r.ticksize ?? null,
        expiry: r.expirydate ?? null, instrument: r.instrumentname ?? null, maxqty: r.maxqtyperorder ?? null,
      })),
    };
    rows.length = 0;   // free the big list before the latency loop

    // 5) One LTP + timed repeats (latency of a warm Droplet → MOSL call)
    step = 'latency';
    const smic = matches.find((r) => /^SILVERMIC\b/i.test(nameOf(r)));
    const code = smic ? Number(smic.scripcode ?? smic.symboltoken) : null;
    const ltpMs = [], obMs = [];
    let firstLtp = null;
    for (let i = 0; i < reps; i++) {
      if (code) {
        const l = await moslPost(ctx, '/rest/report/v3/getltpdata', { clientcode: '', exchange: 'MCX', scripcode: code });
        ltpMs.push(l.ms);
        if (!firstLtp) firstLtp = l;
      }
      const o = await moslPost(ctx, '/rest/book/v5/getorderbook', { clientcode: '', dateandtime: '' });
      obMs.push(o.ms);
    }
    report.ltp_silvermic = firstLtp
      ? { ...brief(firstLtp), contract: nameOf(smic), scripcode: code, data: scrub(firstLtp.json?.data ?? null), note: 'MOSL prices are in paisa — divide by 100' }
      : { skipped: 'no SILVERMIC future found in MCX list' };
    timings.ltp_repeat_ms = stats(ltpMs);
    timings.order_book_repeat_ms = stats(obMs);
    step = 'done';
    timings.total_ms = Date.now() - tReceived;
    return { ok: true, step, timings, report };
  } catch (e) {
    report.error = String(e?.message ?? e).slice(0, 300);
    timings.total_ms = Date.now() - tReceived;
    return { ok: false, step, timings, report };
  } finally {
    ctx.agent.destroy();
    ctx.authToken = ''; ctx.accessToken = ''; ctx.apiKey = ''; ctx.apiSecret = '';
  }
}

// ── Order test run (far-from-market orders; see ORDER TEST MODE above) ──────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OPEN_STATUSES = /^(sent|confirm|partial|unknown)$/i;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ddmmmyyyy = (d) => `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}`;

async function loginCtx(timings, report) {
  const ctx = { agent: agentFor(CFG.moslBase), apiKey: '', apiSecret: '', clientId: '', publicIp: '0.0.0.0', authToken: '', accessToken: '' };
  try { ctx.publicIp = await getText(CFG.ipUrl); } catch { /* keep */ }
  const prep = await callEf({ mode: 'relay_prepare' });
  timings.prepare_ms = prep.ms;
  if (prep.status !== 200 || !prep.json?.ok) throw new Error(`prepare failed (http ${prep.status})`);
  const p = prep.json;
  Object.assign(ctx, { apiKey: p.apiKey, apiSecret: p.apiSecret, clientId: p.clientId });
  const login = await moslPost(ctx, '/rest/login/v7/authdirectapi', { userid: p.clientId, password: p.pwHash, '2FA': p.twoFA, totp: p.totp });
  timings.login_ms = login.ms;
  report.login = brief(login);
  if (login.json?.status !== 'SUCCESS' || !login.json?.AuthToken) throw new Error('login failed');
  ctx.authToken = login.json.AuthToken;
  const at = await moslPost(ctx, '/rest/login/v1/getaccesstoken', { clientcode: '' });
  if (at.json?.accesstoken) ctx.accessToken = at.json.accesstoken;
  return ctx;
}

async function pickTestContract(ctx, trigger, report, timings) {
    const inst = await moslPost(ctx, '/rest/report/v3/getscripsbyexchangename', { clientcode: '', exchangename: 'MCX' });
    timings.instruments_ms = inst.ms;
    const rows = Array.isArray(inst.json?.data) ? inst.json.data : [];
    const want = TEST_CONTRACTS.includes(String(trigger.contract).toUpperCase()) ? String(trigger.contract).toUpperCase() : 'SILVERMIC';
    const futs = rows.filter((r) => new RegExp(`^${want}\\b`, 'i').test(String(r.scripname ?? '')) && /^FUT/i.test(String(r.instrumentname ?? '')))
      .sort((a, b) => Number(a.expirydate) - Number(b.expirydate));
    rows.length = 0;
    const c = futs[0];
    if (!c) throw new Error(`no ${want} future found`);
    const token = Number(c.scripcode);
    const tick = Number(c.ticksize) || 1;
    const ltpRes = await moslPost(ctx, '/rest/report/v3/getltpdata', { clientcode: '', exchange: 'MCX', scripcode: token });
    const ltp = Number(ltpRes.json?.data?.ltp) / 100;
    if (!(ltp > 0)) throw new Error('no LTP');
    // Circuit limits: the contract list may give rupees or paisa — normalise against LTP.
    const norm = (v) => { v = Number(v); if (!(v > 0)) return null; return v > ltp * 10 ? v / 100 : v; };
    const lcl = norm(c.lowercircuitprice) ?? ltp * 0.97;
    const ucl = norm(c.uppercircuitprice) ?? ltp * 1.03;
    const rt = (v) => Math.round(v / tick) * tick;
    const farBuy = rt(ltp - TOWARD_CIRCUIT * (ltp - lcl));    // 90% of the way down to the lower limit
    const farSell = rt(ltp + TOWARD_CIRCUIT * (ucl - ltp));   // 90% of the way up to the upper limit
    report.contract = { name: c.scripname, scripcode: token, lot: c.marketlot, tick, ltp, lcl, ucl, farBuy, farSell,
      raw_circuits: { lower: c.lowercircuitprice, upper: c.uppercircuitprice }, maxqty: c.maxqtyperorder, algoid: c.algoid ?? null };
    if (farBuy - 20 * tick < lcl || farSell + 20 * tick > ucl) throw new Error('stop buffer would cross the daily price limit');
    if (farBuy > ltp * (1 - MIN_DISTANCE) || farSell < ltp * (1 + MIN_DISTANCE)) throw new Error('daily price band too narrow for a safe far-from-market test');
    ctx.orderTest = { token, ltp };
    return { token, tick, ltp, lcl, ucl, farBuy, farSell, rt };
}

export async function runOrderTest(trigger = {}) {
  const t0 = Date.now();
  const timings = {};
  const report = { version: VERSION, mode: 'order_test', cases: [] };
  let step = 'login';
  let ctx = null;
  const placed = [];   // uniqueorderids we created
  try {
    if (!(Date.now() < ORDER_TEST_UNTIL)) throw new Error('order test mode has expired');
    ctx = await loginCtx(timings, report);

    // 1) Pick the contract + far-from-market prices
    step = 'contract';
    const { token, tick, ltp, farBuy, farSell, rt } = await pickTestContract(ctx, trigger, report, timings);

    // 2) Place the test matrix (all far from market; MARKET is never sent)
    step = 'place';
    const gtd = ddmmmyyyy(new Date(Date.now() + 7 * 86400_000));
    const base = { clientcode: '', exchange: 'MCX', symboltoken: token, quantityinlot: 1, disclosedquantity: 0, amoorder: 'N', algoid: '', goodtilldate: '', participantcode: '' };
    const cases = [
      { id: 'T01', note: 'LIMIT BUY, DAY', o: { buyorsell: 'BUY', ordertype: 'LIMIT', producttype: 'NORMAL', orderduration: 'DAY', price: farBuy, triggerprice: 0 } },
      { id: 'T02', note: 'LIMIT SELL, DAY', o: { buyorsell: 'SELL', ordertype: 'LIMIT', producttype: 'NORMAL', orderduration: 'DAY', price: farSell, triggerprice: 0 } },
      { id: 'T03', note: 'STOP-LIMIT SELL (trigger below market)', o: { buyorsell: 'SELL', ordertype: 'STOPLOSS', producttype: 'NORMAL', orderduration: 'DAY', price: rt(farBuy - 20 * tick), triggerprice: farBuy } },
      { id: 'T04', note: 'STOP-LIMIT BUY (trigger above market)', o: { buyorsell: 'BUY', ordertype: 'STOPLOSS', producttype: 'NORMAL', orderduration: 'DAY', price: rt(farSell + 20 * tick), triggerprice: farSell } },
      { id: 'T05', note: 'SL-M attempt A: STOPLOSS with price 0', o: { buyorsell: 'SELL', ordertype: 'STOPLOSS', producttype: 'NORMAL', orderduration: 'DAY', price: 0, triggerprice: farBuy } },
      { id: 'T06', note: 'SL-M attempt B: ordertype "SL-M"', o: { buyorsell: 'SELL', ordertype: 'SL-M', producttype: 'NORMAL', orderduration: 'DAY', price: 0, triggerprice: farBuy } },
      { id: 'T07', note: 'LIMIT BUY, GTC (carry-over)', o: { buyorsell: 'BUY', ordertype: 'LIMIT', producttype: 'NORMAL', orderduration: 'GTC', price: farBuy, triggerprice: 0 } },
      { id: 'T08', note: `LIMIT BUY, GTD ${gtd} (carry-over)`, o: { buyorsell: 'BUY', ordertype: 'LIMIT', producttype: 'NORMAL', orderduration: 'GTD', price: farBuy, triggerprice: 0, goodtilldate: gtd } },
      { id: 'T09', note: 'STOP-LIMIT SELL, GTC (carry-over stop)', o: { buyorsell: 'SELL', ordertype: 'STOPLOSS', producttype: 'NORMAL', orderduration: 'GTC', price: rt(farBuy - 20 * tick), triggerprice: farBuy } },
      { id: 'T10', note: 'LIMIT BUY, IOC', o: { buyorsell: 'BUY', ordertype: 'LIMIT', producttype: 'NORMAL', orderduration: 'IOC', price: farBuy, triggerprice: 0 } },
      { id: 'T11', note: 'LIMIT BUY, VALUEPLUS (intraday)', o: { buyorsell: 'BUY', ordertype: 'LIMIT', producttype: 'VALUEPLUS', orderduration: 'DAY', price: farBuy, triggerprice: 0 } },
    ];
    for (const k of cases) {
      const body = { ...base, ...k.o, tag: `WMST${k.id}` };
      let r;
      try { r = await transPost(ctx, 'place', body); }
      catch (e) { report.cases.push({ id: k.id, note: k.note, blocked_locally: String(e.message) }); continue; }
      const uid = r.json?.uniqueorderid || null;
      if (uid) placed.push(uid);
      report.cases.push({ id: k.id, note: k.note, request: body, ms: r.ms, http: r.http,
        status: r.json?.status ?? null, message: r.json?.message ?? r.raw ?? null, errorcode: r.json?.errorcode ?? null, uniqueorderid: uid });
      await sleep(150);
    }

    // 3) What the books say about them
    step = 'books';
    await sleep(2000);
    const ob1 = await moslPost(ctx, '/rest/book/v5/getorderbook', { clientcode: '', dateandtime: '' });
    const mine = (d) => (Array.isArray(d) ? d.filter((o) => placed.includes(o.uniqueorderid)) : []);
    report.order_book_after_place = { ms: ob1.ms, status: ob1.json?.status, message: ob1.json?.message, rows: mine(ob1.json?.data) };
    report.order_book_all_count = Array.isArray(ob1.json?.data) ? ob1.json.data.length : 0;
    report.order_detail = [];
    for (const uid of placed) {
      const d = await moslPost(ctx, '/rest/book/v5/getorderdetailbyuniqueorderid', { clientcode: '', uniqueorderid: uid });
      report.order_detail.push({ uniqueorderid: uid, ms: d.ms, status: d.json?.status, message: d.json?.message, data: d.json?.data ?? null });
    }
    if (placed[0]) {
      const td = await moslPost(ctx, '/rest/book/v4/gettradedetailbyuniqueorderid', { clientcode: '', uniqueorderid: placed[0] });
      report.trade_detail_sample = { ms: td.ms, status: td.json?.status, message: td.json?.message, data: td.json?.data ?? null };
    }

    // 4) Modify one open order (needs lastmodifiedtime + qtytradedtoday from the book)
    step = 'modify';
    const openRows = report.order_book_after_place.rows.filter((o) => OPEN_STATUSES.test(String(o.orderstatus)));
    const target = openRows.find((o) => /LIMIT/i.test(o.ordertype) && /BUY/i.test(o.buyorsell)) ?? openRows[0];
    if (target) {
      const tRead = Date.now();
      const fresh = await moslPost(ctx, '/rest/book/v5/getorderdetailbyuniqueorderid', { clientcode: '', uniqueorderid: target.uniqueorderid });
      const row = (Array.isArray(fresh.json?.data) ? fresh.json.data[0] : fresh.json?.data) ?? target;
      const isStop = /STOP/i.test(target.ordertype);
      const body = {
        clientcode: '', uniqueorderid: target.uniqueorderid,
        newordertype: String(target.ordertype).toUpperCase(), neworderduration: String(target.orderduration || 'DAY').toUpperCase(),
        newquantityinlot: 1, newdisclosedquantity: 0,
        newprice: isStop ? Number(target.price) - 5 * tick : rt(Number(target.price) - 10 * tick),
        newtriggerprice: isStop ? Number(target.triggerprice) - 5 * tick : 0,
        newgoodtilldate: '', lastmodifiedtime: row.lastmodifiedtime ?? target.lastmodifiedtime, qtytradedtoday: Number(row.qtytradedtoday ?? 0),
      };
      let m;
      try { m = await transPost(ctx, 'modify', body); } catch (e) { m = { ms: 0, json: { status: 'BLOCKED', message: e.message } }; }
      report.modify = { target: target.uniqueorderid, request: body, read_ms: fresh.ms, modify_ms: m.ms, read_plus_modify_ms: Date.now() - tRead,
        status: m.json?.status, message: m.json?.message ?? m.raw ?? null, errorcode: m.json?.errorcode ?? null };
      await sleep(1000);
      const after = await moslPost(ctx, '/rest/book/v5/getorderdetailbyuniqueorderid', { clientcode: '', uniqueorderid: target.uniqueorderid });
      report.modify.after = after.json?.data ?? null;
    } else {
      report.modify = { skipped: 'no order stayed open (all rejected?)' };
    }

    // 5) Cancel everything still open
    step = 'cancel';
    report.cancel = [];
    const ob2 = await moslPost(ctx, '/rest/book/v5/getorderbook', { clientcode: '', dateandtime: '' });
    for (const o of mine(ob2.json?.data)) {
      if (!OPEN_STATUSES.test(String(o.orderstatus))) continue;
      const r = await transPost(ctx, 'cancel', { clientcode: '', uniqueorderid: o.uniqueorderid }).catch((e) => ({ ms: 0, json: { status: 'BLOCKED', message: e.message } }));
      report.cancel.push({ uniqueorderid: o.uniqueorderid, tag: o.tag, ms: r.ms, status: r.json?.status, message: r.json?.message ?? null, errorcode: r.json?.errorcode ?? null });
    }

    // 6) Final state + the other books (for reference fields)
    step = 'final';
    await sleep(1500);
    const ob3 = await moslPost(ctx, '/rest/book/v5/getorderbook', { clientcode: '', dateandtime: '' });
    report.order_book_final = mine(ob3.json?.data).map((o) => ({ uniqueorderid: o.uniqueorderid, orderid: o.orderid, tag: o.tag, ordertype: o.ordertype, orderduration: o.orderduration, orderstatus: o.orderstatus, error: o.error }));
    report.still_open = report.order_book_final.filter((o) => OPEN_STATUSES.test(String(o.orderstatus))).map((o) => o.uniqueorderid);
    const tb = await moslPost(ctx, '/rest/book/v4/gettradebook', { clientcode: '' });
    report.trade_book = { status: tb.json?.status, message: tb.json?.message, count: Array.isArray(tb.json?.data) ? tb.json.data.length : 0 };
    const pd = await moslPost(ctx, '/rest/book/v4/getpositiondetail', { clientcode: '' });
    report.position_detail = { status: pd.json?.status, message: pd.json?.message, data: Array.isArray(pd.json?.data) ? pd.json.data.slice(0, 5) : pd.json?.data ?? null };
    step = 'done';
    timings.total_ms = Date.now() - t0;
    return { ok: report.still_open.length === 0, step, timings, report };
  } catch (e) {
    report.error = String(e?.message ?? e).slice(0, 300);
    // Safety net: try to cancel anything we placed
    if (ctx && placed.length) {
      report.emergency_cancel = [];
      for (const uid of placed) {
        const r = await transPost(ctx, 'cancel', { clientcode: '', uniqueorderid: uid }).catch((er) => ({ json: { status: 'ERR', message: er.message } }));
        report.emergency_cancel.push({ uid, status: r.json?.status, message: r.json?.message ?? null });
      }
    }
    timings.total_ms = Date.now() - t0;
    return { ok: false, step, timings, report };
  } finally {
    if (ctx) { ctx.agent.destroy(); ctx.authToken = ''; ctx.accessToken = ''; ctx.apiKey = ''; ctx.apiSecret = ''; }
  }
}

// ── Overnight carry-over test + status + cleanup ────────────────────────────
// overnight_place : leave GTC/GTD orders (tag WMSO..) far from market on the
//                   chosen contract, to see if they survive the close.
// order_status    : read-only — every order with a WMS test tag, plus books.
// cancel_tests    : cancel every OPEN order carrying a WMS test tag (only those).
const pickRow = (o) => ({ uniqueorderid: o.uniqueorderid, orderid: o.orderid, tag: o.tag, symbol: o.symbol, buyorsell: o.buyorsell,
  ordertype: o.ordertype, orderduration: o.orderduration, goodtilldate: o.goodtilldate, price: o.price, triggerprice: o.triggerprice,
  orderstatus: o.orderstatus, error: o.error, entrydatetime: o.entrydatetime, lastmodifiedtime: o.lastmodifiedtime,
  recordinserttime: o.recordinserttime, totalqtytraded: o.totalqtytraded, averageprice: o.averageprice, algoid: o.algoid });

export async function runOrderMode(trigger = {}) {
  const t0 = Date.now();
  const timings = {};
  const mode = String(trigger.mode);
  const report = { version: VERSION, mode, now_utc: new Date().toISOString() };
  let step = 'login';
  let ctx = null;
  try {
    ctx = await loginCtx(timings, report);
    if (mode === 'overnight_place') {
      if (!(Date.now() < ORDER_TEST_UNTIL)) throw new Error('order test mode has expired');
      step = 'contract';
      const { token, tick, farBuy, farSell, rt } = await pickTestContract(ctx, trigger, report, timings);
      step = 'place';
      const gtd = ddmmmyyyy(new Date(Date.now() + 7 * 86400_000));
      const base = { clientcode: '', exchange: 'MCX', symboltoken: token, quantityinlot: 1, disclosedquantity: 0, amoorder: 'N', algoid: '', participantcode: '', producttype: 'NORMAL' };
      const k = String(trigger.contract || 'SILVERMIC').toUpperCase().slice(0, 2);   // SI / GO
      const cases = [
        { tag: `WMSO${k}1`, note: 'GTC LIMIT BUY far below (like a target/entry)', o: { buyorsell: 'BUY', ordertype: 'LIMIT', orderduration: 'GTC', price: farBuy, triggerprice: 0, goodtilldate: '' } },
        { tag: `WMSO${k}2`, note: 'GTC STOP-LIMIT BUY far above (like a short\'s stop)', o: { buyorsell: 'BUY', ordertype: 'STOPLOSS', orderduration: 'GTC', price: rt(farSell + 20 * tick), triggerprice: farSell, goodtilldate: '' } },
        { tag: `WMSO${k}3`, note: `GTD ${gtd} LIMIT BUY far below`, o: { buyorsell: 'BUY', ordertype: 'LIMIT', orderduration: 'GTD', price: farBuy, triggerprice: 0, goodtilldate: gtd } },
      ];
      report.placed = [];
      for (const cse of cases) {
        const body = { ...base, ...cse.o, tag: cse.tag };
        const r = await transPost(ctx, 'place', body).catch((e) => ({ ms: 0, json: { status: 'BLOCKED', message: e.message } }));
        report.placed.push({ tag: cse.tag, note: cse.note, request: body, ms: r.ms, status: r.json?.status, message: r.json?.message ?? r.raw ?? null, errorcode: r.json?.errorcode ?? null, uniqueorderid: r.json?.uniqueorderid ?? null });
        await sleep(200);
      }
      await sleep(2000);
    }
    step = 'books';
    const ob = await moslPost(ctx, '/rest/book/v5/getorderbook', { clientcode: '', dateandtime: '' });
    const all = Array.isArray(ob.json?.data) ? ob.json.data : [];
    report.order_book_status = { status: ob.json?.status, message: ob.json?.message, total_rows: all.length };
    report.test_orders = all.filter((o) => TAG_RE.test(String(o.tag ?? ''))).map(pickRow);
    report.non_test_orders = all.filter((o) => !TAG_RE.test(String(o.tag ?? ''))).map(pickRow);   // e.g. orders placed in the MOSL app
    if (mode === 'cancel_tests') {
      step = 'cancel';
      ctx.orderTest = { token: -1, ltp: 1 };   // arm for cancel only (place/modify still need a real contract)
      report.cancel = [];
      for (const o of all) {
        if (!TAG_RE.test(String(o.tag ?? '')) || !OPEN_STATUSES.test(String(o.orderstatus))) continue;
        const r = await transPost(ctx, 'cancel', { clientcode: '', uniqueorderid: o.uniqueorderid }).catch((e) => ({ ms: 0, json: { status: 'BLOCKED', message: e.message } }));
        report.cancel.push({ uniqueorderid: o.uniqueorderid, tag: o.tag, ms: r.ms, status: r.json?.status, message: r.json?.message ?? null, errorcode: r.json?.errorcode ?? null });
      }
      await sleep(1500);
      const ob2 = await moslPost(ctx, '/rest/book/v5/getorderbook', { clientcode: '', dateandtime: '' });
      report.after_cancel = (Array.isArray(ob2.json?.data) ? ob2.json.data : []).filter((o) => TAG_RE.test(String(o.tag ?? ''))).map(pickRow);
    }
    const tb = await moslPost(ctx, '/rest/book/v4/gettradebook', { clientcode: '' });
    report.trade_book = { status: tb.json?.status, message: tb.json?.message, rows: Array.isArray(tb.json?.data) ? tb.json.data.slice(0, 20) : [] };
    const pos = await moslPost(ctx, '/rest/book/v4/getposition', { clientcode: '' });
    report.positions = { status: pos.json?.status, message: pos.json?.message, rows: Array.isArray(pos.json?.data) ? pos.json.data.slice(0, 20) : [] };
    const pd = await moslPost(ctx, '/rest/book/v4/getpositiondetail', { clientcode: '' });
    report.position_detail = { status: pd.json?.status, message: pd.json?.message, rows: Array.isArray(pd.json?.data) ? pd.json.data.slice(0, 20) : pd.json?.data ?? null };
    step = 'done';
    timings.total_ms = Date.now() - t0;
    return { ok: true, step, timings, report };
  } catch (e) {
    report.error = String(e?.message ?? e).slice(0, 300);
    timings.total_ms = Date.now() - t0;
    return { ok: false, step, timings, report };
  } finally {
    if (ctx) { ctx.agent.destroy(); ctx.authToken = ''; ctx.accessToken = ''; ctx.apiKey = ''; ctx.apiSecret = ''; }
  }
}

let busy = false;
let lastRecordMs = null;
async function handleTrigger(payloadText) {
  if (busy) { warn('probe already running — ignoring trigger'); return; }
  busy = true;
  let trigger = {};
  try { trigger = JSON.parse(payloadText || '{}') || {}; } catch { /* plain text payload */ }
  try {
    const isOrderTest = ['order_test', 'overnight_place', 'order_status', 'cancel_tests'].includes(trigger.mode);
    const limit = isOrderTest ? 150_000 : RUN_TIMEOUT_MS;
    const result = await Promise.race([
      trigger.mode === 'order_test' ? runOrderTest(trigger) : isOrderTest ? runOrderMode(trigger) : runProbe(trigger),
      new Promise((r) => setTimeout(() => r({ ok: false, step: 'timeout', timings: {}, report: { error: `run exceeded ${limit}ms` } }), limit)),
    ]);
    result.timings.prev_record_ms = lastRecordMs;
    const rec = await callEf({ mode: 'relay_record', kind: isOrderTest ? String(trigger.mode) : 'probe', ok: result.ok, step: result.step,
      timings: result.timings, report: scrub(result.report) });
    lastRecordMs = rec.ms;
    log(`probe ${result.ok ? 'OK' : 'FAILED at ' + result.step} · total ${result.timings.total_ms ?? '?'}ms · recorded http ${rec.status} (${rec.ms}ms)`);
  } catch (e) {
    warn('probe/record error:', String(e?.message ?? e).slice(0, 200));
  } finally {
    busy = false;
  }
}

// ── Postgres LISTEN (same pattern + role as wms-live; separate connection) ──
async function listenLoop(pg) {
  let attempt = 0;
  let announced = false;
  while (running) {
    attempt++;
    const client = new pg.Client({
      host: CFG.pgHost, port: CFG.pgPort, database: CFG.pgDatabase,
      user: CFG.pgUser, password: CFG.pgPassword,
      ssl: { rejectUnauthorized: false }, keepAlive: true, application_name: 'wms-mosl',
    });
    pgClient = client;
    try {
      client.on('error', (err) => warn('pg error:', err.message));
      client.on('notification', (msg) => {
        if (msg.channel !== LISTEN_CHANNEL) return;
        log('trigger received');
        handleTrigger(msg.payload).catch(() => {});
      });
      await client.connect();
      await client.query(`LISTEN ${LISTEN_CHANNEL}`);
      attempt = 0;
      log(`listening on '${LISTEN_CHANNEL}'`);
      if (!announced) {
        announced = true;
        callEf({ mode: 'relay_record', kind: 'startup', ok: true, step: 'listening',
          timings: {}, report: { version: VERSION, pid: process.pid } })
          .then((r) => log(`startup recorded (http ${r.status}, ${r.ms}ms)`))
          .catch((e) => warn('startup record failed:', String(e?.message ?? e).slice(0, 120)));
      }
      await new Promise((resolve) => { client.once('end', resolve); client.once('error', resolve); });
      warn('pg connection ended');
    } catch (e) {
      warn(`pg connect failed (#${attempt}):`, String(e?.message ?? e).slice(0, 160));
    }
    try { await client.end(); } catch { /* ignore */ }
    if (!running) break;
    await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))));
  }
}

let running = true;
let pgClient = null;

async function main() {
  const missing = ['supabaseUrl', 'anonKey', 'hmacSecret', 'pgHost', 'pgUser', 'pgPassword'].filter((k) => !CFG[k]);
  if (missing.length) {
    console.error('[wms-mosl] missing settings:', missing.join(', '));
    process.exit(78);   // unit has RestartPreventExitStatus=78 — no crash loop
  }
  const { default: pg } = await import('pg');
  log(`${VERSION} starting (pid ${process.pid})`);

  // Self-update: when a git pull changes this file, exit after the auto-deploy
  // has finished (npm ci), and systemd (Restart=always) starts the new code.
  watchFile(SELF, { interval: 5000 }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs) {
      log(`own file changed — restarting in ${SELF_RESTART_DELAY_MS / 1000}s`);
      setTimeout(() => shutdown('self-update'), SELF_RESTART_DELAY_MS).unref();
    }
  });

  const shutdown = async (why) => {
    log(`stopping (${why})`);
    running = false;
    try { await pgClient?.end(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await listenLoop(pg);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[wms-mosl] fatal:', e); process.exit(1); });
}
