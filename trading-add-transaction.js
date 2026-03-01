// ============================================================================
// trading-add-transaction.js — Add Transaction Modal for Trading Module
// Rule A.1.2: All module-level state uses var (not let/const) to avoid TDZ on reload
// Rule A.1.3: No function names that collide with utils.js const (showAlert, showLoading)
// ============================================================================

// SUPABASE_URL and SUPABASE_ANON_KEY are globals from app.html — do not redeclare

// Reference data (loaded on first modal open)
var atInvestors = [];         // [{id, name, short_name, stt_accounting_method, financial_year_start}]
var atBrokers = [];           // [{id, name, broker_code}]
var atInvObjMap = {};         // investor_id → investor object
var atBrkObjMap = {};         // broker_id → broker object
var atIbaRatesMap = {};       // "investorId|brokerId" → {rates, charges_inclusive}
var atRegCharges = [];        // Active regulatory_charges_config rows
var atExistingTags = [];      // Distinct tags from transactions
var atRefDataLoaded = false;

// Form state
var atSelectedInvestor = null;  // {id, name, short_name}
var atSelectedBroker = null;    // {id, name, broker_code}
var atRows = [];                // Array of row data objects
var atNextRowId = 1;

// Dropdown keyboard nav state
var atInvDdIdx = -1;
var atBrkDdIdx = -1;
var atSymDdIdx = {};          // rowId → highlighted index

// Options search constants (same as trading-watchlist.js — keep in sync)
var AT_MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
var AT_WEEKLY_EXPIRY_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];

// Charges popover state
var atCpRowId = null;

// ============================================================================
// Module Init
// ============================================================================

function initAddTxnModule() {
    // Modal close handlers
    document.getElementById('addTxnCloseBtn').addEventListener('click', closeAddTxnModal);
    document.getElementById('addTxnCancelBtn').addEventListener('click', closeAddTxnModal);
    document.getElementById('addTxnOverlay').addEventListener('click', function(e) {
        if (e.target === this) closeAddTxnModal();
    });

    // Save
    document.getElementById('addTxnSaveBtn').addEventListener('click', openAddTxnConfirmation);

    // Charges popover close
    document.getElementById('addTxnCpCloseBtn').addEventListener('click', closeAddTxnCp);
    document.getElementById('addTxnCpOverlay').addEventListener('click', function(e) {
        if (e.target === this) closeAddTxnCp();
    });

    // Confirmation dialog
    document.getElementById('addTxnConfirmCancelBtn').addEventListener('click', closeAddTxnConfirm);
    document.getElementById('addTxnConfirmOkBtn').addEventListener('click', importAddTxnToDb);

    // Investor search
    setupAddTxnInvSearch();

    // Broker search
    setupAddTxnBrkSearch();

    // ESC key handler
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            if (document.getElementById('addTxnConfirmOverlay').classList.contains('show')) {
                closeAddTxnConfirm();
            } else if (document.getElementById('addTxnCpOverlay').classList.contains('show')) {
                closeAddTxnCp();
            } else if (document.getElementById('addTxnOverlay').classList.contains('show')) {
                closeAddTxnModal();
            }
        }
    });
}

// ============================================================================
// Open / Close Modal
// ============================================================================

async function openAddTxnModal() {
    // Load ref data on first open
    if (!atRefDataLoaded) {
        await loadAddTxnRefData();
    }

    // Reset state
    atSelectedInvestor = null;
    atSelectedBroker = null;
    atRows = [];
    atNextRowId = 1;
    document.getElementById('addTxnTbody').innerHTML = '';
    document.getElementById('addTxnInvInput').value = '';
    document.getElementById('addTxnBrkInput').value = '';
    document.getElementById('addTxnInvBadge').innerHTML = '';
    document.getElementById('addTxnBrkBadge').innerHTML = '';
    document.getElementById('addTxnInvInput').disabled = false;
    document.getElementById('addTxnBrkInput').disabled = false;
    document.getElementById('addTxnSaveBtn').disabled = false;

    // Default date to today
    var today = new Date();
    var yyyy = today.getFullYear();
    var mm = String(today.getMonth() + 1).padStart(2, '0');
    var dd = String(today.getDate()).padStart(2, '0');
    document.getElementById('addTxnDate').value = yyyy + '-' + mm + '-' + dd;

    // Add first empty row
    addAddTxnRow();

    // Show modal
    document.getElementById('addTxnOverlay').classList.add('show');

    // Focus investor input
    setTimeout(function() {
        document.getElementById('addTxnInvInput').focus();
    }, 100);
}

function closeAddTxnModal() {
    document.getElementById('addTxnOverlay').classList.remove('show');
}

window.openAddTxnModal = openAddTxnModal;
window.closeAddTxnModal = closeAddTxnModal;

// ============================================================================
// Reference Data Loading
// ============================================================================

async function loadAddTxnRefData() {
    var headers = { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY };
    try {
        var resp;

        // Investors
        resp = await fetch(SUPABASE_URL + '/rest/v1/investors?select=id,name,short_name,stt_accounting_method,financial_year_start&is_active=eq.true', { headers: headers });
        atInvestors = await resp.json();
        atInvObjMap = {};
        atInvestors.forEach(function(inv) { atInvObjMap[inv.id] = inv; });

        // Brokers
        resp = await fetch(SUPABASE_URL + '/rest/v1/brokers?select=id,name,broker_code&is_active=eq.true', { headers: headers });
        atBrokers = await resp.json();
        atBrkObjMap = {};
        atBrokers.forEach(function(b) { atBrkObjMap[b.id] = b; });

        // IBA rates
        resp = await fetch(SUPABASE_URL + '/rest/v1/investor_broker_accounts?select=investor_id,broker_id,brokerage_rates,charges_inclusive&is_active=eq.true', { headers: headers });
        var ibAccounts = await resp.json();
        atIbaRatesMap = {};
        ibAccounts.forEach(function(iba) {
            if (iba.brokerage_rates) {
                atIbaRatesMap[iba.investor_id + '|' + iba.broker_id] = {
                    rates: iba.brokerage_rates,
                    charges_inclusive: !!iba.charges_inclusive
                };
            }
        });

        // Regulatory charges (active only)
        resp = await fetch(SUPABASE_URL + '/rest/v1/regulatory_charges_config?effective_to=is.null&select=*', { headers: headers });
        atRegCharges = await resp.json();

        // Existing tags
        resp = await fetch(SUPABASE_URL + '/rest/v1/transactions?select=tags&tags=not.is.null&limit=5000', { headers: headers });
        var tagRows = await resp.json();
        var tagSet = {};
        tagRows.forEach(function(r) {
            if (Array.isArray(r.tags)) {
                r.tags.forEach(function(t) {
                    var trimmed = t.trim().toLowerCase();
                    if (trimmed && trimmed !== 'blank') tagSet[trimmed] = true;
                });
            }
        });
        atExistingTags = Object.keys(tagSet).sort();

        atRefDataLoaded = true;
        console.log('AddTxn ref data: ' + atInvestors.length + ' inv, ' + atBrokers.length + ' brk, ' + Object.keys(atIbaRatesMap).length + ' IBA, ' + atRegCharges.length + ' reg, ' + atExistingTags.length + ' tags');
    } catch (e) {
        console.error('AddTxn ref data error:', e);
        showAlert('Error loading reference data: ' + e.message, 'error');
    }
}

// ============================================================================
// Investor / Broker Type-to-Search
// ============================================================================

function setupAddTxnInvSearch() {
    var input = document.getElementById('addTxnInvInput');
    var dd = document.getElementById('addTxnInvDd');

    input.addEventListener('input', function() {
        atInvDdIdx = -1;
        var q = input.value.trim().toLowerCase();
        if (q.length === 0) { dd.classList.remove('show'); return; }
        var matches = atInvestors.filter(function(inv) {
            return (inv.short_name && inv.short_name.toLowerCase().indexOf(q) !== -1) ||
                   (inv.name && inv.name.toLowerCase().indexOf(q) !== -1);
        });
        renderAddTxnDd(dd, matches, function(inv) {
            return (inv.short_name || inv.name) + '<span class="sub">' + inv.name + '</span>';
        }, function(inv) {
            selectAddTxnInvestor(inv);
        });
    });

    input.addEventListener('keydown', function(e) {
        handleAddTxnDdNav(e, dd, function(idx) { atInvDdIdx = idx; return atInvDdIdx; }, function() { return atInvDdIdx; });
    });

    input.addEventListener('focus', function() {
        if (atSelectedInvestor) return;
        if (input.value.trim().length > 0) input.dispatchEvent(new Event('input'));
    });
}

function setupAddTxnBrkSearch() {
    var input = document.getElementById('addTxnBrkInput');
    var dd = document.getElementById('addTxnBrkDd');

    input.addEventListener('input', function() {
        atBrkDdIdx = -1;
        var q = input.value.trim().toLowerCase();
        if (q.length === 0) { dd.classList.remove('show'); return; }
        var matches = atBrokers.filter(function(b) {
            return (b.name && b.name.toLowerCase().indexOf(q) !== -1) ||
                   (b.broker_code && b.broker_code.toLowerCase().indexOf(q) !== -1);
        });
        renderAddTxnDd(dd, matches, function(b) {
            return (b.broker_code || b.name) + '<span class="sub">' + b.name + '</span>';
        }, function(b) {
            selectAddTxnBroker(b);
        });
    });

    input.addEventListener('keydown', function(e) {
        handleAddTxnDdNav(e, dd, function(idx) { atBrkDdIdx = idx; return atBrkDdIdx; }, function() { return atBrkDdIdx; });
    });

    input.addEventListener('focus', function() {
        if (atSelectedBroker) return;
        if (input.value.trim().length > 0) input.dispatchEvent(new Event('input'));
    });
}

function renderAddTxnDd(dd, items, labelFn, selectFn) {
    dd.innerHTML = '';
    if (items.length === 0) {
        dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No matches</div>';
        dd.classList.add('show');
        return;
    }
    items.forEach(function(item, idx) {
        var div = document.createElement('div');
        div.className = 'addTxn-dd-item';
        div.innerHTML = labelFn(item);
        div.dataset.idx = idx;
        div.addEventListener('click', function() {
            selectFn(item);
            dd.classList.remove('show');
        });
        dd.appendChild(div);
    });
    dd.classList.add('show');
}

function handleAddTxnDdNav(e, dd, setIdx, getIdx) {
    if (!dd.classList.contains('show')) return;
    var items = dd.querySelectorAll('.addTxn-dd-item');
    if (items.length === 0) return;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        var idx = getIdx();
        idx = Math.min(idx + 1, items.length - 1);
        setIdx(idx);
        highlightDdItem(items, idx);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        var idx2 = getIdx();
        idx2 = Math.max(idx2 - 1, 0);
        setIdx(idx2);
        highlightDdItem(items, idx2);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        var ci = getIdx();
        if (ci >= 0 && ci < items.length) {
            items[ci].click();
        } else if (items.length === 1) {
            items[0].click();
        }
    }
}

function highlightDdItem(items, idx) {
    items.forEach(function(el, i) {
        el.classList.toggle('highlighted', i === idx);
        if (i === idx) el.scrollIntoView({ block: 'nearest' });
    });
}

function selectAddTxnInvestor(inv) {
    atSelectedInvestor = inv;
    var input = document.getElementById('addTxnInvInput');
    input.value = inv.short_name || inv.name;
    input.disabled = true;
    document.getElementById('addTxnInvDd').classList.remove('show');

    // Show badge with clear button
    document.getElementById('addTxnInvBadge').innerHTML =
        '<span class="addTxn-selected-badge">' + (inv.short_name || inv.name) +
        '<span class="clear" onclick="clearAddTxnInvestor()">&times;</span></span>';

    // Focus broker input
    setTimeout(function() { document.getElementById('addTxnBrkInput').focus(); }, 50);
}

function selectAddTxnBroker(brk) {
    atSelectedBroker = brk;
    var input = document.getElementById('addTxnBrkInput');
    input.value = brk.broker_code || brk.name;
    input.disabled = true;
    document.getElementById('addTxnBrkDd').classList.remove('show');

    document.getElementById('addTxnBrkBadge').innerHTML =
        '<span class="addTxn-selected-badge">' + (brk.broker_code || brk.name) +
        '<span class="clear" onclick="clearAddTxnBroker()">&times;</span></span>';

    // Focus first row symbol
    setTimeout(function() {
        var firstSym = document.querySelector('.addTxn-sym-input');
        if (firstSym) firstSym.focus();
    }, 50);
}

function clearAddTxnInvestor() {
    atSelectedInvestor = null;
    var input = document.getElementById('addTxnInvInput');
    input.value = '';
    input.disabled = false;
    document.getElementById('addTxnInvBadge').innerHTML = '';
    input.focus();
}

function clearAddTxnBroker() {
    atSelectedBroker = null;
    var input = document.getElementById('addTxnBrkInput');
    input.value = '';
    input.disabled = false;
    document.getElementById('addTxnBrkBadge').innerHTML = '';
    input.focus();
}

window.clearAddTxnInvestor = clearAddTxnInvestor;
window.clearAddTxnBroker = clearAddTxnBroker;

// ============================================================================
// Row Management
// ============================================================================

function addAddTxnRow(copyFromId) {
    var copyFrom = null;
    if (copyFromId !== undefined) {
        copyFrom = atRows.find(function(r) { return r.rowId === copyFromId; });
    }

    var rowId = atNextRowId++;
    var row = {
        rowId: rowId,
        trader_id: copyFrom ? copyFrom.trader_id : null,
        security_id: copyFrom ? copyFrom.security_id : null,
        symbol: copyFrom ? copyFrom.symbol : '',
        short_symbol: copyFrom ? copyFrom.short_symbol : '',
        company_name: copyFrom ? copyFrom.company_name : '',
        security_type: copyFrom ? copyFrom.security_type : 'EQUITY',
        asset_class: copyFrom ? copyFrom.asset_class : null,
        exchange: copyFrom ? copyFrom.exchange : 'NSE',
        lot_size: copyFrom ? copyFrom.lot_size : 1,
        lots: copyFrom ? copyFrom.lots : 0,
        quantity: copyFrom ? copyFrom.quantity : 0,
        price: copyFrom ? copyFrom.price : 0,
        gross_amount: copyFrom ? copyFrom.gross_amount : 0,
        brokerage: 0,
        stt: 0,
        other_charges: 0,
        gst: 0,
        total_charges: 0,
        trader_charges: 0,
        net_amount: 0,
        tags: copyFrom ? copyFrom.tags.slice() : [],
        _exchange_charges: 0,
        _sebi_charges: 0,
        _stamp_duty: 0,
        _ipft: 0,
        _chargesBasis: {},
        _totalOverride: false,
        _netOverride: false
    };

    atRows.push(row);

    // Build HTML
    var isNfo = row.lot_size > 1;
    var traderOptions = '<option value="">(Same)</option>';
    atInvestors.forEach(function(inv) {
        var sel = (row.trader_id && inv.id === row.trader_id) ? ' selected' : '';
        traderOptions += '<option value="' + inv.id + '"' + sel + '>' + (inv.short_name || inv.name) + '</option>';
    });

    var tr = document.createElement('tr');
    tr.dataset.rowId = rowId;
    tr.innerHTML =
        // Trader
        '<td><select class="addTxn-trader-sel" data-rid="' + rowId + '">' + traderOptions + '</select></td>' +
        // Symbol
        '<td style="position:relative;">' +
            '<input type="text" class="addTxn-sym-input" data-rid="' + rowId + '" placeholder="Search..." autocomplete="off" value="' + (row.symbol || '') + '">' +
            '<div class="addTxn-sym-dd" id="addTxnSymDd_' + rowId + '"></div>' +
        '</td>' +
        // Lots
        '<td><input type="number" class="addTxn-lots-input' + (isNfo ? '' : ' disabled-lots') + '" data-rid="' + rowId + '" step="1" value="' + (row.lots || '') + '"' + (isNfo ? '' : ' disabled') + '></td>' +
        // Qty
        '<td><input type="number" class="addTxn-qty-input" data-rid="' + rowId + '" step="1" value="' + (row.quantity || '') + '"></td>' +
        // Price
        '<td><input type="number" class="addTxn-price-input" data-rid="' + rowId + '" step="0.01" value="' + (row.price || '') + '"></td>' +
        // Gross (read-only)
        '<td class="r addTxn-ro addTxn-gross" data-rid="' + rowId + '">' + atFmtAmt(row.gross_amount) + '</td>' +
        // Total charges (dblclick)
        '<td class="r addTxn-ro addTxn-charges-cell addTxn-totchg" data-rid="' + rowId + '" title="Double-click for breakdown">' + atFmtAmt(row.total_charges) + '</td>' +
        // Trader charges
        '<td class="r addTxn-ro addTxn-trdchg" data-rid="' + rowId + '">' + atFmtAmt(row.trader_charges) + '</td>' +
        // Net amount
        '<td class="r addTxn-ro addTxn-net" data-rid="' + rowId + '">' + atFmtAmt(row.net_amount) + '</td>' +
        // Tags
        '<td style="position:relative;">' +
            '<input type="text" class="addTxn-tags-input" data-rid="' + rowId + '" placeholder="Tags..." autocomplete="off">' +
            '<div class="addTxn-tag-pills" id="addTxnTagPills_' + rowId + '"></div>' +
            '<div class="addTxn-tag-dd" id="addTxnTagDd_' + rowId + '"></div>' +
        '</td>' +
        // Delete
        '<td><button class="addTxn-del-btn" data-rid="' + rowId + '" title="Remove row">&#x1F5D1;</button></td>';

    document.getElementById('addTxnTbody').appendChild(tr);

    // Attach handlers
    attachAddTxnRowHandlers(rowId);

    // Recalc charges if copying (has security + qty + price)
    if (copyFrom && row.security_id && row.quantity && row.price) {
        recalcAddTxnRow(rowId);
    }

    // Render tag pills if copying
    if (row.tags.length > 0) {
        renderAddTxnTagPills(rowId);
    }

    return rowId;
}

function removeAddTxnRow(rowId) {
    if (atRows.length <= 1) return; // Keep at least one row
    atRows = atRows.filter(function(r) { return r.rowId !== rowId; });
    var tr = document.querySelector('#addTxnTbody tr[data-row-id="' + rowId + '"]');
    if (tr) tr.remove();
}

// ============================================================================
// Row Event Handlers
// ============================================================================

function attachAddTxnRowHandlers(rowId) {
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;

    var traderSel = document.querySelector('.addTxn-trader-sel[data-rid="' + rowId + '"]');
    var symInput = document.querySelector('.addTxn-sym-input[data-rid="' + rowId + '"]');
    var lotsInput = document.querySelector('.addTxn-lots-input[data-rid="' + rowId + '"]');
    var qtyInput = document.querySelector('.addTxn-qty-input[data-rid="' + rowId + '"]');
    var priceInput = document.querySelector('.addTxn-price-input[data-rid="' + rowId + '"]');
    var tagsInput = document.querySelector('.addTxn-tags-input[data-rid="' + rowId + '"]');
    var delBtn = document.querySelector('.addTxn-del-btn[data-rid="' + rowId + '"]');
    var totchgCell = document.querySelector('.addTxn-totchg[data-rid="' + rowId + '"]');

    // --- Trader change ---
    traderSel.addEventListener('change', function() {
        row.trader_id = traderSel.value || null;
        recalcAddTxnRow(rowId);
    });

    // --- Symbol search ---
    var symSearchTimer = null;
    symInput.addEventListener('input', function() {
        clearTimeout(symSearchTimer);
        var q = symInput.value.trim();
        if (q.length < 2) {
            document.getElementById('addTxnSymDd_' + rowId).classList.remove('show');
            return;
        }
        symSearchTimer = setTimeout(function() { searchAddTxnSymbol(rowId, q); }, 300);
    });
    symInput.addEventListener('keydown', function(e) {
        var dd = document.getElementById('addTxnSymDd_' + rowId);
        if (dd.classList.contains('show')) {
            var items = dd.querySelectorAll('.addTxn-dd-item');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                var curIdx = (atSymDdIdx[rowId] !== undefined && atSymDdIdx[rowId] !== null) ? atSymDdIdx[rowId] : -1;
                atSymDdIdx[rowId] = Math.min(curIdx + 1, items.length - 1);
                highlightDdItem(items, atSymDdIdx[rowId]);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                var curIdx2 = (atSymDdIdx[rowId] !== undefined && atSymDdIdx[rowId] !== null) ? atSymDdIdx[rowId] : 0;
                atSymDdIdx[rowId] = Math.max(curIdx2 - 1, 0);
                highlightDdItem(items, atSymDdIdx[rowId]);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                var ci = atSymDdIdx[rowId];
                if (ci >= 0 && ci < items.length) { items[ci].click(); }
                else if (items.length === 1) { items[0].click(); }
            } else if (e.key === 'Escape') {
                dd.classList.remove('show');
            }
        }
    });
    symInput.addEventListener('blur', function() {
        setTimeout(function() { document.getElementById('addTxnSymDd_' + rowId).classList.remove('show'); }, 200);
    });

    // --- Lots change ---
    lotsInput.addEventListener('input', function() {
        var lots = parseFloat(lotsInput.value) || 0;
        row.lots = lots;
        if (row.lot_size > 1) {
            row.quantity = Math.round(lots * row.lot_size);
            qtyInput.value = row.quantity || '';
        }
        recalcAddTxnRow(rowId);
    });

    // --- Qty change ---
    qtyInput.addEventListener('input', function() {
        var qty = parseInt(qtyInput.value) || 0;
        row.quantity = qty;
        if (row.lot_size > 1 && qty !== 0) {
            row.lots = Math.round(Math.abs(qty) / row.lot_size * 100) / 100;
            if (qty < 0) row.lots = -Math.abs(row.lots);
            lotsInput.value = row.lots || '';
        }
        recalcAddTxnRow(rowId);
    });

    // --- Price change ---
    priceInput.addEventListener('input', function() {
        row.price = parseFloat(priceInput.value) || 0;
        recalcAddTxnRow(rowId);
    });

    // --- Total charges dblclick → popover ---
    totchgCell.addEventListener('dblclick', function() {
        openAddTxnCp(rowId);
    });

    // --- Tags autocomplete ---
    setupAddTxnTagInput(rowId);

    // --- Delete row ---
    delBtn.addEventListener('click', function() { removeAddTxnRow(rowId); });

    // --- Keyboard: Tab navigation ---
    var tabbable = [traderSel, symInput, lotsInput, qtyInput, priceInput, tagsInput];
    tabbable.forEach(function(field, idx) {
        field.addEventListener('keydown', function(e) {
            if (e.key === 'Tab' && !e.shiftKey) {
                // If on tags field (last), add new row
                if (field === tagsInput) {
                    e.preventDefault();
                    // Add tag text if any typed
                    var typed = tagsInput.value.trim();
                    if (typed.length > 0) addAddTxnTagFromText(rowId, typed);
                    var newId = addAddTxnRow(rowId);
                    setTimeout(function() {
                        var newTrader = document.querySelector('.addTxn-trader-sel[data-rid="' + newId + '"]');
                        if (newTrader) newTrader.focus();
                    }, 50);
                }
            }
            // Enter on trader or tags → submit
            if (e.key === 'Enter') {
                if (field === traderSel) {
                    e.preventDefault();
                    openAddTxnConfirmation();
                } else if (field === tagsInput) {
                    // Only submit if no tag text to add, and dropdown is not showing
                    var tagDd = document.getElementById('addTxnTagDd_' + rowId);
                    var typed2 = tagsInput.value.trim();
                    if (typed2.length > 0) {
                        e.preventDefault();
                        addAddTxnTagFromText(rowId, typed2);
                    } else if (!tagDd.classList.contains('show')) {
                        e.preventDefault();
                        openAddTxnConfirmation();
                    }
                }
            }
        });
    });
}

// ============================================================================
// Symbol Search
// NOTE: The search process below mirrors trading-watchlist.js trWlSearchSecurities.
// This is the standard process for symbol search across the app:
//   1. Check if query is an options query (contains CE/PE + underlying + strike)
//   2. If options: build Fyers symbol candidates across expiry dates, validate via
//      Fyers quotes API, display valid contracts
//   3. If not options: parallel search securities_db (CM) + securities_nfo (NFO/F&O)
//      via Supabase ilike on symbol/name fields, display combined results
// Any new symbol search in the app should follow this same process.
// ============================================================================

// --- Options Query Parser (ported from trading-watchlist.js trWlParseOptionsQuery) ---
function atParseOptionsQuery(query) {
    if (!query) return null;
    var upper = query.toUpperCase().trim();
    if (upper.indexOf('CE') < 0 && upper.indexOf('PE') < 0) return null;
    var parts = upper.replace(/\s+/g, ' ').split(' ');
    var underlying = null;
    var strike = null;
    var optionType = null;
    var expiryHint = null;
    for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (p === 'CE' || p === 'PE') { optionType = p; continue; }
        var suffixMatch = p.match(/^(\d+(?:\.\d+)?)(CE|PE)$/);
        if (suffixMatch) { strike = parseFloat(suffixMatch[1]); optionType = suffixMatch[2]; continue; }
        if (/^\d+(?:\.\d+)?$/.test(p)) { strike = parseFloat(p); continue; }
        if (AT_MONTHS_SHORT.indexOf(p) >= 0) { expiryHint = p; continue; }
        if (!underlying && /^[A-Z&]+$/.test(p)) { underlying = p; }
    }
    if (!underlying || strike === null || !optionType) return null;
    return { underlying: underlying, strike: strike, optionType: optionType, expiryHint: expiryHint };
}

// --- Fyers option symbol candidate builder (ported from trWlBuildOptionsCandidates) ---
function atNextThursday(from) {
    var d = new Date(from);
    var day = d.getDay();
    var diff = (4 - day + 7) % 7;
    if (diff === 0 && d.getHours() >= 15) diff = 7;
    d.setDate(d.getDate() + diff);
    return d;
}
function atGetWeeklyExpiries(year, month) {
    var thursdays = [];
    var d = new Date(year, month, 1);
    while (d.getMonth() === month) {
        if (d.getDay() === 4) thursdays.push(new Date(d));
        d.setDate(d.getDate() + 1);
    }
    return thursdays;
}
function atGetMonthlyExpiry(year, month) {
    var d = new Date(year, month + 1, 0);
    while (d.getDay() !== 4) d.setDate(d.getDate() - 1);
    return d;
}
function atBuildOptionsCandidates(underlying, strike, optionType, expiryHint) {
    var now = new Date();
    var candidates = [];
    var exchange = 'NSE';
    var mcxUnderlyings = ['CRUDEOIL', 'NATURALGAS', 'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'COPPER'];
    if (mcxUnderlyings.indexOf(underlying) >= 0) exchange = 'MCX';
    var strikeStr = strike % 1 === 0 ? String(Math.round(strike)) : String(strike);
    var isWeekly = AT_WEEKLY_EXPIRY_UNDERLYINGS.indexOf(underlying) >= 0;
    if (expiryHint) {
        var monthIdx = AT_MONTHS_SHORT.indexOf(expiryHint);
        var year = now.getFullYear();
        if (monthIdx < now.getMonth()) year++;
        var yy = String(year).slice(2);
        candidates.push(exchange + ':' + underlying + yy + expiryHint + strikeStr + optionType);
        if (isWeekly) {
            var weeklyDates = atGetWeeklyExpiries(year, monthIdx);
            var monthlyLast = atGetMonthlyExpiry(year, monthIdx);
            weeklyDates.forEach(function(d) {
                if (d.getDate() === monthlyLast.getDate() && d.getMonth() === monthlyLast.getMonth()) return;
                var mm = String(d.getMonth() + 1).padStart(2, '0');
                var dd2 = String(d.getDate()).padStart(2, '0');
                candidates.push(exchange + ':' + underlying + yy + mm + dd2 + strikeStr + optionType);
            });
        }
    } else {
        if (isWeekly) {
            var seenDates = {};
            for (var w = 0; w < 6; w++) {
                var targetDate = new Date(now);
                targetDate.setDate(targetDate.getDate() + (w * 7));
                var thu = atNextThursday(targetDate);
                var dateKey = thu.toISOString().slice(0, 10);
                if (seenDates[dateKey]) continue;
                seenDates[dateKey] = true;
                var yr = thu.getFullYear();
                var yy2 = String(yr).slice(2);
                var monthlyExp = atGetMonthlyExpiry(yr, thu.getMonth());
                if (thu.getDate() === monthlyExp.getDate() && thu.getMonth() === monthlyExp.getMonth()) {
                    candidates.push(exchange + ':' + underlying + yy2 + AT_MONTHS_SHORT[thu.getMonth()] + strikeStr + optionType);
                } else {
                    var mm2 = String(thu.getMonth() + 1).padStart(2, '0');
                    var dd3 = String(thu.getDate()).padStart(2, '0');
                    candidates.push(exchange + ':' + underlying + yy2 + mm2 + dd3 + strikeStr + optionType);
                }
            }
        } else {
            for (var m = 0; m < 3; m++) {
                var d2 = new Date(now.getFullYear(), now.getMonth() + m, 1);
                var yy3 = String(d2.getFullYear()).slice(2);
                candidates.push(exchange + ':' + underlying + yy3 + AT_MONTHS_SHORT[d2.getMonth()] + strikeStr + optionType);
            }
        }
    }
    return candidates;
}

// --- Format options Fyers symbol for display ---
function atFormatOptionsDisplay(fyersSymbol, underlying, strike, optionType) {
    var afterExchange = fyersSymbol.split(':')[1] || fyersSymbol;
    var rest = afterExchange.substring(underlying.length);
    var strikeInt = String(Math.round(strike));
    var expiryPart = rest;
    var suffixInt = strikeInt + optionType;
    var suffixOrig = String(strike) + optionType;
    if (expiryPart.endsWith(suffixInt)) {
        expiryPart = expiryPart.substring(0, expiryPart.length - suffixInt.length);
    } else if (expiryPart.endsWith(suffixOrig)) {
        expiryPart = expiryPart.substring(0, expiryPart.length - suffixOrig.length);
    }
    var actualStrike = strike;
    var afterExpiry = rest.substring(expiryPart.length);
    var strikeFromSymbol = afterExpiry.replace(optionType, '');
    if (strikeFromSymbol && !isNaN(Number(strikeFromSymbol))) actualStrike = Number(strikeFromSymbol);
    var expiryLabel = expiryPart;
    if (expiryPart.length === 5) {
        expiryLabel = expiryPart;
    } else if (expiryPart.length === 6) {
        var yyW = expiryPart.substring(0, 2);
        var mmW = parseInt(expiryPart.substring(2, 4)) - 1;
        var ddW = expiryPart.substring(4, 6);
        if (mmW >= 0 && mmW < 12) expiryLabel = ddW + AT_MONTHS_SHORT[mmW] + yyW;
    }
    return underlying + ' ' + actualStrike + ' ' + optionType + ' ' + expiryLabel;
}

// --- Options search via Fyers API (ported from trWlSearchOptions) ---
async function atSearchOptions(rowId, parsed, dd) {
    if (!window.fyersToken) {
        dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">Fyers not connected — cannot search options.<br>Options search requires an active Fyers connection.</div>';
        dd.classList.add('show');
        return;
    }
    dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">Searching options...</div>';
    dd.classList.add('show');
    var candidates = atBuildOptionsCandidates(parsed.underlying, parsed.strike, parsed.optionType, parsed.expiryHint);
    if (candidates.length === 0) {
        dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">Could not build option symbols</div>';
        return;
    }
    console.log('AddTxn: Options search candidates:', candidates);
    try {
        var data = await window.fyersCall({ action: 'quotes', symbols: candidates });
        var validResults = [];
        if (data && data.d && data.d.length > 0) {
            data.d.forEach(function(item) {
                if (item.v && item.v.lp > 0) {
                    validResults.push({ symbol: item.v.symbol, lp: item.v.lp, ch: item.v.ch || 0, chp: item.v.chp || 0 });
                }
            });
        }
        if (validResults.length === 0) {
            dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No active options found for "' +
                parsed.underlying + ' ' + parsed.strike + ' ' + parsed.optionType + '"<br>Try a different strike price or expiry month.</div>';
            return;
        }
        dd.innerHTML = '';
        validResults.forEach(function(r, idx) {
            var displayLabel = atFormatOptionsDisplay(r.symbol, parsed.underlying, parsed.strike, parsed.optionType);
            var isOpt = true;
            var div = document.createElement('div');
            div.className = 'addTxn-dd-item nfo';
            div.dataset.idx = idx;
            div.innerHTML = displayLabel +
                ' <span class="sub">₹' + r.lp.toFixed(2) + '</span>' +
                ' <span class="sub" style="color:' + (r.chp >= 0 ? '#059669' : '#dc2626') + ';">' +
                (r.chp >= 0 ? '+' : '') + r.chp.toFixed(2) + '%</span>';
            div.addEventListener('click', function() {
                // Determine lot size from underlying — search securities_nfo for this specific symbol
                atSelectOptionsContract(rowId, r.symbol, parsed, displayLabel);
                dd.classList.remove('show');
            });
            dd.appendChild(div);
        });
        dd.classList.add('show');
    } catch (err) {
        dd.innerHTML = '<div style="padding:8px;color:#dc2626;font-size:11px;">Options search failed: ' + err.message + '</div>';
    }
}

// --- Select an options contract from Fyers search results ---
async function atSelectOptionsContract(rowId, fyersSymbol, parsed, displayLabel) {
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;
    // Try to find this in securities_nfo first (may have been added via watchlist)
    var headers = { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY };
    var nfoCheck = SUPABASE_URL + '/rest/v1/securities_nfo?symbol=eq.' + encodeURIComponent(fyersSymbol.split(':')[1] || fyersSymbol) +
        '&select=id,symbol,underlying_symbol,instrument_name,exchange,instrument_type,lot_size,broker_tokens,expiry_date&limit=1';
    var nfoResp = await fetch(nfoCheck, { headers: headers }).then(function(r) { return r.ok ? r.json() : []; }).catch(function() { return []; });
    var lotSize = 1;
    var secId = fyersSymbol; // default: use Fyers symbol as ID
    if (nfoResp.length > 0) {
        var nfo = nfoResp[0];
        lotSize = nfo.lot_size || 1;
        secId = nfo.id;
    } else {
        // Estimate lot size from underlying's NFO records
        var lotCheck = SUPABASE_URL + '/rest/v1/securities_nfo?underlying_symbol=eq.' + encodeURIComponent(parsed.underlying) +
            '&select=lot_size&limit=1';
        var lotResp = await fetch(lotCheck, { headers: headers }).then(function(r) { return r.ok ? r.json() : []; }).catch(function() { return []; });
        if (lotResp.length > 0) lotSize = lotResp[0].lot_size || 1;
    }
    selectAddTxnSecurity(rowId, {
        security_id: secId,
        symbol: fyersSymbol.split(':')[1] || fyersSymbol,
        short_symbol: displayLabel,
        company_name: parsed.underlying + ' Option',
        security_type: 'NFO',
        asset_class: 'OPTIONS',
        exchange: fyersSymbol.split(':')[0] || 'NSE',
        lot_size: lotSize,
        broker_tokens: {}
    });
}

async function searchAddTxnSymbol(rowId, query) {
    var dd = document.getElementById('addTxnSymDd_' + rowId);
    atSymDdIdx[rowId] = -1;

    // Check if this is an options query (contains CE/PE + strike) — same logic as watchlist
    var optionsParsed = atParseOptionsQuery(query);
    if (optionsParsed) {
        await atSearchOptions(rowId, optionsParsed, dd);
        return;
    }

    var headers = { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY };
    var searchQ = encodeURIComponent('%' + query + '%');

    try {
        var dbUrl = SUPABASE_URL + '/rest/v1/securities_db?or=(symbol.ilike.' + searchQ +
            ',nse_symbol.ilike.' + searchQ +
            ',bse_symbol.ilike.' + searchQ +
            ',company_name.ilike.' + searchQ +
            ')&is_active=eq.true&limit=20&select=id,symbol,nse_symbol,bse_symbol,company_name,security_type,asset_class,lot_size,broker_tokens&order=symbol';

        var nfoUrl = SUPABASE_URL + '/rest/v1/securities_nfo?or=(symbol.ilike.' + searchQ +
            ',underlying_symbol.ilike.' + searchQ +
            ',instrument_name.ilike.' + searchQ +
            ')&is_active=eq.true&limit=10&select=id,symbol,underlying_symbol,instrument_name,exchange,instrument_type,lot_size,broker_tokens,expiry_date&order=symbol';

        var results = await Promise.all([
            fetch(dbUrl, { headers: headers }).then(function(r) { return r.ok ? r.json() : []; }),
            fetch(nfoUrl, { headers: headers }).then(function(r) { return r.ok ? r.json() : []; })
        ]);

        var dbResults = results[0];
        var nfoResults = results[1];

        dd.innerHTML = '';
        if (dbResults.length === 0 && nfoResults.length === 0) {
            dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No matches</div>';
            dd.classList.add('show');
            return;
        }

        // CM results
        dbResults.forEach(function(sec, idx) {
            var displaySym = sec.nse_symbol || sec.bse_symbol || sec.symbol;
            var div = document.createElement('div');
            div.className = 'addTxn-dd-item';
            div.dataset.idx = idx;
            div.innerHTML = displaySym + '<span class="sub">' + (sec.company_name || '') + '</span>';
            div.addEventListener('click', function() {
                selectAddTxnSecurity(rowId, {
                    security_id: sec.id,
                    symbol: sec.nse_symbol || sec.bse_symbol || sec.symbol,
                    short_symbol: sec.nse_symbol || sec.bse_symbol || sec.symbol,
                    company_name: sec.company_name || sec.symbol,
                    security_type: sec.security_type || 'EQUITY',
                    asset_class: sec.asset_class || null,
                    exchange: sec.nse_symbol ? 'NSE' : 'BSE',
                    lot_size: sec.lot_size || 1,
                    broker_tokens: sec.broker_tokens
                });
                dd.classList.remove('show');
            });
            dd.appendChild(div);
        });

        // NFO results
        nfoResults.forEach(function(sec, idx) {
            var div = document.createElement('div');
            div.className = 'addTxn-dd-item nfo';
            div.dataset.idx = dbResults.length + idx;
            var label = sec.symbol;
            if (sec.expiry_date) label += ' <span class="sub">exp ' + sec.expiry_date + '</span>';
            div.innerHTML = label;
            div.addEventListener('click', function() {
                // Determine if options
                var isOpt = sec.symbol && (sec.symbol.match(/(CE|PE)$/) !== null);
                selectAddTxnSecurity(rowId, {
                    security_id: sec.id,
                    symbol: sec.symbol,
                    short_symbol: sec.underlying_symbol || sec.symbol,
                    company_name: sec.instrument_name || sec.symbol,
                    security_type: 'NFO',
                    asset_class: isOpt ? 'OPTIONS' : 'FUTURES',
                    exchange: sec.exchange || 'NSE',
                    lot_size: sec.lot_size || 1,
                    broker_tokens: sec.broker_tokens
                });
                dd.classList.remove('show');
            });
            dd.appendChild(div);
        });

        dd.classList.add('show');
    } catch (e) {
        console.error('Symbol search error:', e);
    }
}

function selectAddTxnSecurity(rowId, sec) {
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;

    row.security_id = sec.security_id;
    row.symbol = sec.symbol;
    row.short_symbol = sec.short_symbol;
    row.company_name = sec.company_name;
    row.security_type = sec.security_type;
    row.asset_class = sec.asset_class;
    row.exchange = sec.exchange;
    row.lot_size = sec.lot_size || 1;

    // Update symbol input display
    var symInput = document.querySelector('.addTxn-sym-input[data-rid="' + rowId + '"]');
    symInput.value = sec.symbol;

    // Enable/disable lots field
    var lotsInput = document.querySelector('.addTxn-lots-input[data-rid="' + rowId + '"]');
    if (sec.lot_size > 1) {
        lotsInput.disabled = false;
        lotsInput.classList.remove('disabled-lots');
    } else {
        lotsInput.disabled = true;
        lotsInput.classList.add('disabled-lots');
        lotsInput.value = '';
        row.lots = 0;
    }

    // Reset charges for fresh calc
    row.brokerage = 0;
    row.stt = 0;
    row.other_charges = 0;
    row.gst = 0;
    row._exchange_charges = 0;
    row._sebi_charges = 0;
    row._stamp_duty = 0;
    row._ipft = 0;
    row.total_charges = 0;
    row.trader_charges = 0;
    row._totalOverride = false;

    recalcAddTxnRow(rowId);

    // Focus lots (if NFO) or qty
    setTimeout(function() {
        if (sec.lot_size > 1) lotsInput.focus();
        else document.querySelector('.addTxn-qty-input[data-rid="' + rowId + '"]').focus();
    }, 50);
}

// ============================================================================
// Recalculation
// ============================================================================

function recalcAddTxnRow(rowId) {
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;

    // Gross = |qty| × price
    row.gross_amount = atRound(Math.abs(row.quantity) * (row.price || 0));

    // Derive transaction_type from qty sign
    row.transaction_type = row.quantity >= 0 ? 'BUY' : 'SELL';

    // Auto-calc charges (reset sub-fields for fresh calc)
    row.brokerage = 0;
    row.stt = 0;
    row.other_charges = 0;
    row.gst = 0;
    row._exchange_charges = 0;
    row._sebi_charges = 0;
    row._stamp_duty = 0;
    row._ipft = 0;
    if (!row._totalOverride) row.total_charges = 0;
    row.trader_charges = 0;

    atAutoCalcCharges(row);

    // Update DOM
    updateAddTxnRowDisplay(rowId);
}

function updateAddTxnRowDisplay(rowId) {
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;

    var grossEl = document.querySelector('.addTxn-gross[data-rid="' + rowId + '"]');
    var totchgEl = document.querySelector('.addTxn-totchg[data-rid="' + rowId + '"]');
    var trdchgEl = document.querySelector('.addTxn-trdchg[data-rid="' + rowId + '"]');
    var netEl = document.querySelector('.addTxn-net[data-rid="' + rowId + '"]');

    if (grossEl) grossEl.textContent = atFmtAmt(row.gross_amount);
    if (totchgEl) totchgEl.textContent = atFmtAmt(row.total_charges);
    if (trdchgEl) trdchgEl.textContent = atFmtAmt(row.trader_charges);
    if (netEl) {
        netEl.textContent = atFmtAmt(row.net_amount);
        // Color the net amount based on buy/sell
        netEl.style.color = row.quantity < 0 ? '#dc2626' : '';
    }

    // Total charges override indicator
    if (totchgEl && row._totalOverride) {
        totchgEl.style.color = '#d69e2e';
        totchgEl.title = 'User override';
    } else if (totchgEl) {
        totchgEl.style.color = '';
        totchgEl.title = 'Double-click for breakdown';
    }
}

// ============================================================================
// Charge Calculation (ported from transaction-import.js autoCalcCharges)
// ============================================================================

function atRound(v) { return Math.round((v || 0) * 100) / 100; }

function atGetBrokerage(investorId, brokerId, gross, secType, assetClass, price, quantity, lots) {
    if (!brokerId) return 0;
    var ibaEntry = atIbaRatesMap[investorId + '|' + brokerId];
    if (!ibaEntry) return 0;
    var rates = ibaEntry.rates;

    var segment = null;
    if (secType === 'NFO') {
        if (assetClass === 'OPTIONS' && rates.derivatives && rates.derivatives.options) {
            segment = rates.derivatives.options;
        } else {
            segment = rates.derivatives ? rates.derivatives.futures : null;
        }
    } else {
        segment = rates.equity ? rates.equity.delivery : null;
    }
    if (!segment) return 0;

    // Flat rate (options) — flat × |lots|
    if (segment.flat !== undefined) {
        var absLots = Math.abs(lots || 0) || 1;
        var flatCalc = segment.flat * absLots;
        var flatMax = segment.max || 0;
        if (flatMax > 0 && flatCalc > flatMax) flatCalc = flatMax;
        return atRound(flatCalc);
    }

    var pct = segment.pct || 0;
    var max = segment.max || 0;
    var calc;
    if (ibaEntry.charges_inclusive && price && quantity) {
        var perShare = Math.ceil(price * pct * 100) / 100;
        calc = perShare * Math.abs(quantity);
    } else {
        calc = atRound(gross * pct);
    }
    if (max > 0 && calc > max) calc = max;
    return atRound(calc);
}

function atIsChargesInclusive(investorId, brokerId) {
    var ibaEntry = atIbaRatesMap[investorId + '|' + brokerId];
    return ibaEntry ? ibaEntry.charges_inclusive : false;
}

function atGetRegRate(chargeType, txnCat, txnType, exchange) {
    for (var i = 0; i < atRegCharges.length; i++) {
        var rc = atRegCharges[i];
        if (rc.charge_type === chargeType &&
            rc.transaction_category === txnCat &&
            rc.transaction_type === txnType &&
            rc.exchange === (exchange || 'NSE')) {
            return rc.rate_percentage || 0;
        }
    }
    return 0;
}

function atAutoCalcCharges(row) {
    var investorId = atSelectedInvestor ? atSelectedInvestor.id : null;
    var brokerId = atSelectedBroker ? atSelectedBroker.id : null;
    var gross = row.gross_amount || 0;

    if (!investorId || !brokerId || gross === 0) {
        row.net_amount = gross;
        return;
    }

    // Determine transaction category
    var txnCat = 'EQUITY_DELIVERY';
    if (row.security_type === 'NFO') {
        var symUp = (row.symbol || '').toUpperCase();
        if (symUp.match(/(CE|PE)$/) || (row.asset_class && row.asset_class === 'OPTIONS')) {
            txnCat = 'EQUITY_OPTIONS';
        } else {
            txnCat = 'EQUITY_FUTURES';
        }
    }
    var exchange = (row.exchange === 'NFO' || !row.exchange) ? 'NSE' : row.exchange;
    var txnType = row.transaction_type || 'BUY';

    var inclusive = atIsChargesInclusive(investorId, brokerId);

    // Debug: log charge calc inputs
    console.log('AddTxn charges calc:', {
        symbol: row.symbol, gross: gross, txnCat: txnCat, exchange: exchange,
        txnType: txnType, inclusive: inclusive, secType: row.security_type,
        assetClass: row.asset_class, price: row.price, qty: row.quantity, lots: row.lots
    });

    // 1. Brokerage (rule F.2.6) — pct is stored as decimal (0.005 = 0.5%). Do NOT divide by 100.
    // charges_inclusive: ROUNDUP(price × pct, 2) × |qty|. Otherwise: round(gross × pct, 2).
    row.brokerage = atGetBrokerage(investorId, brokerId, gross, row.security_type, row.asset_class, row.price, row.quantity, row.lots);

    if (inclusive) {
        // charges_inclusive: brokerage IS all-inclusive (covers STT, exchange, GST, everything)
        row.stt = 0;
        row.other_charges = 0;
        row.gst = 0;
        if (!row._totalOverride) {
            row.total_charges = row.brokerage;
        }
        console.log('AddTxn charges (inclusive):', { brokerage: row.brokerage, total: row.total_charges });
    } else {
        // 2. STT (rule F.2.3)
        // Equity delivery: rounded UP to nearest whole number
        // F&O: rounded to 2 decimal places (not rounded up)
        var sttRate = atGetRegRate('STT', txnCat, txnType, exchange);
        if (sttRate > 0) {
            var sttRaw = gross * (sttRate / 100);
            if (txnCat === 'EQUITY_DELIVERY') {
                row.stt = Math.ceil(sttRaw);
            } else {
                row.stt = atRound(sttRaw);
            }
        }

        // 3. Individual regulatory charges (exchange, SEBI, stamp duty, IPFT)
        var exchRate = atGetRegRate('EXCHANGE_CHARGES', txnCat, txnType, exchange);
        var sebiRate = atGetRegRate('SEBI_CHARGES', txnCat, txnType, exchange);
        var stampRate = atGetRegRate('STAMP_DUTY', txnCat, txnType, exchange);
        var ipftRate = atGetRegRate('IPFT', txnCat, txnType, exchange);

        row._exchange_charges = atRound(gross * (exchRate / 100));
        row._sebi_charges = atRound(gross * (sebiRate / 100));
        row._stamp_duty = atRound(gross * (stampRate / 100));
        row._ipft = atRound(gross * (ipftRate / 100));
        row.other_charges = atRound(row._exchange_charges + row._sebi_charges + row._stamp_duty + (row._ipft || 0));

        // 4. GST — 18% on (brokerage + exchange charges + SEBI charges)
        row.gst = atRound((row.brokerage + row._exchange_charges + row._sebi_charges) * 0.18);

        // 5. Total charges = brokerage + stt + other_charges + gst (rule F.2.4)
        if (!row._totalOverride) {
            row.total_charges = atRound(row.brokerage + row.stt + row.other_charges + row.gst);
        }

        console.log('AddTxn charges (non-inclusive):', {
            brokerage: row.brokerage, stt: row.stt, sttRate: sttRate,
            exchRate: exchRate, exch: row._exchange_charges,
            sebiRate: sebiRate, sebi: row._sebi_charges,
            stampRate: stampRate, stamp: row._stamp_duty,
            ipftRate: ipftRate, ipft: row._ipft,
            other: row.other_charges, gst: row.gst, total: row.total_charges
        });
    }

    // 6. Net amount: BUY = gross + charges, SELL = gross - charges (rule F.2.2)
    if (!row._netOverride) {
        if (txnType === 'BUY') {
            row.net_amount = atRound(gross + row.total_charges);
        } else {
            row.net_amount = atRound(gross - row.total_charges);
        }
    }

    // 7. Trader charges (rule F.2.5)
    // When investor = trader, trader_charges = 0
    var traderId = row.trader_id || investorId;
    if (traderId !== investorId) {
        row.trader_charges = atGetBrokerage(traderId, brokerId, gross, row.security_type, row.asset_class, row.price, row.quantity, row.lots);
    } else {
        row.trader_charges = 0;
    }

    // 8. Basis info for popover display
    row._chargesBasis = {};
    var ibaEntry = atIbaRatesMap[investorId + '|' + brokerId];
    if (ibaEntry) {
        var rates = ibaEntry.rates || {};
        var segment = null;
        if (row.security_type === 'NFO') {
            if (row.asset_class === 'OPTIONS' && rates.derivatives && rates.derivatives.options) segment = rates.derivatives.options;
            else segment = rates.derivatives ? rates.derivatives.futures : null;
        } else {
            segment = rates.equity ? rates.equity.delivery : null;
        }
        if (segment) {
            if (segment.flat !== undefined) {
                var bStr = 'Flat ₹' + segment.flat + '/lot × ' + Math.abs(row.lots || 1) + ' lots';
                if (segment.max > 0) bStr += ' (max ₹' + segment.max + ')';
                row._chargesBasis.brokerage = bStr;
            } else {
                var pctD = ((segment.pct || 0) * 100).toFixed(4) + '%';
                row._chargesBasis.brokerage = pctD + ' of gross';
                if (inclusive) row._chargesBasis.brokerage = pctD + ' of price (per-share ROUNDUP) [inclusive]';
                if (segment.max > 0) row._chargesBasis.brokerage += ' (max ₹' + segment.max + ')';
            }
        }
        console.log('AddTxn IBA rates:', { key: investorId + '|' + brokerId, rates: JSON.stringify(rates), inclusive: inclusive, segment: segment });
    } else {
        console.warn('AddTxn: No IBA entry found for', investorId + '|' + brokerId);
    }
    if (!inclusive) {
        var sttRoundLabel = (txnCat === 'EQUITY_DELIVERY') ? ' (rounded up)' : '';
        row._chargesBasis.stt = (sttRate > 0) ? sttRate + '% of gross' + sttRoundLabel : 'N/A';
        row._chargesBasis._exchange_charges = (exchRate > 0) ? exchRate + '% of gross' : 'N/A';
        row._chargesBasis._sebi_charges = (sebiRate > 0) ? sebiRate + '% of gross' : 'N/A';
        row._chargesBasis._stamp_duty = (stampRate > 0) ? stampRate + '% of gross' : 'N/A';
        row._chargesBasis._ipft = (ipftRate > 0) ? ipftRate + '% of gross (IPFT)' : 'N/A';
        row._chargesBasis.gst = '18% on (brokerage + exchange + SEBI)';
    } else {
        ['stt', '_exchange_charges', '_sebi_charges', '_stamp_duty', '_ipft', 'gst'].forEach(function(k) {
            row._chargesBasis[k] = 'Included in brokerage';
        });
    }
}

// ============================================================================
// Charges Breakdown Popover
// ============================================================================

function openAddTxnCp(rowId) {
    atCpRowId = rowId;
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;

    document.getElementById('addTxnCpTitle').textContent = 'Charges — ' + (row.symbol || 'Row');

    var basis = row._chargesBasis || {};
    var fields = [
        { key: 'brokerage', label: 'Brokerage', basis: basis.brokerage || '' },
        { key: 'stt', label: 'STT', basis: basis.stt || '' },
        { key: '_exchange_charges', label: 'Exchange Charges', basis: basis._exchange_charges || '' },
        { key: '_sebi_charges', label: 'SEBI Charges', basis: basis._sebi_charges || '' },
        { key: '_stamp_duty', label: 'Stamp Duty', basis: basis._stamp_duty || '' },
        { key: '_ipft', label: 'NSE IPFT', basis: basis._ipft || '' },
        { key: 'gst', label: 'GST', basis: basis.gst || '' }
    ];

    var bodyHtml = '';
    fields.forEach(function(f) {
        var val = row[f.key] || 0;
        var basisHtml = f.basis ? '<span class="addTxn-cp-basis">' + f.basis + '</span>' : '';
        bodyHtml += '<div class="addTxn-cp-row">' +
            '<span class="addTxn-cp-label">' + f.label + basisHtml + '</span>' +
            '<span class="addTxn-cp-value" data-field="' + f.key + '" title="Double-click to edit">' + atFmtAmt(val) + '</span>' +
            '</div>';
    });
    document.getElementById('addTxnCpBody').innerHTML = bodyHtml;

    // Total
    updateAddTxnCpTotal(row);

    // Attach dblclick to values
    document.querySelectorAll('#addTxnCpBody .addTxn-cp-value').forEach(function(el) {
        el.addEventListener('dblclick', function() { startAddTxnCpEdit(el); });
    });

    // Total dblclick
    var totalEl = document.getElementById('addTxnCpTotal');
    totalEl.ondblclick = function() { startAddTxnCpTotalEdit(totalEl); };

    document.getElementById('addTxnCpOverlay').classList.add('show');
}

function closeAddTxnCp() {
    document.getElementById('addTxnCpOverlay').classList.remove('show');
    atCpRowId = null;
}

function updateAddTxnCpTotal(row) {
    var calcTotal = atRound((row.brokerage || 0) + (row.stt || 0) + (row.other_charges || 0) + (row.gst || 0));
    var display = row._totalOverride ? row.total_charges : calcTotal;
    var el = document.getElementById('addTxnCpTotal');
    el.textContent = atFmtAmt(display);
    if (row._totalOverride) {
        el.style.color = '#d69e2e';
        el.title = 'User override (calc: ' + atFmtAmt(calcTotal) + ')';
    } else {
        el.style.color = '';
        el.title = 'Double-click to override';
    }
}

function startAddTxnCpEdit(span) {
    if (span.querySelector('input')) return;
    var field = span.dataset.field;
    var row = atRows.find(function(r) { return r.rowId === atCpRowId; });
    if (!row) return;
    var currentVal = row[field] || 0;

    var input = document.createElement('input');
    input.type = 'number';
    input.step = '0.01';
    input.value = currentVal;
    input.className = 'charge-edit-input';
    input.style.width = '90px';

    span.innerHTML = '';
    span.appendChild(input);
    input.focus();
    input.select();

    function commit() {
        var newVal = parseFloat(input.value) || 0;
        row[field] = atRound(newVal);

        // Recalc other_charges if a sub-component changed
        if (['_exchange_charges', '_sebi_charges', '_stamp_duty', '_ipft'].indexOf(field) >= 0) {
            row.other_charges = atRound(row._exchange_charges + row._sebi_charges + row._stamp_duty + row._ipft);
        }

        // Recalc total if not overridden
        if (!row._totalOverride) {
            row.total_charges = atRound(row.brokerage + row.stt + row.other_charges + row.gst);
        }

        // Recalc net
        if (!row._netOverride) {
            if (row.transaction_type === 'BUY') {
                row.net_amount = atRound(row.gross_amount + row.total_charges);
            } else {
                row.net_amount = atRound(row.gross_amount - row.total_charges);
            }
        }

        span.textContent = atFmtAmt(row[field]);
        updateAddTxnCpTotal(row);
        updateAddTxnRowDisplay(atCpRowId);
    }

    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { span.textContent = atFmtAmt(currentVal); }
    });
    input.addEventListener('blur', function() { setTimeout(commit, 100); });
}

function startAddTxnCpTotalEdit(el) {
    if (el.querySelector('input')) return;
    var row = atRows.find(function(r) { return r.rowId === atCpRowId; });
    if (!row) return;
    var currentVal = row.total_charges || 0;

    var input = document.createElement('input');
    input.type = 'number';
    input.step = '0.01';
    input.value = currentVal;
    input.className = 'charge-edit-input';
    input.style.width = '90px';

    el.innerHTML = '';
    el.appendChild(input);
    input.focus();
    input.select();

    function commit() {
        var newVal = parseFloat(input.value) || 0;
        row.total_charges = atRound(newVal);
        row._totalOverride = true;

        // Recalc net
        if (!row._netOverride) {
            if (row.transaction_type === 'BUY') {
                row.net_amount = atRound(row.gross_amount + row.total_charges);
            } else {
                row.net_amount = atRound(row.gross_amount - row.total_charges);
            }
        }

        updateAddTxnCpTotal(row);
        updateAddTxnRowDisplay(atCpRowId);
    }

    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { el.textContent = atFmtAmt(currentVal); }
    });
    input.addEventListener('blur', function() { setTimeout(commit, 100); });
}

// ============================================================================
// Tag Autocomplete
// ============================================================================

function setupAddTxnTagInput(rowId) {
    var input = document.querySelector('.addTxn-tags-input[data-rid="' + rowId + '"]');
    var dd = document.getElementById('addTxnTagDd_' + rowId);

    input.addEventListener('input', function() {
        var val = input.value;
        // Auto-add on comma/semicolon
        if (val.indexOf(',') !== -1 || val.indexOf(';') !== -1) {
            addAddTxnTagFromText(rowId, val);
            return;
        }
        showAddTxnTagDd(rowId, val);
    });

    input.addEventListener('focus', function() {
        if (input.value.length > 0) showAddTxnTagDd(rowId, input.value);
    });
    input.addEventListener('blur', function() {
        setTimeout(function() { dd.classList.remove('show'); }, 150);
    });
}

function addAddTxnTagFromText(rowId, text) {
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;
    var newTags = text.split(/[,;]/).map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; });
    var added = false;
    newTags.forEach(function(tag) {
        if (row.tags.indexOf(tag) === -1) {
            row.tags.push(tag);
            added = true;
            if (atExistingTags.indexOf(tag) === -1 && atExistingTags.indexOf(tag.toLowerCase()) === -1) {
                atExistingTags.push(tag);
                atExistingTags.sort();
            }
        }
    });
    var input = document.querySelector('.addTxn-tags-input[data-rid="' + rowId + '"]');
    input.value = '';
    document.getElementById('addTxnTagDd_' + rowId).classList.remove('show');
    if (added) renderAddTxnTagPills(rowId);
}

function removeAddTxnTag(rowId, tag) {
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;
    row.tags = row.tags.filter(function(t) { return t !== tag; });
    renderAddTxnTagPills(rowId);
}

function renderAddTxnTagPills(rowId) {
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;
    var pillsDiv = document.getElementById('addTxnTagPills_' + rowId);
    pillsDiv.innerHTML = '';
    row.tags.forEach(function(tag) {
        var pill = document.createElement('span');
        pill.className = 'addTxn-tag-pill';
        pill.textContent = tag;
        var x = document.createElement('span');
        x.className = 'x';
        x.textContent = '\u00d7';
        pill.appendChild(x);
        pill.addEventListener('click', function() { removeAddTxnTag(rowId, tag); });
        pillsDiv.appendChild(pill);
    });
}

function showAddTxnTagDd(rowId, filter) {
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;
    var dd = document.getElementById('addTxnTagDd_' + rowId);
    dd.innerHTML = '';
    var filterLower = filter.toLowerCase();
    var matches = atExistingTags.filter(function(tag) {
        return row.tags.indexOf(tag) === -1 && tag.toLowerCase().indexOf(filterLower) !== -1;
    });
    if (matches.length === 0) { dd.classList.remove('show'); return; }
    matches.forEach(function(tag) {
        var pill = document.createElement('span');
        pill.className = 'addTxn-tag-dd-pill';
        pill.textContent = tag;
        pill.addEventListener('mousedown', function(e) {
            e.preventDefault();
            addAddTxnTagFromText(rowId, tag);
        });
        dd.appendChild(pill);
    });
    dd.classList.add('show');
}

// ============================================================================
// Confirmation & Save
// ============================================================================

function openAddTxnConfirmation() {
    // Validate
    var errors = [];
    if (!atSelectedInvestor) errors.push('Investor not selected');
    if (!atSelectedBroker) errors.push('Broker not selected');

    atRows.forEach(function(row, idx) {
        if (!row.security_id) errors.push('Row ' + (idx + 1) + ': Symbol not selected');
        if (row.quantity === 0) errors.push('Row ' + (idx + 1) + ': Quantity is zero');
        if (!row.price || row.price <= 0) errors.push('Row ' + (idx + 1) + ': Price must be > 0');
    });

    if (errors.length > 0) {
        showAlert(errors.join('. '), 'error', 5000);
        return;
    }

    // Build confirmation table
    var tbody = document.getElementById('addTxnConfirmBody');
    tbody.innerHTML = '';
    atRows.forEach(function(row, idx) {
        var type = row.quantity >= 0 ? 'BUY' : 'SELL';
        var typeClass = type === 'BUY' ? 'type-buy' : 'type-sell';
        var tr = document.createElement('tr');
        tr.innerHTML =
            '<td>' + (idx + 1) + '</td>' +
            '<td>' + row.symbol + '</td>' +
            '<td class="' + typeClass + '">' + type + '</td>' +
            '<td class="r">' + formatQuantity(Math.abs(row.quantity)) + '</td>' +
            '<td class="r">' + formatPrice(row.price) + '</td>' +
            '<td class="r">' + atFmtAmt(row.net_amount) + '</td>';
        tbody.appendChild(tr);
    });

    document.getElementById('addTxnConfirmTitle').textContent = 'Confirm ' + atRows.length + ' Transaction(s)';
    document.getElementById('addTxnConfirmOverlay').classList.add('show');
}

function closeAddTxnConfirm() {
    document.getElementById('addTxnConfirmOverlay').classList.remove('show');
}

async function importAddTxnToDb() {
    closeAddTxnConfirm();
    document.getElementById('addTxnSaveBtn').disabled = true;

    // --- Duplicate Detection (same logic as Excel import Stage C) ---
    var txnDate = document.getElementById('addTxnDate').value;
    var investorId = atSelectedInvestor.id;
    var brokerId = atSelectedBroker.id;
    var dupHeaders = { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY };

    try {
        var dupFilter = 'investor_id=eq.' + investorId + '&broker_id=eq.' + brokerId + '&transaction_date=eq.' + txnDate;
        var dupResp = await fetch(SUPABASE_URL + '/rest/v1/transactions?select=id,symbol,transaction_type,quantity,price&' + dupFilter, { headers: dupHeaders });
        var existingTxns = dupResp.ok ? await dupResp.json() : [];

        if (existingTxns.length > 0) {
            // Check each row for duplicates
            var dupes = [];
            atRows.forEach(function(row, idx) {
                var txnType = row.quantity >= 0 ? 'BUY' : 'SELL';
                for (var e = 0; e < existingTxns.length; e++) {
                    var ex = existingTxns[e];
                    if (ex.symbol === row.symbol && ex.transaction_type === txnType) {
                        dupes.push({
                            rowNum: idx + 1,
                            symbol: row.symbol,
                            type: txnType,
                            existingQty: ex.quantity,
                            existingPrice: ex.price,
                            newQty: Math.abs(row.quantity),
                            newPrice: row.price
                        });
                        break;
                    }
                }
            });

            if (dupes.length > 0) {
                var dupMsg = 'Potential duplicate(s) found for ' + txnDate + ':\n\n';
                dupes.forEach(function(d) {
                    dupMsg += 'Row ' + d.rowNum + ': ' + d.symbol + ' ' + d.type +
                        ' — existing: ' + d.existingQty + ' @ ' + d.existingPrice +
                        ', new: ' + d.newQty + ' @ ' + d.newPrice + '\n';
                });
                dupMsg += '\nProceed anyway?';

                if (!confirm(dupMsg)) {
                    document.getElementById('addTxnSaveBtn').disabled = false;
                    return;
                }
            }
        }
    } catch (e) {
        console.warn('Duplicate check failed (proceeding anyway):', e);
    }

    // --- Proceed with Import ---
    showAlert('Importing ' + atRows.length + ' transaction(s)...', 'info', 3000);

    try {
        var records = atRows.map(function(row) {
            return {
                investor_id: atSelectedInvestor.id,
                trader_id: row.trader_id || atSelectedInvestor.id,
                broker_id: atSelectedBroker.id,
                security_id: row.security_id,
                security_type: row.security_type || 'EQUITY',
                symbol: row.symbol,
                short_symbol: row.short_symbol || row.symbol,
                company_name: row.company_name || row.symbol,
                exchange: row.exchange || 'NSE',
                product: null,
                transaction_type: row.quantity >= 0 ? 'BUY' : 'SELL',
                transaction_date: document.getElementById('addTxnDate').value,
                quantity: Math.round(row.quantity),
                lots: row.lots || 0,
                price: atRound(row.price),
                gross_amount: atRound(row.gross_amount),
                brokerage: atRound(row.brokerage || 0),
                stt: atRound(row.stt || 0),
                other_charges: atRound(row.other_charges || 0),
                gst: atRound(row.gst || 0),
                tds: null,
                total_charges: atRound(row.total_charges || 0),
                trader_charges: atRound(row.trader_charges || 0),
                net_amount: atRound(row.net_amount || 0),
                margin_blocked: 0,
                broker_contract_note_no: null,
                broker_trade_id: null,
                tags: (row.tags && row.tags.length > 0) ? row.tags : ['blank'],
                notes: null,
                is_locked: false,
                ignore_for_avg_cost: false,
                dont_display: false
            };
        });

        var headers = {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        };

        // Batch insert (max 10 per batch)
        for (var i = 0; i < records.length; i += 10) {
            var batch = records.slice(i, i + 10);
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

        showAlert('Successfully added ' + records.length + ' transaction(s)', 'success', 3000);
        closeAddTxnModal();

        // Refresh trading module
        if (typeof trRefresh === 'function') trRefresh();

    } catch (e) {
        console.error('Import error:', e);
        showAlert('Error importing: ' + e.message, 'error', 5000);
        document.getElementById('addTxnSaveBtn').disabled = false;
    }
}

// ============================================================================
// Formatting Helpers
// ============================================================================

function atFmtAmt(value) {
    if (value === null || value === undefined || isNaN(value)) return '0.00';
    // Use formatAmount from utils.js if available, otherwise basic format
    if (typeof formatAmount === 'function') return formatAmount(value);
    var abs = Math.abs(value);
    var formatted = abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (value < 0) return '(' + formatted + ')';
    return formatted;
}

// ============================================================================
// Init on script load
// ============================================================================

initAddTxnModule();
