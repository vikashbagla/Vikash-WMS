// wms-mosl.test.mjs — offline dry run of the MOSL relay against a FAKE MOSL and a
// FAKE mosl-probe Edge Function (no network, no Postgres, no real secrets).
// Run: node wms-live/wms-mosl.test.mjs
import http from 'node:http';
import crypto from 'node:crypto';

const SECRET = 'test-hmac-secret';
const FAKE = { clientId: 'AB1234', pwHash: 'h'.repeat(64), twoFA: '01/01/1990', totp: '123456', apiKey: 'KEY-XYZ', apiSecret: 'SEC-XYZ' };
let pass = 0, fail = 0;
const T = (n, ok, extra = '') => { if (ok) { console.log('PASS  ' + n); pass++; } else { console.error('FAIL  ' + n + ' ' + extra); fail++; } };

// ---- fake MOSL ----
const moslSeen = [];
const mosl = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    moslSeen.push({ path: req.url, h: req.headers, body: b });
    const j = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/rest/trans/')) return j({ status: 'FAILURE', message: 'should never be called' });
    if (req.url === '/rest/login/v7/authdirectapi') return j({ status: 'SUCCESS', AuthToken: 'AUTH-TOKEN-SECRET' });
    if (req.url === '/rest/login/v1/getaccesstoken') return j({ status: 'SUCCESS', accesstoken: 'ACCESS-SECRET' });
    if (req.url === '/rest/report/v3/getscripsbyexchangename') return j({ status: 'SUCCESS', data: [
      { scripname: 'SILVERMIC 30-NOV-2026', instrumentname: 'FUTCOM', scripcode: 4242, marketlot: 1, ticksize: 100, expirydate: 1796000000 },
      { scripname: 'GOLDM 05-NOV-2026', instrumentname: 'FUTCOM', scripcode: 4343, marketlot: 1, ticksize: 100 },
      { scripname: 'CRUDEOIL 19-OCT-2026', instrumentname: 'FUTCOM', scripcode: 1 },
    ] });
    if (req.url === '/rest/report/v3/getltpdata') return j({ status: 'SUCCESS', data: { ltp: 15123400, accesstoken: 'LEAK?' } });
    if (req.url === '/rest/report/v3/getreportmarginsummary') return j({ status: 'SUCCESS', data: [{ particulars: 'Total', amount: 1000 }] });
    return j({ status: 'SUCCESS', data: [] });
  });
});

// ---- fake mosl-probe EF ----
const efSeen = [];
const ef = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    const ts = req.headers['x-wms-timestamp'], nonce = req.headers['x-wms-nonce'], sig = req.headers['x-wms-signature'];
    const canonical = ['POST', ts, nonce, crypto.createHash('sha256').update(b).digest('hex')].join('\n');
    const good = sig === crypto.createHmac('sha256', SECRET).update(canonical).digest('hex');
    const body = JSON.parse(b);
    efSeen.push({ url: req.url, good, body, h: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (!good) { res.statusCode = 401; return res.end('{"error":"sig"}'); }
    if (body.mode === 'relay_prepare') return res.end(JSON.stringify({ ok: true, ...FAKE }));
    if (body.mode === 'relay_record') return res.end(JSON.stringify({ ok: true, id: 1 }));
    res.statusCode = 400; res.end('{}');
  });
});
const ip = http.createServer((_q, r) => r.end('139.59.67.107\n'));

await new Promise((r) => mosl.listen(0, '127.0.0.1', r));
await new Promise((r) => ef.listen(0, '127.0.0.1', r));
await new Promise((r) => ip.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  SUPABASE_URL: `http://127.0.0.1:${ef.address().port}`, SUPABASE_ANON_KEY: 'anon', WMS_LIVE_HMAC_SECRET: SECRET,
  MOSL_BASE_URL: `http://127.0.0.1:${mosl.address().port}`, MOSL_IP_URL: `http://127.0.0.1:${ip.address().port}/`,
});
const M = await import('./wms-mosl.js');

const r = await M.runProbe({ t: Date.now() - 25, reps: 3 });
T('probe completes ok', r.ok === true && r.step === 'done', JSON.stringify(r.report?.error ?? r.step));
T('prepare call HMAC-signed and verified', efSeen[0]?.good === true && efSeen[0]?.url === '/functions/v1/mosl-probe');
T('every MOSL call sends exact User-Agent', moslSeen.every((x) => x.h['user-agent'] === 'MOSL/V.1.1.0'));
const login = moslSeen.find((x) => x.path === '/rest/login/v7/authdirectapi');
T('login sends NO Authorization header', login && !login.h.authorization && !login.h.accesstoken);
T('login body uses prepared values', login && JSON.parse(login.body).totp === '123456' && JSON.parse(login.body).userid === 'AB1234');
T('later calls carry auth + accesstoken', moslSeen.filter((x) => x.path.startsWith('/rest/book/')).every((x) => x.h.authorization === 'AUTH-TOKEN-SECRET' && x.h.accesstoken === 'ACCESS-SECRET'));
T('ClientPublicIp = Droplet IP', login?.h.clientpublicip === '139.59.67.107');
T('no /rest/trans call ever made', !moslSeen.some((x) => x.path.startsWith('/rest/trans')));
T('latency: 3 timed LTP + 3 order-book repeats', r.timings.ltp_repeat_ms?.n === 3 && r.timings.order_book_repeat_ms?.n === 3);
T('wake_ms measured', Number.isFinite(r.timings.wake_ms) && r.timings.wake_ms >= 25);
T('per-leg timings present', ['prepare_ms', 'login_ms', 'get_access_ms', 'instruments_ms', 'total_ms'].every((k) => Number.isFinite(r.timings[k])));
T('SILVERMIC contract found', r.report.ltp_silvermic?.scripcode === 4242);

const out = JSON.stringify(M.scrub(r.report)) + JSON.stringify(r.timings);
T('result contains no secrets/tokens', !/AUTH-TOKEN-SECRET|ACCESS-SECRET|SEC-XYZ|KEY-XYZ|123456|01\/01\/1990|LEAK\?/.test(out), out.match(/AUTH-TOKEN-SECRET|ACCESS-SECRET|SEC-XYZ|KEY-XYZ|123456|LEAK\?/)?.[0]);

let refused = false;
try { await M.moslPost({ apiKey: '', apiSecret: '', clientId: '', publicIp: '', authToken: '', accessToken: '' }, '/rest/trans/v2/placeorder', {}); }
catch (e) { refused = /refuses/.test(e.message); }
T('order path /rest/trans refused in code', refused);

// bad secret -> prepare rejected -> clean failure, no MOSL call
const before = moslSeen.length;
process.env.WMS_LIVE_HMAC_SECRET = 'wrong';
const M2 = await import('./wms-mosl.js?x=2');
const r2 = await M2.runProbe({ reps: 1 });
T('wrong HMAC secret -> fails at prepare, no MOSL call', r2.ok === false && r2.step === 'prepare' && moslSeen.length === before);

mosl.close(); ef.close(); ip.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
