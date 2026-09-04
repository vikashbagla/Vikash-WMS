// scalp-poke.test.mjs — the level-aware poke decision (mig 114). Run: node wms-live/scalp-poke.test.mjs
import { decidePoke } from './scalp-poke.js';
let pass=0, fail=0;
const T=(n,f)=>{ try{ f(); console.log('PASS  '+n); pass++; }catch(e){ console.error('FAIL  '+n+'\n      '+e.message); fail++; } };
const eq=(a,b,m)=>{ if(a!==b) throw new Error((m||'')+' expected '+JSON.stringify(b)+' got '+JSON.stringify(a)); };
const CD=3000, HRS=true;
const longSt=(o={})=>({ levelAware:true, direction:'long', bandLo:300, bandHi:360, trigger:340, firstEntry:false, lastCrossTrigger:null, lastFirstPokeMs:0, threshold:1, lastPokePrice:null, ...o });
const shortSt=(o={})=>longSt({ direction:'short', bandLo:22000, bandHi:25000, trigger:24000, ...o });

T('out-of-hours never pokes', ()=>{ eq(decidePoke(longSt(), 340, 1e6, CD, false).poke, false); });

T('long: price ABOVE trigger does not poke', ()=>{ eq(decidePoke(longSt({trigger:340}), 342, 1e6, CD, HRS).poke, false); });
T('long: price crosses DOWN to trigger -> poke (level-cross)', ()=>{ const d=decidePoke(longSt({trigger:340}), 340, 1e6, CD, HRS); eq(d.poke,true); eq(d.why,'level-cross'); eq(d.set.lastCrossTrigger,340); });
T('long: de-dupe — same trigger already poked -> no poke', ()=>{ eq(decidePoke(longSt({trigger:340,lastCrossTrigger:340}), 339, 1e6, CD, HRS).poke, false); });
T('long: trigger moved (new level) -> pokes again on cross', ()=>{ const d=decidePoke(longSt({trigger:338,lastCrossTrigger:340}), 338, 1e6, CD, HRS); eq(d.poke,true); eq(d.set.lastCrossTrigger,338); });

T('short: price crosses UP to trigger -> poke', ()=>{ const d=decidePoke(shortSt({trigger:24000}), 24000, 1e6, CD, HRS); eq(d.poke,true); eq(d.why,'level-cross'); });
T('short: price below trigger -> no poke', ()=>{ eq(decidePoke(shortSt({trigger:24000}), 23950, 1e6, CD, HRS).poke, false); });

// --- TARGET-CROSS (mig 116): paper exit poke; opposite side to entry; NOT band-gated ---
T('long target: price crosses UP to target -> poke', ()=>{ const d=decidePoke(longSt({target:350,trigger:340}), 350, 1e6, CD, HRS); eq(d.poke,true); eq(d.why,'target-cross'); eq(d.set.lastCrossTarget,350); });
T('long target: de-dupe same target -> no poke', ()=>{ eq(decidePoke(longSt({target:350,lastCrossTarget:350,trigger:340}), 351, 1e6, CD, HRS).poke, false); });
T('long target: next rung target -> pokes again', ()=>{ const d=decidePoke(longSt({target:352,lastCrossTarget:350,trigger:340}), 352, 1e6, CD, HRS); eq(d.poke,true); eq(d.set.lastCrossTarget,352); });
T('short target: price crosses DOWN to target -> poke', ()=>{ const d=decidePoke(shortSt({target:23900,trigger:24000}), 23900, 1e6, CD, HRS); eq(d.poke,true); eq(d.why,'target-cross'); });
T('target poke fires ABOVE band (not band-gated)', ()=>{ const d=decidePoke(longSt({target:350,trigger:340}), 365, 1e6, CD, HRS); eq(d.poke,true); eq(d.why,'target-cross'); });
T('target below current for a long -> no target poke (falls through)', ()=>{ const d=decidePoke(longSt({target:350,trigger:340}), 345, 1e6, CD, HRS); eq(d.why!=='target-cross', true); });
T('no target set -> entry logic unaffected', ()=>{ const d=decidePoke(longSt({trigger:340}), 340, 1e6, CD, HRS); eq(d.why,'level-cross'); });

T('band gate: below band -> no poke', ()=>{ eq(decidePoke(longSt({trigger:340}), 299, 1e6, CD, HRS).poke, false); });
T('band gate: above band -> no poke', ()=>{ eq(decidePoke(longSt({trigger:340}), 361, 1e6, CD, HRS).poke, false); });

T('first-entry: pokes on an in-band tick', ()=>{ const d=decidePoke(longSt({firstEntry:true,trigger:null}), 330, 1e6, CD, HRS); eq(d.poke,true); eq(d.why,'first-entry'); eq(d.set.lastFirstPokeMs,1e6); });
T('first-entry: cooldown suppresses a rapid repeat', ()=>{ eq(decidePoke(longSt({firstEntry:true,trigger:null,lastFirstPokeMs:1e6-1000}), 330, 1e6, CD, HRS).poke, false); });
T('first-entry: pokes again after the cooldown', ()=>{ eq(decidePoke(longSt({firstEntry:true,trigger:null,lastFirstPokeMs:1e6-4000}), 330, 1e6, CD, HRS).poke, true); });

T('no trigger + not first-entry -> no poke', ()=>{ eq(decidePoke(longSt({trigger:null}), 330, 1e6, CD, HRS).poke, false); });

T('legacy (no band): pokes on a move >= threshold', ()=>{ const d=decidePoke({levelAware:false,threshold:5,lastPokePrice:100}, 106, 1e6, CD, HRS); eq(d.poke,true); eq(d.why,'legacy-move'); eq(d.set.lastPokePrice,106); });
T('legacy: no poke on a small move', ()=>{ eq(decidePoke({levelAware:false,threshold:5,lastPokePrice:100}, 102, 1e6, CD, HRS).poke, false); });

console.log('\n  Passed: '+pass+'\n  Failed: '+fail);
if (fail) process.exit(1);
