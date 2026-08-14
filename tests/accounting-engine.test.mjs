import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { acctBuildVoucher, acctEngineProcess, demergerVouchers, voucherBalances } = require(join(here, '..', 'accounting-engine.js'));

let pass=0, fail=0;
function ok(name, cond){ if(cond){pass++;} else {fail++; console.log('FAIL', name);} }
function amt(v, p){ var l=v.lines.find(l=>p(l.ref)); return l ? (l.debit||0)-(l.credit||0) : null; } // +dr/-cr

const ctx = {
  securityById: {
    SEC1:{security_type:'EQUITY', symbol:'ABC', capital_gains:{stcg:'CG_ST_STT',ltcg:'CG_LT',lt_months:12}, income_ledgers:{DIVIDEND:'INC_DIVIDEND', INTEREST:'INC_INT_BONDS'}},
    FUT1:{security_type:'NFO', symbol:'NIFTYF', capital_gains:{}, income_ledgers:{}}
  },
  investorById: { INV1:{stt_accounting_method:true}, INV2:{stt_accounting_method:false}, T0:{stt_accounting_method:false} },
  brokerById: {}
};
const own = o => Object.assign({investor_id:'INV1', security_id:'SEC1', broker_id:'BRK1', quantity:100}, o);
const cli = o => Object.assign({investor_id:'T0', trader_id:'T1', security_id:'SEC1', broker_id:'BRK1', quantity:100}, o);

// BUY / SELL own (re-check)
ok('buy own balances', voucherBalances(acctBuildVoucher(own({transaction_type:'BUY',net_amount:10040,stt:10}), ctx, []).lines));
let v = acctBuildVoucher(own({transaction_type:'SELL',net_amount:14945,stt:15,quantity:-100}), ctx, [{buyCost:10030,gain:4930,buyDate:'2025-01-01',sellDate:'2025-06-01',securityType:'EQUITY'}]);
ok('sell own CG_ST_STT credit 4930', amt(v, r=>r.role==='CG_ST_STT')===-4930 && voucherBalances(v.lines));

// Income own (dividend + TDS)
v = acctBuildVoucher(own({transaction_type:'DIVIDEND', net_amount:900, tds:100}), ctx, []);
ok('div balances', voucherBalances(v.lines));
ok('div settlement Dr 900', amt(v, r=>r.role==='PMS_SETTLEMENT')===900);
ok('div TDS Dr 100', amt(v, r=>r.role==='TDS_YIELD')===100);
ok('div income Cr 1000 (mapped)', amt(v, r=>r.role==='INC_DIVIDEND')===-1000);
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

// F&O gate
ctx.book = { post_fno:false };
ok('F&O off -> skip', acctBuildVoucher(own({transaction_type:'SELL', security_type:'NFO', security_id:'FUT1'}), ctx, [{gain:5000}]).skip);
ctx.book = { post_fno:true };
v = acctBuildVoucher(own({transaction_type:'SELL', security_type:'NFO', security_id:'FUT1'}), ctx, [{gain:5000}]);
ok('F&O on profit -> Broker Dr / FNO_PL Cr', voucherBalances(v.lines) && amt(v, r=>r.role==='FNO_PL')===-5000);

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
const fifoStub = () => ({ gains: [{sellTxnId:'t2', buyCost:10030, gain:4930, buyDate:'2025-01-01', sellDate:'2025-06-01', securityType:'EQUITY'}] });
const res = acctEngineProcess(book, trades, Object.assign({}, ctx, { fifo: fifoStub }));
ok('orch 3 vouchers (buy/sell/div)', res.vouchers.length===3);
ok('orch all balance', res.vouchers.every(v=>voucherBalances(v.lines)));
ok('orch split skipped', res.skipped.some(s=>s.id==='t4'));
ok('orch no critical exceptions', !res.exceptions.some(e=>e.severity==='critical'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
