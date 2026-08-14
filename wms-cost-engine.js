// ============================================================================
// wms-cost-engine.js — shared, PURE capital-gains classification.
//
// The FIFO cost/gain maths lives in wms-shared.js (_wmsCostEngine / wmsCalcFifoCost).
// This file adds the ST/LT/intraday CLASSIFICATION so that Reports and Accounting
// classify a realised gain THE SAME WAY — one code path, no drift (owner rule
// 2026-08-14). Classification is driven by the security's per-security mapping
// (securities_db.capital_gains: { stcg, ltcg, lt_months }), NOT a hardcoded rule.
//
// PURE: no DOM, no globals, no fetch. Safe to import in the browser AND in a
// node/Deno runtime (so a future server-side nightly poster runs the same code).
// UMD-ish: attaches to the global (browser) and to module.exports (node).
// ============================================================================
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) { for (var k in api) { if (api.hasOwnProperty(k)) root[k] = api[k]; } }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {

    // Add n calendar months to a 'YYYY-MM-DD' date, clamping day overflow
    // (e.g. 31-Jan + 1m → 28/29-Feb). Returns a UTC Date.
    function wmsAddMonths(iso, n) {
        var p = String(iso).slice(0, 10).split('-');
        var y = +p[0], m = +p[1] - 1, day = +p[2];
        var d = new Date(Date.UTC(y, m, 1));
        d.setUTCMonth(d.getUTCMonth() + n);           // move month on day-1 (never overflows)
        var lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
        d.setUTCDate(Math.min(day, lastDay));
        return d;
    }

    function wmsToUtc(iso) { return new Date(String(iso).slice(0, 10) + 'T00:00:00Z'); }

    // Classify one realised gain (as emitted by _wmsCostEngine) into
    // INTRADAY / STCG / LTCG / BUSINESS, and pick the capital-gains ledger ROLE
    // from the security's mapping. `security` = { security_type, capital_gains }.
    //   - INTRADAY : same-day buy & sell (buyDate === sellDate)
    //   - BUSINESS : F&O / commodities (NFO / MCX) — not a capital gain
    //   - LTCG     : sellDate is strictly MORE than lt_months months after buyDate
    //   - STCG     : otherwise (incl. lt_months === 0 → always short, s.50AA)
    // Returns { bucket, cgRole, ltMonths, longTerm }.
    function wmsGainClassify(gain, security) {
        if (gain && gain.buyDate && gain.sellDate && gain.buyDate === gain.sellDate) {
            return { bucket: 'INTRADAY', cgRole: null, ltMonths: null, longTerm: false };
        }
        var st = (security && security.security_type) || (gain && gain.securityType) || 'EQUITY';
        if (st === 'NFO' || st === 'MCX') {
            return { bucket: 'BUSINESS', cgRole: null, ltMonths: null, longTerm: false };
        }
        var cg = (security && security.capital_gains) || {};
        var ltm = (cg.lt_months != null) ? cg.lt_months : 12;   // default listed-equity threshold
        var longTerm = false;
        if (ltm > 0 && gain && gain.buyDate && gain.sellDate) {
            longTerm = wmsToUtc(gain.sellDate).getTime() > wmsAddMonths(gain.buyDate, ltm).getTime();
        }
        return {
            bucket: longTerm ? 'LTCG' : 'STCG',
            cgRole: longTerm ? (cg.ltcg || null) : (cg.stcg || null),
            ltMonths: ltm,
            longTerm: longTerm
        };
    }

    // STT-strip: when the executing investor books STT as a SEPARATE expense
    // (stt_accounting_method = true), STT must be excluded from the CG basis —
    // removed from BUY cost, added back to SELL proceeds — before FIFO runs.
    // `sttOnByInvestor` = { <investor_id>: true/false }. Returns adjusted clones.
    function wmsSttAdjustTxns(txns, sttOnByInvestor) {
        return txns.map(function (t) {
            var stt = Math.abs(parseFloat(t.stt) || 0);
            if (stt <= 0) return t;
            var inv = String(t.investorId != null ? t.investorId : t.investor_id);
            if (!sttOnByInvestor || !sttOnByInvestor[inv]) return t;
            var base = (t.netAmount !== undefined ? t.netAmount : t.net_amount) || 0;
            var ty = (t.type || t.transaction_type || '').toUpperCase();
            var c = {}; for (var k in t) { c[k] = t[k]; }
            if (ty === 'BUY' || ty === 'RIGHTS_PAYMENT') c.net_amount = base - stt;
            else if (ty === 'SELL') c.net_amount = base + stt;
            else c.net_amount = base;
            return c;   // snake-case net_amount wins over netAmount inside the engine
        });
    }

    return {
        wmsAddMonths: wmsAddMonths,
        wmsGainClassify: wmsGainClassify,
        wmsSttAdjustTxns: wmsSttAdjustTxns
    };
});
