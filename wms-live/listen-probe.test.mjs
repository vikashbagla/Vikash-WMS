// listen-probe.test.mjs — the LISTEN-PROBE dead-line check (26-Nov-2026).
// 1. The block is byte-identical in the three Droplet programs.
// 2. Behaviour, on a fake connection: echo heard = ok; no echo / failing NOTIFY =
//    onDead exactly once; stop() silences it.
// Run: node --test wms-live/listen-probe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

const here = new URL('.', import.meta.url);
const files = ['index.js', 'wms-mosl.js', 'wms-scalp-ws.js'];
const BEGIN = '// ── LISTEN-PROBE BEGIN';
const END = '// ── LISTEN-PROBE END ──';
const blocks = files.map((f) => {
  const s = readFileSync(new URL(f, here), 'utf8');
  const a = s.indexOf(BEGIN), b = s.indexOf(END);
  assert.ok(a >= 0 && b > a, `${f}: LISTEN-PROBE block missing`);
  assert.equal(s.indexOf(BEGIN, a + 1), -1, `${f}: block appears twice`);
  return s.slice(a, b + END.length);
});

test('block is identical in all three programs', () => {
  assert.equal(blocks[1], blocks[0], 'wms-mosl.js differs from index.js');
  assert.equal(blocks[2], blocks[0], 'wms-scalp-ws.js differs from index.js');
});

test('each program listens on its own probe channel and arms the probe', () => {
  const want = { 'index.js': 'wms_probe_live', 'wms-mosl.js': 'wms_probe_mosl', 'wms-scalp-ws.js': 'wms_probe_scalp' };
  for (const f of files) {
    const s = readFileSync(new URL(f, here), 'utf8');
    assert.ok(s.includes(`const PROBE_CHANNEL = '${want[f]}'`), `${f}: channel`);
    assert.ok(s.includes('LISTEN ${PROBE_CHANNEL}'), `${f}: LISTEN probe channel`);
    assert.ok(/armListenProbe\(/.test(s.slice(s.indexOf(END))), `${f}: probe armed`);
  }
});

const armListenProbe = new Function(`${blocks[0]}\nreturn armListenProbe;`)();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake pg client: NOTIFY on a channel we listen to echoes back (healthy line)
// unless `deaf` (the 25-Nov state: connection open, LISTEN gone) or `broken`.
function fakeClient({ deaf = false, broken = false } = {}) {
  const c = new EventEmitter();
  c.sent = [];
  c.query = async (sql) => {
    c.sent.push(sql);
    if (broken) throw new Error('Connection terminated unexpectedly');
    const m = /^NOTIFY (\w+), '([\w]+)'$/.exec(sql);
    assert.ok(m, `unexpected statement ${sql}`);
    if (!deaf) setTimeout(() => c.emit('notification', { channel: m[1], payload: m[2] }), 5);
  };
  return c;
}

test('healthy line: echo heard, never declared dead', async () => {
  const c = fakeClient();
  let dead = 0;
  const p = armListenProbe(c, 'wms_probe_test', () => dead++, { everyMs: 30, waitMs: 60 });
  p.tick();
  await wait(200);
  p.stop();
  assert.equal(dead, 0);
  assert.ok(p.state.okAt, 'okAt set');
  assert.ok(p.state.checks >= 3, `checks ${p.state.checks}`);
});

test('deaf line (25-Nov case): onDead once, after the wait', async () => {
  const c = fakeClient({ deaf: true });
  const why = [];
  const p = armListenProbe(c, 'wms_probe_test', (r) => why.push(r), { everyMs: 20, waitMs: 50 });
  p.tick();
  await wait(30);
  assert.equal(why.length, 0, 'not before the wait');
  await wait(200);
  assert.equal(why.length, 1, 'exactly once');
  assert.match(why[0], /no echo/);
  assert.equal(p.state.dead, true);
  assert.equal(c.listenerCount('notification'), 0, 'listener removed');
});

test('broken line: NOTIFY fails, onDead once', async () => {
  const c = fakeClient({ broken: true });
  const why = [];
  const p = armListenProbe(c, 'wms_probe_test', (r) => why.push(r), { everyMs: 20, waitMs: 500 });
  p.tick();
  await wait(100);
  assert.equal(why.length, 1);
  assert.match(why[0], /probe failed: Connection terminated/);
});

test('someone else\'s payload or channel does not count as an echo', async () => {
  const c = fakeClient({ deaf: true });
  const why = [];
  const p = armListenProbe(c, 'wms_probe_test', (r) => why.push(r), { everyMs: 1000, waitMs: 60 });
  p.tick();
  c.emit('notification', { channel: 'wms_probe_test', payload: 'someone-else' });
  c.emit('notification', { channel: 'other', payload: 'x' });
  await wait(120);
  assert.equal(why.length, 1);
  assert.equal(p.state.okAt, null);
});

test('stop() silences a pending check', async () => {
  const c = fakeClient({ deaf: true });
  let dead = 0;
  const p = armListenProbe(c, 'wms_probe_test', () => dead++, { everyMs: 20, waitMs: 40 });
  p.tick();
  p.stop();
  await wait(120);
  assert.equal(dead, 0);
});
