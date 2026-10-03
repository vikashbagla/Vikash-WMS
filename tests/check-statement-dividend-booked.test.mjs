// check-statement-dividend-booked.test.mjs — Statements (trader + broker): a dividend
// counts as BOOKED P&L for the year, net of TDS, and so enters the Potential-Tax base
// (owner 2026-10-03, CALCULATIONS §E.15.19). Dividends only. Runs the REAL helpers lifted
// out of trading-ledger.js, on the real T2 KTKBANK rows
// (query: transactions where transaction_type='DIVIDEND' and trader = T2, FY 2026-27),
// and checks BOTH producers (on-screen summary + export) are wired to the helper.
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(join(here, '..', process.env.LEDGER_JS || 'trading-ledger.js'), 'utf8');
const SHARED = fs.readFileSync(join(here, '..', 'wms-shared.js'), 'utf8');

function extractFn(src, name) {
  const m = new RegExp('^function\\s+' + name + '\\s*\\(', 'm').exec(src);
  if (!m) return null;
  let i = src.indexOf('{', m.index), depth = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (depth === 0) break; } }
  return src.slice(m.index, j + 1);
}
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL', name); } }

const sb = { Math, parseFloat, reconDate: '' };
sb.lgAnchorReconDate = () => sb.reconDate;
vm.createContext(sb);
const need = ['lgDividendBookedEntries', 'lgBookedTypeLabel', 'lgSplitBookedGains'];
const got = {};
vm.runInContext(extractFn(SHARED, 'wmsSecTypeShortLabel'), sb);
const typeConst = /^var LG_BOOKED_DIVIDEND_TYPE = [^;]+;/m.exec(SRC);
if (typeConst) vm.runInContext(typeConst[0], sb);
for (const n of need) { const code = extractFn(SRC, n); got[n] = !!code; if (code) vm.runInContext(code, sb); }
ok('helpers exist in trading-ledger.js', need.every((n) => got[n]) && !!typeConst);
if (!got.lgDividendBookedEntries || !got.lgBookedTypeLabel) { console.log(`\n${pass} passed, ${fail + 1} failed  (statement dividend → booked P&L)`); process.exit(1); }

// ---- the real T2 rows (TDS on the TG row is 86,875 once restored; it was zeroed 03-Oct) ----
const cs = { id: 'cs', transaction_type: 'DIVIDEND', transaction_date: '2026-09-29', symbol: 'KTKBANK', short_symbol: 'KTKBANK', quantity: 42500, price: 5, net_amount: 212500, tds: 21250, investor_id: 'T0', trader_id: 'T2', broker_id: 'CS' };
const tg0 = { id: 'tg', transaction_type: 'DIVIDEND', transaction_date: '2026-09-29', symbol: 'KTKBANK', short_symbol: 'KTKBANK', quantity: 173750, price: 5, net_amount: 868750, tds: 0, investor_id: 'T0', trader_id: 'T2', broker_id: 'TG' };
const tg = Object.assign({}, tg0, { tds: 86875 });
const others = ['INTEREST', 'OTHER_INCOME', 'CAPITAL_REDUCTION', 'BUY', 'SELL', 'RIGHTS_PAYMENT', 'BONUS', 'HISTORICAL_PL']
  .map((ty, i) => ({ id: 'o' + i, transaction_type: ty, transaction_date: '2026-06-01', symbol: 'ABC', short_symbol: 'ABC', quantity: 10, net_amount: 1000, tds: 100 }));

const rowsIn = [cs, tg].concat(others);
const snapshot = JSON.stringify(rowsIn);
const out = sb.lgDividendBookedEntries(rowsIn);
ok('dividends only: 2 entries from 10 rows', out.length === 2);
ok('CS dividend: 191,250 net of TDS', out[0] && out[0].gain === 191250);
ok('TG dividend: 781,875 net of TDS', out[1] && out[1].gain === 781875);
ok('dated on the dividend date', out.every((g) => g.sellDate === '2026-09-29'));
ok('quantity = shares the dividend was paid on', out[0].qty === 42500 && out[1].qty === 173750);
ok('own row type DIVIDEND, labelled DIV', out.every((g) => g.securityType === 'DIVIDEND') && sb.lgBookedTypeLabel('DIVIDEND') === 'DIV');
ok('other labels unchanged (EQ / NFO / MCX)', sb.lgBookedTypeLabel('EQUITY') === 'EQ' && sb.lgBookedTypeLabel('NFO') === 'NFO' && sb.lgBookedTypeLabel('MCX') === 'MCX' && sb.lgBookedTypeLabel(undefined) === 'EQ');
ok('input rows are not modified', JSON.stringify(rowsIn) === snapshot);
ok('TDS zero → gross (the TG row as it stands today)', sb.lgDividendBookedEntries([tg0])[0].gain === 868750);
ok('stored negative amounts are read by magnitude', sb.lgDividendBookedEntries([Object.assign({}, cs, { net_amount: -212500, tds: -21250, quantity: -42500 })])[0].gain === 191250);
ok('zero-net dividend and undated dividend are skipped', sb.lgDividendBookedEntries([Object.assign({}, cs, { tds: 212500 }), Object.assign({}, cs, { transaction_date: null })]).length === 0);
ok('empty / missing input is safe', sb.lgDividendBookedEntries(null).length === 0 && sb.lgDividendBookedEntries([]).length === 0);

// ---- into the booked total + tax, exactly as both producers do ----
const engineGains = Object.freeze([Object.freeze({ shortSymbol: 'X', securityType: 'EQUITY', sellDate: '2026-08-31', qty: 1, gain: 8648620 })]);   // T2's FY booked P&L on screen before the change
const fyOf = (gs) => gs.filter((g) => g.sellDate >= '2026-04-01' && g.sellDate <= '2027-03-31');
const total = (gs) => Math.round(gs.reduce((a, g) => a + g.gain, 0) * 100) / 100;
let all = engineGains.concat(sb.lgDividendBookedEntries([cs, tg]));
ok('engine gains array is left untouched', engineGains.length === 1);
ok('T2 booked P&L: 8,648,620 + 973,125 = 9,621,745', total(fyOf(all)) === 9621745);
ok('T2 potential tax at 12.5% = 1,202,718.13', Math.round(Math.max(0, total(fyOf(all))) * 12.5) / 100 === 1202718.13);
all = engineGains.concat(sb.lgDividendBookedEntries([cs, tg0]));
ok('T2 today (TG TDS still zero): booked 9,708,620, tax 1,213,577.50', total(fyOf(all)) === 9708620 && Math.round(total(fyOf(all)) * 12.5) / 100 === 1213577.5);
ok('a dividend outside the FY is not in the FY base', total(fyOf(engineGains.concat(sb.lgDividendBookedEntries([Object.assign({}, cs, { transaction_date: '2026-03-30' })])))) === 8648620);

// ---- Starting / New split at a reconciliation uses the dividend date ----
all = engineGains.concat(sb.lgDividendBookedEntries([cs, tg]));
sb.reconDate = '2026-09-29';
let sp = sb.lgSplitBookedGains(fyOf(all), '2026-04-01', '2027-03-31');
ok('recon on the dividend date → dividend sits in Starting', sp.split && sp.newGains.length === 0 && sp.startingGain === 9621745 && sp.total === 9621745);
sb.reconDate = '2026-09-15';
sp = sb.lgSplitBookedGains(fyOf(all), '2026-04-01', '2027-03-31');
ok('recon before the dividend → dividend sits in New', sp.split && sp.newGains.length === 2 && sp.startingGain === 8648620 && sp.total === 9621745);
sb.reconDate = '';

// ---- wiring: BOTH producers use the helper, on a copy of the engine gains ----
ok('on-screen summary adds dividends', SRC.includes('var allGains = (fifo.gains || []).concat(lgDividendBookedEntries(sorted));'));
ok('export producer adds dividends', SRC.includes('var allGains = (fifo.gains || []).concat(lgDividendBookedEntries(sortedAll));'));
ok('no producer is left on the bare engine gains', !/var allGains = fifo\.gains \|\| \[\];/.test(SRC));
ok('both Booked P&L row builders use the DIV-aware label', (SRC.match(/lgBookedTypeLabel\(b\.securityType\)/g) || []).length === 2);
ok('Open Positions rows keep the shared label', (SRC.match(/wmsSecTypeShortLabel\(h\.securityType\)/g) || []).length === 2);

console.log(`\n${pass} passed, ${fail} failed  (statement dividend → booked P&L, net of TDS)`);
if (fail) process.exit(1);
