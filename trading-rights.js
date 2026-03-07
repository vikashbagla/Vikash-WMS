// ============================================================================
// trading-rights.js — Rights Corporate Action (Entitlement + Payment)
// Rule A.1.2: All module-level state uses var
// ============================================================================

// Entitlement state
var rhEntSelectedSecurity = null;   // {id, symbol, company_name, ...} from wmsRefData
var rhEntHoldings = [];             // [{investor_id, trader_id, broker_id, netQuantity, ...}]

// Payment state
var rhPaySelectedSecurity = null;   // RE- security object
var rhPayHoldings = [];

// ============================================================================
// INIT
// ============================================================================

function initRightsModule() {
    // --- Entitlement modal ---
    document.getElementById('rhEntCloseBtn').addEventListener('click', closeRightsEntitlementModal);
    document.getElementById('rhEntCancelBtn').addEventListener('click', closeRightsEntitlementModal);
    document.getElementById('rightsEntitlementOverlay').addEventListener('click', function(e) {
        if (e.target === this) closeRightsEntitlementModal();
    });
    document.getElementById('rhEntConfirmBtn').addEventListener('click', rhEntConfirmAndReview);
    document.getElementById('rhEntDate').addEventListener('change', rhEntPopulateHoldings);

    // Entitlement symbol search
    var entInput = document.getElementById('rhEntSymbolInput');
    var entDd = document.getElementById('rhEntSymbolDd');
    entInput.addEventListener('input', function() {
        rhSearchSymbol(entInput, entDd, false);
    });
    entInput.addEventListener('blur', function() {
        setTimeout(function() { entDd.style.display = 'none'; }, 200);
    });
    entDd.addEventListener('mousedown', function(e) {
        var item = e.target.closest('.rh-dd-item');
        if (!item) return;
        e.preventDefault();
        var idx = parseInt(item.dataset.idx);
        var results = entDd._rhResults || [];
        if (results[idx]) rhEntSelectSymbol(results[idx]);
        entDd.style.display = 'none';
    });

    // --- Payment modal ---
    document.getElementById('rhPayCloseBtn').addEventListener('click', closeRightsPaymentModal);
    document.getElementById('rhPayCancelBtn').addEventListener('click', closeRightsPaymentModal);
    document.getElementById('rightsPaymentOverlay').addEventListener('click', function(e) {
        if (e.target === this) closeRightsPaymentModal();
    });
    document.getElementById('rhPaySaveBtn').addEventListener('click', rhPaySaveTransactions);
    document.getElementById('rhPayDate').addEventListener('change', rhPayPopulateHoldings);

    // Payment security search (RE- only)
    var payInput = document.getElementById('rhPaySecurityInput');
    var payDd = document.getElementById('rhPaySecurityDd');
    payInput.addEventListener('input', function() {
        rhSearchSymbol(payInput, payDd, true);
    });
    payInput.addEventListener('blur', function() {
        setTimeout(function() { payDd.style.display = 'none'; }, 200);
    });
    payDd.addEventListener('mousedown', function(e) {
        var item = e.target.closest('.rh-dd-item');
        if (!item) return;
        e.preventDefault();
        var idx = parseInt(item.dataset.idx);
        var results = payDd._rhResults || [];
        if (results[idx]) rhPaySelectSecurity(results[idx]);
        payDd.style.display = 'none';
    });

    // ESC handler
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            if (document.getElementById('rightsEntitlementOverlay').classList.contains('show')) {
                closeRightsEntitlementModal();
            } else if (document.getElementById('rightsPaymentOverlay').classList.contains('show')) {
                closeRightsPaymentModal();
            }
        }
    });
}

// ============================================================================
// SHARED: Symbol search
// ============================================================================

function rhSearchSymbol(input, dd, reOnly) {
    var q = input.value.trim();
    if (q.length < 1) { dd.style.display = 'none'; dd._rhResults = []; return; }

    var results = wmsSearchSecurities(q);
    if (reOnly) {
        // Filter to RE- prefix securities only
        results = results.filter(function(s) {
            return s.isin && s.isin.indexOf('RE-') === 0;
        });
    }

    dd._rhResults = results;
    dd.innerHTML = '';
    if (results.length === 0) {
        dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No securities found</div>';
        dd.style.display = 'block';
        return;
    }
    results.forEach(function(sec, idx) {
        var div = document.createElement('div');
        div.className = 'rh-dd-item';
        div.dataset.idx = idx;
        div.innerHTML = '<strong>' + (sec.nse_symbol || sec.symbol) + '</strong> — ' + sec.company_name;
        dd.appendChild(div);
    });
    dd.style.display = 'block';
}

// ============================================================================
// SHARED: Holdings as-of-date calculation
// ============================================================================

function rhCalcHoldingsAsOfDate(shortSymbol, targetDate) {
    // Filter transactions: matching symbol, date <= targetDate, not hidden
    var filtered = trTransactions.filter(function(t) {
        var sym = t.short_symbol || t.symbol;
        return !t.dont_display && sym === shortSymbol && t.transaction_date <= targetDate;
    });

    // Group by investor_id|trader_id|broker_id
    var groups = {};
    filtered.forEach(function(t) {
        var key = (t.investor_id || '') + '|' + (t.trader_id || '') + '|' + (t.broker_id || '');
        if (!groups[key]) {
            groups[key] = {
                investor_id: t.investor_id,
                trader_id: t.trader_id,
                broker_id: t.broker_id,
                txns: []
            };
        }
        groups[key].txns.push(t);
    });

    // Calc avg cost per group, resolve display names
    var invMap = wmsRefData.investorObjMap || {};
    var brkMap = wmsRefData.brokerObjMap || {};
    var results = [];

    Object.keys(groups).forEach(function(key) {
        var g = groups[key];
        var calc = wmsCalcAvgCost(g.txns);
        if (calc.netQuantity <= 0) return; // skip zero/negative

        var inv = invMap[g.investor_id];
        var trader = g.trader_id ? invMap[g.trader_id] : null;
        var brk = brkMap[g.broker_id];

        results.push({
            investor_id: g.investor_id,
            trader_id: g.trader_id,
            broker_id: g.broker_id,
            invName: inv ? (inv.short_name || inv.name) : '—',
            traderName: trader ? (trader.short_name || trader.name) : '',
            brkName: brk ? (brk.broker_code || brk.name) : '—',
            netQuantity: calc.netQuantity,
            avgCost: calc.avgCost
        });
    });

    return results;
}

// ============================================================================
// ENTITLEMENT: Open / Close
// ============================================================================

function openRightsEntitlementModal() {
    rhEntSelectedSecurity = null;
    rhEntHoldings = [];
    document.getElementById('rhEntDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('rhEntSymbolInput').value = '';
    document.getElementById('rhEntSymbolBadge').innerHTML = '';
    document.getElementById('rhEntTableWrap').innerHTML = '<div class="rights-empty">Select a date and symbol to view holdings</div>';
    document.getElementById('rhEntConfirmBtn').disabled = true;
    document.getElementById('rightsEntitlementOverlay').classList.add('show');
    setTimeout(function() { document.getElementById('rhEntSymbolInput').focus(); }, 100);
}

function closeRightsEntitlementModal() {
    document.getElementById('rightsEntitlementOverlay').classList.remove('show');
}

// ============================================================================
// ENTITLEMENT: Symbol selection + populate holdings
// ============================================================================

function rhEntSelectSymbol(security) {
    rhEntSelectedSecurity = security;
    var shortSym = security.nse_symbol || security.symbol;
    document.getElementById('rhEntSymbolInput').value = '';
    document.getElementById('rhEntSymbolBadge').innerHTML =
        '<span class="rights-selected-badge">' + shortSym + ' — ' + security.company_name + '</span>';
    rhEntPopulateHoldings();
}

function rhEntPopulateHoldings() {
    var dateStr = document.getElementById('rhEntDate').value;
    if (!dateStr || !rhEntSelectedSecurity) {
        document.getElementById('rhEntTableWrap').innerHTML = '<div class="rights-empty">Select a date and symbol to view holdings</div>';
        document.getElementById('rhEntConfirmBtn').disabled = true;
        return;
    }

    var shortSym = rhEntSelectedSecurity.nse_symbol || rhEntSelectedSecurity.symbol;
    var holdings = rhCalcHoldingsAsOfDate(shortSym, dateStr);
    rhEntHoldings = holdings;

    if (holdings.length === 0) {
        document.getElementById('rhEntTableWrap').innerHTML = '<div class="rights-empty">No holdings found for ' + shortSym + ' as of ' + dateStr + '</div>';
        document.getElementById('rhEntConfirmBtn').disabled = true;
        return;
    }

    var html = '<table class="rights-table"><thead><tr>' +
        '<th>Investor</th><th>Trader</th><th>Broker</th>' +
        '<th class="r">Current Qty</th><th class="r">Rights Recd</th>' +
        '</tr></thead><tbody>';
    holdings.forEach(function(h, idx) {
        html += '<tr>' +
            '<td>' + h.invName + '</td>' +
            '<td>' + h.traderName + '</td>' +
            '<td>' + h.brkName + '</td>' +
            '<td class="r">' + h.netQuantity + '</td>' +
            '<td class="r"><input type="number" min="0" step="1" data-idx="' + idx + '" class="rh-ent-qty"></td>' +
            '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('rhEntTableWrap').innerHTML = html;
    document.getElementById('rhEntConfirmBtn').disabled = false;
}

// ============================================================================
// ENTITLEMENT: Confirm → Open PE modal for RE- security review
// ============================================================================

function rhEntConfirmAndReview() {
    // Collect quantities
    var inputs = document.querySelectorAll('.rh-ent-qty');
    var hasAny = false;
    inputs.forEach(function(inp) {
        var idx = parseInt(inp.dataset.idx);
        var qty = parseInt(inp.value) || 0;
        if (rhEntHoldings[idx]) {
            rhEntHoldings[idx].rightsReceived = qty;
            if (qty > 0) hasAny = true;
        }
    });
    if (!hasAny) { alert('Please enter at least one rights quantity.'); return; }

    // Close entitlement modal (keep state)
    document.getElementById('rightsEntitlementOverlay').classList.remove('show');

    // Pre-fill the PE modal for RE- security creation
    var sec = rhEntSelectedSecurity;
    var shortSym = sec.nse_symbol || sec.symbol;

    // Check if master-data module is loaded (PE modal is there)
    if (typeof openAddPeSecurityModal !== 'function') {
        alert('Master Data module must be loaded first. Please open Master Database tab, then try again.');
        document.getElementById('rightsEntitlementOverlay').classList.add('show');
        return;
    }

    // Open as new (not edit)
    openAddPeSecurityModal();

    // Override fields for RE- security
    setTimeout(function() {
        document.getElementById('peSecurityModalTitle').textContent = 'New Rights Security (Review & Save)';
        document.getElementById('peSymbol').value = shortSym;
        document.getElementById('peCompanyName').value = sec.company_name || shortSym;
        document.getElementById('peIsin').value = 'RE-' + shortSym;
        // Set type to RIGHTS if available in dropdown, else set as new
        var typeSelect = document.getElementById('peType');
        var hasRights = false;
        for (var i = 0; i < typeSelect.options.length; i++) {
            if (typeSelect.options[i].value === 'RIGHTS') { hasRights = true; break; }
        }
        if (hasRights) {
            typeSelect.value = 'RIGHTS';
        } else {
            typeSelect.value = '__new__';
            document.getElementById('peTypeNew').style.display = 'block';
            document.getElementById('peTypeNew').value = 'RIGHTS';
        }

        // Override ISIN auto-update to use RE- prefix
        document.getElementById('peSymbol').oninput = function() {
            var sym = this.value.trim().toUpperCase();
            document.getElementById('peIsin').value = sym ? 'RE-' + sym : '';
        };

        // Override savePeSecurity to chain into rights flow
        window._rhOrigSavePeSecurity = window.savePeSecurity;
        window.savePeSecurity = async function() {
            await rhEntSaveSecurityAndTransactions();
        };
    }, 150);
}

// ============================================================================
// ENTITLEMENT: Save RE security + create entitlement transactions
// ============================================================================

async function rhEntSaveSecurityAndTransactions() {
    var symbol = document.getElementById('peSymbol').value.trim().toUpperCase();
    var companyName = document.getElementById('peCompanyName').value.trim();
    if (!symbol) { alert('Please enter a symbol'); return; }
    if (!companyName) { alert('Please enter a company name'); return; }

    var isin = 'RE-' + symbol;

    // Resolve type
    var typeSel = document.getElementById('peType').value;
    var securityType = typeSel === '__new__'
        ? (document.getElementById('peTypeNew').value.trim().toUpperCase() || 'RIGHTS')
        : typeSel || 'RIGHTS';

    // Resolve asset class
    var acSel = document.getElementById('peAssetClass').value;
    var assetClass = acSel === '__new__'
        ? document.getElementById('peAssetClassNew').value.trim() || null
        : acSel || null;

    // Resolve sector
    var secSel = document.getElementById('peSector').value;
    var sector = secSel === '__new__'
        ? document.getElementById('peSectorNew').value.trim() || null
        : secSel || null;

    var secData = {
        symbol: symbol,
        company_name: companyName,
        isin: isin,
        security_type: securityType,
        asset_class: assetClass,
        sector: sector,
        lot_size: parseInt(document.getElementById('peLotSize').value) || 1,
        is_active: document.getElementById('peStatus').value === 'true'
    };

    try {
        var headers = {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        };

        // Check if RE-SYMBOL ISIN already exists
        var checkResp = await fetch(SUPABASE_URL + '/rest/v1/securities_db?isin=eq.' + encodeURIComponent(isin) + '&select=id', {
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
        });
        var existing = await checkResp.json();
        if (existing && existing.length > 0) {
            alert('A security with ISIN "' + isin + '" already exists.');
            return;
        }

        // Insert new RE security
        var resp = await fetch(SUPABASE_URL + '/rest/v1/securities_db', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(secData)
        });
        if (!resp.ok) {
            var errBody = await resp.text();
            throw new Error('Insert failed: ' + errBody);
        }

        var created = await resp.json();
        var newSecId = Array.isArray(created) ? created[0].id : created.id;

        // Now create entitlement transactions
        var dateStr = document.getElementById('rhEntDate').value;
        var txns = [];
        rhEntHoldings.forEach(function(h) {
            if (!h.rightsReceived || h.rightsReceived <= 0) return;
            txns.push({
                investor_id: h.investor_id,
                trader_id: h.trader_id || null,
                broker_id: h.broker_id,
                security_id: newSecId,
                security_type: securityType,
                symbol: isin,
                short_symbol: isin,
                company_name: companyName,
                exchange: 'NSE',
                product: null,
                transaction_type: 'RIGHTS_ENTITLEMENT',
                transaction_date: dateStr,
                quantity: h.rightsReceived,
                lots: 0,
                price: 0,
                gross_amount: 0,
                brokerage: 0,
                stt: 0,
                other_charges: 0,
                gst: 0,
                tds: 0,
                total_charges: 0,
                trader_charges: 0,
                net_amount: 0,
                margin_blocked: 0,
                broker_contract_note_no: null,
                broker_trade_id: null,
                tags: ['blank'],
                notes: '[Rights Entitlement from ' + (rhEntSelectedSecurity.nse_symbol || rhEntSelectedSecurity.symbol) + ' on ' + dateStr + ']',
                is_locked: false,
                ignore_for_avg_cost: false,
                dont_display: false
            });
        });

        if (txns.length > 0) {
            await rhBatchCreateTransactions(txns);
        }

        // Restore original savePeSecurity
        if (window._rhOrigSavePeSecurity) {
            window.savePeSecurity = window._rhOrigSavePeSecurity;
            delete window._rhOrigSavePeSecurity;
        }

        // Close PE modal
        closePeSecurityModal();

        // Refresh caches
        await wmsLoadSecuritiesCm();
        if (typeof trRefresh === 'function') await trRefresh();

        showAlert('Rights entitlement created: ' + txns.length + ' transaction(s) for ' + isin, 'success', 4000);

    } catch (e) {
        console.error('Rights entitlement error:', e);
        alert('Error: ' + e.message);
    }
}

// ============================================================================
// PAYMENT: Open / Close
// ============================================================================

function openRightsPaymentModal() {
    rhPaySelectedSecurity = null;
    rhPayHoldings = [];
    document.getElementById('rhPayDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('rhPaySecurityInput').value = '';
    document.getElementById('rhPaySecurityBadge').innerHTML = '';
    document.getElementById('rhPayTableWrap').innerHTML = '<div class="rights-empty">Select a date and RE-security to view holdings</div>';
    document.getElementById('rhPaySaveBtn').disabled = true;
    document.getElementById('rightsPaymentOverlay').classList.add('show');
    setTimeout(function() { document.getElementById('rhPaySecurityInput').focus(); }, 100);
}

function closeRightsPaymentModal() {
    document.getElementById('rightsPaymentOverlay').classList.remove('show');
}

// ============================================================================
// PAYMENT: Security selection + populate holdings
// ============================================================================

function rhPaySelectSecurity(security) {
    rhPaySelectedSecurity = security;
    var sym = security.nse_symbol || security.symbol;
    document.getElementById('rhPaySecurityInput').value = '';
    document.getElementById('rhPaySecurityBadge').innerHTML =
        '<span class="rights-selected-badge">' + sym + ' — ' + security.company_name + '</span>';
    rhPayPopulateHoldings();
}

function rhPayPopulateHoldings() {
    var dateStr = document.getElementById('rhPayDate').value;
    if (!dateStr || !rhPaySelectedSecurity) {
        document.getElementById('rhPayTableWrap').innerHTML = '<div class="rights-empty">Select a date and RE-security to view holdings</div>';
        document.getElementById('rhPaySaveBtn').disabled = true;
        return;
    }

    var shortSym = rhPaySelectedSecurity.nse_symbol || rhPaySelectedSecurity.symbol;
    var holdings = rhCalcHoldingsAsOfDate(shortSym, dateStr);
    rhPayHoldings = holdings;

    if (holdings.length === 0) {
        document.getElementById('rhPayTableWrap').innerHTML = '<div class="rights-empty">No RE holdings found for ' + shortSym + ' as of ' + dateStr + '</div>';
        document.getElementById('rhPaySaveBtn').disabled = true;
        return;
    }

    var html = '<table class="rights-table"><thead><tr>' +
        '<th>Investor</th><th>Trader</th><th>Broker</th>' +
        '<th class="r">RE Qty</th><th class="r">Price</th>' +
        '<th class="r">Charges</th><th class="r">Total</th>' +
        '</tr></thead><tbody>';
    holdings.forEach(function(h, idx) {
        html += '<tr>' +
            '<td>' + h.invName + '</td>' +
            '<td>' + h.traderName + '</td>' +
            '<td>' + h.brkName + '</td>' +
            '<td class="r">' + h.netQuantity + '</td>' +
            '<td class="r"><input type="number" min="0" step="0.01" data-idx="' + idx + '" class="rh-pay-price" oninput="rhPayUpdateTotal(' + idx + ')"></td>' +
            '<td class="r"><input type="number" min="0" step="0.01" data-idx="' + idx + '" class="rh-pay-charges" value="0" oninput="rhPayUpdateTotal(' + idx + ')"></td>' +
            '<td class="r"><span id="rh-pay-total-' + idx + '">0</span></td>' +
            '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('rhPayTableWrap').innerHTML = html;
    document.getElementById('rhPaySaveBtn').disabled = false;
}

function rhPayUpdateTotal(idx) {
    if (idx < 0 || idx >= rhPayHoldings.length) return;
    var h = rhPayHoldings[idx];
    var priceInput = document.querySelector('.rh-pay-price[data-idx="' + idx + '"]');
    var chargesInput = document.querySelector('.rh-pay-charges[data-idx="' + idx + '"]');
    var totalSpan = document.getElementById('rh-pay-total-' + idx);
    if (!priceInput || !totalSpan) return;

    var price = parseFloat(priceInput.value) || 0;
    var charges = parseFloat(chargesInput ? chargesInput.value : 0) || 0;
    var total = (h.netQuantity * price) + charges;
    totalSpan.textContent = total > 0 ? total.toFixed(2) : '0';
}

// ============================================================================
// PAYMENT: Save transactions
// ============================================================================

async function rhPaySaveTransactions() {
    var dateStr = document.getElementById('rhPayDate').value;
    if (!dateStr || !rhPaySelectedSecurity) { alert('Select date and security first.'); return; }

    var sec = rhPaySelectedSecurity;
    var sym = sec.nse_symbol || sec.symbol;
    var txns = [];

    rhPayHoldings.forEach(function(h, idx) {
        if (h.netQuantity <= 0) return;
        var priceInput = document.querySelector('.rh-pay-price[data-idx="' + idx + '"]');
        var chargesInput = document.querySelector('.rh-pay-charges[data-idx="' + idx + '"]');
        var price = parseFloat(priceInput ? priceInput.value : 0) || 0;
        var charges = parseFloat(chargesInput ? chargesInput.value : 0) || 0;
        if (price <= 0) return; // skip rows with no price

        var grossAmount = h.netQuantity * price;
        txns.push({
            investor_id: h.investor_id,
            trader_id: h.trader_id || null,
            broker_id: h.broker_id,
            security_id: sec.id,
            security_type: sec.security_type || 'RIGHTS',
            symbol: sym,
            short_symbol: sym,
            company_name: sec.company_name || sym,
            exchange: 'NSE',
            product: null,
            transaction_type: 'BUY',
            transaction_date: dateStr,
            quantity: h.netQuantity,
            lots: 0,
            price: Math.round(price * 100) / 100,
            gross_amount: Math.round(grossAmount * 100) / 100,
            brokerage: 0,
            stt: 0,
            other_charges: Math.round(charges * 100) / 100,
            gst: 0,
            tds: 0,
            total_charges: Math.round(charges * 100) / 100,
            trader_charges: 0,
            net_amount: Math.round((grossAmount + charges) * 100) / 100,
            margin_blocked: 0,
            broker_contract_note_no: null,
            broker_trade_id: null,
            tags: ['blank'],
            notes: '[Rights Payment for ' + sym + ']',
            is_locked: false,
            ignore_for_avg_cost: false,
            dont_display: false
        });
    });

    if (txns.length === 0) { alert('No valid rows to save. Enter a price for at least one row.'); return; }

    try {
        document.getElementById('rhPaySaveBtn').disabled = true;
        await rhBatchCreateTransactions(txns);
        closeRightsPaymentModal();
        if (typeof trRefresh === 'function') await trRefresh();
        showAlert('Rights payment: ' + txns.length + ' transaction(s) saved.', 'success', 4000);
    } catch (e) {
        console.error('Rights payment error:', e);
        alert('Error: ' + e.message);
        document.getElementById('rhPaySaveBtn').disabled = false;
    }
}

// ============================================================================
// SHARED: Batch create transactions
// ============================================================================

async function rhBatchCreateTransactions(txns) {
    var headers = {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
    };
    for (var i = 0; i < txns.length; i += 10) {
        var batch = txns.slice(i, i + 10);
        var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(batch)
        });
        if (!resp.ok) {
            var errText = await resp.text();
            throw new Error('DB error: ' + resp.status + ' — ' + errText);
        }
    }
}

// ============================================================================
// GLOBAL EXPORTS
// ============================================================================

window.openRightsEntitlementModal = openRightsEntitlementModal;
window.openRightsPaymentModal = openRightsPaymentModal;
window.rhPayUpdateTotal = rhPayUpdateTotal;
