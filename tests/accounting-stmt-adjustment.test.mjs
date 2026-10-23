// accounting-stmt-adjustment.test.mjs — Statement ADJUSTMENT entries post to the books
// (owner rule 2026-10-23). Contra is ALWAYS PMS Settlement (never Cash). Direction follows
// the amount AS DISPLAYED on the statement (displayed = −stored):
//   Broker: displayed +ve (I owe broker less) → Dr Broker / Cr PMS; −ve → Dr PMS / Cr Broker.
//   Trader: displayed +ve (trader owes me less) → Dr PMS / Cr Trader; −ve → Dr Trader / Cr PMS.
// Client entries post in the PARENT book. Full year — no cutoff.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { acctStatementVoucher, acctProcessStatements, voucherBalances } = require(join(here, '..', 'accounting-engine.js'));
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL', name); } }
function amt(v, p) { const l = v.lines.find((l) => p(l.ref)); return l ? (l.debit || 0) - (l.credit || 0) : null; } // +dr / −cr
const ctx = { investorById: { T0: {}, T1: { book_parent_id: 'T0' }, T2: { book_parent_id: 'T0' }, T3: { book_parent_id: 'T0' } } };
const pms = (r) => r.role === 'PMS_SETTLEMENT';
let v;
// Broker, displayed +ve (stored −254,801 "Trf from T1 sheet") → Dr Broker / Cr PMS
v = acctStatementVoucher({ entry_type: 'ADJUSTMENT', investor_id: 'T0', broker_id: 'CS', amount: -254801, reference: 'Trf from T1 sheet' }, ctx);
ok('broker displayed +ve: Dr Broker / Cr PMS', voucherBalances(v.lines) && amt(v, (r) => r.broker_id === 'CS') === 254801 && amt(v, pms) === -254801);
ok('type STMT-ADJUSTMENT, own book T0', v.type === 'STMT-ADJUSTMENT' && v.bookId === 'T0');
ok('narration "Adjustment — <ref>"', v.narration === 'Adjustment — Trf from T1 sheet');
ok('never touches Cash', !v.lines.some((l) => l.ref.role === 'CASH'));
// Broker, displayed −ve (stored +6,000 KAMDHENU TDS) → Dr PMS / Cr Broker
v = acctStatementVoucher({ entry_type: 'ADJUSTMENT', investor_id: 'T0', broker_id: 'CS', amount: 6000 }, ctx);
ok('broker displayed −ve: Dr PMS / Cr Broker', voucherBalances(v.lines) && amt(v, pms) === 6000 && amt(v, (r) => r.broker_id === 'CS') === -6000);
// Trader, displayed +ve (stored −840,000 rent) → Dr PMS / Cr Trader, in the PARENT book
v = acctStatementVoucher({ entry_type: 'ADJUSTMENT', investor_id: 'T3', amount: -840000, reference: 'Rent Paid' }, ctx);
ok('trader displayed +ve: Dr PMS / Cr Trader', voucherBalances(v.lines) && amt(v, pms) === 840000 && amt(v, (r) => r.investor_id === 'T3') === -840000);
ok('client adjustment posts in parent book T0', v.bookId === 'T0');
// Trader, displayed −ve (stored +6,000) → Dr Trader / Cr PMS
v = acctStatementVoucher({ entry_type: 'ADJUSTMENT', investor_id: 'T3', amount: 6000 }, ctx);
ok('trader displayed −ve: Dr Trader / Cr PMS', voucherBalances(v.lines) && amt(v, (r) => r.investor_id === 'T3') === 6000 && amt(v, pms) === -6000 && v.narration === 'Adjustment');
ok('zero amount skipped', !!acctStatementVoucher({ entry_type: 'ADJUSTMENT', investor_id: 'T3', amount: 0 }, ctx).skip);
// Batch: adjustments are now vouchers, not "unhandled" exceptions
const res = acctProcessStatements([
  { id: 'a1', entry_type: 'ADJUSTMENT', investor_id: 'T1', amount: -254801, entry_date: '2026-10-16' },
  { id: 'a2', entry_type: 'ADJUSTMENT', investor_id: 'T0', broker_id: 'CS', amount: -254801, entry_date: '2026-10-16' },
  { id: 'a3', entry_type: 'ADJUSTMENT', investor_id: 'T2', amount: 86875, entry_date: '2026-09-29' },
], ctx);
ok('batch: 3 vouchers, no exceptions', res.vouchers.length === 3 && res.exceptions.length === 0);
// T1 → T0_CS transfer nets through PMS: Dr CS / Cr T1, PMS nets to zero
const net = {}; res.vouchers.slice(0, 2).forEach((x) => x.lines.forEach((l) => { const k = JSON.stringify(l.ref); net[k] = (net[k] || 0) + (l.debit || 0) - (l.credit || 0); }));
ok('T1→CS transfer nets: PMS zero, Dr CS, Cr T1', Math.abs(net[JSON.stringify({ role: 'PMS_SETTLEMENT' })]) < 0.005 && net[JSON.stringify({ broker_id: 'CS' })] === 254801 && net[JSON.stringify({ investor_id: 'T1' })] === -254801);
ok('T2 86,875 (stored +): Dr T2 / Cr PMS', amt(res.vouchers[2], (r) => r.investor_id === 'T2') === 86875);
console.log(`\n${pass} passed, ${fail} failed  (statement ADJUSTMENT → PMS Settlement)`);
if (fail) process.exit(1);
