// scalp-roll-poke.test.mjs — the roll-window driver decision (spec v8). Run: node wms-live/scalp-roll-poke.test.mjs
import { decideRollPoke, hhmmToMin } from './scalp-poke.js';
let pass = 0, fail = 0;
const T = (n, f) => { try { f(); console.log('PASS  ' + n); pass++; } catch (e) { console.error('FAIL  ' + n + '\n      ' + e.message); fail++; } };
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); };

const PREOPEN = 510;   // 08:30 IST
const st = (o = {}) => ({ rollDate: '2026-09-30', advanceDue: true, rollMin: 750, lastAdvanceDate: null, lastRollPokeMs: 0, ...o });
const NOW = Date.UTC(2026, 8, 30, 5, 0, 0);

T('hhmmToMin', () => { eq(hhmmToMin('12:30'), 750); eq(hhmmToMin('08:30'), 510); eq(hhmmToMin('bad'), null); });

T('Event A: advanceDue + pre-open passed → ADVANCE (first morning of the window)', () => {
  const r = decideRollPoke(st({ rollDate: '2026-09-30' }), NOW, '2026-09-11', 511, PREOPEN);   // window opened, before roll_time/rollDate
  eq(r.advance, true); eq(r.set.lastAdvanceDate, '2026-09-11');
});
T('Event A: before pre-open minute → no advance', () => { eq(decideRollPoke(st(), NOW, '2026-09-11', 500, PREOPEN).advance, false); });
T('Event A: de-dupes on lastAdvanceDate (already advanced today)', () => {
  eq(decideRollPoke(st({ lastAdvanceDate: '2026-09-11' }), NOW, '2026-09-11', 520, PREOPEN).advance, false);
});
T('Event A: advanceDue false (already advanced, op far) → no advance ever again', () => {
  eq(decideRollPoke(st({ advanceDue: false }), NOW, '2026-09-11', 520, PREOPEN).advance, false);
});

T('Event B: on/after rollDate, at/after roll_time → ROLL nudge', () => {
  const r = decideRollPoke(st({ advanceDue: false }), NOW, '2026-09-30', 751, PREOPEN);
  eq(r.roll, true); eq(r.advance, false);
});
T('Event B: before rollDate → no roll nudge', () => {
  eq(decideRollPoke(st({ advanceDue: false }), NOW, '2026-09-24', 800, PREOPEN).roll, false);
});
T('Event B: before roll_time → no roll nudge', () => {
  eq(decideRollPoke(st({ advanceDue: false }), NOW, '2026-09-30', 700, PREOPEN).roll, false);
});
T('Event B: throttled within window', () => {
  eq(decideRollPoke(st({ advanceDue: false, lastRollPokeMs: NOW - 1000 }), NOW, '2026-09-30', 800, PREOPEN, 60000).roll, false);
});
T('Event B: fires again after the throttle elapses', () => {
  const r = decideRollPoke(st({ advanceDue: false, lastRollPokeMs: NOW - 70000 }), NOW, '2026-09-30', 800, PREOPEN, 60000);
  eq(r.roll, true); eq(r.set.lastRollPokeMs, NOW);
});
T('no rollDate (equity / pre-mig universe) → no roll nudge', () => {
  eq(decideRollPoke(st({ rollDate: null, advanceDue: false }), NOW, '2026-09-30', 800, PREOPEN).roll, false);
});
T('rollDate jumped forward (post-roll, holding new contract) → no nudge', () => {
  eq(decideRollPoke(st({ advanceDue: false, rollDate: '2026-10-11' }), NOW, '2026-09-30', 800, PREOPEN).roll, false);
});

console.log('\n  Passed: ' + pass + '\n  Failed: ' + fail);
if (fail) process.exit(1);
