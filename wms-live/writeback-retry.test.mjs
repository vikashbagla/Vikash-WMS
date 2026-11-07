// writeback-retry.test.mjs — run: node wms-live/writeback-retry.test.mjs
import { sendWithRetry, isTransientWritebackError } from './writeback-retry.js';
let pass = 0, fail = 0;
const T = async (n, f) => { try { await f(); console.log('PASS  ' + n); pass++; } catch (e) { console.error('FAIL  ' + n + '\n      ' + e.message); fail++; } };
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); };
const httpErr = (s) => Object.assign(new Error('cmd-complete ' + s), { status: s });
const quiet = { warn() {}, log() {}, error() {} };
// A manual scheduler: collects timers; run them one by one.
function manual() { const q = []; return { q, schedule: (fn, ms) => q.push({ fn, ms }), async runAll() { while (q.length) await q.shift().fn(); } }; }

await T('transient = 5xx, 429, or no response; NOT 4xx', () => {
  eq(isTransientWritebackError(httpErr(503)), true); eq(isTransientWritebackError(httpErr(502)), true);
  eq(isTransientWritebackError(httpErr(500)), true); eq(isTransientWritebackError(httpErr(429)), true);
  eq(isTransientWritebackError(new TypeError('fetch failed')), true);
  eq(isTransientWritebackError(httpErr(400)), false); eq(isTransientWritebackError(httpErr(401)), false);
  eq(isTransientWritebackError(httpErr(404)), false);
});
await T('success first time: one call, nothing scheduled', async () => {
  let calls = 0; const m = manual();
  const r = await sendWithRetry(async () => { calls++; }, { schedule: m.schedule, log: quiet });
  eq(r.ok, true); eq(calls, 1); eq(m.q.length, 0);
});
await T('the first attempt is NOT delayed (called before any timer)', async () => {
  const order = []; const m = manual();
  await sendWithRetry(async () => { order.push('send'); }, { schedule: (f, ms) => { order.push('timer'); m.schedule(f, ms); }, log: quiet });
  eq(order[0], 'send'); eq(order.length, 1);
});
await T('503 then success: returns immediately, recovers in background on retry 1', async () => {
  let calls = 0, rec = 0; const m = manual();
  const r = await sendWithRetry(async () => { calls++; if (calls === 1) throw httpErr(503); },
    { schedule: m.schedule, log: quiet, onRecovered: (n) => { rec = n; } });
  eq(r.ok, false); eq(r.retrying, true); eq(calls, 1, 'caller not held');
  eq(m.q.length, 1); eq(m.q[0].ms, 2000);
  await m.runAll(); eq(calls, 2); eq(rec, 1);
});
await T('7-second outage (fails twice) recovers on retry 2', async () => {
  let calls = 0, rec = 0; const m = manual();
  await sendWithRetry(async () => { calls++; if (calls <= 2) throw httpErr(503); },
    { schedule: m.schedule, log: quiet, onRecovered: (n) => { rec = n; } });
  await m.runAll(); eq(calls, 3); eq(rec, 2);
});
await T('persistent 503: gives up after the last retry (1 + 4 calls), reports lost', async () => {
  let calls = 0, lost = 0; const m = manual();
  await sendWithRetry(async () => { calls++; throw httpErr(503); }, { schedule: m.schedule, log: quiet, onLost: () => { lost++; } });
  await m.runAll(); eq(calls, 5); eq(lost, 1);
});
await T('400 / 401 are never retried', async () => {
  for (const s of [400, 401]) {
    let calls = 0; const m = manual();
    const r = await sendWithRetry(async () => { calls++; throw httpErr(s); }, { schedule: m.schedule, log: quiet });
    eq(r.retrying, false); eq(calls, 1); eq(m.q.length, 0);
  }
});
await T('a retry that hits a 4xx stops there', async () => {
  let calls = 0, lost = 0; const m = manual();
  await sendWithRetry(async () => { calls++; throw httpErr(calls === 1 ? 503 : 400); }, { schedule: m.schedule, log: quiet, onLost: () => { lost++; } });
  await m.runAll(); eq(calls, 2); eq(lost, 1);
});
await T('delays are 2s, 5s, 10s, 20s', async () => {
  const ms = []; const m = manual();
  await sendWithRetry(async () => { throw httpErr(503); }, { schedule: (f, d) => { ms.push(d); m.schedule(f, d); }, log: quiet });
  await m.runAll(); eq(ms.join(','), '2000,5000,10000,20000');
});
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
