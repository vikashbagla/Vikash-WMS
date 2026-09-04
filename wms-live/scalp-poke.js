// scalp-poke.js — the pure poke-decision for wms-scalp-ws (level-aware poking, mig 114 + 116).
// No dependencies + no side effects, so it is unit-tested directly (scalp-poke.test.mjs)
// while the driver stays untestable-in-prod. Given a symbol's cached state, the tick
// price, now, the first-entry cooldown, and whether we're in market hours, it returns
// { poke, why, set? } — `set` is the poke-state fields the caller merges onto the symbol.
export function decidePoke(st, price, now, cooldownMs, inHours) {
  if (!inHours) return { poke: false, why: 'out-of-hours' };
  // Legacy fallback (pre-mig-114 universe: no band) — poke on move, no heartbeat.
  if (!st.levelAware) {
    if (st.lastPokePrice == null || Math.abs(price - st.lastPokePrice) >= st.threshold)
      return { poke: true, why: 'legacy-move', set: { lastPokePrice: price } };
    return { poke: false, why: 'legacy-still' };
  }
  // TARGET-CROSS (mig 116) — PAPER exits only: the universe sends `target` for paper books
  // only, because paper has no resting order and is booked only when the engine is poked.
  // LIVE is never sent a target (its resting LIMIT fills at the broker and re-arms on the
  // confirmed fill, never on a price-cross). NOT band-gated — a take-profit can sit outside
  // the entry band. Long exits up (price >= target); short exits down (price <= target).
  // One poke per target level (de-duped on lastCrossTarget); the next rung's target re-arms it.
  if (st.target != null) {
    const hit = st.direction === 'short' ? price <= st.target : price >= st.target;
    if (hit && st.lastCrossTarget !== st.target)
      return { poke: true, why: 'target-cross', set: { lastCrossTarget: st.target } };
  }
  if (st.bandLo != null && price < st.bandLo) return { poke: false, why: 'below-band' };
  if (st.bandHi != null && price > st.bandHi) return { poke: false, why: 'above-band' };
  // FIRST-ENTRY: flat + in-band -> poke on the next tick, cooldown-throttled.
  if (st.firstEntry) {
    if (now - (st.lastFirstPokeMs || 0) >= cooldownMs)
      return { poke: true, why: 'first-entry', set: { lastFirstPokeMs: now } };
    return { poke: false, why: 'first-entry-cooldown' };
  }
  // ENTRY LEVEL-CROSS: poke once per armed level when price crosses from the actionable side.
  if (st.trigger == null) return { poke: false, why: 'no-trigger' };
  const crossed = st.direction === 'short' ? price >= st.trigger : price <= st.trigger;
  if (crossed && st.lastCrossTrigger !== st.trigger)
    return { poke: true, why: 'level-cross', set: { lastCrossTrigger: st.trigger } };
  return { poke: false, why: crossed ? 'already-poked-this-level' : 'not-crossed' };
}
