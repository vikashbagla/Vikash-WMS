// check-demerger-client.test.mjs — a demerger posts only for the book's OWN holding.
// Real case (nightly 15-Oct-2026, T0 failed): VERANDA demerged on 06-Oct-2026 into
// VERANDA-PE for T0 (own) AND for T3 (direct sub-trader, posted in T0's book). The engine
// grouped both owners' rows under one key "VERANDA|2026-10-06": 8 child lines (both
// owners, 3,944,126.25) against ONE parent (1,972,084.69) → "not balanced", post failed.
// Rule (owner 2026-10-16): a CLIENT's demerger only re-splits the client's own cost —
// client holdings never sit on the book's Investment ledgers — so it posts nothing.
// The book's own demerger posts Dr child Investment / Cr parent Investment, balanced.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { acctEngineProcess, voucherBalances } = require(join(here, '..', process.env.ACCT_ENGINE || 'accounting-engine.js'));

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL', name); } }
const r2 = (x) => Math.round(x * 100) / 100;
const sum = (ls, k) => r2(ls.reduce((a, l) => a + (l[k] || 0), 0));

const ctx = {
  securityById: {
    P: { security_type: 'EQUITY', symbol: 'VERANDA', capital_gains: {}, income_ledgers: {} },
    C: { security_type: 'PRIVATE_EQUITY', symbol: 'VERANDA-PE', capital_gains: {}, income_ledgers: {} },
  },
  investorById: { T0: { stt_accounting_method: false, post_fno: true }, T3: { book_parent_id: 'T0' } },
  brokerById: {},
  fifo: () => ({ gains: [] }),
};
const D = (o) => Object.assign({ transaction_type: 'DEMERGER', broker_id: 'CS', stt: 0, symbol: o.security_id === 'P' ? 'VERANDA' : 'VERANDA-PE' }, o);
const parentNote = '[Demerger of VERANDA on 2026-10-06: 34.50% of cost allocated to VERANDA-PE]';
const childNote = (d) => '[Demerger from VERANDA on 2026-10-06: 34.50% of original cost; parent lot ' + d + ']';
const own = [
  D({ id: 'p0', investor_id: 'T0', trader_id: 'T0', security_id: 'P', quantity: -25000, net_amount: 1972041.56, transaction_date: '2026-10-06', notes: parentNote }),
  D({ id: 'c0a', investor_id: 'T0', trader_id: 'T0', security_id: 'C', quantity: 6250, net_amount: 498417.19, transaction_date: '2025-08-06', notes: childNote('2025-08-06') }),
  D({ id: 'c0b', investor_id: 'T0', trader_id: 'T0', security_id: 'C', quantity: 4370, net_amount: 333341.41, transaction_date: '2025-08-22', notes: childNote('2025-08-22') }),
  D({ id: 'c0c', investor_id: 'T0', trader_id: 'T0', security_id: 'C', quantity: 1880, net_amount: 143405.46, transaction_date: '2025-08-25', notes: childNote('2025-08-25') }),
  D({ id: 'c0d', investor_id: 'T0', trader_id: 'T0', security_id: 'C', quantity: 12500, net_amount: 996877.5, transaction_date: '2026-07-14', notes: childNote('2026-07-14') }),
];
const client = [
  D({ id: 'p3', investor_id: 'T3', trader_id: 'T3', security_id: 'P', quantity: -25000, net_amount: 1972084.69, transaction_date: '2026-10-06', notes: parentNote }),
  D({ id: 'c3a', investor_id: 'T3', trader_id: 'T3', security_id: 'C', quantity: 6250, net_amount: 498438.75, transaction_date: '2025-08-06', notes: childNote('2025-08-06') }),
  D({ id: 'c3b', investor_id: 'T3', trader_id: 'T3', security_id: 'C', quantity: 4370, net_amount: 333356.49, transaction_date: '2025-08-22', notes: childNote('2025-08-22') }),
  D({ id: 'c3c', investor_id: 'T3', trader_id: 'T3', security_id: 'C', quantity: 1880, net_amount: 143411.95, transaction_date: '2025-08-25', notes: childNote('2025-08-25') }),
  D({ id: 'c3d', investor_id: 'T3', trader_id: 'T3', security_id: 'C', quantity: 12500, net_amount: 996877.5, transaction_date: '2026-07-14', notes: childNote('2026-07-14') }),
];

// both owners in T0's run — the real failure
let res = acctEngineProcess({ id: 'T0', post_fno: true }, own.concat(client), ctx);
const dem = res.vouchers.filter((v) => v.type === 'PMS-DEMERGER');
ok('exactly one demerger voucher (T0 own)', dem.length === 1);
ok('it is T0\'s own event (parent p0)', dem[0] && dem[0].txnId === 'p0');
ok('Dr VERANDA-PE 1,972,041.56 (4 lots)', dem[0] && sum(dem[0].lines.filter((l) => l.ref.security_id === 'C'), 'debit') === 1972041.56);
ok('Cr VERANDA 1,972,041.56', dem[0] && sum(dem[0].lines.filter((l) => l.ref.security_id === 'P'), 'credit') === 1972041.56);
ok('it balances', dem[0] && voucherBalances(dem[0].lines));
ok('no "demerger does not balance" exception', !res.exceptions.some((e) => /demerger_unbalanced/.test(e.condition_key)));
ok('no exceptions at all', res.exceptions.length === 0);
ok('T3\'s 5 rows are skipped (client demerger)', ['p3', 'c3a', 'c3b', 'c3c', 'c3d'].every((id) => res.skipped.some((s) => s.id === id && /client demerger/.test(s.reason))));

// own only — unchanged behaviour
res = acctEngineProcess({ id: 'T0', post_fno: true }, own, ctx);
ok('own-only: one balanced demerger voucher', res.vouchers.length === 1 && voucherBalances(res.vouchers[0].lines));

console.log(`\n${pass} passed, ${fail} failed  (demerger posts only for the book's own holding)`);
if (fail) process.exit(1);
