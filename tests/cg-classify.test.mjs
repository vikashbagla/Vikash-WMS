// Offline tests for the shared CG classifier (wms-cost-engine.js).
// Run: node tests/cg-classify.test.mjs
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { wmsGainClassify, wmsSttAdjustTxns, wmsAddMonths } = require(join(here, '..', 'wms-cost-engine.js'));

let pass = 0, fail = 0;
function eq(name, got, want) {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; }
    else { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
}

const EQ  = { security_type: 'EQUITY',   capital_gains: { stcg: 'CG_ST_STT',  ltcg: 'CG_LT', lt_months: 12 } };
const UNL = { security_type: 'UNLISTED', capital_gains: { stcg: 'CG_ST_SLAB', ltcg: 'CG_LT', lt_months: 24 } };
const MF0 = { security_type: 'MF',       capital_gains: { stcg: 'CG_ST_SLAB', ltcg: 'CG_LT', lt_months: 0 } }; // 50AA always short
const NFO = { security_type: 'NFO',      capital_gains: {} };

eq('intraday same-day', wmsGainClassify({ buyDate: '2026-05-01', sellDate: '2026-05-01' }, EQ).bucket, 'INTRADAY');
eq('equity 366d -> LT', wmsGainClassify({ buyDate: '2023-01-15', sellDate: '2024-01-16' }, EQ), { bucket: 'LTCG', cgRole: 'CG_LT', ltMonths: 12, longTerm: true });
eq('equity exactly 12m -> ST', wmsGainClassify({ buyDate: '2023-01-15', sellDate: '2024-01-15' }, EQ), { bucket: 'STCG', cgRole: 'CG_ST_STT', ltMonths: 12, longTerm: false });
eq('equity 6m -> ST', wmsGainClassify({ buyDate: '2023-01-15', sellDate: '2023-07-10' }, EQ).bucket, 'STCG');
eq('unlisted 20m -> ST', wmsGainClassify({ buyDate: '2022-01-10', sellDate: '2023-09-10' }, UNL).bucket, 'STCG');
eq('unlisted 25m -> LT', wmsGainClassify({ buyDate: '2022-01-10', sellDate: '2024-02-10' }, UNL).cgRole, 'CG_LT');
eq('debt-MF 3y -> ST (50AA)', wmsGainClassify({ buyDate: '2020-01-10', sellDate: '2023-01-10' }, MF0).bucket, 'STCG');
eq('NFO -> BUSINESS', wmsGainClassify({ buyDate: '2026-01-01', sellDate: '2026-03-01' }, NFO).bucket, 'BUSINESS');
eq('unmapped -> default 12m long', wmsGainClassify({ buyDate: '2023-01-01', sellDate: '2025-01-01' }, { security_type: 'EQUITY', capital_gains: {} }).longTerm, true);
eq('unmapped role null', wmsGainClassify({ buyDate: '2023-01-01', sellDate: '2025-01-01' }, { security_type: 'EQUITY', capital_gains: {} }).cgRole, null);

const flag = { INV1: true, INV2: false };
eq('STT BUY flagON cost down', wmsSttAdjustTxns([{ transaction_type: 'BUY', investor_id: 'INV1', stt: 10, net_amount: 1000 }], flag)[0].net_amount, 990);
eq('STT SELL flagON proceeds up', wmsSttAdjustTxns([{ transaction_type: 'SELL', investor_id: 'INV1', stt: 15, net_amount: 2000 }], flag)[0].net_amount, 2015);
eq('STT flagOFF unchanged', wmsSttAdjustTxns([{ transaction_type: 'BUY', investor_id: 'INV2', stt: 10, net_amount: 1000 }], flag)[0].net_amount, 1000);
eq('addMonths 31Jan+1m clamps to 28Feb', wmsAddMonths('2023-01-31', 1).toISOString().slice(0, 10), '2023-02-28');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
