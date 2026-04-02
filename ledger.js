// ============================================================================
// WMS LEDGER MODULE
// ============================================================================
// Uses 'lg' prefix for all module-level state and functions.
// All variables use 'var' (project convention A.1.2).

// ============================================================================
// STATE VARIABLES
// ============================================================================

// Views
var lgViews = [];
var lgActiveViewId = null;

// Data
var lgLedgerEntries = [];
var lgCombined = [];
var lgMarginAdj = [];

// Filters
var lgSelectedInvestorIds = [];
var lgSelectedTraderIds = [];
var lgSelectedBrokerIds = [];
var lgSelectedTagNames = [];
var lgTagFilterLogic = 'OR';

// Date filter (shared wmsDateFilter component)
var lgDateFilterInstance = null;
var lgDateFrom = '';
var lgDateTo = '';

// Pill filter controllers
var lgInvPillFilter = null;
var lgTrdPillFilter = null;
var lgBrkPillFilter = null;
var lgTagPillFilter = null;

// Editing state
var lgEditingEntryId = null;

// Init flag
var lgInited = false;

// Interest detail temp state
var lgInterestDetailEntryId = null;
var lgInterestDetailData = null;

// ============================================================================
// INITIALIZATION
// ============================================================================

function lgInit() {
    if (lgInited) return;
    lgInited = true;

    // Create pill filters (same pattern as Portfolio — pass selectedIds array reference)
    // Items start empty; lgRefreshPillItems() populates them with current data.
    var invContainer = document.getElementById('lgFilterInvestor');
    if (invContainer) {
        lgInvPillFilter = wmsPillSearch(invContainer, {
            label: 'Filter by Investor',
            placeholder: 'Type to search investors...',
            items: [],
            selectedIds: lgSelectedInvestorIds,
            onChange: function() { lgRefresh(); }
        });
    }

    var trdContainer = document.getElementById('lgFilterTrader');
    if (trdContainer) {
        lgTrdPillFilter = wmsPillSearch(trdContainer, {
            label: 'Filter by Trader',
            placeholder: 'Type to search traders...',
            items: [],
            selectedIds: lgSelectedTraderIds,
            onChange: function() { lgRefresh(); }
        });
    }

    var brkContainer = document.getElementById('lgFilterBroker');
    if (brkContainer) {
        lgBrkPillFilter = wmsPillSearch(brkContainer, {
            label: 'Filter by Broker',
            placeholder: 'Type to search brokers...',
            items: [],
            selectedIds: lgSelectedBrokerIds,
            onChange: function() { lgRefresh(); }
        });
    }

    var tagContainer = document.getElementById('lgFilterTags');
    if (tagContainer) {
        lgTagPillFilter = wmsPillSearch(tagContainer, {
            label: 'Filter by Tag',
            placeholder: 'Type to search tags...',
            items: [],
            selectedIds: lgSelectedTagNames,
            onChange: function() { lgRefresh(); }
        });
    }

    // Populate pill items with current data
    lgRefreshPillItems();

    // Date filter — initialize shared wmsDateFilter component (same as Transactions page)
    var dateContainer = document.getElementById('lgDateFilter');
    if (dateContainer) {
        var fyStartMonth = 4;
        if (window.wmsRefData && wmsRefData.userPrefs && wmsRefData.userPrefs.fy_start_month) {
            fyStartMonth = wmsRefData.userPrefs.fy_start_month;
        }
        lgDateFilterInstance = wmsDateFilter(dateContainer, {
            default: 'all',
            fyStartMonth: fyStartMonth,
            transactions: trTransactions,
            onChange: function(from, to) {
                lgDateFrom = from || '';
                lgDateTo = to || '';
                lgRefresh();
            }
        });
        if (lgDateFilterInstance) {
            var range = lgDateFilterInstance.getRange();
            lgDateFrom = range.from || '';
            lgDateTo = range.to || '';
        }
    }

    // Filters toggle button (same pattern as Portfolio)
    var filtersToggle = document.getElementById('lgFiltersToggle');
    if (filtersToggle) {
        filtersToggle.addEventListener('click', function() {
            var filtersDiv = document.getElementById('lgFiltersBar');
            var isHidden = filtersDiv.style.display === 'none';
            filtersDiv.style.display = isHidden ? 'flex' : 'none';
            this.textContent = isHidden ? '\u25BC' : '\u25B2';
        });
    }

    // Add Entry button
    var addBtn = document.getElementById('lgAddEntryBtn');
    if (addBtn) {
        addBtn.addEventListener('click', lgAddEntry);
    }

    // Interest detail close/cancel buttons
    var intDetailClose = document.getElementById('lgInterestDetailClose');
    var intDetailCancel = document.getElementById('lgInterestDetailCancelBtn');
    if (intDetailClose) {
        intDetailClose.addEventListener('click', function() {
            document.getElementById('lgInterestDetail').style.display = 'none';
        });
    }
    if (intDetailCancel) {
        intDetailCancel.addEventListener('click', function() {
            document.getElementById('lgInterestDetail').style.display = 'none';
        });
    }

    // Interest post button
    var intPostBtn = document.getElementById('lgInterestPostBtn');
    if (intPostBtn) {
        intPostBtn.addEventListener('click', lgPostInterest);
    }

    // Export buttons
    var pdfBtn = document.getElementById('lgExportPdfBtn');
    var xlsBtn = document.getElementById('lgExportExcelBtn');
    if (pdfBtn) pdfBtn.addEventListener('click', lgExportPdf);
    if (xlsBtn) xlsBtn.addEventListener('click', lgExportExcel);

    // View management buttons
    var newViewBtn = document.getElementById('lgNewViewBtn');
    var updateBtn = document.getElementById('lgUpdateViewBtn');
    var saveNewBtn = document.getElementById('lgSaveNewBtn');
    var moreBtn = document.getElementById('lgMoreBtn');

    if (newViewBtn) {
        newViewBtn.addEventListener('click', function() {
            var prompt = document.getElementById('lgSavePrompt');
            if (prompt) {
                prompt.style.display = 'flex';
                document.getElementById('lgSavePromptName').focus();
            }
        });
    }

    if (updateBtn) {
        updateBtn.addEventListener('click', lgUpdateCurrentView);
    }

    if (saveNewBtn) {
        saveNewBtn.addEventListener('click', function() {
            var prompt = document.getElementById('lgSavePrompt');
            if (prompt) {
                prompt.style.display = 'flex';
                document.getElementById('lgSavePromptName').value = '';
                document.getElementById('lgSavePromptName').focus();
            }
        });
    }

    // Save prompt OK/Cancel
    var saveOk = document.getElementById('lgSavePromptOk');
    var saveCancel = document.getElementById('lgSavePromptCancel');
    if (saveOk) {
        saveOk.addEventListener('click', function() {
            var name = document.getElementById('lgSavePromptName').value.trim();
            if (name) {
                lgSaveCurrentView(name);
            }
        });
    }
    if (saveCancel) {
        saveCancel.addEventListener('click', function() {
            document.getElementById('lgSavePrompt').style.display = 'none';
        });
    }

    // More dropdown toggle
    if (moreBtn) {
        moreBtn.addEventListener('click', function() {
            var dd = document.getElementById('lgMoreDropdown');
            if (dd) {
                dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
            }
        });
    }

    // Load views and initial data
    lgLoadViews();
}

// ============================================================================
// VIEW MANAGEMENT
// ============================================================================

async function lgLoadViews() {
    try {
        var resp = await fetch(
            SUPABASE_URL + '/rest/v1/portfolio_views?module=eq.ledger&select=id,name,filters,sort_order,is_default,show_in_tabs&order=sort_order.asc,created_at.asc',
            {
                headers: lgHeaders()
            }
        );
        lgViews = resp.ok ? await resp.json() : [];
    } catch (err) {
        console.warn('Ledger: Failed to load views:', err.message);
        lgViews = [];
    }

    lgRenderViewTabs();
    lgRenderMoreDropdown();
    lgUpdateViewButtons();

    // Auto-apply default view if no view is active
    if (!lgActiveViewId) {
        var defaultView = lgViews.find(function(v) { return v.is_default; });
        if (defaultView) {
            lgApplyView(defaultView.id);
        } else {
            // No default, just refresh with current filters
            lgRefresh();
        }
    }
}

function lgRenderViewTabs() {
    var container = document.getElementById('lgViewTabs');
    if (!container) return;

    var defaultView = lgViews.find(function(v) { return v.is_default; });
    var tabViews = lgViews.filter(function(v) {
        return v.show_in_tabs !== false && !v.is_default;
    });

    var html = '';

    // Default view tab
    if (defaultView) {
        var isActive = defaultView.id === lgActiveViewId;
        html += '<button class="tr-view-tab' + (isActive ? ' active' : '') + '" data-view-id="' +
            defaultView.id + '"><span class="tr-tab-star">★</span> ' + wmsEsc(defaultView.name) + '</button>';
    }

    // Other tabs
    tabViews.forEach(function(v) {
        var isActive = v.id === lgActiveViewId;
        html += '<button class="tr-view-tab' + (isActive ? ' active' : '') + '" data-view-id="' +
            v.id + '">' + wmsEsc(v.name) +
            ' <span class="tr-tab-close" data-close-id="' + v.id + '" title="Remove from tabs">✕</span></button>';
    });

    container.innerHTML = html;

    // Attach handlers
    container.querySelectorAll('.tr-view-tab').forEach(function(tab) {
        var clickTimer = null;
        tab.addEventListener('click', function(e) {
            if (e.target.classList.contains('tr-tab-close')) {
                e.stopPropagation();
                lgCloseViewTab(e.target.dataset.closeId);
                return;
            }
            if (clickTimer) clearTimeout(clickTimer);
            clickTimer = setTimeout(function() {
                clickTimer = null;
                lgApplyView(tab.dataset.viewId);
            }, 250);
        });

        tab.addEventListener('dblclick', function(e) {
            e.preventDefault();
            e.stopPropagation();
            if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }

            var viewId = tab.dataset.viewId;
            var view = lgViews.find(function(v) { return v.id === viewId; });
            if (!view) return;

            lgActiveViewId = viewId;

            var input = document.createElement('input');
            input.type = 'text';
            input.value = view.name;
            input.style.cssText = 'width:100px; font-size:11px; padding:1px 4px; border:1px solid #667eea; border-radius:3px; outline:none; background:white;';
            tab.innerHTML = '';
            tab.appendChild(input);
            input.focus();
            input.select();

            ['click', 'mousedown', 'mouseup', 'dblclick', 'keydown', 'keyup', 'keypress'].forEach(function(evt) {
                input.addEventListener(evt, function(ie) { ie.stopPropagation(); });
            });

            var finished = false;
            function finishRename() {
                if (finished) return;
                finished = true;
                var newName = input.value.trim();
                if (newName && newName !== view.name) {
                    // Duplicate name check
                    var duplicate = lgViews.some(function(v) {
                        return v.id !== viewId && v.name.toLowerCase() === newName.toLowerCase();
                    });
                    if (duplicate) {
                        showAlert('A view named "' + newName + '" already exists', 'error', 3000);
                    } else {
                        view.name = newName;
                        fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + viewId, {
                            method: 'PATCH',
                            headers: lgHeaders(),
                            body: JSON.stringify({ name: newName })
                        }).catch(function(err) { console.warn('Failed to rename view:', err.message); });
                    }
                }
                lgRenderViewTabs();
                lgRenderMoreDropdown();
            }

            input.addEventListener('blur', finishRename);
            input.addEventListener('keydown', function(ke) {
                ke.stopPropagation();
                if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
                if (ke.key === 'Escape') { ke.preventDefault(); input.value = view.name; input.blur(); }
            });
        });
    });
}

function lgRenderMoreDropdown() {
    var list = document.getElementById('lgMoreList');
    if (!list) return;

    if (lgViews.length === 0) {
        list.innerHTML = '<div style="padding:8px 12px; font-size:12px; color:#a0aec0;">No saved views</div>';
        return;
    }

    list.innerHTML = lgViews.map(function(v, idx) {
        var isActive = v.id === lgActiveViewId;
        var isDefault = v.is_default;
        var inTabs = v.show_in_tabs !== false;
        return '<div class="tr-more-item' + (isActive ? ' active' : '') + '" data-view-id="' + v.id + '" data-view-idx="' + idx + '">' +
            (isActive ? '<span style="color:#667eea;font-size:11px;">✓</span> ' : '<span style="width:16px;display:inline-block;"></span> ') +
            '<span class="tr-more-name">' + wmsEsc(v.name) + '</span>' +
            (isDefault ? '<span class="tr-more-badge">★ Default</span>' : '') +
            '<span class="tr-more-actions">' +
                (!isDefault ? '<button class="tr-more-action-btn" data-action="default" data-id="' + v.id + '">★</button>' : '') +
                (inTabs && !isDefault ? '<button class="tr-more-action-btn" data-action="hide-tab" data-id="' + v.id + '">□</button>' : '') +
                (!inTabs ? '<button class="tr-more-action-btn" data-action="show-tab" data-id="' + v.id + '">■</button>' : '') +
                '<button class="tr-more-action-btn danger" data-action="delete" data-id="' + v.id + '">✕</button>' +
            '</span></div>';
    }).join('');

    list.querySelectorAll('.tr-more-item').forEach(function(item) {
        item.addEventListener('click', function(e) {
            if (e.target.closest('.tr-more-action-btn')) return;
            lgApplyView(item.dataset.viewId);
            document.getElementById('lgMoreDropdown').style.display = 'none';
        });
    });

    list.querySelectorAll('.tr-more-action-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var action = btn.dataset.action;
            var id = btn.dataset.id;
            if (action === 'default') lgSetDefaultView(id);
            else if (action === 'hide-tab') lgCloseViewTab(id);
            else if (action === 'show-tab') lgShowViewTab(id);
            else if (action === 'delete') lgDeleteView(id);
        });
    });
}

function lgUpdateViewButtons() {
    var updateBtn = document.getElementById('lgUpdateViewBtn');
    if (updateBtn) {
        updateBtn.disabled = !lgActiveViewId;
    }
}

function lgApplyView(viewId) {
    var view = lgViews.find(function(v) { return v.id === viewId; });
    if (!view) return;

    lgActiveViewId = viewId;
    var f = view.filters || {};

    // Mutate arrays in-place (same references passed to wmsPillSearch)
    lgSelectedInvestorIds.length = 0;
    Array.prototype.push.apply(lgSelectedInvestorIds, f.investorIds || []);
    lgSelectedTraderIds.length = 0;
    Array.prototype.push.apply(lgSelectedTraderIds, f.traderIds || []);
    lgSelectedBrokerIds.length = 0;
    Array.prototype.push.apply(lgSelectedBrokerIds, f.brokerIds || []);
    lgSelectedTagNames.length = 0;
    Array.prototype.push.apply(lgSelectedTagNames, f.tagNames || []);
    lgTagFilterLogic = f.tagLogic || 'OR';

    // Update filter UI (same pattern as Portfolio trApplyView)
    ['investor', 'trader', 'broker', 'tag'].forEach(function(type) {
        lgSyncPillStates(type);
        lgRenderSelectedTags(type);
    });

    lgRenderViewTabs();
    lgRenderMoreDropdown();
    lgUpdateViewButtons();
    lgRefresh();
}

// Refresh pill filter items with current reference data (handles async data loading)
function lgRefreshPillItems() {
    if (lgInvPillFilter && trInvestors && trInvestors.length > 0) {
        lgInvPillFilter.setItems(trInvestors.map(function(inv) {
            return { id: inv.id, label: inv.short_name || inv.name, searchText: (inv.name || '') + ' ' + (inv.short_name || '') };
        }));
    }
    if (lgTrdPillFilter && trInvestors && trInvestors.length > 0) {
        lgTrdPillFilter.setItems(trInvestors.map(function(inv) {
            return { id: inv.id, label: inv.short_name || inv.name, searchText: (inv.name || '') + ' ' + (inv.short_name || '') };
        }));
    }
    if (lgBrkPillFilter && trBrokers && trBrokers.length > 0) {
        lgBrkPillFilter.setItems(trBrokers.map(function(brk) {
            return { id: brk.id, label: brk.broker_code || brk.name, searchText: (brk.name || '') + ' ' + (brk.broker_code || '') };
        }));
    }
    if (lgTagPillFilter && wmsRefData.allTags && wmsRefData.allTags.length > 0) {
        lgTagPillFilter.setItems(wmsRefData.allTags.map(function(tag) {
            return { id: tag, label: tag };
        }));
    }
}

// Delegates to pill filter controller syncStates (same as Portfolio trSyncPillStates)
function lgSyncPillStates(type) {
    if (type === 'investor' && lgInvPillFilter) lgInvPillFilter.syncStates();
    else if (type === 'trader' && lgTrdPillFilter) lgTrdPillFilter.syncStates();
    else if (type === 'broker' && lgBrkPillFilter) lgBrkPillFilter.syncStates();
    else if ((type === 'tag' || !type) && lgTagPillFilter) lgTagPillFilter.syncStates();
}

// Delegates to pill filter controller renderSelectedTags (same as Portfolio trRenderSelectedTags)
function lgRenderSelectedTags(type) {
    if (type === 'investor' && lgInvPillFilter) lgInvPillFilter.renderSelectedTags();
    else if (type === 'trader' && lgTrdPillFilter) lgTrdPillFilter.renderSelectedTags();
    else if (type === 'broker' && lgBrkPillFilter) lgBrkPillFilter.renderSelectedTags();
    else if ((type === 'tag' || !type) && lgTagPillFilter) lgTagPillFilter.renderSelectedTags();
}

async function lgSaveCurrentView(name) {
    // Duplicate name check
    var exists = lgViews.some(function(v) { return v.name.toLowerCase() === name.toLowerCase(); });
    if (exists) {
        showAlert('A view named "' + name + '" already exists', 'error', 3000);
        return;
    }
    var filters = lgGetCurrentFilters();
    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/portfolio_views', {
            method: 'POST',
            headers: lgHeaders(),
            body: JSON.stringify({
                name: name,
                filters: filters,
                sort_order: (lgViews.length || 0) + 1,
                is_default: false,
                show_in_tabs: true,
                module: 'ledger'
            })
        });
        if (resp.ok) {
            var newView = await resp.json();
            if (Array.isArray(newView)) newView = newView[0];
            lgViews.push(newView);
            lgApplyView(newView.id);
            document.getElementById('lgSavePrompt').style.display = 'none';
            showAlert('View saved', 'success', 3000);
        }
    } catch (err) {
        console.warn('Failed to save view:', err.message);
        showAlert('Failed to save view', 'error', 3000);
    }
}

async function lgUpdateCurrentView() {
    if (!lgActiveViewId) return;
    var view = lgViews.find(function(v) { return v.id === lgActiveViewId; });
    if (!view) return;

    var filters = lgGetCurrentFilters();
    try {
        await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + lgActiveViewId, {
            method: 'PATCH',
            headers: lgHeaders(),
            body: JSON.stringify({ filters: filters })
        });
        view.filters = filters;
        showAlert('View updated', 'success', 3000);
    } catch (err) {
        console.warn('Failed to update view:', err.message);
        showAlert('Failed to update view', 'error', 3000);
    }
}

async function lgSetDefaultView(viewId) {
    try {
        // Clear previous default
        var prevDefault = lgViews.find(function(v) { return v.is_default; });
        if (prevDefault) {
            await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + prevDefault.id, {
                method: 'PATCH',
                headers: lgHeaders(),
                body: JSON.stringify({ is_default: false })
            });
            prevDefault.is_default = false;
        }

        // Set new default
        await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + viewId, {
            method: 'PATCH',
            headers: lgHeaders(),
            body: JSON.stringify({ is_default: true })
        });
        var v = lgViews.find(function(v) { return v.id === viewId; });
        if (v) v.is_default = true;

        lgRenderViewTabs();
        lgRenderMoreDropdown();
    } catch (err) {
        console.warn('Failed to set default view:', err.message);
    }
}

async function lgCloseViewTab(viewId) {
    try {
        await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + viewId, {
            method: 'PATCH',
            headers: lgHeaders(),
            body: JSON.stringify({ show_in_tabs: false })
        });
    } catch (err) {
        console.warn('Failed to close tab:', err.message);
    }

    var v = lgViews.find(function(v) { return v.id === viewId; });
    if (v) v.show_in_tabs = false;

    if (lgActiveViewId === viewId) {
        var defaultView = lgViews.find(function(v) { return v.is_default; });
        if (defaultView) {
            lgApplyView(defaultView.id);
            return;
        } else {
            lgActiveViewId = null;
        }
    }

    lgRenderViewTabs();
    lgRenderMoreDropdown();
}

async function lgShowViewTab(viewId) {
    try {
        await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + viewId, {
            method: 'PATCH',
            headers: lgHeaders(),
            body: JSON.stringify({ show_in_tabs: true })
        });
    } catch (err) {
        console.warn('Failed to show tab:', err.message);
    }

    var v = lgViews.find(function(v) { return v.id === viewId; });
    if (v) v.show_in_tabs = true;

    lgRenderViewTabs();
    lgRenderMoreDropdown();
}

async function lgDeleteView(viewId) {
    if (!confirm('Delete this view?')) return;

    try {
        await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + viewId, {
            method: 'DELETE',
            headers: lgHeaders()
        });
        lgViews = lgViews.filter(function(v) { return v.id !== viewId; });

        if (lgActiveViewId === viewId) {
            var defaultView = lgViews.find(function(v) { return v.is_default; });
            if (defaultView) {
                lgApplyView(defaultView.id);
                return;
            } else {
                lgActiveViewId = null;
            }
        }

        lgRenderViewTabs();
        lgRenderMoreDropdown();
    } catch (err) {
        console.warn('Failed to delete view:', err.message);
    }
}

function lgGetCurrentFilters() {
    return {
        investorIds: lgSelectedInvestorIds.slice(),
        traderIds: lgSelectedTraderIds.slice(),
        brokerIds: lgSelectedBrokerIds.slice(),
        tagNames: lgSelectedTagNames.slice(),
        tagLogic: lgTagFilterLogic
    };
}

// ============================================================================
// DATA REFRESH & RENDERING
// ============================================================================

async function lgRefresh() {
    // Ensure pill items are populated with latest data (handles async load race)
    lgRefreshPillItems();

    // Use date range from wmsDateFilter component
    var dateFrom = lgDateFrom || '2000-01-01';
    var dateTo = lgDateTo || '2099-12-31';

    // Fetch ledger entries filtered by date range
    var query = 'entry_date.gte.' + dateFrom + '&entry_date.lte.' + dateTo;
    if (lgSelectedInvestorIds.length > 0) {
        query += '&investor_id.in.(' + lgSelectedInvestorIds.map(function(id) { return '"' + id + '"'; }).join(',') + ')';
    }

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/ledger_entries?select=*&' + query + '&order=entry_date.asc', {
            headers: lgHeaders()
        });
        lgLedgerEntries = resp.ok ? await resp.json() : [];
    } catch (err) {
        console.warn('Failed to fetch ledger entries:', err.message);
        lgLedgerEntries = [];
    }

    // Filter transactions to match current view
    var filtered = trTransactions.filter(function(t) {
        if (t.dont_display) return false;
        if (!t.transaction_date) return false;

        // Date range filter
        if (t.transaction_date < dateFrom || t.transaction_date > dateTo) return false;

        // Investor filter
        if (lgSelectedInvestorIds.length > 0 && lgSelectedInvestorIds.indexOf(t.investor_id) < 0) return false;

        // Trader filter
        if (lgSelectedTraderIds.length > 0) {
            var tid = t.trader_id || t.investor_id;
            if (!tid || lgSelectedTraderIds.indexOf(tid) < 0) return false;
        }

        // Broker filter
        if (lgSelectedBrokerIds.length > 0 && lgSelectedBrokerIds.indexOf(t.broker_id) < 0) return false;

        // Tag filter
        if (lgSelectedTagNames.length > 0) {
            var txnTags = t.tags || [];
            var hasTag = false;
            for (var i = 0; i < lgSelectedTagNames.length; i++) {
                if (txnTags.indexOf(lgSelectedTagNames[i]) >= 0) {
                    hasTag = true;
                    break;
                }
            }
            if (!hasTag) return false;
        }

        return true;
    });

    // Build combined ledger
    lgCombined = wmsBuildLedger(lgLedgerEntries, filtered, {
        investorIds: lgSelectedInvestorIds,
        traderIds: lgSelectedTraderIds,
        brokerIds: lgSelectedBrokerIds,
        tagNames: lgSelectedTagNames,
        tagLogic: lgTagFilterLogic
    });

    // Calculate margin adjustments for NFO trades
    lgMarginAdj = wmsCalcMarginFIFO(filtered);

    // Render
    lgRenderEntries(lgCombined);
    lgRenderSummary();
}

function lgRenderEntries(rows) {
    var tbody = document.getElementById('lgBody');
    if (!tbody) return;

    // Keep the new entry row, replace all others
    var newRowHtml = tbody.querySelector('#lgNewEntryRow').outerHTML;

    var html = newRowHtml;

    // Render data rows
    var totalAmount = 0;
    var lastBalance = 0;

    rows.forEach(function(row) {
        var date = formatDate(row.date);
        var scrip = '';
        var product = '';
        var qty = '';
        var price = '';
        var net = '';
        var amount = '';
        var balance = '';
        var marginAdj = '';
        var editDelete = '';

        if (row._rowType === 'ledger') {
            var source = row._source;
            scrip = wmsEsc(row.entryType === 'OPENING_BALANCE' ? 'Opening Balance' :
                          row.entryType === 'CASH_RECEIVED' ? 'Cash In' :
                          row.entryType === 'CASH_PAID' ? 'Cash Out' :
                          row.entryType === 'INTEREST_BOOKED' ? 'Interest' :
                          'Adjustment');

            if (row.entryType === 'INTEREST_BOOKED') {
                var entryId = source.id;
                amount = '<span style="cursor:pointer; text-decoration:underline;" ondblclick="lgShowInterestDetail(\'' + wmsEsc(entryId) + '\')">' +
                    wmsFmtAmt(row.amount) + '</span>';
            } else {
                amount = wmsFmtAmt(row.amount);
            }

            balance = wmsFmtAmt(row._runningBalance);
            lastBalance = row._runningBalance;

            editDelete = '<span style="font-size:9px;"><a href="#" onclick="event.preventDefault(); lgEditEntry(\'' + wmsEsc(source.id) + '\');" style="margin-right:4px;">✎</a>' +
                '<a href="#" onclick="event.preventDefault(); lgDeleteEntry(\'' + wmsEsc(source.id) + '\');">✕</a></span>';
        } else if (row._rowType === 'trade') {
            var source = row._source;
            var sym = source.short_symbol || source.symbol || '';
            scrip = wmsEsc(sym);

            var prod = source.product || (source.security_type === 'NFO' ? 'NFO' : 'EQ');
            product = wmsEsc(prod);

            var q = Math.abs(source.quantity || 0);
            if (source.transaction_type === 'SELL' || source.transaction_type === 'RIGHTS_ENTITLEMENT' || source.transaction_type === 'BONUS') {
                q = -q;
            }
            if (q !== 0) qty = String(Math.round(q));

            price = source.price ? wmsFmtAmt(source.price) : '';

            if (source.quantity && source.net_amount) {
                var netPerUnit = source.net_amount / source.quantity;
                net = wmsFmtAmt(netPerUnit);
            }

            amount = wmsFmtAmt(row.amount);
            balance = wmsFmtAmt(row._runningBalance);
            lastBalance = row._runningBalance;

            // Margin adjustment for NFO
            var marginForTrade = lgMarginAdj.find(function(m) {
                return m.transactionId === source.id;
            });
            if (marginForTrade && marginForTrade.marginAdj !== 0) {
                marginAdj = wmsFmtAmt(marginForTrade.marginAdj);
            }
        }

        var amountColor = row.amount < 0 ? ' style="color:#dc2626;"' : row.amount > 0 ? ' style="color:#059669;"' : '';
        var balanceColor = row._runningBalance < 0 ? ' style="color:#dc2626;"' : '';

        html += '<tr>' +
            '<td>' + date + '</td>' +
            '<td>' + scrip + (editDelete ? ' ' + editDelete : '') + '</td>' +
            '<td>' + product + '</td>' +
            '<td class="text-right">' + qty + '</td>' +
            '<td class="text-right">' + price + '</td>' +
            '<td class="text-right">' + net + '</td>' +
            '<td class="text-right"' + amountColor + '>' + amount + '</td>' +
            '<td class="text-right"' + balanceColor + '>' + balance + '</td>' +
            '<td class="text-right">' + marginAdj + '</td>' +
            '</tr>';

        totalAmount += row.amount;
    });

    // Update totals row
    var totalAmountStr = wmsFmtAmt(totalAmount);
    var totalBalanceStr = wmsFmtAmt(lastBalance);

    // Replace tbody with new HTML, then update totals
    tbody.innerHTML = html;

    var totalAmtEl = document.getElementById('lgTotalAmount');
    var totalBalEl = document.getElementById('lgTotalBalance');
    if (totalAmtEl) totalAmtEl.textContent = totalAmountStr;
    if (totalBalEl) totalBalEl.textContent = totalBalanceStr;
}

function lgRenderSummary() {
    var summaryBody = document.getElementById('lgSummaryBody');
    if (!summaryBody) return;

    // Calculate holdings from filtered transactions
    var holdings = {};
    var totalCost = 0;
    var totalValue = 0;

    lgCombined.forEach(function(row) {
        if (row._rowType !== 'trade') return;
        var sym = row.symbol;
        if (!sym) return;

        if (!holdings[sym]) {
            holdings[sym] = {
                symbol: sym,
                product: row._source.product || (row._source.security_type === 'NFO' ? 'NFO' : 'EQ'),
                qty: 0,
                totalCost: 0,
                totalValue: 0,
                avgCost: 0,
                cmp: 0
            };
        }

        var qty = row._source.transaction_type === 'SELL' ? -Math.abs(row._source.quantity) : Math.abs(row._source.quantity);
        holdings[sym].qty += qty;
        holdings[sym].totalCost += row._source.net_amount;
    });

    // Render holdings rows
    var rows = Object.keys(holdings).map(function(sym) {
        var h = holdings[sym];
        if (h.qty === 0) return '';

        h.avgCost = h.qty !== 0 ? h.totalCost / h.qty : 0;
        h.cmp = h.avgCost;  // Use average cost as proxy for CMP
        h.totalValue = h.qty * h.cmp;

        totalCost += h.totalCost;
        totalValue += h.totalValue;

        var mtm = h.totalValue - h.totalCost;
        var mtmColor = mtm < 0 ? ' style="color:#dc2626;"' : mtm > 0 ? ' style="color:#059669;"' : '';

        return '<tr>' +
            '<td>' + wmsEsc(sym) + '</td>' +
            '<td class="text-right">' + wmsEsc(h.product) + '</td>' +
            '<td class="text-right">' + String(Math.round(h.qty)) + '</td>' +
            '<td class="text-right">' + wmsFmtAmt(h.avgCost) + '</td>' +
            '<td class="text-right">' + wmsFmtAmt(h.cmp) + '</td>' +
            '<td class="text-right"' + mtmColor + '>' + wmsFmtAmt(mtm) + '</td>' +
            '<td class="text-right">' + wmsFmtAmt(h.totalValue) + '</td>' +
            '</tr>';
    }).filter(function(s) { return s.length > 0; }).join('');

    if (rows.length === 0) {
        rows = '<tr><td colspan="7" style="text-align:center; padding:20px; color:#9ca3af;">No holdings</td></tr>';
    }

    summaryBody.innerHTML = rows;

    // Update summary totals
    var lastBalance = 0;
    if (lgCombined.length > 0) {
        lastBalance = lgCombined[lgCombined.length - 1]._runningBalance;
    }

    var holdingsValueEl = document.getElementById('lgHoldingsValue');
    var mtmFnoEl = document.getElementById('lgMtmFno');
    var outstandingEl = document.getElementById('lgOutstanding');
    var potentialTaxEl = document.getElementById('lgPotentialTax');
    var netValueEl = document.getElementById('lgNetValue');

    if (holdingsValueEl) holdingsValueEl.textContent = wmsFmtAmt(totalValue);
    if (mtmFnoEl) mtmFnoEl.textContent = '0.00';
    if (outstandingEl) outstandingEl.textContent = wmsFmtAmt(Math.abs(lastBalance));

    var taxRate = 0;  // TODO: Get from investor/IBA config
    var potentialTax = (totalValue - totalCost) * (taxRate / 100);
    if (potentialTaxEl) potentialTaxEl.textContent = wmsFmtAmt(potentialTax);

    var netValue = totalValue - Math.abs(lastBalance) - potentialTax;

    if (netValueEl) {
        netValueEl.textContent = wmsFmtAmt(netValue);
        netValueEl.style.color = netValue < 0 ? '#dc2626' : netValue > 0 ? '#059669' : '';
    }
}

// ============================================================================
// LEDGER ENTRY MANAGEMENT
// ============================================================================

async function lgAddEntry() {
    var dateEl = document.getElementById('lgNewDate');
    var typeEl = document.getElementById('lgNewType');
    var refEl = document.getElementById('lgNewReference');
    var amtEl = document.getElementById('lgNewAmount');

    var entryDate = dateEl ? dateEl.value : '';
    var entryType = typeEl ? typeEl.value : 'ADJUSTMENT';
    var reference = refEl ? refEl.value : '';
    var amount = parseFloat(amtEl ? amtEl.value : '0') || 0;

    if (!entryDate || !amount) {
        showAlert('Please fill in date and amount', 'warning', 3000);
        return;
    }

    // Determine investor from selected filters (use first selected)
    var investorId = lgSelectedInvestorIds.length > 0 ? lgSelectedInvestorIds[0] : null;
    if (!investorId) {
        showAlert('Please select an investor', 'warning', 3000);
        return;
    }

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/ledger_entries', {
            method: 'POST',
            headers: lgHeaders(),
            body: JSON.stringify({
                investor_id: investorId,
                entry_date: entryDate,
                entry_type: entryType,
                amount: amount,
                reference: reference,
                notes: ''
            })
        });

        if (resp.ok) {
            if (dateEl) dateEl.value = '';
            if (refEl) refEl.value = '';
            if (amtEl) amtEl.value = '';
            showAlert('Entry added', 'success', 2000);
            lgRefresh();
        }
    } catch (err) {
        console.warn('Failed to add entry:', err.message);
        showAlert('Failed to add entry', 'error', 3000);
    }
}

async function lgEditEntry(entryId) {
    var entry = lgLedgerEntries.find(function(e) { return e.id === entryId; });
    if (!entry) return;

    lgEditingEntryId = entryId;
    showAlert('Edit feature coming soon', 'info', 3000);
}

async function lgDeleteEntry(entryId) {
    if (!confirm('Delete this entry?')) return;

    try {
        await fetch(SUPABASE_URL + '/rest/v1/ledger_entries?id=eq.' + entryId, {
            method: 'DELETE',
            headers: lgHeaders()
        });
        lgRefresh();
        showAlert('Entry deleted', 'success', 2000);
    } catch (err) {
        console.warn('Failed to delete entry:', err.message);
        showAlert('Failed to delete entry', 'error', 3000);
    }
}

// ============================================================================
// INTEREST CALCULATION & POSTING
// ============================================================================

async function lgShowInterestDetail(entryId) {
    var entry = lgLedgerEntries.find(function(e) { return e.id === entryId; });
    if (!entry || entry.entry_type !== 'INTEREST_BOOKED') return;

    lgInterestDetailEntryId = entryId;

    // Find investor's interest terms
    var investorId = entry.investor_id;
    var interestTerms = wmsGetInterestTerms(investorId);

    if (!interestTerms) {
        showAlert('No interest terms configured', 'warning', 3000);
        return;
    }

    // Calculate period from previous interest to current one
    var fromDate = null;
    for (var i = lgLedgerEntries.length - 1; i >= 0; i--) {
        if (lgLedgerEntries[i].entry_date < entry.entry_date && lgLedgerEntries[i].entry_type === 'INTEREST_BOOKED') {
            fromDate = new Date(lgLedgerEntries[i].entry_date);
            fromDate.setDate(fromDate.getDate() + 1);
            fromDate = fromDate.toISOString().slice(0, 10);
            break;
        }
    }
    if (!fromDate) {
        fromDate = lgCombined.length > 0 ? lgCombined[0].date : entry.entry_date;
    }
    var toDate = entry.entry_date;

    // Render detail panel
    var detailPanel = document.getElementById('lgInterestDetail');
    if (!detailPanel) return;

    var detailBody = document.getElementById('lgInterestDetailBody');
    var totalEditEl = document.getElementById('lgInterestTotalEdit');

    if (detailBody) {
        detailBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px;">Detail calculation would go here</td></tr>';
    }
    if (totalEditEl) {
        totalEditEl.value = entry.amount;
    }

    detailPanel.style.display = 'block';
}

async function lgPostInterest() {
    if (!lgInterestDetailEntryId) return;

    var totalEl = document.getElementById('lgInterestTotalEdit');
    var totalAmount = parseFloat(totalEl ? totalEl.value : '0') || 0;

    try {
        await fetch(SUPABASE_URL + '/rest/v1/ledger_entries?id=eq.' + lgInterestDetailEntryId, {
            method: 'PATCH',
            headers: lgHeaders(),
            body: JSON.stringify({ amount: totalAmount })
        });

        document.getElementById('lgInterestDetail').style.display = 'none';
        lgRefresh();
        showAlert('Interest posted', 'success', 2000);
    } catch (err) {
        console.warn('Failed to post interest:', err.message);
        showAlert('Failed to post interest', 'error', 3000);
    }
}

// ============================================================================
// EXPORT
// ============================================================================

function lgExportPdf() {
    showAlert('PDF export coming soon', 'info', 3000);
}

function lgExportExcel() {
    showAlert('Excel export coming soon', 'info', 3000);
}

// ============================================================================
// HELPERS
// ============================================================================

function lgHeaders() {
    return {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
    };
}

// ============================================================================
// WINDOW EXPORTS
// ============================================================================

window.lgInit = lgInit;
window.lgRefresh = lgRefresh;
window.lgRefreshPillItems = lgRefreshPillItems;
window.lgEditEntry = lgEditEntry;
window.lgDeleteEntry = lgDeleteEntry;
window.lgShowInterestDetail = lgShowInterestDetail;
window.lgAddEntry = lgAddEntry;
window.lgPostInterest = lgPostInterest;
window.lgApplyView = lgApplyView;
window.lgLoadViews = lgLoadViews;
