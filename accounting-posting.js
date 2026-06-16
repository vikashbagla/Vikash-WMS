// ============================================================================
// WMS ACCOUNTING — POSTING ENGINE (Phase 2)
// Pure, DB-free engine. Given a book's transactions it emits balanced vouchers.
// Namespace: acct. See WMS_Accounting_Module_Plan.md §6 + WMS-LESSONS §A.6.1.
//
// DESIGN
//  - PURE: no DB, no wmsRefData. Caller passes a small ctx for name lookups.
//  - Ledgers are referenced by a logical KEY object {key,name,kind,group,...};
//    a separate resolver (in accounting.js) maps keys -> acct_ledgers ids.
//  - Per-book FIFO lot state for OWN equity (cost basis = capitalised cost).
//  - Charges are CAPITALISED into investment cost; STT is capitalised by default
//    or expensed separately when the book's stt_accounting_method is true.
//  - Realised gains recognised AT SALE on FIFO, split ST/LT by holding period.
//  - Client/party beneficiaries: the trade nets to a current-account ledger
//    (no investment, no FIFO) — see §6.4. F&O is just a cash movement for them.
//  - OWN F&O P&L is DEFERRED (returns a skip) — needs its own FIFO-P&L pass.
//
// Rule A.1.2: var only (avoid TDZ on browser script reload).
// ============================================================================

// Wrapped in an IIFE so NONE of the internal helpers leak as globals — this
// engine defines names like `acctNum` that would otherwise collide with the
// currency formatter of the same name in accounting.js (A.1.3). Only the public
// API is exported at the bottom.
(function () {

var ACCT_NO_VOUCHER_TYPES = { BONUS: 1, SPLIT: 1, RIGHTS_ENTITLEMENT: 1, HISTORICAL_PL: 1 };
var ACCT_INCOME_TYPES = { DIVIDEND: 'Dividend Income', INTEREST: 'Interest Income', OTHER_INCOME: 'Other Income' };
// Securities treated as "debt" for the 36-month LT threshold; everything else 12 months.
var ACCT_DEBT_TYPES = { NCD: 1, GOVT_BOND: 1, SGB: 1 };

function acctNum(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
function acctR2(v) { return Math.round((acctNum(v)) * 100) / 100; }
function acctIsFno(t) { return (t.security_type || '') === 'NFO'; }

function acctMonthsBetween(fromYmd, toYmd) {
    // whole-month difference; used only for ST/LT classification
    var a = new Date(fromYmd), b = new Date(toYmd);
    if (isNaN(a) || isNaN(b)) return 0;
    var months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    if (b.getDate() < a.getDate()) months -= 1;
    return months;
}
function acctIsLongTerm(secType, buyYmd, sellYmd) {
    var threshold = ACCT_DEBT_TYPES[secType] ? 36 : 12;
    return acctMonthsBetween(buyYmd, sellYmd) >= threshold;
}

// ---- Ledger key constructors -----------------------------------------------
function acctKeyInvestment(txn) {
    return { key: 'SEC:' + (txn.security_id || txn.symbol), name: (txn.short_symbol || txn.company_name || txn.symbol || 'Investment'),
             kind: 'PMS_SECURITY', group: 'Investments' };
}
function acctKeyBroker(txn, ctx) {
    var name = ctx.brokerName(txn.broker_id) || 'Broker';
    return { key: 'BRK:' + (txn.broker_id || name), name: name, kind: 'PMS_BROKER', group: 'Broker Accounts' };
}
function acctKeyCounterparty(benId, benName, bookId) {
    return { key: 'CLI:' + benId, name: 'Client – ' + (benName || benId), kind: 'CLIENT_ACCOUNT',
             group: 'Client Accounts', isGlobal: false, scopeInvestorId: bookId };
}
function acctKeySystem(name, kind, group) { return { key: 'SYS:' + name, name: name, kind: kind, group: group }; }
var ACCT_SYS = {
    pmsAdj: function () { return acctKeySystem('PMS Adjustment', 'PMS_ADJUSTMENT', 'Current Assets'); },
    tds: function () { return acctKeySystem('TDS Receivable', 'TDS_RECEIVABLE', 'Current Assets'); },
    stt: function () { return acctKeySystem('STT', 'STT_EXPENSE', 'Transaction Charges'); },
    cgST: function () { return acctKeySystem('Realised Capital Gains (ST)', 'REALISED_GAIN', 'Capital Gains'); },
    cgLT: function () { return acctKeySystem('Realised Capital Gains (LT)', 'REALISED_GAIN', 'Capital Gains'); },
    income: function (name) { return acctKeySystem(name, 'INCOME', 'Trading & Other Income'); },
    fnoProfit: function () { return acctKeySystem('F&O Trading Profit', 'FNO_PL', 'F&O Income'); },
    fnoLoss: function () { return acctKeySystem('F&O Trading Loss', 'FNO_PL', 'F&O Expenses'); }
};

// ---- A tiny line builder that keeps Dr/Cr non-negative ----------------------
function acctLine(ledgerKey, debit, credit, narration) {
    return { ledger: ledgerKey, debit: acctR2(debit || 0), credit: acctR2(credit || 0), narration: narration || '' };
}
// Post a signed amount to a ledger: positive => debit, negative => credit.
function acctSignedDebit(ledgerKey, amount, narration) {
    amount = acctR2(amount);
    return amount >= 0 ? acctLine(ledgerKey, amount, 0, narration) : acctLine(ledgerKey, 0, -amount, narration);
}

// ============================================================================
// FIFO lot store (per security, within one book)
// ============================================================================
function acctNewFifo() { return {}; }   // securityKey -> [ {qty, cost, date} ]
function acctSecKey(txn) { return txn.security_id || txn.symbol; }

function acctFifoPush(fifo, txn, qty, cost) {
    var k = acctSecKey(txn);
    (fifo[k] = fifo[k] || []).push({ qty: qty, cost: acctR2(cost), date: txn.transaction_date });
}
// Consume qty FIFO; returns { portions:[{qty,cost,date}], totalCost, shortfall }
function acctFifoConsume(fifo, txn, qty) {
    var k = acctSecKey(txn);
    var lots = fifo[k] || [];
    var remaining = qty, totalCost = 0, portions = [];
    while (remaining > 0 && lots.length) {
        var lot = lots[0];
        var take = Math.min(lot.qty, remaining);
        var portionCost = (lot.qty > 0) ? acctR2(lot.cost * (take / lot.qty)) : 0;
        portions.push({ qty: take, cost: portionCost, date: lot.date });
        totalCost += portionCost;
        lot.qty -= take; lot.cost = acctR2(lot.cost - portionCost);
        remaining -= take;
        if (lot.qty <= 0) lots.shift();
    }
    return { portions: portions, totalCost: acctR2(totalCost), shortfall: remaining };
}
// Reduce cost basis FIFO (capital reduction). Returns { applied, excess }.
function acctFifoReduceCost(fifo, txn, amount) {
    var k = acctSecKey(txn);
    var lots = fifo[k] || [];
    var remaining = amount, applied = 0;
    for (var i = 0; i < lots.length && remaining > 0.005; i++) {
        var take = Math.min(lots[i].cost, remaining);
        lots[i].cost = acctR2(lots[i].cost - take);
        applied += take; remaining -= take;
    }
    return { applied: acctR2(applied), excess: acctR2(Math.max(0, remaining)) };
}
// Add cost to existing holding (rights payment) without changing qty.
function acctFifoAddCost(fifo, txn, amount) {
    var k = acctSecKey(txn);
    var lots = fifo[k] || (fifo[k] = []);
    if (lots.length) { lots[0].cost = acctR2(lots[0].cost + amount); }
    else { lots.push({ qty: Math.abs(acctNum(txn.quantity)), cost: acctR2(amount), date: txn.transaction_date }); }
}

// ============================================================================
// Beneficiary relationship
// ============================================================================
function acctRelationship(txn, bookId, ctx) {
    var benId = txn.trader_id || txn.investor_id;
    if (benId === bookId) return { rel: 'OWN', benId: benId };
    var ben = ctx.investor(benId) || {};
    if (ben.book_parent_id === bookId) return { rel: 'CLIENT', benId: benId, benName: ben.short_name || ben.name };
    // any other non-own beneficiary -> a counterparty current account in this book
    return { rel: 'PARTY', benId: benId, benName: ben.short_name || ben.name };
}

// ============================================================================
// F&O FIFO P&L — P&L-only (no balance-sheet position), like the Statements
// module. Positions are keyed by BENEFICIARY + contract, so own and each
// client's F&O net independently. Charges of BOTH legs are netted into the
// realised P&L at close (open-leg charges are deferred until the close).
// ============================================================================
function acctFnoKey(benId, txn) {
    var contract = (txn.symbol || '').replace(/^[A-Z]+:/, '');   // strip exchange prefix (A.2.13)
    return benId + '|' + (txn.security_id || contract);
}
// Returns realised net P&L for this trade (mutates the position store `fno`).
function acctFnoMatch(fno, txn, benId) {
    var key = acctFnoKey(benId, txn);
    var lots = fno[key] || (fno[key] = []);
    var mag = Math.abs(acctNum(txn.quantity));
    var dir = (txn.transaction_type === 'BUY') ? 1 : -1;
    var price = acctNum(txn.price);
    var chargePerUnit = mag > 0 ? acctNum(txn.total_charges) / mag : 0;
    var realised = 0, remaining = mag;
    // close opposite-sign lots FIFO
    while (remaining > 0 && lots.length && (lots[0].qty > 0 ? 1 : -1) === -dir) {
        var lot = lots[0];
        var take = Math.min(Math.abs(lot.qty), remaining);
        var grossPnl = (lot.qty > 0)
            ? (price - lot.price) * take      // long lot closed by a SELL
            : (lot.price - price) * take;     // short lot closed by a BUY
        realised += grossPnl - (lot.chargePerUnit * take) - (chargePerUnit * take);
        lot.qty = (lot.qty > 0) ? (lot.qty - take) : (lot.qty + take);
        if (Math.abs(lot.qty) < 1e-9) lots.shift();
        remaining -= take;
    }
    // any remainder opens a new lot in the trade's direction
    if (remaining > 0) lots.push({ qty: dir * remaining, price: price, chargePerUnit: chargePerUnit, date: txn.transaction_date });
    return acctR2(realised);
}
// Build the F&O voucher (or a skip for a pure open / net-zero). post_fno is
// checked by the caller. OWN → Broker vs F&O Trading P&L; client/party →
// Broker vs the client current account.
function acctBuildFno(txn, bookId, ctx, fno, relInfo) {
    var pnl = acctFnoMatch(fno, txn, relInfo.benId);
    if (Math.abs(pnl) < 0.005) return { skip: 'F&O ' + txn.transaction_type + ' (opening / no realised P&L)' };
    var sym = txn.short_symbol || txn.symbol || '';
    var broker = acctKeyBroker(txn, ctx);
    var counter = (relInfo.rel === 'OWN')
        ? ((pnl > 0) ? ACCT_SYS.fnoProfit() : ACCT_SYS.fnoLoss())
        : acctKeyCounterparty(relInfo.benId, relInfo.benName, bookId);
    var nar = sym + ' · F&O ' + txn.transaction_type + (relInfo.rel === 'OWN' ? '' : ' (' + (relInfo.benName || 'client') + ')');
    var lines = (pnl > 0)
        ? [acctLine(broker, pnl, 0), acctLine(counter, 0, pnl)]      // profit: cash in, credit P&L/client
        : [acctLine(counter, -pnl, 0), acctLine(broker, 0, -pnl)];   // loss: debit P&L/client, cash out
    return { voucherType: 'PMS-FNO', narration: nar, lines: lines };
}

// ============================================================================
// Per-transaction voucher builder
// Returns { voucherType, narration, lines:[...] } | { skip:reason }
// Mutates `fifo` (OWN equity lots) and `fno` (F&O positions).
// ============================================================================
function acctBuildOne(txn, bookId, ctx, fifo, fno, sttSeparate) {
    var type = txn.transaction_type;
    var relInfo = acctRelationship(txn, bookId, ctx);
    var rel = relInfo.rel;
    var gross = acctNum(txn.gross_amount);
    var charges = acctNum(txn.total_charges);
    var stt = acctNum(txn.stt);
    var sym = txn.short_symbol || txn.symbol || '';

    // ---- Types that never post a financial voucher (own side affects FIFO) ----
    if (ACCT_NO_VOUCHER_TYPES[type]) {
        if (rel === 'OWN' && (type === 'BONUS' || type === 'SPLIT' || type === 'RIGHTS_ENTITLEMENT') && !acctIsFno(txn)) {
            // qty added at zero cost (lowers average cost); no cash, no voucher
            acctFifoPush(fifo, txn, Math.abs(acctNum(txn.quantity)), 0);
        }
        return { skip: type === 'HISTORICAL_PL' ? 'HISTORICAL_PL ignored (FIFO books)' : (type + ' has no cash effect') };
    }

    // ---- F&O (own OR client): P&L-only on FIFO close, gated by the book's post_fno ----
    if (acctIsFno(txn) && (type === 'BUY' || type === 'SELL')) {
        if (!ctx.postFno) return { skip: 'F&O posting off for this book (post_fno=false)' };
        return acctBuildFno(txn, bookId, ctx, fno, relInfo);
    }

    // ---- CLIENT / PARTY: net cash movement to a current account ----------------
    if (rel !== 'OWN') {
        var cp = acctKeyCounterparty(relInfo.benId, relInfo.benName, bookId);
        var nar = sym + ' · ' + type + ' (' + (relInfo.benName || 'client') + ')';
        if (type === 'BUY') {
            return { voucherType: 'PMS-BUY', narration: nar,
                lines: [acctLine(cp, gross + charges, 0), acctLine(acctKeyBroker(txn, ctx), 0, gross + charges)] };
        }
        if (type === 'SELL') {
            return { voucherType: 'PMS-SELL', narration: nar,
                lines: [acctLine(acctKeyBroker(txn, ctx), gross - charges, 0), acctLine(cp, 0, gross - charges)] };
        }
        // income / capital reduction (cash in to client) vs rights payment (cash out)
        var amt = Math.abs(acctNum(txn.net_amount)) || (gross - acctNum(txn.tds));
        if (type === 'RIGHTS_PAYMENT') {
            return { voucherType: 'PMS-RIGHTS_PAYMENT', narration: nar,
                lines: [acctLine(cp, amt, 0), acctLine(ACCT_SYS.pmsAdj(), 0, amt)] };
        }
        // DIVIDEND / INTEREST / OTHER_INCOME / CAPITAL_REDUCTION
        var vt = ACCT_INCOME_TYPES[type] ? ('PMS-' + type) : 'PMS-' + type;
        return { voucherType: vt, narration: nar,
            lines: [acctLine(ACCT_SYS.pmsAdj(), amt, 0), acctLine(cp, 0, amt)] };
    }

    // ---- OWN equity-like (F&O already handled above) --------------------------
    if (type === 'BUY') {
        var cost = sttSeparate ? (gross + charges - stt) : (gross + charges);
        acctFifoPush(fifo, txn, Math.abs(acctNum(txn.quantity)), cost);
        var lines = [acctLine(acctKeyInvestment(txn), cost, 0, sym)];
        if (sttSeparate && stt > 0) lines.push(acctLine(ACCT_SYS.stt(), stt, 0));
        lines.push(acctLine(acctKeyBroker(txn, ctx), 0, gross + charges));
        return { voucherType: 'PMS-BUY', narration: sym + ' · BUY', lines: lines };
    }

    if (type === 'SELL') {
        var qty = Math.abs(acctNum(txn.quantity));   // SELL quantity is stored negative in the data
        var consumed = acctFifoConsume(fifo, txn, qty);
        var netSell = gross - charges;
        var proceedsForCg = sttSeparate ? (netSell + stt) : netSell;   // STT excluded from CG when separate
        // allocate proceeds pro-rata across consumed qty (incl shortfall) + classify ST/LT
        var cgST = 0, cgLT = 0, warn = null;
        var allocBase = qty > 0 ? qty : 1;
        consumed.portions.forEach(function (p) {
            var pProceeds = proceedsForCg * (p.qty / allocBase);
            var pCg = pProceeds - p.cost;
            if (acctIsLongTerm(txn.security_type, p.date, txn.transaction_date)) cgLT += pCg; else cgST += pCg;
        });
        if (consumed.shortfall > 0) {
            var sProceeds = proceedsForCg * (consumed.shortfall / allocBase);
            cgST += sProceeds; // no cost basis available -> full proceeds as ST gain
            warn = 'SELL of ' + sym + ' exceeded known FIFO lots by ' + consumed.shortfall + ' (no cost basis; needs opening balance)';
        }
        cgST = acctR2(cgST); cgLT = acctR2(cgLT);
        var slines = [acctLine(acctKeyBroker(txn, ctx), netSell, 0)];
        if (sttSeparate && stt > 0) slines.push(acctLine(ACCT_SYS.stt(), stt, 0));
        slines.push(acctLine(acctKeyInvestment(txn), 0, consumed.totalCost, sym));
        if (Math.abs(cgST) >= 0.005) slines.push(acctSignedDebit(ACCT_SYS.cgST(), -cgST)); // gain=credit
        if (Math.abs(cgLT) >= 0.005) slines.push(acctSignedDebit(ACCT_SYS.cgLT(), -cgLT));
        return { voucherType: 'PMS-SELL', narration: sym + ' · SELL', lines: slines, warn: warn };
    }

    if (ACCT_INCOME_TYPES[type]) {
        var inGross = gross || Math.abs(acctNum(txn.net_amount));
        var tds = acctNum(txn.tds);
        var inNet = inGross - tds;
        var ilines = [acctLine(ACCT_SYS.pmsAdj(), inNet, 0)];
        if (tds > 0) ilines.push(acctLine(ACCT_SYS.tds(), tds, 0));
        ilines.push(acctLine(ACCT_SYS.income(ACCT_INCOME_TYPES[type]), 0, inGross));
        return { voucherType: 'PMS-' + type, narration: sym + ' · ' + type, lines: ilines };
    }

    if (type === 'CAPITAL_REDUCTION') {
        var crAmt = Math.abs(acctNum(txn.net_amount)) || gross;
        var red = acctFifoReduceCost(fifo, txn, crAmt);
        var clines = [acctLine(ACCT_SYS.pmsAdj(), crAmt, 0), acctLine(acctKeyInvestment(txn), 0, red.applied, sym)];
        if (red.excess > 0) clines.push(acctLine(ACCT_SYS.cgLT(), 0, red.excess)); // excess over cost = gain
        return { voucherType: 'PMS-CAPITAL_REDUCTION', narration: sym + ' · Capital reduction', lines: clines };
    }

    if (type === 'RIGHTS_PAYMENT') {
        var rpAmt = Math.abs(acctNum(txn.net_amount)) || gross;
        acctFifoAddCost(fifo, txn, rpAmt);
        return { voucherType: 'PMS-RIGHTS_PAYMENT', narration: sym + ' · Rights payment',
            lines: [acctLine(acctKeyInvestment(txn), rpAmt, 0, sym), acctLine(ACCT_SYS.pmsAdj(), 0, rpAmt)] };
    }

    return { skip: 'Unhandled transaction_type: ' + type };
}

// ============================================================================
// Public: process a whole book
//   bookId : investor id of the book (own-books)
//   txns   : array of transaction rows (any order)
//   ctx    : { investor(id)->{...}, brokerName(id)->str, sttSeparate(bool) }
// Returns { vouchers:[{txnId, voucherType, date, narration, lines}], skipped, warnings }
// ============================================================================
function acctProcessBook(bookId, txns, ctx) {
    var sttSeparate = !!ctx.sttSeparate;
    var fifo = acctNewFifo();
    var fno = {};   // F&O positions keyed by beneficiary+contract
    var sorted = (txns || []).slice().sort(function (a, b) {
        if (a.transaction_date !== b.transaction_date) return a.transaction_date < b.transaction_date ? -1 : 1;
        var at = a.transaction_time || '00:00:00', bt = b.transaction_time || '00:00:00';
        if (at !== bt) return at < bt ? -1 : 1;
        return (a.created_at || '') < (b.created_at || '') ? -1 : 1;
    });
    var vouchers = [], skipped = [], warnings = [];
    sorted.forEach(function (txn) {
        var res = acctBuildOne(txn, bookId, ctx, fifo, fno, sttSeparate);
        if (!res) { skipped.push({ txnId: txn.id, reason: 'null result' }); return; }
        if (res.skip) { skipped.push({ txnId: txn.id, reason: res.skip }); return; }
        if (res.warn) warnings.push({ txnId: txn.id, warn: res.warn });
        // sanity: balance
        var dr = 0, cr = 0;
        res.lines.forEach(function (l) { dr += l.debit; cr += l.credit; });
        if (Math.round(dr * 100) !== Math.round(cr * 100)) {
            warnings.push({ txnId: txn.id, warn: 'UNBALANCED voucher (' + res.voucherType + '): Dr ' + acctR2(dr) + ' Cr ' + acctR2(cr) });
        }
        res.lines.forEach(function (l, i) { l.sort_order = i; });
        vouchers.push({ txnId: txn.id, voucherType: res.voucherType, date: txn.transaction_date,
            narration: res.narration, lines: res.lines, totalDebit: acctR2(dr), totalCredit: acctR2(cr) });
    });
    return { vouchers: vouchers, skipped: skipped, warnings: warnings };
}

// ---- exports (Node test harness + browser global) --------------------------
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { acctProcessBook: acctProcessBook, acctBuildOne: acctBuildOne, acctNewFifo: acctNewFifo,
        acctKeyInvestment: acctKeyInvestment, ACCT_SYS: ACCT_SYS };
}
if (typeof window !== 'undefined') { window.acctProcessBook = acctProcessBook; }

})();
