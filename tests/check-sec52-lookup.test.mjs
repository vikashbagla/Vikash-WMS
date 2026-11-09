// check-sec52-lookup.test.mjs — 52-week slider picks the right securities row (owner 2026-11-09).
// ESDS: an old inactive PRIVATE_EQUITY row (merged into the listed one, no 52-wk range) came first.
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const SHARED = fs.readFileSync(join(here, '..', 'wms-shared.js'), 'utf8');
let pass = 0, fail = 0;
function ok(n, c) { if (c) pass++; else { fail++; console.log('FAIL', n); } }
const sb = { window: {}, document: { addEventListener() {}, hidden: true }, console, Date, Math, JSON, Object, Array, String, Number, Boolean, parseInt, parseFloat, isNaN, isFinite, fetch: () => Promise.resolve({ ok: false }), setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}, SUPABASE_URL: '', SUPABASE_ANON_KEY: '' };
sb.globalThis = sb; vm.createContext(sb); vm.runInContext(SHARED, sb);
const pe = { id: 'pe', symbol: 'ESDS', security_type: 'PRIVATE_EQUITY', is_active: false, merged_into_id: 'eq', week_52_high: null, week_52_low: null };
const eq = { id: 'eq', symbol: 'ESDS', nse_symbol: 'ESDS', security_type: 'EQUITY', is_active: true, merged_into_id: null, week_52_high: '1859.20', week_52_low: '756.00' };
vm.runInContext('wmsRefData.securitiesCm = []; wmsRefData.securitiesCmMap = {};', sb);
sb.wmsRefData.securitiesCm = [pe, eq]; sb.wmsRefData.securitiesCmMap = { pe, eq };
ok('symbol only → listed row (skips retired PE row listed first)', sb.wmsSec52Lookup('ESDS', null).id === 'eq');
ok('exact security id wins', sb.wmsSec52Lookup('ESDS', 'eq').id === 'eq');
ok('merged id given → falls back to the live row', sb.wmsSec52Lookup('ESDS', 'pe').id === 'eq');
ok('unknown symbol → null', sb.wmsSec52Lookup('NOPE', null) === null);
console.log(`\n${pass} passed, ${fail} failed  (52-week slider: security lookup)`);
if (fail) process.exit(1);
