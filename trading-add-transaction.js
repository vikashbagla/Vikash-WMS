// ============================================================================
// trading-add-transaction.js — Add Transaction Modal for Trading Module
// Rule A.1.2: All module-level state uses var (not let/const) to avoid TDZ on reload
// Rule A.1.3: No function names that collide with utils.js const (showAlert, showLoading)
// ============================================================================

// SUPABASE_URL and SUPABASE_ANON_KEY are globals from app.html — do not redeclare

// Reference data — aliases to wmsRefData (loaded once at app startup in wms-shared.js)
// Local aliases for backward compatibility with dropdown/autocomplete code
var atInvestors = [];         // Synced from wmsRefData.investors
var atBrokers = [];           // Synced from wmsRefData.brokers
var atInvObjMap = {};         // Synced from wmsRefData.investorObjMap
var atBrkObjMap = {};         // Synced from wmsRefData.brokerObjMap
var atExistingTags = [];      // Synced from wmsRefData.tags

// Form state
var atSelectedInvestor = null;  // {id, name, short_name}
var atSelectedBroker = null;    // {id, name, broker_code}
var atRows = [];                // Array of row data objects
var atNextRowId = 1;

// Dropdown controllers (wmsDropdown)
var atInvDdCtrl = null;
var atBrkDdCtrl = null;
var atSymDdCtrls = {};        // rowId → wmsDropdown controller

// Tag input controllers (wmsTagInput)
var atTagInputCtrls = {};     // rowId → wmsTagInput controller

// Dropdown data (for wmsDropdown onSelect callback)
var atInvDdItems = [];        // Current investor matches
var atBrkDdItems = [];        // Current broker matches
var atSymDdItems = {};        // rowId → symbol results array

// Options constants now in wms-shared.js (WMS_MONTHS_SHORT, WMS_WEEKLY_EXPIRY_UNDERLYINGS)

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
    // Ensure shared ref data is loaded (loaded once at app startup)
    if (!wmsRefData.ready) {
        await wmsLoadRefData();
    }
    // Sync local aliases from shared ref data
    atInvestors = wmsRefData.investors;
    atBrokers = wmsRefData.brokers;
    atInvObjMap = wmsRefData.investorObjMap;
    atBrkObjMap = wmsRefData.brokerObjMap;
    atExistingTags = wmsRefData.tags;

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

// Reference data loading removed — now uses wmsRefData from wms-shared.js (loaded at app startup)

// ============================================================================
// Investor / Broker Type-to-Search
// ============================================================================

function setupAddTxnInvSearch() {
    var input = document.getElementById('addTxnInvInput');
    var dd = document.getElementById('addTxnInvDd');

    // Create wmsDropdown controller
    atInvDdCtrl = wmsDropdown(input, dd, {
        onSelect: function(itemEl) {
            var idx = parseInt(itemEl.dataset.idx);
            if (idx >= 0 && idx < atInvDdItems.length) {
                selectAddTxnInvestor(atInvDdItems[idx]);
            }
        },
        itemSelector: '.wms-dd-item',
        closeOnSelect: true,
        blurDelay: 200,
        escClearsInput: true
    });

    input.addEventListener('input', function() {
        var q = input.value.trim().toLowerCase();
        if (q.length === 0) {
            atInvDdCtrl.close();
            return;
        }
        var matches = atInvestors.filter(function(inv) {
            return (inv.short_name && inv.short_name.toLowerCase().indexOf(q) !== -1) ||
                   (inv.name && inv.name.toLowerCase().indexOf(q) !== -1);
        });
        atInvDdItems = matches;

        dd.innerHTML = '';
        if (matches.length === 0) {
            dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No matches</div>';
        } else {
            matches.forEach(function(inv, idx) {
                var div = document.createElement('div');
                div.className = 'wms-dd-item';
                div.dataset.idx = idx;
                div.innerHTML = (inv.short_name || inv.name) + '<span class="sub">' + inv.name + '</span>';
                dd.appendChild(div);
            });
        }
        atInvDdCtrl.show();
        atInvDdCtrl.resetIdx();
    });

    input.addEventListener('focus', function() {
        if (atSelectedInvestor) return;
        if (input.value.trim().length > 0) input.dispatchEvent(new Event('input'));
    });
}

function setupAddTxnBrkSearch() {
    var input = document.getElementById('addTxnBrkInput');
    var dd = document.getElementById('addTxnBrkDd');

    // Create wmsDropdown controller
    atBrkDdCtrl = wmsDropdown(input, dd, {
        onSelect: function(itemEl) {
            var idx = parseInt(itemEl.dataset.idx);
            if (idx >= 0 && idx < atBrkDdItems.length) {
                selectAddTxnBroker(atBrkDdItems[idx]);
            }
        },
        itemSelector: '.wms-dd-item',
        closeOnSelect: true,
        blurDelay: 200,
        escClearsInput: true
    });

    input.addEventListener('input', function() {
        var q = input.value.trim().toLowerCase();
        if (q.length === 0) {
            atBrkDdCtrl.close();
            return;
        }
        var matches = atBrokers.filter(function(b) {
            return (b.name && b.name.toLowerCase().indexOf(q) !== -1) ||
                   (b.broker_code && b.broker_code.toLowerCase().indexOf(q) !== -1);
        });
        atBrkDdItems = matches;

        dd.innerHTML = '';
        if (matches.length === 0) {
            dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No matches</div>';
        } else {
            matches.forEach(function(b, idx) {
                var div = document.createElement('div');
                div.className = 'wms-dd-item';
                div.dataset.idx = idx;
                div.innerHTML = (b.broker_code || b.name) + '<span class="sub">' + b.name + '</span>';
                dd.appendChild(div);
            });
        }
        atBrkDdCtrl.show();
        atBrkDdCtrl.resetIdx();
    });

    input.addEventListener('focus', function() {
        if (atSelectedBroker) return;
        if (input.value.trim().length > 0) input.dispatchEvent(new Event('input'));
    });
}

// renderAddTxnDd, handleAddTxnDdNav, highlightDdItem — removed (using wmsDropdown)
// Legacy: kept as empty stubs if called elsewhere (currently not used)
function renderAddTxnDd() {}
function handleAddTxnDdNav() {}
function highlightDdItem() {}

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
    var dd = document.getElementById('addTxnSymDd_' + rowId);

    // Create wmsDropdown for this row's symbol search
    atSymDdCtrls[rowId] = wmsDropdown(symInput, dd, {
        onSelect: function(itemEl) {
            var idx = parseInt(itemEl.dataset.idx);
            if (idx >= 0 && atSymDdItems[rowId] && idx < atSymDdItems[rowId].length) {
                var sec = atSymDdItems[rowId][idx];
                // Check if this is an options contract (has _fyersSymbol field)
                if (sec._fyersSymbol) {
                    atSelectOptionsContract(rowId, sec._fyersSymbol, sec._parsed, sec._displayLabel);
                } else {
                    selectAddTxnSecurity(rowId, sec);
                }
            }
        },
        itemSelector: '.wms-dd-item',
        closeOnSelect: true,
        blurDelay: 200,
        escClearsInput: false
    });

    symInput.addEventListener('input', function() {
        clearTimeout(symSearchTimer);
        var q = symInput.value.trim();
        if (q.length < 2) {
            atSymDdCtrls[rowId].close();
            return;
        }
        symSearchTimer = setTimeout(function() { searchAddTxnSymbol(rowId, q); }, 300);
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
// SYMBOL SEARCH
// Options parsing & candidate building delegated to wms-shared.js.
// See WMS-LESSONS.md Section B.9 for the shared module inventory.
// ============================================================================

// --- Options functions: delegated to wms-shared.js ---
function atParseOptionsQuery(query) { return wmsParseOptionsQuery(query); }
function atBuildOptionsCandidates(underlying, strike, optionType, expiryHint) { return wmsBuildOptionsCandidates(underlying, strike, optionType, expiryHint); }
function atFormatOptionsDisplay(fyersSymbol, underlying, strike, optionType) { return wmsFormatOptionsDisplay(fyersSymbol, underlying, strike, optionType); }

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
        var allSecurities = [];
        validResults.forEach(function(r, idx) {
            var displayLabel = atFormatOptionsDisplay(r.symbol, parsed.underlying, parsed.strike, parsed.optionType);
            var div = document.createElement('div');
            div.className = 'wms-dd-item nfo';
            div.dataset.idx = idx;
            div.innerHTML = displayLabel +
                ' <span class="sub">₹' + r.lp.toFixed(2) + '</span>' +
                ' <span class="sub" style="color:' + (r.chp >= 0 ? '#059669' : '#dc2626') + ';">' +
                (r.chp >= 0 ? '+' : '') + r.chp.toFixed(2) + '%</span>';
            dd.appendChild(div);
            allSecurities.push({
                _fyersSymbol: r.symbol,
                _displayLabel: displayLabel,
                _parsed: parsed
            });
        });
        atSymDdItems[rowId] = allSecurities;
        atSymDdCtrls[rowId].show();
        atSymDdCtrls[rowId].resetIdx();
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
            ')&is_active=eq.true&limit=10&select=id,symbol,underlying_symbol,instrument_name,exchange,instrument_type,lot_size,broker_tokens,expiry_date&order=expiry_date';

        var results = await Promise.all([
            fetch(dbUrl, { headers: headers }).then(function(r) { return r.ok ? r.json() : []; }),
            fetch(nfoUrl, { headers: headers }).then(function(r) { return r.ok ? r.json() : []; })
        ]);

        var dbResults = results[0];
        var nfoResults = results[1];

        // Build combined security results array for the dropdown controller
        var allSecurities = [];

        // CM results
        dbResults.forEach(function(sec) {
            allSecurities.push({
                security_id: sec.id,
                symbol: sec.nse_symbol || sec.bse_symbol || sec.symbol,
                short_symbol: sec.nse_symbol || sec.bse_symbol || sec.symbol,
                company_name: sec.company_name || sec.symbol,
                security_type: sec.security_type || 'EQUITY',
                asset_class: sec.asset_class || null,
                exchange: sec.nse_symbol ? 'NSE' : 'BSE',
                lot_size: sec.lot_size || 1,
                broker_tokens: sec.broker_tokens,
                _displaySym: sec.nse_symbol || sec.bse_symbol || sec.symbol,
                _displayName: sec.company_name || '',
                _isNfo: false
            });
        });

        // NFO results
        nfoResults.forEach(function(sec) {
            var isOpt = sec.symbol && (sec.symbol.match(/(CE|PE)$/) !== null);
            allSecurities.push({
                security_id: sec.id,
                symbol: sec.symbol,
                short_symbol: sec.underlying_symbol || sec.symbol,
                company_name: sec.instrument_name || sec.symbol,
                security_type: 'NFO',
                asset_class: isOpt ? 'OPTIONS' : 'FUTURES',
                exchange: sec.exchange || 'NSE',
                lot_size: sec.lot_size || 1,
                broker_tokens: sec.broker_tokens,
                _displaySym: sec.symbol,
                _displayExpiry: sec.expiry_date,
                _isNfo: true
            });
        });

        allSecurities = wmsSortSearchResults(allSecurities);
        atSymDdItems[rowId] = allSecurities;

        dd.innerHTML = '';
        if (allSecurities.length === 0) {
            dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No matches</div>';
        } else {
            allSecurities.forEach(function(sec, idx) {
                var div = document.createElement('div');
                div.className = sec._isNfo ? 'wms-dd-item nfo' : 'wms-dd-item';
                div.dataset.idx = idx;
                var label = sec._displaySym;
                if (sec._displayExpiry) label += ' <span class="sub">exp ' + sec._displayExpiry + '</span>';
                else if (sec._displayName) label += '<span class="sub">' + sec._displayName + '</span>';
                div.innerHTML = label;
                dd.appendChild(div);
            });
        }
        atSymDdCtrls[rowId].show();
        atSymDdCtrls[rowId].resetIdx();
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
// Charge Calculation — thin wrappers calling wms-shared.js canonical functions
// ============================================================================

function atRound(v) { return wmsRoundMoney(v); }

function atAutoCalcCharges(row) {
    var investorId = atSelectedInvestor ? atSelectedInvestor.id : null;
    var brokerId = atSelectedBroker ? atSelectedBroker.id : null;

    wmsAutoCalcCharges(row, {
        ibaRatesMap: wmsRefData.ibaRatesMap,
        regCharges: wmsRefData.regCharges,
        investorId: investorId,
        brokerId: brokerId,
        preserveExisting: false,  // Add Txn always recalculates fresh
        debug: true
    });
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
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;

    var input = document.querySelector('.addTxn-tags-input[data-rid="' + rowId + '"]');
    var pillsDiv = document.getElementById('addTxnTagPills_' + rowId);
    var dd = document.getElementById('addTxnTagDd_' + rowId);

    // Create wmsTagInput controller
    atTagInputCtrls[rowId] = wmsTagInput(input, pillsDiv, dd, {
        tags: row.tags,
        existingTags: atExistingTags,
        onChange: function() {
            // Tags are automatically updated in row.tags (passed by reference)
        }
    });
}

// Legacy functions — kept as thin delegating stubs if called from other places
function addAddTxnTagFromText(rowId, text) {
    if (atTagInputCtrls[rowId]) {
        var row = atRows.find(function(r) { return r.rowId === rowId; });
        if (!row) return;
        var newTags = text.split(/[,;]/).map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; });
        var added = false;
        newTags.forEach(function(tag) {
            if (row.tags.indexOf(tag) === -1) {
                row.tags.push(tag);
                added = true;
            }
        });
        if (added) {
            atTagInputCtrls[rowId].refresh();
        }
        var input = document.querySelector('.addTxn-tags-input[data-rid="' + rowId + '"]');
        if (input) input.value = '';
    }
}

function removeAddTxnTag(rowId, tag) {
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;
    row.tags = row.tags.filter(function(t) { return t !== tag; });
    if (atTagInputCtrls[rowId]) {
        atTagInputCtrls[rowId].refresh();
    }
}

function renderAddTxnTagPills(rowId) {
    if (atTagInputCtrls[rowId]) {
        atTagInputCtrls[rowId].refresh();
    }
}

// showAddTxnTagDd — functionality now handled by wmsTagInput
function showAddTxnTagDd() {}

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
