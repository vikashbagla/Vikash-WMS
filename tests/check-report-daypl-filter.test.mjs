// check-report-daypl-filter.test.mjs — Reports Portfolio Day P&L must use only the
// filtered investor's trades (owner 2026-11-18, LLOYDSENT on the MB view showed
// the whole firm's 725k shares × day change instead of MB's 7,500 bought today).
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const SHARED = fs.readFileSync(join(here, '..', 'wms-shared.js'), 'utf8');
const RPT = fs.readFileSync(join(here, '..', 'reports.js'), 'utf8');
let pass = 0, fail = 0;
function ok(n, c) { if (c) pass++; else { fail++; console.log('FAIL', n); } }
const sb = { window: {}, document: { addEventListener() {}, hidden: true }, console, Date, Math, JSON, Object, Array, String, Number, Boolean, parseInt, parseFloat, isNaN, isFinite, fetch: () => Promise.resolve({ ok: false }), setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}, SUPABASE_URL: '', SUPABASE_ANON_KEY: '' };
sb.globalThis = sb; vm.createContext(sb); vm.runInContext(SHARED, sb);
// Pull just rptFifoEngine + rptGetAssetClass out of reports.js
function grab(name) { const i = RPT.indexOf('function ' + name + '('); let d = 0, j = RPT.indexOf('{', i); for (; j < RPT.length; j++) { if (RPT[j] === '{') d++; else if (RPT[j] === '}' && --d === 0) break; } return RPT.slice(i, j + 1); }
vm.runInContext('var rptTransactions = [];\n' + grab('rptGetAssetClass') + '\n' + grab('rptFifoEngine'), sb);
const today = new Date().toISOString().slice(0, 10);
const mk = (inv, date, qty, price) => ({ investorId: inv, investor_id: inv, date, transaction_date: date, type: 'BUY', transaction_type: 'BUY', quantity: qty, price, netAmount: qty * price, net_amount: qty * price, symbol: 'LLOYDSENT', shortSymbol: 'LLOYDSENT', short_symbol: 'LLOYDSENT', exchange: 'NSE', securityType: 'EQUITY', security_type: 'EQUITY' });
const all = [mk('OTHER', '2026-10-01', 725025, 70), mk('MB', today, 7500, 64)];
sb.rptTransactions = all;
vm.runInContext('rptTransactions = globalThis.rptTransactions;', sb);
const mbOnly = all.filter(t => t.investorId === 'MB');
const h = sb.rptFifoEngine(mbOnly).holdings['LLOYDSENT'];
ok('holding qty is MB only', h && h.quantity === 7500);
ok('_txns holds only the filtered trades', h && h._txns.length === 1);
const dp = sb.wmsCalcStockDayPL(h._txns, { lp: 63.94, ch: -1.85 }, today, { includeNfo: false });
ok('Day P&L = 7,500 × (63.94 − 64) = −450', Math.abs(dp + 450) < 0.01);
console.log(`\n${pass} passed, ${fail} failed  (Reports Day P&L uses filtered trades)`);
if (fail) process.exit(1);
