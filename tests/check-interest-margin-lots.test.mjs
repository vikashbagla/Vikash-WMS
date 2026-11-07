// check-interest-margin-lots.test.mjs — Interest window: F&O Margin line expands to the lots
// holding the margin (owner 2026-11-07). Lots at a date must add up to the running margin the
// interest engines use for that date.
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const SHARED = fs.readFileSync(join(here, '..', 'wms-shared.js'), 'utf8');
const LEDGER = fs.readFileSync(join(here, '..', 'trading-ledger.js'), 'utf8');
let pass = 0, fail = 0;
function ok(n, c) { if (c) pass++; else { fail++; console.log('FAIL', n); } }
const sb = { window: {}, document: { addEventListener() {}, hidden: true }, console, Date, Math, JSON, Object, Array, String, Number, Boolean, parseInt, parseFloat, isNaN, isFinite, fetch: () => Promise.resolve({ ok: false }), setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}, SUPABASE_URL: '', SUPABASE_ANON_KEY: '' };
sb.globalThis = sb; vm.createContext(sb); vm.runInContext(SHARED, sb);
sb.wmsGetMarginRate = () => 25;
const T = (d, time, type, qty, price, net) => ({ investor_id: 'T3a', trader_id: 'T3a', broker_id: 'FY', security_type: 'MCX', symbol: 'MCX:SILVERM26NOVFUT', transaction_date: d, transaction_time: time, transaction_type: type, quantity: qty, price, net_amount: net, display_net_amount: net });
const tx = [T('2026-11-05', '23:15:13', 'SELL', -30, 188643.31, 5658450.41), T('2026-11-06', '13:50:44', 'BUY', 30, 186928.5, 5608696.18),
  T('2026-11-06', '18:30:13', 'SELL', -55, 186701.13, 10267021.87), T('2026-11-06', '20:17:30', 'BUY', 55, 186792.62, 10275135.14), T('2026-11-06', '23:15:10', 'SELL', -50, 186002.19, 9298714.48)];
const ev = sb.wmsCalcMarginFIFO(tx, {});
const lots6 = sb.wmsMarginLotsAsOf(tx, {}, '2026-11-06');
ok('one lot open at 06-Nov EOD', lots6.length === 1);
ok('lot = short 50 @186,002.19, value 9,298,714.48, 25%, margin 2,324,678.62', lots6[0].qty === -50 && lots6[0].price === 186002.19 && Math.abs(lots6[0].value - 9298714.48) < 0.05 && lots6[0].ratePct === 25 && Math.abs(lots6[0].margin - 2324678.62) < 0.01);
ok('lots sum = running margin at that date', Math.abs(lots6.reduce((s, l) => s + l.margin, 0) - sb.wmsGetMarginRunningAt(ev, '2026-11-06')) < 0.01);
const lots5 = sb.wmsMarginLotsAsOf(tx, {}, '2026-11-05');
ok('as of 05-Nov: the short 30', lots5.length === 1 && lots5[0].qty === -30);
ok('return value of the engine unchanged (array of events)', Array.isArray(ev) && ev.length === 5);
ok('interest window renders an expandable margin row', LEDGER.includes('lg-mg-caret') && LEDGER.includes('calc.marginLots'));
ok('pending rows carry the lots; posted rows rebuild them', LEDGER.includes('p.marginLots = wmsMarginLotsAsOf(') && LEDGER.includes('calc.marginLots = wmsMarginLotsAsOf('));
console.log(`\n${pass} passed, ${fail} failed  (interest window: margin breakdown)`);
if (fail) process.exit(1);
