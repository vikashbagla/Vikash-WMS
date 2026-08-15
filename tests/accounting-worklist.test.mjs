// accounting-worklist.test — the incremental posting worklist (new/changed/
// unchanged/closed/orphan) per FY-CLOSE-PLAN D10/D12/D17/D18. Pure, offline.
//   node tests/accounting-worklist.test.mjs
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { acctVoucherSig, acctDiffVouchers, inClosedPeriod } = require(join(here, '..', 'wms-acct-worklist.js'));

let pass = 0, fail = 0;
function ok(n, c) { if (c) pass++; else { fail++; console.log('FAIL', n); } }

// signature: order-independent, amount-canonical
const a = acctVoucherSig([{ ledger_id: 'L1', debit_amount: 100, credit_amount: 0 }, { ledger_id: 'L2', debit_amount: 0, credit_amount: 100 }]);
const b = acctVoucherSig([{ ledger_id: 'L2', debit: 0, credit: 100 }, { ledger_id: 'L1', debit: 100.004, credit: 0 }]);
ok('sig is order-independent + amount-canonical (2dp)', a === b);
ok('sig differs when an amount differs', a !== acctVoucherSig([{ ledger_id: 'L1', debit_amount: 101, credit_amount: 0 }, { ledger_id: 'L2', debit_amount: 0, credit_amount: 101 }]));

ok('inClosedPeriod: on/before close date = closed', inClosedPeriod('2026-06-30', '2026-06-30') && inClosedPeriod('2026-05-01', '2026-06-30'));
ok('inClosedPeriod: after close / null = open', !inClosedPeriod('2026-07-01', '2026-06-30') && !inClosedPeriod('2026-05-01', null));

// worklist classification
const fresh = [
  { key: 'tNEW', sig: 's1', date: '2026-07-01' },                 // no existing → post
  { key: 'tSAME', sig: 'sX', date: '2026-07-01' },                // same sig → unchanged
  { key: 'tCHG_OPEN', sig: 'sNEW', date: '2026-07-01' },          // changed, open → replace
  { key: 'tCHG_CLOSED', sig: 'sNEW', date: '2026-05-01' }         // changed, closed → blocked (log)
];
const existing = [
  { key: 'tSAME', sig: 'sX', id: 'v-same' },
  { key: 'tCHG_OPEN', sig: 'sOLD', id: 'v-open' },
  { key: 'tCHG_CLOSED', sig: 'sOLD', id: 'v-closed' },
  { key: 'tORPHAN', sig: 'sZ', id: 'v-orphan' }                   // no fresh → orphan (alert)
];
const d = acctDiffVouchers(fresh, existing, { closedUpto: '2026-06-30' });
ok('NEW → toPost', d.toPost.length === 1 && d.toPost[0].key === 'tNEW');
ok('UNCHANGED → skip', d.unchanged.length === 1 && d.unchanged[0].key === 'tSAME');
ok('CHANGED open → toReplace (cancel old + post)', d.toReplace.length === 1 && d.toReplace[0].oldId === 'v-open' && d.toReplace[0].fresh.key === 'tCHG_OPEN');
ok('CHANGED closed → closedBlocked (never auto-edit)', d.closedBlocked.length === 1 && d.closedBlocked[0].oldId === 'v-closed');
ok('ORPHAN (source gone) → orphans (alert)', d.orphans.length === 1 && d.orphans[0].id === 'v-orphan');

// no close date → everything open, nothing blocked
const d2 = acctDiffVouchers(fresh, existing, { closedUpto: null });
ok('null close date → changed-closed becomes a normal replace', d2.toReplace.length === 2 && d2.closedBlocked.length === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed  (worklist: new/changed/unchanged/closed/orphan)');
process.exit(fail ? 1 : 0);
