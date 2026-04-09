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

// Carry-forward (computed running balance as of dateFrom - 1) — drives the opening balance row
var lgCarryForwardBalance = 0;
var lgCurrentCashBalance = 0; // End-of-history running balance (for summary)
var lgCarryForwardDate = '';

// Pending (not yet posted) weekly interest rows — generated each refresh
var lgPendingInterestRows = [];

// Key of the pending row currently open in the interest detail modal (for commit)
var lgPendingModalKey = null;

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

    // Delegated row/cell click handler:
    //   trade row          → open shared trading edit modal (same as Portfolio/Transactions)
    //   interest amount    → open interest detail modal (posted or pending)
    var lgBodyEl = document.getElementById('lgBody');
    if (lgBodyEl) {
        lgBodyEl.addEventListener('click', function(e) {
            // Interest amount span (posted or pending) → open detail modal
            var intAmt = e.target.closest('.lg-int-amt');
            if (intAmt) {
                var tr2 = intAmt.closest('tr');
                if (tr2 && tr2.classList.contains('lg-row-pending')) {
                    lgShowPendingInterestDetail(tr2.getAttribute('data-pending-key'));
                }
                // Posted-row click already has inline onclick → lgShowInterestDetail
                return;
            }
            // Ignore clicks on interactive children (buttons, links, inputs, etc.)
            if (e.target.closest('button, a, input, select, .lg-actions, .lg-confirm-bar, .lg-ob-edit')) return;
            var tr = e.target.closest('tr.lg-row-trade');
            if (!tr) return;
            var txnId = tr.getAttribute('data-txn-id');
            if (txnId && typeof trOpenEditModal === 'function') {
                trOpenEditModal(txnId);
            }
        });
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

// Ledger-only date format: "Wed, 09-Apr-26"
// (we don't touch the global formatDate to avoid changing the rest of the app)
function lgFmtDate(dateStr) {
    if (!dateStr) return '';
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var dayName = days[d.getDay()];
    var dd = String(d.getDate()).padStart(2, '0');
    var mon = months[d.getMonth()];
    var yy = String(d.getFullYear()).slice(-2);
    return dayName + ', ' + dd + '-' + mon + '-' + yy;
}

// ============================================================================
// SYMBOL DISPLAY — Full decoded NFO description
// ============================================================================

function lgFormatSymbol(row) {
    if (row._rowType !== 'trade') return '';
    var source = row._source;
    var sym = source.short_symbol || source.symbol || '';

    // Build tooltip: full symbol + company name + exchange (watchlist pattern)
    var tipParts = [];
    if (source.symbol && source.symbol !== sym) tipParts.push(source.symbol);
    if (source.company_name) tipParts.push(source.company_name);
    if (source.exchange) tipParts.push(source.exchange);
    var tooltip = tipParts.length > 0 ? (sym + ' — ' + tipParts.join(' · ')) : sym;

    var inner;
    // For NFO, show decoded contract: e.g. "MANAPPURAM 30 Mar 26 Fut"
    if (source.security_type === 'NFO' || (source.product && /NFO|F&O|FNO/i.test(source.product))) {
        var contract = typeof wmsFormatContract === 'function' ? wmsFormatContract(source) : '';
        if (contract && contract !== 'Equity' && contract !== 'NFO') {
            inner = wmsEsc(sym) + ' <span style="color:#718096; font-size:10px;">' + wmsEsc(contract) + '</span>';
        } else {
            inner = wmsEsc(sym);
        }
    } else {
        inner = wmsEsc(sym);
    }

    return '<span title="' + wmsEsc(tooltip) + '">' + inner + '</span>';
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

    // Pull ALL ledger entries respecting non-date filters (investor OR trader).
    // Running balance must be correct from history; we slice the display to
    // [dateFrom, dateTo] only AFTER computing the running balance, so that a
    // mid-FY filter (e.g. 01-Jul onwards) shows the correct carry-forward
    // opening balance as of 30-Jun. OPENING_BALANCE ledger entries are treated
    // as pre-period state (rolled into carry-forward, not displayed as rows).
    //
    // Trader filters resolve against investor_id (trader_id == investor_id in
    // the same UUID namespace). wmsBuildLedger applies the same filter again
    // defensively, so loading a superset here is safe.
    var entityIds = [];
    if (lgSelectedInvestorIds.length > 0) {
        entityIds = lgSelectedInvestorIds.slice();
    } else if (lgSelectedTraderIds.length > 0) {
        entityIds = lgSelectedTraderIds.slice();
    }
    var allQuery = '';
    if (entityIds.length > 0) {
        allQuery += 'investor_id.in.(' + entityIds.map(function(id) { return '"' + id + '"'; }).join(',') + ')';
    }

    try {
        var url = SUPABASE_URL + '/rest/v1/ledger_entries?select=*' + (allQuery ? '&' + allQuery : '') + '&order=entry_date.asc';
        var resp = await fetch(url, { headers: lgHeaders() });
        lgLedgerEntries = resp.ok ? await resp.json() : [];
    } catch (err) {
        console.warn('Failed to fetch ledger entries:', err.message);
        lgLedgerEntries = [];
    }

    // Filter transactions by non-date filters (investor/trader/broker/tags) — NO date filter yet.
    var txnFiltered = trTransactions.filter(function(t) {
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

    // Build full-history ledger — running balance computed across ALL time.
    var fullCombined = wmsBuildLedger(lgLedgerEntries, txnFiltered, {
        investorIds: lgSelectedInvestorIds,
        traderIds: lgSelectedTraderIds,
        brokerIds: lgSelectedBrokerIds,
        tagNames: lgSelectedTagNames,
        tagLogic: lgTagFilterLogic
    });

    // ------------------------------------------------------------------
    // PENDING INTEREST ROWS — generate Saturdays between last-posted and today
    // for weekly_friday terms, including F&O margin in the Friday base.
    // These rows are injected into fullCombined so running balance flows naturally
    // but are marked _isPending so they render with a Commit button and are not
    // in the database yet.
    // ------------------------------------------------------------------
    lgPendingInterestRows = [];
    // Resolve to a single effective investor ID — works for either investor
    // filter (length 1) or trader-only filter (length 1, trader_id == investor_id).
    var effInvId = lgGetEffectiveInvestorId();
    if (effInvId) {
        var invId = effInvId;
        var terms = wmsGetInterestTerms(invId);
        if (terms && terms.frequency === 'weekly_friday' && terms.rate > 0) {
            // Last posted Saturday = max entry_date of INTEREST_BOOKED for this investor
            var lastPosted = null;
            for (var li = 0; li < lgLedgerEntries.length; li++) {
                var le = lgLedgerEntries[li];
                if (le.entry_type === 'INTEREST_BOOKED' && le.investor_id === invId) {
                    if (!lastPosted || le.entry_date > lastPosted) lastPosted = le.entry_date;
                }
            }
            // Start window = (last posted + 1 day) OR the earliest activity date OR FY start
            var genFrom;
            if (lastPosted) {
                var lpDate = new Date(lastPosted);
                lpDate.setDate(lpDate.getDate() + 1);
                genFrom = lpDate.toISOString().slice(0, 10);
            } else {
                // Use the earliest row date; if nothing, use today
                genFrom = fullCombined.length > 0 ? fullCombined[0].date : new Date().toISOString().slice(0, 10);
            }
            var today = new Date().toISOString().slice(0, 10);
            if (genFrom <= today) {
                // Compute margin events from NFO transactions (full history)
                var nfoTxns = txnFiltered.filter(function(t) {
                    var p = (t.product || '').toUpperCase();
                    var s = (t.security_type || '').toUpperCase();
                    return /F&O|FNO|NFO/.test(p) || /F&O|FNO|NFO/.test(s);
                }).sort(function(a, b) {
                    return (a.transaction_date || '').localeCompare(b.transaction_date || '');
                });
                var marginEvents = wmsCalcMarginFIFO(nfoTxns);

                var periods = wmsCalcInterestWeeklyFriday(fullCombined, terms, genFrom, today, marginEvents);
                // Skip zero-interest rows entirely (user §8.3)
                for (var pi = 0; pi < periods.length; pi++) {
                    var p = periods[pi];
                    if (p.interest <= 0) continue;

                    // Build a synthetic "pending" row
                    var pendingRow = {
                        _rowType: 'pending_interest',
                        _isPending: true,
                        _pendingKey: 'pi_' + p.postDate,
                        _calc: p,
                        date: p.postDate,
                        sortKey: p.postDate + '|0|_pending_' + p.postDate,
                        entryType: 'INTEREST_BOOKED',
                        amount: p.interest,
                        investorId: invId,
                        reference: 'Weekly interest ' + p.period,
                        notes: ''
                    };
                    fullCombined.push(pendingRow);
                    lgPendingInterestRows.push(pendingRow);
                }

                // Re-sort and recompute running balance so pending rows flow into it.
                // (Mirrors wmsBuildLedger's reset-on-OPENING_BALANCE semantic.)
                if (lgPendingInterestRows.length > 0) {
                    fullCombined.sort(function(a, b) {
                        return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
                    });
                    var bal = 0;
                    for (var fi = 0; fi < fullCombined.length; fi++) {
                        var fr = fullCombined[fi];
                        if (fr._rowType === 'ledger' && fr.entryType === 'OPENING_BALANCE') {
                            bal = fr.amount;
                        } else {
                            bal += fr.amount;
                        }
                        fr._runningBalance = wmsRoundMoney(bal);
                    }
                }
            }
        }
    }

    // Derive carry-forward balance: everything strictly before dateFrom PLUS
    // any OPENING_BALANCE entry (always treated as pre-period state regardless
    // of date — by definition an opening balance is the period's starting cash,
    // never a regular row in the body of the ledger).
    var carry = 0;
    var displayed = [];
    for (var i = 0; i < fullCombined.length; i++) {
        var r = fullCombined[i];
        var isOpeningBalance = (r._rowType === 'ledger' && r.entryType === 'OPENING_BALANCE');
        if (r.date < dateFrom || isOpeningBalance) {
            carry = r._runningBalance;
        } else if (r.date >= dateFrom && r.date <= dateTo) {
            displayed.push(r);
        }
    }
    lgCarryForwardBalance = carry;
    lgCarryForwardDate = dateFrom;
    lgCombined = displayed;
    // Current cash balance = last running balance across full history (used by Summary)
    lgCurrentCashBalance = fullCombined.length > 0 ? fullCombined[fullCombined.length - 1]._runningBalance : 0;

    lgRenderEntries(lgCombined);
    lgRenderSummary();
    lgUpdateAddRowAvailability();
}

function lgRenderEntries(rows) {
    var tbody = document.getElementById('lgBody');
    if (!tbody) return;

    // Preserve the new entry row and opening balance row as LIVE DOM nodes,
    // not as HTML strings — re-inserting their outerHTML would replace them
    // with fresh nodes and orphan the wmsDateInput controller bound to the
    // original DOM (event listeners would be lost). See bug: ledger add-row
    // date field stops responding to clicks/keys after first refresh.
    var newRow = document.getElementById('lgNewEntryRow');
    var obRow = document.getElementById('lgOpeningBalRow');
    if (newRow && newRow.parentNode === tbody) tbody.removeChild(newRow);
    if (obRow && obRow.parentNode === tbody) tbody.removeChild(obRow);

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

    // Compute opening balance up front (used to seed running balance below).
    // The actual lgRenderOpeningBalance() call MUST happen AFTER obRow is
    // re-attached to the DOM — otherwise getElementById('lgObDate') etc.
    // can't find the (currently detached) child elements.
    var openingBal = lgFindOpeningBalance();

    var html = '';
    var totalAmount = 0;
    var lastBalance = openingBal.amount || 0; // Start with opening balance (carry-forward)

    sorted.forEach(function(row) {
        var date = lgFmtDate(row.date);
        var symbol = '';
        var typeHtml = '';
        var qty = '';
        var price = '';
        var net = '';
        var amount = '';
        var balance = '';
        var actions = '';

        if (row._rowType === 'pending_interest') {
            // Synthetic, unposted weekly interest row
            typeHtml = '<span class="lg-type lg-type-income">Interest (pending)</span>';
            symbol = wmsEsc(row.reference || '');
            amount = '<span class="lg-int-amt" title="Click to view calculation / edit">' + lgFmt(row.amount) + '</span>';
            balance = lgFmt(row._runningBalance);
            lastBalance = row._runningBalance;
            actions = '<span class="lg-actions">' +
                '<a href="#" class="lg-commit-int" onclick="event.preventDefault(); lgCommitPendingInterest(\'' + wmsEsc(row._pendingKey) + '\');" title="Commit this interest row">✓ Commit</a>' +
                '</span>';
        } else if (row._rowType === 'ledger') {
            var source = row._source;
            typeHtml = lgFormatType(row);

            if (row.entryType === 'INTEREST_BOOKED') {
                var entryId = source.id;
                amount = '<span class="lg-int-amt" onclick="event.preventDefault(); lgShowInterestDetail(\'' + wmsEsc(entryId) + '\');" title="Click to view calculation / edit">' +
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

        // Trade rows are clickable → open shared trading edit modal
        var trAttrs = '';
        if (row._rowType === 'trade' && row._source && row._source.id) {
            trAttrs = ' class="lg-row-trade" data-txn-id="' + wmsEsc(row._source.id) + '"';
        } else if (row._rowType === 'pending_interest') {
            trAttrs = ' class="lg-row-pending" data-pending-key="' + wmsEsc(row._pendingKey) + '"';
        }

        html += '<tr' + trAttrs + '>' +
            '<td class="text-right">' + date + '</td>' +
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

    // Wipe dynamic rows; re-insert preserved nodes (DOM-identity intact, so
    // wmsDateInput controller still has live event listeners) then dynamic html.
    tbody.innerHTML = '';
    if (newRow) tbody.appendChild(newRow);
    if (obRow) tbody.appendChild(obRow);
    if (html) tbody.insertAdjacentHTML('beforeend', html);

    // Now that obRow is back in the DOM, render the opening balance values
    // and re-attach the click handler.
    lgRenderOpeningBalance(openingBal);
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
    // Opening balance row now always shows the computed carry-forward as of dateFrom.
    // We still surface the stored OPENING_BALANCE entry (if any) so the inline
    // edit UI can update it — but the DISPLAYED amount is always the carry-forward.
    var stored = lgLedgerEntries.find(function(e) {
        return e.entry_type === 'OPENING_BALANCE';
    });
    return {
        id: stored ? stored.id : null,
        // Display date = the "as of" date, which is the period start
        date: lgCarryForwardDate || (stored ? stored.entry_date : ''),
        amount: lgCarryForwardBalance,
        storedAmount: stored ? (parseFloat(stored.amount) || 0) : 0,
        storedDate: stored ? stored.entry_date : '',
        isCarryForward: !!(stored && stored.entry_date < lgCarryForwardDate),
        exists: !!stored
    };
}

function lgRenderOpeningBalance(ob) {
    var dateEl = document.getElementById('lgObDate');
    var amountEl = document.getElementById('lgObAmount');
    var balanceEl = document.getElementById('lgObBalance');

    if (dateEl) {
        dateEl.textContent = ob.date ? lgFmtDate(ob.date) : '';
    }
    if (amountEl) {
        if (lgObEditing) return; // Don't overwrite while editing
        // Editable only when the displayed date equals the stored OPENING_BALANCE's
        // entry_date — i.e. we're viewing the actual FY-start opening.
        // For any later window (mid-FY filter), the value is a computed carry-forward
        // and must not be editable.
        var isEditable = !ob.isCarryForward && (!ob.exists || ob.storedDate === ob.date);
        var amtHtml;
        if (isEditable) {
            amtHtml = ob.exists ?
                '<span class="lg-ob-amount" title="Double-click to edit">' + lgFmt(ob.amount) + '</span>' :
                '<span class="lg-ob-amount" style="color:#9ca3af;" title="Double-click to set opening balance">Set...</span>';
        } else {
            amtHtml = '<span title="Carry-forward running balance as of ' + wmsEsc(ob.date) + ' (not editable)">' + lgFmt(ob.amount) + '</span>';
        }
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

// Tax rate on booked gains — TODO: make configurable via DB / investor table
var LG_TAX_RATE_PCT = 12.5;

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
    var allGains = fifo.gains || [];

    // Build source lookup for NFO symbol decoding (keyed same as engine: symbol+'-'+exchange)
    var sourceLookup = {};
    for (var si = 0; si < sorted.length; si++) {
        var st = sorted[si];
        var sKey = (st.symbol || '') + '-' + (st.exchange || '');
        if (!sourceLookup[sKey]) sourceLookup[sKey] = st;
    }

    // Compute NFO running margin (final value = current open margin)
    var nfoTxnsForMargin = sorted.filter(function(t) {
        var p = (t.product || '').toUpperCase();
        var s = (t.security_type || '').toUpperCase();
        return /F&O|FNO|NFO/.test(p) || /F&O|FNO|NFO/.test(s);
    });
    var marginEvents = wmsCalcMarginFIFO(nfoTxnsForMargin);
    var currentNfoMargin = marginEvents.length > 0 ? marginEvents[marginEvents.length - 1].runningMargin : 0;

    // ------------------------------------------------------------
    // Build holdings table rows — split EQ vs NFO
    //   EQ:  Value = Qty × CMP, MTM = Value − Cost
    //   NFO: Value = 0, MTM only (from live price vs trade price)
    // ------------------------------------------------------------
    var totalEqCost = 0;
    var totalEqValue = 0;
    var totalEqMtm = 0;
    var totalNfoMtm = 0;

    var rowsHtml = Object.keys(holdingsMap).map(function(key) {
        var h = holdingsMap[key];
        if (h.quantity === 0) return '';

        var qty = h.quantity;
        var cost = h.totalCost;
        var avgCost = h.avgCost;
        var isNfo = (h.securityType === 'NFO');

        // CMP from shared live price cache
        var shortSym = h.shortSymbol || h.symbol;
        var priceEntry = (typeof wmsLivePrices === 'object' && wmsLivePrices) ? wmsLivePrices[shortSym] : null;
        var cmp = (priceEntry && priceEntry.lp > 0) ? priceEntry.lp : avgCost;

        var value, mtm;
        if (isNfo) {
            value = 0; // Per spec: NFO Value = 0, MTM only
            mtm = (cmp - avgCost) * qty;
            totalNfoMtm += mtm;
        } else {
            value = qty * cmp;
            mtm = value - cost;
            totalEqCost += cost;
            totalEqValue += value;
            totalEqMtm += mtm;
        }

        var mtmClass = lgAmtClass(mtm);
        var typeLabel = isNfo ? 'NFO' : 'EQ';

        // Symbol display — decode NFO contracts via shared formatter
        var symHtml;
        var srcTxn = sourceLookup[key];
        if (srcTxn && isNfo && typeof wmsFormatContract === 'function') {
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
            '<td class="text-right">' + typeLabel + '</td>' +
            '<td class="text-right">' + (typeof formatQuantity === 'function' ? formatQuantity(qty) : String(Math.round(qty))) + '</td>' +
            '<td class="text-right">' + lgFmtPrice(avgCost) + '</td>' +
            '<td class="text-right">' + lgFmtPrice(cmp) + '</td>' +
            '<td class="text-right ' + mtmClass + '">' + lgFmt(mtm) + '</td>' +
            '<td class="text-right">' + lgFmt(value) + '</td>' +
            '</tr>';
    }).filter(function(s) { return s.length > 0; }).join('');

    if (!rowsHtml) {
        rowsHtml = '<tr><td colspan="7" class="text-center" style="padding:20px; color:#9ca3af;">No holdings</td></tr>';
    }
    summaryBody.innerHTML = rowsHtml;

    // Table footer totals
    var totalMtm = totalEqMtm + totalNfoMtm;
    var mtmTotalEl = document.getElementById('lgSummaryMtmTotal');
    var valTotalEl = document.getElementById('lgSummaryValueTotal');
    if (mtmTotalEl) {
        mtmTotalEl.innerHTML = lgFmt(totalMtm);
        mtmTotalEl.className = 'text-right ' + lgAmtClass(totalMtm);
    }
    if (valTotalEl) valTotalEl.innerHTML = lgFmt(totalEqValue);

    // ------------------------------------------------------------
    // Summary cards
    //   Carry-forward balance (end of ledger) = current cash balance.
    //   Outstanding = |cash balance (negative means investor owes)| + NFO margin.
    // ------------------------------------------------------------
    // Current cash balance: use last running balance of full combined list (already
    // computed in lgRefresh via lgCombinedFullBal — fall back to carry-forward).
    var cashBalance = (typeof lgCurrentCashBalance === 'number') ? lgCurrentCashBalance : (lgCarryForwardBalance || 0);
    // Negative cash balance means investor owes us (receivable). Outstanding is shown as
    // positive magnitude of what's owed. If cash balance is positive, investor has credit.
    var outstanding = Math.max(0, -cashBalance) + currentNfoMargin;

    // Current FY bounds — fixed Apr-Mar cadence per user instruction
    var today = new Date();
    var curY = today.getFullYear();
    var curM = today.getMonth() + 1;
    var fyStartYear = (curM >= 4) ? curY : curY - 1;
    var fyStartStr = fyStartYear + '-04-01';
    var fyEndStr = (fyStartYear + 1) + '-03-31';
    var fyLabel = '(FY ' + fyStartYear + '-' + String(fyStartYear + 1).slice(-2) + ')';

    // Booked P&L for current FY — sum of gains with sellDate within FY
    var fyGains = allGains.filter(function(g) {
        return g.sellDate && g.sellDate >= fyStartStr && g.sellDate <= fyEndStr;
    });
    var totalBookedGain = 0;
    fyGains.forEach(function(g) { totalBookedGain += (g.gain || 0); });

    var potentialTax = Math.max(0, totalBookedGain) * (LG_TAX_RATE_PCT / 100);

    // Net receivable = holdings value + MTM − outstanding − potential tax
    // Holdings value is EQ only (NFO is 0). MTM already embedded in EQ value via CMP,
    // so for NFO we add totalNfoMtm separately.
    var netReceivable = totalEqValue + totalNfoMtm - outstanding - potentialTax;
    var balNoMtm = totalEqCost + 0 - outstanding; // EQ at cost, NFO 0, minus outstanding
    var pctOutstanding = outstanding > 0 ? ((totalEqValue + totalNfoMtm) / outstanding) * 100 : 0;

    function setCard(id, val, useAmtClass) {
        var el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = lgFmt(val);
        if (useAmtClass) el.className = 'lg-summary-card-value ' + lgAmtClass(val);
    }
    setCard('lgCardHoldingsValue', totalEqValue, false);
    setCard('lgCardOutstanding', outstanding, false);
    setCard('lgCardPotentialTax', potentialTax, false);
    setCard('lgCardNetReceivable', netReceivable, true);
    setCard('lgCardBalNoMtm', balNoMtm, true);
    var pctEl = document.getElementById('lgCardPctOutstanding');
    if (pctEl) pctEl.textContent = outstanding > 0 ? pctOutstanding.toFixed(1) + '%' : '-';

    // ------------------------------------------------------------
    // Booked P&L collapsible — grouped by symbol, FY only
    // ------------------------------------------------------------
    var fyLabelEl = document.getElementById('lgBookedFyLabel');
    if (fyLabelEl) fyLabelEl.textContent = fyLabel;
    var bookedTotalEl = document.getElementById('lgBookedTotal');
    if (bookedTotalEl) {
        bookedTotalEl.innerHTML = lgFmt(totalBookedGain);
        bookedTotalEl.className = 'lg-booked-total ' + lgAmtClass(totalBookedGain);
    }

    var bookedRowsEl = document.getElementById('lgBookedBodyRows');
    if (bookedRowsEl) {
        if (fyGains.length === 0) {
            bookedRowsEl.innerHTML = '<tr><td colspan="4" class="text-center" style="padding:12px; color:#9ca3af;">No booked P&L in ' + fyLabel + '</td></tr>';
        } else {
            // Group by symbol+securityType
            var bySym = {};
            fyGains.forEach(function(g) {
                var k = (g.shortSymbol || g.symbol) + '|' + (g.securityType || 'EQ');
                if (!bySym[k]) bySym[k] = { shortSymbol: g.shortSymbol || g.symbol, securityType: g.securityType || 'EQ', qty: 0, gain: 0 };
                bySym[k].qty += g.qty || 0;
                bySym[k].gain += g.gain || 0;
            });
            var bookedHtml = Object.keys(bySym).sort().map(function(k) {
                var b = bySym[k];
                var cls = lgAmtClass(b.gain);
                var typeL = (b.securityType === 'NFO') ? 'NFO' : 'EQ';
                return '<tr>' +
                    '<td>' + wmsEsc(b.shortSymbol) + '</td>' +
                    '<td class="text-right">' + typeL + '</td>' +
                    '<td class="text-right">' + (typeof formatQuantity === 'function' ? formatQuantity(b.qty) : String(Math.round(b.qty))) + '</td>' +
                    '<td class="text-right ' + cls + '">' + lgFmt(b.gain) + '</td>' +
                    '</tr>';
            }).join('');
            bookedRowsEl.innerHTML = bookedHtml;
        }
    }

    // Wire collapse toggle (idempotent — guarded via dataset flag)
    var bookedHdr = document.getElementById('lgBookedHeader');
    var bookedSec = document.getElementById('lgBookedSection');
    if (bookedHdr && bookedSec && !bookedHdr.dataset.lgWired) {
        bookedHdr.dataset.lgWired = '1';
        bookedHdr.addEventListener('click', function() {
            bookedSec.classList.toggle('lg-booked-collapsed');
        });
        // Start collapsed
        bookedSec.classList.add('lg-booked-collapsed');
    }
}

// ============================================================================
// LEDGER ENTRY MANAGEMENT
// ============================================================================

/**
 * Resolve the single effective investor for the add-entry row.
 * Add row is for ONE investor only — supports the case where the user has
 * filtered by trader (T3) where trader_id and investor_id share the same UUID
 * namespace, so a sole trader filter resolves to that same investor.
 *
 * Returns investor id, or null if 0 or >1 entities are selected.
 */
function lgGetEffectiveInvestorId() {
    if (lgSelectedInvestorIds.length === 1) return lgSelectedInvestorIds[0];
    if (lgSelectedInvestorIds.length === 0 && lgSelectedTraderIds.length === 1) {
        // Trader IDs share the investor UUID namespace; verify it maps to a real investor
        var tid = lgSelectedTraderIds[0];
        if (wmsRefData.investorObjMap && wmsRefData.investorObjMap[tid]) return tid;
    }
    return null;
}

/**
 * Enable/disable the add-entry row based on whether a single effective
 * investor can be resolved from the current filters.
 */
function lgUpdateAddRowAvailability() {
    var newRow = document.getElementById('lgNewEntryRow');
    if (!newRow) return;
    var effective = lgGetEffectiveInvestorId();
    var enabled = !!effective;

    var fields = ['lgNewReference', 'lgNewType', 'lgNewAmount', 'lgAddEntryBtn'];
    fields.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.disabled = !enabled;
    });
    // Date input
    var dateWrap = document.querySelector('#lgNewDateContainer .wms-di-wrap');
    if (dateWrap) {
        dateWrap.style.opacity = enabled ? '1' : '0.45';
        dateWrap.style.pointerEvents = enabled ? 'auto' : 'none';
    }
    newRow.style.opacity = enabled ? '1' : '0.6';
    newRow.title = enabled ? '' : 'Select exactly one investor (or trader) to add entries';
}

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

    var investorId = lgGetEffectiveInvestorId();
    if (!investorId) {
        showAlert('Select exactly one investor (or trader) to add entries', 'warning', 3000);
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
            // Note: wmsDateInput exposes setValue/getValue/destroy — no clear().
            // Keep the date as-is (the user typically adds several entries on the
            // same date, so this is the more useful default).
            if (refEl) refEl.value = '';
            if (amtEl) amtEl.value = '';
            showAlert('Entry added', 'success', 2000);
            lgRefresh();
        } else {
            // Surface the actual server error so failures aren't silent
            var errText = '';
            try { errText = await resp.text(); } catch (_) {}
            var errMsg = 'Failed to add entry (HTTP ' + resp.status + ')';
            try {
                var parsed = JSON.parse(errText);
                if (parsed && parsed.message) errMsg += ': ' + parsed.message;
            } catch (_) {
                if (errText) errMsg += ': ' + errText.slice(0, 200);
            }
            console.warn('lgAddEntry failed:', resp.status, errText);
            showAlert(errMsg, 'error', 6000);
        }
    } catch (err) {
        console.warn('Failed to add entry:', err.message);
        showAlert('Failed to add entry: ' + err.message, 'error', 5000);
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

// Render the interest detail modal with the calculation breakdown.
// Works for both posted rows (entry in DB) and pending rows (_calc in memory).
function lgPopulateInterestDetail(calc, currentAmount) {
    var detailBody = document.getElementById('lgInterestDetailBody');
    var totalEditEl = document.getElementById('lgInterestTotalEdit');

    if (detailBody) {
        if (calc) {
            var baseLine = '';
            if (calc.marginBalance) {
                baseLine = '<tr>' +
                    '<td>' + wmsEsc(calc.period) + '</td>' +
                    '<td class="text-right">' + lgFmt(calc.closingBalance) + ' + ' + lgFmt(calc.marginBalance) + ' <span style="color:#718096; font-size:10px;">(F&amp;O margin)</span> = ' + lgFmt(calc.baseBalance || (calc.closingBalance + calc.marginBalance)) + '</td>' +
                    '<td class="text-right">' + calc.days + '</td>' +
                    '<td class="text-right">' + calc.rate + '%</td>' +
                    '<td class="text-right">' + lgFmt(calc.interest) + '</td>' +
                '</tr>';
            } else {
                baseLine = '<tr>' +
                    '<td>' + wmsEsc(calc.period) + '</td>' +
                    '<td class="text-right">' + lgFmt(calc.closingBalance) + '</td>' +
                    '<td class="text-right">' + calc.days + '</td>' +
                    '<td class="text-right">' + calc.rate + '%</td>' +
                    '<td class="text-right">' + lgFmt(calc.interest) + '</td>' +
                '</tr>';
            }
            var formulaNote = '<tr><td colspan="5" style="font-size:10px; color:#718096; padding-top:6px;">Formula: max(0, balance + F&amp;O margin) × rate% × (1/52)</td></tr>';
            detailBody.innerHTML = baseLine + formulaNote;
        } else {
            detailBody.innerHTML = '<tr><td colspan="5" class="text-center" style="padding:20px; color:#9ca3af;">No calculation data available</td></tr>';
        }
    }

    if (totalEditEl) {
        totalEditEl.value = currentAmount != null ? currentAmount : (calc ? calc.interest : 0);
    }
}

// Open interest detail modal for a POSTED interest entry (already in DB).
async function lgShowInterestDetail(entryId) {
    var entry = lgLedgerEntries.find(function(e) { return e.id === entryId; });
    if (!entry || entry.entry_type !== 'INTEREST_BOOKED') return;

    lgInterestDetailEntryId = entryId;
    lgPendingModalKey = null;

    var investorId = entry.investor_id;
    var interestTerms = wmsGetInterestTerms(investorId);

    if (!interestTerms) {
        showAlert('No interest terms configured', 'warning', 3000);
        return;
    }

    // Recompute the calculation for this row by finding the Friday before entry_date
    // and running the same weekly engine for a single period.
    var calc = null;
    try {
        var postDate = new Date(entry.entry_date);
        var friday = new Date(postDate);
        friday.setDate(friday.getDate() - 1);
        var fromStr = friday.toISOString().slice(0, 10);
        var toStr = fromStr;

        // Build ledger excluding this entry itself (so the running balance matches
        // what it was just before this interest row was posted)
        var txnFiltered = trTransactions.filter(function(t) {
            return !t.dont_display && t.investor_id === investorId;
        });
        var entriesExSelf = lgLedgerEntries.filter(function(e) { return e.id !== entryId; });
        var full = wmsBuildLedger(entriesExSelf, txnFiltered, { investorIds: [investorId] });

        var nfoTxns = txnFiltered.filter(function(t) {
            var p = (t.product || '').toUpperCase();
            var s = (t.security_type || '').toUpperCase();
            return /F&O|FNO|NFO/.test(p) || /F&O|FNO|NFO/.test(s);
        }).sort(function(a, b) { return (a.transaction_date || '').localeCompare(b.transaction_date || ''); });
        var marginEvents = wmsCalcMarginFIFO(nfoTxns);

        var periods = wmsCalcInterestWeeklyFriday(full, interestTerms, fromStr, toStr, marginEvents);
        calc = periods.length > 0 ? periods[0] : null;
    } catch (err) {
        console.warn('Failed to recompute interest detail:', err.message);
    }

    lgPopulateInterestDetail(calc, entry.amount);
    lgShowModal('lgInterestDetail');
}

// Open interest detail modal for a PENDING (not yet posted) interest row.
function lgShowPendingInterestDetail(pendingKey) {
    var pending = lgPendingInterestRows.find(function(r) { return r._pendingKey === pendingKey; });
    if (!pending) return;

    lgInterestDetailEntryId = null;
    lgPendingModalKey = pendingKey;

    lgPopulateInterestDetail(pending._calc, pending.amount);
    lgShowModal('lgInterestDetail');
}

// Commit a pending interest row: insert to ledger_entries with the current (possibly edited) amount.
async function lgCommitPendingInterest(pendingKey) {
    var pending = lgPendingInterestRows.find(function(r) { return r._pendingKey === pendingKey; });
    if (!pending) return;

    // If the user opened the modal first, honour whatever they typed there.
    var totalEl = document.getElementById('lgInterestTotalEdit');
    var amount = pending.amount;
    if (lgPendingModalKey === pendingKey && totalEl) {
        var v = parseFloat(totalEl.value);
        if (!isNaN(v)) amount = v;
    }

    if (amount <= 0) {
        showAlert('Interest must be greater than 0', 'warning', 3000);
        return;
    }

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/ledger_entries', {
            method: 'POST',
            headers: lgHeaders(),
            body: JSON.stringify({
                investor_id: pending.investorId,
                entry_date: pending.date,
                entry_type: 'INTEREST_BOOKED',
                amount: amount,
                reference: pending.reference,
                notes: JSON.stringify(pending._calc || {})
            })
        });
        if (resp.ok) {
            lgHideModal('lgInterestDetail');
            showAlert('Interest committed', 'success', 2000);
            lgRefresh();
        } else {
            showAlert('Failed to commit interest', 'error', 3000);
        }
    } catch (err) {
        console.warn('Failed to commit interest:', err.message);
        showAlert('Failed to commit interest', 'error', 3000);
    }
}

// Post / update interest: works for either posted (PATCH existing entry) or pending (POST new).
async function lgPostInterest() {
    if (lgPendingModalKey) {
        // Modal was opened for a pending row → route to commit path
        await lgCommitPendingInterest(lgPendingModalKey);
        return;
    }
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
        showAlert('Interest updated', 'success', 2000);
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
window.lgShowPendingInterestDetail = lgShowPendingInterestDetail;
window.lgCommitPendingInterest = lgCommitPendingInterest;
window.lgAddEntry = lgAddEntry;
window.lgPostInterest = lgPostInterest;
window.lgApplyView = lgApplyView;
window.lgLoadViews = lgLoadViews;
window.lgSaveOpeningBalance = lgSaveOpeningBalance;
window.lgCancelObEdit = lgCancelObEdit;
