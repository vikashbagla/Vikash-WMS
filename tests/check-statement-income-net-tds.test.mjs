// check-statement-income-net-tds.test.mjs — Statements: income rows (DIVIDEND /
// OTHER_INCOME / INTEREST / CAPITAL_REDUCTION) show gross − the TDS entered on the
// trade, in every perspective (owner 2026-10-23). Real case: KTKBANK dividend
// 29-Sep-26 (gross 212,500, TDS 21,250) showed 212,500 on stmt_T0_CS and the T2
// statement while the books posted 191,250 — the owner had patched it with manual
// ADJUSTMENT rows.
// Runs the REAL wmsBuildLedger from wms-shared.js.
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const SHARED = fs.readFileSync(join(here, '..', 'wms-shared.js'), 'utf8');
function _unused_extractFn(src, name) {
  const m = new RegExp('^function\\s+' + name + '\\s*\\(', 'm').exec(src);
  let i = src.indexOf('{', m.index), depth = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (depth === 0) break; } }
  return src.slice(m.index, j + 1);
}
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL', name); } }
const sb = {
  SUPABASE_URL: '', SUPABASE_ANON_KEY: '', window: {}, document: { addEventListener() {}, hidden: true },
  console, Date, Math, JSON, Object, Array, String, Number, Boolean, parseInt, parseFloat, isNaN, isFinite,
  fetch: () => Promise.resolve({ ok: false }), setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(SHARED, sb, { filename: 'wms-shared.js' });

const base = { investor_id: 'T0', trader_id: 'T2', broker_id: 'CS', security_type: 'EQUITY' };
const T = (o) => Object.assign({}, base, o);
const txns = [
  T({ id: 'b', transaction_type: 'BUY', transaction_date: '2026-07-01', symbol: 'KTKBANK', quantity: 100, gross_amount: 50000, net_amount: 50000, tds: 0 }),
  T({ id: 'd', transaction_type: 'DIVIDEND', transaction_date: '2026-09-29', symbol: 'KTKBANK', gross_amount: 212500, net_amount: 212500, tds: 21250 }),
  T({ id: 'd0', transaction_type: 'DIVIDEND', transaction_date: '2026-10-12', symbol: 'KAMDHENU', gross_amount: 60000, net_amount: 60000, tds: 0 }),
  T({ id: 'o', transaction_type: 'OTHER_INCOME', transaction_date: '2026-09-01', symbol: 'Y', gross_amount: 1000, net_amount: 1000, tds: 100 }),
  T({ id: 'cr', transaction_type: 'CAPITAL_REDUCTION', transaction_date: '2026-09-02', symbol: 'Z', gross_amount: 5000, net_amount: 5000, tds: 500 }),
  T({ id: 'i', transaction_type: 'INTEREST', transaction_date: '2026-08-21', symbol: 'INDIGRID', gross_amount: 2000, net_amount: 2000, tds: 200 }),
  T({ id: 'dn', transaction_type: 'DIVIDEND', transaction_date: '2026-09-03', symbol: 'N', gross_amount: 300, net_amount: 300, tds: null }),
  T({ id: 's', transaction_type: 'SELL', transaction_date: '2026-10-07', symbol: 'KTKBANK', quantity: -100, gross_amount: 60000, net_amount: 60000, tds: 0 }),
];
for (const persp of ['investor', 'trader', 'broker']) {
  sb.wmsSanitizeTransactions(txns);
  const rows = sb.wmsBuildLedger([], txns, { perspective: persp, investorIds: ['T0'], brokerIds: ['CS'] });
  const amt = (id) => { const r = rows.find((x) => x._source && x._source.id === id); return r ? r.amount : undefined; };
  ok(`${persp}: dividend net of TDS (-191,250)`, amt('d') === -191250);
  ok(`${persp}: dividend with no TDS unchanged (-60,000)`, amt('d0') === -60000);
  ok(`${persp}: dividend with TDS null unchanged (-300)`, amt('dn') === -300);
  ok(`${persp}: other income net (-900)`, amt('o') === -900);
  ok(`${persp}: capital reduction net (-4,500)`, amt('cr') === -4500);
  ok(`${persp}: INTEREST net, stored sign kept (+1,800)`, amt('i') === 1800);
  ok(`${persp}: BUY untouched (+50,000)`, amt('b') === 50000);
  ok(`${persp}: SELL untouched (-60,000)`, amt('s') === -60000);
}
console.log(`\n${pass} passed, ${fail} failed  (statement: income rows net of trade TDS)`);
if (fail) process.exit(1);
