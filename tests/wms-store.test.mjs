// =============================================================================
// wms-store.test — the app-wide data store core (ADR-001).
//   node tests/wms-store.test.mjs      # exit 1 on ANY failure
// =============================================================================
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const wmsStore = require(join(here, '..', 'wms-store.js'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- cache policy: load-once, token-gated reuse, delta on change --------------
let loads = 0, deltas = 0, token = 'A', notified = 0;
wmsStore.register('t', {
  policy: 'cache',
  loader: async () => { loads++; return { v: 'full' + loads }; },
  syncState: async () => ({ checksum: token }),
  deltaReconcile: async (st) => { deltas++; st.data = { v: 'delta' + deltas }; return true; },
});
const unsub = wmsStore.subscribe('t', () => { notified++; });

const a = await wmsStore.get('t');
ok(loads === 1 && a.v === 'full1', 'first get() loads once');
ok(notified === 1, 'subscribe fired on first load');
const b = await wmsStore.get('t');
ok(loads === 1 && b.v === 'full1', 'unchanged token → reuse, no reload');
ok(wmsStore.peek('t').v === 'full1', 'peek returns current copy synchronously');
token = 'B';
const c = await wmsStore.get('t');
ok(deltas === 1 && loads === 1 && c.v === 'delta1', 'changed token → deltaReconcile, no full reload');
ok(notified === 2, 'subscribe fired again on change');

wmsStore.register('t2', { policy: 'cache', loader: async () => ({ v: 'reload' }), syncState: async () => ({ checksum: Math.random().toString() }), deltaReconcile: async () => false });
await wmsStore.get('t2');
ok((await wmsStore.get('t2')).v === 'reload', 'deltaReconcile=false → full reload (self-heal)');

let t3loads = 0;
wmsStore.register('t3', { policy: 'cache', loader: async () => { t3loads++; return { v: t3loads }; }, syncState: async () => { if (t3loads >= 1) throw new Error('probe down'); return { checksum: 'x' }; } });
await wmsStore.get('t3'); await wmsStore.get('t3');
ok(t3loads === 2, 'syncState failure → full reload (no silent stale reuse)');

// ---- delegate ----------------------------------------------------------------
let dl = 0;
wmsStore.register('d', { policy: 'delegate', loader: async () => { dl++; return ['row' + dl]; }, peek: () => ['peeked'] });
await wmsStore.get('d'); await wmsStore.get('d');
ok(dl === 2, 'delegate get() calls loader each time');
ok(wmsStore.peek('d')[0] === 'peeked', 'delegate peek uses descriptor.peek');

// ---- concurrent de-dupe ------------------------------------------------------
let cl = 0;
wmsStore.register('c', { policy: 'cache', loader: async () => { cl++; await tick(); return { n: cl }; }, syncState: async () => ({ checksum: 'k' }) });
const [r1, r2] = await Promise.all([wmsStore.get('c'), wmsStore.get('c')]);
ok(cl === 1 && r1 === r2, 'concurrent get()s de-dupe to ONE load');

// ---- keyed datasets ----------------------------------------------------------
let kloads = {};
wmsStore.register('keyed', {
  policy: 'cache',
  keyBy: (pr) => (pr && pr.ids ? pr.ids.slice().sort().join(',') : ''),
  loader: async (pr) => { const k = (pr.ids || []).join(','); kloads[k] = (kloads[k] || 0) + 1; return { forKey: k }; },
  syncState: async () => ({ checksum: 'same' }),
});
const kA = await wmsStore.get('keyed', { ids: ['b1'] });
const kB = await wmsStore.get('keyed', { ids: ['b2'] });
await wmsStore.get('keyed', { ids: ['b1'] });
ok(kA.forKey === 'b1' && kB.forKey === 'b2', 'keyed datasets cache per key');
ok(kloads['b1'] === 1 && kloads['b2'] === 1, 'each key loads once; re-get reuses');

// ---- wmsStoreVerify: catches cache-vs-DB drift ------------------------------
wmsStore.register('vp', { policy: 'cache', loader: async () => [1, 2, 3], syncState: async () => ({ checksum: 'z' }) });
await wmsStore.get('vp');
let vr = await wmsStore.verify();
let vpLine = vr.find((x) => x.dataset === 'vp');
ok(vpLine && vpLine.ok, 'verify(): cached copy matches a fresh DB fetch → PASS');
wmsStore._state['vp'].data = [1, 2, 999];          // simulate a corrupted/stale cache
vr = await wmsStore.verify();
vpLine = vr.find((x) => x.dataset === 'vp');
ok(vpLine && !vpLine.ok, 'verify(): drift from the DB is detected → FAIL');

wmsStore.invalidate('t');
ok(wmsStore._state['t'] === undefined, 'invalidate() drops the cached state');

unsub();
if (fail) { console.error(`\n❌ wms-store: ${fail} failed, ${pass} passed`); process.exit(1); }
console.log(`✅ wms-store: ${pass} assertions passed`);
