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

    // ⛔ SINGLE SOURCE — F&O (NFO + MCX) realised P&L. Do NOT copy this logic or add
    //    another F&O FIFO anywhere. Both consumers MUST call this: Statements
    //    (wms-shared.js wmsBuildLedger) and Accounting (accounting-engine.js).
    //    ⚠️ Any edit here is behaviour-changing for BOTH modules and requires
    //    EXPLICIT OWNER APPROVAL. The guard tests/check-fno-engine.mjs (in the
    //    Vikash-WMS-backend repo, part of `npm run drift`/`npm test`) fails LOUD on
    //    any change or on a re-introduced copy; re-pin with `--write` ONLY after approval.
    //
    // F&O realised P&L — the AUTHORITATIVE symmetric long/short FIFO, per CONTRACT.
    // Lifted from the Statements module (wms-shared.js wmsBuildLedger NFO block),
    // which the owner designates as the single source of truth for F&O P&L (2026-08-15).
    // Both the Statements module and the Accounting engine call THIS so they cannot
    // diverge; the fno-parity test guards it.
    //
    // A lot is LONG (opened by a BUY) or SHORT (opened by a SELL). Every trade first
    // COVERS open lots of the opposite side (FIFO, booking realised P&L) and only the
    // uncovered remainder opens a new lot on its own side — so shorts (SELL to open)
    // are handled. Callers decide WHAT to feed it: Statements passes futures only
    // (option premiums are cash there); Accounting passes each beneficiary's F&O.
    //
    // rows = [{ key, type:'BUY'|'SELL', qty, net, id, sort }]
    //   key  = contract identity (e.g. symbol minus exchange prefix)
    //   qty  = quantity (sign ignored; magnitude used)
    //   net  = net-amount MAGNITUDE (perUnit = net/qty is cost on BUY, proceeds on SELL)
    //   id   = caller's row identifier (returned so the caller can attribute the P&L)
    //   sort = ordering key within a contract (chronological)
    // Returns [{ id, matchedQty, realisedPnl }] for each COVERING trade
    //   (realisedPnl = sell proceeds − buy cost; +profit / −loss).
    function wmsFnoRealised(rows) {
        var groups = {};
        (rows || []).forEach(function (r) { (groups[r.key] = groups[r.key] || []).push(r); });
        var out = [];
        Object.keys(groups).forEach(function (k) {
            var g = groups[k].slice().sort(function (a, b) { return a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0; });
            var lots = [];
            g.forEach(function (r) {
                var qty = Math.abs(r.qty); if (qty === 0) return;
                if (r.type !== 'BUY' && r.type !== 'SELL') return;
                var perUnit = Math.abs(r.net) / qty;
                var isBuy = r.type === 'BUY';
                var openSide = isBuy ? 'LONG' : 'SHORT', coverSide = isBuy ? 'SHORT' : 'LONG';
                var remain = qty, matchedQty = 0, buyCost = 0, sellProc = 0;
                while (remain > 0 && lots.length > 0 && lots[0].side === coverSide) {
                    var lot = lots[0], matched = Math.min(remain, lot.qty);
                    if (isBuy) { sellProc += matched * lot.perUnit; buyCost += matched * perUnit; }
                    else { buyCost += matched * lot.perUnit; sellProc += matched * perUnit; }
                    lot.qty -= matched; remain -= matched; matchedQty += matched;
                    if (lot.qty <= 0) lots.shift();
                }
                if (remain > 0) lots.push({ qty: remain, perUnit: perUnit, side: openSide });
                if (matchedQty > 0) out.push({ id: r.id, matchedQty: matchedQty, realisedPnl: Math.round((sellProc - buyCost) * 100) / 100 });
            });
        });
        return out;
    }

    return {
        wmsAddMonths: wmsAddMonths,
        wmsGainClassify: wmsGainClassify,
        wmsSttAdjustTxns: wmsSttAdjustTxns,
        wmsFnoRealised: wmsFnoRealised
    };
});
