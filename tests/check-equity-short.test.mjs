// check-equity-short.test.mjs — selling MORE equity than is held opens a SHORT in the
// books instead of being skipped with a "SELL with no cost basis" warning, and the
// later BUY that covers it books the gain on the COVER date (owner 2026-10-15 — T0
// APTUS: 2,000 sold at CS on 09-Oct-2026 against shares held elsewhere).
//   SELL (short part) : Dr Broker [proceeds] / Cr Investment [proceeds]   — no gain yet
//   BUY  (cover part) : Dr Investment [short proceeds + any new long cost] / Cr Broker [paid]
//                       / Cr (Dr) Capital gain [short proceeds − cover cost], ST / LT / intraday
//                       by how long the short was open.
// A SAME-DAY sell-then-buy is an intraday round trip and keeps its P&L on the SELL
// exactly as before. Runs the REAL shared FIFO (wms-shared.js) + the real engine.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import vm from 'vm';
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

const sandbox = {
  SUPABASE_URL: '', SUPABASE_ANON_KEY: '', window: {}, document: { addEventListener() {}, hidden: true },
  console, Date, Math, JSON, Object, Array, String, Number, Boolean,
  parseInt, parseFloat, isNaN, isFinite, fetch: () => Promise.resolve({ ok: false }),
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'wms-shared.js'), 'utf8'), sandbox, { filename: 'wms-shared.js' });
const fifo = sandbox.wmsCalcFifoCost;
const { acctEngineProcess, voucherBalances } = require(join(ROOT, process.env.ACCT_ENGINE || 'accounting-engine.js'));

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL', name); } }
const r2 = (x) => Math.round(x * 100) / 100;
const sum = (ls, k) => r2(ls.reduce((a, l) => a + (l[k] || 0), 0));
const L = (v, pred) => (v ? v.lines.filter((l) => pred(l.ref || {})) : []);
const inv = (v) => L(v, (r) => r.security_id === 'S1');
const brk = (v) => L(v, (r) => r.broker_id === 'CS');
const role = (v, x) => L(v, (r) => r.role === x);
const sec = { S1: { security_type: 'EQUITY', symbol: 'APTUS', capital_gains: { stcg: 'CG_ST_STT', ltcg: 'CG_LT', lt_months: 12 }, income_ledgers: {} } };
const ctx = (stt) => ({ securityById: sec, investorById: { T0: { stt_accounting_method: !!stt } }, brokerById: {}, fifo });
const S = { investor_id: 'T0', trader_id: 'T0', security_id: 'S1', broker_id: 'CS', symbol: 'APTUS', short_symbol: 'APTUS', security_type: 'EQUITY', stt: 0 };
const T = (o) => Object.assign({}, S, o);
const ALL = [];
const run = (trades, stt) => {
  const res = acctEngineProcess({ id: 'T0', post_fno: true }, trades, ctx(stt));
  ALL.push(res);
  const V = {}; res.vouchers.forEach((v) => (V[v.txnId] = v));
  return { res, V };
};

// --- 1. the real case: buy 4,000; sell 4,000 then 2,000 more the same day (09-Oct-2026) ---
const real = [
  T({ id: 'b1', transaction_type: 'BUY', quantity: 4000, price: 350, net_amount: 1407000, transaction_date: '2025-08-04', created_at: '2026-03-07T06:08:49Z' }),
  T({ id: 's1', transaction_type: 'SELL', quantity: -4000, price: 215.37, net_amount: 857160, transaction_date: '2026-10-09', created_at: '2026-10-10T11:07:02Z' }),
  T({ id: 's2', transaction_type: 'SELL', quantity: -2000, price: 215.37, net_amount: 428580, transaction_date: '2026-10-09', created_at: '2026-10-10T11:07:42Z' }),
];
let { res, V } = run(real);
ok('APTUS: no "SELL with no cost basis" warning', !res.exceptions.some((e) => /sell_no_cost_basis/.test(e.condition_key)));
ok('APTUS: the extra 2,000 sale now posts', !!V.s2);
ok('APTUS short: Dr CS 428,580', sum(brk(V.s2), 'debit') === 428580);
ok('APTUS short: Cr Investment 428,580 (the open short)', sum(inv(V.s2), 'credit') === 428580 && sum(inv(V.s2), 'debit') === 0);
ok('APTUS short: no gain booked yet', V.s2 && V.s2.lines.length === 2);
ok('APTUS short: narration says it opens a short', V.s2 && /opens short 2000/.test(V.s2.narration));
ok('APTUS: the 4,000 sale is unchanged (cost 1,407,000, loss 549,840)', sum(inv(V.s1), 'credit') === 1407000 && sum(role(V.s1, 'CG_LT'), 'debit') === 549840);

// --- 2. cover later at a lower price: buy 2,000 @ 200 on 20-Nov-2026 (net 400,000) ---
({ res, V } = run(real.concat([T({ id: 'c1', transaction_type: 'BUY', quantity: 2000, price: 200, net_amount: 400000, transaction_date: '2026-11-20' })])));
ok('cover: Dr Investment 428,580 (short closed)', sum(inv(V.c1), 'debit') === 428580);
ok('cover: Cr CS 400,000 (cash paid)', sum(brk(V.c1), 'credit') === 400000);
ok('cover: profit 28,580 to short-term gains, on the cover date', sum(role(V.c1, 'CG_ST_STT'), 'credit') === 28580 && V.c1.date === '2026-11-20');
ok('cover: the short SELL voucher is unchanged by the cover', V.s2 && V.s2.lines.length === 2 && sum(inv(V.s2), 'credit') === 428580);
ok('after cover the short leaves nothing on Investment (s2 + c1 net zero)', r2(sum(inv(V.s2), 'credit') - sum(inv(V.c1), 'debit')) === 0);

// --- 3. cover at a LOSS ---
({ res, V } = run(real.concat([T({ id: 'c2', transaction_type: 'BUY', quantity: 2000, price: 230, net_amount: 460000, transaction_date: '2026-11-20' })])));
ok('loss cover: loss 31,420 DEBITED to short-term gains', sum(role(V.c2, 'CG_ST_STT'), 'debit') === 31420);

// --- 4. buy MORE than the short: 3,000 @ 200 → 2,000 cover + 1,000 fresh long ---
({ res, V } = run(real.concat([T({ id: 'c3', transaction_type: 'BUY', quantity: 3000, price: 200, net_amount: 600000, transaction_date: '2026-11-20' })])));
ok('over-cover: Dr Investment 628,580 = short 428,580 + new long 200,000', sum(inv(V.c3), 'debit') === 628580);
ok('over-cover: gain 28,580 only on the covered 2,000', sum(role(V.c3, 'CG_ST_STT'), 'credit') === 28580);

// --- 5. short held more than 12 months → long-term ---
({ res, V } = run(real.concat([T({ id: 'c4', transaction_type: 'BUY', quantity: 2000, price: 200, net_amount: 400000, transaction_date: '2027-11-20' })])));
ok('cover after 12+ months: gain to Long Term Capital Gains', sum(role(V.c4, 'CG_LT'), 'credit') === 28580 && role(V.c4, 'CG_ST_STT').length === 0);

// --- 6. partial: hold 1,000, sell 1,500 → 1,000 normal sale + 500 short ---
({ res, V } = run([
  T({ id: 'p1', transaction_type: 'BUY', quantity: 1000, price: 100, net_amount: 100000, transaction_date: '2026-05-01' }),
  T({ id: 'p2', transaction_type: 'SELL', quantity: -1500, price: 120, net_amount: 180000, transaction_date: '2026-06-01' }),
]));
ok('partial: Cr Investment 160,000 = cost 100,000 + short 60,000', sum(inv(V.p2), 'credit') === 160000);
ok('partial: gain 20,000 on the 1,000 held', sum(role(V.p2, 'CG_ST_STT'), 'credit') === 20000);

// --- 7. same-day reverse-order round trip (KISSHT 08-May pattern) keeps its P&L on the SELL ---
({ res, V } = run([
  T({ id: 'k1', transaction_type: 'SELL', quantity: -10000, price: 212.89, net_amount: 2128900, transaction_date: '2026-05-08', created_at: '2026-05-08T10:00:00Z' }),
  T({ id: 'k2', transaction_type: 'BUY', quantity: 10000, price: 190.1, net_amount: 1901000, transaction_date: '2026-05-08', created_at: '2026-05-08T10:01:00Z' }),
]));
ok('intraday: SELL keeps Cr Investment 1,901,000 + intraday P&L 227,900 (as before)', sum(inv(V.k1), 'credit') === 1901000 && sum(role(V.k1, 'INTRADAY_PL'), 'credit') === 227900);
ok('intraday: BUY is a plain purchase (as before)', V.k2 && V.k2.lines.length === 2 && sum(inv(V.k2), 'debit') === 1901000);

// --- 8. STT accounted separately: short + cover still balance, STT on its own line ---
({ res, V } = run([
  T({ id: 'x1', transaction_type: 'SELL', quantity: -100, price: 100, net_amount: 9990, stt: 10, transaction_date: '2026-06-01' }),
  T({ id: 'x2', transaction_type: 'BUY', quantity: 100, price: 90, net_amount: 9009, stt: 9, transaction_date: '2026-07-01' }),
], true));
ok('STT-separate short: Cr Investment 10,000 (proceeds before STT)', sum(inv(V.x1), 'credit') === 10000 && sum(role(V.x1, 'STT_STOCKS'), 'debit') === 10);
ok('STT-separate cover: gain 1,000 = 10,000 − 9,000', sum(role(V.x2, 'CG_ST_STT'), 'credit') === 1000 && sum(role(V.x2, 'STT_STOCKS'), 'debit') === 9);

// --- 9. a normal long round trip is untouched ---
({ res, V } = run([
  T({ id: 'n1', transaction_type: 'BUY', quantity: 100, price: 100, net_amount: 10000, transaction_date: '2026-04-01' }),
  T({ id: 'n2', transaction_type: 'SELL', quantity: -100, price: 130, net_amount: 13000, transaction_date: '2026-06-01' }),
]));
ok('normal sale: Cr Investment 10,000 + gain 3,000, 3 lines', V.n2 && V.n2.lines.length === 3 && sum(inv(V.n2), 'credit') === 10000 && sum(role(V.n2, 'CG_ST_STT'), 'credit') === 3000);
ok('normal buy: 2 lines', V.n1 && V.n1.lines.length === 2);
ok('every voucher in every scenario balances', ALL.every((r) => r.vouchers.every((v) => voucherBalances(v.lines))));
ok('no exceptions in any scenario', ALL.every((r) => r.exceptions.length === 0));

console.log(`\n${pass} passed, ${fail} failed  (equity short: open on SELL, gain on cover)`);
if (fail) process.exit(1);
