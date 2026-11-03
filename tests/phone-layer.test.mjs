// =============================================================================
// phone-layer.test — guards the PHONE LAYER structure (Phone Layer Plan v1,
// UI-STANDARDS §D.13.2). Fails when:
//   1. a phone (max-width:480px) @media block appears in a DESKTOP file again;
//   2. a phone function (anything defined in an m-*.js file, or any *Mobile*
//      function) is defined in a desktop JS file;
//   3. a desktop file calls a phone-layer function WITHOUT a typeof guard
//      (desktop never loads m-*.js, so an unguarded call would throw there);
//   4. app.html loads an m- file outside the `if (window.WMS_PHONE)` gate;
//   5. a NEW calculation line appears in an m-*.js file. Phone code must only
//      show numbers produced by the shared helpers. The 8 calculation lines that
//      pre-date the phone layer (June-2026 phone lists, moved verbatim) are
//      allow-listed below until they are moved into shared helpers.
//   node tests/phone-layer.test.mjs        (exit 1 on any failure)
// =============================================================================
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
// (5) pre-existing calc lines: see ALLOWED_CALC below
const ok = (cond, msg) => { if (!cond) fails.push(msg); };
const read = f => readFileSync(join(ROOT, f), 'utf8');
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const all = readdirSync(ROOT).filter(f => /\.(js|html|css)$/.test(f));
const phoneFiles = all.filter(f => f.startsWith('m-'));
// index.html = the separate login page (own tiny phone rule, outside the app shell)
const desktopFiles = all.filter(f => !f.startsWith('m-') && f !== 'index.html');
ok(phoneFiles.includes('m-styles.css') && phoneFiles.includes('m-trading.js'), 'phone layer files m-styles.css + m-trading.js must exist');

// 1. no phone media blocks in desktop files (a min-width range such as 481–768 is tablet, allowed)
for (const f of desktopFiles) {
  const s = stripComments(read(f));
  for (const m of s.matchAll(/@media[^{]*\{/g)) {
    const q = m[0];
    if (/max-width:\s*480px/.test(q) && !/min-width/.test(q)) fails.push(`1. ${f}: phone @media block "${q.trim()}" — move it to m-styles.css`);
  }
}

// 2 + 3. phone functions live only in m-*.js; desktop calls are typeof-guarded
const phoneFns = new Set();
for (const f of phoneFiles.filter(f => f.endsWith('.js'))) {
  for (const m of read(f).matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)) phoneFns.add(m[1]);
}
ok(phoneFns.has('trRenderPortfolioMobile') && phoneFns.has('trFnoRenderMobile') && phoneFns.has('wmsPhoneLanding'), 'm-trading.js must define trRenderPortfolioMobile, trFnoRenderMobile, wmsPhoneLanding');
for (const f of desktopFiles.filter(f => /\.(js|html)$/.test(f))) {
  const src = read(f);
  for (const m of src.matchAll(/^\s*function\s+([A-Za-z0-9_$]+)\s*\(/gm)) {
    if (phoneFns.has(m[1])) fails.push(`2. ${f}: defines phone function ${m[1]}() — it belongs in m-*.js`);
    else if (/Mobile/.test(m[1])) fails.push(`2. ${f}: defines ${m[1]}() — phone functions belong in m-*.js`);
  }
  const lines = src.split('\n');
  lines.forEach((ln, i) => {
    const code = ln.replace(/\/\/.*$/, '');
    if (/^\s*(\*|<!--)/.test(ln)) return;
    for (const fn of phoneFns) {
      if (!new RegExp('\\b' + fn + '\\s*\\(').test(code)) continue;
      if (!new RegExp("typeof\\s+" + fn + "\\s*===\\s*'function'").test(code))
        fails.push(`3. ${f}:${i + 1}: unguarded call to phone function ${fn}() — use: if (typeof ${fn} === 'function') ${fn}(...)`);
    }
  });
}

// 4. app.html loads m- files only behind the WMS_PHONE gate
{
  const s = read('app.html');
  const gate = s.indexOf('if (window.WMS_PHONE) {');
  ok(gate !== -1, '4. app.html: missing the `if (window.WMS_PHONE) {` loader gate');
  const gateEnd = s.indexOf('\n    }\n', gate);   // the gate block's own closing brace line
  for (const m of s.matchAll(/m-[a-z-]+\.(js|css)/g)) {
    if (m.index < gate || m.index > gateEnd) {
      const lineStart = s.lastIndexOf('\n', m.index) + 1, line = s.slice(lineStart, s.indexOf('\n', m.index));
      if (!/^\s*\/\/|^\s*\/\*|^\s*\*/.test(line) && !/<!--/.test(line)) fails.push(`4. app.html: m- file referenced outside the WMS_PHONE gate: ${line.trim().slice(0, 100)}`);
    }
  }
  ok(/WMS_PHONE\s*=\s*\(function\s*\(\)\s*\{\s*try\s*\{[^}]*\}?[^}]*return Math\.min\(screen\.width,\s*screen\.height\)\s*<=\s*480/.test(s), '4. app.html: WMS_PHONE must be decided by the smaller screen side <= 480');
}

// 5. no NEW calculation lines in phone JS
// 2026-11-03: the 8 pre-existing calc lines were moved into shared helpers (trFnoTotals /
// trFnoSymbolNums / trFnoGroupNums / trFnoPctOfExposure in trading-fno.js, pctOfStock in
// trInvestorBreakdown). Nothing is allow-listed any more — keep it that way.
const ALLOWED_CALC = new Set([]);
const CALC = /\+=|-=|\*=|\/=|\.reduce\(|[\w)\]]\s[\/*]\s[\w(]/;
// money addition/subtraction between two money-named values, e.g. `a.totalRealisedPnl + a.totalUnrealisedPnl`
const MONEY_ADD = /\b[A-Za-z_$.]*(?:pnl|Pnl|PnL|PNL|cost|Cost|exp|Exp|real|Real|Unreal|unreal|invested|Invested|value|Value|amt|Amt|qty|Qty)[A-Za-z_$.]*\s*[+-]\s*[A-Za-z_$.]*(?:pnl|Pnl|PnL|PNL|cost|Cost|exp|Exp|real|Real|Unreal|unreal|invested|Invested|value|Value|amt|Amt|qty|Qty)[A-Za-z_$]*\b(?!\s*\()/;
for (const f of phoneFiles.filter(f => f.endsWith('.js'))) {
  read(f).split('\n').forEach((ln, i) => {
    const t = ln.trim(); if (!t || t.startsWith('//') || t.startsWith('*')) return;
    const code = t.replace(/\/\/.*$/, '').replace(/'[^']*'/g, "''");
    if (/^dd\.style\./.test(code)) return;   // screen positioning, not money
    if ((CALC.test(code) || MONEY_ADD.test(code)) && !ALLOWED_CALC.has(t)) fails.push(`5. ${f}:${i + 1}: calculation in phone code — move it to a shared helper the desktop also uses: ${t.slice(0, 110)}`);
  });
}

if (fails.length) { console.error('phone-layer: ' + fails.length + ' FAILURE(S)\n  ' + fails.join('\n  ')); process.exit(1); }
console.log(`phone-layer: OK — ${phoneFiles.length} phone files, ${phoneFns.size} phone functions, ${desktopFiles.length} desktop files clean, no calculations in phone files`);
