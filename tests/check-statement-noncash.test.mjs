// check-statement-noncash.test.mjs — Statements: corporate actions that move no cash
// (DEMERGER, BONUS, SPLIT, RIGHTS_ENTITLEMENT) carry ZERO amount in the ledger, in every
// perspective (owner 2026-10-19). Real case: stmt_T0_CS showed the VERANDA demerger of
// 06-Oct-26 as a (1,972.04)k cash row, and the child lot dated 14-Jul-26 (996,877.50)
// pushed the balance before the 03-Oct reconciliation off by exactly that amount.
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

const base = { investor_id: 'T0', trader_id: 'T0', broker_id: 'CS', security_type: 'EQUITY' };
const T = (o) => Object.assign({}, base, o);
const txns = [
  T({ id: 'b', transaction_type: 'BUY', transaction_date: '2026-07-01', symbol: 'X', quantity: 100, net_amount: 50000 }),
  T({ id: 'p', transaction_type: 'DEMERGER', transaction_date: '2026-10-06', symbol: 'VERANDA', quantity: -25000, net_amount: 1972041.56 }),
  T({ id: 'c', transaction_type: 'DEMERGER', transaction_date: '2026-07-14', symbol: 'VERANDA-PE', quantity: 12500, net_amount: 996877.5 }),
  T({ id: 'bo', transaction_type: 'BONUS', transaction_date: '2026-08-01', symbol: 'Y', quantity: 50, net_amount: 0 }),
  T({ id: 'sp', transaction_type: 'SPLIT', transaction_date: '2026-08-02', symbol: 'Z', quantity: 50, net_amount: 0 }),
  T({ id: 's', transaction_type: 'SELL', transaction_date: '2026-10-07', symbol: 'X', quantity: -100, net_amount: 60000 }),
];
for (const persp of ['investor', 'trader', 'broker']) {
  const rows = sb.wmsBuildLedger([], txns, { perspective: persp, investorIds: ['T0'], brokerIds: ['CS'] });
  const amt = (id) => { const r = rows.find((x) => x._source && x._source.id === id); return r ? r.amount : undefined; };
  ok(`${persp}: demerger parent amount 0`, amt('p') === 0);
  ok(`${persp}: demerger child amount 0`, amt('c') === 0);
  ok(`${persp}: bonus / split amount 0`, amt('bo') === 0 && amt('sp') === 0);
  ok(`${persp}: BUY still +50,000`, amt('b') === 50000);
  ok(`${persp}: SELL still -60,000`, amt('s') === -60000);
  ok(`${persp}: demerger rows still listed (shown, no cash)`, amt('p') !== undefined && amt('c') !== undefined);
}
console.log(`\n${pass} passed, ${fail} failed  (statement: non-cash corporate actions carry no amount)`);
if (fail) process.exit(1);
