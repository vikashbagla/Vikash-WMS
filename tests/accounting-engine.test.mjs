import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { acctBuildVoucher, voucherBalances } = require(join(here, '..', 'accounting-engine.js'));

let pass=0, fail=0;
function ok(name, cond){ if(cond){pass++;} else {fail++; console.log('FAIL', name);} }
function lineFor(v, pred){ return v.lines.find(pred); }
function amt(v, refPred){ var l=v.lines.find(l=>refPred(l.ref)); return l ? (l.debit||0)-(l.credit||0) : null; } // +dr / -cr

const ctx = {
  securityById: { SEC1: { security_type:'EQUITY', symbol:'ABC', capital_gains:{stcg:'CG_ST_STT',ltcg:'CG_LT',lt_months:12} } },
  investorById: { INV1: { stt_accounting_method:true }, INV2: { stt_accounting_method:false } }
};
const buy = o => Object.assign({transaction_type:'BUY',investor_id:'INV1',security_id:'SEC1',broker_id:'BRK1',quantity:100}, o);
const sell= o => Object.assign({transaction_type:'SELL',investor_id:'INV1',security_id:'SEC1',broker_id:'BRK1',quantity:-100}, o);

// 1. BUY STT ON
let v = acctBuildVoucher(buy({net_amount:10040, stt:10}), ctx, []);
ok('buy-on balances', voucherBalances(v.lines));
ok('buy-on investment 10030', amt(v, r=>r.security_id==='SEC1')===10030);
ok('buy-on STT 10', amt(v, r=>r.role==='STT_STOCKS')===10);
ok('buy-on broker -10040', amt(v, r=>r.broker_id==='BRK1')===-10040);

// 1b. BUY STT OFF
v = acctBuildVoucher(buy({investor_id:'INV2', net_amount:10040, stt:10}), ctx, []);
ok('buy-off balances', voucherBalances(v.lines));
ok('buy-off investment 10040 (incl STT)', amt(v, r=>r.security_id==='SEC1')===10040);
ok('buy-off no STT line', !lineFor(v, l=>l.ref.role==='STT_STOCKS'));

// 2. SELL gain, STT ON, short-term
v = acctBuildVoucher(sell({net_amount:14945, stt:15}), ctx, [{buyCost:10030, gain:4930, buyDate:'2025-01-01', sellDate:'2025-06-01', securityType:'EQUITY'}]);
ok('sell-gain balances', voucherBalances(v.lines));
ok('sell-gain broker 14945', amt(v, r=>r.broker_id==='BRK1')===14945);
ok('sell-gain STT 15', amt(v, r=>r.role==='STT_STOCKS')===15);
ok('sell-gain investment -10030', amt(v, r=>r.security_id==='SEC1')===-10030);
ok('sell-gain CG_ST_STT -4930 (credit)', amt(v, r=>r.role==='CG_ST_STT')===-4930);

// 3. SELL loss
v = acctBuildVoucher(sell({net_amount:8961, stt:9}), ctx, [{buyCost:10030, gain:-1060, buyDate:'2025-01-01', sellDate:'2025-06-01', securityType:'EQUITY'}]);
ok('sell-loss balances', voucherBalances(v.lines));
ok('sell-loss CG debit 1060', amt(v, r=>r.role==='CG_ST_STT')===1060);

// 4. SELL ST+LT split (stt 0)
v = acctBuildVoucher(sell({investor_id:'INV2', net_amount:13030, stt:0}), ctx, [
  {buyCost:5000, gain:1000, buyDate:'2023-01-01', sellDate:'2025-06-01', securityType:'EQUITY'}, // LT
  {buyCost:5030, gain:2000, buyDate:'2025-01-01', sellDate:'2025-06-01', securityType:'EQUITY'}  // ST
]);
ok('sell-split balances', voucherBalances(v.lines));
ok('sell-split CG_LT -1000', amt(v, r=>r.role==='CG_LT')===-1000);
ok('sell-split CG_ST_STT -2000', amt(v, r=>r.role==='CG_ST_STT')===-2000);
ok('sell-split investment -10030', amt(v, r=>r.security_id==='SEC1')===-10030);

// 5. Intraday
v = acctBuildVoucher(sell({investor_id:'INV2', net_amount:1050, stt:0}), ctx, [{buyCost:1000, gain:50, buyDate:'2025-05-01', sellDate:'2025-05-01', securityType:'EQUITY'}]);
ok('intraday balances', voucherBalances(v.lines));
ok('intraday -> INTRADAY_PL -50', amt(v, r=>r.role==='INTRADAY_PL')===-50);

// 6. no-op types
ok('SPLIT skipped', acctBuildVoucher({transaction_type:'SPLIT'}, ctx, []).skip);
ok('HISTORICAL_PL skipped', acctBuildVoucher({transaction_type:'HISTORICAL_PL'}, ctx, []).skip);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
