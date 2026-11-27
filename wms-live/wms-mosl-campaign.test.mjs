// wms-mosl-campaign.test.mjs — offline tests of the VEINS TEST CAMPAIGN in wms-mosl.js against a
// FAKE MOSL and a FAKE mosl-probe Edge Function (no network, no Postgres, no real secrets).
// Run: node wms-live/wms-mosl-campaign.test.mjs
import http from 'node:http';
import crypto from 'node:crypto';

const SECRET = 'test-hmac-secret';
const FAKE = { clientId: 'AB1234', pwHash: 'h'.repeat(64), twoFA: '01/01/1990', totp: '123456', apiKey: 'KEY-XYZ', apiSecret: 'SEC-XYZ' };
let pass = 0, fail = 0;
const T = (n, ok, extra = '') => { if (ok) { console.log('PASS  ' + n); pass++; } else { console.error('FAIL  ' + n + ' ' + extra); fail++; } };

// ---- fake MOSL: GOLDPETAL token 7777, LTP 12,400, band 11,700–13,100, tick 1 ----
const LTP = 12400;
const seen = []; const orders = []; let EXTRA_SCRIPS = []; let DEC_BAND = [11700, 13100];
const mosl = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    seen.push({ path: req.url, body: b });
    const j = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    const o = b ? JSON.parse(b) : {};
    if (req.url === '/rest/trans/v2/placeorder') {
      if (o.ordertype === 'MARKET') return j({ status: 'ERROR', message: 'Cannot place Market orders for Algo Orders', errorcode: 'M01108' });
      const id = 'U' + (orders.length + 1);
      const marketable = o.ordertype === 'LIMIT' && (o.buyorsell === 'BUY' ? o.price >= LTP : o.price <= LTP);
      orders.push({ uniqueorderid: id, orderid: 'X' + id, tag: o.tag, buyorsell: o.buyorsell, ordertype: o.ordertype === 'STOPLOSS' ? 'Stop Loss' : 'Limit',
        orderduration: o.orderduration, price: o.price, triggerprice: o.triggerprice, orderstatus: marketable ? 'Traded' : 'Confirm', averageprice: marketable ? LTP : 0,
        lastmodifiedtime: '27-Nov-2026 13:00:00', qtytradedtoday: marketable ? 1 : 0 });
      return j({ status: 'SUCCESS', message: 'ok', uniqueorderid: id });
    }
    if (req.url === '/rest/trans/v5/modifyorder') { const r = orders.find((x) => x.uniqueorderid === o.uniqueorderid); if (r) { r.price = o.newprice; r.triggerprice = o.newtriggerprice; } return j({ status: 'SUCCESS', message: 'modified' }); }
    if (req.url === '/rest/trans/v2/cancelorder') { const r = orders.find((x) => x.uniqueorderid === o.uniqueorderid); if (r) r.orderstatus = 'Cancel'; return j({ status: 'SUCCESS', message: 'cancelled' }); }
    if (req.url === '/rest/book/v5/getorderbook') return j({ status: 'SUCCESS', data: orders });
    // the detail call deliberately has NO tag (the relay must fall back to the order book)
    if (req.url === '/rest/book/v5/getorderdetailbyuniqueorderid') return j({ status: 'SUCCESS', data: orders.filter((x) => x.uniqueorderid === o.uniqueorderid).map(({ tag, ...rest }) => rest) });
    if (req.url === '/rest/login/v7/authdirectapi') return j({ status: 'SUCCESS', AuthToken: 'AUTH-TOKEN-SECRET' });
    if (req.url === '/rest/login/v1/getaccesstoken') return j({ status: 'SUCCESS', accesstoken: 'ACCESS-SECRET' });
    if (req.url === '/rest/report/v3/getscripsbyexchangename') return j({ status: 'SUCCESS', data: [ ...EXTRA_SCRIPS,
      { scripname: 'GOLDPETAL 31-DEC-2026', instrumentname: 'FUTCOM', scripcode: 7777, marketlot: 1, ticksize: 1, expirydate: 1798000000, lowercircuitprice: DEC_BAND[0], uppercircuitprice: DEC_BAND[1] },
      { scripname: 'SILVERM 27-FEB-2027', instrumentname: 'FUTCOM', scripcode: 8888, marketlot: 1, ticksize: 1, expirydate: 1799000000 },
    ] });
    if (req.url === '/rest/report/v3/getltpdata') return j({ status: 'SUCCESS', data: { ltp: LTP * 100 } });
    if (req.url === '/rest/report/v3/getreportmarginsummary') return j({ status: 'SUCCESS', data: [{ particulars: 'Available Margin for Commodity', amount: 49403.93, clientcode: 'AB1234' }] });
    return j({ status: 'SUCCESS', data: [] });
  });
});
const efSeen = [];
const ef = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    const body = JSON.parse(b); efSeen.push(body);
    res.setHeader('Content-Type', 'application/json');
    if (body.mode === 'relay_prepare') return res.end(JSON.stringify({ ok: true, ...FAKE }));
    res.end(JSON.stringify({ ok: true, id: 1 }));
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
const sign = (t) => ({ ...t, sig: crypto.createHmac('sha256', SECRET).update(M.campaignCanonical(t)).digest('hex') });
const trig = (action, params = {}, allow_fill = false) => sign({ mode: 'veins_test', req: 'r-' + Math.random().toString(36).slice(2), action, params, allow_fill, ts: Date.now() });
const trans = () => seen.filter((x) => x.path.startsWith('/rest/trans/'));

// ---- 1. the guard (pure) ----
const C = { token: 7777, ltp: 12400, allowFill: false, maxLots: 1 };
const P = (o) => ({ exchange: 'MCX', symboltoken: 7777, quantityinlot: 1, tag: 'WMSVT', triggerprice: 0, ...o });
const ok = (k, b, row) => M.campaignCheck(k, b, C, row) === null;
T('guard: far BUY limit (−2%) allowed', ok('place', P({ buyorsell: 'BUY', ordertype: 'LIMIT', price: 12152 })));
T('guard: BUY limit near the price refused', !ok('place', P({ buyorsell: 'BUY', ordertype: 'LIMIT', price: 12300 })));
T('guard: BUY limit ABOVE the price refused (would fill)', !ok('place', P({ buyorsell: 'BUY', ordertype: 'LIMIT', price: 13000 })));
T('guard: SELL limit far above allowed', ok('place', P({ buyorsell: 'SELL', ordertype: 'LIMIT', price: 12648 })));
T('guard: SELL limit below the price refused', !ok('place', P({ buyorsell: 'SELL', ordertype: 'LIMIT', price: 12000 })));
T('guard: MARKET refused', !ok('place', P({ buyorsell: 'BUY', ordertype: 'MARKET', price: 0 })));
T('guard: SL-M refused', !ok('place', P({ buyorsell: 'SELL', ordertype: 'SL-M', price: 0, triggerprice: 12000 })));
T('guard: far SELL stop (trigger −2%, limit below) allowed', ok('place', P({ buyorsell: 'SELL', ordertype: 'STOPLOSS', triggerprice: 12152, price: 12132 })));
T('guard: SELL stop with limit above its trigger refused', !ok('place', P({ buyorsell: 'SELL', ordertype: 'STOPLOSS', triggerprice: 12152, price: 12160 })));
T('guard: near SELL stop refused', !ok('place', P({ buyorsell: 'SELL', ordertype: 'STOPLOSS', triggerprice: 12350, price: 12340 })));
T('guard: passed SELL stop with unfillable limit (+3%) allowed', ok('place', P({ buyorsell: 'SELL', ordertype: 'STOPLOSS', triggerprice: 12710, price: 12772 })));
T('guard: passed SELL stop with fillable limit refused', !ok('place', P({ buyorsell: 'SELL', ordertype: 'STOPLOSS', triggerprice: 12500, price: 12450 })));
T('guard: wrong contract refused', !ok('place', P({ symboltoken: 1, buyorsell: 'BUY', ordertype: 'LIMIT', price: 12000 })));
T('guard: 2 lots refused', !ok('place', P({ quantityinlot: 2, buyorsell: 'BUY', ordertype: 'LIMIT', price: 12000 })));
T('guard: tag must be WMSV…', !ok('place', P({ tag: 'ABC', buyorsell: 'BUY', ordertype: 'LIMIT', price: 12000 })));
T('guard: cancel of a non-test order refused', !ok('cancel', {}, { tag: 'MYAPP' }) && ok('cancel', {}, { tag: 'WMSVP' }));
T('guard: modify of a non-test order refused', !ok('modify', { newordertype: 'LIMIT', newprice: 12000 }, { tag: '', buyorsell: 'BUY' }));
T('guard: modify keeps the rule (BUY moved near → refused)', !ok('modify', { newordertype: 'LIMIT', newprice: 12390 }, { tag: 'WMSVP', buyorsell: 'BUY' }));
T('guard: allow-fill still caps prices within 3%', M.campaignCheck('place', P({ buyorsell: 'BUY', ordertype: 'LIMIT', price: 12462 }), { ...C, allowFill: true }) === null
  && M.campaignCheck('place', P({ buyorsell: 'BUY', ordertype: 'LIMIT', price: 13000 }), { ...C, allowFill: true }) !== null);
T('guard: switches itself off after CAMPAIGN_UNTIL', M.campaignCheck('place', P({ buyorsell: 'BUY', ordertype: 'LIMIT', price: 12000 }), C, null, M.CAMPAIGN_UNTIL + 1) !== null);

// ---- 2. signature ----
const t1 = trig('status');
T('signature: good one accepted', M.campaignSigOk(t1) === null);
T('signature: tampered params refused', M.campaignSigOk({ ...t1, params: { x: 1 } }) !== null);
T('signature: allow_fill flipped refused', M.campaignSigOk({ ...t1, allow_fill: true }) !== null);
T('signature: stale (3 min) refused', M.campaignSigOk(sign({ ...t1, ts: Date.now() - 180_000, sig: undefined })) !== null);

// ---- 3. runs against the fake MOSL ----
let n = trans().length;
const u = await M.runCampaign({ mode: 'veins_test', req: 'x', action: 'place', params: {}, ts: Date.now() });
T('unsigned request refused, nothing sent', u.ok === false && /refused/.test(u.report.error) && trans().length === n);
const s = await M.runCampaign(trig('status'));
T('status: ok, reads only', s.ok === true && trans().length === n, JSON.stringify(s.report.error));
T('status: logs in as VEINS', efSeen.some((e) => e.mode === 'relay_prepare' && e.login_key === 'VEINS'));
T('status: margin rows recorded, account fields dropped', Array.isArray(s.report.margin_summary) && s.report.margin_summary[0]?.amount === 49403.93 && !JSON.stringify(s.report.margin_summary).includes('AB1234'));
const pl = await M.runCampaign(trig('place', { side: 'BUY', type: 'LIMIT' }));
T('place: default far BUY limit sent with a WMSV tag', pl.ok === true && orders.at(-1)?.tag?.startsWith('WMSV') && orders.at(-1).price <= 12400 * 0.98, JSON.stringify(pl.report.steps));
n = trans().length;
const near = await M.runCampaign(trig('place', { side: 'BUY', type: 'LIMIT', price: 12400 }));
T('place: near-market BUY blocked by the guard, nothing sent', near.ok === false && near.report.steps[0]?.status === 'BLOCKED' && trans().length === n);
const cc = await M.runCampaign(trig('cancel', { uid: orders.at(-1).uniqueorderid }));
T('cancel: our test order cancelled (tag taken from the order book)', cc.report.steps[0]?.status === 'SUCCESS' && orders.at(-1).orderstatus === 'Cancel', JSON.stringify(cc.report.steps));
orders.push({ uniqueorderid: 'APP1', tag: '', buyorsell: 'BUY', ordertype: 'Limit', orderstatus: 'Confirm', price: 12000 });
n = trans().length;
const ca = await M.runCampaign(trig('cancel', { uid: 'APP1' }));
T('cancel: an order placed in the MOSL app is never touched', ca.report.steps[0]?.status === 'BLOCKED' && trans().length === n);
const cs = await M.runCampaign(trig('carry_set', { amo: 'N' }));
T('carry_set: 5 orders (GTC/GTD limit + stop, DAY control) all far', cs.report.steps.filter((x) => /GTC|GTD|DAY/.test(x.step) && x.status === 'SUCCESS').length === 5);
n = trans().length;
const rtNo = await M.runCampaign(trig('round_trip', {}, false));
T('round trip refused without "allow fill"', rtNo.ok === false && trans().length === n);
const rt = await M.runCampaign(trig('round_trip', {}, true));
const rtSteps = rt.report.steps.map((x) => `${x.step}:${x.status ?? x.final ?? ''}`).join(' | ');
T('round trip: entry filled, stop placed, trailed 3×, cancelled, exit filled, flat', rt.ok === true && rt.report.position_left_open === false
  && rt.report.steps.filter((x) => /trail the stop/.test(x.step) && x.status === 'SUCCESS').length === 3, rtSteps);
const bt = await M.runCampaign(trig('band_test'));
T('band test: both beyond-band orders sent on the unfillable side, then cleaned up', bt.report.steps.filter((x) => /band/.test(x.step)).length === 2 && bt.report.steps.some((x) => /cleanup/.test(x.step)));

const pr = await M.runCampaign(trig('pair', { seconds: 30 }, true));
T('pair (neither leg fills in time): both cancelled, lot exited, flat', pr.report.position_left_open === false
  && pr.report.steps.filter((x) => /cancel \(neither/.test(x.step) && x.status === 'SUCCESS').length === 2, pr.report.steps.map((x) => x.step).join(' | '));
const ch = await M.runCampaign(trig('chase', { seconds: 30 }, true));
T('chase (stop never triggers): stop cancelled, lot exited, flat', ch.report.position_left_open === false && ch.report.steps.some((x) => /cancel the stop/.test(x.step)), ch.report.steps.map((x) => x.step).join(' | '));

const all = JSON.stringify([s, pl, near, cc, cs, rt, bt, pr, ch].map((r) => M.scrub(r.report)));
T('no secrets in any report', !/AUTH-TOKEN-SECRET|ACCESS-SECRET|KEY-XYZ|SEC-XYZ|123456/.test(all));

T('modify sends no date for a DAY order (book shows "0")', M.gtdForModify({ orderduration: 'Day', goodtilldate: '0' }) === ''
  && M.gtdForModify({ orderduration: 'GTD', goodtilldate: '02-Dec-2026' }) === '02-Dec-2026');
{ // modify ×30 on a SELL stop keeps its limit at/below the trigger every time
  const stp = await M.runCampaign(trig('place', { side: 'SELL', type: 'STOPLOSS' }));
  const uid = stp.report.steps[0].uniqueorderid;
  const mr = await M.runCampaign(trig('modify_repeat', { uid, n: 4 }));
  T('modify ×30 on a SELL stop: all sent, none blocked', mr.report.modifies_done === 4 && mr.report.steps.every((x) => x.status === 'SUCCESS'), JSON.stringify(mr.report.steps.map((x) => x.status + ' ' + (x.message ?? ''))));
}
{ const ps = await M.runCampaign(trig('passed_stop'));
  const st = ps.report.steps[0];
  T('passed stop: BUY stop below the price, limit = trigger, sent and cleaned up', st?.status === 'SUCCESS' && st.request.buyorsell === 'BUY' && st.request.price === st.request.triggerprice
    && st.request.triggerprice < LTP * 0.98 && ps.report.steps.some((x) => /cleanup/.test(x.step)), JSON.stringify(ps.report.steps)); }
// ---- 27-Nov live case: the expiring Nov contract listed first (band already stale), Dec band tight above ----
T('expiry read from the contract name', M.expiryFromName('GOLDPETAL 30-NOV-2026') === Date.UTC(2026, 10, 30, 18, 30) && M.expiryFromName('junk') === null);
const nov = { scripname: 'GOLDPETAL 30-NOV-2026', instrumentname: 'FUTCOM', scripcode: 5555, marketlot: 1, ticksize: 1, expirydate: 1796000000, lowercircuitprice: 11910, uppercircuitprice: 12646 };
EXTRA_SCRIPS = [nov]; DEC_BAND = [11700, 12460]; M.clearContractCache();   // above-market room only +0.5% (like the app showed)
const cs2 = await M.runCampaign(trig('carry_set', { amo: 'N' }));
T('carry_set skips the contract expiring within 7 days (uses Dec)', cs2.report.contract?.scripcode === 7777, JSON.stringify(cs2.report.contract));
T('carry_set still places all 5 (all below the market) when the band above is tight', cs2.report.steps.filter((x) => /GTC|GTD|DAY/.test(x.step) && x.status === 'SUCCESS').length === 5
  && cs2.report.contract.above_market_ok === false && cs2.report.contract.below_market_ok === true, cs2.report.error ?? '');
n = trans().length;
const sl2 = await M.runCampaign(trig('place', { side: 'SELL', type: 'LIMIT' }));
T('an above-market order with no safe room is refused, not sent', trans().length === n && sl2.report.steps[0]?.status === 'BLOCKED', JSON.stringify(sl2.report.steps[0] ?? sl2.report.error));
EXTRA_SCRIPS = []; DEC_BAND = [12390, 12405]; M.clearContractCache();      // no usable contract at all
const st2 = await M.runCampaign(trig('status'));
T('status still works when no contract is usable', st2.ok === true && !!st2.report.contract_error && Array.isArray(st2.report.margin_summary));
const pl2 = await M.runCampaign(trig('place', { side: 'BUY', type: 'LIMIT' }));
T('an order test with no usable contract stops before sending anything', pl2.ok === false && trans().length === n);
const ca2 = await M.runCampaign(trig('cancel_all'));
T('cancel all still works with no usable contract', ca2.ok === true && ca2.report.steps.some((x) => /cancel WMSV/.test(x.step) && x.status === 'SUCCESS'));
DEC_BAND = [11700, 13100]; M.clearContractCache();
n = seen.filter((x) => /getscrips/.test(x.path)).length;
await M.runCampaign(trig('status')); await M.runCampaign(trig('status'));
T('contract list downloaded once, then reused (runs no longer wait ~15 s)', seen.filter((x) => /getscrips/.test(x.path)).length === n + 1);

mosl.close(); ef.close(); ip.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
