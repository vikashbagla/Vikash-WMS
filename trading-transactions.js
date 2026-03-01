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
var trTxSelectedBrokerIds = [];
var trTxSelectedTagNames = [];
var trTxTagLogic = 'OR';
var trTxInitialized = false;
var trTxOpenMenuId = null;
var trTxInvPillFilter = null;
var trTxBrkPillFilter = null;
var trTxTagPillFilter = null;

// New state for options bar
var trTxViewMode = 'list';        // 'list' or 'matching'
var trTxMatchMethod = 'lifo';     // 'fifo' or 'lifo'
var trTxShowAll = false;
var trTxFnoOnly = false;

// Set of row indices hidden in matching view (view-only, not persisted)
var trTxMatchHiddenRows = {};

// ============================================================================
// INITIALIZATION
// ============================================================================

function trTxInit() {
    if (!trTxInitialized) {
        trTxSetupFilters();
        trTxSetupOptionsBar();
        trTxInitialized = true;
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
    var invInput = document.getElementById('trTx-investor-search');
    var invDd = document.getElementById('trTx-investor-dropdown');
    var invTags = document.getElementById('trTx-selected-investors');
    if (invInput && invDd) {
        var invItems = trInvestors.map(function(inv) { return {id: String(inv.id), label: inv.short_name || inv.name}; });
        trTxInvPillFilter = wmsPillFilter(invInput, invDd, invTags, {
            items: invItems,
            selectedIds: trTxSelectedInvestorIds,
            onChange: trTxRender,
            pillClass: 'wms-pill'
        });
    }
    // Broker pills
    var brkInput = document.getElementById('trTx-broker-search');
    var brkDd = document.getElementById('trTx-broker-dropdown');
    var brkTags = document.getElementById('trTx-selected-brokers');
    if (brkInput && brkDd) {
        var brkItems = trBrokers.map(function(b) { return {id: String(b.id), label: b.broker_code || b.name}; });
        trTxBrkPillFilter = wmsPillFilter(brkInput, brkDd, brkTags, {
            items: brkItems,
            selectedIds: trTxSelectedBrokerIds,
            onChange: trTxRender,
            pillClass: 'wms-pill'
        });
    }
    // Tag pills — collect all unique tags from transactions
    var allTags = {};
    trTransactions.forEach(function(t) {
        if (t.tags) t.tags.forEach(function(tag) { if (tag && tag !== 'blank') allTags[tag] = true; });
    });
    var tagInput = document.getElementById('trTx-tag-search');
    var tagDd = document.getElementById('trTx-tag-dropdown');
    var tagTags = document.getElementById('trTx-selected-tags');
    if (tagInput && tagDd) {
        var tagItems = Object.keys(allTags).sort().map(function(tag) { return {id: tag, label: tag}; });
        trTxTagPillFilter = wmsPillFilter(tagInput, tagDd, tagTags, {
            items: tagItems,
            selectedIds: trTxSelectedTagNames,
            onChange: trTxRender,
            pillClass: 'wms-pill'
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

    // Pill filter clear buttons — delegate to wmsPillFilter.clearAll()
    var clearInv = document.getElementById('trTx-clear-investors');
    if (clearInv) {
        clearInv.addEventListener('click', function() {
            if (trTxInvPillFilter) trTxInvPillFilter.clearAll();
        });
    }
    var clearBrk = document.getElementById('trTx-clear-brokers');
    if (clearBrk) {
        clearBrk.addEventListener('click', function() {
            if (trTxBrkPillFilter) trTxBrkPillFilter.clearAll();
        });
    }
    var clearTags = document.getElementById('trTx-clear-tags');
    if (clearTags) {
        clearTags.addEventListener('click', function() {
            if (trTxTagPillFilter) trTxTagPillFilter.clearAll();
        });
    }

    // Tag logic radio
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
}

// ============================================================================
// SELECTED TAGS (filter chips)
// ============================================================================

function trTxRenderSelectedTags(type) {
    // Delegate to wmsPillFilter's renderSelectedTags method
    if (type === 'investor' && trTxInvPillFilter) {
        trTxInvPillFilter.renderSelectedTags();
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

    // Filter: symbol search
    if (trTxSymbolSearch) {
        filtered = filtered.filter(function(t) {
            var sym = (t.short_symbol || t.symbol || '').toLowerCase();
            var co = (t.company_name || '').toLowerCase();
            return sym.indexOf(trTxSymbolSearch) >= 0 || co.indexOf(trTxSymbolSearch) >= 0;
        });
    }

    // Filter: investors (use String() for safe comparison)
    if (trTxSelectedInvestorIds.length > 0) {
        filtered = filtered.filter(function(t) {
            return t.investor_id && trTxSelectedInvestorIds.indexOf(String(t.investor_id)) >= 0;
        });
    }

    // Filter: brokers (use String() for safe comparison)
    if (trTxSelectedBrokerIds.length > 0) {
        filtered = filtered.filter(function(t) {
            return t.broker_id && trTxSelectedBrokerIds.indexOf(String(t.broker_id)) >= 0;
        });
    }

    // Filter: tags
    if (trTxSelectedTagNames.length > 0) {
        filtered = filtered.filter(function(t) {
            var txnTags = (t.tags || []).filter(function(tg) { return tg && tg !== 'blank'; });
            if (trTxTagLogic === 'AND') {
                return trTxSelectedTagNames.every(function(st) { return txnTags.indexOf(st) >= 0; });
            } else {
                return trTxSelectedTagNames.some(function(st) { return txnTags.indexOf(st) >= 0; });
            }
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
    // Sort
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

    var tbody = document.getElementById('trTx-list');
    if (!tbody) return;

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:#9ca3af;">No transactions match the current filters</td></tr>';
        trTxUpdateSortIndicators();
        return;
    }

    tbody.innerHTML = filtered.map(function(txn) {
        var isSell = txn.transaction_type === 'SELL';
        var isIncome = INCOME_TYPES.indexOf(txn.transaction_type) >= 0;
        var qty = Math.abs(txn.quantity || 0);
        var netAmt = txn.net_amount || 0;
        var acqCost = qty !== 0 ? Math.abs(netAmt / qty) : 0;

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
        var tags = (txn.tags || []).filter(function(tg) { return tg && tg !== 'blank'; });
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

        return '<tr' + rowClass + ' data-txn-id="' + txn.id + '">' +
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
            '<td class="text-right">' + formatPrice(acqCost, false) + '</td>' +
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

    // Row click opens edit modal (except action cell), but not for locked
    document.querySelectorAll('#trTx-list tr[data-txn-id]').forEach(function(row) {
        row.addEventListener('click', function(e) {
            if (e.target.closest('.action-cell')) return;
            var txnId = row.dataset.txnId;
            var txn = trTransactions.find(function(t) { return t.id === txnId; });
            if (txn && txn.is_locked) {
                showAlert('Transaction is locked. Unlock it first to edit.', 'error');
                return;
            }
            trOpenEditModal(txnId);
        });
    });
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
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        },
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

    var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + txnId, {
        method: 'DELETE',
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
            'Prefer': 'return=minimal'
        }
    });

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

    // Exclude income types — only BUY and SELL
    var trades = filtered.filter(function(t) {
        return t.transaction_type === 'BUY' || t.transaction_type === 'SELL';
    });

    // Group by short_symbol ONLY (not investor)
    var groups = {};
    trades.forEach(function(t) {
        var key = t.short_symbol || t.symbol || '';
        if (!groups[key]) {
            groups[key] = {
                symbol: t.short_symbol || t.symbol || '',
                companyName: t.company_name || '',
                buys: [],
                sells: []
            };
        }
        var entry = {
            date: t.transaction_date,
            qty: Math.abs(t.quantity || 0),
            netAmount: Math.abs(t.net_amount || 0),
            remaining: Math.abs(t.quantity || 0),
            displaySymbol: t.symbol || t.short_symbol || '',
            investorId: t.investor_id,
            brokerId: t.broker_id,
            txn: t
        };
        if (t.transaction_type === 'BUY') {
            groups[key].buys.push(entry);
        } else {
            groups[key].sells.push(entry);
        }
    });

    // Build groupResults
    var groupResults = [];
    var colCount = 11;

    Object.keys(groups).sort().forEach(function(key) {
        var g = groups[key];

        g.buys.sort(function(a, b) { return new Date(a.date) - new Date(b.date); });
        g.sells.sort(function(a, b) { return new Date(a.date) - new Date(b.date); });

        var firstBuyDate = g.buys.length > 0 ? new Date(g.buys[0].date) : new Date('9999-12-31');
        var firstSellDate = g.sells.length > 0 ? new Date(g.sells[0].date) : new Date('9999-12-31');
        var isShort = firstSellDate < firstBuyDate;

        var buys = g.buys.map(function(b) {
            return { date: b.date, qty: b.qty, netAmount: b.netAmount, remaining: b.qty, displaySymbol: b.displaySymbol, investorId: b.investorId, brokerId: b.brokerId, txn: b.txn };
        });
        var sells = g.sells.map(function(s) {
            return { date: s.date, qty: s.qty, netAmount: s.netAmount, remaining: s.qty, displaySymbol: s.displaySymbol, investorId: s.investorId, brokerId: s.brokerId, txn: s.txn };
        });

        var openers = isShort ? sells : buys;
        var closers = isShort ? buys : sells;
        var openerOrder = trTxMatchMethod === 'lifo' ? openers.slice().reverse() : openers.slice();

        var matchedRows = [];

        closers.forEach(function(closer) {
            var closerRemaining = closer.remaining;
            var closerPpu = closer.qty > 0 ? closer.netAmount / closer.qty : 0;

            for (var oi = 0; oi < openerOrder.length && closerRemaining > 0; oi++) {
                var opener = openerOrder[oi];
                if (opener.remaining <= 0) continue;
                var matchQty = Math.min(closerRemaining, opener.remaining);
                var openerPpu = opener.qty > 0 ? opener.netAmount / opener.qty : 0;

                var buyDate, buyAvg, buyAmount, sellDate, sellAvg, sellAmount, displaySymbol, invId, brkId;
                if (isShort) {
                    sellDate = opener.date; sellAvg = openerPpu; sellAmount = matchQty * openerPpu;
                    buyDate = closer.date; buyAvg = closerPpu; buyAmount = matchQty * closerPpu;
                    displaySymbol = opener.displaySymbol || closer.displaySymbol;
                    invId = opener.investorId; brkId = opener.brokerId;
                } else {
                    buyDate = opener.date; buyAvg = openerPpu; buyAmount = matchQty * openerPpu;
                    sellDate = closer.date; sellAvg = closerPpu; sellAmount = matchQty * closerPpu;
                    displaySymbol = opener.displaySymbol || closer.displaySymbol;
                    invId = opener.investorId; brkId = opener.brokerId;
                }

                matchedRows.push({
                    type: 'matched', isShort: isShort,
                    displaySymbol: displaySymbol, investorId: invId, brokerId: brkId,
                    qty: matchQty, buyDate: buyDate, buyAvg: buyAvg, buyAmount: buyAmount,
                    sellDate: sellDate, sellAvg: sellAvg, sellAmount: sellAmount,
                    pnl: sellAmount - buyAmount
                });
                opener.remaining -= matchQty;
                closerRemaining -= matchQty;
            }
            closer.remaining = closerRemaining;
        });

        // Open positions
        openerOrder.forEach(function(opener) {
            if (opener.remaining <= 0) return;
            var ppu = opener.qty > 0 ? opener.netAmount / opener.qty : 0;
            var row = {
                type: 'open', isShort: isShort,
                displaySymbol: opener.displaySymbol, investorId: opener.investorId, brokerId: opener.brokerId,
                qty: opener.remaining, pnl: 0
            };
            if (isShort) {
                row.buyDate = null; row.buyAvg = 0; row.buyAmount = 0;
                row.sellDate = opener.date; row.sellAvg = ppu; row.sellAmount = opener.remaining * ppu;
            } else {
                row.buyDate = opener.date; row.buyAvg = ppu; row.buyAmount = opener.remaining * ppu;
                row.sellDate = null; row.sellAvg = 0; row.sellAmount = 0;
            }
            matchedRows.push(row);
        });

        // Unmatched closers
        closers.forEach(function(closer) {
            if (closer.remaining <= 0) return;
            var ppu = closer.qty > 0 ? closer.netAmount / closer.qty : 0;
            var row = {
                type: 'unmatched-closer', isShort: isShort,
                displaySymbol: closer.displaySymbol, investorId: closer.investorId, brokerId: closer.brokerId,
                qty: closer.remaining
            };
            if (isShort) {
                row.buyDate = closer.date; row.buyAvg = ppu; row.buyAmount = closer.remaining * ppu;
                row.sellDate = null; row.sellAvg = 0; row.sellAmount = 0;
                row.pnl = -(closer.remaining * ppu);
            } else {
                row.buyDate = null; row.buyAvg = 0; row.buyAmount = 0;
                row.sellDate = closer.date; row.sellAvg = ppu; row.sellAmount = closer.remaining * ppu;
                row.pnl = closer.remaining * ppu;
            }
            matchedRows.push(row);
        });

        if (matchedRows.length === 0) return;

        // Sort by opening date
        matchedRows.sort(function(a, b) {
            var dateA = isShort ? (a.sellDate || '9999') : (a.buyDate || '9999');
            var dateB = isShort ? (b.sellDate || '9999') : (b.buyDate || '9999');
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
            symbol: g.symbol, companyName: g.companyName, isShort: isShort,
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
            var isUnmatched = row.type === 'unmatched-closer';
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
            } else if (isUnmatched) {
                pnlHtml = '<span style="color:#718096;">Unmatched</span>';
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
