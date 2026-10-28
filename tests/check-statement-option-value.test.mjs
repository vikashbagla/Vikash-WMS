// check-statement-option-value.test.mjs — Statement Open Positions (owner 2026-10-28):
// an open OPTION is valued like a share (Value = Qty × CMP; short = negative), because
// the premium is real cash already in the statement balance. FUTURES keep Value = MTM.
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(join(here, '..', 'trading-ledger.js'), 'utf8');
const SHARED = fs.readFileSync(join(here, '..', 'wms-shared.js'), 'utf8');
let pass = 0, fail = 0;
function ok(n, c) { if (c) pass++; else { fail++; console.log('FAIL', n); } }
const sb = { window: {}, document: { addEventListener() {}, hidden: true }, console, Date, Math, JSON, Object, Array, String, Number, Boolean, parseInt, parseFloat, isNaN, isFinite, fetch: () => Promise.resolve({ ok: false }), setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}, SUPABASE_URL: '', SUPABASE_ANON_KEY: '' };
sb.globalThis = sb; vm.createContext(sb); vm.runInContext(SHARED, sb);
ok('LAURUSLABS 2280 CE contract is an option', sb.wmsIsOptionContract('LAURUSLABS26NOV2280CE', 'LAURUSLABS'));
ok('PE is an option', sb.wmsIsOptionContract('NIFTY26NOV22000PE', 'NIFTY'));
ok('future is not an option', !sb.wmsIsOptionContract('MANAPPURAM26NOVFUT', 'MANAPPURAM'));
// The valuation rule, as coded (same arithmetic in screen + export):
const val = (qty, avg, cmp) => ({ value: qty * cmp, mtm: (cmp - avg) * qty });
let r = val(50150, 21.18, 49.95);
ok('long option: value = qty × cmp (2,504,992.50)', Math.abs(r.value - 2504992.5) < 0.01);
ok('long option: MTM = (cmp − avg) × qty (1,442,815.50)', Math.abs(r.mtm - 1442815.5) < 0.01);
r = val(-100, 10, 8);
ok('short option: value negative (−800)', r.value === -800);
ok('short option: MTM +200 when premium falls', r.mtm === 200);
ok('screen: option branch before futures branch', /var isOpt = isNfo && wmsIsOptionContract\(key, shortSym\);[\s\S]{0,300}if \(isOpt\) \{\s*value = qty \* cmp;/.test(SRC));
ok('export: same rule', /var isOpt2 = isNfo && wmsIsOptionContract\(key, shortSym\);[\s\S]{0,200}if \(isOpt2\) \{\s*value = qty2 \* cmp;/.test(SRC));
ok('futures still Value = MTM', SRC.includes('value = mtm;           // FUTURES'));
console.log(`\n${pass} passed, ${fail} failed  (statement: open options valued at Qty × CMP)`);
if (fail) process.exit(1);
