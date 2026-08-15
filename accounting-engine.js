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

    // Client spread — the book bills the client `trader_charges` but pays the broker
    // `total_charges`; the difference is the BOOK's income, posted to Trader Income
    // and borne by the client (owner rule 2026-08-15). Used by income/rights and F&O
    // client vouchers (buy/sell client already bake the spread into their legs).
    function pushSpread(lines, t) {
        var spread = r2(absN(t.trader_charges) - absN(t.total_charges));
        if (Math.round(spread * 100) === 0) return;
        if (spread > 0) { lines.push({ ref: { investor_id: t.trader_id }, debit: spread, credit: 0 }); lines.push({ ref: { role: 'TRADER_INCOME' }, debit: 0, credit: spread }); }
        else { lines.push({ ref: { role: 'TRADER_INCOME' }, debit: -spread, credit: 0 }); lines.push({ ref: { investor_id: t.trader_id }, debit: 0, credit: -spread }); }
    }

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

        // No cost basis — FIFO matched fewer units than were sold (e.g. a holding
        // carried in without an opening lot). Do NOT post a one-legged voucher;
        // raise an anomaly ALERT and skip so the owner fixes it manually (opening
        // balance / cost basis). Owner decision 2026-08-14 (see POSTING-RULES v2 §CG).
        var sold = absN(t.quantity), matched = 0;
        (gains || []).forEach(function (g) { matched += absN(g.qty); });
        if (sold > 0 && matched + 0.0001 < sold) {
            return { skip: 'no cost basis (uncovered ' + r2(sold - matched) + ' of ' + sold + ')',
                exceptions: [ex('sell_no_cost_basis:' + symOf(t, ctx), 'warn',
                    'SELL with no cost basis: ' + symOf(t, ctx),
                    { security_id: t.security_id, symbol: symOf(t, ctx), sold: sold, matched: matched,
                      uncovered: r2(sold - matched), hint: 'needs an opening lot / cost basis; no voucher posted' })] };
        }

        lines.push({ ref: { broker_id: t.broker_id }, debit: r2(net), credit: 0 });
        if (sep && stt > 0) lines.push({ ref: { role: sttRole(sec) }, debit: r2(stt), credit: 0 });
        var cost = 0, byRole = {}, order = [];
        (gains || []).forEach(function (g) {
            cost += (g.buyCost || 0);
            var cls = wmsGainClassify(g, sec);
            var role = (cls.bucket === 'INTRADAY') ? 'INTRADAY_PL' : cls.cgRole;
            if (!role) { exceptions.push(ex('unmapped_cg:' + symOf(t, ctx), 'warn', 'No CG ledger for ' + symOf(t, ctx), { security_id: t.security_id, bucket: cls.bucket })); role = 'CG_ST_SLAB'; }
            if (byRole[role] === undefined) order.push(role);
            byRole[role] = (byRole[role] || 0) + (g.gain || 0);
        });
        lines.push({ ref: { security_id: t.security_id }, debit: 0, credit: r2(cost) });

        // Rounding plug — let the LAST P&L (capital-gain) line absorb the sub-paise
        // residual so the voucher ties EXACTLY (Σdebit === Σcredit). cost and each
        // gain are r2()'d independently, so their rounded sum can miss the rounded
        // proceeds by ±0.01; the post-voucher RPC rejects that. The true identity
        // cost + Σgain === proceeds holds at full precision, so this only moves the
        // residual, never real value. Owner-approved 2026-08-14.
        var cg = [];
        order.forEach(function (role) { var amt = r2(byRole[role]); if (Math.round(amt * 100) !== 0) cg.push({ role: role, amt: amt }); });
        var debitsTotal = r2(net) + ((sep && stt > 0) ? r2(stt) : 0);
        var resid = r2(r2(debitsTotal - r2(cost)) - cg.reduce(function (s, e) { return s + e.amt; }, 0));
        if (Math.abs(resid) >= 0.005 && Math.abs(resid) < 1) {   // rounding only; larger gaps fall through to the unbalanced check
            if (cg.length) cg[cg.length - 1].amt = r2(cg[cg.length - 1].amt + resid);
            else cg.push({ role: (sec.capital_gains && sec.capital_gains.stcg) || 'CG_ST_SLAB', amt: resid });
        }
        cg.forEach(function (e) {
            if (e.amt >= 0) lines.push({ ref: { role: e.role }, debit: 0, credit: e.amt });
            else lines.push({ ref: { role: e.role }, debit: -e.amt, credit: 0 });
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

    // F&O close — OWN (no trader, or trader = investor): gated by the book's
    // post_fno flag. Flag ON → post (Broker vs FNO_PL); flag OFF → no voucher.
    // Owner rule 2026-08-15.
    function fnoOwn(t, ctx, gains) {
        if (!ctx.book || !ctx.book.post_fno) return { skip: 'own F&O — book F&O posting off (post_fno)' };
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
        var lines = [{ ref: { role: 'PMS_SETTLEMENT' }, debit: r2(net), credit: 0 }, { ref: { investor_id: t.trader_id }, debit: 0, credit: r2(net) }];
        pushSpread(lines, t);   // bill the client the book's charge spread (e.g. rights trader_charges)
        return { type: 'PMS-' + ty, narration: ty.charAt(0) + ty.slice(1).toLowerCase() + ' ' + symOf(t, ctx) + ' (client)', lines: lines };
    }
    // Client F&O close: the P&L belongs to the CLIENT (trader ≠ investor), so the
    // client's ledger is updated for EVERY F&O booking, IRRESPECTIVE of the book's
    // post_fno flag (owner rule 2026-08-15). Profit Dr FNO_PL / Cr Trader; loss reverse.
    function fnoClient(t, ctx, gains) {
        var pnl = 0; (gains || []).forEach(function (g) { pnl += (g.gain || 0); });
        pnl = r2(pnl);
        var lines = [];
        if (Math.round(pnl * 100) !== 0) {
            if (pnl >= 0) { lines.push({ ref: { role: 'FNO_PL' }, debit: pnl, credit: 0 }); lines.push({ ref: { investor_id: t.trader_id }, debit: 0, credit: pnl }); }
            else { lines.push({ ref: { investor_id: t.trader_id }, debit: -pnl, credit: 0 }); lines.push({ ref: { role: 'FNO_PL' }, debit: 0, credit: -pnl }); }
        }
        pushSpread(lines, t);   // the charge spread is the book's income on every client F&O leg (owner rule 2026-08-15)
        if (!lines.length) return { skip: 'F&O open / net-zero (no P&L, no spread)' };
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
            var childLines = g.children.map(function (c) { return { ref: { security_id: c.security_id }, debit: r2(absN(c.net_amount)), credit: 0 }; });
            var parentCr = r2(absN(g.parent.net_amount));
            // Rounding plug — the last child absorbs the sub-paise cost-allocation
            // residual so Σ(children) === parent exactly (owner-approved 2026-08-14).
            var resid = r2(parentCr - childLines.reduce(function (s, l) { return s + l.debit; }, 0));
            if (childLines.length && Math.abs(resid) >= 0.005 && Math.abs(resid) < 1) {
                childLines[childLines.length - 1].debit = r2(childLines[childLines.length - 1].debit + resid);
            }
            childLines.forEach(function (l) { lines.push(l); });
            lines.push({ ref: { security_id: g.parent.security_id }, debit: 0, credit: parentCr });
            if (!voucherBalances(lines)) out.exceptions.push(ex('demerger_unbalanced:' + key, 'critical', 'Demerger does not balance: ' + key, {}));
            out.vouchers.push({ txnId: g.parent.id, type: 'PMS-DEMERGER', date: g.parent.transaction_date, narration: 'Demerger ' + key.split('|')[0], lines: lines });
        });
        return out;
    }

    // ---- F&O realised P&L — dedicated matcher --------------------------------
    // F&O P&L must be matched with a SYMMETRIC (long AND short) FIFO, keyed by
    // BENEFICIARY + CONTRACT — never by the book-wide, long-only wmsCalcFifoCost,
    // which pools every trader's trades in a book and cannot cover a short (SELL to
    // open). Mirrors the Statements module (wms-shared.js wmsBuildLedger NFO block),
    // which the owner confirms is correct. Beneficiary = the client (trader) for a
    // client trade, else the book (investor). Contract = full symbol minus any
    // exchange prefix (so APR and MAY futures are distinct). Returns { txnId: pnl }
    // keyed on the COVERING trade; realisedPnl = sell proceeds − buy cost (profit +).
    function acctFnoRealised(trades) {
        var groups = {};
        trades.forEach(function (t) {
            if (!isFno(t)) return;
            var ty = ttype(t); if (ty !== 'BUY' && ty !== 'SELL') return;
            var sym = String(t.symbol || t.short_symbol || '').replace(/^[A-Z]+:/, '');
            var ben = (t.trader_id && String(t.trader_id) !== String(t.investor_id)) ? String(t.trader_id) : String(t.investor_id);
            (groups[ben + '|' + sym] = groups[ben + '|' + sym] || []).push(t);
        });
        var out = {};
        Object.keys(groups).forEach(function (key) {
            var rows = groups[key].slice().sort(function (a, b) {
                return String(a.transaction_date).localeCompare(String(b.transaction_date)) ||
                       String(a.transaction_time || '').localeCompare(String(b.transaction_time || '')) ||
                       String(a.created_at || '').localeCompare(String(b.created_at || ''));
            });
            var lots = [];
            rows.forEach(function (t) {
                var qty = absN(t.quantity); if (!qty) return;
                var perUnit = absN(t.net_amount !== undefined ? t.net_amount : t.netAmount) / qty;
                var isBuy = ttype(t) === 'BUY';
                var openSide = isBuy ? 'LONG' : 'SHORT', coverSide = isBuy ? 'SHORT' : 'LONG';
                var remain = qty, matched = 0, buyCost = 0, sellProc = 0;
                while (remain > 0 && lots.length && lots[0].side === coverSide) {
                    var lot = lots[0], m = Math.min(remain, lot.qty);
                    if (isBuy) { sellProc += m * lot.perUnit; buyCost += m * perUnit; }
                    else { buyCost += m * lot.perUnit; sellProc += m * perUnit; }
                    lot.qty -= m; remain -= m; matched += m; if (lot.qty <= 0) lots.shift();
                }
                if (remain > 0) lots.push({ qty: remain, perUnit: perUnit, side: openSide });
                if (matched > 0) out[String(t.id)] = r2((out[String(t.id)] || 0) + (sellProc - buyCost));
            });
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
        // Equity CG FIFO must run PER BENEFICIARY (own book vs each client), never
        // pooled book-wide — otherwise an own SELL matches a client's lots (the same
        // bug found in F&O). Beneficiary = the client (trader) for a client trade,
        // else the book (investor). The shared wmsCalcFifoCost runs on each slice.
        var byBen = {};
        adjusted.forEach(function (t) {
            var b = (t.trader_id && String(t.trader_id) !== String(t.investor_id)) ? String(t.trader_id) : String(t.investor_id);
            (byBen[b] = byBen[b] || []).push(t);
        });
        var gainsBySell = {};
        Object.keys(byBen).forEach(function (b) {
            var f = ctx.fifo(byBen[b]) || { gains: [] };
            (f.gains || []).forEach(function (g) { var k = String(g.sellTxnId); (gainsBySell[k] = gainsBySell[k] || []).push(g); });
        });

        // F&O realised P&L via the dedicated symmetric/per-beneficiary matcher —
        // OVERRIDE any F&O gains the pooled long-only equity FIFO produced.
        var fnoMap = acctFnoRealised(sorted);
        Object.keys(fnoMap).forEach(function (id) { gainsBySell[id] = [{ gain: fnoMap[id] }]; });

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
        acctFnoRealised: acctFnoRealised,
        voucherBalances: voucherBalances
    };
});
