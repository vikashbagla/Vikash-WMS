// check-statement-sameday-order.test.mjs — Statements (owner 2026-11-07): same-day F&O
// trades must be processed in TIME order for FIFO holdings and margin. Real case:
// T3a SILVERM 30-Nov-26 FUT on 06-Nov-26 (13:50 B30, 18:30 S55, 20:17 B55, 23:15 S50).
// Open position = short 50 from 23:15 @186,002.19 → margin 25% × 9,298,714.48 = 2,324,678.62.
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const SHARED = fs.readFileSync(join(here, '..', 'wms-shared.js'), 'utf8');
const LEDGER = fs.readFileSync(join(here, '..', 'trading-ledger.js'), 'utf8');
let pass = 0, fail = 0;
function ok(n, c) { if (c) pass++; else { fail++; console.log('FAIL', n); } }
function extractFn(src, name) {
  const st = src.indexOf('function ' + name + '(');
  let i = src.indexOf('{', st), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) break; } }
  return src.slice(st, i + 1);
}
const sb = { window: {}, document: { addEventListener() {}, hidden: true }, console, Date, Math, JSON, Object, Array, String, Number, Boolean, parseInt, parseFloat, isNaN, isFinite, fetch: () => Promise.resolve({ ok: false }), setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}, SUPABASE_URL: '', SUPABASE_ANON_KEY: '' };
sb.globalThis = sb; vm.createContext(sb); vm.runInContext(SHARED, sb);
vm.runInContext(extractFn(LEDGER, 'lgTxnChronoCmp'), sb);
sb.wmsGetMarginRate = () => 25;   // T3a @ Fyers
const T = (time, type, qty, price, net, created) => ({ investor_id: 'T3a', trader_id: 'T3a', broker_id: 'FY', security_type: 'MCX', symbol: 'MCX:SILVERM26NOVFUT', short_symbol: 'SILVERM', transaction_date: '2026-11-06', transaction_time: time, transaction_type: type, quantity: qty, price, net_amount: net, display_net_amount: net, created_at: created });
// Short 30 carried from 05-Nov, then the 06-Nov trades in the STORED (wrong) order.
const prior = { ...T('23:15:13', 'SELL', -30, 188643.31, 5658450.41, '2026-11-05T18:00:00Z'), transaction_date: '2026-11-05' };
const stored = [prior, T('13:50:44', 'BUY', 30, 186928.5, 5608696.18, 'a'), T('23:15:10', 'SELL', -50, 186002.19, 9298714.48, 'b'), T('18:30:13', 'SELL', -55, 186701.13, 10267021.87, 'c'), T('20:17:30', 'BUY', 55, 186792.62, 10275135.14, 'd')];
const sorted = stored.slice().sort(sb.lgTxnChronoCmp);
ok('time order: 13:50, 18:30, 20:17, 23:15', sorted.slice(1).map((t) => t.transaction_time).join(',') === '13:50:44,18:30:13,20:17:30,23:15:10');
const ev = sb.wmsCalcMarginFIFO(sorted);
const margin = ev[ev.length - 1].runningMargin;
ok('margin = 25% of the 23:15 short 50 (2,324,678.62)', Math.abs(margin - 2324678.62) < 0.01);
const fifo = sb.wmsCalcFifoCost(sorted);
const h = fifo.holdings['SILVERM26NOVFUT'];
ok('open qty −50', h && h.quantity === -50);
ok('avg cost = the 23:15 sell (≈186,002.29 net/unit)', h && Math.abs(h.avgCost - 9298714.48 / 50) < 0.01);
// Old behaviour (date-only sort) gives a different, wrong answer — guard that the code no longer uses it
ok('statement summary, export and pending-interest paths use the time-aware sort', (LEDGER.match(/return lgTxnChronoCmp\(a, b\);/g) || []).length === 3);
console.log(`\n${pass} passed, ${fail} failed  (statement: same-day trades in time order)`);
if (fail) process.exit(1);
