// ============================================================================
// accounting-engine.js — the WMS accounting posting engine (v2 rebuild).
// Replaces accounting-posting.js. PURE/UMD (browser + node + Deno).
//
// Design: POSTING-RULES.md v4 / EXECUTION-PLAN.md v3.
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
//   PMS_SETTLEMENT, CASH, TDS_YIELD, FNO_PL, TRADER_INCOME, INT_TRADING, and the
//   income roles the security's income_ledgers map points at (INC_*).
//
// Trade vouchers: acctEngineProcess (per book) → acctBuildVoucher (per trade).
// Statement vouchers (acct ledger_entries — interest / cash / recon / opening):
//   acctProcessStatements → acctStatementVoucher. See POSTING-RULES §9.1–9.2.
// Options are CASH premiums (not FIFO); futures use the shared wmsFnoRealised.
// NOTE: feed RAW transactions — never trader-perspective display_net_amount rows —
//   or the STT-adjusted FIFO basis is silently overridden.
// ============================================================================
(function (root, factory) {
    var dep = (typeof module !== 'undefined' && module.exports) ? require('./wms-cost-engine.js') : root;
    var api = factory(dep);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) { for (var k in api) { if (api.hasOwnProperty(k)) root[k] = api[k]; } }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (dep) {

    var wmsGainClassify = dep.wmsGainClassify;
    var wmsSttAdjustTxns = dep.wmsSttAdjustTxns;
    var wmsFnoRealised = dep.wmsFnoRealised;   // shared, authoritative F&O P&L (Statements module source of truth)

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

    // Trader-perspective net — mirrors wms-shared.js wmsComputeDisplayNetAmount so the
    // ledger F&O P&L equals the Statements figure BY CONSTRUCTION. For a CLIENT trade
    // (trader ≠ investor) a BUY/SELL/RIGHTS_PAYMENT nets at the trader's OWN charges
    // (gross ± trader_charges); every other case keeps the raw DB net_amount. Feed this
    // to the F&O matcher so Accounting and Statements can never drift (owner 2026-08-20).
    function acctDisplayNet(t) {
        var inv = String(t.investor_id || '');
        var tr = String(t.trader_id || '') || inv;
        var dbNet = num(t.net_amount !== undefined ? t.net_amount : t.netAmount);
        if (!tr || tr === inv) return dbNet;
        var ty = ttype(t);
        if (ty !== 'BUY' && ty !== 'SELL' && ty !== 'RIGHTS_PAYMENT') return dbNet;
        var gross = absN(t.gross_amount), traderCh = absN(t.trader_charges);
        return r2((ty === 'BUY' || ty === 'RIGHTS_PAYMENT') ? gross + traderCh : gross - traderCh);
    }

    // Posting book — a trade posts in the trader's PARENT book when trader ≠ investor
    // (a client trade managed by another book), else in the investor book. When the
    // trader has no parent it IS its own book. Drives parent-vs-investor routing so a
    // trader's P&L lands in its parent and the investor book skips it (owner 2026-08-20).
    function acctPostingBook(t, ctx) {
        var inv = String(t.investor_id || '');
        var tr = String(t.trader_id || '') || inv;
        // Beneficiary = trader (client) else investor (own). Route to the beneficiary's
        // PARENT book when it has one - INCLUDING the "direct" case trader===investor for
        // a sub-trader (T3's own CS legs post in T0). Owner 2026-08-21.
        var entity = (tr && tr !== inv) ? tr : inv;
        var e = (ctx.investorById || {})[entity] || {};
        var parent = e.book_parent_id ? String(e.book_parent_id) : '';
        return (!parent || parent === entity) ? entity : parent;
    }

    // "Direct" trade: investor === trader AND that entity is a sub-trader (has a parent
    // book). Only these (today: T3's own CS legs) are the legacy direct book kept out of
    // a trader's PMS routing. They post in the parent as a CLIENT trade, with the broker
    // leg on a beneficiary-scoped ledger (e.g. "CS - T3") and NO brokerage spread (the
    // book took no markup). Owner 2026-08-21.
    function acctIsDirect(t, ctx) {
        var inv = String(t.investor_id || '');
        var tr = String(t.trader_id || '') || inv;
        if (tr !== inv) return false;
        var e = (ctx.investorById || {})[inv] || {};
        return !!e.book_parent_id;
    }
    function acctClientSpread(t, ctx) {
        if (acctIsDirect(t, ctx)) return 0;                       // direct: client bears the broker charge in full
        return r2(absN(t.trader_charges) - absN(t.total_charges));
    }
    function acctClientBrokerRef(t, ctx) {
        return acctIsDirect(t, ctx)
            ? { broker_id: t.broker_id, investor_id: String(t.investor_id) }   // scoped "CS - T3" ledger
            : { broker_id: t.broker_id };
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
    // Cr <income ledger> [gross]; Dr TDS on Yield [tds]; Dr PMS Settlement [gross − tds].
    // NOTE: the income module stores net_amount = GROSS (qty × price) and keeps tds in
    // its own field (trading-income.js: "both gross_amount and net_amount store qty ×
    // price; tds is saved separately"). So net_amount IS the gross — settlement is the
    // net cash actually received (gross − tds). Do NOT add tds back onto net_amount, or
    // both income and settlement double-count the TDS (own-book dividend bug, 2026-08-17).
    function incomeOwn(t, ctx) {
        var ty = ttype(t), sec = secOf(t, ctx);
        var gross = absN(t.net_amount !== undefined ? t.net_amount : t.netAmount), tds = absN(t.tds);
        var settle = r2(gross - tds), lines = [], exceptions = [];
        var role = incRole(sec, ty);
        if (!role) { exceptions.push(ex('unmapped_income:' + symOf(t, ctx) + ':' + ty, 'warn', 'No income ledger for ' + symOf(t, ctx) + ' ' + ty, { security_id: t.security_id, type: ty })); role = 'INC_OTHER'; }
        lines.push({ ref: { role: 'PMS_SETTLEMENT' }, debit: settle, credit: 0 });
        if (tds > 0) lines.push({ ref: { role: 'TDS_YIELD' }, debit: r2(tds), credit: 0 });
        lines.push({ ref: { role: role }, debit: 0, credit: r2(gross) });
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

    // OWN option — the premium is CASH, treated EXACTLY as the Statements module does
    // (both premium legs hit the balance; their net across the round-trip IS the
    // realised P&L). No FIFO, no security asset. BUY = premium paid (Dr FNO_PL / Cr
    // Broker); SELL = premium received (Dr Broker / Cr FNO_PL). Gated by post_fno like
    // own futures (owner rule 2026-08-16). Client options route through buyClient/
    // sellClient so the premium lands in the client's account, matching their statement.
    function optionOwn(t, ctx) {
        if (!ctx.book || !ctx.book.post_fno) return { skip: 'own option — book F&O posting off (post_fno)' };
        var net = absN(t.net_amount !== undefined ? t.net_amount : t.netAmount);
        if (Math.round(net * 100) === 0) return { skip: 'option premium net-zero' };
        var lines = (ttype(t) === 'BUY')
            ? [{ ref: { role: 'FNO_PL' }, debit: r2(net), credit: 0 }, { ref: { broker_id: t.broker_id }, debit: 0, credit: r2(net) }]
            : [{ ref: { broker_id: t.broker_id }, debit: r2(net), credit: 0 }, { ref: { role: 'FNO_PL' }, debit: 0, credit: r2(net) }];
        return { type: 'PMS-OPTION', narration: 'Option ' + ttype(t) + ' ' + symOf(t, ctx) + ' (premium)', lines: lines };
    }

    // ---- CLIENT (parent-book) legs: trader ≠ investor -----------------------
    // BUY: Dr Client [net + spread]; Cr Broker [net]; Cr Trader Income [spread].
    function buyClient(t, ctx) {
        var net = absN(t.net_amount !== undefined ? t.net_amount : t.netAmount);
        var spread = acctClientSpread(t, ctx);
        var lines = [{ ref: { investor_id: t.trader_id }, debit: r2(net + spread), credit: 0 }, { ref: acctClientBrokerRef(t, ctx), debit: 0, credit: r2(net) }];
        if (Math.round(spread * 100) !== 0) lines.push({ ref: { role: 'TRADER_INCOME' }, debit: 0, credit: r2(spread) });
        return { type: 'PMS-BUY', narration: 'Buy ' + absN(t.quantity) + ' ' + symOf(t, ctx) + ' (client)', lines: lines };
    }
    // SELL: Dr Broker [net]; Cr Client [net − spread]; Cr Trader Income [spread].
    function sellClient(t, ctx) {
        var net = absN(t.net_amount !== undefined ? t.net_amount : t.netAmount);
        var spread = acctClientSpread(t, ctx);
        var lines = [{ ref: acctClientBrokerRef(t, ctx), debit: r2(net), credit: 0 }, { ref: { investor_id: t.trader_id }, debit: 0, credit: r2(net - spread) }];
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
    // Client RIGHTS_PAYMENT — the CLIENT subscribes to the rights, so the client is
    // charged (Dr) and the book pays the bank (Cr PMS Settlement); the trader-charge
    // spread is the book's income. Mirrors buyClient but the counterparty is PMS
    // Settlement, not the broker (owner rule 2026-08-16; corrects trades 949 / 1126,
    // which previously paid the client instead of billing them).
    function rightsPayClient(t, ctx) {
        var net = absN(t.net_amount !== undefined ? t.net_amount : t.netAmount);
        var spread = r2(absN(t.trader_charges) - absN(t.total_charges));
        var lines = [{ ref: { investor_id: t.trader_id }, debit: r2(net + spread), credit: 0 },
                     { ref: { role: 'PMS_SETTLEMENT' }, debit: 0, credit: r2(net) }];
        if (Math.round(spread * 100) !== 0) lines.push({ ref: { role: 'TRADER_INCOME' }, debit: 0, credit: r2(spread) });
        return { type: 'PMS-RIGHTS_PAYMENT', narration: 'Rights payment ' + symOf(t, ctx) + ' (client)', lines: lines };
    }
    // Client F&O close: the P&L belongs to the CLIENT (trader ≠ investor), so the
    // client's ledger is updated for EVERY F&O booking, IRRESPECTIVE of the book's
    // post_fno flag (owner rule 2026-08-15). The P&L is already struck on the TRADER
    // basis (acctDisplayNet feeds the matcher gross ± trader_charges), so it equals the
    // Statements figure and there is NO separate charge spread for F&O — the trader
    // charges are inside the P&L (owner rule 2026-08-20; the brokerage/charge spread
    // stays an EQ-only concept). The voucher posts in the trader's PARENT book (the
    // engine's posting-book filter routes it there). Profit Dr FNO_PL / Cr Trader; loss reverse.
    function fnoClient(t, ctx, gains) {
        var pnl = 0; (gains || []).forEach(function (g) { pnl += (g.gain || 0); });
        pnl = r2(pnl);
        if (Math.round(pnl * 100) === 0) return { skip: 'F&O open / net-zero (no realised P&L)' };
        var lines = [];
        if (pnl >= 0) { lines.push({ ref: { role: 'FNO_PL' }, debit: pnl, credit: 0 }); lines.push({ ref: { investor_id: t.trader_id }, debit: 0, credit: pnl }); }
        else { lines.push({ ref: { investor_id: t.trader_id }, debit: -pnl, credit: 0 }); lines.push({ ref: { role: 'FNO_PL' }, debit: 0, credit: -pnl }); }
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
        // Key each F&O trade by BENEFICIARY + CONTRACT (client trader, else the book),
        // then defer the actual matching to the shared, authoritative wmsFnoRealised
        // (Statements module's engine). Beneficiary keying lives here because a book's
        // own and its clients' positions in the same contract must not pool.
        var rows = [];
        trades.forEach(function (t) {
            if (!isFno(t) || isOption(t)) return;   // options are cash premiums, not FIFO P&L (match Statements)
            var ty = ttype(t); if (ty !== 'BUY' && ty !== 'SELL') return;
            var contract = String(t.symbol || t.short_symbol || '').replace(/^[A-Z]+:/, '');
            var ben = (t.trader_id && String(t.trader_id) !== String(t.investor_id)) ? String(t.trader_id) : String(t.investor_id);
            rows.push({ key: ben + '|' + contract, type: ty, qty: absN(t.quantity),
                net: absN(acctDisplayNet(t)), id: String(t.id),
                sort: String(t.transaction_date) + '|' + String(t.transaction_time || '') + '|' + String(t.created_at || '') });
        });
        var out = {};
        wmsFnoRealised(rows).forEach(function (r) { out[r.id] = r2((out[r.id] || 0) + r.realisedPnl); });
        return out;
    }

    // ---- per-trade dispatch --------------------------------------------------
    function isFno(t) { var s = String(t.security_type || '').toUpperCase(); return s === 'NFO' || s === 'MCX'; }
    // Option (CE/PE) vs future: options settle as cash premiums (statement treatment),
    // futures settle as realised FIFO P&L. Detect via option_type or the strike+CE/PE suffix.
    function isOption(t) {
        if (t.option_type) return true;
        var s = String(t.symbol || t.short_symbol || '').replace(/^[A-Z]+:/, '');
        return /\d(?:CE|PE)$/.test(s);
    }
    function acctBuildVoucher(t, ctx, gains) {
        var ty = ttype(t);
        if (ty === 'HISTORICAL_PL') return { skip: 'historical (pre-period)' };
        if (ty === 'SPLIT' || ty === 'BONUS' || ty === 'RIGHTS_ENTITLEMENT') return { skip: 'quantity-only, no posting' };
        if (ty === 'DEMERGER') return { skip: 'handled as a grouped event' };
        var _book = (ctx.book && ctx.book.id != null) ? String(ctx.book.id) : null;
        var _ben = (t.trader_id && String(t.trader_id) !== String(t.investor_id)) ? String(t.trader_id) : String(t.investor_id);
        // A trade is a CLIENT trade of THIS book when its beneficiary is not the book -
        // this makes a direct sub-trader trade (T3 own) a client of its parent (T0),
        // not an own trade. Falls back to trader<>investor when ctx.book is absent (unit tests).
        var client = _book ? (_ben !== _book) : !!(t.trader_id && String(t.trader_id) !== String(t.investor_id));
        if (isFno(t)) {
            if (isOption(t)) {   // options: premium is cash (match Statements) — no FIFO P&L
                if (ty === 'BUY') return client ? buyClient(t, ctx) : optionOwn(t, ctx);
                if (ty === 'SELL') return client ? sellClient(t, ctx) : optionOwn(t, ctx);
                return { skip: 'option non-trade type: ' + ty };
            }
            return client ? fnoClient(t, ctx, gains) : fnoOwn(t, ctx, gains);
        }
        if (ty === 'BUY') return client ? buyClient(t, ctx) : buyOwn(t, ctx);
        if (ty === 'SELL') return client ? sellClient(t, ctx) : sellOwn(t, ctx, gains);
        if (ty === 'DIVIDEND' || ty === 'INTEREST' || ty === 'OTHER_INCOME') return client ? incomeClient(t, ctx) : incomeOwn(t, ctx);
        if (ty === 'CAPITAL_REDUCTION') return client ? incomeClient(t, ctx) : capRedOwn(t, ctx);
        if (ty === 'RIGHTS_PAYMENT') return client ? rightsPayClient(t, ctx) : rightsPayOwn(t, ctx);
        return { skip: 'unrecognised type: ' + ty, exceptions: [ex('unrecognised_type:' + ty, 'warn', 'Unrecognised transaction_type ' + ty, { id: t.id })] };
    }

    // ---- Statement postings (acct ledger_entries: interest / cash / recon) ----
    // These come from broker & client STATEMENTS, not the transactions table. The
    // own-book-vs-client split is signalled by broker_id: a book faces the broker
    // DIRECTLY (broker_id set) so its interest/cash is a broker item; a client faces
    // its PARENT book (no broker_id) so the same items flip to the client account.
    // Owner rules 2026-08-16:
    //   INTEREST_BOOKED own    : Dr Trading Interest / Cr Broker  (broker charges the book)
    //   INTEREST_BOOKED client : Dr Client / Cr Trading Interest  (parent charges the client)
    //   CASH_RECEIVED   own    : Dr Cash / Cr Broker              CASH_PAID own    : Dr Broker / Cr Cash
    //   CASH_RECEIVED   client : Dr Cash / Cr Client              CASH_PAID client : Dr Client / Cr Cash
    //   RECONCILIATION         : no voucher      OPENING_BALANCE : no voucher (entered manually)
    function acctStatementVoucher(e, ctx) {
        var ty = String(e.entry_type || '').toUpperCase();
        var amt = absN(e.amount);
        if (ty === 'OPENING_BALANCE') return { skip: 'opening balance — entered manually' };
        if (ty === 'RECONCILIATION')  return { skip: 'reconciliation — no voucher' };
        if (Math.round(amt * 100) === 0) return { skip: 'zero amount' };
        var own = !!e.broker_id;                                                   // book faces the broker directly
        var cp  = own ? { broker_id: e.broker_id } : { investor_id: e.investor_id }; // counterparty leg
        // Posting book: a client (T1..T5) has no book of its own — the voucher posts
        // in its PARENT book (T0), with the client's current account as the line item.
        // An own-book entity (has book_parent_id null/self) posts in its own book.
        var inv = (ctx.investorById || {})[String(e.investor_id)] || {};
        var bookId = (!inv.book_parent_id || String(inv.book_parent_id) === String(e.investor_id))
            ? String(e.investor_id) : String(inv.book_parent_id);
        if (ty === 'INTEREST_BOOKED') {
            var il = own
                ? [{ ref: { role: 'INT_TRADING' }, debit: r2(amt), credit: 0 }, { ref: cp, debit: 0, credit: r2(amt) }]
                : [{ ref: cp, debit: r2(amt), credit: 0 }, { ref: { role: 'INT_TRADING' }, debit: 0, credit: r2(amt) }];
            return { type: 'STMT-INTEREST', bookId: bookId, narration: 'Trading interest' + (e.reference ? ' — ' + e.reference : ''), lines: il };
        }
        if (ty === 'CASH_RECEIVED' || ty === 'CASH_PAID') {
            var recd = (ty === 'CASH_RECEIVED');
            var cash  = { ref: { role: 'CASH' }, debit: recd ? r2(amt) : 0, credit: recd ? 0 : r2(amt) };
            var other = { ref: cp,               debit: recd ? 0 : r2(amt), credit: recd ? r2(amt) : 0 };
            return { type: 'STMT-' + ty, bookId: bookId, narration: (recd ? 'Cash received' : 'Cash paid') + (e.reference ? ' — ' + e.reference : ''), lines: [cash, other] };
        }
        return { skip: 'unhandled entry_type: ' + ty, exceptions: [ex('unhandled_ledger_entry:' + ty, 'warn', 'Unhandled ledger entry_type ' + ty, { id: e.id })] };
    }

    // Batch the statement entries into vouchers (mirror of acctEngineProcess for trades).
    function acctProcessStatements(entries, ctx) {
        var vouchers = [], exceptions = [], skipped = [];
        (entries || []).forEach(function (e) {
            var v = acctStatementVoucher(e, ctx);
            if (v.exceptions) exceptions = exceptions.concat(v.exceptions);
            if (v.skip) { skipped.push({ id: e.id, reason: v.skip }); return; }
            if (!voucherBalances(v.lines)) exceptions.push(ex('stmt_unbalanced:' + e.id, 'critical', 'Statement voucher does not balance ' + e.id, { type: v.type }));
            v.entryId = e.id; v.date = e.entry_date;
            vouchers.push(v);
        });
        return { vouchers: vouchers, exceptions: exceptions, skipped: skipped };
    }

    // ---- orchestrator --------------------------------------------------------
    // book = { id, post_fno }; trades = the book's own transactions PLUS its child
    // traders' transactions (the caller fetches investor=book OR trader∈children).
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

        // Posting-book routing (owner rule 2026-08-20): keep only the trades that
        // belong to THE BOOK being processed — a client trade (trader ≠ investor)
        // posts in the trader's PARENT book, an own trade in the investor book. This
        // makes a trader's buy+sell pool together in the parent's run (so the F&O
        // matcher can cover the round-trip) and makes the investor book skip them
        // entirely. Non-client trades are unaffected — their posting book IS this book.
        sorted = sorted.filter(function (t) { return acctPostingBook(t, ctx) === String(book.id); });

        // Shared FIFO on STT-adjusted trades → gains grouped by the SELL txn id.
        var adjusted = wmsSttAdjustTxns(sorted, sttOn);
        // Equity CG FIFO — pooling level gated on the BOOK's stt_accounting_method
        // (owner 2026-08-21, refining the 2026-08-15 book-level decision):
        //   • STT accounted SEPARATELY (family investor books — VB/HUF/KDB/AJ/Veins/
        //     Zoulz) → POOL at BOOK level: one tax P&L for the whole demat, so a
        //     trader split would wrongly fragment the FIFO tax lots.
        //   • STT IN COST (T0 + PMS trader books) → POOL PER BENEFICIARY: there is no
        //     separate book tax return, so a book's own lots and each client's lots in
        //     the same scrip must not mix. Mirrors acctFnoRealised (F&O already keyed
        //     per beneficiary). Gains are keyed by sellTxnId, so merging disjoint
        //     per-beneficiary groups is exact.
        var bookSttSep = !!(ctx.investorById[String(book.id)] || {}).stt_accounting_method;
        var fifo;
        if (bookSttSep) {
            fifo = ctx.fifo(adjusted) || { gains: [] };            // book-level pooled (unchanged)
        } else {
            var _byBen = {};
            adjusted.forEach(function (t) {
                var ben = (t.trader_id && String(t.trader_id) !== String(t.investor_id)) ? String(t.trader_id) : String(t.investor_id);
                (_byBen[ben] = _byBen[ben] || []).push(t);
            });
            var _g = [];
            Object.keys(_byBen).forEach(function (k) { _g = _g.concat((ctx.fifo(_byBen[k]) || { gains: [] }).gains || []); });
            fifo = { gains: _g };
        }
        var gainsBySell = {};
        (fifo.gains || []).forEach(function (g) { var k = String(g.sellTxnId); (gainsBySell[k] = gainsBySell[k] || []).push(g); });

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

    // ---- Mutual-fund postings (mf_trades — fractional units, separate table) ----
    // The 3rd PMS source. Counterparty is ALWAYS PMS_SETTLEMENT, never a broker
    // (owner rule 2026-08-18) — so MF does NOT reuse buyOwn/sellOwn (those credit the
    // broker). BUY: Dr Investment / Cr PMS Settlement. REDEMPTION: Dr PMS Settlement /
    // Cr Investment (FIFO cost) / CG via the security's capital_gains map (liquid =
    // always slab). DIV_REINVEST: Dr Investment / Cr income. DIV_PAYOUT: Dr PMS
    // Settlement / Cr income. No STT (MF `stt` is not tracked in mf_trades).
    function acctMfIncomeRole(sec) {
        var m = (sec && sec.income_ledgers) || {};
        return m.DIVIDEND || m.INTEREST || m.OTHER_INCOME || 'INC_OTHER';
    }
    function acctProcessMfTrades(mfTrades, ctx) {
        var rows = (mfTrades || []).slice().sort(function (a, b) {
            return String(a.txn_date).localeCompare(String(b.txn_date)) || String(a.id).localeCompare(String(b.id));
        });
        // Pseudo-transactions for the shared FIFO (BUY adds a lot, SELL matches by date).
        var pt = rows.map(function (r) {
            var tt = (r.txn_type === 'REDEMPTION') ? 'SELL' : 'BUY';   // PURCHASE / DIV_REINVEST add units
            return { id: r.id, security_id: r.security_id, security_type: secOf(r, ctx).security_type,
                     transaction_type: tt, quantity: absN(r.units), net_amount: absN(r.amount),
                     transaction_date: r.txn_date, stt: 0 };
        });
        var fifo = ctx.fifo(pt) || { gains: [] };
        var gainsBySell = {};
        (fifo.gains || []).forEach(function (g) { var k = String(g.sellTxnId); (gainsBySell[k] = gainsBySell[k] || []).push(g); });

        var vouchers = [], exceptions = [], skipped = [];
        rows.forEach(function (r) {
            var sec = secOf(r, ctx), amt = absN(r.amount), tt = String(r.txn_type || '').toUpperCase(), nm = symOf(r, ctx) || 'MF', lines = [], type;
            if (tt === 'PURCHASE') {
                lines.push({ ref: { security_id: r.security_id }, debit: r2(amt), credit: 0 });
                lines.push({ ref: { role: 'PMS_SETTLEMENT' }, debit: 0, credit: r2(amt) });
                type = 'PMS-MF-BUY';
            } else if (tt === 'DIV_REINVEST') {
                lines.push({ ref: { security_id: r.security_id }, debit: r2(amt), credit: 0 });
                lines.push({ ref: { role: acctMfIncomeRole(sec) }, debit: 0, credit: r2(amt) });
                type = 'PMS-MF-DIVREINV';
            } else if (tt === 'DIV_PAYOUT') {
                lines.push({ ref: { role: 'PMS_SETTLEMENT' }, debit: r2(amt), credit: 0 });
                lines.push({ ref: { role: acctMfIncomeRole(sec) }, debit: 0, credit: r2(amt) });
                type = 'PMS-MF-DIVPAYOUT';
            } else if (tt === 'REDEMPTION') {
                var gains = gainsBySell[String(r.id)] || [], sold = absN(r.units), matched = 0;
                gains.forEach(function (g) { matched += absN(g.qty); });
                if (sold > 0 && matched + 0.0001 < sold) {
                    skipped.push({ id: r.id, reason: 'no cost basis' });
                    exceptions.push(ex('mf_sell_no_cost_basis:' + nm, 'warn', 'MF redemption with no cost basis: ' + nm,
                        { security_id: r.security_id, sold: sold, matched: matched, uncovered: r2(sold - matched) }));
                    return;
                }
                lines.push({ ref: { role: 'PMS_SETTLEMENT' }, debit: r2(amt), credit: 0 });      // proceeds
                var cost = 0, byRole = {}, order = [];
                gains.forEach(function (g) {
                    cost += (g.buyCost || 0);
                    var cls = wmsGainClassify(g, sec);
                    var role = (cls.bucket === 'INTRADAY') ? 'INTRADAY_PL' : cls.cgRole;
                    if (!role) { exceptions.push(ex('mf_unmapped_cg:' + nm, 'warn', 'No CG ledger for ' + nm, { security_id: r.security_id })); role = 'CG_ST_SLAB'; }
                    if (byRole[role] === undefined) order.push(role);
                    byRole[role] = (byRole[role] || 0) + (g.gain || 0);
                });
                lines.push({ ref: { security_id: r.security_id }, debit: 0, credit: r2(cost) });
                var cg = [];
                order.forEach(function (role) { var a = r2(byRole[role]); if (Math.round(a * 100) !== 0) cg.push({ role: role, amt: a }); });
                // Rounding plug — last CG line absorbs the sub-paise residual so it ties.
                var resid = r2(r2(r2(amt) - r2(cost)) - cg.reduce(function (s, e) { return s + e.amt; }, 0));
                if (Math.abs(resid) >= 0.005 && cg.length) cg[cg.length - 1].amt = r2(cg[cg.length - 1].amt + resid);
                else if (Math.abs(resid) >= 0.005) cg.push({ role: (sec.capital_gains && sec.capital_gains.stcg) || 'CG_ST_SLAB', amt: resid });
                cg.forEach(function (e) {
                    if (e.amt >= 0) lines.push({ ref: { role: e.role }, debit: 0, credit: e.amt });
                    else lines.push({ ref: { role: e.role }, debit: -e.amt, credit: 0 });
                });
                type = 'PMS-MF-SELL';
            } else { skipped.push({ id: r.id, reason: 'unknown mf txn_type ' + tt }); return; }

            if (!voucherBalances(lines)) { exceptions.push(ex('mf_unbalanced:' + r.id, 'critical', 'MF voucher does not balance for ' + nm, { mfId: r.id, type: type })); }
            vouchers.push({ mfId: r.id, type: type, date: r.txn_date, narration: (type === 'PMS-MF-SELL' ? 'MF redeem ' : 'MF buy ') + nm, lines: lines });
        });
        return { vouchers: vouchers, exceptions: exceptions, skipped: skipped };
    }

    return {
        acctEngineProcess: acctEngineProcess,
        acctBuildVoucher: acctBuildVoucher,
        acctStatementVoucher: acctStatementVoucher,
        acctProcessStatements: acctProcessStatements,
        acctProcessMfTrades: acctProcessMfTrades,
        demergerVouchers: demergerVouchers,
        acctFnoRealised: acctFnoRealised,
        voucherBalances: voucherBalances
    };
});
