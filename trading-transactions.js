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

// ============================================================================
// INITIALIZATION
// ============================================================================

function trTxInit() {
    if (!trTxInitialized) {
        trTxInitPills();
        trTxSetupFilters();
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
    // Tag pills
    var allTags = {};
    trTransactions.forEach(function(t) {
        if (t.tags) t.tags.forEach(function(tag) { if (tag !== 'blank') allTags[tag] = true; });
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
// SELECTED TAGS (filter chips)
// ============================================================================

function trTxRenderSelectedTags(type) {
    var arr, container, labelFn;
    if (type === 'investor') {
        arr = trTxSelectedInvestorIds;
        container = document.getElementById('trTx-selected-investors');
        labelFn = function(id) {
            var inv = trInvestors.find(function(i) { return i.id === id; });
            return inv ? (inv.short_name || inv.name) : id;
        };
    } else if (type === 'broker') {
        arr = trTxSelectedBrokerIds;
        container = document.getElementById('trTx-selected-brokers');
        labelFn = function(id) {
            var b = trBrokers.find(function(i) { return i.id === id; });
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
// RENDER
// ============================================================================

function trTxRender() {
    var filtered = trTransactions.slice();

    // Filter: symbol search
    if (trTxSymbolSearch) {
        filtered = filtered.filter(function(t) {
            var sym = (t.short_symbol || t.symbol || '').toLowerCase();
            var co = (t.company_name || '').toLowerCase();
            return sym.indexOf(trTxSymbolSearch) >= 0 || co.indexOf(trTxSymbolSearch) >= 0;
        });
    }

    // Filter: investors
    if (trTxSelectedInvestorIds.length > 0) {
        filtered = filtered.filter(function(t) {
            return trTxSelectedInvestorIds.indexOf(t.investor_id) >= 0;
        });
    }

    // Filter: brokers
    if (trTxSelectedBrokerIds.length > 0) {
        filtered = filtered.filter(function(t) {
            return trTxSelectedBrokerIds.indexOf(t.broker_id) >= 0;
        });
    }

    // Filter: tags
    if (trTxSelectedTagNames.length > 0) {
        filtered = filtered.filter(function(t) {
            var txnTags = (t.tags || []).filter(function(tg) { return tg !== 'blank'; });
            if (trTxTagLogic === 'AND') {
                return trTxSelectedTagNames.every(function(st) { return txnTags.indexOf(st) >= 0; });
            } else {
                return trTxSelectedTagNames.some(function(st) { return txnTags.indexOf(st) >= 0; });
            }
        });
    }

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

    // Update count
    var countEl = document.getElementById('trTx-count');
    if (countEl) {
        countEl.textContent = 'Showing ' + filtered.length + ' of ' + trTransactions.length + ' transactions';
    }

    // Render table
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
        var qty = txn.quantity || 0;
        var netAmt = txn.net_amount || 0;
        var acqCost = qty !== 0 ? Math.abs(netAmt / qty) : 0;

        // Row classes
        var rowClasses = [];
        if (txn.dont_display) rowClasses.push('trTx-hidden-row');
        if (txn.ignore_for_avg_cost) rowClasses.push('trTx-ignored-row');
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

        // Tags
        var tagHtml = '';
        var tags = (txn.tags || []).filter(function(tg) { return tg !== 'blank'; });
        if (tags.length > 0) {
            tagHtml = '<div class="tag-pills">' + tags.map(function(tg) {
                return '<span class="tag-pill">' + tg + '</span>';
            }).join('') + '</div>';
        }

        // Action menu
        var menuId = 'trTxAm-' + txn.id.substring(0, 8);

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
            '<td class="text-right' + (isSell ? ' negative' : '') + '">' + formatQuantity(qty) + '</td>' +
            '<td class="text-right">' + formatPrice(acqCost, false) + '</td>' +
            '<td class="text-right' + (isSell ? ' negative' : '') + '">' + formatAmount(netAmt) + '</td>' +
            '<td>' + tagHtml + '</td>' +
            '<td class="action-cell">' +
                '<button class="btn-action trTx-action-btn" data-txn-id="' + txn.id + '" title="Actions">⚙️</button>' +
                '<div class="action-menu" id="' + menuId + '">' +
                    '<button class="action-menu-item" data-txaction="edit" data-txn-id="' + txn.id + '">✏️ Edit</button>' +
                    '<button class="action-menu-item" data-txaction="toggle-display" data-txn-id="' + txn.id + '">' +
                        (txn.dont_display ? '👁 Show in Display' : '🙈 Hide from Display') +
                    '</button>' +
                    '<button class="action-menu-item" data-txaction="toggle-ignore" data-txn-id="' + txn.id + '">' +
                        (txn.ignore_for_avg_cost ? '▶ Include in Avg Cost' : '⏸ Ignore for Avg Cost') +
                    '</button>' +
                    '<button class="action-menu-item danger" data-txaction="delete" data-txn-id="' + txn.id + '">🗑️ Delete</button>' +
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
            trTxCloseAllMenus();
            var action = item.dataset.txaction;
            var txnId = item.dataset.txnId;
            if (action === 'edit') trOpenEditModal(txnId);
            else if (action === 'toggle-display') trTxToggleFlag(txnId, 'dont_display');
            else if (action === 'toggle-ignore') trTxToggleFlag(txnId, 'ignore_for_avg_cost');
            else if (action === 'delete') trTxDeleteTransaction(txnId);
        });
    });

    // Row click opens edit modal (except action cell)
    document.querySelectorAll('#trTx-list tr[data-txn-id]').forEach(function(row) {
        row.addEventListener('click', function(e) {
            if (e.target.closest('.action-cell')) return;
            trOpenEditModal(row.dataset.txnId);
        });
    });
}

function trTxCloseAllMenus() {
    document.querySelectorAll('#trTx-list .action-menu.show').forEach(function(m) { m.classList.remove('show'); });
    trTxOpenMenuId = null;
}

// ============================================================================
// TOGGLE FLAGS (dont_display, ignore_for_avg_cost)
// ============================================================================

async function trTxToggleFlag(txnId, flagName) {
    var txn = trTransactions.find(function(t) { return t.id === txnId; });
    if (!txn) return;
    if (txn.is_locked) {
        showAlert('Transaction is locked. Unlock it first.', 'error');
        return;
    }

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
        showAlert(flagName.replace(/_/g, ' ') + ' ' + (newValue ? 'enabled' : 'disabled'), 'success', 2000);
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
// WINDOW EXPORTS
// ============================================================================

window.trTxInit = trTxInit;
