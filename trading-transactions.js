// ============================================================================
// WMS TRADING — TRANSACTIONS SUB-MODULE
// ============================================================================
// Loaded on-demand when the Transactions tab is first activated.
// Reads shared data from trading.js: trTransactions, trInvestors, trBrokers,
// INCOME_TYPES, trInvName(), trBrkCode(), trOpenEditModal(),
// trRenderPortfolio(), formatDate(), formatQuantity(), formatAmount(),
// formatPrice(), showAlert(), SUPABASE_URL, SUPABASE_ANON_KEY.

var trTxSortColumn = 'date';
var trTxSortDirection = 'desc';
var trTxSymbolSearch = '';
var trTxSelectedInvestorIds = [];
var trTxSelectedTraderIds = [];
var trTxSelectedBrokerIds = [];
var trTxSelectedTagNames = [];
var trTxTagLogic = 'OR';
var trTxInitialized = false;
var trTxOpenMenuId = null;
var trTxInvPillFilter = null;
var trTxTrdPillFilter = null;
var trTxBrkPillFilter = null;
var trTxTagPillFilter = null;

// New state for options bar
var trTxViewMode = 'list';        // 'list' or 'matching'
var trTxMatchMethod = 'lifo';     // 'fifo' or 'lifo'
var trTxShowAll = false;
var trTxFnoOnly = false;

// Date filter state
var trTxDateFilterInstance = null;
var trTxDateRange = { from: null, to: null };

// Checkbox / bulk selection state
var trTxSelectedIds = {};         // { txnId: true, ... }

// Set of row indices hidden in matching view (view-only, not persisted)
var trTxMatchHiddenRows = {};

// ============================================================================
// INITIALIZATION
// ============================================================================

function trTxInit() {
    if (!trTxInitialized) {
        trTxSetupFilters();
        trTxSetupOptionsBar();
        trTxSetupCheckboxes();
        trTxInitialized = true;
    } else {
        // Rebuild date filter — data may have loaded after first init
        trTxRebuildDateFilter();
    }
    // Always repopulate pills — data may not have been ready on first load
    trTxInitPills();
    trTxRender();
}

// ============================================================================
// FILTER PILLS
// ============================================================================

function trTxInitPills() {
    // Investor pills
    var invContainer = document.getElementById('trTx-filter-investor');
    if (invContainer) {
        var invItems = trInvestors.map(function(inv) { return {id: String(inv.id), label: inv.short_name || inv.name, searchText: (inv.name || '') + ' ' + (inv.short_name || '')}; });
        trTxInvPillFilter = wmsPillSearch(invContainer, {
            label: 'Investor',
            placeholder: 'Search investors...',
            items: invItems,
            selectedIds: trTxSelectedInvestorIds,
            onChange: trTxRender
        });
    }

    // Trader pills (same investors list — traders are investors)
    var trdContainer = document.getElementById('trTx-filter-trader');
    if (trdContainer) {
        var trdItems = trInvestors.map(function(inv) { return {id: String(inv.id), label: inv.short_name || inv.name, searchText: (inv.name || '') + ' ' + (inv.short_name || '')}; });
        trTxTrdPillFilter = wmsPillSearch(trdContainer, {
            label: 'Trader',
            placeholder: 'Search traders...',
            items: trdItems,
            selectedIds: trTxSelectedTraderIds,
            onChange: trTxRender
        });
    }

    // Broker pills
    var brkContainer = document.getElementById('trTx-filter-broker');
    if (brkContainer) {
        var brkItems = trBrokers.map(function(b) { return {id: String(b.id), label: b.broker_code || b.name, searchText: (b.name || '') + ' ' + (b.broker_code || '')}; });
        trTxBrkPillFilter = wmsPillSearch(brkContainer, {
            label: 'Broker',
            placeholder: 'Search brokers...',
            items: brkItems,
            selectedIds: trTxSelectedBrokerIds,
            onChange: trTxRender
        });
    }

    // Tag pills — case-insensitive dedup (Rule D.5.5)
    var tagContainer = document.getElementById('trTx-filter-tag');
    if (tagContainer) {
        var tagItems = wmsBuildTagItems(trTransactions);
        // Build tag-logic radios as headerExtra
        var tagExtra = document.createElement('div');
        tagExtra.className = 'tag-match-options';
        tagExtra.innerHTML =
            '<span style="font-size:11px;color:#718096;">Match:</span>' +
            '<label class="radio-label"><input type="radio" name="trTx-tag-logic" value="OR" checked> <span>Any</span></label>' +
            '<label class="radio-label"><input type="radio" name="trTx-tag-logic" value="AND"> <span>All</span></label>';
        trTxTagPillFilter = wmsPillSearch(tagContainer, {
            label: 'Tag',
            placeholder: 'Search tags...',
            items: tagItems,
            selectedIds: trTxSelectedTagNames,
            onChange: trTxRender,
            headerExtra: tagExtra
        });
        // Re-attach tag logic radio listeners
        tagContainer.querySelectorAll('input[name="trTx-tag-logic"]').forEach(function(r) {
            r.addEventListener('change', function() {
                trTxTagLogic = r.value;
                trTxRender();
            });
        });
    }
}

function trTxAttachPillListeners() {
    // Empty stub — wmsPillFilter handles all pill interactions
}

// ============================================================================
// FILTER SETUP
// ============================================================================

function trTxSetupFilters() {
    // Symbol search
    var symInput = document.getElementById('trTx-symbol-search');
    if (symInput) {
        symInput.addEventListener('input', function() {
            trTxSymbolSearch = symInput.value.toLowerCase();
            var clearBtn = document.getElementById('trTx-clear-symbol');
            if (clearBtn) clearBtn.style.visibility = trTxSymbolSearch ? 'visible' : 'hidden';
            trTxRender();
        });
    }
    var clearSym = document.getElementById('trTx-clear-symbol');
    if (clearSym) {
        clearSym.addEventListener('click', function() {
            trTxSymbolSearch = '';
            var input = document.getElementById('trTx-symbol-search');
            if (input) input.value = '';
            clearSym.style.visibility = 'hidden';
            trTxRender();
        });
    }

    // Tag logic radio — setup deferred to trTxInitPills() where wmsPillSearch creates the DOM
    // (kept for reference — old tag logic handler was here)
    document.querySelectorAll('input[name="trTx-tag-logic"]').forEach(function(r) {
        r.addEventListener('change', function() {
            trTxTagLogic = r.value;
            trTxRender();
        });
    });

    // Close action menus on outside click
    document.addEventListener('click', function(e) {
        if (trTxOpenMenuId && !e.target.closest('.action-cell')) {
            trTxCloseAllMenus();
        }
    });

    // Sort headers
    document.getElementById('trTx-th-date').addEventListener('click', function() { trTxSort('date'); });
    document.getElementById('trTx-th-investor').addEventListener('click', function() { trTxSort('investor'); });
    document.getElementById('trTx-th-symbol').addEventListener('click', function() { trTxSort('symbol'); });
}

// ============================================================================
// OPTIONS BAR SETUP
// ============================================================================

function trTxSetupOptionsBar() {
    // Show All toggle
    var showAllCb = document.getElementById('trTx-show-all');
    if (showAllCb) {
        showAllCb.addEventListener('change', function() {
            trTxShowAll = showAllCb.checked;
            trTxRender();
        });
    }

    // F&O Only toggle
    var fnoCb = document.getElementById('trTx-fno-only');
    if (fnoCb) {
        fnoCb.addEventListener('change', function() {
            trTxFnoOnly = fnoCb.checked;
            trTxRender();
        });
    }

    // View toggle (List / Matching Trades)
    var viewToggle = document.getElementById('trTx-view-toggle');
    if (viewToggle) {
        viewToggle.querySelectorAll('.trTx-toggle-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                viewToggle.querySelectorAll('.trTx-toggle-btn').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                trTxViewMode = btn.dataset.view;

                // Show/hide FIFO/LIFO toggle
                var fifoGroup = document.getElementById('trTx-match-method-toggle');
                if (fifoGroup) {
                    fifoGroup.classList.toggle('visible', trTxViewMode === 'matching');
                }

                trTxRender();
            });
        });
    }

    // FIFO/LIFO toggle
    var methodToggle = document.getElementById('trTx-match-method-toggle');
    if (methodToggle) {
        methodToggle.querySelectorAll('.trTx-toggle-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                methodToggle.querySelectorAll('.trTx-toggle-btn').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                trTxMatchMethod = btn.dataset.method;
                trTxRender();
            });
        });
    }

    // Date filter — initialize shared wmsDateFilter component
    var dateContainer = document.getElementById('trTx-date-filter');
    if (dateContainer) {
        var fyStartMonth = 4; // Default April; override from user prefs if available
        if (window.wmsRefData && wmsRefData.userPrefs && wmsRefData.userPrefs.fy_start_month) {
            fyStartMonth = wmsRefData.userPrefs.fy_start_month;
        }
        trTxDateFilterInstance = wmsDateFilter(dateContainer, {
            default: 'last7',
            fyStartMonth: fyStartMonth,
            transactions: trTransactions,
            onChange: function(from, to) {
                trTxDateRange = { from: from, to: to };
                trTxRender();
            }
        });
        // Set initial range from default preset
        if (trTxDateFilterInstance) {
            trTxDateRange = trTxDateFilterInstance.getRange();
        }
    }
}

// Rebuild date filter with fresh transaction data (FY list depends on data)
function trTxRebuildDateFilter() {
    var dateContainer = document.getElementById('trTx-date-filter');
    if (!dateContainer) return;
    // Preserve current preset if possible
    var prevPreset = trTxDateFilterInstance ? trTxDateFilterInstance.getPreset() : 'last7';
    if (trTxDateFilterInstance) trTxDateFilterInstance.destroy();

    var fyStartMonth = 4;
    if (window.wmsRefData && wmsRefData.userPrefs && wmsRefData.userPrefs.fy_start_month) {
        fyStartMonth = wmsRefData.userPrefs.fy_start_month;
    }
    trTxDateFilterInstance = wmsDateFilter(dateContainer, {
        default: prevPreset,
        fyStartMonth: fyStartMonth,
        transactions: trTransactions,
        onChange: function(from, to) {
            trTxDateRange = { from: from, to: to };
            trTxRender();
        }
    });
    if (trTxDateFilterInstance) {
        trTxDateRange = trTxDateFilterInstance.getRange();
    }
}

// ============================================================================
// CHECKBOX / BULK SELECTION SETUP
// ============================================================================

function trTxSetupCheckboxes() {
    // Select-all checkbox in header
    var selectAll = document.getElementById('trTx-select-all');
    if (selectAll) {
        selectAll.addEventListener('change', function() {
            var checked = selectAll.checked;
            // Get currently visible transaction IDs
            var filtered = trTxGetFilteredTransactions();
            trTxSelectedIds = {};
            if (checked) {
                filtered.forEach(function(t) {
                    trTxSelectedIds[t.id] = true;
                });
            }
            trTxUpdateCheckboxUI();
            trTxUpdateBulkBar();
        });
    }
}

function trTxUpdateCheckboxUI() {
    // Update individual row checkboxes
    document.querySelectorAll('#trTx-list input.trTx-row-cb').forEach(function(cb) {
        cb.checked = !!trTxSelectedIds[cb.dataset.txnId];
    });
    // Update select-all checkbox state
    var selectAll = document.getElementById('trTx-select-all');
    if (selectAll) {
        var filtered = trTxGetFilteredTransactions();
        var count = Object.keys(trTxSelectedIds).length;
        selectAll.checked = filtered.length > 0 && count === filtered.length;
        selectAll.indeterminate = count > 0 && count < filtered.length;
    }
}

function trTxUpdateBulkBar() {
    var ids = Object.keys(trTxSelectedIds);
    var count = ids.length;
    var bar = document.getElementById('trTx-bulk-bar');
    if (bar) {
        bar.style.display = count > 0 ? 'flex' : 'none';
    }
    var countEl = document.getElementById('trTx-bulk-count');
    if (countEl) {
        countEl.textContent = count + ' selected';
    }
    // Dynamic label for ignore_for_avg_cost toggle
    var ignoreBtn = document.getElementById('trTx-bulk-ignore');
    if (ignoreBtn && count > 0) {
        var ignoredCount = 0;
        ids.forEach(function(id) {
            var txn = trTransactions.find(function(t) { return t.id === id; });
            if (txn && txn.ignore_for_avg_cost) ignoredCount++;
        });
        if (ignoredCount === count) {
            // All ignored → offer to include
            ignoreBtn.textContent = '✅ Include Avg';
            ignoreBtn.title = 'Include all selected in avg cost calculation';
        } else {
            // None or mixed → offer to ignore all
            ignoreBtn.textContent = '⊘ Ignore Avg';
            ignoreBtn.title = 'Ignore all selected for avg cost calculation';
        }
    }
}

function trTxClearSelection() {
    trTxSelectedIds = {};
    trTxUpdateCheckboxUI();
    trTxUpdateBulkBar();
}

// ============================================================================
// BULK ACTIONS
// ============================================================================

async function trTxBulkHide() {
    var ids = Object.keys(trTxSelectedIds);
    if (ids.length === 0) return;
    if (!confirm('Hide ' + ids.length + ' transaction(s) from display?')) return;

    var headers = wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'});

    var failed = 0;
    for (var i = 0; i < ids.length; i++) {
        var txnId = ids[i];
        var txn = trTransactions.find(function(t) { return t.id === txnId; });
        if (!txn || txn.dont_display) continue;

        var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + txnId, {
            method: 'PATCH',
            headers: headers,
            body: JSON.stringify({ dont_display: true })
        });
        if (resp.ok) {
            txn.dont_display = true;
        } else {
            failed++;
        }
    }

    trTxClearSelection();
    trTxRender();
    trRenderPortfolio();
    if (failed > 0) {
        showAlert(failed + ' transaction(s) failed to hide', 'error');
    } else {
        showAlert(ids.length + ' transaction(s) hidden', 'success', 2000);
    }
}

async function trTxBulkIgnoreAvg() {
    var ids = Object.keys(trTxSelectedIds);
    if (ids.length === 0) return;

    // Determine toggle direction: if ALL selected (non-locked) are already ignored → include them; else → ignore them
    var allIgnored = ids.every(function(id) {
        var txn = trTransactions.find(function(t) { return t.id === id; });
        return txn && txn.ignore_for_avg_cost;
    });
    var newValue = !allIgnored;
    var label = newValue ? 'Ignore for avg cost' : 'Include in avg cost';

    if (!confirm(label + ' for ' + ids.length + ' transaction(s)?')) return;

    var headers = wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'});

    var failed = 0;
    for (var i = 0; i < ids.length; i++) {
        var txnId = ids[i];
        var txn = trTransactions.find(function(t) { return t.id === txnId; });
        if (!txn) continue;

        var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + txnId, {
            method: 'PATCH',
            headers: headers,
            body: JSON.stringify({ ignore_for_avg_cost: newValue })
        });
        if (resp.ok) {
            txn.ignore_for_avg_cost = newValue;
        } else {
            failed++;
        }
    }

    trTxClearSelection();
    trTxRender();
    trRenderPortfolio();
    if (failed > 0) {
        showAlert(failed + ' transaction(s) failed to update', 'error');
    } else {
        showAlert(ids.length + ' transaction(s) ' + (newValue ? 'ignored' : 'included') + ' for avg cost', 'success', 2000);
    }
}

async function trTxBulkDelete() {
    var ids = Object.keys(trTxSelectedIds);
    if (ids.length === 0) return;

    // Check for locked transactions
    var lockedCount = 0;
    ids.forEach(function(id) {
        var txn = trTransactions.find(function(t) { return t.id === id; });
        if (txn && txn.is_locked) lockedCount++;
    });
    if (lockedCount > 0) {
        showAlert(lockedCount + ' locked transaction(s) cannot be deleted. Unlock them first.', 'error');
        return;
    }

    if (!confirm('Delete ' + ids.length + ' transaction(s)? This cannot be undone.')) return;

    // Block UI during bulk delete
    showLoading(true, 'Deleting ' + ids.length + ' transaction(s)...');

    var headers = wmsHeaders({'Prefer': 'return=minimal'});

    var failed = 0;
    for (var i = 0; i < ids.length; i++) {
        var txnId = ids[i];
        var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + txnId, {
            method: 'DELETE',
            headers: headers
        });
        if (resp.ok) {
            trTransactions = trTransactions.filter(function(t) { return t.id !== txnId; });
        } else {
            failed++;
        }
    }

    showLoading(false);
    trTxClearSelection();
    trTxRender();
    trRenderPortfolio();
    if (failed > 0) {
        showAlert(failed + ' transaction(s) failed to delete', 'error');
    } else {
        showAlert(ids.length + ' transaction(s) deleted', 'success', 2000);
    }
}

// ============================================================================
// BULK TAG CHANGE
// ============================================================================

var trTxBulkTagCtrl = null;

function trTxOpenTagPopup() {
    var popup = document.getElementById('trTx-tag-popup');
    if (!popup) return;

    // Destroy previous controller
    if (trTxBulkTagCtrl) { trTxBulkTagCtrl.destroy(); trTxBulkTagCtrl = null; }

    // Collect all existing tags for autocomplete
    var inputEl = document.getElementById('trTx-tag-popup-input');
    var pillsEl = document.getElementById('trTx-tag-popup-pills');
    var ddEl = document.getElementById('trTx-tag-popup-dd');
    inputEl.value = '';
    pillsEl.innerHTML = '';
    ddEl.innerHTML = '';

    trTxBulkTagCtrl = wmsTagInput(inputEl, pillsEl, ddEl, {
        tags: [],
        existingTags: wmsBuildTagItems(trTransactions).map(function(it) { return it.label; }),
        onChange: function() {}
    });

    popup.classList.add('show');
    inputEl.focus();
}

function trTxCloseTagPopup() {
    var popup = document.getElementById('trTx-tag-popup');
    if (popup) popup.classList.remove('show');
    if (trTxBulkTagCtrl) { trTxBulkTagCtrl.destroy(); trTxBulkTagCtrl = null; }
}

async function trTxApplyBulkTags() {
    var ids = Object.keys(trTxSelectedIds);
    if (ids.length === 0) return;

    // Capture confirmed tags + any pending text in the input (user typed but didn't press Enter)
    var newTags = trTxBulkTagCtrl ? trTxBulkTagCtrl.getTags().slice() : [];
    var pendingInput = document.getElementById('trTx-tag-popup-input');
    if (pendingInput && pendingInput.value.trim()) {
        pendingInput.value.split(/[,;]/).map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; }).forEach(function(p) {
            if (newTags.indexOf(p) === -1) newTags.push(p);
        });
    }
    var tagsToSave = newTags.length > 0 ? newTags : ['blank'];

    trTxCloseTagPopup();
    showLoading(true, 'Updating tags on ' + ids.length + ' transaction(s)...');

    var headers = wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'});

    var failed = 0;
    for (var i = 0; i < ids.length; i++) {
        var txnId = ids[i];
        var txn = trTransactions.find(function(t) { return t.id === txnId; });
        if (!txn) continue;

        var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + txnId, {
            method: 'PATCH',
            headers: headers,
            body: JSON.stringify({ tags: tagsToSave })
        });
        if (resp.ok) {
            txn.tags = tagsToSave.slice();
        } else {
            failed++;
        }
    }

    showLoading(false);
    trTxClearSelection();
    trTxRender();
    if (failed > 0) {
        showAlert(failed + ' transaction(s) failed to update', 'error');
    } else {
        showAlert(ids.length + ' transaction(s) tags updated', 'success', 2000);
    }
}

// ============================================================================
// SELECTED TAGS (filter chips)
// ============================================================================

function trTxRenderSelectedTags(type) {
    // Delegate to wmsPillFilter's renderSelectedTags method
    if (type === 'investor' && trTxInvPillFilter) {
        trTxInvPillFilter.renderSelectedTags();
    } else if (type === 'trader' && trTxTrdPillFilter) {
        trTxTrdPillFilter.renderSelectedTags();
    } else if (type === 'broker' && trTxBrkPillFilter) {
        trTxBrkPillFilter.renderSelectedTags();
    } else if (type === 'tag' && trTxTagPillFilter) {
        trTxTagPillFilter.renderSelectedTags();
    }
}

function trTxSyncPillStates(type) {
    // Delegate to wmsPillFilter's syncStates method
    if (type === 'investor' && trTxInvPillFilter) {
        trTxInvPillFilter.syncStates();
    } else if (type === 'trader' && trTxTrdPillFilter) {
        trTxTrdPillFilter.syncStates();
    } else if (type === 'broker' && trTxBrkPillFilter) {
        trTxBrkPillFilter.syncStates();
    } else if (type === 'tag' && trTxTagPillFilter) {
        trTxTagPillFilter.syncStates();
    }
}

// ============================================================================
// SORTING
// ============================================================================

function trTxSort(column) {
    if (trTxSortColumn === column) {
        trTxSortDirection = trTxSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        trTxSortColumn = column;
        trTxSortDirection = column === 'date' ? 'desc' : 'asc';
    }
    trTxRender();
}

function trTxUpdateSortIndicators() {
    document.querySelectorAll('#trTx-table .sort-indicator').forEach(function(el) { el.textContent = ''; });
    var indicator = document.getElementById('trTx-sort-' + trTxSortColumn);
    if (indicator) {
        indicator.textContent = trTxSortDirection === 'asc' ? '▲' : '▼';
    }
}

// Multi-level sort comparator for default sort:
// Primary: Date desc → Secondary: Symbol asc → Tertiary: Investor>Trader>Broker asc
function trTxMultiSort(a, b) {
    // Primary: date descending
    var dateA = new Date(a.transaction_date);
    var dateB = new Date(b.transaction_date);
    if (dateA.getTime() !== dateB.getTime()) {
        return dateB - dateA;
    }
    // Secondary: symbol ascending
    var symA = (a.short_symbol || a.symbol || '').toLowerCase();
    var symB = (b.short_symbol || b.symbol || '').toLowerCase();
    var symCmp = symA.localeCompare(symB);
    if (symCmp !== 0) return symCmp;
    // Tertiary: investor>trader>broker ascending
    var invA = (trInvName(a.investor_id) + ' ' + trBrkCode(a.broker_id)).toLowerCase();
    var invB = (trInvName(b.investor_id) + ' ' + trBrkCode(b.broker_id)).toLowerCase();
    return invA.localeCompare(invB);
}

// ============================================================================
// COMMON FILTER LOGIC
// ============================================================================

function trTxGetFilteredTransactions() {
    var filtered = trTransactions.slice();

    // Filter: hide dont_display unless Show All is ON
    if (!trTxShowAll) {
        filtered = filtered.filter(function(t) { return !t.dont_display; });
    }

    // Filter: F&O only (NFO exchange, NFO security_type, or MCX)
    if (trTxFnoOnly) {
        filtered = filtered.filter(function(t) {
            return t.exchange === 'NFO' || t.security_type === 'NFO' || t.exchange === 'MCX';
        });
    }

    // Filter: date range
    if (trTxDateRange.from) {
        filtered = filtered.filter(function(t) {
            return t.transaction_date >= trTxDateRange.from;
        });
    }
    if (trTxDateRange.to) {
        filtered = filtered.filter(function(t) {
            return t.transaction_date <= trTxDateRange.to;
        });
    }

    // Filter: symbol search (uses enriched _searchText from wmsRefData, Rule B.9.2)
    if (trTxSymbolSearch) {
        var symTokens = wmsTokenize(trTxSymbolSearch);
        filtered = filtered.filter(function(t) {
            return wmsMultiTokenMatch(symTokens, t._searchText);
        });
    }

    // Filter: investors (use String() for safe comparison)
    if (trTxSelectedInvestorIds.length > 0) {
        filtered = filtered.filter(function(t) {
            return t.investor_id && trTxSelectedInvestorIds.indexOf(String(t.investor_id)) >= 0;
        });
    }

    // Filter: traders (use String() for safe comparison)
    if (trTxSelectedTraderIds.length > 0) {
        filtered = filtered.filter(function(t) {
            var tid = t.trader_id || t.investor_id; return tid && trTxSelectedTraderIds.indexOf(String(tid)) >= 0;
        });
    }

    // Filter: brokers (use String() for safe comparison)
    if (trTxSelectedBrokerIds.length > 0) {
        filtered = filtered.filter(function(t) {
            return t.broker_id && trTxSelectedBrokerIds.indexOf(String(t.broker_id)) >= 0;
        });
    }

    // Filter: tags — case-insensitive (Rule D.5.5)
    if (trTxSelectedTagNames.length > 0) {
        filtered = filtered.filter(function(t) {
            return wmsMatchTagsFilter(t.tags, trTxSelectedTagNames, trTxTagLogic);
        });
    }

    return filtered;
}

// ============================================================================
// MAIN RENDER — dispatches to list or matching view
// ============================================================================

function trTxRender() {
    var filtered = trTxGetFilteredTransactions();

    // Update count
    var totalCount = trTxShowAll ? trTransactions.length : trTransactions.filter(function(t) { return !t.dont_display; }).length;
    var countEl = document.getElementById('trTx-count');
    if (countEl) {
        countEl.textContent = 'Showing ' + filtered.length + ' of ' + totalCount + ' transactions';
    }

    // Show/hide containers based on view mode
    var listContainer = document.getElementById('trTx-list-container');
    var matchContainer = document.getElementById('trTx-matching-container');

    if (trTxViewMode === 'matching') {
        if (listContainer) listContainer.classList.add('hidden');
        if (matchContainer) matchContainer.classList.add('visible');
        trTxRenderMatchingTrades(filtered);
    } else {
        if (listContainer) listContainer.classList.remove('hidden');
        if (matchContainer) matchContainer.classList.remove('visible');
        trTxRenderList(filtered);
    }
}

// ============================================================================
// LIST VIEW RENDER
// ============================================================================

function trTxRenderList(filtered) {
    // Sort: if user clicked a column header, use single-column sort;
    // otherwise (default state: date desc) use multi-level sort
    if (trTxSortColumn === 'date' && trTxSortDirection === 'desc') {
        // Default multi-level sort: date desc > symbol asc > investor asc
        filtered.sort(trTxMultiSort);
    } else {
        // User-selected single-column sort
        filtered.sort(function(a, b) {
            var valA, valB;
            switch (trTxSortColumn) {
                case 'investor':
                    valA = (trInvName(a.investor_id) + ' ' + trBrkCode(a.broker_id)).toLowerCase();
                    valB = (trInvName(b.investor_id) + ' ' + trBrkCode(b.broker_id)).toLowerCase();
                    return trTxSortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
                case 'symbol':
                    valA = (a.short_symbol || a.symbol || '').toLowerCase();
                    valB = (b.short_symbol || b.symbol || '').toLowerCase();
                    return trTxSortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
                case 'date':
                default:
                    valA = new Date(a.transaction_date);
                    valB = new Date(b.transaction_date);
                    return trTxSortDirection === 'asc' ? valA - valB : valB - valA;
            }
        });
    }

    // When Show All is ON, push dont_display rows to the bottom (retain sort within each group)
    if (trTxShowAll) {
        var normal = filtered.filter(function(t) { return !t.dont_display; });
        var hidden = filtered.filter(function(t) { return t.dont_display; });
        filtered = normal.concat(hidden);
    }

    var tbody = document.getElementById('trTx-list');
    if (!tbody) return;

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:40px;color:#9ca3af;">No transactions match the current filters</td></tr>';
        trTxUpdateSortIndicators();
        return;
    }

    tbody.innerHTML = filtered.map(function(txn) {
        var isSell = txn.transaction_type === 'SELL';
        var isIncome = INCOME_TYPES.indexOf(txn.transaction_type) >= 0;
        var qty = Math.abs(txn.quantity || 0);
        // List shows the trader-perspective value (display_net_amount), not the raw DB net_amount.
        var netAmt = txn.display_net_amount !== undefined ? txn.display_net_amount : (txn.net_amount || 0);
        var tradedPrice = txn.price || 0;
        var netPrice = qty !== 0 ? Math.abs(netAmt / qty) : 0;

        // Row classes
        var rowClasses = [];
        if (txn.dont_display && trTxShowAll) rowClasses.push('trTx-hidden-row');
        var rowClass = rowClasses.length > 0 ? ' class="' + rowClasses.join(' ') + '"' : '';

        // Investor > Trader > Broker
        var invBrk = trInvName(txn.investor_id);
        var trdName = txn.trader_id ? trInvName(txn.trader_id) : '';
        var brkCode = trBrkCode(txn.broker_id);
        if (trdName && trdName !== invBrk) invBrk += ' > ' + trdName;
        if (brkCode) invBrk += ' > ' + brkCode;

        // Type badge color
        var typeColor = '#667eea'; // default purple
        if (txn.transaction_type === 'BUY') typeColor = '#059669';
        else if (txn.transaction_type === 'SELL') typeColor = '#dc2626';
        else if (isIncome) typeColor = '#d97706';

        // Locked icon
        var lockIcon = txn.is_locked ? ' 🔒' : '';

        // Quantity display — negative for sells, in red with parentheses
        var qtyHtml;
        if (isSell) {
            qtyHtml = '<span class="negative">(' + formatQuantity(qty) + ')</span>';
        } else {
            qtyHtml = formatQuantity(qty);
        }

        // Net amount display — negative amounts in red with parentheses
        var netAmtHtml;
        if (netAmt < 0) {
            netAmtHtml = '<span class="negative">(' + formatAmount(Math.abs(netAmt)) + ')</span>';
        } else {
            netAmtHtml = formatAmount(netAmt);
        }

        // Tags
        var tagHtml = '';
        var tags = (txn.tags || []).filter(function(tg) { return tg; });
        if (tags.length > 0) {
            tagHtml = '<div class="tag-pills">' + tags.map(function(tg) {
                return '<span class="tag-pill">' + tg + '</span>';
            }).join('') + '</div>';
        }

        // Action menu — icon-only, lock-aware
        var menuId = 'trTxAm-' + txn.id.substring(0, 8);
        var isLocked = !!txn.is_locked;
        var editClass = isLocked ? 'action-menu-item disabled' : 'action-menu-item';
        var deleteClass = isLocked ? 'action-menu-item danger disabled' : 'action-menu-item danger';
        var hideIcon = txn.dont_display ? '👁' : '👁';
        var hideTitle = txn.dont_display ? 'Show in Display' : 'Hide from Display';

        // Checkbox state
        var cbChecked = trTxSelectedIds[txn.id] ? ' checked' : '';

        return '<tr' + rowClass + ' data-txn-id="' + txn.id + '">' +
            '<td class="trTx-checkbox-cell">' +
                '<input type="checkbox" class="trTx-row-cb" data-txn-id="' + txn.id + '"' + cbChecked + '>' +
            '</td>' +
            '<td>' + formatDate(txn.transaction_date) + '</td>' +
            '<td>' + invBrk + '</td>' +
            '<td>' + (txn.symbol || txn.short_symbol || '') +
                (txn.company_name ? '<br><span style="font-size:10px;color:#9ca3af;">' + txn.company_name + '</span>' : '') +
            '</td>' +
            '<td style="text-align:center;">' +
                '<span class="trTx-type-badge" style="background:' + typeColor + '1a;color:' + typeColor + ';">' +
                    txn.transaction_type + lockIcon +
                '</span>' +
            '</td>' +
            '<td class="text-right">' + qtyHtml + '</td>' +
            '<td class="text-right">' + formatPrice(tradedPrice, false) + '</td>' +
            '<td class="text-right">' + formatPrice(netPrice, false) + '</td>' +
            '<td class="text-right">' + netAmtHtml + '</td>' +
            '<td>' + tagHtml + '</td>' +
            '<td class="action-cell">' +
                '<button class="btn-action trTx-action-btn" data-txn-id="' + txn.id + '" title="Actions">⋮</button>' +
                '<div class="action-menu" id="' + menuId + '">' +
                    '<button class="' + editClass + '" data-txaction="edit" data-txn-id="' + txn.id + '" title="Edit">✏️</button>' +
                    '<button class="action-menu-item" data-txaction="toggle-display" data-txn-id="' + txn.id + '" title="' + hideTitle + '">' + hideIcon + '</button>' +
                    '<button class="' + deleteClass + '" data-txaction="delete" data-txn-id="' + txn.id + '" title="Delete">🗑️</button>' +
                '</div>' +
            '</td>' +
        '</tr>';
    }).join('');

    trTxUpdateSortIndicators();
    trTxAttachRowListeners();
}

// ============================================================================
// ROW EVENT LISTENERS
// ============================================================================

function trTxAttachRowListeners() {
    // Action menu buttons
    document.querySelectorAll('.trTx-action-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var txnId = btn.dataset.txnId;
            var menuId = 'trTxAm-' + txnId.substring(0, 8);
            var menu = document.getElementById(menuId);
            if (!menu) return;

            var wasOpen = menu.classList.contains('show');
            trTxCloseAllMenus();
            if (!wasOpen) {
                menu.classList.add('show');
                trTxOpenMenuId = menuId;
            }
        });
    });

    // Action menu items
    document.querySelectorAll('#trTx-list .action-menu-item').forEach(function(item) {
        item.addEventListener('click', function(e) {
            e.stopPropagation();

            // Disabled items (locked) — show alert and stop
            if (item.classList.contains('disabled')) {
                showAlert('Transaction is locked. Unlock it first.', 'error');
                return;
            }

            trTxCloseAllMenus();
            var action = item.dataset.txaction;
            var txnId = item.dataset.txnId;
            if (action === 'edit') trOpenEditModal(txnId);
            else if (action === 'toggle-display') trTxToggleFlag(txnId, 'dont_display');
            else if (action === 'delete') trTxDeleteTransaction(txnId);
        });
    });

    // Row click opens edit modal (except action cell and checkbox cell)
    // Locked transactions open in view-only mode (Save disabled, fields read-only)
    document.querySelectorAll('#trTx-list tr[data-txn-id]').forEach(function(row) {
        row.addEventListener('click', function(e) {
            if (e.target.closest('.action-cell')) return;
            if (e.target.closest('.trTx-checkbox-cell')) return;
            trOpenEditModal(row.dataset.txnId);
        });
    });

    // Individual row checkboxes
    document.querySelectorAll('#trTx-list input.trTx-row-cb').forEach(function(cb) {
        cb.addEventListener('change', function(e) {
            e.stopPropagation();
            var txnId = cb.dataset.txnId;
            if (cb.checked) {
                trTxSelectedIds[txnId] = true;
            } else {
                delete trTxSelectedIds[txnId];
            }
            trTxUpdateCheckboxUI();
            trTxUpdateBulkBar();
        });
    });

    // Bulk action buttons — attach once (safe to re-attach, won't duplicate because they're static elements)
    var bulkHideBtn = document.getElementById('trTx-bulk-hide');
    var bulkDeleteBtn = document.getElementById('trTx-bulk-delete');
    var bulkClearBtn = document.getElementById('trTx-bulk-clear');
    if (bulkHideBtn && !bulkHideBtn._bound) {
        bulkHideBtn.addEventListener('click', trTxBulkHide);
        bulkHideBtn._bound = true;
    }
    var bulkIgnoreBtn = document.getElementById('trTx-bulk-ignore');
    if (bulkIgnoreBtn && !bulkIgnoreBtn._bound) {
        bulkIgnoreBtn.addEventListener('click', trTxBulkIgnoreAvg);
        bulkIgnoreBtn._bound = true;
    }
    if (bulkDeleteBtn && !bulkDeleteBtn._bound) {
        bulkDeleteBtn.addEventListener('click', trTxBulkDelete);
        bulkDeleteBtn._bound = true;
    }
    if (bulkClearBtn && !bulkClearBtn._bound) {
        bulkClearBtn.addEventListener('click', trTxClearSelection);
        bulkClearBtn._bound = true;
    }
    var bulkTagsBtn = document.getElementById('trTx-bulk-tags');
    if (bulkTagsBtn && !bulkTagsBtn._bound) {
        bulkTagsBtn.addEventListener('click', trTxOpenTagPopup);
        bulkTagsBtn._bound = true;
    }
    var tagPopupCancel = document.getElementById('trTx-tag-popup-cancel');
    if (tagPopupCancel && !tagPopupCancel._bound) {
        tagPopupCancel.addEventListener('click', trTxCloseTagPopup);
        tagPopupCancel._bound = true;
    }
    var tagPopupApply = document.getElementById('trTx-tag-popup-apply');
    if (tagPopupApply && !tagPopupApply._bound) {
        tagPopupApply.addEventListener('click', trTxApplyBulkTags);
        tagPopupApply._bound = true;
    }
}

function trTxCloseAllMenus() {
    document.querySelectorAll('#trTx-list .action-menu.show').forEach(function(m) { m.classList.remove('show'); });
    trTxOpenMenuId = null;
}

// ============================================================================
// TOGGLE FLAG (dont_display only — ignore_for_avg_cost removed)
// ============================================================================

async function trTxToggleFlag(txnId, flagName) {
    var txn = trTransactions.find(function(t) { return t.id === txnId; });
    if (!txn) return;

    var newValue = !txn[flagName];
    var body = {};
    body[flagName] = newValue;

    var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + txnId, {
        method: 'PATCH',
        headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'}),
        body: JSON.stringify(body)
    });

    if (resp.ok) {
        txn[flagName] = newValue;
        showAlert(newValue ? 'Hidden from display' : 'Shown in display', 'success', 2000);
        trTxRender();
        trRenderPortfolio();
    } else {
        showAlert('Failed to update: HTTP ' + resp.status, 'error');
    }
}

// ============================================================================
// DELETE TRANSACTION
// ============================================================================

async function trTxDeleteTransaction(txnId) {
    var txn = trTransactions.find(function(t) { return t.id === txnId; });
    if (!txn) return;
    if (txn.is_locked) {
        showAlert('Transaction is locked. Unlock it first.', 'error');
        return;
    }

    if (!confirm('Delete this ' + txn.transaction_type + ' transaction for ' + txn.symbol + '?\n\nThis cannot be undone.')) return;

    showLoading(true, 'Deleting transaction...');
    var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + txnId, {
        method: 'DELETE',
        headers: wmsHeaders({'Prefer': 'return=minimal'})
    });

    showLoading(false);
    if (resp.ok) {
        trTransactions = trTransactions.filter(function(t) { return t.id !== txnId; });
        showAlert('Transaction deleted', 'success', 2000);
        trTxRender();
        trRenderPortfolio();
    } else {
        showAlert('Failed to delete: HTTP ' + resp.status, 'error');
    }
}

// ============================================================================
// MATCHING TRADES — FIFO / LIFO
// ============================================================================

// Helper: extract abbreviated contract detail from full F&O symbol
// e.g. "NATIONALUM26JANFUT" with short_symbol "NATIONALUM" -> "26JAN FUT"
// e.g. "NIFTY25FEB22000CE" with short_symbol "NIFTY" -> "25FEB 22000 CE"
// For equity (symbol == short_symbol), returns empty string.
function trTxFormatContract(fullSymbol, shortSymbol) {
    if (!fullSymbol || !shortSymbol) return '';
    if (fullSymbol === shortSymbol) return '';
    // Strip the underlying prefix
    var detail = fullSymbol;
    if (fullSymbol.toUpperCase().indexOf(shortSymbol.toUpperCase()) === 0) {
        detail = fullSymbol.substring(shortSymbol.length);
    }
    if (!detail) return '';
    // Insert space before FUT/CE/PE/CALL/PUT at end
    detail = detail.replace(/(FUT|CE|PE|CALL|PUT)$/i, ' $1');
    // Insert space before a numeric strike price (digits before the type suffix)
    detail = detail.replace(/(\d{2}[A-Z]{3})(\d+)/, '$1 $2');
    return detail.toUpperCase().trim();
}

function trTxRenderMatchingTrades(filtered) {
    var tbody = document.getElementById('trTx-matching-list');
    if (!tbody) return;

    // ----------------------------------------------------------------------
    // J.5.H migration (2026-04-11): delegate FIFO/LIFO matching to the shared
    // wmsCalcFifoCost / wmsCalcLifoCost engines. Behaviour changes accepted
    // by the user:
    //   Cat 1: corporate actions (BONUS / RIGHTS_ENTITLEMENT / RIGHTS_PAYMENT
    //          / CAPITAL_REDUCTION / HISTORICAL_PL) flow through the engine.
    //   Cat 2: NFO keys by full contract symbol (prefix-stripped), EQ keys
    //          by short_symbol — identical to the engine's _engineKey.
    //   Cat 3: LIFO re-attribution (closers matched against most-recent
    //          openers) is the engine's native behaviour.
    // Unmatched closers no longer exist as a row type — the engine turns
    // them into short-open lots, which render as "Short Open" rows.
    // ----------------------------------------------------------------------

    // Build txn-id lookup so we can recover displaySymbol / investor / broker
    // from engine output (gains carry buyTxnId/sellTxnId, lots carry txnId).
    var txnById = {};
    filtered.forEach(function(t) { if (t.id !== undefined) txnById[t.id] = t; });

    // Grouping key: EQ → short_symbol; NFO → full symbol (exchange stripped).
    // This mirrors _engineKey in wms-shared.js so the UI groups match the
    // engine's internal bucketing exactly.
    function _txGroupKey(t) {
        var secType = t.security_type || 'EQUITY';
        if (secType === 'NFO') {
            var nfoSym = t.symbol || t.short_symbol || '';
            return nfoSym.replace(/^[A-Z]+:/, '');
        }
        return t.short_symbol || t.symbol || '';
    }

    // Group txns (pass full slice — engine filters BUY/SELL/corporate itself)
    var groups = {};
    filtered.forEach(function(t) {
        var key = _txGroupKey(t);
        if (!key) return;
        if (!groups[key]) {
            groups[key] = {
                key: key,
                symbol: key,  // display: for EQ = ticker, for NFO = full contract
                companyName: t.company_name || '',
                securityType: t.security_type || 'EQUITY',
                txns: []
            };
        }
        if (!groups[key].companyName && t.company_name) groups[key].companyName = t.company_name;
        groups[key].txns.push(t);
    });

    // Build groupResults
    var groupResults = [];
    var colCount = 11;

    Object.keys(groups).sort().forEach(function(key) {
        var g = groups[key];

        // Sort chronologically, id as tie-breaker (matches engine's expectation)
        var sorted = g.txns.slice().sort(function(a, b) {
            var da = a.transaction_date || '', db = b.transaction_date || '';
            if (da !== db) return da < db ? -1 : 1;
            return (a.id || 0) - (b.id || 0);
        });

        var result = trTxMatchMethod === 'lifo' ? wmsCalcLifoCost(sorted) : wmsCalcFifoCost(sorted);

        // The engine may produce 0 or 1 holdings for this slice — find it.
        var holdingKeys = Object.keys(result.holdings || {});
        var holding = holdingKeys.length > 0 ? result.holdings[holdingKeys[0]] : null;
        var openLots = holding && holding.lots ? holding.lots : [];

        var matchedRows = [];

        // Realised matches → matched rows
        (result.gains || []).forEach(function(gain) {
            var rowIsShort = (gain.sellDate || '') < (gain.buyDate || '');
            // Opener metadata: for long matches = buy txn; for short matches = sell txn
            var openerTxn = rowIsShort
                ? (txnById[gain.sellTxnId] || null)
                : (txnById[gain.buyTxnId] || null);
            var closerTxn = rowIsShort
                ? (txnById[gain.buyTxnId] || null)
                : (txnById[gain.sellTxnId] || null);
            var displaySymbol = (openerTxn && openerTxn.symbol) || (closerTxn && closerTxn.symbol) || g.symbol;
            var invId = openerTxn ? openerTxn.investor_id : null;
            var brkId = openerTxn ? openerTxn.broker_id : null;

            matchedRows.push({
                type: 'matched', isShort: rowIsShort,
                displaySymbol: displaySymbol, investorId: invId, brokerId: brkId,
                qty: gain.qty,
                buyDate: gain.buyDate, buyAvg: gain.buyCostPerUnit, buyAmount: gain.buyCost,
                sellDate: gain.sellDate, sellAvg: gain.sellProceedsPerUnit, sellAmount: gain.sellProceeds,
                pnl: gain.gain
            });
        });

        // Surviving lots → open rows (long lot = Open; negative lot = Short Open)
        openLots.forEach(function(lot) {
            if (!lot.qty) return;
            var lotIsShort = lot.qty < 0;
            var absQty = Math.abs(lot.qty);
            var ppu = lot.costPerUnit || 0;
            var lotTxn = lot.txnId !== undefined ? txnById[lot.txnId] : null;
            var row = {
                type: 'open', isShort: lotIsShort,
                displaySymbol: (lotTxn && lotTxn.symbol) || g.symbol,
                investorId: lotTxn ? lotTxn.investor_id : null,
                brokerId: lotTxn ? lotTxn.broker_id : null,
                qty: absQty, pnl: 0
            };
            if (lotIsShort) {
                row.buyDate = null; row.buyAvg = 0; row.buyAmount = 0;
                row.sellDate = lot.date; row.sellAvg = ppu; row.sellAmount = absQty * ppu;
            } else {
                row.buyDate = lot.date; row.buyAvg = ppu; row.buyAmount = absQty * ppu;
                row.sellDate = null; row.sellAvg = 0; row.sellAmount = 0;
            }
            matchedRows.push(row);
        });

        if (matchedRows.length === 0) return;

        // Group isShort label: derived from first open lot direction; if no
        // open lots, fall back to first matched row.
        var groupIsShort = false;
        if (openLots.length > 0) {
            groupIsShort = openLots[0].qty < 0;
        } else if (matchedRows.length > 0) {
            groupIsShort = matchedRows[0].isShort;
        }

        // Sort by opening date
        matchedRows.sort(function(a, b) {
            var dateA = a.isShort ? (a.sellDate || '9999') : (a.buyDate || '9999');
            var dateB = b.isShort ? (b.sellDate || '9999') : (b.buyDate || '9999');
            return new Date(dateA) - new Date(dateB);
        });

        // Totals for matched (completed) trades only
        var totalQty = 0, totalBuyAmt = 0, totalSellAmt = 0, totalPnl = 0;
        matchedRows.forEach(function(r) {
            if (r.type === 'matched') {
                totalQty += r.qty; totalBuyAmt += r.buyAmount;
                totalSellAmt += r.sellAmount; totalPnl += r.pnl;
            }
        });

        groupResults.push({
            symbol: g.symbol, companyName: g.companyName, isShort: groupIsShort,
            rows: matchedRows, totalQty: totalQty,
            totalBuyAmt: totalBuyAmt, totalSellAmt: totalSellAmt, totalPnl: totalPnl
        });
    });

    if (groupResults.length === 0) {
        tbody.innerHTML = '<tr><td colspan="' + colCount + '" style="text-align:center;padding:40px;color:#9ca3af;">No matching trades found</td></tr>';
        return;
    }

    // Render groups — ALL start collapsed
    var html = '';
    var globalRowIdx = 0;

    groupResults.forEach(function(grp, gi) {
        var groupId = 'trTxMG-' + gi;
        var shortLabel = grp.isShort ? ' <span style="color:#dc2626;font-size:10px;">(Short)</span>' : '';

        // Totals display
        var totalPnlClass = grp.totalPnl >= 0 ? 'trTx-pnl-positive' : 'trTx-pnl-negative';
        var totalPnlHtml = grp.totalPnl < 0
            ? '<span class="' + totalPnlClass + '">(' + formatAmount(Math.abs(grp.totalPnl)) + ')</span>'
            : '<span class="' + totalPnlClass + '">' + formatAmount(grp.totalPnl) + '</span>';

        // Group header (starts collapsed)
        html += '<tr class="trTx-match-group-header collapsed" data-group-id="' + groupId + '">' +
            '<td colspan="3">' +
                '<span class="trTx-collapse-icon">▼</span> ' +
                grp.symbol + shortLabel +
                (grp.companyName ? ' — ' + grp.companyName : '') +
            '</td>' +
            '<td class="trTx-buy-start"></td>' +
            '<td></td>' +
            '<td class="text-right"><span class="trTx-group-total">' + (grp.totalBuyAmt > 0 ? formatAmount(grp.totalBuyAmt) : '') + '</span></td>' +
            '<td class="trTx-sell-start"></td>' +
            '<td></td>' +
            '<td class="text-right"><span class="trTx-group-total">' + (grp.totalSellAmt > 0 ? formatAmount(grp.totalSellAmt) : '') + '</span></td>' +
            '<td class="text-right"><span class="trTx-group-total">' + totalPnlHtml + '</span></td>' +
            '<td></td>' +
        '</tr>';

        // Detail rows (start hidden because collapsed)
        grp.rows.forEach(function(row) {
            var rowId = 'trTxMR-' + globalRowIdx;
            globalRowIdx++;

            var isOpen = row.type === 'open';
            var rowClass = 'trTx-match-detail-row collapsed-row';
            if (isOpen) rowClass += ' trTx-match-open';

            // Inv @ Broker
            var invBrk = trInvName(row.investorId);
            var brkCode = trBrkCode(row.brokerId);
            if (brkCode) invBrk += ' @ ' + brkCode;

            // Contract detail (abbreviated F&O name)
            var contract = trTxFormatContract(row.displaySymbol, grp.symbol);
            var contractHtml = contract ? '<span class="trTx-contract-detail">' + contract + '</span>' : '';

            // P&L
            var pnlHtml = '';
            if (isOpen) {
                pnlHtml = '<span style="color:#718096;">' + (row.isShort ? 'Short Open' : 'Open') + '</span>';
            } else {
                var pnlClass = row.pnl >= 0 ? 'trTx-pnl-positive' : 'trTx-pnl-negative';
                pnlHtml = row.pnl < 0
                    ? '<span class="' + pnlClass + '">(' + formatAmount(Math.abs(row.pnl)) + ')</span>'
                    : '<span class="' + pnlClass + '">' + formatAmount(row.pnl) + '</span>';
            }

            var buyDateHtml = row.buyDate ? formatDate(row.buyDate) : '-';
            var sellDateHtml = row.sellDate ? formatDate(row.sellDate) : '-';
            var hasBuy = row.buyAvg > 0 || row.buyAmount > 0;
            var hasSell = row.sellAvg > 0 || row.sellAmount > 0;

            html += '<tr class="' + rowClass + '" data-group-id="' + groupId + '" data-row-id="' + rowId + '">' +
                '<td>' + invBrk + '</td>' +
                '<td>' + contractHtml + '</td>' +
                '<td class="text-right">' + formatQuantity(row.qty) + '</td>' +
                '<td class="trTx-buy-start">' + buyDateHtml + '</td>' +
                '<td class="text-right">' + (hasBuy ? formatPrice(row.buyAvg, false) : '-') + '</td>' +
                '<td class="text-right">' + (hasBuy ? formatAmount(row.buyAmount) : '-') + '</td>' +
                '<td class="trTx-sell-start">' + sellDateHtml + '</td>' +
                '<td class="text-right">' + (hasSell ? formatPrice(row.sellAvg, false) : '-') + '</td>' +
                '<td class="text-right">' + (hasSell ? formatAmount(row.sellAmount) : '-') + '</td>' +
                '<td class="text-right">' + pnlHtml + '</td>' +
                '<td><button class="trTx-match-eye-btn" data-row-id="' + rowId + '" title="Hide row">👁</button></td>' +
            '</tr>';
        });
    });

    tbody.innerHTML = html;

    // Collapse/expand handlers
    tbody.querySelectorAll('.trTx-match-group-header').forEach(function(header) {
        header.addEventListener('click', function() {
            var gid = header.dataset.groupId;
            var isCollapsed = header.classList.toggle('collapsed');
            tbody.querySelectorAll('.trTx-match-detail-row[data-group-id="' + gid + '"]').forEach(function(row) {
                if (isCollapsed) {
                    row.classList.add('collapsed-row');
                } else {
                    // When expanding, also clear any view-hidden state
                    row.classList.remove('collapsed-row');
                    row.classList.remove('trTx-view-hidden');
                    var rid = row.dataset.rowId;
                    if (rid) delete trTxMatchHiddenRows[rid];
                }
            });
        });
    });

    // Eye icon handlers — hide row from current view only
    tbody.querySelectorAll('.trTx-match-eye-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var rid = btn.dataset.rowId;
            var row = tbody.querySelector('tr[data-row-id="' + rid + '"]');
            if (row) {
                row.classList.add('trTx-view-hidden');
                trTxMatchHiddenRows[rid] = true;
            }
        });
    });
}

// ============================================================================
// WINDOW EXPORTS
// ============================================================================

window.trTxInit = trTxInit;
