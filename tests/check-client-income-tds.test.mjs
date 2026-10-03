// check-client-income-tds.test.mjs — a CLIENT's income (a holding that belongs to a
// trader, posted in the parent book) settles NET OF TDS on BOTH legs, exactly as the
// book's own income does: Dr PMS Settlement [gross − tds] / Cr Trader [gross − tds].
// No Trader Income line (TDS is not a charge spread) and no TDS line in the book
// (the client bears it). Owner 2026-10-03 — KTKBANK / T2 via CS, PMS-2627-0374 had
// credited the client gross + TDS. Runs through the REAL engine entry point.
// The figures are the real trades (query: transactions where transaction_type='DIVIDEND'
// and symbol='KTKBANK' and transaction_date='2026-09-29').
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { acctEngineProcess } = require(join(here, '..', process.env.ACCT_ENGINE || 'accounting-engine.js'));

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL', name); } }
const role = (v, r) => v.lines.filter((l) => l.ref && l.ref.role === r);
const trader = (v, inv) => v.lines.filter((l) => l.ref && l.ref.investor_id === inv && !l.ref.broker_id);
const sum = (ls, k) => Math.round(ls.reduce((a, l) => a + (l[k] || 0), 0) * 100) / 100;
const balances = (v) => Math.round((sum(v.lines, 'debit') - sum(v.lines, 'credit')) * 100) === 0;

const ctx = {
  securityById: { S1: { security_type: 'EQUITY', symbol: 'KTKBANK', capital_gains: { stcg: 'CG_ST_STT', ltcg: 'CG_LT_STT', lt_months: 12 }, income_ledgers: { DIVIDEND: 'INC_DIVIDEND', INTEREST: 'INC_INT_BONDS', OTHER_INCOME: 'INC_OTHER' } } },
  investorById: { T0: { stt_accounting_method: false, post_fno: true }, T2: { book_parent_id: 'T0' }, T3: { book_parent_id: 'T0' }, T1: { book_parent_id: 'T0' }, VEINS: {} },
  brokerById: {},
  fifo: () => ({ gains: [] }),
};
const base = { security_id: 'S1', symbol: 'KTKBANK', short_symbol: 'KTKBANK', security_type: 'EQUITY', stt: 0, transaction_date: '2026-09-29' };
const inc = (o) => Object.assign({ trader_charges: 0 }, base, o);
const trades = [
  // the real one: T2's holding at CS — gross 212,500, TDS 21,250 (total_charges mirrors the TDS, A.2.9)
  inc({ id: 'cs', investor_id: 'T0', trader_id: 'T2', broker_id: 'CS', transaction_type: 'DIVIDEND', quantity: 42500, price: 5, gross_amount: 212500, net_amount: 212500, tds: 21250, total_charges: 21250 }),
  // T2's holding at TG — gross 868,750, TDS 86,875
  inc({ id: 'tg', investor_id: 'T0', trader_id: 'T2', broker_id: 'TG', transaction_type: 'DIVIDEND', quantity: 173750, price: 5, gross_amount: 868750, net_amount: 868750, tds: 86875, total_charges: 86875 }),
  // client dividend with NO tds — must be untouched by the fix (gross both legs)
  inc({ id: 'nt', investor_id: 'T0', trader_id: 'T3', broker_id: 'TG', transaction_type: 'DIVIDEND', quantity: 3062, price: 0.9, gross_amount: 2755.8, net_amount: 2755.8, tds: 0, total_charges: 0 }),
  // a sub-trader's DIRECT holding (investor = trader = T3) also posts as a client in T0
  inc({ id: 'dr', investor_id: 'T3', trader_id: 'T3', broker_id: 'CS', transaction_type: 'DIVIDEND', quantity: 1500, price: 0.9, gross_amount: 1350, net_amount: 1350, tds: 135, total_charges: 135 }),
  // the same path carries a client's interest / other income / capital reduction
  inc({ id: 'in', investor_id: 'T0', trader_id: 'T2', broker_id: 'CS', transaction_type: 'INTEREST', quantity: 10, price: 100, gross_amount: 1000, net_amount: 1000, tds: 100, total_charges: 100 }),
  inc({ id: 'oi', investor_id: 'T0', trader_id: 'T2', broker_id: 'CS', transaction_type: 'OTHER_INCOME', quantity: 10, price: 50, gross_amount: 500, net_amount: 500, tds: 50, total_charges: 50 }),
  inc({ id: 'cr', investor_id: 'T0', trader_id: 'T2', broker_id: 'CS', transaction_type: 'CAPITAL_REDUCTION', quantity: 10, price: 70, gross_amount: 700, net_amount: 700, tds: 0, total_charges: 0 }),
  // T0's OWN dividend — the reference behaviour, must be unchanged
  inc({ id: 'ow', investor_id: 'T0', trader_id: 'T0', broker_id: 'CS', transaction_type: 'DIVIDEND', quantity: 42500, price: 5, gross_amount: 212500, net_amount: 212500, tds: 21250, total_charges: 21250 }),
  // client RIGHTS_PAYMENT and client BUY keep their trader-charge spread (unchanged)
  inc({ id: 'rp', investor_id: 'T0', trader_id: 'T2', broker_id: 'CS', transaction_type: 'RIGHTS_PAYMENT', quantity: 100, gross_amount: 500000, net_amount: 500000, tds: 0, total_charges: 0, trader_charges: 2500 }),
  inc({ id: 'by', investor_id: 'VEINS', trader_id: 'T1', broker_id: 'CS', transaction_type: 'BUY', quantity: 100, gross_amount: 100000, net_amount: 100400, tds: 0, total_charges: 400, trader_charges: 500, transaction_date: '2026-05-02' }),
];
const res = acctEngineProcess({ id: 'T0', post_fno: true }, trades, ctx);
const V = {}; res.vouchers.forEach((v) => (V[v.txnId] = v));

// --- the reported case ---
ok('CS dividend posts', !!V.cs);
ok('CS dividend: exactly 2 lines', V.cs && V.cs.lines.length === 2);
ok('CS dividend: Dr PMS Settlement 191,250 (gross − TDS)', V.cs && sum(role(V.cs, 'PMS_SETTLEMENT'), 'debit') === 191250 && sum(role(V.cs, 'PMS_SETTLEMENT'), 'credit') === 0);
ok('CS dividend: Cr Trader T2 191,250 (gross − TDS)', V.cs && sum(trader(V.cs, 'T2'), 'credit') === 191250 && sum(trader(V.cs, 'T2'), 'debit') === 0);
ok('CS dividend: NO Trader Income line', V.cs && role(V.cs, 'TRADER_INCOME').length === 0);
ok('CS dividend: NO TDS line in the book', V.cs && role(V.cs, 'TDS_YIELD').length === 0);
ok('CS dividend: NO income line in the book', V.cs && role(V.cs, 'INC_DIVIDEND').length === 0);
ok('CS dividend: narration marks it a client entry', V.cs && /\(client\)$/.test(V.cs.narration));
// --- same rule on the TG holding ---
ok('TG dividend: Dr PMS 781,875 / Cr T2 781,875, 2 lines', V.tg && V.tg.lines.length === 2 && sum(role(V.tg, 'PMS_SETTLEMENT'), 'debit') === 781875 && sum(trader(V.tg, 'T2'), 'credit') === 781875);
// --- no TDS: unchanged ---
ok('no-TDS client dividend: gross on both legs, 2 lines', V.nt && V.nt.lines.length === 2 && sum(role(V.nt, 'PMS_SETTLEMENT'), 'debit') === 2755.8 && sum(trader(V.nt, 'T3'), 'credit') === 2755.8);
// --- direct sub-trader ---
ok('direct sub-trader dividend: net 1,215 to Trader T3, no Trader Income', V.dr && V.dr.lines.length === 2 && sum(role(V.dr, 'PMS_SETTLEMENT'), 'debit') === 1215 && sum(trader(V.dr, 'T3'), 'credit') === 1215 && role(V.dr, 'TRADER_INCOME').length === 0);
// --- other income types on the same path ---
ok('client interest: net 900 both legs, no Trader Income', V.in && V.in.lines.length === 2 && sum(role(V.in, 'PMS_SETTLEMENT'), 'debit') === 900 && sum(trader(V.in, 'T2'), 'credit') === 900);
ok('client other income: net 450 both legs', V.oi && V.oi.lines.length === 2 && sum(role(V.oi, 'PMS_SETTLEMENT'), 'debit') === 450 && sum(trader(V.oi, 'T2'), 'credit') === 450);
ok('client capital reduction (no TDS): 700 both legs', V.cr && V.cr.lines.length === 2 && sum(role(V.cr, 'PMS_SETTLEMENT'), 'debit') === 700 && sum(trader(V.cr, 'T2'), 'credit') === 700);
// --- own book: the reference, unchanged ---
ok('OWN dividend unchanged: Dr PMS 191,250 + Dr TDS 21,250 / Cr Dividend Income 212,500', V.ow && V.ow.lines.length === 3 && sum(role(V.ow, 'PMS_SETTLEMENT'), 'debit') === 191250 && sum(role(V.ow, 'TDS_YIELD'), 'debit') === 21250 && sum(role(V.ow, 'INC_DIVIDEND'), 'credit') === 212500);
ok('client and own settle the SAME cash for the same dividend', V.cs && V.ow && sum(role(V.cs, 'PMS_SETTLEMENT'), 'debit') === sum(role(V.ow, 'PMS_SETTLEMENT'), 'debit'));
// --- neighbours that must NOT change ---
ok('client rights payment: spread still posts to Trader Income (2,500)', V.rp && sum(role(V.rp, 'TRADER_INCOME'), 'credit') === 2500 && sum(trader(V.rp, 'T2'), 'debit') === 502500 && sum(role(V.rp, 'PMS_SETTLEMENT'), 'credit') === 500000);
ok('client buy: spread still posts to Trader Income (100)', V.by && sum(role(V.by, 'TRADER_INCOME'), 'credit') === 100);
ok('no exceptions', res.exceptions.length === 0);
ok('every voucher balances', res.vouchers.every(balances));
ok('all ten trades produced a voucher', res.vouchers.length === 10);

console.log(`\n${pass} passed, ${fail} failed  (client income settles net of TDS, no Trader Income)`);
if (fail) process.exit(1);
