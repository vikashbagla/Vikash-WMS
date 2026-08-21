// check-direct-subtrader.test.mjs — a sub-trader's OWN (direct) trades
// (investor === trader, entity has a parent — today only T3) must post in the
// PARENT book as CLIENT trades: Dr/Cr the Trader current account vs a
// beneficiary-SCOPED broker ledger ({broker_id, investor_id}), with NO brokerage
// spread and NO investment / capital-gains leg. Owner 2026-08-21.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { acctEngineProcess } = require(join(here, '..', 'accounting-engine.js'));

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL', name); } }
const isScoped = (r, brk, inv) => r && r.broker_id === brk && r.investor_id === inv;
const isBroker = (r, brk) => r && r.broker_id === brk && !r.investor_id;
const isTrader = (r, inv) => r && r.investor_id === inv && !r.broker_id;

const ctx = {
  securityById: { S1: { security_type: 'EQUITY', symbol: 'ABC', capital_gains: { stcg: 'CG_ST_STT', ltcg: 'CG_LT_STT', lt_months: 12 }, income_ledgers: {} } },
  investorById: { T0: { stt_accounting_method: false, post_fno: true }, T3: { book_parent_id: 'T0' }, T1: { book_parent_id: 'T0' }, VEINS: {} },
  brokerById: {},
  fifo: (tx) => ({ gains: tx.filter((t) => t.transaction_type === 'SELL').map((t) => ({ sellTxnId: t.id, qty: Math.abs(t.quantity), buyCost: 900000, gain: 100000, buyDate: '2025-06-01', sellDate: t.transaction_date, securityType: 'EQUITY' })) }),
};
const base = { security_id: 'S1', symbol: 'ABC', short_symbol: 'ABC', security_type: 'EQUITY', price: 0, stt: 0, tds: 0 };
const trades = [
  Object.assign({ id: 'd1', investor_id: 'T3', trader_id: 'T3', broker_id: 'CS', transaction_type: 'BUY', quantity: 100, gross_amount: 100000, total_charges: 500, trader_charges: 0, net_amount: 100500, transaction_date: '2026-05-07' }, base),
  Object.assign({ id: 'd2', investor_id: 'T3', trader_id: 'T3', broker_id: 'CS', transaction_type: 'SELL', quantity: -100, gross_amount: 200000, total_charges: 1000, trader_charges: 0, net_amount: 199000, transaction_date: '2026-05-08' }, base),
  Object.assign({ id: 'o1', investor_id: 'T0', trader_id: 'T0', broker_id: 'CS', transaction_type: 'BUY', quantity: 100, gross_amount: 100000, total_charges: 500, trader_charges: 0, net_amount: 100500, transaction_date: '2026-05-01' }, base),
  Object.assign({ id: 'c1', investor_id: 'VEINS', trader_id: 'T1', broker_id: 'CS', transaction_type: 'BUY', quantity: 100, gross_amount: 100000, total_charges: 400, trader_charges: 500, net_amount: 100400, transaction_date: '2026-05-02' }, base),
];
const res = acctEngineProcess({ id: 'T0', post_fno: true }, trades, ctx);
const V = {}; res.vouchers.forEach((v) => (V[v.txnId] = v));

ok('direct buy posts (client)', !!V.d1 && V.d1.lines.length === 2);
ok('direct buy: Dr Trader-T3 full net', V.d1 && V.d1.lines.some((l) => isTrader(l.ref, 'T3') && l.debit === 100500));
ok('direct buy: Cr scoped CS-T3', V.d1 && V.d1.lines.some((l) => isScoped(l.ref, 'CS', 'T3') && l.credit === 100500));
ok('direct buy: NO Trader-Income spread', V.d1 && !V.d1.lines.some((l) => l.ref && l.ref.role === 'TRADER_INCOME'));
ok('direct buy: NO investment/security leg', V.d1 && !V.d1.lines.some((l) => l.ref && l.ref.security_id));
ok('direct sell: Dr scoped CS-T3', V.d2 && V.d2.lines.some((l) => isScoped(l.ref, 'CS', 'T3') && l.debit === 199000));
ok('direct sell: Cr Trader-T3', V.d2 && V.d2.lines.some((l) => isTrader(l.ref, 'T3') && l.credit === 199000));
ok('direct sell: NO capital-gains leg', V.d2 && !V.d2.lines.some((l) => l.ref && /^CG_|INTRADAY/.test(l.ref.role || '')));
ok('direct sell: NO investment leg', V.d2 && !V.d2.lines.some((l) => l.ref && l.ref.security_id));
ok('own buy: Dr Investment', V.o1 && V.o1.lines.some((l) => l.ref && l.ref.security_id === 'S1' && l.debit === 100500));
ok('own buy: Cr PLAIN CS (not scoped)', V.o1 && V.o1.lines.some((l) => isBroker(l.ref, 'CS') && l.credit === 100500));
ok('client buy: Cr PLAIN CS', V.c1 && V.c1.lines.some((l) => isBroker(l.ref, 'CS')));
ok('client buy: Trader-Income spread posts', V.c1 && V.c1.lines.some((l) => l.ref && l.ref.role === 'TRADER_INCOME' && l.credit === 100));
ok('no exceptions', res.exceptions.length === 0);
ok('every voucher balances', res.vouchers.every((v) => { let d = 0, c = 0; v.lines.forEach((l) => { d += l.debit || 0; c += l.credit || 0; }); return Math.round((d - c) * 100) === 0; }));

console.log(`\n${pass} passed, ${fail} failed  (direct sub-trader -> scoped CS-T3 client posting)`);
if (fail) process.exit(1);
