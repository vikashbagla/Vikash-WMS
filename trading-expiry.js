// ============================================================================
// trading-expiry.js — Settle Expired Options (Corporate Action)
//
// Scans open F&O OPTION positions whose contract expiry_date < today,
// presents a review modal, and writes matching closing BUY/SELL transactions
// at a user-entered settlement price (default 0 = expired worthless).
//
// Scope: options only (CE/PE). Futures are out of scope (physical settlement
// of stock futures is a different workflow — cash-settled index futures expire
// to settlement price and can be handled the same way later if needed).
//
// The closing transaction is a plain BUY or SELL so that FIFO/LIFO, margin
// FIFO, Statements, and Reports all work unchanged. Charges are set to 0 in
// the auto-generated trade. For ITM options that incur STT on settlement,
// the user edits the transaction after creation.
//
// Rule A.1.2: all declarations use var.
// ============================================================================

var _trExpRows = [];           // [{ investor_id, trader_id, broker_id,
                               //    security_id, fullSymbol, shortSymbol,
                               //    contractLabel, expiryDate, netQty,
                               //    openCostSigned, settlementPrice, included,
                               //    nfoRec, sampleTxn }]
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
        '.trExp-card { background:#fff; border-radius:10px; width:960px; max-width:96vw;' +
        '   max-height:85vh; display:flex; flex-direction:column; box-shadow:0 10px 30px rgba(0,0,0,0.2); }' +
        '.trExp-header { display:flex; justify-content:space-between; align-items:flex-start;' +
        '   padding:14px 18px; border-bottom:1px solid #e2e8f0; gap:16px; }' +
        '.trExp-title { font-size:15px; font-weight:700; color:#2d3748; }' +
        '.trExp-sub { font-size:11px; color:#718096; margin-top:4px; line-height:1.5; max-width:720px; }' +
        '.trExp-body { overflow-y:auto; padding:12px 18px; flex:1; min-height:0; }' +
        '.trExp-table { width:100%; border-collapse:collapse; font-size:11px; }' +
        '.trExp-table thead th { position:sticky; top:0; background:#f7fafc; font-size:10px;' +
        '   text-transform:uppercase; font-weight:600; color:#718096; padding:6px 8px;' +
        '   text-align:left; border-bottom:1px solid #e2e8f0; }' +
        '.trExp-table thead th.right { text-align:right; }' +
        '.trExp-table tbody td { padding:6px 8px; border-bottom:1px solid #f1f5f9; vertical-align:middle; }' +
        '.trExp-table tbody td.right { text-align:right; }' +
        '.trExp-table tbody tr.excluded td { opacity:0.4; }' +
        '.trExp-settle-input { width:80px; padding:3px 6px; font-size:11px; border:1px solid #cbd5e0;' +
        '   border-radius:4px; text-align:right; font-family:inherit; }' +
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
                '<div class="trExp-title">Settle Expired Options</div>' +
                '<div class="trExp-sub">Open option positions whose contract expiry is in the past. ' +
                'Enter a settlement price per row (0 = expired worthless OTM; for ITM contracts, enter the intrinsic value). ' +
                'Uncheck rows to skip them. Closing transactions are written at the expiry date and match your open lots via FIFO/LIFO — realised P&L, margin release and tax reports update automatically.</div>' +
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
                  '<th class="right">Settle Price</th>' +
                  '<th class="right">Realised P&amp;L</th>' +
                '</tr></thead>' +
                '<tbody id="trExpTbody"></tbody>' +
              '</table>' +
              '<div class="trExp-empty" id="trExpEmpty" style="display:none;">No expired open option positions found.</div>' +
            '</div>' +
            '<div class="trExp-footer">' +
              '<div class="trExp-help">Charges are set to 0 in the auto-generated closing trade. If an ITM contract attracts STT on settlement, edit the transaction after creation to add the STT.</div>' +
              '<div class="trExp-footer-btns">' +
                '<button class="btn-secondary" id="trExpCancelBtn">Cancel</button>' +
                '<button class="btn-primary" id="trExpConfirmBtn">Confirm &amp; Settle</button>' +
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
//   (investor|trader|broker|contract), computes net qty and sum of signed
//   gross amounts, filters to net qty != 0 AND expiry_date < today.
//
// The "avg open price" shown in the table is derived from remaining open lots
// via wmsCalcFifoCost so the Realised P&L preview equals what the FIFO engine
// will compute once the closing trade lands.
// ============================================================================

function _trExpFindExpired() {
    if (typeof trTransactions === 'undefined' || !Array.isArray(trTransactions)) return [];
    var todayStr = new Date().toISOString().slice(0, 10);

    // Filter to option BUY/SELL transactions. Honours the same investor/trader/
    // broker/tag pill filters as the F&O tab via trFnoGetTxns() when that
    // function is available, so "Settle Expired" respects the current view.
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

    // Group by (inv|trd|brk|fullSymbol), stripping any exchange prefix (A.2.13).
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

    // Compute net qty + open lots per group; filter to expired + still-open.
    var out = [];
    Object.keys(groups).forEach(function(k) {
        var g = groups[k];
        var sorted = g.txns.slice().sort(function(a, b) {
            var da = a.transaction_date || '', db = b.transaction_date || '';
            if (da !== db) return da < db ? -1 : 1;
            return (a.id || 0) - (b.id || 0);
        });
        var netQty = 0;
        sorted.forEach(function(t) { netQty += (t.quantity || 0); });
        if (netQty === 0) return;

        // Expiry check via securities_nfo.
        var nfoRec = (wmsRefData && wmsRefData.securitiesNfoMap) ? wmsRefData.securitiesNfoMap[g.security_id] : null;
        if (!nfoRec || !nfoRec.expiry_date) return;  // can't determine
        if (nfoRec.expiry_date >= todayStr) return;  // not yet expired

        // Avg open price from remaining lots (FIFO is fine — total cost is
        // invariant under FIFO vs LIFO when closing all open lots at once).
        var result = (typeof wmsCalcFifoCost === 'function') ? wmsCalcFifoCost(sorted) : null;
        var openCostSigned = 0;   // signed: positive for long cost, negative for short proceeds
        var openAbsQty = 0;
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
            openCostSigned: openCostSigned,
            avgPrice: avgPrice,
            settlementPrice: 0,
            included: true,
            nfoRec: nfoRec,
            sampleTxn: g.sampleTxn
        });
    });

    // Sort: earliest expiry first, then by underlying.
    out.sort(function(a, b) {
        if (a.expiryDate !== b.expiryDate) return a.expiryDate < b.expiryDate ? -1 : 1;
        return (a.shortSymbol || '').localeCompare(b.shortSymbol || '');
    });
    return out;
}

// ============================================================================
// RENDER — populate table rows from _trExpRows
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

function _trExpCalcRealisedPnl(row) {
    // Long position (netQty > 0) closing at settlement:
    //   PnL = settlement * netQty - totalBuyCost = settlement*|netQty| - avgPrice*|netQty|
    // Short position (netQty < 0) closing at settlement:
    //   PnL = totalSellProceeds - settlement*|netQty| = avgPrice*|netQty| - settlement*|netQty|
    var absQty = Math.abs(row.netQty);
    if (row.netQty > 0) return (row.settlementPrice - row.avgPrice) * absQty;
    return (row.avgPrice - row.settlementPrice) * absQty;
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
        confirmBtn.textContent = 'Confirm & Settle';
        return;
    }
    table.style.display = '';
    empty.style.display = 'none';

    var includedCount = 0;
    var totalPnl = 0;
    var rowsHtml = _trExpRows.map(function(row, idx) {
        var absQty = Math.abs(row.netQty);
        var side = row.netQty > 0 ? 'long' : 'short';
        var pnl = _trExpCalcRealisedPnl(row);
        if (row.included) { includedCount++; totalPnl += pnl; }
        return '<tr class="' + (row.included ? '' : 'excluded') + '" data-idx="' + idx + '">' +
            '<td><input type="checkbox" class="trExp-row-chk" data-idx="' + idx + '"' + (row.included ? ' checked' : '') + '></td>' +
            '<td>' + wmsEsc(_trExpInvBrkLabel(row)) + '</td>' +
            '<td>' + wmsEsc(row.contractLabel || row.fullSymbol) +
                ' <span class="trExp-side-' + side + '">' + side + '</span></td>' +
            '<td class="right">' + wmsEsc(row.expiryDate) + '</td>' +
            '<td class="right">' + _trExpFmtInt(absQty) + '</td>' +
            '<td class="right">' + ((typeof wmsFmtAmt === 'function') ? wmsFmtAmt(row.avgPrice) : row.avgPrice.toFixed(2)) + '</td>' +
            '<td class="right"><input type="text" class="trExp-settle-input" data-idx="' + idx +
                '" value="' + (row.settlementPrice || 0) + '"></td>' +
            '<td class="right">' + _trExpFmtPnl(pnl) + '</td>' +
        '</tr>';
    }).join('');
    tbody.innerHTML = rowsHtml;

    // Wire row checkboxes + settlement-price inputs
    tbody.querySelectorAll('.trExp-row-chk').forEach(function(chk) {
        chk.addEventListener('change', function() {
            var idx = parseInt(this.getAttribute('data-idx'), 10);
            if (_trExpRows[idx]) {
                _trExpRows[idx].included = this.checked;
                _trExpRender();  // refresh summary + totals
            }
        });
    });
    tbody.querySelectorAll('.trExp-settle-input').forEach(function(inp) {
        inp.addEventListener('input', function() {
            var idx = parseInt(this.getAttribute('data-idx'), 10);
            var v = parseFloat((this.value || '0').replace(/,/g, ''));
            if (isNaN(v) || v < 0) v = 0;
            if (_trExpRows[idx]) {
                _trExpRows[idx].settlementPrice = v;
                // Update just this row's P&L cell + summary without full re-render
                // (avoids losing focus while typing).
                var tr = tbody.querySelector('tr[data-idx="' + idx + '"]');
                if (tr) {
                    var pnlCell = tr.querySelectorAll('td')[7];
                    if (pnlCell) pnlCell.innerHTML = _trExpFmtPnl(_trExpCalcRealisedPnl(_trExpRows[idx]));
                }
                _trExpUpdateSummary();
            }
        });
    });

    _trExpUpdateSummary();

    // Sync select-all checkbox state
    var allOn = _trExpRows.every(function(r) { return r.included; });
    var someOn = _trExpRows.some(function(r) { return r.included; });
    var selAll = document.getElementById('trExpSelectAll');
    selAll.checked = allOn;
    selAll.indeterminate = someOn && !allOn;

    confirmBtn.disabled = includedCount === 0;
    confirmBtn.textContent = 'Confirm & Settle' + (includedCount > 0 ? ' (' + includedCount + ')' : '');
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
        '<b>' + included + '</b> selected for settlement. ' +
        'Aggregate realised P&amp;L at current settlement prices: <span class="' + pnlCls + '">' + pnlStr + '</span>.';
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
// CONFIRM — write closing transactions
//
// For each included row:
//   - Long  (netQty > 0): SELL  quantity = -|netQty|, lots = |netQty|/lot_size
//   - Short (netQty < 0): BUY   quantity = +|netQty|, lots = |netQty|/lot_size
// Price = settlementPrice. Gross = |netQty| * settlementPrice.
// All charges set to 0 (A.2.9 does NOT apply — this is BUY/SELL, not income).
// trader_id default: investor_id when blank (A.2.2). Tags default ['blank'] (A.2.1).
// Rounded via roundMoney where relevant (A.2.8).
// ============================================================================

async function trExpConfirm() {
    if (_trExpSaving) return;
    var selected = _trExpRows.filter(function(r) { return r.included; });
    if (selected.length === 0) {
        if (typeof showAlert === 'function') showAlert('No positions selected for settlement.', 'error', 3000);
        return;
    }

    _trExpSaving = true;
    var btn = document.getElementById('trExpConfirmBtn');
    var cancelBtn = document.getElementById('trExpCancelBtn');
    btn.disabled = true;
    cancelBtn.disabled = true;
    btn.textContent = 'Settling...';

    function r2(v) { return Math.round((v || 0) * 100) / 100; }

    try {
        var txns = selected.map(function(row) {
            var absQty = Math.abs(row.netQty);
            var isLong = row.netQty > 0;
            var price = row.settlementPrice || 0;
            var gross = r2(absQty * price);
            var lotSize = (row.nfoRec && row.nfoRec.lot_size) ? row.nfoRec.lot_size : 0;
            var lots = lotSize > 0 ? r2(absQty / lotSize) : 0;
            var sample = row.sampleTxn || {};
            // Preserve security_type / exchange / product / asset_class from the original
            // open trade so NFO vs MCX-options, intraday vs delivery product, and any
            // asset-class tagging all carry through to the closing row. Falls back to
            // securities_nfo record or sensible defaults.
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
                price: r2(price),
                gross_amount: gross,
                brokerage: 0, stt: 0, other_charges: 0, gst: 0, tds: 0,
                total_charges: 0,
                trader_charges: 0,
                // For BUY (close short): net_amount = gross + charges (0); for SELL (close long): gross - charges (0).
                net_amount: gross,
                margin_blocked: 0,
                broker_contract_note_no: null,
                broker_trade_id: null,
                tags: ['blank'],                                 // A.2.1
                notes: '[AUTO-SETTLED on expiry ' + row.expiryDate +
                       ' at ' + (typeof wmsFmtAmt === 'function' ? wmsFmtAmt(price) : price.toFixed(2)) + ']',
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
            showAlert('Settled ' + txns.length + ' expired option position' + (txns.length === 1 ? '' : 's') + '.', 'success', 4000);
        }
        if (typeof trRefresh === 'function') await trRefresh();

    } catch (err) {
        console.error('trExpConfirm error:', err);
        if (typeof showAlert === 'function') showAlert('Error settling expired options: ' + err.message, 'error', 6000);
        btn.disabled = false;
        cancelBtn.disabled = false;
        btn.textContent = 'Confirm & Settle (' + selected.length + ')';
        _trExpSaving = false;
    }
}

// ============================================================================
// EXPORTS
// ============================================================================
window.trExpOpen = trExpOpen;
window.trExpClose = trExpClose;
