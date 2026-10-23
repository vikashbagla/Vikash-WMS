// check-interest-adjustment.test.mjs — Statement interest modal (owner 2026-10-23):
// manual adjustment line, total stays editable, breakup saved in ledger_entries.notes
// and shown AS SAVED when a posted entry is reopened (drift flagged, not silently replaced).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(join(here, '..', 'trading-ledger.js'), 'utf8');
const HTML = fs.readFileSync(join(here, '..', 'trading-ledger.html'), 'utf8');
let pass = 0, fail = 0;
function ok(n, c) { if (c) pass++; else { fail++; console.log('FAIL', n); } }
function extractFn(src, name) {
  const st = src.indexOf('function ' + name + '(');
  let i = src.indexOf('{', st), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) break; } }
  return src.slice(st, i + 1);
}
const parse = new Function(extractFn(SRC, 'lgParseInterestNotes') + '; return lgParseInterestNotes;')();
const saved = { period: '10 Oct to 16 Oct', closingBalance: 85382488.53, marginBalance: 0, baseBalance: 85382488.53, rate: 14.25, interest: 233980.86 };
ok('parses saved JSON record', parse(JSON.stringify(saved)).interest === 233980.86);
ok('old free-text notes → null (falls back to recalculation)', parse('weekly interest') === null && parse('') === null && parse(null) === null);
ok('JSON without interest → null', parse('{"a":1}') === null);
// notes-to-save: calc + manualAdj (= total − calculated) + reason
const doc = { getElementById: (id) => (id === 'lgInterestAdjNote' ? { value: ' rate concession ' } : null) };
const build = new Function('document', 'lgInterestCalcAmt', extractFn(SRC, 'lgInterestNotesToSave') + '; return lgInterestNotesToSave;');
const toSave = JSON.parse(build(doc, 233981)(saved, 233481));
ok('saves the calculation fields', toSave.period === saved.period && toSave.interest === saved.interest && toSave.rate === 14.25);
ok('saves manualAdj = total − calculated', toSave.manualAdj === -500);
ok('saves the reason, trimmed', toSave.manualAdjNote === 'rate concession');
ok('modal has adjustment amount + reason boxes', HTML.includes('id="lgInterestAdjAmt"') && HTML.includes('id="lgInterestAdjNote"'));
ok('total stays editable', HTML.includes('id="lgInterestTotalEdit"'));
ok('total box font matches modal (13px)', /id="lgInterestTotalEdit"[^>]*font-size:13px/.test(HTML));
ok('posted entry opens the SAVED breakup', SRC.includes('var saved = lgParseInterestNotes(entry.notes);'));
ok('commit saves adjustment with the calc', SRC.includes('lgInterestNotesToSave(pending._calc, amount)'));
ok('editing a posted entry rewrites notes with the adjustment', SRC.includes('notes: lgInterestNotesToSave(lgInterestCalcSaved, totalAmount)'));
console.log(`\n${pass} passed, ${fail} failed  (statement interest: manual adjustment + saved breakup)`);
if (fail) process.exit(1);
