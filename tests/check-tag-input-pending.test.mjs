// check-tag-input-pending.test.mjs — tag box (owner 20-Nov-2026):
// (1) text typed but not turned into a chip is still saved; (2) a real tag replaces 'blank';
// (3) a split's new row gets its search text so the Symbol search finds it.
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const SHARED = fs.readFileSync(join(here, '..', 'wms-shared.js'), 'utf8');
const MODAL = fs.readFileSync(join(here, '..', 'wms-txn-modal.js'), 'utf8');
let pass = 0, fail = 0;
function ok(n, c) { if (c) pass++; else { fail++; console.log('FAIL', n); } }
function el() { return { value: '', innerHTML: '', classList: { add() {}, remove() {}, contains() { return false; } }, addEventListener() {}, appendChild() {}, querySelectorAll() { return []; }, style: {} }; }
const doc = { addEventListener() {}, hidden: true, createElement: () => el() };
const sb = { window: {}, document: doc, console, Date, Math, JSON, Object, Array, String, Number, Boolean, parseInt, parseFloat, isNaN, isFinite, fetch: () => Promise.resolve({ ok: false }), setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}, SUPABASE_URL: '', SUPABASE_ANON_KEY: '' };
sb.globalThis = sb; vm.createContext(sb); vm.runInContext(SHARED, sb);
sb.wmsDropdown = () => ({ show() {}, destroy() {} });
vm.runInContext('wmsDropdown = globalThis.wmsDropdown;', sb);
let input = el(), c = sb.wmsTagInput(input, el(), el(), { tags: ['blank'], existingTags: ['AdvT1'] });
input.value = 'AdvT1';
let t = c.getTags();
ok('typed-but-not-chipped tag is saved', t.indexOf('AdvT1') >= 0);
ok("'blank' dropped once a real tag is added", t.indexOf('blank') < 0 && t.length === 1);
ok('box cleared after commit', input.value === '');
input = el(); c = sb.wmsTagInput(input, el(), el(), { tags: [], existingTags: [] });
input.value = 'a, b';
t = c.getTags();
ok('comma-separated pending text → two tags', t.length === 2 && t[0] === 'a' && t[1] === 'b');
input = el(); c = sb.wmsTagInput(input, el(), el(), { tags: ['X'], existingTags: [] });
ok('nothing typed → tags unchanged', c.getTags().length === 1);
ok('split inserts a processed row (search text)', /insertedTxn = wmsTxnProcessRow\(insertedTxn\)[\s\S]{0,400}wmsTxnCtx\.transactions\.push\(insertedTxn\)/.test(MODAL));
console.log(`\n${pass} passed, ${fail} failed  (tag box pending text + blank; split row search text)`);
if (fail) process.exit(1);
