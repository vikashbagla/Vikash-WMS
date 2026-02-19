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

// New state for options bar
var trTxViewMode = 'list';        // 'list' or 'matching'
var trTxMatchMethod = 'fifo';     // 'fifo' or 'lifo'
var trTxShowAll = false;
var trTxFnoOnly = false;

// ============================================================================
// INITIALIZATION
// ============================================================================

function trTxInit() {
    if (!trTxInitialized) {
        trTxInitPills();
        trTxSetupFilters();
        trTxSetupOptionsBar();
        trTxInitialized = true;
    }
    trTxRender();
}

// ============================================================================
// FILTER PILLS
// ============================================================================

function trTxInitPills() {
    // Investor pills
    var invDd = document.getElementById('trTx-investor-dropdown');
    if (invDd) {
        invDd.innerHTML = trInvestors.map(function(inv) {
            var label = inv.short_name || inv.name;
            return '<span class="tr-pill" data-txtype="investor" data-id="' + inv.id + '">' + label + '</span>';
        }).join('');
    }
    // Broker pills
    var brkDd = document.getElementById('trTx-broker-dropdown');
    if (brkDd) {
        brkDd.innerHTML = trBrokers.map(function(b) {
            var label = b.broker_code || b.name;
            return '<span class="tr-pill" data-txtype="broker" data-id="' + b.id + '">' + label + '</span>';
        }).join('');
    }
    // Tag pills — collect all unique tags from transactions
    var allTags = {};
    trTransactions.forEach(function(t) {
        if (t.tags) t.tags.forEach(function(tag) { if (tag && tag !== 'blank') allTags[tag] = true; });
    });
    var tagDd = document.getElementById('trTx-tag-dropdown');
    if (tagDd) {
        tagDd.innerHTML = Object.keys(allTags).sort().map(function(tag) {
            return '<span class="tr-pill" data-txtype="tag" data-id="' + tag + '">' + tag + '</span>';
        }).join('');
    }
    // Attach pill click handlers
    trTxAttachPillListeners();
}

function trTxAttachPillListeners() {
    document.querySelectorAll('#tr-transactions-container .tr-pill-dropdown .tr-pill').forEach(function(pill) {
        pill.addEventListener('click', function(e) {
            e.stopPropagation();
            var type = pill.dataset.txtype;
            var id = pill.dataset.id;
            var arr;
            if (type === 'investor') arr = trTxSelectedInvestorIds;
            else if (type === 'broker') arr = trTxSelectedBrokerIds;
            else arr = trTxSelectedTagNames;

            var idx = arr.indexOf(id);
            if (idx >= 0) arr.splice(idx, 1);
            else arr.push(id);

            pill.classList.toggle('on', arr.indexOf(id) >= 0);
            trTxRenderSelectedTags(type);
            trTxRender();
        });
    });
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

    // Pill dropdown show/filter
    ['investor', 'broker', 'tag'].forEach(function(type) {
        var input = document.getElementById('trTx-' + type + '-search');
        var dd = document.getElementById('trTx-' + type + '-dropdown');
        if (!input || !dd) return;
        input.addEventListener('click', function() { dd.classList.add('show'); });
        input.addEventListener('input', function() {
            dd.classList.add('show');
            var query = input.value.toLowerCase();
            dd.querySelectorAll('.tr-pill').forEach(function(pill) {
                pill.style.display = pill.textContent.toLowerCase().indexOf(query) >= 0 ? '' : 'none';
            });
        });
    });

    // Close dropdowns on outside click (scoped to transactions container)
    document.addEventListener('click', function(e) {
        if (!e.target.closest('#tr-transactions-container .filter-search-container')) {
            document.querySelectorAll('#tr-transactions-container .tr-pill-dropdown').forEach(function(dd) {
                dd.classList.remove('show');
            });
        }
        // Close action menus on outside click
        if (trTxOpenMenuId && !e.target.closest('.action-cell')) {
            trTxCloseAllMenus();
        }
    });

    // Clear buttons
    document.getElementById('trTx-clear-investors').addEventListener('click', function() {
        trTxSelectedInvestorIds = [];
        trTxSyncPillStates('investor');
        trTxRenderSelectedTags('investor');
        trTxRender();
    });
    document.getElementById('trTx-clear-brokers').addEventListener('click', function() {
        trTxSelectedBrokerIds = [];
        trTxSyncPillStates('broker');
        trTxRenderSelectedTags('broker');
        trTxRender();
    });
    document.getElementById('trTx-clear-tags').addEventListener('click', function() {
        trTxSelectedTagNames = [];
        trTxSyncPillStates('tag');
        trTxRenderSelectedTags('tag');
        trTxRender();
    });

    // Tag logic radio
    document.querySelectorAll('input[name="trTx-tag-logic"]').forEach(function(r) {
        r.addEventListener('change', function() {
            trTxTagLogic = r.value;
            trTxRender();
        });
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
    var arr, container, labelFn;
    if (type === 'investor') {
        arr = trTxSelectedInvestorIds;
        container = document.getElementById('trTx-selected-investors');
        labelFn = function(id) {
            var inv = trInvestors.find(function(i) { return String(i.id) === String(id); });
            return inv ? (inv.short_name || inv.name) : id;
        };
    } else if (type === 'broker') {
        arr = trTxSelectedBrokerIds;
        container = document.getElementById('trTx-selected-brokers');
        labelFn = function(id) {
            var b = trBrokers.find(function(i) { return String(i.id) === String(id); });
            return b ? (b.broker_code || b.name) : id;
        };
    } else {
        arr = trTxSelectedTagNames;
        container = document.getElementById('trTx-selected-tags');
        labelFn = function(id) { return id; };
    }
    if (!container) return;
    container.innerHTML = arr.map(function(id) {
        return '<span class="filter-tag-item">' + labelFn(id) +
            ' <span class="filter-tag-remove" data-txtype="' + type + '" data-id="' + id + '">×</span></span>';
    }).join('');
    container.querySelectorAll('.filter-tag-remove').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var t = btn.dataset.txtype;
            var rid = btn.dataset.id;
            var a;
            if (t === 'investor') a = trTxSelectedInvestorIds;
            else if (t === 'broker') a = trTxSelectedBrokerIds;
            else a = trTxSelectedTagNames;
            var ix = a.indexOf(rid);
            if (ix >= 0) a.splice(ix, 1);
            trTxSyncPillStates(t);
            trTxRenderSelectedTags(t);
            trTxRender();
        });
    });
}

function trTxSyncPillStates(type) {
    var selector = '#trTx-' + type + '-dropdown .tr-pill';
    document.querySelectorAll(selector).forEach(function(pill) {
        var id = pill.dataset.id;
        var arr;
        if (type === 'investor') arr = trTxSelectedInvestorIds;
        else if (type === 'broker') arr = trTxSelectedBrokerIds;
        else arr = trTxSelectedTagNames;
        pill.classList.toggle('on', arr.indexOf(id) >= 0);
    });
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

        // Investor @ Broker
        var invBrk = trInvName(txn.investor_id);
        var brkCode = trBrkCode(txn.broker_id);
        if (brkCode) invBrk += ' @ ' + brkCode;

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
        var hideIcon = txn.dont_display ? '👁' : '🙈';
        var hideTitle = txn.dont_display ? 'Show in Display' : 'Hide from Display';

        return '<tr' + rowClass + ' data-txn-id="' + txn.id + '">' +
            '<td>' + formatDate(txn.transaction_date) + '</td>' +
            '<td>' + invBrk + '</td>' +
            '<td>' + (txn.short_symbol || txn.symbol || '') +
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
                '<button class="btn-action trTx-action-btn" data-txn-id="' + txn.id + '" title="Actions">⚙️</button>' +
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

function trTxRenderMatchingTrades(filtered) {
    var tbody = document.getElementById('trTx-matching-list');
    if (!tbody) return;

    // Exclude income types — only BUY and SELL
    var trades = filtered.filter(function(t) {
        return t.transaction_type === 'BUY' || t.transaction_type === 'SELL';
    });

    // Group by (investor_id, short_symbol)
    var groups = {};
    trades.forEach(function(t) {
        var key = String(t.investor_id) + '||' + (t.short_symbol || t.symbol || '');
        if (!groups[key]) {
            groups[key] = {
                investorId: t.investor_id,
                brokerId: t.broker_id,
                symbol: t.short_symbol || t.symbol || '',
                companyName: t.company_name || '',
                buys: [],
                sells: []
            };
        }
        if (t.transaction_type === 'BUY') {
            groups[key].buys.push({
                date: t.transaction_date,
                qty: Math.abs(t.quantity || 0),
                netAmount: Math.abs(t.net_amount || 0),
                remaining: Math.abs(t.quantity || 0),
                remainingAmount: Math.abs(t.net_amount || 0),
                txn: t
            });
        } else {
            groups[key].sells.push({
                date: t.transaction_date,
                qty: Math.abs(t.quantity || 0),
                netAmount: Math.abs(t.net_amount || 0),
                remaining: Math.abs(t.quantity || 0),
                remainingAmount: Math.abs(t.net_amount || 0),
                txn: t
            });
        }
    });

    var allRows = [];

    Object.keys(groups).sort().forEach(function(key) {
        var g = groups[key];

        // Sort buys and sells by date ascending
        g.buys.sort(function(a, b) { return new Date(a.date) - new Date(b.date); });
        g.sells.sort(function(a, b) { return new Date(a.date) - new Date(b.date); });

        // Determine direction: long (buy first) or short (sell first)
        var firstBuyDate = g.buys.length > 0 ? new Date(g.buys[0].date) : new Date('9999-12-31');
        var firstSellDate = g.sells.length > 0 ? new Date(g.sells[0].date) : new Date('9999-12-31');
        var isShort = firstSellDate < firstBuyDate;

        // Clone remaining values for matching
        var buys = g.buys.map(function(b) {
            return { date: b.date, qty: b.qty, netAmount: b.netAmount, remaining: b.qty, txn: b.txn };
        });
        var sells = g.sells.map(function(s) {
            return { date: s.date, qty: s.qty, netAmount: s.netAmount, remaining: s.qty, txn: s.txn };
        });

        // openers = the side that opens the position, closers = the side that closes it
        // Long: buys open, sells close. Short: sells open, buys close.
        var openers, closers;
        if (isShort) {
            openers = sells;  // sells open the short position
            closers = buys;   // buys close (cover) the short position
        } else {
            openers = buys;   // buys open the long position
            closers = sells;  // sells close the long position
        }

        // For FIFO/LIFO, determine order of openers to consume
        var openerOrder;
        if (trTxMatchMethod === 'lifo') {
            openerOrder = openers.slice().reverse();
        } else {
            openerOrder = openers.slice();
        }

        var matchedRows = [];

        // For each closer, allocate against openers
        closers.forEach(function(closer) {
            var closerRemaining = closer.remaining;
            var closerPricePerUnit = closer.qty > 0 ? closer.netAmount / closer.qty : 0;

            for (var oi = 0; oi < openerOrder.length && closerRemaining > 0; oi++) {
                var opener = openerOrder[oi];
                if (opener.remaining <= 0) continue;

                var matchQty = Math.min(closerRemaining, opener.remaining);
                var openerPricePerUnit = opener.qty > 0 ? opener.netAmount / opener.qty : 0;

                // Calculate buy/sell amounts based on direction
                var buyAmount, sellAmount, buyAvg, sellAvg, sellDate;
                if (isShort) {
                    // Short: opener = sell (opening short), closer = buy (covering)
                    sellAvg = openerPricePerUnit;
                    sellAmount = matchQty * openerPricePerUnit;
                    buyAvg = closerPricePerUnit;
                    buyAmount = matchQty * closerPricePerUnit;
                    sellDate = opener.date;  // show the sell (opening) date
                } else {
                    // Long: opener = buy, closer = sell
                    buyAvg = openerPricePerUnit;
                    buyAmount = matchQty * openerPricePerUnit;
                    sellAvg = closerPricePerUnit;
                    sellAmount = matchQty * closerPricePerUnit;
                    sellDate = closer.date;  // show the sell (closing) date
                }

                var pnl = sellAmount - buyAmount;

                matchedRows.push({
                    type: 'matched',
                    isShort: isShort,
                    symbol: g.symbol,
                    companyName: g.companyName,
                    investorId: g.investorId,
                    brokerId: g.brokerId,
                    sellDate: sellDate,
                    closeDate: closer.date,
                    qty: matchQty,
                    buyAvg: buyAvg,
                    buyAmount: buyAmount,
                    sellAvg: sellAvg,
                    sellAmount: sellAmount,
                    pnl: pnl
                });

                opener.remaining -= matchQty;
                closerRemaining -= matchQty;
            }
            closer.remaining = closerRemaining;
        });

        // Open positions — openers with remaining qty (unmatched)
        openerOrder.forEach(function(opener) {
            if (opener.remaining > 0) {
                var openerPricePerUnit = opener.qty > 0 ? opener.netAmount / opener.qty : 0;
                if (isShort) {
                    // Short open position: unmatched sell (still short)
                    matchedRows.push({
                        type: 'open',
                        isShort: true,
                        symbol: g.symbol,
                        companyName: g.companyName,
                        investorId: g.investorId,
                        brokerId: g.brokerId,
                        sellDate: opener.date,
                        qty: opener.remaining,
                        buyAvg: 0,
                        buyAmount: 0,
                        sellAvg: openerPricePerUnit,
                        sellAmount: opener.remaining * openerPricePerUnit,
                        pnl: 0,
                        openDate: opener.date
                    });
                } else {
                    // Long open position: unmatched buy (still holding)
                    matchedRows.push({
                        type: 'open',
                        isShort: false,
                        symbol: g.symbol,
                        companyName: g.companyName,
                        investorId: g.investorId,
                        brokerId: g.brokerId,
                        sellDate: '-',
                        qty: opener.remaining,
                        buyAvg: openerPricePerUnit,
                        buyAmount: opener.remaining * openerPricePerUnit,
                        sellAvg: 0,
                        sellAmount: 0,
                        pnl: 0,
                        openDate: opener.date
                    });
                }
            }
        });

        // Unmatched closers (rare edge case)
        closers.forEach(function(closer) {
            if (closer.remaining > 0) {
                var closerPricePerUnit = closer.qty > 0 ? closer.netAmount / closer.qty : 0;
                if (isShort) {
                    // Short: unmatched buy (bought to cover but no matching sell)
                    matchedRows.push({
                        type: 'unmatched-closer',
                        isShort: true,
                        symbol: g.symbol,
                        companyName: g.companyName,
                        investorId: g.investorId,
                        brokerId: g.brokerId,
                        sellDate: '-',
                        qty: closer.remaining,
                        buyAvg: closerPricePerUnit,
                        buyAmount: closer.remaining * closerPricePerUnit,
                        sellAvg: 0,
                        sellAmount: 0,
                        pnl: -(closer.remaining * closerPricePerUnit)
                    });
                } else {
                    // Long: unmatched sell (sold but no matching buy — short sale from long group)
                    matchedRows.push({
                        type: 'unmatched-closer',
                        isShort: false,
                        symbol: g.symbol,
                        companyName: g.companyName,
                        investorId: g.investorId,
                        brokerId: g.brokerId,
                        sellDate: closer.date,
                        qty: closer.remaining,
                        buyAvg: 0,
                        buyAmount: 0,
                        sellAvg: closerPricePerUnit,
                        sellAmount: closer.remaining * closerPricePerUnit,
                        pnl: closer.remaining * closerPricePerUnit
                    });
                }
            }
        });

        if (matchedRows.length > 0) {
            var dirLabel = isShort ? ' (Short)' : '';
            allRows.push({ type: 'group-header', symbol: g.symbol, companyName: g.companyName, investorId: g.investorId, brokerId: g.brokerId, isShort: isShort });
            allRows = allRows.concat(matchedRows);
        }
    });

    if (allRows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:#9ca3af;">No matching trades found</td></tr>';
        return;
    }

    tbody.innerHTML = allRows.map(function(row) {
        if (row.type === 'group-header') {
            var invBrk = trInvName(row.investorId);
            var brkCode = trBrkCode(row.brokerId);
            if (brkCode) invBrk += ' @ ' + brkCode;
            var shortLabel = row.isShort ? ' <span style="color:#dc2626;font-size:10px;">(Short)</span>' : '';
            return '<tr class="trTx-match-group-header">' +
                '<td colspan="9">' + row.symbol + shortLabel +
                    (row.companyName ? ' — ' + row.companyName : '') +
                    ' &nbsp;|&nbsp; ' + invBrk +
                '</td></tr>';
        }

        var isOpen = row.type === 'open';
        var isUnmatched = row.type === 'unmatched-closer';
        var rowClass = isOpen ? ' class="trTx-match-open"' : '';

        // P&L display
        var pnlHtml = '';
        if (isOpen) {
            var openLabel = row.isShort ? 'Short Open' : 'Open';
            pnlHtml = '<span style="color:#718096;">' + openLabel + '</span>';
        } else if (isUnmatched) {
            pnlHtml = '<span style="color:#718096;">Unmatched</span>';
        } else {
            var pnlClass = row.pnl >= 0 ? 'trTx-pnl-positive' : 'trTx-pnl-negative';
            if (row.pnl < 0) {
                pnlHtml = '<span class="' + pnlClass + '">(' + formatAmount(Math.abs(row.pnl)) + ')</span>';
            } else {
                pnlHtml = '<span class="' + pnlClass + '">' + formatAmount(row.pnl) + '</span>';
            }
        }

        // Date display — for open positions, show the opening trade date
        var dateHtml;
        if (isOpen) {
            dateHtml = formatDate(row.openDate || '-');
        } else if (row.sellDate && row.sellDate !== '-') {
            dateHtml = formatDate(row.sellDate);
        } else {
            dateHtml = '-';
        }

        // Buy/Sell columns — show '-' when not applicable
        var hasBuy = row.buyAvg > 0 || row.buyAmount > 0;
        var hasSell = row.sellAvg > 0 || row.sellAmount > 0;

        return '<tr' + rowClass + '>' +
            '<td>' + dateHtml + '</td>' +
            '<td></td>' +  // investor@broker shown in group header
            '<td></td>' +  // symbol shown in group header
            '<td class="text-right">' + formatQuantity(row.qty) + '</td>' +
            '<td class="text-right">' + (hasBuy ? formatPrice(row.buyAvg, false) : '-') + '</td>' +
            '<td class="text-right">' + (hasBuy ? formatAmount(row.buyAmount) : '-') + '</td>' +
            '<td class="text-right">' + (hasSell ? formatPrice(row.sellAvg, false) : '-') + '</td>' +
            '<td class="text-right">' + (hasSell ? formatAmount(row.sellAmount) : '-') + '</td>' +
            '<td class="text-right">' + pnlHtml + '</td>' +
        '</tr>';
    }).join('');
}

// ============================================================================
// WINDOW EXPORTS
// ============================================================================

window.trTxInit = trTxInit;
