// ============================================================================
// accounting-engine.js — the WMS accounting posting engine (v2 rebuild).
// Replaces accounting-posting.js. PURE/UMD (browser + node + Deno).
//
// Design: POSTING-RULES.md v2 / EXECUTION-PLAN.md v2.
//  - Reuses the SHARED calc: wmsCalcFifoCost (FIFO cost + gains) + wmsGainClassify
//    (ST/LT/intraday, per-security capital_gains) + wmsSttAdjustTxns — so the
//    books and the Reports CG figures are consistent by construction.
//  - Ledgers are referenced by a `ref`, resolved to ids by the caller:
//       { role:'CG_LT' }    → system ledger by posting_role
//       { security_id }     → the security's Investment ledger
//       { broker_id }       → the broker ledger
//       { investor_id }     → a client (Trader) current-account ledger
//  - Every voucher balances (Σdebit === Σcredit).
//
// Ledger roles used: STT_STOCKS/STT_MF, CG_ST_STT/CG_ST_SLAB/CG_LT, INTRADAY_PL,
//   PMS_SETTLEMENT, TDS_YIELD, FNO_PL, TRADER_INCOME, INT_TRADING, and the income
//   roles the security's income_ledgers map points at (INC_*).
// ============================================================================
(function (root, factory) {
    var dep = (typeof module !== 'undefined' && module.exports) ? require('./wms-cost-engine.js') : root;
    var api = factory(dep);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) { for (var k in api) { if (api.hasOwnProperty(k)) root[k] = api[k]; } }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (dep) {

    var wmsGainClassify = dep.wmsGainClassify;
    var wmsSttAdjustTxns = dep.wmsSttAdjustTxns;

    function absN(x) { return Math.abs(parseFloat(x) || 0); }
    function num(x) { return parseFloat(x) || 0; }
    function r2(x) { return Math.round(x * 100) / 100; }
    function ttype(t) { return String(t.transaction_type || t.type || '').toUpperCase(); }
    function secOf(t, ctx) { return ctx.securityById[String(t.security_id)] || {}; }
    function symOf(t, ctx) { return secOf(t, ctx).symbol || t.short_symbol || t.symbol || ''; }
    function sttRole(sec) { return (sec && sec.security_type === 'MF') ? 'STT_MF' : 'STT_STOCKS'; }
    function sttSeparate(t, ctx) { return !!(ctx.investorById[String(t.investor_id)] || {}).stt_accounting_method; }
    function incRole(sec, type) { var m = (sec && sec.income_ledgers) || {}; return m[type] || null; }

    function voucherBalances(lines) {
        var d = 0, c = 0;
        lines.forEach(function (l) { d += (l.debit || 0); c += (l.credit || 0); });
        return Math.round(d * 100) === Math.round(c * 100);
    }
    function ex(key, sev, title, detail) { return { condition_key: key, severity: sev, title: title, detail: detail || {} }; }

    // ---- OWN legs -----------------------------------------------------------
    function buyOwn(t, ctx) {
        var total = absN(t.net_amount !== undefined ? t.net_amount : t.netAmount), stt = absN(t.stt);
        var sep = sttSeparate(t, ctx), sec = secOf(t, ctx), lines = [];
        lines.push({ ref: { security_id: t.security_id }, debit: r2(sep ? total - stt : total), credit: 0 });
        if (sep && stt > 0) lines.push({ ref: { role: sttRole(sec) }, debit: r2(stt), credit: 0 });
        lines.push({ ref: { broker_id: t.broker_id }, debit: 0, credit: r2(total) });
        return { type: 'PMS-BUY', narration: 'Buy ' + absN(t.quantity) + ' ' + symOf(t, ctx), lines: lines };
    }

    function sellOwn(t, ctx, gains) {
        var net = absN(t.net_amount !== undefined ? t.net_amount : t.netAmount), stt = absN(t.stt);
        var sep = sttSeparate(t, ctx), sec = secOf(t, ctx), lines = [], exceptions = [];
        lines.push({ ref: { broker_id: t.broker_id }, debit: r2(net), credit: 0 });
        if (sep && stt > 0) lines.push({ ref: { role: sttRole(sec) }, debit: r2(stt), credit: 0 });
        var cost = 0, byRole = {};
        (gains || []).forEach(function (g) {
            cost += (g.buyCost || 0);
            var cls = wmsGainClassify(g, sec);
            var role = (cls.bucket === 'INTRADAY') ? 'INTRADAY_PL' : cls.cgRole;
            if (!role) { exceptions.push(ex('unmapped_cg:' + symOf(t, ctx), 'warn', 'No CG ledger for ' + symOf(t, ctx), { security_id: t.security_id, bucket: cls.bucket })); role = 'CG_ST_SLAB'; }
            byRole[role] = (byRole[role] || 0) + (g.gain || 0);
        });
        lines.push({ ref: { security_id: t.security_id }, debit: 0, credit: r2(cost) });
        Object.keys(byRole).forEach(function (role) {
            var amt = r2(byRole[role]); if (Math.round(amt * 100) === 0) return;
            if (amt >= 0) lines.push({ ref: { role: role }, debit: 0, credit: amt });
            else lines.push({ ref: { role: role }, debit: -amt, credit: 0 });
        });
        return { type: 'PMS-SELL', narration: 'Sell ' + absN(t.quantity) + ' ' + symOf(t, ctx), lines: lines, exceptions: exceptions };
    }

    // Income (DIVIDEND / INTEREST / OTHER_INCOME) — own book.
    // Dr PMS Settlement [net]; Dr TDS on Yield [tds]; Cr <income ledger> [gross].
    function incomeOwn(t, ctx) {
        var ty = ttype(t), sec = secOf(t, ctx);
        var net = absN(t.net_amount !== undefined ? t.net_amount : t.netAmount), tds = absN(t.tds);
        var gross = r2(net + tds), lines = [], exceptions = [];
        var role = incRole(sec, ty);
        if (!role) { exceptions.push(ex('unmapped_income:' + symOf(t, ctx) + ':' + ty, 'warn', 'No income ledger for ' + symOf(t, ctx) + ' ' + ty, { security_id: t.security_id, type: ty })); role = 'INC_OTHER'; }
        lines.push({ ref: { role: 'PMS_SETTLEMENT' }, debit: r2(net), credit: 0 });
        if (tds > 0) lines.push({ ref: { role: 'TDS_YIELD' }, debit: r2(tds), credit: 0 });
        lines.push({ ref: { role: role }, debit: 0, credit: gross });
        return { type: 'PMS-' + ty, narration: ty.charAt(0) + ty.slice(1).toLowerCase() + ' ' + symOf(t, ctx), lines: lines, exceptions: exceptions };
    }

    // CAPITAL_REDUCTION — Dr PMS Settlement; Cr Investment (cost reduced).
    function capRedOwn(t, ctx) {
        var amt = absN(t.net_amount !== undefined ? t.net_amount : t.netAmount);
        return { type: 'PMS-CAPITAL_REDUCTION', narration: 'Capital reduction ' + symOf(t, ctx),
            lines: [{ ref: { role: 'PMS_SETTLEMENT' }, debit: r2(amt), credit: 0 }, { ref: { security_id: t.security_id }, debit: 0, credit: r2(amt) }] };
    }

    // RIGHTS_PAYMENT — Dr Investment (adds cost); Cr PMS Settlement.
    function rightsPayOwn(t, ctx) {
        var amt = absN(t.net_amount !== undefined ? t.net_amount : t.netAmount);
        return { type: 'PMS-RIGHTS_PAYMENT', narration: 'Rights payment ' + symOf(t, ctx),
            lines: [{ ref: { security_id: t.security_id }, debit: r2(amt), credit: 0 }, { ref: { role: 'PMS_SETTLEMENT' }, debit: 0, credit: r2(amt) }] };
    }

    // F&O close — realised P&L only, gated by post_fno. OWN: Broker vs FNO_PL.
    function fnoOwn(t, ctx, gains) {
        if (!ctx.book || !ctx.book.post_fno) return { skip: 'F&O gated off (post_fno)' };
        var pnl = 0; (gains || []).forEach(function (g) { pnl += (g.gain || 0); });
        pnl = r2(pnl); if (Math.round(pnl * 100) === 0) return { skip: 'F&O open / net-zero' };
        var lines = pnl >= 0
            ? [{ ref: { broker_id: t.broker_id }, debit: pnl, credit: 0 }, { ref: { role: 'FNO_PL' }, debit: 0, credit: pnl }]
            : [{ ref: { role: 'FNO_PL' }, debit: -pnl, credit: 0 }, { ref: { broker_id: t.broker_id }, debit: 0, credit: -pnl }];
        return { type: 'PMS-FNO', narration: 'F&O ' + symOf(t, ctx), lines: lines };
    }

    // ---- CLIENT (parent-book) legs: trader ≠ investor -----------------------
    // BUY: Dr Client [net + spread]; Cr Broker [net]; Cr Trader Income [spread].
    function buyClient(t, ctx) {
        var net = absN(t.net_amount !== undefined ? t.net_amount : t.netAmount);
        var spread = r2(absN(t.trader_charges) - absN(t.total_charges));
        var lines = [{ ref: { investor_id: t.trader_id }, debit: r2(net + spread), credit: 0 }, { ref: { broker_id: t.broker_id }, debit: 0, credit: r2(net) }];
        if (Math.round(spread * 100) !== 0) lines.push({ ref: { role: 'TRADER_INCOME' }, debit: 0, credit: r2(spread) });
        return { type: 'PMS-BUY', narration: 'Buy ' + absN(t.quantity) + ' ' + symOf(t, ctx) + ' (client)', lines: lines };
    }
    // SELL: Dr Broker [net]; Cr Client [net − spread]; Cr Trader Income [spread].
    function sellClient(t, ctx) {
        var net = absN(t.net_amount !== undefined ? t.net_amount : t.netAmount);
        var spread = r2(absN(t.trader_charges) - absN(t.total_charges));
        var lines = [{ ref: { broker_id: t.broker_id }, debit: r2(net), credit: 0 }, { ref: { investor_id: t.trader_id }, debit: 0, credit: r2(net - spread) }];
        if (Math.round(spread * 100) !== 0) lines.push({ ref: { role: 'TRADER_INCOME' }, debit: 0, credit: r2(spread) });
        return { type: 'PMS-SELL', narration: 'Sell ' + absN(t.quantity) + ' ' + symOf(t, ctx) + ' (client)', lines: lines };
    }
    // Client income / cap-reduction / rights: net between the client account and settlement.
    function incomeClient(t, ctx) {
        var ty = ttype(t), net = absN(t.net_amount !== undefined ? t.net_amount : t.netAmount);
        return { type: 'PMS-' + ty, narration: ty.charAt(0) + ty.slice(1).toLowerCase() + ' ' + symOf(t, ctx) + ' (client)',
            lines: [{ ref: { role: 'PMS_SETTLEMENT' }, debit: r2(net), credit: 0 }, { ref: { investor_id: t.trader_id }, debit: 0, credit: r2(net) }] };
    }
    // Client F&O close: F&O P&L vs the client current account (posted in parent book).
    function fnoClient(t, ctx, gains) {
        if (!ctx.book || !ctx.book.post_fno) return { skip: 'F&O gated off (post_fno)' };
        var pnl = 0; (gains || []).forEach(function (g) { pnl += (g.gain || 0); });
        pnl = r2(pnl); if (Math.round(pnl * 100) === 0) return { skip: 'F&O open / net-zero' };
        var lines = pnl >= 0
            ? [{ ref: { role: 'FNO_PL' }, debit: pnl, credit: 0 }, { ref: { investor_id: t.trader_id }, debit: 0, credit: pnl }]
            : [{ ref: { investor_id: t.trader_id }, debit: -pnl, credit: 0 }, { ref: { role: 'FNO_PL' }, debit: 0, credit: -pnl }];
        return { type: 'PMS-FNO', narration: 'F&O ' + symOf(t, ctx) + ' (client)', lines: lines };
    }

    // ---- Demerger (grouped): Dr each child Investment; Cr parent Investment ---
    // Parses notes: child "Demerger from <SYM> on <DATE>", parent "Demerger of <SYM> on <DATE>".
    function demergerVouchers(demergerTrades, ctx) {
        var groups = {}, out = { vouchers: [], exceptions: [] };
        demergerTrades.forEach(function (t) {
            var n = String(t.notes || '');
            var mFrom = n.match(/Demerger from ([A-Z0-9&._-]+) on (\d{4}-\d{2}-\d{2})/i);
            var mOf = n.match(/Demerger of ([A-Z0-9&._-]+) on (\d{4}-\d{2}-\d{2})/i);
            var m = mOf || mFrom; if (!m) { out.exceptions.push(ex('demerger_unparsed:' + t.id, 'warn', 'Demerger row not parseable', { id: t.id })); return; }
            var key = m[1].toUpperCase() + '|' + m[2];
            if (!groups[key]) groups[key] = { parent: null, children: [] };
            if (mOf) groups[key].parent = t; else groups[key].children.push(t);
        });
        Object.keys(groups).forEach(function (key) {
            var g = groups[key], lines = [];
            if (!g.parent || !g.children.length) { out.exceptions.push(ex('demerger_incomplete:' + key, 'warn', 'Demerger event incomplete: ' + key, {})); return; }
            g.children.forEach(function (c) { lines.push({ ref: { security_id: c.security_id }, debit: r2(absN(c.net_amount)), credit: 0 }); });
            lines.push({ ref: { security_id: g.parent.security_id }, debit: 0, credit: r2(absN(g.parent.net_amount)) });
            if (!voucherBalances(lines)) out.exceptions.push(ex('demerger_unbalanced:' + key, 'critical', 'Demerger does not balance: ' + key, {}));
            out.vouchers.push({ txnId: g.parent.id, type: 'PMS-DEMERGER', date: g.parent.transaction_date, narration: 'Demerger ' + key.split('|')[0], lines: lines });
        });
        return out;
    }

    // ---- per-trade dispatch --------------------------------------------------
    function isFno(t) { var s = String(t.security_type || '').toUpperCase(); return s === 'NFO' || s === 'MCX'; }
    function acctBuildVoucher(t, ctx, gains) {
        var ty = ttype(t);
        if (ty === 'HISTORICAL_PL') return { skip: 'historical (pre-period)' };
        if (ty === 'SPLIT' || ty === 'BONUS' || ty === 'RIGHTS_ENTITLEMENT') return { skip: 'quantity-only, no posting' };
        if (ty === 'DEMERGER') return { skip: 'handled as a grouped event' };
        var client = !!(t.trader_id && String(t.trader_id) !== String(t.investor_id));
        if (isFno(t)) return client ? fnoClient(t, ctx, gains) : fnoOwn(t, ctx, gains);
        if (ty === 'BUY') return client ? buyClient(t, ctx) : buyOwn(t, ctx);
        if (ty === 'SELL') return client ? sellClient(t, ctx) : sellOwn(t, ctx, gains);
        if (ty === 'DIVIDEND' || ty === 'INTEREST' || ty === 'OTHER_INCOME') return client ? incomeClient(t, ctx) : incomeOwn(t, ctx);
        if (ty === 'CAPITAL_REDUCTION') return client ? incomeClient(t, ctx) : capRedOwn(t, ctx);
        if (ty === 'RIGHTS_PAYMENT') return client ? incomeClient(t, ctx) : rightsPayOwn(t, ctx);
        return { skip: 'unrecognised type: ' + ty, exceptions: [ex('unrecognised_type:' + ty, 'warn', 'Unrecognised transaction_type ' + ty, { id: t.id })] };
    }

    // ---- orchestrator --------------------------------------------------------
    // book = { id, post_fno }; trades = this book's transactions (investor_id === book.id).
    // ctx = { securityById, investorById, brokerById, fifo:function(txns){return {gains}} }.
    function acctEngineProcess(book, trades, ctx) {
        ctx.book = book;
        var sttOn = {};
        Object.keys(ctx.investorById).forEach(function (id) { sttOn[id] = !!ctx.investorById[id].stt_accounting_method; });

        var sorted = trades.slice().sort(function (a, b) {
            return String(a.transaction_date).localeCompare(String(b.transaction_date)) ||
                   String(a.transaction_time || '').localeCompare(String(b.transaction_time || '')) ||
                   String(a.created_at || '').localeCompare(String(b.created_at || ''));
        });

        // Shared FIFO on STT-adjusted trades → gains grouped by the SELL txn id.
        var adjusted = wmsSttAdjustTxns(sorted, sttOn);
        var fifo = ctx.fifo(adjusted) || { gains: [] };
        var gainsBySell = {};
        (fifo.gains || []).forEach(function (g) { var k = String(g.sellTxnId); (gainsBySell[k] = gainsBySell[k] || []).push(g); });

        var vouchers = [], exceptions = [], skipped = [], demergers = [];
        sorted.forEach(function (t) {
            if (ttype(t) === 'DEMERGER') { demergers.push(t); return; }
            var v = acctBuildVoucher(t, ctx, gainsBySell[String(t.id)] || []);
            if (v.exceptions) exceptions = exceptions.concat(v.exceptions);
            if (v.skip) { skipped.push({ id: t.id, reason: v.skip }); return; }
            if (!voucherBalances(v.lines)) { exceptions.push(ex('unbalanced:' + t.id, 'critical', 'Voucher does not balance for txn ' + t.id, { type: v.type })); }
            v.txnId = t.id; v.date = t.transaction_date;
            vouchers.push(v);
        });

        var dm = demergerVouchers(demergers, ctx);
        vouchers = vouchers.concat(dm.vouchers);
        exceptions = exceptions.concat(dm.exceptions);

        return { vouchers: vouchers, exceptions: exceptions, skipped: skipped };
    }

    return {
        acctEngineProcess: acctEngineProcess,
        acctBuildVoucher: acctBuildVoucher,
        demergerVouchers: demergerVouchers,
        voucherBalances: voucherBalances
    };
});
