// =============================================================================
// accounting-ef-parity.test — proves the FROZEN engine runs server-side (Node /
// Deno) with the REAL FIFO, producing the same vouchers as the browser. This is
// the Phase-2 offline gate: the Edge Function will run this exact stack.
//
// It does NOT re-implement anything. It loads:
//   - the real wmsCalcFifoCost (+ wmsRoundMoney) from wms-shared.js, via a vm
//     sandbox (the run-cost-engine-tests.js pattern) — the same FIFO the browser
//     and Statements use;
//   - the frozen accounting-engine.js (+ wms-cost-engine.js) via require;
// then runs acctEngineProcess with ctx.fifo = the real wmsCalcFifoCost and
// asserts the FIFO-derived gains post correctly and every voucher balances.
//   node tests/accounting-ef-parity.test.mjs      (exit 1 on any failure)
// =============================================================================
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import vm from 'vm';
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

// ---- load the REAL FIFO from wms-shared.js in a sandbox (no rewrite) ----
const sandbox = {
  SUPABASE_URL: '', SUPABASE_ANON_KEY: '', window: {}, document: { addEventListener() {}, hidden: true },
  console, Date, Math, JSON, Object, Array, String, Number, Boolean,
  parseInt, parseFloat, isNaN, isFinite, fetch: () => Promise.resolve({ ok: false }),
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'wms-shared.js'), 'utf8'), sandbox, { filename: 'wms-shared.js' });
const wmsCalcFifoCost = sandbox.wmsCalcFifoCost;

// ---- load the FROZEN engine (unchanged) ----
const { acctEngineProcess, voucherBalances } = require(join(ROOT, 'accounting-engine.js'));

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL', name); } }
ok('real wmsCalcFifoCost extracted from wms-shared.js', typeof wmsCalcFifoCost === 'function');

const ctx = {
  securityById: { EQ1: { security_type: 'EQUITY', symbol: 'ABC', capital_gains: { stcg: 'CG_ST_STT', ltcg: 'CG_LT_STT', lt_months: 12 }, income_ledgers: {} } },
  investorById: { B0: { stt_accounting_method: false } },
  brokerById: {},
  fifo: wmsCalcFifoCost           // the REAL engine, not a stub
};

// A real own-book round-trip: buy 100 @ 100 (net 10000), buy 100 @ 110 (11000),
// sell 150 @ 130 (19500). FIFO cost of 150 = 100*100 + 50*110 = 15500 → gain 4000.
const S = { symbol: 'ABC', short_symbol: 'ABC', security_type: 'EQUITY' };   // fields the real FIFO groups on
const trades = [
  { id: 'b1', investor_id: 'B0', security_id: 'EQ1', broker_id: 'BRK1', transaction_type: 'BUY',  quantity: 100,  price: 100, net_amount: 10000, transaction_date: '2026-04-01', ...S },
  { id: 'b2', investor_id: 'B0', security_id: 'EQ1', broker_id: 'BRK1', transaction_type: 'BUY',  quantity: 100,  price: 110, net_amount: 11000, transaction_date: '2026-04-05', ...S },
  { id: 's1', investor_id: 'B0', security_id: 'EQ1', broker_id: 'BRK1', transaction_type: 'SELL', quantity: -150, price: 130, net_amount: 19500, transaction_date: '2026-06-01', ...S }
];
const res = acctEngineProcess({ id: 'B0', post_fno: false }, trades, ctx);

const sell = res.vouchers.find(v => v.txnId === 's1');
ok('sell voucher produced by the real-FIFO stack', !!sell);
ok('every voucher balances (real FIFO)', res.vouchers.length > 0 && res.vouchers.every(v => voucherBalances(v.lines)));
// FIFO gain 4000 → STCG(STT) credit 4000; cost 15500 credited to the security
const cg = sell && sell.lines.find(l => l.ref.role === 'CG_ST_STT');
ok('real FIFO gain = 4000 posted to CG_ST_STT', !!cg && Math.round((cg.credit || 0)) === 4000);
const cost = sell && sell.lines.find(l => l.ref.security_id === 'EQ1');
ok('real FIFO cost = 15500 credited to Investment', !!cost && Math.round((cost.credit || 0)) === 15500);
const brk = sell && sell.lines.find(l => l.ref.broker_id === 'BRK1');
ok('proceeds 19500 debited to Broker', !!brk && Math.round((brk.debit || 0)) === 19500);
ok('no critical exceptions', !res.exceptions.some(e => e.severity === 'critical'));

console.log('\n' + pass + ' passed, ' + fail + ' failed  (frozen engine + REAL FIFO, server-side)');
process.exit(fail ? 1 : 0);
