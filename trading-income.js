// ============================================================================
// trading-income.js — Income Transactions (Dividend, Interest, Other Income,
//                     Capital Reduction)
// Rule A.1.2: All module-level state uses var
// ============================================================================

// Module state
var incSelectedType = null;         // 'DIVIDEND' | 'INTEREST' | 'OTHER_INCOME' | 'CAPITAL_REDUCTION'
var incSelectedSecurity = null;     // {id, symbol, company_name, ...} from wmsRefData
var incHoldings = [];               // [{investor_id, trader_id, broker_id, netQuantity, ...}]
var incDdCtrl = null;               // wmsDropdown controller for security search

// Date state (used by rhInitDateWidget('inc'))
var incDateState = { day: 1, month: 0, year: 2026 };
var incDateActiveSeg = null;
var incDateTypeBuf = '';

// Type labels for modal title
var INC_TYPE_LABELS = {
    'DIVIDEND': 'Dividend',
    'INTEREST': 'Interest',
    'OTHER_INCOME': 'Other Income',
    'CAPITAL_REDUCTION': 'Capital Reduction'
};

// ============================================================================
// INIT — called once after HTML + script injected
// ============================================================================

function initIncomeModule() {
    window._incModuleInitDone = false;

    // Helper: clone element to strip old listeners
    function freshClone(id) {
        var el = document.getElementById(id);
        if (!el) return null;
        var clone = el.cloneNode(true);
        el.parentNode.replaceChild(clone, el);
        return clone;
    }

    // Close / Cancel buttons
    var closeBtn = freshClone('incCloseBtn');
    var cancelBtn = freshClone('incCancelBtn');
    var saveBtn = freshClone('incSaveBtn');

    if (closeBtn) closeBtn.addEventListener('click', closeIncomeModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeIncomeModal);
    if (saveBtn) saveBtn.addEventListener('click', incSaveTransactions);

    // Date widget (reuses rights date widget pattern)
    freshClone('incDateWrap');
    rhInitDateWidget('inc');

    // Security search
    var secInput = document.getElementById('incSecurityInput');
    var secDd = document.getElementById('incSecurityDd');
    incDdCtrl = wmsDropdown(secInput, secDd, {
        itemSelector: '.wms-dd-item',
        closeOnSelect: true,
        blurDelay: 200,
        escClearsInput: false,
        onSelect: function(itemEl) {
            var idx = parseInt(itemEl.dataset.idx);
            var results = secDd._incResults || [];
            if (results[idx]) incSelectSecurity(results[idx]);
        }
    });
    secInput.addEventListener('input', function() {
        incSearchSecurity();
    });

    // ESC handler
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            if (document.getElementById('incomeOverlay').classList.contains('show')) {
                closeIncomeModal();
            }
        }
    });

    window._incModuleInitDone = true;
}

// ============================================================================
// OPEN / CLOSE
// ============================================================================

function openIncomeModal(txnType) {
    incSelectedType = txnType;
    incSelectedSecurity = null;
    incHoldings = [];

    document.getElementById('incModalTitle').textContent = INC_TYPE_LABELS[txnType] || txnType;
    document.getElementById('incSecurityInput').value = '';
    document.getElementById('incSecurityBadge').innerHTML = '';
    document.getElementById('incTableWrap').innerHTML = '<div class="rights-empty">Select a date and security to view holdings</div>';
    document.getElementById('incSaveBtn').disabled = true;

    // Set date to today
    rhDateSetFromDate('inc', new Date());

    document.getElementById('incomeOverlay').classList.add('show');
    setTimeout(function() { document.getElementById('incSecurityInput').focus(); }, 100);
}

function closeIncomeModal() {
    document.getElementById('incomeOverlay').classList.remove('show');
}

// ============================================================================
// SECURITY SEARCH
// ============================================================================

function incSearchSecurity() {
    var input = document.getElementById('incSecurityInput');
    var dd = document.getElementById('incSecurityDd');
    var q = input.value.trim();
    if (q.length < 1) { incDdCtrl.close(); dd._incResults = []; return; }

    var results = wmsSearchSecurities(q);
    // For income: show only CM (equity) securities — filter out NFO
    results = results.filter(function(s) { return s.isin; });

    dd._incResults = results;
    dd.innerHTML = '';
    if (results.length === 0) {
        dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No securities found</div>';
        incDdCtrl.show();
        return;
    }
    results.forEach(function(sec, idx) {
        var div = document.createElement('div');
        div.className = 'wms-dd-item';
        div.dataset.idx = idx;
        div.innerHTML = '<strong>' + (sec.nse_symbol || sec.symbol) + '</strong> — ' + sec.company_name;
        dd.appendChild(div);
    });
    incDdCtrl.show();
    incDdCtrl.resetIdx();
}

function incSelectSecurity(sec) {
    incSelectedSecurity = sec;
    var shortSym = sec.nse_symbol || sec.symbol;
    document.getElementById('incSecurityInput').value = '';
    document.getElementById('incSecurityBadge').innerHTML =
        '<span class="rights-selected-badge">' + shortSym + ' — ' + sec.company_name + '</span>';
    incPopulateHoldings();
}

// ============================================================================
// POPULATE HOLDINGS TABLE
// ============================================================================

function incPopulateHoldings() {
    var dateStr = rhDateGetIsoStr('inc');
    if (!incSelectedSecurity) {
        document.getElementById('incTableWrap').innerHTML = '<div class="rights-empty">Select a date and security to view holdings</div>';
        document.getElementById('incSaveBtn').disabled = true;
        return;
    }

    var shortSym = incSelectedSecurity.nse_symbol || incSelectedSecurity.symbol;
    var holdings = wmsCalcHoldingsAsOfDate(shortSym, dateStr, trTransactions);
    incHoldings = holdings;

    if (holdings.length === 0) {
        document.getElementById('incTableWrap').innerHTML = '<div class="rights-empty">No holdings found for ' + shortSym + ' as of ' + dateStr + '</div>';
        document.getElementById('incSaveBtn').disabled = true;
        return;
    }

    // Check for existing income transactions of same type + symbol + date
    var existingDups = incFindDuplicates(shortSym, dateStr);

    var html = '';
    if (existingDups.length > 0) {
        html += '<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:4px;padding:6px 10px;margin-bottom:8px;font-size:11px;color:#92400e;">' +
            '<strong>Warning:</strong> ' + existingDups.length + ' existing ' + (INC_TYPE_LABELS[incSelectedType] || incSelectedType) +
            ' transaction(s) found for ' + shortSym + ' on ' + dateStr + '. Rows already recorded are marked below.</div>';
    }

    html += '<table class="inc-table"><thead><tr>' +
        '<th style="width:35%">Inv &gt; Trd &gt; Brk</th>' +
        '<th class="r" style="width:13%">Qty</th>' +
        '<th class="r" style="width:17%">Price</th>' +
        '<th class="r" style="width:17%">TDS 10%</th>' +
        '<th class="r" style="width:18%">Amount</th>' +
        '</tr></thead><tbody>';

    holdings.forEach(function(h, idx) {
        var isDup = incIsDuplicateRow(existingDups, h);
        var rowStyle = isDup ? ' style="background:#fef3c7;"' : '';
        var dupTag = isDup ? ' <span style="color:#d97706;font-size:9px;font-weight:600;">(EXISTS)</span>' : '';
        html += '<tr' + rowStyle + '>' +
            '<td class="inc-label-cell">' + h.combinedLabel + dupTag + '</td>' +
            '<td class="inc-qty-cell">' + h.netQuantity.toLocaleString() + '</td>' +
            '<td class="r"><input type="text" id="inc-price-' + idx + '" data-idx="' + idx + '" class="inc-price" placeholder="0.00"></td>' +
            '<td class="r"><input type="text" id="inc-tds-' + idx + '" data-idx="' + idx + '" class="inc-tds" placeholder="0.00"></td>' +
            '<td class="r"><input type="text" id="inc-amt-' + idx + '" data-idx="' + idx + '" class="inc-amt" placeholder="0.00"></td>' +
            '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('incTableWrap').innerHTML = html;
    document.getElementById('incSaveBtn').disabled = false;

    // Bind focus/blur/input handlers
    holdings.forEach(function(h, idx) {
        var priceEl = document.getElementById('inc-price-' + idx);
        var tdsEl = document.getElementById('inc-tds-' + idx);
        var amtEl = document.getElementById('inc-amt-' + idx);

        // Focus: show raw value
        [priceEl, tdsEl, amtEl].forEach(function(el) {
            el.addEventListener('focus', function() {
                var raw = el.dataset.rawValue || '';
                el.value = (raw && parseFloat(raw) !== 0) ? raw : '';
            });
            el.addEventListener('blur', function() {
                var v = parseFloat(el.value.replace(/,/g, '')) || 0;
                el.dataset.rawValue = v ? v.toString() : '';
                el.value = v ? wmsFmtAmt(v) : '';
            });
        });

        // Price input → auto-calc TDS and Amount
        priceEl.addEventListener('input', function() { incOnPriceChange(idx); });
        // TDS/Amount manual edits: mark as user-overridden
        tdsEl.addEventListener('input', function() { tdsEl.dataset.userEdited = 'true'; });
        amtEl.addEventListener('input', function() { amtEl.dataset.userEdited = 'true'; });
    });
}

// ============================================================================
// AUTO-CALC: Price → TDS (10%) and Amount (qty × price)
// ============================================================================

function incOnPriceChange(idx) {
    if (idx < 0 || idx >= incHoldings.length) return;
    var h = incHoldings[idx];

    var priceEl = document.getElementById('inc-price-' + idx);
    var tdsEl = document.getElementById('inc-tds-' + idx);
    var amtEl = document.getElementById('inc-amt-' + idx);

    var price = parseFloat(priceEl.value.replace(/,/g, '')) || 0;
    var grossAmount = Math.round(h.netQuantity * price * 100) / 100;
    var tds = Math.round(grossAmount * WMS_TDS_DEFAULT_RATE * 100) / 100;

    // Only auto-fill if user hasn't manually edited
    if (tdsEl.dataset.userEdited !== 'true') {
        tdsEl.dataset.rawValue = tds ? tds.toString() : '';
        tdsEl.value = tds ? wmsFmtAmt(tds) : '';
    }
    if (amtEl.dataset.userEdited !== 'true') {
        amtEl.dataset.rawValue = grossAmount ? grossAmount.toString() : '';
        amtEl.value = grossAmount ? wmsFmtAmt(grossAmount) : '';
    }
}

// ============================================================================
// DATE CHANGE HANDLER — called by rhDateOnChange when prefix='inc'
// ============================================================================

function incDateOnChange() {
    incPopulateHoldings();
}

// ============================================================================
// DUPLICATE DETECTION
// Checks trTransactions for existing income txns matching type + symbol + date
// ============================================================================

function incFindDuplicates(shortSym, dateStr) {
    if (!trTransactions || !incSelectedType) return [];
    return trTransactions.filter(function(t) {
        var sym = t.short_symbol || t.symbol;
        return t.transaction_type === incSelectedType &&
            sym === shortSym &&
            t.transaction_date === dateStr &&
            !t.dont_display;
    });
}

function incIsDuplicateRow(existingDups, holding) {
    return existingDups.some(function(t) {
        return t.investor_id === holding.investor_id &&
            (t.trader_id || null) === (holding.trader_id || null) &&
            t.broker_id === holding.broker_id;
    });
}

// ============================================================================
// SAVE TRANSACTIONS
// ============================================================================

async function incSaveTransactions() {
    var dateStr = rhDateGetIsoStr('inc');
    if (!incSelectedSecurity) { showAlert('Select date and security first.', 'error', 3000); return; }
    if (!incSelectedType) { showAlert('No income type selected.', 'error', 3000); return; }

    var sec = incSelectedSecurity;
    var sym = sec.nse_symbol || sec.symbol;
    var txns = [];

    incHoldings.forEach(function(h, idx) {
        if (h.netQuantity <= 0) return;

        var priceEl = document.getElementById('inc-price-' + idx);
        var tdsEl = document.getElementById('inc-tds-' + idx);
        var amtEl = document.getElementById('inc-amt-' + idx);

        var price = parseFloat((priceEl.dataset.rawValue || priceEl.value || '').replace(/,/g, '')) || 0;
        var tds = parseFloat((tdsEl.dataset.rawValue || tdsEl.value || '').replace(/,/g, '')) || 0;
        var grossAmount = parseFloat((amtEl.dataset.rawValue || amtEl.value || '').replace(/,/g, '')) || 0;

        // Skip row if all three are 0/empty
        if (price === 0 && tds === 0 && grossAmount === 0) return;

        // If only price entered, recalculate amount if user didn't override
        if (price > 0 && grossAmount === 0 && amtEl.dataset.userEdited !== 'true') {
            grossAmount = Math.round(h.netQuantity * price * 100) / 100;
        }

        var netAmount = Math.round((grossAmount - tds) * 100) / 100;

        txns.push({
            investor_id: h.investor_id,
            trader_id: h.trader_id || null,
            broker_id: h.broker_id,
            security_id: sec.id,
            security_type: sec.security_type || 'EQUITY',
            symbol: sym,
            short_symbol: sym,
            company_name: sec.company_name || sym,
            exchange: 'NSE',
            product: null,
            transaction_type: incSelectedType,
            transaction_date: dateStr,
            quantity: h.netQuantity,
            lots: 0,
            price: Math.round(price * 100) / 100,
            gross_amount: Math.round(grossAmount * 100) / 100,
            brokerage: 0,
            stt: 0,
            other_charges: 0,
            gst: 0,
            tds: Math.round(tds * 100) / 100,
            total_charges: Math.round(tds * 100) / 100,
            trader_charges: 0,
            net_amount: netAmount,
            margin_blocked: 0,
            broker_contract_note_no: null,
            broker_trade_id: null,
            tags: ['blank'],
            notes: '[' + (INC_TYPE_LABELS[incSelectedType] || incSelectedType) + ' for ' + h.netQuantity + ' units of ' + sym + ' @ ' + price + ']',
            is_locked: false,
            ignore_for_avg_cost: false,
            dont_display: false
        });
    });

    if (txns.length === 0) {
        showAlert('No valid rows to save. Enter a price for at least one row.', 'error', 3000);
        return;
    }

    // Save-time duplicate check: warn if any of the rows being saved already exist
    var shortSym = sec.nse_symbol || sec.symbol;
    var saveDups = incFindDuplicates(shortSym, dateStr);
    if (saveDups.length > 0) {
        var dupCount = 0;
        txns.forEach(function(txn) {
            if (saveDups.some(function(d) {
                return d.investor_id === txn.investor_id &&
                    (d.trader_id || null) === (txn.trader_id || null) &&
                    d.broker_id === txn.broker_id;
            })) dupCount++;
        });
        if (dupCount > 0) {
            var msg = dupCount + ' of ' + txns.length + ' row(s) already have a ' +
                (INC_TYPE_LABELS[incSelectedType] || incSelectedType) + ' entry for ' +
                shortSym + ' on ' + dateStr + '. Save anyway?';
            if (!confirm(msg)) return;
        }
    }

    try {
        document.getElementById('incSaveBtn').disabled = true;
        await wmsBatchCreateTransactions(txns);
        closeIncomeModal();
        if (typeof trRefresh === 'function') await trRefresh();
        showAlert((INC_TYPE_LABELS[incSelectedType] || 'Income') + ': ' + txns.length + ' transaction(s) saved.', 'success', 4000);
    } catch (e) {
        wmsShowError((INC_TYPE_LABELS[incSelectedType] || 'Income') + ' save failed', e);
        document.getElementById('incSaveBtn').disabled = false;
    }
}

// ============================================================================
// GLOBAL EXPORTS
// ============================================================================

window.openIncomeModal = openIncomeModal;

// Module init on script load
initIncomeModule();
