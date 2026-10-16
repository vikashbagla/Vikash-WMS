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
// ☠️ PLACES NO ORDERS. moslPost() refuses any path outside /rest/login,
//    /rest/book and /rest/report — MOSL's order endpoints (/rest/trans) cannot
//    be reached from this file.
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
const VERSION = 'wms-mosl/1.0.0';

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

let busy = false;
let lastRecordMs = null;
async function handleTrigger(payloadText) {
  if (busy) { warn('probe already running — ignoring trigger'); return; }
  busy = true;
  let trigger = {};
  try { trigger = JSON.parse(payloadText || '{}') || {}; } catch { /* plain text payload */ }
  try {
    const result = await Promise.race([
      runProbe(trigger),
      new Promise((r) => setTimeout(() => r({ ok: false, step: 'timeout', timings: {}, report: { error: `run exceeded ${RUN_TIMEOUT_MS}ms` } }), RUN_TIMEOUT_MS)),
    ]);
    result.timings.prev_record_ms = lastRecordMs;
    const rec = await callEf({ mode: 'relay_record', kind: 'probe', ok: result.ok, step: result.step,
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
