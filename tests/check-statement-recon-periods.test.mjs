// check-statement-recon-periods.test.mjs — Statements (owner 2026-10-23):
// (1) with Hide pre-recon OFF, each reconciliation row heads a collapsible period
//     (rows after the previous reconciliation up to and including it); rows after
//     the last reconciliation are always the open period.
// (2) ledger rows carry no ✏️ edit icon; delete confirmation is a pop-up.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(join(here, '..', 'trading-ledger.js'), 'utf8');
let pass = 0, fail = 0;
function ok(n, c) { if (c) pass++; else { fail++; console.log('FAIL', n); } }
function extractFn(src, name) {
  const st = src.indexOf('function ' + name + '(');
  let i = src.indexOf('{', st), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) break; } }
  return src.slice(st, i + 1);
}
const lgAssignReconPeriods = new Function(extractFn(SRC, 'lgAssignReconPeriods') + '; return lgAssignReconPeriods;')();
const R = (id, d, k) => ({ _rowType: 'ledger', entryType: 'RECONCILIATION', date: d, sortKey: d + '|4|', _source: { id } });
const T = (d, n) => ({ _rowType: 'trade', date: d, sortKey: d + '|1|' + n });
const L = (d, ty) => ({ _rowType: 'ledger', entryType: ty, date: d, sortKey: d + '|3|' });
const a = T('2026-08-25', 'a'), i1 = L('2026-08-29', 'INTEREST_BOOKED'), r1 = R('r1', '2026-08-29');
const b = T('2026-09-04', 'b'), r2 = R('r2', '2026-09-12');
const c = T('2026-10-05', 'c'), adj = L('2026-10-05', 'ADJUSTMENT');
const rows = [c, r2, a, adj, r1, b, i1];               // any display order (e.g. sorted desc)
const m = lgAssignReconPeriods(rows);
ok('rows before 1st recon → r1', m.get(a) === 'r1' && m.get(i1) === 'r1');
ok('same-day interest belongs to that recon (sorts before it)', m.get(i1) === 'r1');
ok('recon row maps to itself', m.get(r1) === 'r1' && m.get(r2) === 'r2');
ok('rows between recons → later recon', m.get(b) === 'r2');
ok('rows after last recon → open period', m.get(c) === '' && m.get(adj) === '');
ok('no recons → everything open', lgAssignReconPeriods([a, b]).get(a) === '');
ok('pencil removed from ledger rows', !/title="Edit">✏️/.test(SRC));
ok('delete confirm is a pop-up', SRC.includes("ov.className = 'lg-del-overlay'"));
ok('recon row click toggles its period', SRC.includes("lgReconExpanded[rid] = !lgReconExpanded[rid]"));
ok('filter hides collapsed periods only when Hide pre-recon is OFF', /if \(!lgHidePreRecon\) \{\s*var per = reconPeriodOf\.get\(row\)/.test(SRC));
console.log(`\n${pass} passed, ${fail} failed  (statement: collapsible reconciliation periods + delete pop-up)`);
if (fail) process.exit(1);
