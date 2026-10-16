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
const orders = [], modifies = [];
const mosl = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    moslSeen.push({ path: req.url, h: req.headers, body: b });
    const j = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.url === '/rest/trans/v2/placeorder') { const o = JSON.parse(b); if (o.ordertype === 'SL-M') return j({ status: 'ERROR', message: 'Invalid Order Type', errorcode: 'MO1053' }); if (o.ordertype === 'MARKET') return j({ status: 'ERROR', message: 'Market order is restricted in this product', errorcode: 'MO1072' }); const id = 'U' + (orders.length + 1); orders.push({ uniqueorderid: id, orderid: 'X' + id, tag: o.tag, ordertype: o.ordertype, orderduration: o.orderduration, orderstatus: o.orderduration === 'IOC' ? 'Cancel' : (o.ordertype === 'LIMIT' && Math.abs(o.price - 151000) / 151000 < 0.01) ? 'Traded' : 'Confirm', averageprice: (o.ordertype === 'LIMIT' && Math.abs(o.price - 151000) / 151000 < 0.01) ? 151050 : 0, buyorsell: o.buyorsell, price: o.price, triggerprice: o.triggerprice, lastmodifiedtime: '16-Oct-2026 13:20:00', qtytradedtoday: 0 }); return j({ status: 'SUCCESS', message: 'ok', uniqueorderid: id }); }
    if (req.url === '/rest/trans/v5/modifyorder') { const o = JSON.parse(b); modifies.push(o); return j({ status: 'SUCCESS', message: 'modified' }); }
    if (req.url === '/rest/trans/v2/cancelorder') { const o = JSON.parse(b); const r = orders.find((x) => x.uniqueorderid === o.uniqueorderid); if (r) r.orderstatus = 'Cancel'; return j({ status: 'SUCCESS', message: 'cancelled' }); }
    if (req.url === '/rest/book/v5/getorderbook') return j({ status: 'SUCCESS', data: orders });
    if (req.url === '/rest/book/v5/getorderdetailbyuniqueorderid') { const o = JSON.parse(b); return j({ status: 'SUCCESS', data: orders.filter((x) => x.uniqueorderid === o.uniqueorderid) }); }
    if (req.url.startsWith('/rest/trans/')) return j({ status: 'FAILURE', message: 'unexpected trans path' });
    if (req.url === '/rest/login/v7/authdirectapi') return j({ status: 'SUCCESS', AuthToken: 'AUTH-TOKEN-SECRET' });
    if (req.url === '/rest/login/v1/getaccesstoken') return j({ status: 'SUCCESS', accesstoken: 'ACCESS-SECRET' });
    if (req.url === '/rest/report/v3/getscripsbyexchangename') return j({ status: 'SUCCESS', data: [
      { scripname: 'SILVERMIC 30-NOV-2026', instrumentname: 'FUTCOM', scripcode: 4242, marketlot: 1, ticksize: 1, expirydate: 1796000000, lowercircuitprice: 142000, uppercircuitprice: 160000 },
      { scripname: 'GOLDPETAL 30-OCT-2026', instrumentname: 'FUTCOM', scripcode: 7777, marketlot: 1, ticksize: 1, expirydate: 1795500000, lowercircuitprice: 142000, uppercircuitprice: 160000 },
      { scripname: 'SILVERMIC 27-FEB-2027', instrumentname: 'FUTCOM', scripcode: 4999, marketlot: 1, ticksize: 1, expirydate: 1799000000 },
      { scripname: 'SILVERMIC 30-NOV-2026 CE 150000', instrumentname: 'OPTFUT', scripcode: 5000, marketlot: 1, ticksize: 1, expirydate: 1795000000 },
      { scripname: 'GOLDM 05-NOV-2026', instrumentname: 'FUTCOM', scripcode: 4343, marketlot: 1, ticksize: 100 },
      { scripname: 'CRUDEOIL 19-OCT-2026', instrumentname: 'FUTCOM', scripcode: 1 },
    ] });
    if (req.url === '/rest/report/v3/getltpdata') return j({ status: 'SUCCESS', data: { ltp: 15100000, accesstoken: 'LEAK?' } });
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


// ---- order test mode ----
const before2 = moslSeen.length;
process.env.WMS_LIVE_HMAC_SECRET = SECRET;
const M3 = await import('./wms-mosl.js?x=3');
const ot = await M3.runOrderTest({});
const sent = moslSeen.slice(before2);
const places = sent.filter((x) => x.path === '/rest/trans/v2/placeorder').map((x) => JSON.parse(x.body));
T('order test completes, nothing left open', ot.ok === true && ot.step === 'done' && ot.report.still_open.length === 0, JSON.stringify(ot.report.error ?? ot.report.still_open));
T('picks front-month FUTURE (not option, not later month)', ot.report.contract?.scripcode === 4242);
T('11 cases attempted, 11 sent (SL-M B rejected by MOSL, not locally)', ot.report.cases.length === 11 && places.length === 11);
T('no MARKET order ever sent', places.every((o) => o.ordertype !== 'MARKET'));
T('every order is 1 lot of the chosen contract', places.every((o) => o.quantityinlot === 1 && o.symboltoken === 4242 && o.exchange === 'MCX'));
const ltp = 151000;
T('every non-zero price/trigger >= 1.5% from LTP', places.every((o) => [o.price, o.triggerprice].every((v) => !v || Math.abs(v - ltp) / ltp >= 0.015)));
T('tags WMST.. echoed and <= 10 chars', places.every((o) => /^WMST/.test(o.tag) && o.tag.length <= 10));
T('GTD order carries DD-MMM-YYYY date', /^\d{2}-[A-Z][a-z]{2}-\d{4}$/.test(places.find((o) => o.orderduration === 'GTD')?.goodtilldate ?? ''));
T('modify sent with lastmodifiedtime + qtytradedtoday', modifies.length === 1 && modifies[0].lastmodifiedtime === '16-Oct-2026 13:20:00' && modifies[0].qtytradedtoday === 0);
T('all open orders cancelled', orders.every((o) => o.orderstatus !== 'Confirm'));
// guards
const ctxG = { orderTest: { token: 4242, ltp }, agent: undefined, apiKey: '', apiSecret: '', clientId: '', publicIp: '', authToken: '', accessToken: '' };
const good = { exchange: 'MCX', symboltoken: 4242, quantityinlot: 1, ordertype: 'LIMIT', price: 140000, triggerprice: 0 };
const rej = async (body, now, kind = 'place') => { try { await M3.transPost(ctxG, kind, body, now); return null; } catch (e) { return e.message; } };
T('guard: MARKET refused', /MARKET/.test(await rej({ ...good, ordertype: 'MARKET' })));
T('guard: 2 lots refused', /1 lot/.test(await rej({ ...good, quantityinlot: 2 })));
T('guard: other contract refused', /wrong contract/.test(await rej({ ...good, symboltoken: 1 })));
T('guard: price near market refused', /too close/.test(await rej({ ...good, price: 150500 })));
T('guard: trigger near market refused', /too close/.test(await rej({ ...good, ordertype: 'STOPLOSS', price: 140000, triggerprice: 150000 })));
T('guard: expires after ORDER_TEST_UNTIL', /expired/.test(await rej(good, M3.ORDER_TEST_UNTIL + 1)));
T('guard: unarmed ctx refused', /not armed/.test(await (async () => { try { await M3.transPost({}, 'place', good); } catch (e) { return e.message; } })()));

// ---- overnight / status / cancel modes ----
orders.push({ uniqueorderid: 'APP1', orderid: 'XAPP1', tag: '', ordertype: 'Limit', orderduration: 'Day', orderstatus: 'Confirm', price: 1 });  // order placed in the MOSL app
const on = await M3.runOrderMode({ mode: 'overnight_place', contract: 'SILVERMIC' });
T('overnight_place: 3 GTC/GTD orders placed and left open', on.ok && on.report.placed.length === 3 && on.report.placed.every((p) => p.status === 'SUCCESS') && on.report.test_orders.filter((o) => /^WMSO/.test(o.tag) && o.orderstatus === 'Confirm').length === 3, JSON.stringify(on.report.error ?? on.report.placed));
T('overnight_place: durations GTC, GTC, GTD', on.report.placed.map((p) => p.request.orderduration).join() === 'GTC,GTC,GTD');
T('order_status: app order reported separately (not a test order)', on.report.non_test_orders.some((o) => o.uniqueorderid === 'APP1'));
const st = await M3.runOrderMode({ mode: 'order_status' });
T('order_status: read-only (no trans calls)', st.ok && !moslSeen.slice(-6).some((x) => x.path.startsWith('/rest/trans')));
const cx = await M3.runOrderMode({ mode: 'cancel_tests' });
T('cancel_tests: cancels only WMS-tagged open orders', cx.ok && cx.report.cancel.length === 3 && orders.find((o) => o.uniqueorderid === 'APP1').orderstatus === 'Confirm');

// ---- fill test (owner-triggered) ----
const nBefore = orders.length;
const noConfirm = await M3.runFillTest({});
T('fill test refuses without owner confirmation phrase', noConfirm.ok === false && /confirmation/.test(noConfirm.report.error) && orders.length === nBefore);
const ft = await M3.runFillTest({ confirm: 'I-AUTHORISE-FILL' });
const fo = orders.slice(nBefore);
T('fill test completes, flat, nothing open', ft.ok === true && ft.report.position_left_open === false && ft.report.still_open.length === 0, JSON.stringify(ft.report.error ?? ft.report.steps.map((x) => x.step + ':' + x.status)));
T('fill test: MARKET attempted and rejected', ft.report.steps.some((x) => /MARKET/.test(x.step) && x.errorcode === 'MO1072'));
T('fill test: entry, SL, TP, exit all on GOLDPETAL 1 lot, tags WMSF', fo.length >= 5 && fo.every((o) => /^WMSF/.test(o.tag)));
T('fill test: entry filled then exit filled', ft.report.entry?.final === 'Traded' && ft.report.exit?.final === 'Traded');
T('fill test: SL modified with lastmodifiedtime', ft.report.steps.some((x) => /MODIFY SL/.test(x.step) && x.status === 'SUCCESS'));
T('fill test: SL and TP cancelled', ['WMSFSL', 'WMSFTP'].every((tg) => orders.find((o) => o.tag === tg)?.orderstatus === 'Cancel'));
T('guard: fill-armed ctx still refuses 2 lots / non-WMSF tag', await (async () => { const c = { orderTest: { token: 7777, ltp: 151000, fill: true } }; const a = await M3.transPost(c, 'place', { exchange: 'MCX', symboltoken: 7777, quantityinlot: 2, tag: 'WMSFX' }).then(() => 'ok', (e) => e.message); const b = await M3.transPost(c, 'place', { exchange: 'MCX', symboltoken: 7777, quantityinlot: 1, tag: 'X' }).then(() => 'ok', (e) => e.message); return /1 lot/.test(a) && /WMSF/.test(b); })());

// ---- live feed watch (fake WebSocket on the fake MOSL server) ----
const { WebSocketServer } = await import('ws');
const wss = new WebSocketServer({ server: mosl, path: '/ws' });
const wsIn = [];
wss.on('connection', (sock) => sock.on('message', (m) => { const o = JSON.parse(String(m)); wsIn.push(o);
  if (o.authtoken) sock.send(JSON.stringify({ status: 'SUCCESS', message: 'Login Successful' }));
  if (o.action === 'OrderSubscribe') setTimeout(() => sock.send(JSON.stringify({ uniqueorderid: 'U99', orderstatus: 'Confirm', tag: 'WMSTWS1', accesstoken: 'LEAK?' })), 300); }));
const ww = await M3.runWsWatch({ minutes: 1, test_seconds: 2 });
T('ws_watch: connects, logs in, subscribes order + trade', ww.ok && ww.report.attempts[0].opened && wsIn.some((o) => o.authtoken === 'AUTH-TOKEN-SECRET') && ['OrderSubscribe', 'TradeSubscribe'].every((a) => wsIn.some((o) => o.action === a)), JSON.stringify(ww.report.error ?? ww.report.attempts));
T('ws_watch: records incoming frames', ww.report.frames.some((f) => f.dir === 'in' && f.data?.uniqueorderid === 'U99'));
T('ws_watch: no secrets in recorded frames', !/AUTH-TOKEN-SECRET|KEY-XYZ|LEAK\?/.test(JSON.stringify(ww.report.frames)));
T('ws_watch: far API order placed and cancelled', ww.report.api_order?.status === 'SUCCESS' && ww.report.api_order?.cancel?.status === 'SUCCESS');
wss.close();
mosl.close(); ef.close(); ip.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
