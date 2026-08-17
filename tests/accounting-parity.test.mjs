// =============================================================================
// accounting-parity.test — the Phase-C behaviour/parity gate for the posting
// engine (accounting-engine.js). Pattern of charges-parity.test.mjs: a
// self-contained SCENARIO MATRIX (no live DB) that asserts the AGREED vouchers
// for every trade type × own/client × asset class (EQ / NFO-fut / NFO-opt / MCX)
// × STT flag × F&O gate, plus the statement postings, plus two invariants:
//   (1) every emitted voucher balances (Σdr === Σcr);
//   (2) every unmapped/no-basis case raises an acct_exceptions alert (never a
//       silent skip or a one-legged voucher).
// Rules: POSTING-RULES.md v4 §9 / §9.1 / §9.2.  Run: node tests/accounting-parity.test.mjs
// =============================================================================
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const E = require(join(here, '..', 'accounting-engine.js'));
const { acctBuildVoucher, acctEngineProcess, acctProcessStatements, acctStatementVoucher, acctFnoRealised, voucherBalances } = E;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL', name); } }
// posting signature: sorted "account Dr|Cr amount" — account = role or the FK key
function acctKey(ref) { return ref.role || (ref.security_id && 'SEC:' + ref.security_id) || (ref.broker_id && 'BRK:' + ref.broker_id) || (ref.investor_id && 'INV:' + ref.investor_id) || '?'; }
function sig(v) { return (v.lines || []).map(l => acctKey(l.ref) + ' ' + (l.debit ? 'Dr ' + round(l.debit) : 'Cr ' + round(l.credit))).sort().join(' | '); }
function round(x) { return Math.round((+x || 0) * 100) / 100; }
function has(v, key, side, amt) { return (v.lines || []).some(l => acctKey(l.ref) === key && round(l[side]) === round(amt)); }

const ctx = {
  securityById: {
    EQ1: { security_type: 'EQUITY', symbol: 'ABC', capital_gains: { stcg: 'CG_ST_STT', ltcg: 'CG_LT_STT', lt_months: 12 }, income_ledgers: { DIVIDEND: 'INC_DIVIDEND', INTEREST: 'INC_INT_BONDS', OTHER_INCOME: 'INC_OTH_UNITS' } },
    FUT1: { security_type: 'NFO', symbol: 'NIFTY26AUGFUT', capital_gains: {}, income_ledgers: {} },
    OPT1: { security_type: 'NFO', symbol: 'NIFTY26AUG25000CE', capital_gains: {}, income_ledgers: {} },
    MCX1: { security_type: 'MCX', symbol: 'SILVERM26AUGFUT', capital_gains: {}, income_ledgers: {} },
    UNM: { security_type: 'EQUITY', symbol: 'NOMAP', capital_gains: {}, income_ledgers: {} }
  },
  investorById: {
    B0: { stt_accounting_method: false },            // own book, STT capitalised
    BS: { stt_accounting_method: true },              // own book, STT separate
    T1: { book_parent_id: 'B0' }, T2: { book_parent_id: 'B0' }
  },
  brokerById: {}
};
const own = o => Object.assign({ investor_id: 'B0', broker_id: 'BRK1' }, o);
const ownS = o => Object.assign({ investor_id: 'BS', broker_id: 'BRK1' }, o);
const cli = o => Object.assign({ investor_id: 'B0', trader_id: 'T1', broker_id: 'BRK1' }, o);
let v;

// ---- A. OWN EQUITY BUY/SELL, STT off & on ----
v = acctBuildVoucher(own({ transaction_type: 'BUY', security_id: 'EQ1', quantity: 100, net_amount: 10040 }), ctx, []);
ok('own EQ buy (STT off): Dr Investment 10040 / Cr Broker 10040', voucherBalances(v.lines) && has(v, 'SEC:EQ1', 'debit', 10040) && has(v, 'BRK:BRK1', 'credit', 10040));
v = acctBuildVoucher(ownS({ transaction_type: 'BUY', security_id: 'EQ1', quantity: 100, net_amount: 10040, stt: 10 }), ctx, []);
ok('own EQ buy (STT on): Dr Investment 10030 + Dr STT 10 / Cr Broker 10040', voucherBalances(v.lines) && has(v, 'SEC:EQ1', 'debit', 10030) && has(v, 'STT_STOCKS', 'debit', 10) && has(v, 'BRK:BRK1', 'credit', 10040));
v = acctBuildVoucher(ownS({ transaction_type: 'SELL', security_id: 'EQ1', quantity: -100, net_amount: 14945, stt: 15 }), ctx, [{ qty: 100, buyCost: 10030, gain: 4930, buyDate: '2025-01-01', sellDate: '2025-06-01', securityType: 'EQUITY' }]);
ok('own EQ sell STCG(STT): Cr CG_ST_STT 4930, balances', voucherBalances(v.lines) && has(v, 'CG_ST_STT', 'credit', 4930));
v = acctBuildVoucher(own({ transaction_type: 'SELL', security_id: 'EQ1', quantity: -100, net_amount: 9000 }), ctx, [{ qty: 100, buyCost: 10000, gain: -1000, buyDate: '2025-01-01', sellDate: '2025-06-01', securityType: 'EQUITY' }]);
ok('own EQ sell LOSS: Dr CG (loss) 1000, balances', voucherBalances(v.lines) && has(v, 'CG_ST_STT', 'debit', 1000));
v = acctBuildVoucher(own({ transaction_type: 'SELL', security_id: 'EQ1', quantity: -100, net_amount: 20000 }), ctx, [{ qty: 100, buyCost: 10000, gain: 10000, buyDate: '2024-01-01', sellDate: '2025-06-01', securityType: 'EQUITY' }]);
ok('own EQ sell LTCG(STT): Cr CG_LT_STT 10000', voucherBalances(v.lines) && has(v, 'CG_LT_STT', 'credit', 10000));
v = acctBuildVoucher(own({ transaction_type: 'SELL', security_id: 'EQ1', quantity: -50, net_amount: 7500 }), ctx, [{ qty: 50, buyCost: 7400, gain: 100, buyDate: '2025-06-01', sellDate: '2025-06-01', securityType: 'EQUITY' }]);
ok('own EQ intraday: Cr INTRADAY_PL', voucherBalances(v.lines) && has(v, 'INTRADAY_PL', 'credit', 100));
// no cost basis → skip + alert
v = acctBuildVoucher(own({ transaction_type: 'SELL', security_id: 'EQ1', quantity: -100, net_amount: 9000 }), ctx, []);
ok('own EQ sell no cost basis: SKIP + acct_exceptions alert', !!v.skip && !!(v.exceptions && v.exceptions.some(e => e.condition_key.indexOf('sell_no_cost_basis') === 0)));

// ---- B. CLIENT EQUITY ----
v = acctBuildVoucher(cli({ transaction_type: 'BUY', security_id: 'EQ1', quantity: 100, net_amount: 10040, total_charges: 40, trader_charges: 50 }), ctx, []);
ok('client EQ buy: Dr Client 10050 / Cr Broker 10040 / Cr Trader Income 10', voucherBalances(v.lines) && has(v, 'INV:T1', 'debit', 10050) && has(v, 'BRK:BRK1', 'credit', 10040) && has(v, 'TRADER_INCOME', 'credit', 10));
v = acctBuildVoucher(cli({ transaction_type: 'SELL', security_id: 'EQ1', quantity: -100, net_amount: 14960, total_charges: 40, trader_charges: 50 }), ctx, []);
ok('client EQ sell: Dr Broker 14960 / Cr Client 14950 / Cr Trader Income 10', voucherBalances(v.lines) && has(v, 'BRK:BRK1', 'debit', 14960) && has(v, 'INV:T1', 'credit', 14950) && has(v, 'TRADER_INCOME', 'credit', 10));

// ---- C. INCOME own (mapped + TDS, and unmapped → alert) ----
// net_amount stores GROSS (qty × price); tds separate. gross 1000, tds 100 -> settlement 900.
v = acctBuildVoucher(own({ transaction_type: 'DIVIDEND', security_id: 'EQ1', net_amount: 1000, tds: 100 }), ctx, []);
ok('own dividend: Cr Dividend 1000 / Dr TDS 100 / Dr PMS 900', voucherBalances(v.lines) && has(v, 'PMS_SETTLEMENT', 'debit', 900) && has(v, 'TDS_YIELD', 'debit', 100) && has(v, 'INC_DIVIDEND', 'credit', 1000));
v = acctBuildVoucher(own({ transaction_type: 'OTHER_INCOME', security_id: 'EQ1', net_amount: 500 }), ctx, []);
ok('own other income → INC_OTH_UNITS (mapped)', voucherBalances(v.lines) && has(v, 'INC_OTH_UNITS', 'credit', 500));
v = acctBuildVoucher(own({ transaction_type: 'DIVIDEND', security_id: 'UNM', net_amount: 300 }), ctx, []);
ok('own income UNMAPPED → INC_OTHER + alert', has(v, 'INC_OTHER', 'credit', 300) && !!(v.exceptions && v.exceptions.length));

// ---- D. CLIENT income / cap-reduction ----
v = acctBuildVoucher(cli({ transaction_type: 'DIVIDEND', security_id: 'EQ1', net_amount: 900 }), ctx, []);
ok('client dividend: Dr PMS 900 / Cr Client 900', voucherBalances(v.lines) && has(v, 'PMS_SETTLEMENT', 'debit', 900) && has(v, 'INV:T1', 'credit', 900));
v = acctBuildVoucher(own({ transaction_type: 'CAPITAL_REDUCTION', security_id: 'EQ1', net_amount: 500 }), ctx, []);
ok('own cap-reduction: Dr PMS 500 / Cr Investment 500', voucherBalances(v.lines) && has(v, 'PMS_SETTLEMENT', 'debit', 500) && has(v, 'SEC:EQ1', 'credit', 500));

// ---- E. RIGHTS_PAYMENT own & client (v4 fix) ----
v = acctBuildVoucher(own({ transaction_type: 'RIGHTS_PAYMENT', security_id: 'EQ1', net_amount: 2000 }), ctx, []);
ok('own rights: Dr Investment 2000 / Cr PMS 2000', voucherBalances(v.lines) && has(v, 'SEC:EQ1', 'debit', 2000) && has(v, 'PMS_SETTLEMENT', 'credit', 2000));
v = acctBuildVoucher(cli({ transaction_type: 'RIGHTS_PAYMENT', security_id: 'EQ1', net_amount: 500000, total_charges: 0, trader_charges: 2500 }), ctx, []);
ok('client rights (v4): Dr Client 502500 / Cr PMS 500000 / Cr Trader Income 2500', voucherBalances(v.lines) && has(v, 'INV:T1', 'debit', 502500) && has(v, 'PMS_SETTLEMENT', 'credit', 500000) && has(v, 'TRADER_INCOME', 'credit', 2500));

// ---- F. F&O FUTURES own (post_fno on/off) & client, + MCX ----
ctx.book = { id: 'B0', post_fno: true };
v = acctBuildVoucher(own({ transaction_type: 'SELL', security_id: 'FUT1', symbol: 'NIFTY26AUGFUT', security_type: 'NFO', quantity: -50 }), ctx, [{ gain: 5000 }]);
ok('own future close profit (post_fno on): Dr Broker 5000 / Cr FNO_PL 5000', voucherBalances(v.lines) && has(v, 'BRK:BRK1', 'debit', 5000) && has(v, 'FNO_PL', 'credit', 5000));
ctx.book = { id: 'B0', post_fno: false };
v = acctBuildVoucher(own({ transaction_type: 'SELL', security_id: 'FUT1', symbol: 'NIFTY26AUGFUT', security_type: 'NFO', quantity: -50 }), ctx, [{ gain: 5000 }]);
ok('own future (post_fno OFF): SKIP', !!v.skip);
v = acctBuildVoucher(own({ transaction_type: 'SELL', security_id: 'MCX1', symbol: 'SILVERM26AUGFUT', security_type: 'MCX', quantity: -1 }), ctx, [{ gain: 3000 }]);
ok('own MCX treated as F&O (post_fno OFF → skip, NOT equity)', !!v.skip);
ctx.book = { id: 'B0', post_fno: true };
v = acctBuildVoucher(own({ transaction_type: 'SELL', security_id: 'MCX1', symbol: 'SILVERM26AUGFUT', security_type: 'MCX', quantity: -1 }), ctx, [{ gain: 3000 }]);
ok('own MCX future close (post_fno on): Broker vs FNO_PL', voucherBalances(v.lines) && has(v, 'FNO_PL', 'credit', 3000));
v = acctBuildVoucher(cli({ transaction_type: 'SELL', security_id: 'FUT1', symbol: 'NIFTY26AUGFUT', security_type: 'NFO', quantity: -50, total_charges: 100, trader_charges: 2730 }), ctx, [{ gain: 5000 }]);
ok('client future close: FNO_PL 5000 vs Client + Trader Income 2630 (posts even if flag)', voucherBalances(v.lines) && has(v, 'FNO_PL', 'debit', 5000) && has(v, 'INV:T1', 'credit', 5000) && has(v, 'TRADER_INCOME', 'credit', 2630));

// ---- G. OPTIONS as cash (own gated; client to client a/c); excluded from FIFO ----
ctx.book = { id: 'B0', post_fno: true };
v = acctBuildVoucher(own({ transaction_type: 'BUY', security_id: 'OPT1', symbol: 'NIFTY26AUG25000CE', security_type: 'NFO', net_amount: 5000 }), ctx, []);
ok('own option buy: Dr FNO_PL 5000 / Cr Broker 5000 (premium)', voucherBalances(v.lines) && has(v, 'FNO_PL', 'debit', 5000) && has(v, 'BRK:BRK1', 'credit', 5000));
v = acctBuildVoucher(own({ transaction_type: 'SELL', security_id: 'OPT1', symbol: 'NIFTY26AUG25000CE', security_type: 'NFO', net_amount: 8000, quantity: -100 }), ctx, []);
ok('own option sell: Dr Broker 8000 / Cr FNO_PL 8000 (premium)', voucherBalances(v.lines) && has(v, 'BRK:BRK1', 'debit', 8000) && has(v, 'FNO_PL', 'credit', 8000));
ctx.book = { id: 'B0', post_fno: false };
ok('own option (post_fno OFF): SKIP', !!acctBuildVoucher(own({ transaction_type: 'BUY', security_id: 'OPT1', symbol: 'NIFTY26AUG25000CE', security_type: 'NFO', net_amount: 5000 }), ctx, []).skip);
v = acctBuildVoucher(cli({ transaction_type: 'BUY', security_id: 'OPT1', symbol: 'NIFTY26AUG25000CE', security_type: 'NFO', net_amount: 5040, total_charges: 40, trader_charges: 50 }), ctx, []);
ok('client option buy: premium to Client 5050 / Broker 5040 / Trader Income 10', voucherBalances(v.lines) && has(v, 'INV:T1', 'debit', 5050) && has(v, 'TRADER_INCOME', 'credit', 10));
ok('options EXCLUDED from F&O FIFO', Object.keys(acctFnoRealised([own({ id: 'o1', transaction_type: 'BUY', security_type: 'NFO', security_id: 'OPT1', symbol: 'NIFTY26AUG25000CE', quantity: 50, net_amount: 5000 })])).length === 0);
ok('futures INCLUDED in F&O FIFO', Object.keys(acctFnoRealised([
  own({ id: 'f1', transaction_type: 'BUY', security_type: 'NFO', security_id: 'FUT1', symbol: 'NIFTY26AUGFUT', quantity: 50, net_amount: 5000, transaction_date: '2026-08-01' }),
  own({ id: 'f2', transaction_type: 'SELL', security_type: 'NFO', security_id: 'FUT1', symbol: 'NIFTY26AUGFUT', quantity: -50, net_amount: 6000, transaction_date: '2026-08-05' })
])).length > 0);

// ---- H. No-op & unrecognised types ----
['SPLIT', 'BONUS', 'RIGHTS_ENTITLEMENT', 'HISTORICAL_PL'].forEach(function (ty) {
  ok('no-op type ' + ty + ': skip', !!acctBuildVoucher(own({ transaction_type: ty, security_id: 'EQ1' }), ctx, []).skip);
});
v = acctBuildVoucher(own({ transaction_type: 'ZZZ', security_id: 'EQ1' }), ctx, []);
ok('unrecognised type: skip + alert', !!v.skip && !!(v.exceptions && v.exceptions.length));

// ---- I. Statement postings (interest / cash / recon / opening) + posting book ----
v = acctStatementVoucher({ entry_type: 'INTEREST_BOOKED', investor_id: 'B0', broker_id: 'BRK1', amount: 5000 }, ctx);
ok('stmt interest own: Dr Trading Interest / Cr Broker; book=B0', voucherBalances(v.lines) && has(v, 'INT_TRADING', 'debit', 5000) && has(v, 'BRK:BRK1', 'credit', 5000) && v.bookId === 'B0');
v = acctStatementVoucher({ entry_type: 'INTEREST_BOOKED', investor_id: 'T1', amount: 2000 }, ctx);
ok('stmt interest client: Dr Client / Cr Trading Interest; posts in PARENT book B0', voucherBalances(v.lines) && has(v, 'INV:T1', 'debit', 2000) && has(v, 'INT_TRADING', 'credit', 2000) && v.bookId === 'B0');
v = acctStatementVoucher({ entry_type: 'CASH_RECEIVED', investor_id: 'B0', broker_id: 'BRK1', amount: 20000 }, ctx);
ok('stmt cash received own: Dr Cash / Cr Broker', voucherBalances(v.lines) && has(v, 'CASH', 'debit', 20000) && has(v, 'BRK:BRK1', 'credit', 20000));
v = acctStatementVoucher({ entry_type: 'CASH_PAID', investor_id: 'T2', amount: 30000 }, ctx);
ok('stmt cash paid client: Dr Client / Cr Cash; book=B0', voucherBalances(v.lines) && has(v, 'INV:T2', 'debit', 30000) && has(v, 'CASH', 'credit', 30000) && v.bookId === 'B0');
ok('stmt reconciliation: skip', !!acctStatementVoucher({ entry_type: 'RECONCILIATION', investor_id: 'B0', amount: 1 }, ctx).skip);
ok('stmt opening balance: skip', !!acctStatementVoucher({ entry_type: 'OPENING_BALANCE', investor_id: 'B0', broker_id: 'BRK1', amount: 1 }, ctx).skip);

// ---- J. INVARIANT: a mixed book posts only balanced vouchers, no criticals ----
const mixed = [
  own({ id: 'm1', transaction_type: 'BUY', security_id: 'EQ1', quantity: 100, net_amount: 10000, transaction_date: '2026-04-01' }),
  own({ id: 'm2', transaction_type: 'SELL', security_id: 'EQ1', quantity: -100, net_amount: 12000, transaction_date: '2026-05-01' }),
  cli({ id: 'm3', transaction_type: 'BUY', security_id: 'EQ1', quantity: 100, net_amount: 9000, total_charges: 30, trader_charges: 40, transaction_date: '2026-04-15' }),
  cli({ id: 'm4', transaction_type: 'SELL', security_id: 'EQ1', quantity: -100, net_amount: 13000, total_charges: 30, trader_charges: 40, transaction_date: '2026-06-01' }),
  own({ id: 'm5', transaction_type: 'DIVIDEND', security_id: 'EQ1', net_amount: 900, tds: 100, transaction_date: '2026-05-10' }),
  cli({ id: 'm6', transaction_type: 'RIGHTS_PAYMENT', security_id: 'EQ1', net_amount: 100000, total_charges: 0, trader_charges: 500, transaction_date: '2026-05-20' })
];
const res = acctEngineProcess({ id: 'B0', post_fno: true }, mixed, Object.assign({}, ctx, { fifo: function (txns) {
  // minimal FIFO stub for the EQ round-trips above (own m1/m2, client m3/m4)
  return { gains: [
    { sellTxnId: 'm2', qty: 100, buyCost: 10000, gain: 2000, buyDate: '2026-04-01', sellDate: '2026-05-01', securityType: 'EQUITY' }
  ] };
} }));
ok('mixed book: every posted voucher balances', res.vouchers.length > 0 && res.vouchers.every(function (vv) { return voucherBalances(vv.lines); }));
ok('mixed book: no critical exceptions', !res.exceptions.some(function (e) { return e.severity === 'critical'; }));
const stmtRes = acctProcessStatements([
  { id: 's1', entry_type: 'INTEREST_BOOKED', investor_id: 'B0', broker_id: 'BRK1', amount: 5000, entry_date: '2026-04-04' },
  { id: 's2', entry_type: 'INTEREST_BOOKED', investor_id: 'T1', amount: 200, entry_date: '2026-04-04' },
  { id: 's3', entry_type: 'CASH_PAID', investor_id: 'T2', amount: 1000, entry_date: '2026-04-10' },
  { id: 's4', entry_type: 'RECONCILIATION', investor_id: 'B0', amount: 9, entry_date: '2026-04-30' }
], ctx);
ok('statements batch: 3 posted, 1 skipped, all balance', stmtRes.vouchers.length === 3 && stmtRes.skipped.length === 1 && stmtRes.vouchers.every(function (vv) { return voucherBalances(vv.lines); }));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
