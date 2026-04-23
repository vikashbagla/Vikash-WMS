// ============================================================================
// trading-expiry.js — Expire Worthless (OTM) Options — Corporate Action
//
// Scope: OTM options expiring worthless. Settlement price is hardcoded to 0.
// For ITM options the user should NOT use this tool — ITM contracts are
// either (a) squared off before expiry as a normal trade, or (b) for stock
// options go to physical delivery, which is a plain equity-delivery
// transaction entered via Add Transaction. This tool is narrowly scoped so
// the UI and accounting stay unambiguous.
//
// How it works:
//   1. Scans open F&O OPTION positions (CE/PE) whose contract expiry_date is
//      earlier than today.
//   2. Presents a review modal — user ticks which rows to expire (default:
//      all ticked).
//   3. On confirm, writes a plain closing BUY/SELL transaction per row at
//      price = 0:
//        - Long  (netQty > 0) → SELL quantity = -|netQty| at price 0
//        - Short (netQty < 0) → BUY  quantity = +|netQty| at price 0
//      All charges = 0 (nothing applies on an OTM-expired contract —
//      no STT, no exchange fee, no SEBI, no stamp, no GST, no brokerage).
//
// FIFO/LIFO, margin FIFO, Statements and Reports all pick this up
// automatically because the closing trade is a normal BUY/SELL.
//
// Rule A.1.2: all declarations use var.
// ============================================================================

var _trExpRows = [];           // [{ investor_id, trader_id, broker_id,
                               //    security_id, fullSymbol, shortSymbol,
                               //    contractLabel, expiryDate, netQty,
                               //    avgPrice, included, nfoRec, sampleTxn }]
var _trExpDomReady = false;
var _trExpSaving = false;

// ============================================================================
// DOM INJECTION — runs once on first open
// ============================================================================

function _trExpEnsureDom() {
    if (_trExpDomReady) return;
    _trExpDomReady = true;

    var style = document.createElement('style');
    style.textContent =
        '.trExp-overlay { position:fixed; top:0; left:0; width:100%; height:100%;' +
        '   background:rgba(0,0,0,0.45); display:none; align-items:center;' +
        '   justify-content:center; z-index:1200; }' +
        '.trExp-overlay.show { display:flex; }' +
        '.trExp-card { background:#fff; border-radius:10px; width:900px; max-width:96vw;' +
        '   max-height:85vh; display:flex; flex-direction:column; box-shadow:0 10px 30px rgba(0,0,0,0.2); }' +
        '.trExp-header { display:flex; justify-content:space-between; align-items:flex-start;' +
        '   padding:14px 18px; border-bottom:1px solid #e2e8f0; gap:16px; }' +
        '.trExp-title { font-size:15px; font-weight:700; color:#2d3748; }' +
        '.trExp-sub { font-size:11px; color:#718096; margin-top:4px; line-height:1.5; max-width:680px; }' +
        '.trExp-body { overflow-y:auto; padding:12px 18px; flex:1; min-height:0; }' +
        '.trExp-table { width:100%; border-collapse:collapse; font-size:11px; }' +
        '.trExp-table thead th { position:sticky; top:0; background:#f7fafc; font-size:10px;' +
        '   text-transform:uppercase; font-weight:600; color:#718096; padding:6px 8px;' +
        '   text-align:left; border-bottom:1px solid #e2e8f0; }' +
        '.trExp-table thead th.right { text-align:right; }' +
        '.trExp-table tbody td { padding:6px 8px; border-bottom:1px solid #f1f5f9; vertical-align:middle; }' +
        '.trExp-table tbody td.right { text-align:right; }' +
        '.trExp-table tbody tr.excluded td { opacity:0.4; }' +
        '.trExp-pnl-pos { color:#059669; font-weight:600; }' +
        '.trExp-pnl-neg { color:#dc2626; font-weight:600; }' +
        '.trExp-side-long  { color:#059669; font-weight:600; font-size:9px; text-transform:uppercase; }' +
        '.trExp-side-short { color:#dc2626; font-weight:600; font-size:9px; text-transform:uppercase; }' +
        '.trExp-footer { padding:12px 18px; border-top:1px solid #e2e8f0;' +
        '   display:flex; justify-content:space-between; align-items:center; gap:12px; }' +
        '.trExp-help { font-size:10px; color:#718096; max-width:560px; line-height:1.4; }' +
        '.trExp-footer-btns { display:flex; gap:8px; }' +
        '.trExp-summary { font-size:11px; color:#4a5568; padding:6px 8px; background:#f7fafc;' +
        '   border-radius:4px; margin-bottom:8px; }' +
        '.trExp-empty { padding:40px 20px; text-align:center; color:#718096; font-size:12px; }';
    document.head.appendChild(style);

    var wrap = document.createElement('div');
    wrap.innerHTML =
        '<div class="trExp-overlay" id="trExpOverlay">' +
          '<div class="trExp-card" id="trExpCard">' +
            '<div class="trExp-header">' +
              '<div>' +
                '<div class="trExp-title">Expire Worthless (OTM) Options</div>' +
                '<div class="trExp-sub">Open option positions past their expiry date — they will be closed at price <b>0</b> ' +
                '(worthless OTM settlement). Each row shows the premium you retain (short) or lose (long) on expiry. ' +
                'Uncheck any ITM rows — those are not settled via this flow; square them off as a normal trade, or ' +
                'for stock options that went to physical delivery, record a delivery transaction via Add Transaction instead.</div>' +
              '</div>' +
              '<button class="btn-close-modal" id="trExpCloseBtn" title="Close">&times;</button>' +
            '</div>' +
            '<div class="trExp-body">' +
              '<div class="trExp-summary" id="trExpSummary"></div>' +
              '<table class="trExp-table" id="trExpTable">' +
                '<thead><tr>' +
                  '<th style="width:24px;"><input type="checkbox" id="trExpSelectAll" checked title="Select/deselect all"></th>' +
                  '<th>Investor &rsaquo; Trader &rsaquo; Broker</th>' +
                  '<th>Contract</th>' +
                  '<th class="right">Expiry</th>' +
                  '<th class="right">Open Qty</th>' +
                  '<th class="right">Avg Open Price</th>' +
                  '<th class="right">Realised P&amp;L</th>' +
                '</tr></thead>' +
                '<tbody id="trExpTbody"></tbody>' +
              '</table>' +
              '<div class="trExp-empty" id="trExpEmpty" style="display:none;">No expired open option positions found.</div>' +
            '</div>' +
            '<div class="trExp-footer">' +
              '<div class="trExp-help">All charges are zero on OTM-expired contracts (no STT, no exchange fee, no SEBI / stamp / GST). Closing trades are dated on each contract\'s expiry date.</div>' +
              '<div class="trExp-footer-btns">' +
                '<button class="btn-secondary" id="trExpCancelBtn">Cancel</button>' +
                '<button class="btn-primary" id="trExpConfirmBtn">Expire Worthless</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
    document.body.appendChild(wrap.firstChild);

    // Wire close / cancel
    document.getElementById('trExpCloseBtn').addEventListener('click', trExpClose);
    document.getElementById('trExpCancelBtn').addEventListener('click', trExpClose);
    document.getElementById('trExpOverlay').addEventListener('click', function(e) {
        if (e.target === this) trExpClose();
    });
    document.getElementById('trExpConfirmBtn').addEventListener('click', trExpConfirm);

    // Select-all checkbox
    document.getElementById('trExpSelectAll').addEventListener('change', function() {
        var on = this.checked;
        _trExpRows.forEach(function(r) { r.included = on; });
        _trExpRender();
    });

    // ESC to close
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            var overlay = document.getElementById('trExpOverlay');
            if (overlay && overlay.classList.contains('show')) trExpClose();
        }
    });
}

// ============================================================================
// SCAN — find expired open option positions
//
// Groups options (security_type NFO + symbol ends in CE/PE) by
//   (investor|trader|broker|contract), computes net qty. Filters to net qty
//   != 0 AND contract expiry_date < today.
//
// "Avg open price" = weighted avg of remaining open lots (via
// wmsCalcFifoCost) — used only for the realised P&L preview in the table.
// FIFO vs LIFO makes no difference when closing ALL remaining lots at once,
// so using wmsCalcFifoCost for display is safe.
// ============================================================================

function _trExpFindExpired() {
    if (typeof trTransactions === 'undefined' || !Array.isArray(trTransactions)) return [];
    var todayStr = new Date().toISOString().slice(0, 10);

    // Honour the current F&O pill filters via trFnoGetTxns when available.
    var pool;
    if (typeof trFnoGetTxns === 'function') {
        pool = trFnoGetTxns();
    } else {
        pool = trTransactions.filter(function(t) {
            return t.security_type === 'NFO' || t.security_type === 'MCX';
        });
    }
    var optionTxns = pool.filter(function(t) {
        if (t.transaction_type !== 'BUY' && t.transaction_type !== 'SELL') return false;
        var sym = t.symbol || '';
        var shortSym = t.short_symbol || '';
        return wmsIsOptionContract(sym, shortSym);
    });

    // Group by (inv|trd|brk|fullSymbol), stripping exchange prefix (A.2.13).
    var groups = {};
    optionTxns.forEach(function(t) {
        var invId = t.investor_id || '';
        var trdId = t.trader_id || t.investor_id || '';
        var brkId = t.broker_id || '';
        var fullSym = (t.symbol || t.short_symbol || '').replace(/^[A-Z]+:/, '');
        var key = invId + '|' + trdId + '|' + brkId + '|' + fullSym;
        if (!groups[key]) {
            groups[key] = {
                investor_id: invId,
                trader_id: (trdId && trdId !== invId) ? trdId : null,
                broker_id: brkId || null,
                security_id: t.security_id,
                fullSymbol: fullSym,
                shortSymbol: t.short_symbol || t.symbol || '',
                sampleTxn: t,
                txns: []
            };
        }
        groups[key].txns.push(t);
    });

    var out = [];
    Object.keys(groups).forEach(function(k) {
        var g = groups[k];
        var sorted = g.txns.slice().sort(function(a, b) {
            var da = a.transaction_date || '', db = b.transaction_date || '';
            if (da !== db) return da < db ? -1 : 1;
            // Chronological tiebreaker: transaction_time (NULL treated as 00:00:00
            // so older rows without a saved time sort before newer rows with one).
            var ta = a.transaction_time || '', tb = b.transaction_time || '';
            if (ta !== tb) return ta < tb ? -1 : 1;
            return (a.id || 0) - (b.id || 0);
        });
        var netQty = 0;
        sorted.forEach(function(t) { netQty += (t.quantity || 0); });
        if (netQty === 0) return;

        var nfoRec = (wmsRefData && wmsRefData.securitiesNfoMap) ? wmsRefData.securitiesNfoMap[g.security_id] : null;
        if (!nfoRec || !nfoRec.expiry_date) return;
        if (nfoRec.expiry_date >= todayStr) return;

        // Avg open price from remaining lots.
        var result = (typeof wmsCalcFifoCost === 'function') ? wmsCalcFifoCost(sorted) : null;
        var openCostSigned = 0, openAbsQty = 0;
        if (result && result.holdings) {
            Object.keys(result.holdings).forEach(function(hk) {
                result.holdings[hk].lots.forEach(function(lot) {
                    if (!lot.qty) return;
                    openCostSigned += lot.qty * lot.costPerUnit;
                    openAbsQty += Math.abs(lot.qty);
                });
            });
        }
        var avgPrice = openAbsQty > 0 ? (Math.abs(openCostSigned) / openAbsQty) : 0;

        out.push({
            investor_id: g.investor_id,
            trader_id: g.trader_id,
            broker_id: g.broker_id,
            security_id: g.security_id,
            fullSymbol: g.fullSymbol,
            shortSymbol: g.shortSymbol,
            contractLabel: (typeof wmsFormatContract === 'function') ? wmsFormatContract(g.sampleTxn) : g.fullSymbol,
            expiryDate: nfoRec.expiry_date,
            netQty: netQty,
            avgPrice: avgPrice,
            included: true,
            nfoRec: nfoRec,
            sampleTxn: g.sampleTxn
        });
    });

    out.sort(function(a, b) {
        if (a.expiryDate !== b.expiryDate) return a.expiryDate < b.expiryDate ? -1 : 1;
        return (a.shortSymbol || '').localeCompare(b.shortSymbol || '');
    });
    return out;
}

// ============================================================================
// RENDER
// ============================================================================

function _trExpFmtInt(v) {
    if (v === null || v === undefined || isNaN(v)) return '0';
    var abs = Math.abs(Math.round(v));
    return String(abs).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function _trExpFmtPnl(v) {
    var cls = v > 0 ? 'trExp-pnl-pos' : (v < 0 ? 'trExp-pnl-neg' : '');
    var str = (typeof wmsFmtAmt === 'function') ? wmsFmtAmt(v) : String(v);
    return '<span class="' + cls + '">' + str + '</span>';
}

function _trExpInvBrkLabel(row) {
    var inv = (typeof trInvName === 'function') ? trInvName(row.investor_id) : row.investor_id;
    var trd = row.trader_id ? ((typeof trInvName === 'function') ? trInvName(row.trader_id) : row.trader_id) : '';
    var brk = row.broker_id ? ((typeof trBrkCode === 'function') ? trBrkCode(row.broker_id) : row.broker_id) : '';
    var label = inv;
    if (trd && trd !== inv) label += ' > ' + trd;
    if (brk) label += ' > ' + brk;
    return label;
}

// Realised P&L at price 0:
//   Long  (netQty > 0): full premium loss = -avgPrice × |netQty|
//   Short (netQty < 0): full premium retained = +avgPrice × |netQty|
function _trExpCalcRealisedPnl(row) {
    var absQty = Math.abs(row.netQty);
    if (row.netQty > 0) return -row.avgPrice * absQty;
    return row.avgPrice * absQty;
}

function _trExpRender() {
    var tbody = document.getElementById('trExpTbody');
    var empty = document.getElementById('trExpEmpty');
    var table = document.getElementById('trExpTable');
    var summary = document.getElementById('trExpSummary');
    var confirmBtn = document.getElementById('trExpConfirmBtn');

    if (!_trExpRows.length) {
        tbody.innerHTML = '';
        table.style.display = 'none';
        empty.style.display = '';
        summary.textContent = '';
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Expire Worthless';
        return;
    }
    table.style.display = '';
    empty.style.display = 'none';

    var rowsHtml = _trExpRows.map(function(row, idx) {
        var absQty = Math.abs(row.netQty);
        var side = row.netQty > 0 ? 'long' : 'short';
        var pnl = _trExpCalcRealisedPnl(row);
        return '<tr class="' + (row.included ? '' : 'excluded') + '" data-idx="' + idx + '">' +
            '<td><input type="checkbox" class="trExp-row-chk" data-idx="' + idx + '"' + (row.included ? ' checked' : '') + '></td>' +
            '<td>' + wmsEsc(_trExpInvBrkLabel(row)) + '</td>' +
            '<td>' + wmsEsc(row.contractLabel || row.fullSymbol) +
                ' <span class="trExp-side-' + side + '">' + side + '</span></td>' +
            '<td class="right">' + wmsEsc(row.expiryDate) + '</td>' +
            '<td class="right">' + _trExpFmtInt(absQty) + '</td>' +
            '<td class="right">' + ((typeof wmsFmtAmt === 'function') ? wmsFmtAmt(row.avgPrice) : row.avgPrice.toFixed(2)) + '</td>' +
            '<td class="right">' + _trExpFmtPnl(pnl) + '</td>' +
        '</tr>';
    }).join('');
    tbody.innerHTML = rowsHtml;

    tbody.querySelectorAll('.trExp-row-chk').forEach(function(chk) {
        chk.addEventListener('change', function() {
            var idx = parseInt(this.getAttribute('data-idx'), 10);
            if (_trExpRows[idx]) {
                _trExpRows[idx].included = this.checked;
                _trExpRender();  // refresh summary + row fade
            }
        });
    });

    _trExpUpdateSummary();

    var allOn = _trExpRows.every(function(r) { return r.included; });
    var someOn = _trExpRows.some(function(r) { return r.included; });
    var selAll = document.getElementById('trExpSelectAll');
    selAll.checked = allOn;
    selAll.indeterminate = someOn && !allOn;

    var includedCount = _trExpRows.filter(function(r) { return r.included; }).length;
    confirmBtn.disabled = includedCount === 0;
    confirmBtn.textContent = 'Expire Worthless' + (includedCount > 0 ? ' (' + includedCount + ')' : '');
}

function _trExpUpdateSummary() {
    var summary = document.getElementById('trExpSummary');
    var total = _trExpRows.length;
    var included = 0, totalPnl = 0;
    _trExpRows.forEach(function(r) {
        if (r.included) { included++; totalPnl += _trExpCalcRealisedPnl(r); }
    });
    var pnlStr = (typeof wmsFmtAmt === 'function') ? wmsFmtAmt(totalPnl) : totalPnl.toFixed(2);
    var pnlCls = totalPnl > 0 ? 'trExp-pnl-pos' : (totalPnl < 0 ? 'trExp-pnl-neg' : '');
    summary.innerHTML =
        '<b>' + total + '</b> expired open option position' + (total === 1 ? '' : 's') + ' found. ' +
        '<b>' + included + '</b> selected. ' +
        'Aggregate realised P&amp;L on worthless expiry: <span class="' + pnlCls + '">' + pnlStr + '</span>.';
}

// ============================================================================
// PUBLIC: OPEN / CLOSE
// ============================================================================

function trExpOpen() {
    _trExpEnsureDom();
    _trExpRows = _trExpFindExpired();
    _trExpRender();
    document.getElementById('trExpOverlay').classList.add('show');
}

function trExpClose() {
    var overlay = document.getElementById('trExpOverlay');
    if (overlay) overlay.classList.remove('show');
    _trExpRows = [];
    _trExpSaving = false;
}

// ============================================================================
// CONFIRM — write closing transactions at price 0
//
// For each included row:
//   - Long  (netQty > 0): SELL  quantity = -|netQty| at price 0
//   - Short (netQty < 0): BUY   quantity = +|netQty| at price 0
// Price and gross are always 0. All charges are 0 (no STT/exchange/SEBI/
// stamp/GST on OTM-expired options). Notes field carries a human-readable
// tag so these rows are distinguishable in Transactions / audit.
// ============================================================================

async function trExpConfirm() {
    if (_trExpSaving) return;
    var selected = _trExpRows.filter(function(r) { return r.included; });
    if (selected.length === 0) {
        if (typeof showAlert === 'function') showAlert('No positions selected.', 'error', 3000);
        return;
    }

    _trExpSaving = true;
    var btn = document.getElementById('trExpConfirmBtn');
    var cancelBtn = document.getElementById('trExpCancelBtn');
    btn.disabled = true;
    cancelBtn.disabled = true;
    btn.textContent = 'Expiring...';

    function r2(v) { return Math.round((v || 0) * 100) / 100; }

    try {
        var txns = selected.map(function(row) {
            var absQty = Math.abs(row.netQty);
            var isLong = row.netQty > 0;
            var lotSize = (row.nfoRec && row.nfoRec.lot_size) ? row.nfoRec.lot_size : 0;
            var lots = lotSize > 0 ? r2(absQty / lotSize) : 0;
            var sample = row.sampleTxn || {};
            var securityType = sample.security_type || 'NFO';
            var exch = sample.exchange || (row.nfoRec && row.nfoRec.exchange) || 'NSE';
            var company = sample.company_name || (row.nfoRec && row.nfoRec.instrument_name) || row.shortSymbol;
            var assetClass = sample.asset_class || (row.nfoRec && row.nfoRec.asset_class) || null;
            var product = sample.product || null;

            return {
                investor_id: row.investor_id,
                trader_id: row.trader_id || row.investor_id,   // A.2.2
                broker_id: row.broker_id,
                security_id: row.security_id,
                security_type: securityType,
                symbol: row.fullSymbol,
                short_symbol: row.shortSymbol,
                company_name: company,
                asset_class: assetClass,
                exchange: exch,
                product: product,
                transaction_type: isLong ? 'SELL' : 'BUY',
                transaction_date: row.expiryDate,
                quantity: isLong ? -absQty : absQty,
                lots: lots,
                price: 0,
                gross_amount: 0,
                brokerage: 0, stt: 0, other_charges: 0, gst: 0, tds: 0,
                total_charges: 0,
                trader_charges: 0,
                net_amount: 0,
                margin_blocked: 0,
                broker_contract_note_no: null,
                broker_trade_id: null,
                tags: ['blank'],                                 // A.2.1
                notes: '[Expired worthless on ' + row.expiryDate + ']',
                is_locked: false,
                ignore_for_avg_cost: false,
                dont_display: false
            };
        });

        if (typeof wmsBatchCreateTransactions !== 'function') {
            throw new Error('wmsBatchCreateTransactions not loaded');
        }
        await wmsBatchCreateTransactions(txns);

        trExpClose();
        if (typeof showAlert === 'function') {
            showAlert('Expired ' + txns.length + ' option position' + (txns.length === 1 ? '' : 's') + ' at zero.', 'success', 4000);
        }
        if (typeof trRefresh === 'function') await trRefresh();

    } catch (err) {
        console.error('trExpConfirm error:', err);
        if (typeof showAlert === 'function') showAlert('Error expiring options: ' + err.message, 'error', 6000);
        btn.disabled = false;
        cancelBtn.disabled = false;
        btn.textContent = 'Expire Worthless (' + selected.length + ')';
        _trExpSaving = false;
    }
}

// ============================================================================
// EXPORTS
// ============================================================================
window.trExpOpen = trExpOpen;
window.trExpClose = trExpClose;
