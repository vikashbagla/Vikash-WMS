// ============================================================================
// WMS CONTRACT NOTE VIEWER (cn-viewer.js)
// ----------------------------------------------------------------------------
// Read-only modal that aggregates every transaction sharing the same
// (investor_id, broker_id, broker_contract_note_no) and displays them as a
// single Contract Note view. No DB writes, no in-memory mutations — pure
// rendering over the caller's already-loaded transactions array.
//
// PUBLIC API
//   wmsCnViewerOpen(investorId, brokerId, cnNumber, transactions)
//     - transactions = the caller's already-in-memory snake_case array
//       (e.g. trTransactions for Trading, wmsTxnCtx.transactions for the
//       shared edit modal). Filtering happens in-memory; zero network.
//   wmsCnViewerClose()
//
// USAGE
//   From Edit modal: wmsCnViewerOpen(txn.investor_id, txn.broker_id,
//                                    txn.broker_contract_note_no,
//                                    wmsTxnCtx.transactions)
//   From Trading list action menu: same, passing trTransactions.
//
// SCOPE (V1)
//   - Trigger from Edit modal (View link next to Contract Note No field)
//   - Trigger from Transactions list (action menu item, only when the row
//     has a CN number)
//   - Aggregated totals row in <tfoot>
//   - No "Recent CNs" tab (out of scope V1)
//   - No PDF archive (Phase 2)
//   - No charges-reconciliation gap analysis (Phase 2)
//
// Rule A.1.2: all declarations use var.
// ============================================================================

var _wmsCnViewerDomReady = false;

// ============================================================================
// HELPERS — investor/broker lookup from wmsRefData (module-agnostic)
// ============================================================================

function _wmsCnInvestor(investorId) {
    if (!investorId || !wmsRefData || !wmsRefData.investorObjMap) return null;
    return wmsRefData.investorObjMap[investorId] || null;
}

function _wmsCnInvName(investorId) {
    var inv = _wmsCnInvestor(investorId);
    if (!inv) return investorId || '-';
    return inv.short_name || inv.name || investorId || '-';
}

function _wmsCnBroker(brokerId) {
    if (!brokerId || !wmsRefData || !wmsRefData.brokerObjMap) return null;
    return wmsRefData.brokerObjMap[brokerId] || null;
}

function _wmsCnBrokerName(brokerId) {
    var brk = _wmsCnBroker(brokerId);
    if (!brk) return brokerId || '-';
    return brk.name || brk.broker_code || brokerId || '-';
}

function _wmsCnFmtAmt(v) {
    if (typeof wmsFmtAmt === 'function') return wmsFmtAmt(v);
    if (v === null || v === undefined || isNaN(v)) return '0.00';
    var n = Number(v);
    var abs = Math.abs(n);
    var s = abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return n < 0 ? '(' + s + ')' : s;
}

function _wmsCnFmtQty(v) {
    if (v === null || v === undefined || isNaN(v)) return '-';
    var n = Math.abs(Number(v));
    if (n === 0) return '-';
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function _wmsCnFmtPrice(v) {
    if (v === null || v === undefined || isNaN(v)) return '-';
    var n = Number(v);
    return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function _wmsCnFmtDate(d) {
    if (!d) return '-';
    if (typeof formatDate === 'function') return formatDate(d);
    return d;
}

function _wmsCnEsc(s) {
    if (typeof wmsEsc === 'function') return wmsEsc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

// ============================================================================
// DOM INJECTION (one-shot)
// ============================================================================

function _wmsCnViewerEnsureDom() {
    if (_wmsCnViewerDomReady) return;
    _wmsCnViewerDomReady = true;

    // ---- Inject CSS ----
    var style = document.createElement('style');
    style.id = 'wms-cn-viewer-styles';
    style.textContent =
        '.wms-cn-overlay { display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.45); z-index:1300; justify-content:center; align-items:flex-start; padding:30px 20px; overflow-y:auto; }' +
        '.wms-cn-overlay.show { display:flex; }' +
        '.wms-cn-modal { background:#fff; border-radius:10px; width:100%; max-width:1100px; max-height:88vh; display:flex; flex-direction:column; box-shadow:0 8px 32px rgba(0,0,0,0.18); }' +
        '.wms-cn-header { padding:12px 16px; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center; }' +
        '.wms-cn-header h3 { margin:0; font-size:14px; color:#2d3748; }' +
        '.wms-cn-header .cn-sub { font-size:11px; color:#718096; margin-left:8px; }' +
        '.wms-cn-body { padding:12px 16px; overflow-y:auto; flex:1; }' +
        '.wms-cn-info { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:8px 16px; padding:8px 10px; background:#f7fafc; border-radius:6px; margin-bottom:10px; }' +
        '.wms-cn-info-row { display:flex; gap:6px; align-items:baseline; font-size:12px; }' +
        '.wms-cn-info-row label { font-size:10px; font-weight:600; text-transform:uppercase; color:#718096; letter-spacing:0.4px; min-width:75px; }' +
        '.wms-cn-info-row span { color:#2d3748; font-weight:500; }' +
        '.wms-cn-table-wrap { width:100%; overflow-x:auto; }' +
        '.wms-cn-table { width:100%; border-collapse:collapse; font-size:12px; }' +
        '.wms-cn-table th { background:#f7fafc; padding:6px 8px; font-size:10px; font-weight:600; text-transform:uppercase; color:#718096; border-bottom:1px solid #e2e8f0; position:sticky; top:0; text-align:left; white-space:nowrap; }' +
        '.wms-cn-table th.num { text-align:right; }' +
        '.wms-cn-table td { padding:5px 8px; border-bottom:1px solid #f0f4f8; }' +
        '.wms-cn-table td.num { text-align:right; font-variant-numeric:tabular-nums; }' +
        '.wms-cn-table tr:hover td { background:#f9fafb; }' +
        '.wms-cn-table tr.row-buy td.type-cell { color:#059669; font-weight:600; }' +
        '.wms-cn-table tr.row-sell td.type-cell { color:#dc2626; font-weight:600; }' +
        '.wms-cn-table tfoot td { font-weight:700; background:#f7fafc; border-top:2px solid #cbd5e0; padding:7px 8px; }' +
        '.wms-cn-table .sym-cell { white-space:nowrap; }' +
        '.wms-cn-table .sym-name { font-size:10px; color:#9ca3af; }' +
        '.wms-cn-empty { padding:24px; text-align:center; color:#9ca3af; font-size:13px; }' +
        '.wms-cn-footer { padding:10px 16px; border-top:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center; }' +
        '.wms-cn-footer-note { font-size:11px; color:#9ca3af; }' +
        '';
    // NOTE: Edit-modal trigger styles (.wms-cn-input-row / .wms-cn-view-btn)
    // live in wms-txn-modal.js's style block. The trigger is part of the
    // Edit modal UI and must be styled the moment that modal opens — well
    // before the user has clicked View CN to lazy-inject *this* file's
    // styles. Keeping a clean separation: cn-viewer.js owns the viewer
    // modal styles, wms-txn-modal.js owns the Edit-modal trigger styles.
    document.head.appendChild(style);

    // ---- Inject HTML ----
    var overlay = document.createElement('div');
    overlay.id = 'wmsCnViewerOverlay';
    overlay.className = 'wms-cn-overlay';
    overlay.innerHTML =
        '<div class="wms-cn-modal" id="wmsCnViewerModal" onclick="event.stopPropagation();">' +
            '<div class="wms-cn-header">' +
                '<h3>Contract Note <span class="cn-sub" id="wmsCnHeaderSub"></span></h3>' +
                '<button class="btn-close-modal" onclick="wmsCnViewerClose()" title="Close">&times;</button>' +
            '</div>' +
            '<div class="wms-cn-body">' +
                '<div class="wms-cn-info" id="wmsCnInfo"></div>' +
                '<div class="wms-cn-table-wrap" id="wmsCnTableWrap"></div>' +
            '</div>' +
            '<div class="wms-cn-footer">' +
                '<span class="wms-cn-footer-note">Read-only view. To edit a trade, close this and use the Edit option on the row.</span>' +
                '<button class="btn-secondary" onclick="wmsCnViewerClose()">Close</button>' +
            '</div>' +
        '</div>';

    // Click-outside-modal closes
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) wmsCnViewerClose();
    });

    document.body.appendChild(overlay);

    // ESC closes
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && overlay.classList.contains('show')) {
            wmsCnViewerClose();
        }
    });
}

// ============================================================================
// PUBLIC API: OPEN / CLOSE
// ============================================================================

function wmsCnViewerOpen(investorId, brokerId, cnNumber, transactions) {
    if (!cnNumber) {
        if (typeof showAlert === 'function') showAlert('No Contract Note number on this transaction.', 'error');
        return;
    }
    _wmsCnViewerEnsureDom();

    // Filter the caller's in-memory array. No DB read.
    var rows = (transactions || []).filter(function(t) {
        return t
            && t.investor_id === investorId
            && t.broker_id === brokerId
            && (t.broker_contract_note_no || '') === cnNumber;
    });

    _wmsCnViewerRender(rows, investorId, brokerId, cnNumber);

    var overlay = document.getElementById('wmsCnViewerOverlay');
    if (overlay) overlay.classList.add('show');
}

function wmsCnViewerClose() {
    var overlay = document.getElementById('wmsCnViewerOverlay');
    if (overlay) overlay.classList.remove('show');
}

// ============================================================================
// RENDER
// ============================================================================

function _wmsCnViewerRender(rows, investorId, brokerId, cnNumber) {
    // Header sub-line: CN number (always present)
    var headerSub = document.getElementById('wmsCnHeaderSub');
    if (headerSub) headerSub.textContent = '— ' + cnNumber;

    // ---- Info block (header card) ----
    var info = document.getElementById('wmsCnInfo');
    if (info) {
        if (rows.length === 0) {
            info.innerHTML =
                '<div class="wms-cn-info-row"><label>Investor</label><span>' + _wmsCnEsc(_wmsCnInvName(investorId)) + '</span></div>' +
                '<div class="wms-cn-info-row"><label>Broker</label><span>' + _wmsCnEsc(_wmsCnBrokerName(brokerId)) + '</span></div>' +
                '<div class="wms-cn-info-row"><label>CN Number</label><span>' + _wmsCnEsc(cnNumber) + '</span></div>';
        } else {
            // CN date — earliest transaction_date in the set (typically all rows share the same date)
            var dates = rows.map(function(r) { return r.transaction_date; }).filter(Boolean).sort();
            var cnDate = dates.length ? dates[0] : null;
            var multiDate = dates.length && dates[0] !== dates[dates.length - 1];

            // Trader summary — usually all rows share the same trader, but in
            // case of post-import re-attribution / split there could be a mix.
            var traderIds = {};
            rows.forEach(function(r) { traderIds[r.trader_id || r.investor_id] = true; });
            var traderNames = Object.keys(traderIds).map(_wmsCnInvName).join(', ');

            info.innerHTML =
                '<div class="wms-cn-info-row"><label>Investor</label><span>' + _wmsCnEsc(_wmsCnInvName(investorId)) + '</span></div>' +
                '<div class="wms-cn-info-row"><label>Broker</label><span>' + _wmsCnEsc(_wmsCnBrokerName(brokerId)) + '</span></div>' +
                '<div class="wms-cn-info-row"><label>CN Number</label><span>' + _wmsCnEsc(cnNumber) + '</span></div>' +
                '<div class="wms-cn-info-row"><label>CN Date</label><span>' + _wmsCnFmtDate(cnDate) + (multiDate ? ' <em style="color:#9ca3af;font-size:10px;">(spans multiple dates)</em>' : '') + '</span></div>' +
                '<div class="wms-cn-info-row"><label>Trader(s)</label><span>' + _wmsCnEsc(traderNames) + '</span></div>' +
                '<div class="wms-cn-info-row"><label>Trades</label><span>' + rows.length + '</span></div>';
        }
    }

    // ---- Table ----
    var wrap = document.getElementById('wmsCnTableWrap');
    if (!wrap) return;

    if (rows.length === 0) {
        wrap.innerHTML = '<div class="wms-cn-empty">No transactions found for this Contract Note in the current view.</div>';
        return;
    }

    // Sort within CN: chronological (date + time + id) then symbol — matches
    // the canonical sort used everywhere else (LESSONS E.16).
    var sorted = rows.slice().sort(function(a, b) {
        var da = a.transaction_date || '';
        var db = b.transaction_date || '';
        if (da !== db) return da < db ? -1 : 1;
        var ta = a.transaction_time || '';
        var tb = b.transaction_time || '';
        if (ta !== tb) return ta < tb ? -1 : 1;
        var sa = a.symbol || '';
        var sb = b.symbol || '';
        if (sa !== sb) return sa < sb ? -1 : 1;
        return (a.id || '') < (b.id || '') ? -1 : 1;
    });

    // Totals
    var T = { qtyBuy: 0, qtySell: 0, gross: 0, brokerage: 0, stt: 0, other: 0, gst: 0, traderCh: 0, net: 0 };

    var tbodyRows = sorted.map(function(t) {
        var typ = t.transaction_type || '';
        var isSell = typ === 'SELL';
        var qtyAbs = Math.abs(parseFloat(t.quantity) || 0);
        var gross = parseFloat(t.gross_amount) || 0;
        var brokerage = parseFloat(t.brokerage) || 0;
        var stt = parseFloat(t.stt) || 0;
        var other = parseFloat(t.other_charges) || 0;
        var gst = parseFloat(t.gst) || 0;
        var traderCh = parseFloat(t.trader_charges) || 0;
        var net = parseFloat(t.net_amount) || 0;

        if (isSell) T.qtySell += qtyAbs; else T.qtyBuy += qtyAbs;
        T.gross += gross;
        T.brokerage += brokerage;
        T.stt += stt;
        T.other += other;
        T.gst += gst;
        T.traderCh += traderCh;
        T.net += (isSell ? -net : net);

        var rowClass = isSell ? 'row-sell' : (typ === 'BUY' ? 'row-buy' : '');
        var symLabel = (t.symbol || '').replace(/^[A-Z]+:/, '');
        var symName = t.company_name || '';

        return '<tr class="' + rowClass + '">' +
            '<td class="sym-cell">' + _wmsCnEsc(symLabel) +
                (symName && symName !== symLabel ? '<br><span class="sym-name">' + _wmsCnEsc(symName) + '</span>' : '') +
            '</td>' +
            '<td class="type-cell">' + _wmsCnEsc(typ) + '</td>' +
            '<td class="num">' + _wmsCnFmtQty(qtyAbs) + '</td>' +
            '<td class="num">' + _wmsCnFmtPrice(t.price) + '</td>' +
            '<td class="num">' + _wmsCnFmtAmt(gross) + '</td>' +
            '<td class="num">' + _wmsCnFmtAmt(brokerage) + '</td>' +
            '<td class="num">' + _wmsCnFmtAmt(stt) + '</td>' +
            '<td class="num">' + _wmsCnFmtAmt(other) + '</td>' +
            '<td class="num">' + _wmsCnFmtAmt(gst) + '</td>' +
            '<td class="num">' + _wmsCnFmtAmt(traderCh) + '</td>' +
            '<td class="num">' + _wmsCnFmtAmt(net) + '</td>' +
        '</tr>';
    }).join('');

    var hasTraderCharges = T.traderCh > 0.005;

    wrap.innerHTML =
        '<table class="wms-cn-table">' +
            '<thead><tr>' +
                '<th>Symbol</th>' +
                '<th>Type</th>' +
                '<th class="num">Qty</th>' +
                '<th class="num">Price</th>' +
                '<th class="num">Gross</th>' +
                '<th class="num">Brokerage</th>' +
                '<th class="num">STT</th>' +
                '<th class="num">Other</th>' +
                '<th class="num">GST</th>' +
                '<th class="num" title="Trader charges (zero when investor = trader)">Trader Chg</th>' +
                '<th class="num">Net</th>' +
            '</tr></thead>' +
            '<tbody>' + tbodyRows + '</tbody>' +
            '<tfoot><tr>' +
                '<td colspan="2">TOTAL (' + sorted.length + ' trades' + (T.qtyBuy && T.qtySell ? ', mixed' : (T.qtyBuy ? ', BUY' : ', SELL')) + ')</td>' +
                '<td class="num">' + _wmsCnFmtQty(T.qtyBuy + T.qtySell) + '</td>' +
                '<td class="num">—</td>' +
                '<td class="num">' + _wmsCnFmtAmt(T.gross) + '</td>' +
                '<td class="num">' + _wmsCnFmtAmt(T.brokerage) + '</td>' +
                '<td class="num">' + _wmsCnFmtAmt(T.stt) + '</td>' +
                '<td class="num">' + _wmsCnFmtAmt(T.other) + '</td>' +
                '<td class="num">' + _wmsCnFmtAmt(T.gst) + '</td>' +
                '<td class="num">' + (hasTraderCharges ? _wmsCnFmtAmt(T.traderCh) : '—') + '</td>' +
                '<td class="num">' + _wmsCnFmtAmt(T.net) + '</td>' +
            '</tr></tfoot>' +
        '</table>';
}

// ============================================================================
// EXPOSE
// ============================================================================

window.wmsCnViewerOpen = wmsCnViewerOpen;
window.wmsCnViewerClose = wmsCnViewerClose;
