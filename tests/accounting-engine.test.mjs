import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { acctBuildVoucher, acctEngineProcess, demergerVouchers, acctFnoRealised, acctStatementVoucher, voucherBalances } = require(join(here, '..', 'accounting-engine.js'));

let pass=0, fail=0;
function ok(name, cond){ if(cond){pass++;} else {fail++; console.log('FAIL', name);} }
function amt(v, p){ var l=v.lines.find(l=>p(l.ref)); return l ? (l.debit||0)-(l.credit||0) : null; } // +dr/-cr

const ctx = {
  securityById: {
    SEC1:{security_type:'EQUITY', symbol:'ABC', capital_gains:{stcg:'CG_ST_STT',ltcg:'CG_LT',lt_months:12}, income_ledgers:{DIVIDEND:'INC_DIVIDEND', INTEREST:'INC_INT_BONDS'}},
    FUT1:{security_type:'NFO', symbol:'NIFTYF', capital_gains:{}, income_ledgers:{}}
  },
  investorById: { INV1:{stt_accounting_method:true}, INV2:{stt_accounting_method:false}, T0:{stt_accounting_method:false}, T1:{book_parent_id:'T0'}, T2:{book_parent_id:'T0'}, T3a:{book_parent_id:'T0'} },
  brokerById: {}
};
const own = o => Object.assign({investor_id:'INV1', security_id:'SEC1', broker_id:'BRK1', quantity:100}, o);
const cli = o => Object.assign({investor_id:'T0', trader_id:'T1', security_id:'SEC1', broker_id:'BRK1', quantity:100}, o);

// BUY / SELL own (re-check)
ok('buy own balances', voucherBalances(acctBuildVoucher(own({transaction_type:'BUY',net_amount:10040,stt:10}), ctx, []).lines));
let v = acctBuildVoucher(own({transaction_type:'SELL',net_amount:14945,stt:15,quantity:-100}), ctx, [{qty:100,buyCost:10030,gain:4930,buyDate:'2025-01-01',sellDate:'2025-06-01',securityType:'EQUITY'}]);
ok('sell own CG_ST_STT credit 4930', amt(v, r=>r.role==='CG_ST_STT')===-4930 && voucherBalances(v.lines));

// Income own (dividend + TDS). The income module stores net_amount = GROSS (qty × price)
// and tds separately, so gross=1000 tds=100 -> settlement (net cash) = 900.
v = acctBuildVoucher(own({transaction_type:'DIVIDEND', net_amount:1000, tds:100}), ctx, []);
ok('div balances', voucherBalances(v.lines));
ok('div income Cr 1000 (gross = net_amount)', amt(v, r=>r.role==='INC_DIVIDEND')===-1000);
ok('div TDS Dr 100', amt(v, r=>r.role==='TDS_YIELD')===100);
ok('div settlement Dr 900 (gross − tds)', amt(v, r=>r.role==='PMS_SETTLEMENT')===900);
// Interest -> mapped INC_INT_BONDS
v = acctBuildVoucher(own({transaction_type:'INTEREST', net_amount:500, tds:0}), ctx, []);
ok('interest uses income_ledgers.INTEREST', amt(v, r=>r.role==='INC_INT_BONDS')===-500);

// Cap reduction / rights
v = acctBuildVoucher(own({transaction_type:'CAPITAL_REDUCTION', net_amount:500}), ctx, []);
ok('capred balances', voucherBalances(v.lines) && amt(v, r=>r.role==='PMS_SETTLEMENT')===500 && amt(v, r=>r.security_id==='SEC1')===-500);
v = acctBuildVoucher(own({transaction_type:'RIGHTS_PAYMENT', net_amount:2000}), ctx, []);
ok('rights balances', voucherBalances(v.lines) && amt(v, r=>r.security_id==='SEC1')===2000);

// Client BUY / SELL (spread)
v = acctBuildVoucher(cli({transaction_type:'BUY', net_amount:10040, total_charges:40, trader_charges:50}), ctx, []);
ok('client buy balances', voucherBalances(v.lines));
ok('client buy Client Dr 10050', amt(v, r=>r.investor_id==='T1')===10050);
ok('client buy Broker Cr 10040', amt(v, r=>r.broker_id==='BRK1')===-10040);
ok('client buy Trader Income Cr 10', amt(v, r=>r.role==='TRADER_INCOME')===-10);
v = acctBuildVoucher(cli({transaction_type:'SELL', net_amount:14945, total_charges:40, trader_charges:50, quantity:-100}), ctx, []);
ok('client sell balances', voucherBalances(v.lines));
ok('client sell Client Cr net-spread', amt(v, r=>r.investor_id==='T1')===-(14945-10));

// F&O rules (2026-08-15 final): OWN F&O gated by post_fno; CLIENT F&O ALWAYS posts (flag ignored).
ctx.book = { post_fno:true };
v = acctBuildVoucher(own({transaction_type:'SELL', security_type:'NFO', security_id:'FUT1'}), ctx, [{gain:5000}]);
ok('F&O own (flag on) -> Dr Broker / Cr FNO_PL', voucherBalances(v.lines) && amt(v, r=>r.role==='FNO_PL')===-5000 && amt(v, r=>r.broker_id==='BRK1')===5000);
ctx.book = { post_fno:false };
ok('F&O own (flag off) -> no voucher', acctBuildVoucher(own({transaction_type:'SELL', security_type:'NFO', security_id:'FUT1'}), ctx, [{gain:5000}]).skip);
ctx.book = { post_fno:true };
v = acctBuildVoucher(cli({transaction_type:'SELL', security_type:'NFO', security_id:'FUT1'}), ctx, [{gain:5000}]);
ok('F&O client (flag on) profit -> Dr FNO_PL / Cr Trader', voucherBalances(v.lines) && amt(v, r=>r.role==='FNO_PL')===5000 && amt(v, r=>r.investor_id==='T1')===-5000);
ctx.book = { post_fno:false };
v = acctBuildVoucher(cli({transaction_type:'SELL', security_type:'NFO', security_id:'FUT1'}), ctx, [{gain:5000}]);
ok('F&O client (flag OFF) STILL posts -> Dr FNO_PL / Cr Trader', voucherBalances(v.lines) && amt(v, r=>r.role==='FNO_PL')===5000 && amt(v, r=>r.investor_id==='T1')===-5000);
v = acctBuildVoucher(cli({transaction_type:'SELL', security_type:'NFO', security_id:'FUT1'}), ctx, [{gain:-3000}]);
ok('F&O client loss -> Dr Trader / Cr FNO_PL', voucherBalances(v.lines) && amt(v, r=>r.role==='FNO_PL')===-3000 && amt(v, r=>r.investor_id==='T1')===3000);

// Demerger grouping
let dm = demergerVouchers([
  {id:'D0', security_id:'VEDL', net_amount:1000, transaction_date:'2026-06-15', notes:'[Demerger of VEDL on 2026-06-15: 100%]'},
  {id:'D1', security_id:'VAML', net_amount:400, transaction_date:'2024-09-26', notes:'[Demerger from VEDL on 2026-06-15]'},
  {id:'D2', security_id:'VISL', net_amount:600, transaction_date:'2024-09-26', notes:'[Demerger from VEDL on 2026-06-15]'}
], ctx);
ok('demerger 1 voucher', dm.vouchers.length===1);
ok('demerger balances', voucherBalances(dm.vouchers[0].lines));
ok('demerger parent Cr 1000', amt(dm.vouchers[0], r=>r.security_id==='VEDL')===-1000);

// Orchestrator end-to-end (stub fifo)
const book = { id:'INV1', post_fno:false };
const trades = [
  own({id:'t1', transaction_type:'BUY', net_amount:10040, stt:10, transaction_date:'2025-01-01'}),
  own({id:'t2', transaction_type:'SELL', net_amount:14945, stt:15, quantity:-100, transaction_date:'2025-06-01'}),
  own({id:'t3', transaction_type:'DIVIDEND', net_amount:900, tds:100, transaction_date:'2025-03-01'}),
  own({id:'t4', transaction_type:'SPLIT', transaction_date:'2025-02-01'})
];
const fifoStub = () => ({ gains: [{sellTxnId:'t2', qty:100, buyCost:10030, gain:4930, buyDate:'2025-01-01', sellDate:'2025-06-01', securityType:'EQUITY'}] });
const res = acctEngineProcess(book, trades, Object.assign({}, ctx, { fifo: fifoStub }));
ok('orch 3 vouchers (buy/sell/div)', res.vouchers.length===3);
ok('orch all balance', res.vouchers.every(v=>voucherBalances(v.lines)));
ok('orch split skipped', res.skipped.some(s=>s.id==='t4'));
ok('orch no critical exceptions', !res.exceptions.some(e=>e.severity==='critical'));

// --- Rounding plug: independently-rounded cost + gain must still tie exactly ---
// Reproduces the live LIQUIDCASE case: proceeds 22,28,494.06 = cost 21,96,211.19 + gain 32,282.87,
// where naive r2 of cost and gain sum to ...07 (a 1-paise gap). The last CG line absorbs it.
v = acctBuildVoucher(own({transaction_type:'SELL', net_amount:2228494.06, stt:0, quantity:-20000, security_id:'SEC1'}),
  Object.assign({}, ctx, {investorById:{INV1:{stt_accounting_method:false}}}),
  [{qty:20000, buyCost:2196211.19, gain:32282.87, buyDate:'2024-01-01', sellDate:'2024-08-01', securityType:'EQUITY'}]);
ok('rounding plug: sell voucher ties exactly', voucherBalances(v.lines));
ok('rounding plug: broker Dr == sum of credits', Math.round((amt(v,r=>r.broker_id==='BRK1'))*100) === Math.round(2228494.06*100));

// --- No cost basis: uncovered SELL is skipped with a warn alert, not a broken voucher ---
let nc = acctBuildVoucher(own({transaction_type:'SELL', net_amount:976.35, quantity:-1, security_id:'SEC1'}), ctx, []); // no gains -> uncovered
ok('no-cost sell is skipped (no voucher)', !!nc.skip && !nc.lines);
ok('no-cost sell raises sell_no_cost_basis alert', (nc.exceptions||[]).some(e=>e.condition_key.indexOf('sell_no_cost_basis')===0 && e.severity==='warn'));

// --- Demerger plug: children re-sum to parent exactly even with allocation rounding ---
let dm2 = demergerVouchers([
  {id:'P', security_id:'VEDL', net_amount:2292996.81, transaction_date:'2026-06-15', notes:'[Demerger of VEDL on 2026-06-15: 100%]'},
  {id:'c1', security_id:'A', net_amount:588404.34, transaction_date:'2026-06-15', notes:'[Demerger from VEDL on 2026-06-15]'},
  {id:'c2', security_id:'B', net_amount:1033917.36, transaction_date:'2026-06-15', notes:'[Demerger from VEDL on 2026-06-15]'},
  {id:'c3', security_id:'C', net_amount:343997.63, transaction_date:'2026-06-15', notes:'[Demerger from VEDL on 2026-06-15]'},
  {id:'c4', security_id:'D', net_amount:326677.47, transaction_date:'2026-06-15', notes:'[Demerger from VEDL on 2026-06-15]'}
], ctx);
ok('demerger plug: voucher ties exactly', voucherBalances(dm2.vouchers[0].lines));
ok('demerger plug: no critical exception', !dm2.exceptions.some(e=>e.severity==='critical'));

// --- Client charge spread -> Trader Income (rights/income + F&O) ---
v = acctBuildVoucher(cli({transaction_type:'RIGHTS_PAYMENT', net_amount:500000, trader_charges:2500, total_charges:0}), ctx, []);
ok('client rights: balances', voucherBalances(v.lines));
ok('client rights: client Dr net+spread (502500)', amt(v, r=>r.investor_id==='T1')===502500);
ok('client rights: PMS Settlement Cr 500000 (book pays the bank, not the client)', amt(v, r=>r.role==='PMS_SETTLEMENT')===-500000);
ok('client rights: spread to Trader Income (2500)', amt(v, r=>r.role==='TRADER_INCOME')===-2500);
ctx.book = { post_fno:true };
v = acctBuildVoucher(cli({transaction_type:'SELL', security_type:'NFO', security_id:'FUT1', total_charges:100, trader_charges:2730}), ctx, [{gain:5000}]);
ok('client F&O: P&L + spread both post', voucherBalances(v.lines) && amt(v, r=>r.role==='FNO_PL')===5000 && amt(v, r=>r.role==='TRADER_INCOME')===-2630);
v = acctBuildVoucher(cli({transaction_type:'BUY', security_type:'NFO', security_id:'FUT1', total_charges:100, trader_charges:2730}), ctx, []); // open leg, no P&L
ok('client F&O open leg: spread still posts', voucherBalances(v.lines) && amt(v, r=>r.role==='TRADER_INCOME')===-2630 && !v.skip);

// --- Options: premium is CASH (match Statements), never FIFO P&L (owner rule 2026-08-16) ---
ctx.book = { post_fno:true };
v = acctBuildVoucher(own({transaction_type:'BUY', security_type:'NFO', security_id:'OPT1', symbol:'NIFTY26AUG25000CE', net_amount:5000}), ctx, []);
ok('own option buy: premium Dr FNO_PL / Cr Broker', voucherBalances(v.lines) && amt(v, r=>r.role==='FNO_PL')===5000 && amt(v, r=>r.broker_id==='BRK1')===-5000);
v = acctBuildVoucher(own({transaction_type:'SELL', security_type:'NFO', security_id:'OPT1', symbol:'NIFTY26AUG25000CE', net_amount:8000, quantity:-100}), ctx, []);
ok('own option sell: premium Dr Broker / Cr FNO_PL', voucherBalances(v.lines) && amt(v, r=>r.role==='FNO_PL')===-8000 && amt(v, r=>r.broker_id==='BRK1')===8000);
ctx.book = { post_fno:false };
v = acctBuildVoucher(own({transaction_type:'BUY', security_type:'NFO', security_id:'OPT1', symbol:'NIFTY26AUG25000CE', net_amount:5000}), ctx, []);
ok('own option: post_fno off -> skip (like own futures)', !!v.skip);
v = acctBuildVoucher(cli({transaction_type:'BUY', security_type:'NFO', security_id:'OPT1', symbol:'NIFTY26AUG25000CE', net_amount:5040, total_charges:40, trader_charges:50}), ctx, []);
ok('client option buy: premium to client (Dr 5050), spread to Trader Income', voucherBalances(v.lines) && amt(v, r=>r.investor_id==='T1')===5050 && amt(v, r=>r.role==='TRADER_INCOME')===-10);
ok('option excluded from futures FIFO', Object.keys(acctFnoRealised([own({id:'o1', transaction_type:'BUY', security_type:'NFO', security_id:'OPT1', symbol:'NIFTY26AUG25000CE', quantity:50, net_amount:5000})])).length===0);
ok('future still matched by FIFO', Object.keys(acctFnoRealised([
  own({id:'f1', transaction_type:'BUY',  security_type:'NFO', security_id:'FUT1', symbol:'NIFTY26AUGFUT', quantity:50,  net_amount:5000, transaction_date:'2026-08-01'}),
  own({id:'f2', transaction_type:'SELL', security_type:'NFO', security_id:'FUT1', symbol:'NIFTY26AUGFUT', quantity:-50, net_amount:6000, transaction_date:'2026-08-05'})
])).length>0);

// --- F&O realised P&L matcher: symmetric FIFO, per beneficiary + contract ---
// Two beneficiaries in the SAME contract in one book must NOT pool (the v4 bug).
let fno = acctFnoRealised([
  // client T1 long MAY: buy 1250@1389.17 + buy 1250@1322.27, sell 2500@1299.61 => LOSS ~140281
  {id:'b1', investor_id:'T0', trader_id:'T1', security_type:'NFO', symbol:'AXISBANK26MAYFUT', transaction_type:'BUY',  quantity:1250,  net_amount:1736467.07, transaction_date:'2026-04-22'},
  {id:'b2', investor_id:'T0', trader_id:'T1', security_type:'NFO', symbol:'AXISBANK26MAYFUT', transaction_type:'BUY',  quantity:1250,  net_amount:1652838.02, transaction_date:'2026-04-27'},
  {id:'s1', investor_id:'T0', trader_id:'T1', security_type:'NFO', symbol:'AXISBANK26MAYFUT', transaction_type:'SELL', quantity:-2500, net_amount:3249024.13, transaction_date:'2026-05-25'},
  // OWN Veins long MAY same contract — must be matched separately, not pooled with T1
  {id:'o1', investor_id:'VB', trader_id:'VB', security_type:'NFO', symbol:'AXISBANK26MAYFUT', transaction_type:'BUY',  quantity:100, net_amount:100000, transaction_date:'2026-04-22'},
  {id:'o2', investor_id:'VB', trader_id:'VB', security_type:'NFO', symbol:'AXISBANK26MAYFUT', transaction_type:'SELL', quantity:-100, net_amount:110000, transaction_date:'2026-05-25'},
]);
ok('F&O client MAY loss ~ -140281 (not pooled/profit)', Math.round(fno['s1'])===-140281);
ok('F&O own MAY profit +10000 (separate beneficiary)', Math.round(fno['o1']||fno['o2'])===10000 && fno['o2']===10000);
// short-to-open then cover (symmetric FIFO): sell 100@120 open, buy 100@90 cover => profit 3000 on the cover
let fnoShort = acctFnoRealised([
  {id:'sh1', investor_id:'VB', trader_id:'VB', security_type:'NFO', symbol:'NIFTY26AUGFUT', transaction_type:'SELL', quantity:-100, net_amount:12000, transaction_date:'2026-08-01'},
  {id:'sh2', investor_id:'VB', trader_id:'VB', security_type:'NFO', symbol:'NIFTY26AUGFUT', transaction_type:'BUY',  quantity:100,  net_amount:9000,  transaction_date:'2026-08-05'},
]);
ok('F&O short cover profit +3000 (symmetric FIFO handles short)', fnoShort['sh2']===3000 && fnoShort['sh1']===undefined);

// --- Equity FIFO runs POOLED at the book level (all trades, any trader) ---
// The book's tax P&L cannot depend on the trader split; the shared FIFO is called
// once with the whole book's trades. (New dual book-tax/trader-settlement engine
// is being finalised separately.)
let fifoCalls2=[];
const fifoSpy2 = (txns)=>{ fifoCalls2.push(txns.map(t=>t.id)); return {gains:[]}; };
acctEngineProcess({ id:'INV1', post_fno:false }, [
  {id:'p1', investor_id:'INV1', security_id:'SEC1', broker_id:'BRK1', transaction_type:'BUY',  quantity:100,  net_amount:10000, transaction_date:'2025-01-01'},
  {id:'p2', investor_id:'INV1', security_id:'SEC1', broker_id:'BRK1', transaction_type:'SELL', quantity:-100, net_amount:12000, transaction_date:'2025-02-01'},
  {id:'p3', investor_id:'INV1', trader_id:'T1', security_id:'SEC1', broker_id:'BRK1', transaction_type:'BUY', quantity:100, net_amount:9000, transaction_date:'2025-01-15'},
], Object.assign({}, ctx, { investorById:{INV1:{stt_accounting_method:false}, T1:{}}, fifo:fifoSpy2 }));
ok('equity FIFO pooled book-level (one call, all trades incl client p3)', fifoCalls2.length===1 && fifoCalls2[0].indexOf('p1')>=0 && fifoCalls2[0].indexOf('p3')>=0);

// --- Statement postings: interest / cash / recon / opening (owner rules 2026-08-16) ---
// Interest, own book (has broker): Dr Trading Interest / Cr Broker
v = acctStatementVoucher({entry_type:'INTEREST_BOOKED', investor_id:'T0', broker_id:'BRK1', amount:194191.92}, ctx);
ok('stmt interest own: Dr Trading Interest / Cr Broker', voucherBalances(v.lines) && amt(v, r=>r.role==='INT_TRADING')===194191.92 && amt(v, r=>r.broker_id==='BRK1')===-194191.92);
// Interest, client (no broker): Dr Client / Cr Trading Interest (parent charges the client)
v = acctStatementVoucher({entry_type:'INTEREST_BOOKED', investor_id:'T1', amount:2433.52}, ctx);
ok('stmt interest client: Dr Client / Cr Trading Interest', voucherBalances(v.lines) && amt(v, r=>r.investor_id==='T1')===2433.52 && amt(v, r=>r.role==='INT_TRADING')===-2433.52);
ok('stmt client entry posts in the PARENT book (T0), not T1', v.bookId==='T0');
ok('stmt own-book entry posts in its own book (T0)', acctStatementVoucher({entry_type:'INTEREST_BOOKED', investor_id:'T0', broker_id:'BRK1', amount:100}, ctx).bookId==='T0');
// Cash received, own book: Dr Cash / Cr Broker
v = acctStatementVoucher({entry_type:'CASH_RECEIVED', investor_id:'T0', broker_id:'BRK1', amount:20000}, ctx);
ok('stmt cash recd own: Dr Cash / Cr Broker', voucherBalances(v.lines) && amt(v, r=>r.role==='CASH')===20000 && amt(v, r=>r.broker_id==='BRK1')===-20000);
// Cash paid, own book: Dr Broker / Cr Cash
v = acctStatementVoucher({entry_type:'CASH_PAID', investor_id:'T0', broker_id:'BRK1', amount:1000}, ctx);
ok('stmt cash paid own: Dr Broker / Cr Cash', voucherBalances(v.lines) && amt(v, r=>r.broker_id==='BRK1')===1000 && amt(v, r=>r.role==='CASH')===-1000);
// Cash paid, client (T0 gives cash to T2): Dr Client / Cr Cash
v = acctStatementVoucher({entry_type:'CASH_PAID', investor_id:'T2', amount:2516500}, ctx);
ok('stmt cash paid client: Dr Client / Cr Cash', voucherBalances(v.lines) && amt(v, r=>r.investor_id==='T2')===2516500 && amt(v, r=>r.role==='CASH')===-2516500);
// Cash received, client (client deposits): Dr Cash / Cr Client
v = acctStatementVoucher({entry_type:'CASH_RECEIVED', investor_id:'T3a', amount:18500}, ctx);
ok('stmt cash recd client: Dr Cash / Cr Client', voucherBalances(v.lines) && amt(v, r=>r.role==='CASH')===18500 && amt(v, r=>r.investor_id==='T3a')===-18500);
// Reconciliation & opening balance: no voucher
ok('stmt reconciliation: skipped', !!acctStatementVoucher({entry_type:'RECONCILIATION', investor_id:'T3', amount:69448675.66}, ctx).skip);
ok('stmt opening balance: skipped', !!acctStatementVoucher({entry_type:'OPENING_BALANCE', investor_id:'T0', broker_id:'BRK1', amount:70863016}, ctx).skip);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
