// ============================================================================
// accounting-engine.js — the WMS accounting posting engine (v2 rebuild).
// Replaces accounting-posting.js. PURE/UMD (browser + node + Deno).
//
// Design: POSTING-RULES.md v2 / EXECUTION-PLAN.md v2.
//  - Reuses the SHARED calc: wmsCalcFifoCost (FIFO cost + gains) and
//    wmsGainClassify (ST/LT/intraday, per-security capital_gains) — so the books
//    and the Reports CG figures are consistent by construction.
//  - Ledgers are referenced by a `ref`, resolved to ids by the caller:
//       { role:'CG_LT' }        → a system ledger by posting_role
//       { security_id:'…' }     → the security's Investment ledger
//       { broker_id:'…' }       → the broker ledger
//       { investor_id:'…' }     → a client (Trader) current-account ledger
//  - Every voucher balances (Σdebit === Σcredit).
//
// This file (C3a) covers OWN-book BUY and SELL. Income, corporate actions,
// demerger, F&O/intraday and parent-book legs are added in later increments.
// ============================================================================
(function (root, factory) {
    var dep = (typeof module !== 'undefined' && module.exports)
        ? require('./wms-cost-engine.js')
        : root;                                   // browser: globals from wms-cost-engine.js
    var api = factory(dep);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) { for (var k in api) { if (api.hasOwnProperty(k)) root[k] = api[k]; } }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (dep) {

    var wmsGainClassify = dep.wmsGainClassify;

    function absN(x) { return Math.abs(parseFloat(x) || 0); }
    function r2(x) { return Math.round(x * 100) / 100; }
    function tradeType(t) { return String(t.transaction_type || t.type || '').toUpperCase(); }

    // STT expense ledger role depends on the instrument (stocks vs MFs).
    function sttRole(sec) { return (sec && sec.security_type === 'MF') ? 'STT_MF' : 'STT_STOCKS'; }

    // Is STT booked as a SEPARATE expense for the trade's executing investor?
    function sttSeparate(trade, ctx) {
        var inv = ctx.investorById[String(trade.investor_id)] || {};
        return !!inv.stt_accounting_method;
    }

    function voucherBalances(lines) {
        var d = 0, c = 0;
        lines.forEach(function (l) { d += (l.debit || 0); c += (l.credit || 0); });
        return Math.round(d * 100) === Math.round(c * 100);
    }

    // --- OWN BUY -------------------------------------------------------------
    // Dr Investment [total − STT if separate]; Dr STT [if separate]; Cr Broker [total].
    function buildBuyOwn(t, ctx) {
        var total = absN(t.net_amount !== undefined ? t.net_amount : t.netAmount);
        var stt = absN(t.stt);
        var sep = sttSeparate(t, ctx);
        var sec = ctx.securityById[String(t.security_id)] || {};
        var lines = [];
        lines.push({ ref: { security_id: t.security_id }, debit: r2(sep ? total - stt : total), credit: 0, narration: 'Cost' });
        if (sep && stt > 0) lines.push({ ref: { role: sttRole(sec) }, debit: r2(stt), credit: 0, narration: 'STT' });
        lines.push({ ref: { broker_id: t.broker_id }, debit: 0, credit: r2(total), narration: 'Broker' });
        return { type: 'PMS-BUY', narration: 'Buy ' + absN(t.quantity) + ' ' + (sec.symbol || t.short_symbol || '') , lines: lines };
    }

    // --- OWN SELL ------------------------------------------------------------
    // Dr Broker [net]; Dr STT [if separate]; Cr Investment [FIFO cost]; Cr/Dr CG.
    // `gains` = the FIFO gain events whose sellTxnId === this trade (from wmsCalcFifoCost).
    function buildSellOwn(t, ctx, gains) {
        var net = absN(t.net_amount !== undefined ? t.net_amount : t.netAmount);
        var stt = absN(t.stt);
        var sep = sttSeparate(t, ctx);
        var sec = ctx.securityById[String(t.security_id)] || {};
        var lines = [], exceptions = [];

        lines.push({ ref: { broker_id: t.broker_id }, debit: r2(net), credit: 0, narration: 'Broker' });
        if (sep && stt > 0) lines.push({ ref: { role: sttRole(sec) }, debit: r2(stt), credit: 0, narration: 'STT' });

        var cost = 0, byRole = {};
        (gains || []).forEach(function (g) {
            cost += (g.buyCost || 0);
            var cls = wmsGainClassify(g, sec);
            var role = (cls.bucket === 'INTRADAY') ? 'INTRADAY_PL' : cls.cgRole;
            if (!role) {
                exceptions.push({ condition_key: 'unmapped_cg:' + (sec.symbol || t.security_id),
                    severity: 'warn', title: 'No capital-gains ledger for ' + (sec.symbol || t.security_id),
                    detail: { security_id: t.security_id, bucket: cls.bucket } });
                role = 'CG_ST_SLAB';   // safe fallback so the voucher still balances
            }
            byRole[role] = (byRole[role] || 0) + (g.gain || 0);
        });

        lines.push({ ref: { security_id: t.security_id }, debit: 0, credit: r2(cost), narration: 'Cost relieved' });
        Object.keys(byRole).forEach(function (role) {
            var amt = r2(byRole[role]);
            if (Math.round(amt * 100) === 0) return;
            if (amt >= 0) lines.push({ ref: { role: role }, debit: 0, credit: amt, narration: 'Gain' });   // gain → credit
            else lines.push({ ref: { role: role }, debit: -amt, credit: 0, narration: 'Loss' });           // loss → debit
        });

        return { type: 'PMS-SELL', narration: 'Sell ' + absN(t.quantity) + ' ' + (sec.symbol || t.short_symbol || ''), lines: lines, exceptions: exceptions };
    }

    // Build the voucher for ONE own-book trade. Returns {skip} for no-op types.
    // gains = FIFO gain events for this trade (SELL only).
    function acctBuildVoucher(trade, ctx, gains) {
        var ty = tradeType(trade);
        if (ty === 'HISTORICAL_PL') return { skip: 'historical (pre-period)' };
        if (ty === 'SPLIT' || ty === 'BONUS' || ty === 'RIGHTS_ENTITLEMENT') return { skip: 'quantity-only, no posting' };
        if (ty === 'BUY') return buildBuyOwn(trade, ctx);
        if (ty === 'SELL') return buildSellOwn(trade, ctx, gains);
        return { skip: 'not handled in C3a: ' + ty };   // income / corp-actions / F&O → later increments
    }

    return {
        acctBuildVoucher: acctBuildVoucher,
        _buildBuyOwn: buildBuyOwn,
        _buildSellOwn: buildSellOwn,
        voucherBalances: voucherBalances
    };
});
