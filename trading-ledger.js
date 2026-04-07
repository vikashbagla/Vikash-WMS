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

// Sorting state
var lgSortCol = 'date';
var lgSortDir = 'asc';

// New entry date input (wmsDateInput instance)
var lgNewDateInput = null;

// Delete confirmation state
var lgPendingDeleteId = null;

// Active page tab ('transactions' or 'summary')
var lgActivePage = 'transactions';

// Opening balance editing state
var lgObEditing = false;

// ============================================================================
// TRANSACTION TYPE FRIENDLY LABELS
// ============================================================================

var LG_TYPE_LABELS = {
    'BUY': 'Buy',
    'SELL': 'Sell',
    'DIVIDEND': 'Dividend',
    'INTEREST': 'Interest',
    'OTHER_INCOME': 'Other Income',
    'CAPITAL_REDUCTION': 'Capital Reduction',
    'RIGHTS_ENTITLEMENT': 'Rights',
    'RIGHTS_PAYMENT': 'Rights Pay',
    'BONUS': 'Bonus',
    'SPLIT': 'Split',
    'HISTORICAL_PL': 'Historical P&L',
    'CASH_RECEIVED': 'Cash In',
    'CASH_PAID': 'Cash Out',
    'OPENING_BALANCE': 'Opening Bal',
    'ADJUSTMENT': 'Adjustment',
    'INTEREST_BOOKED': 'Interest'
};

var LG_TYPE_CSS = {
    'BUY': 'lg-type-buy',
    'SELL': 'lg-type-sell',
    'DIVIDEND': 'lg-type-income',
    'INTEREST': 'lg-type-income',
    'OTHER_INCOME': 'lg-type-income',
    'CAPITAL_REDUCTION': 'lg-type-income',
    'RIGHTS_ENTITLEMENT': 'lg-type-other',
    'RIGHTS_PAYMENT': 'lg-type-buy',
    'BONUS': 'lg-type-other',
    'SPLIT': 'lg-type-other',
    'HISTORICAL_PL': 'lg-type-other',
    'CASH_RECEIVED': 'lg-type-cash',
    'CASH_PAID': 'lg-type-sell',
    'OPENING_BALANCE': 'lg-type-cash',
    'ADJUSTMENT': 'lg-type-other',
    'INTEREST_BOOKED': 'lg-type-income'
};

// ============================================================================
// INITIALIZATION
// ============================================================================

function lgInit() {
    if (lgInited) return;
    lgInited = true;

    // Create pill filters (same pattern as Portfolio — pass selectedIds array reference)
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

    // Date filter — initialize shared wmsDateFilter component
    // Default to current FY
    var dateContainer = document.getElementById('lgDateFilter');
    if (dateContainer) {
        var fyStartMonth = 4;
        if (window.wmsRefData && wmsRefData.userPrefs && wmsRefData.userPrefs.fy_start_month) {
            fyStartMonth = wmsRefData.userPrefs.fy_start_month;
        }
        lgDateFilterInstance = wmsDateFilter(dateContainer, {
            default: 'currentFY',
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

    // New entry date input — use wmsDateInput (Rule D.5.4: never native <input type="date">)
    var newDateContainer = document.getElementById('lgNewDateContainer');
    if (newDateContainer) {
        lgNewDateInput = wmsDateInput(newDateContainer, {
            compact: true
        });
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

    // Page tab switching — Running Transactions / Output Summary
    var pageTabs = document.getElementById('lgPageTabs');
    if (pageTabs) {
        pageTabs.addEventListener('click', function(e) {
            var btn = e.target.closest('.lg-page-tab');
            if (!btn) return;
            var page = btn.getAttribute('data-page');
            if (page === lgActivePage) return;
            lgActivePage = page;
            // Update tab active states
            var tabs = pageTabs.querySelectorAll('.lg-page-tab');
            for (var i = 0; i < tabs.length; i++) {
                tabs[i].classList.toggle('active', tabs[i].getAttribute('data-page') === page);
            }
            // Show/hide sections
            var txnSection = document.getElementById('lgTransactionsSection');
            var sumSection = document.getElementById('lgSummarySection');
            if (txnSection) txnSection.classList.toggle('lg-page-hidden', page !== 'transactions');
            if (sumSection) sumSection.classList.toggle('lg-page-hidden', page !== 'summary');
        });
    }

    // Add Entry button
    var addBtn = document.getElementById('lgAddEntryBtn');
    if (addBtn) {
        addBtn.addEventListener('click', lgAddEntry);
    }

    // Modal close handlers — Interest Detail (4 ways: ✕, Cancel, click-outside, Escape)
    lgInitModal('lgInterestDetail', 'lgInterestDetailClose', 'lgInterestDetailCancelBtn');

    // Modal close handlers — Book Interest
    lgInitModal('lgBookInterestModal', 'lgBookInterestClose', 'lgBookCancelBtn');

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

    if (updateBtn) {
        updateBtn.addEventListener('click', lgUpdateCurrentView);
    }

    // Column sorting — attach click handlers to sortable headers
    document.querySelectorAll('#lgHead th.lg-sortable').forEach(function(th) {
        th.addEventListener('click', function() {
            var col = th.dataset.sort;
            if (lgSortCol === col) {
                lgSortDir = lgSortDir === 'asc' ? 'desc' : 'asc';
            } else {
                lgSortCol = col;
                lgSortDir = 'asc';
            }
            lgRenderEntries(lgCombined);
        });
    });

    // Update unit labels in column headers
    lgUpdateUnitLabels();

    // Load views and initial data
    lgLoadViews();
}

// ============================================================================
// MODAL HELPERS — Standard D.1 pattern (4 close methods)
// ============================================================================

function lgInitModal(overlayId, closeBtnId, cancelBtnId) {
    var overlay = document.getElementById(overlayId);
    var closeBtn = document.getElementById(closeBtnId);
    var cancelBtn = document.getElementById(cancelBtnId);

    var closeFn = function() {
        if (overlay) overlay.classList.remove('show');
    };

    // 1. ✕ button
    if (closeBtn) closeBtn.addEventListener('click', closeFn);
    // 2. Cancel button
    if (cancelBtn) cancelBtn.addEventListener('click', closeFn);
    // 3. Click outside (on overlay, not content)
    if (overlay) {
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) closeFn();
        });
    }
    // 4. Escape key (registered once per modal)
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && overlay && overlay.classList.contains('show')) {
            closeFn();
        }
    });
}

function lgShowModal(overlayId) {
    var el = document.getElementById(overlayId);
    if (el) el.classList.add('show');
}

function lgHideModal(overlayId) {
    var el = document.getElementById(overlayId);
    if (el) el.classList.remove('show');
}

// ============================================================================
// UNIT LABELS — Shows user's display unit in amount column headers
// ============================================================================

function lgUpdateUnitLabels() {
    var label = typeof getUnitLabel === 'function' ? getUnitLabel() : '';
    var amtEl = document.getElementById('lgAmtUnit');
    var balEl = document.getElementById('lgBalUnit');
    if (amtEl) amtEl.textContent = label ? '(' + label + ')' : '';
    if (balEl) balEl.textContent = label ? '(' + label + ')' : '';
}

// ============================================================================
// FORMATTING HELPERS — Use canonical formatAmount/formatPrice/getAmountClass
// ============================================================================

function lgFmt(value) {
    if (value === 0 || value === null || value === undefined) return '-';
    return typeof formatAmount === 'function' ? formatAmount(value) : wmsFmtAmt(value);
}

function lgFmtPrice(value) {
    if (value === 0 || value === null || value === undefined) return '-';
    return typeof formatPrice === 'function' ? formatPrice(value, false) : wmsFmtAmt(value);
}

function lgAmtClass(value) {
    if (value === 0 || value === null || value === undefined) return '';
    return typeof getAmountClass === 'function' ? getAmountClass(value) : (value > 0 ? 'positive' : value < 0 ? 'negative' : '');
}

// ============================================================================
// SYMBOL DISPLAY — Full decoded NFO description
// ============================================================================

function lgFormatSymbol(row) {
    if (row._rowType !== 'trade') return '';
    var source = row._source;
    var sym = source.short_symbol || source.symbol || '';

    // For NFO, show decoded contract: e.g. "MANAPPURAM Mar 26 Fut"
    if (source.security_type === 'NFO' || (source.product && /NFO|F&O|FNO/i.test(source.product))) {
        var contract = typeof wmsFormatContract === 'function' ? wmsFormatContract(source) : '';
        if (contract && contract !== 'Equity' && contract !== 'NFO') {
            return wmsEsc(sym) + ' <span style="color:#718096; font-size:10px;">' + wmsEsc(contract) + '</span>';
        }
    }
    return wmsEsc(sym);
}

// ============================================================================
// TRANSACTION TYPE DISPLAY — Friendly labels with colored badges
// ============================================================================

function lgFormatType(row) {
    var type = '';
    var cssClass = 'lg-type-other';

    if (row._rowType === 'ledger') {
        type = row.entryType || '';
    } else if (row._rowType === 'trade') {
        type = row._source.transaction_type || '';
    }

    var label = LG_TYPE_LABELS[type] || type.replace(/_/g, ' ');
    cssClass = LG_TYPE_CSS[type] || 'lg-type-other';

    return '<span class="lg-type ' + cssClass + '">' + wmsEsc(label) + '</span>';
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

    if (defaultView) {
        var isActive = defaultView.id === lgActiveViewId;
        html += '<button class="tr-view-tab' + (isActive ? ' active' : '') + '" data-view-id="' +
            defaultView.id + '"><span class="tr-tab-star">★</span> ' + wmsEsc(defaultView.name) + '</button>';
    }

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
            input.className = 'wms-input-compact';
            input.style.width = '100px';
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
        list.innerHTML = '<div class="tr-more-empty">No saved views</div>';
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

    ['investor', 'trader', 'broker', 'tag'].forEach(function(type) {
        lgSyncPillStates(type);
        lgRenderSelectedTags(type);
    });

    lgRenderViewTabs();
    lgRenderMoreDropdown();
    lgUpdateViewButtons();
    lgRefresh();
}

// Refresh pill filter items with current reference data
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

function lgSyncPillStates(type) {
    if (type === 'investor' && lgInvPillFilter) lgInvPillFilter.syncStates();
    else if (type === 'trader' && lgTrdPillFilter) lgTrdPillFilter.syncStates();
    else if (type === 'broker' && lgBrkPillFilter) lgBrkPillFilter.syncStates();
    else if ((type === 'tag' || !type) && lgTagPillFilter) lgTagPillFilter.syncStates();
}

function lgRenderSelectedTags(type) {
    if (type === 'investor' && lgInvPillFilter) lgInvPillFilter.renderSelectedTags();
    else if (type === 'trader' && lgTrdPillFilter) lgTrdPillFilter.renderSelectedTags();
    else if (type === 'broker' && lgBrkPillFilter) lgBrkPillFilter.renderSelectedTags();
    else if ((type === 'tag' || !type) && lgTagPillFilter) lgTagPillFilter.renderSelectedTags();
}

async function lgSaveCurrentView(name) {
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
        var prevDefault = lgViews.find(function(v) { return v.is_default; });
        if (prevDefault) {
            await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + prevDefault.id, {
                method: 'PATCH',
                headers: lgHeaders(),
                body: JSON.stringify({ is_default: false })
            });
            prevDefault.is_default = false;
        }

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
    showAlert('Hold Shift + click to confirm delete', 'warning', 3000);
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
        showAlert('View deleted', 'success', 2000);
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
    lgRefreshPillItems();

    var dateFrom = lgDateFrom || '2000-01-01';
    var dateTo = lgDateTo || '2099-12-31';

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

    var filtered = trTransactions.filter(function(t) {
        if (t.dont_display) return false;
        if (!t.transaction_date) return false;
        if (t.transaction_date < dateFrom || t.transaction_date > dateTo) return false;
        if (lgSelectedInvestorIds.length > 0 && lgSelectedInvestorIds.indexOf(t.investor_id) < 0) return false;
        if (lgSelectedTraderIds.length > 0) {
            var tid = t.trader_id || t.investor_id;
            if (!tid || lgSelectedTraderIds.indexOf(tid) < 0) return false;
        }
        if (lgSelectedBrokerIds.length > 0 && lgSelectedBrokerIds.indexOf(t.broker_id) < 0) return false;
        if (lgSelectedTagNames.length > 0) {
            if (!wmsMatchTagsFilter(t.tags || [], lgSelectedTagNames, lgTagFilterLogic)) return false;
        }
        return true;
    });

    lgCombined = wmsBuildLedger(lgLedgerEntries, filtered, {
        investorIds: lgSelectedInvestorIds,
        traderIds: lgSelectedTraderIds,
        brokerIds: lgSelectedBrokerIds,
        tagNames: lgSelectedTagNames,
        tagLogic: lgTagFilterLogic
    });

    lgRenderEntries(lgCombined);
    lgRenderSummary();
}

function lgRenderEntries(rows) {
    var tbody = document.getElementById('lgBody');
    if (!tbody) return;

    // Preserve the new entry row and opening balance row
    var newRow = document.getElementById('lgNewEntryRow');
    var newRowHtml = newRow ? newRow.outerHTML : '';
    var obRow = document.getElementById('lgOpeningBalRow');
    var obRowHtml = obRow ? obRow.outerHTML : '';

    // Sort rows
    var sorted = rows.slice();
    if (lgSortCol) {
        sorted.sort(function(a, b) {
            var va, vb;
            if (lgSortCol === 'date') { va = a.date || ''; vb = b.date || ''; }
            else if (lgSortCol === 'amount') { va = a.amount || 0; vb = b.amount || 0; }
            else if (lgSortCol === 'balance') { va = a._runningBalance || 0; vb = b._runningBalance || 0; }
            else if (lgSortCol === 'qty') {
                va = a._source ? Math.abs(a._source.quantity || 0) : 0;
                vb = b._source ? Math.abs(b._source.quantity || 0) : 0;
            }
            if (va < vb) return lgSortDir === 'asc' ? -1 : 1;
            if (va > vb) return lgSortDir === 'asc' ? 1 : -1;
            return 0;
        });
    }

    // Update sort indicators in header
    document.querySelectorAll('#lgHead th.lg-sortable').forEach(function(th) {
        var indicator = th.querySelector('.sort-indicator');
        if (!indicator) return;
        var col = th.dataset.sort;
        if (col === lgSortCol) {
            indicator.textContent = (lgSortDir === 'asc' ? ' ▲' : ' ▼');
        } else {
            if (col === 'amount' || col === 'balance') {
                var label = typeof getUnitLabel === 'function' ? getUnitLabel() : '';
                indicator.textContent = label ? '(' + label + ')' : '';
            } else {
                indicator.textContent = '';
            }
        }
    });

    // Render opening balance row
    var openingBal = lgFindOpeningBalance();
    lgRenderOpeningBalance(openingBal);

    var html = obRowHtml + newRowHtml;
    var totalAmount = 0;
    var lastBalance = openingBal.amount || 0; // Start with opening balance

    sorted.forEach(function(row) {
        // Skip OPENING_BALANCE ledger entries from the main rows (shown in special row)
        if (row._rowType === 'ledger' && row.entryType === 'OPENING_BALANCE') return;

        var date = formatDate(row.date);
        var symbol = '';
        var typeHtml = '';
        var qty = '';
        var price = '';
        var net = '';
        var amount = '';
        var balance = '';
        var actions = '';

        if (row._rowType === 'ledger') {
            var source = row._source;
            typeHtml = lgFormatType(row);

            if (row.entryType === 'INTEREST_BOOKED') {
                var entryId = source.id;
                amount = '<span style="cursor:pointer; text-decoration:underline;" ondblclick="lgShowInterestDetail(\'' + wmsEsc(entryId) + '\')">' +
                    lgFmt(row.amount) + '</span>';
            } else {
                amount = lgFmt(row.amount);
            }

            // Show reference as symbol for ledger entries
            if (source.reference) {
                symbol = wmsEsc(source.reference);
            }

            balance = lgFmt(row._runningBalance);
            lastBalance = row._runningBalance;

            // Edit/delete — standard icons (D.9: ✏️ edit, 🗑️ delete)
            actions = '<span class="lg-actions">' +
                '<a href="#" onclick="event.preventDefault(); lgEditEntry(\'' + wmsEsc(source.id) + '\');" title="Edit">✏️</a>' +
                '<a href="#" class="lg-del" onclick="event.preventDefault(); lgDeleteEntry(\'' + wmsEsc(source.id) + '\', this);" title="Delete">🗑️</a>' +
                '</span>';
        } else if (row._rowType === 'trade') {
            var source = row._source;
            symbol = lgFormatSymbol(row);
            typeHtml = lgFormatType(row);

            var q = Math.abs(source.quantity || 0);
            if (source.transaction_type === 'SELL' || source.transaction_type === 'RIGHTS_ENTITLEMENT' || source.transaction_type === 'BONUS') {
                q = -q;
            }
            if (q !== 0) {
                qty = typeof formatQuantity === 'function' ? formatQuantity(q) : String(Math.round(q));
            }

            price = source.price ? lgFmtPrice(source.price) : '';

            if (source.quantity && source.net_amount) {
                var netPerUnit = source.net_amount / source.quantity;
                net = lgFmtPrice(netPerUnit);
            }

            amount = lgFmt(row.amount);
            balance = lgFmt(row._runningBalance);
            lastBalance = row._runningBalance;
        }

        var amtClass = lgAmtClass(row.amount);
        var balClass = lgAmtClass(row._runningBalance);

        html += '<tr>' +
            '<td>' + date + '</td>' +
            '<td>' + symbol + (actions ? ' ' + actions : '') + '</td>' +
            '<td>' + typeHtml + '</td>' +
            '<td class="text-right">' + qty + '</td>' +
            '<td class="text-right">' + price + '</td>' +
            '<td class="text-right">' + net + '</td>' +
            '<td class="text-right ' + amtClass + '">' + amount + '</td>' +
            '<td class="text-right ' + balClass + '">' + balance + '</td>' +
            '</tr>';

        totalAmount += row.amount;
    });

    tbody.innerHTML = html;

    // Re-attach opening balance click handler
    lgAttachObClickHandler();

    // Update totals in tfoot
    var totalAmtEl = document.getElementById('lgTotalAmount');
    var totalBalEl = document.getElementById('lgTotalBalance');
    if (totalAmtEl) {
        totalAmtEl.innerHTML = lgFmt(totalAmount);
        totalAmtEl.className = 'text-right ' + lgAmtClass(totalAmount);
        totalAmtEl.style.fontWeight = '600';
    }
    if (totalBalEl) {
        totalBalEl.innerHTML = lgFmt(lastBalance);
        totalBalEl.className = 'text-right ' + lgAmtClass(lastBalance);
        totalBalEl.style.fontWeight = '600';
    }
}

// ============================================================================
// OPENING BALANCE — Editable row at top of transactions table
// ============================================================================

function lgFindOpeningBalance() {
    // Find OPENING_BALANCE ledger entry for the active investor filter
    var ob = lgLedgerEntries.find(function(e) {
        return e.entry_type === 'OPENING_BALANCE';
    });
    if (ob) {
        return { id: ob.id, date: ob.entry_date, amount: parseFloat(ob.amount) || 0, exists: true };
    }
    // Also check in lgCombined for opening balance rows
    var obRow = lgCombined.find(function(r) {
        return r._rowType === 'ledger' && r.entryType === 'OPENING_BALANCE';
    });
    if (obRow) {
        return { id: obRow._source.id, date: obRow.date, amount: obRow.amount, exists: true };
    }
    return { id: null, date: '', amount: 0, exists: false };
}

function lgRenderOpeningBalance(ob) {
    var dateEl = document.getElementById('lgObDate');
    var amountEl = document.getElementById('lgObAmount');
    var balanceEl = document.getElementById('lgObBalance');

    if (dateEl) {
        dateEl.textContent = ob.date ? (typeof formatDate === 'function' ? formatDate(ob.date) : ob.date) : '';
    }
    if (amountEl) {
        if (lgObEditing) return; // Don't overwrite while editing
        var amtHtml = ob.exists ?
            '<span class="lg-ob-amount" title="Double-click to edit">' + lgFmt(ob.amount) + '</span>' :
            '<span class="lg-ob-amount" style="color:#9ca3af;" title="Double-click to set opening balance">Set...</span>';
        amountEl.innerHTML = amtHtml;
        amountEl.className = 'text-right ' + lgAmtClass(ob.amount);
    }
    if (balanceEl) {
        balanceEl.innerHTML = lgFmt(ob.amount);
        balanceEl.className = 'text-right ' + lgAmtClass(ob.amount);
    }
}

function lgAttachObClickHandler() {
    var amountEl = document.getElementById('lgObAmount');
    if (!amountEl) return;
    var obSpan = amountEl.querySelector('.lg-ob-amount');
    if (obSpan) {
        obSpan.addEventListener('dblclick', function(e) {
            e.preventDefault();
            lgStartObEdit();
        });
    }
}

function lgStartObEdit() {
    lgObEditing = true;
    var amountEl = document.getElementById('lgObAmount');
    if (!amountEl) return;

    var ob = lgFindOpeningBalance();
    var currentVal = ob.amount || 0;

    amountEl.innerHTML = '<span class="lg-ob-edit">' +
        '<input type="number" step="0.01" value="' + currentVal + '" class="wms-input-compact wms-input-number" id="lgObEditInput">' +
        '<button class="lg-ob-save" onclick="lgSaveOpeningBalance()">✓</button>' +
        '<button class="lg-ob-cancel" onclick="lgCancelObEdit()">✕</button>' +
        '</span>';

    var input = document.getElementById('lgObEditInput');
    if (input) {
        input.focus();
        input.select();
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); lgSaveOpeningBalance(); }
            if (e.key === 'Escape') { e.preventDefault(); lgCancelObEdit(); }
        });
    }
}

function lgCancelObEdit() {
    lgObEditing = false;
    var ob = lgFindOpeningBalance();
    lgRenderOpeningBalance(ob);
    lgAttachObClickHandler();
}

async function lgSaveOpeningBalance() {
    var input = document.getElementById('lgObEditInput');
    if (!input) return;
    var newAmount = parseFloat(input.value) || 0;

    var ob = lgFindOpeningBalance();
    var investorId = lgSelectedInvestorIds.length > 0 ? lgSelectedInvestorIds[0] : null;

    if (!investorId) {
        showAlert('Please select an investor filter first', 'warning', 3000);
        lgCancelObEdit();
        return;
    }

    try {
        if (ob.exists && ob.id) {
            // Update existing opening balance
            await fetch(SUPABASE_URL + '/rest/v1/ledger_entries?id=eq.' + ob.id, {
                method: 'PATCH',
                headers: lgHeaders(),
                body: JSON.stringify({ amount: newAmount })
            });
        } else {
            // Create new opening balance entry
            var entryDate = lgDateFrom || new Date().toISOString().slice(0, 10);
            await fetch(SUPABASE_URL + '/rest/v1/ledger_entries', {
                method: 'POST',
                headers: lgHeaders(),
                body: JSON.stringify({
                    investor_id: investorId,
                    entry_date: entryDate,
                    entry_type: 'OPENING_BALANCE',
                    amount: newAmount,
                    reference: 'Opening Balance',
                    notes: ''
                })
            });
        }
        lgObEditing = false;
        showAlert('Opening balance saved', 'success', 2000);
        lgRefresh();
    } catch (err) {
        console.warn('Failed to save opening balance:', err.message);
        showAlert('Failed to save opening balance', 'error', 3000);
        lgCancelObEdit();
    }
}

// ============================================================================
// SUMMARY RENDERING
// ============================================================================

function lgRenderSummary() {
    var summaryBody = document.getElementById('lgSummaryBody');
    if (!summaryBody) return;

    // Summary uses ALL transactions (ignoring date filter) but respects
    // investor/trader/broker/tag filters to show current portfolio holdings
    var allFiltered = trTransactions.filter(function(t) {
        if (t.dont_display) return false;
        if (!t.transaction_date) return false;
        if (lgSelectedInvestorIds.length > 0 && lgSelectedInvestorIds.indexOf(t.investor_id) < 0) return false;
        if (lgSelectedTraderIds.length > 0) {
            var tid = t.trader_id || t.investor_id;
            if (!tid || lgSelectedTraderIds.indexOf(tid) < 0) return false;
        }
        if (lgSelectedBrokerIds.length > 0 && lgSelectedBrokerIds.indexOf(t.broker_id) < 0) return false;
        if (lgSelectedTagNames.length > 0) {
            if (!wmsMatchTagsFilter(t.tags || [], lgSelectedTagNames, lgTagFilterLogic)) return false;
        }
        return true;
    });

    // Sort by date for FIFO processing
    var sorted = allFiltered.slice().sort(function(a, b) {
        return (a.transaction_date || '').localeCompare(b.transaction_date || '');
    });

    // Use shared FIFO engine (wms-shared.js)
    var fifo = wmsCalcFifoCost(sorted);
    var holdingsMap = fifo.holdings;

    // Build source lookup for NFO symbol decoding (keyed same as engine: symbol+'-'+exchange)
    var sourceLookup = {};
    for (var si = 0; si < sorted.length; si++) {
        var st = sorted[si];
        var sKey = (st.symbol || '') + '-' + (st.exchange || '');
        if (!sourceLookup[sKey]) sourceLookup[sKey] = st;
    }

    // Build holdings table rows
    var totalCost = 0;
    var totalValue = 0;

    var rows = Object.keys(holdingsMap).map(function(key) {
        var h = holdingsMap[key];
        if (h.quantity === 0) return '';

        var qty = h.quantity;
        var cost = h.totalCost;
        var fifoCost = h.avgCost;
        var cmp = fifoCost;  // CMP placeholder — no live price in ledger context
        var value = qty * cmp;

        totalCost += cost;
        totalValue += value;

        var mtm = value - cost;
        var mtmClass = lgAmtClass(mtm);

        // Type label
        var typeLabel = (h.securityType === 'NFO') ? 'NFO' : 'EQ';

        // Symbol display — decode NFO symbols via wmsFormatContract
        var symHtml;
        var shortSym = h.shortSymbol || h.symbol;
        var srcTxn = sourceLookup[key];
        if (srcTxn && h.securityType === 'NFO' && typeof wmsFormatContract === 'function') {
            var contract = wmsFormatContract(srcTxn);
            if (contract && contract !== 'Equity' && contract !== 'NFO') {
                symHtml = wmsEsc(shortSym) + ' <span style="color:#718096; font-size:10px;">' + wmsEsc(contract) + '</span>';
            } else {
                symHtml = wmsEsc(shortSym);
            }
        } else {
            symHtml = wmsEsc(shortSym);
        }

        return '<tr>' +
            '<td>' + symHtml + '</td>' +
            '<td class="text-right">' + wmsEsc(typeLabel) + '</td>' +
            '<td class="text-right">' + (typeof formatQuantity === 'function' ? formatQuantity(qty) : String(Math.round(qty))) + '</td>' +
            '<td class="text-right">' + lgFmtPrice(fifoCost) + '</td>' +
            '<td class="text-right">' + lgFmtPrice(cmp) + '</td>' +
            '<td class="text-right ' + mtmClass + '">' + lgFmt(mtm) + '</td>' +
            '<td class="text-right">' + lgFmt(value) + '</td>' +
            '</tr>';
    }).filter(function(s) { return s.length > 0; }).join('');

    if (rows.length === 0) {
        rows = '<tr><td colspan="7" class="text-center" style="padding:20px; color:#9ca3af;">No holdings</td></tr>';
    }

    summaryBody.innerHTML = rows;

    // Update summary totals — outstanding = total cost of current holdings
    var outstanding = totalCost;

    var holdingsValueEl = document.getElementById('lgHoldingsValue');
    var mtmFnoEl = document.getElementById('lgMtmFno');
    var outstandingEl = document.getElementById('lgOutstanding');
    var potentialTaxEl = document.getElementById('lgPotentialTax');
    var netValueEl = document.getElementById('lgNetValue');

    if (holdingsValueEl) {
        holdingsValueEl.innerHTML = lgFmt(totalValue);
        holdingsValueEl.className = 'text-right positive';
        holdingsValueEl.style.fontWeight = '600';
    }
    if (mtmFnoEl) mtmFnoEl.textContent = '-';
    if (outstandingEl) outstandingEl.innerHTML = lgFmt(Math.abs(outstanding));

    var taxRate = 0;
    var potentialTax = (totalValue - totalCost) * (taxRate / 100);
    if (potentialTaxEl) potentialTaxEl.innerHTML = lgFmt(potentialTax);

    var netValue = totalValue - Math.abs(outstanding) - potentialTax;

    if (netValueEl) {
        netValueEl.innerHTML = lgFmt(netValue);
        netValueEl.className = 'text-right ' + lgAmtClass(netValue);
        netValueEl.style.fontWeight = '600';
    }
}

// ============================================================================
// LEDGER ENTRY MANAGEMENT
// ============================================================================

async function lgAddEntry() {
    var entryDate = lgNewDateInput ? lgNewDateInput.getValue() : '';
    var typeEl = document.getElementById('lgNewType');
    var refEl = document.getElementById('lgNewReference');
    var amtEl = document.getElementById('lgNewAmount');

    var entryType = typeEl ? typeEl.value : 'ADJUSTMENT';
    var reference = refEl ? refEl.value : '';
    var amount = parseFloat(amtEl ? amtEl.value : '0') || 0;

    if (!entryDate || !amount) {
        showAlert('Please fill in date and amount', 'warning', 3000);
        return;
    }

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
            if (lgNewDateInput) lgNewDateInput.clear();
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

// Inline delete confirmation — replaces browser confirm()
async function lgDeleteEntry(entryId, linkEl) {
    if (lgPendingDeleteId === entryId) {
        lgPendingDeleteId = null;
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
        return;
    }

    lgPendingDeleteId = entryId;
    var actionsSpan = linkEl ? linkEl.closest('.lg-actions') : null;
    if (actionsSpan) {
        var confirmHtml = '<span class="lg-confirm-bar">Delete? ' +
            '<button class="lg-confirm-yes" onclick="event.preventDefault(); lgDeleteEntry(\'' + wmsEsc(entryId) + '\');">Yes</button>' +
            '<button onclick="event.preventDefault(); lgCancelDelete();">No</button>' +
            '</span>';
        actionsSpan.insertAdjacentHTML('afterend', confirmHtml);
    }

    setTimeout(function() {
        if (lgPendingDeleteId === entryId) {
            lgCancelDelete();
        }
    }, 5000);
}

function lgCancelDelete() {
    lgPendingDeleteId = null;
    document.querySelectorAll('.lg-confirm-bar').forEach(function(el) { el.remove(); });
}

// ============================================================================
// INTEREST CALCULATION & POSTING
// ============================================================================

async function lgShowInterestDetail(entryId) {
    var entry = lgLedgerEntries.find(function(e) { return e.id === entryId; });
    if (!entry || entry.entry_type !== 'INTEREST_BOOKED') return;

    lgInterestDetailEntryId = entryId;

    var investorId = entry.investor_id;
    var interestTerms = wmsGetInterestTerms(investorId);

    if (!interestTerms) {
        showAlert('No interest terms configured', 'warning', 3000);
        return;
    }

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

    var detailBody = document.getElementById('lgInterestDetailBody');
    var totalEditEl = document.getElementById('lgInterestTotalEdit');

    if (detailBody) {
        detailBody.innerHTML = '<tr><td colspan="5" class="text-center" style="padding:20px;">Detail calculation would go here</td></tr>';
    }

    if (totalEditEl) {
        totalEditEl.value = entry.amount;
    }

    lgShowModal('lgInterestDetail');
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

        lgHideModal('lgInterestDetail');
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
    return wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'});
}

// ============================================================================
// WINDOW EXPORTS
// ============================================================================

window.lgInit = lgInit;
window.lgRefresh = lgRefresh;
window.lgRefreshPillItems = lgRefreshPillItems;
window.lgEditEntry = lgEditEntry;
window.lgDeleteEntry = lgDeleteEntry;
window.lgCancelDelete = lgCancelDelete;
window.lgShowInterestDetail = lgShowInterestDetail;
window.lgAddEntry = lgAddEntry;
window.lgPostInterest = lgPostInterest;
window.lgApplyView = lgApplyView;
window.lgLoadViews = lgLoadViews;
window.lgSaveOpeningBalance = lgSaveOpeningBalance;
window.lgCancelObEdit = lgCancelObEdit;
