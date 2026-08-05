// ============================================================================
// WMS STATEMENTS MODULE
// ============================================================================
// Uses 'lg' prefix for all module-level state and functions.
// All variables use 'var' (project convention A.1.2).

// ============================================================================
// STATE VARIABLES
// ============================================================================

// ---- Statements View Manager (wmsViewManager instance) ----
var lgVM = wmsViewManager({
    module: 'ledger',
    label: 'Statements',
    ids: {
        viewTabs: 'lgViewTabs',
        moreList: 'lgMoreList',
        moreDropdown: 'lgMoreDropdown',
        updateBtn: 'lgUpdateViewBtn'
    },
    autoDefaultFirst: false,
    getPills: function() {
        return [
            { pill: lgInvPillFilter, type: 'investor' },
            { pill: lgTrdPillFilter, type: 'trader' },
            { pill: lgBrkPillFilter, type: 'broker' },
            { pill: lgTagPillFilter, type: 'tag' }
        ];
    },
    getFilters: function() {
        return {
            investorIds: lgSelectedInvestorIds.slice(),
            traderIds: lgSelectedTraderIds.slice(),
            brokerIds: lgSelectedBrokerIds.slice(),
            tagNames: lgSelectedTagNames.slice(),
            tagLogic: lgTagFilterLogic,
            // Statement type — 'trader' (investor / sub-trader perspective) or
            // 'broker' (broker-side perspective). See LESSONS §E.15.12.
            statementType: lgStatementType
        };
    },
    applyFilters: function(f) {
        // Mutate arrays in-place (B.2.3 — pill controllers hold references)
        lgSelectedInvestorIds.length = 0;
        Array.prototype.push.apply(lgSelectedInvestorIds, f.investorIds || []);
        lgSelectedTraderIds.length = 0;
        Array.prototype.push.apply(lgSelectedTraderIds, f.traderIds || []);
        lgSelectedBrokerIds.length = 0;
        Array.prototype.push.apply(lgSelectedBrokerIds, f.brokerIds || []);
        lgSelectedTagNames.length = 0;
        Array.prototype.push.apply(lgSelectedTagNames, f.tagNames || []);
        lgTagFilterLogic = f.tagLogic || 'OR';

        // Statement type — backward-compat: any view saved before this feature
        // shipped won't have a statementType key. Default to 'trader' so the
        // existing T1/T2/T3 views behave exactly as they did pre-feature.
        // LESSONS §E.15.12.
        lgStatementType = (f.statementType === 'broker') ? 'broker' : 'trader';
        lgSyncStatementTypeToggle();

        // Sync pill UI
        ['investor', 'trader', 'broker', 'tag'].forEach(function(type) {
            lgSyncPillStates(type);
            lgRenderSelectedTags(type);
        });
    },
    onRefresh: function() { lgRefresh(); },
    onSaveComplete: function() {
        var prompt = document.getElementById('lgSavePrompt');
        if (prompt) prompt.style.display = 'none';
    },
    // View-filter lock (LESSONS §E.17.8) — a view becomes filter-locked once
    // any ledger_entry references it. Used by wmsViewManager.updateCurrentView
    // to refuse mutation, and by the app to disable the Update View button.
    isViewLocked: function(viewId) { return lgIsViewLocked(viewId); },
    // Pre-delete hook — warn about orphaning ledger entries before allowing
    // deletion. ON DELETE SET NULL means entries survive but lose their view
    // pointer and revert to legacy-column scope matching.
    beforeDelete: function(viewId) { return lgConfirmViewDelete(viewId); }
});

// Data
var lgLedgerEntries = [];
var lgCombined = [];
// Full-history combined rows with running balance (superset of lgCombined,
// which is clipped to the active date filter).  Stashed so that the recon
// drift check (Layer 3a) has access to all RECONCILIATION rows, even when
// the current date window excludes them. See LESSONS §E.17.5.
var lgFullCombined = [];

// Filters
var lgSelectedInvestorIds = [];
var lgSelectedTraderIds = [];
var lgSelectedBrokerIds = [];
var lgSelectedTagNames = [];
var lgTagFilterLogic = 'OR';

// Statement type — 'trader' (default, investor / sub-trader perspective) or
// 'broker' (broker-side perspective). Persisted alongside filters on each
// portfolio_views row. Controls (a) which perspective wmsBuildLedger uses,
// (b) whether ledger_entries are fetched (broker = no, since cash entries
// are investor-scoped), and (c) which summary cards render (broker hides
// Potential Tax — see LESSONS §E.15.12).
var lgStatementType = 'trader';

// F&O futures rows toggle — purely a display filter (LESSONS §E.15.14).
// When false, rows where _rowType==='trade' && _nfoCashImpact===false (futures
// BUY/SELL with no cash impact) are HIDDEN from the Transactions table. Margin
// + interest calculations are UNAFFECTED — they read the full transaction
// universe upstream of this filter. NFO_PNL synthetic rows and options
// (CE/PE) rows always render because they have _nfoCashImpact===true.
// BROWSER-PERSISTENT (2026-08-05, owner request): stored in localStorage
// ('wms_lg_show_fno'), shared across views/tabs on this browser. Default
// when never set: OFF (unchecked).
var lgShowFutures = (localStorage.getItem('wms_lg_show_fno') === null)
    ? false
    : localStorage.getItem('wms_lg_show_fno') === '1';

// Hide-pre-reconciliation rows toggle (LESSONS §E.15.15). When true (default),
// all rows with date <= the latest RECONCILIATION row's date are hidden from
// the Transactions table, and the Opening Balance row is overridden to show
// the recon date + recon's running balance (so the recon becomes the new "as
// of" anchor). When false, full history is shown with the recon row visible
// inline as a green ✓ marker. Engine, margin, interest, drift check, and DB
// rows are UNAFFECTED — this is a pure display filter.
// BROWSER-PERSISTENT (2026-08-05, owner request): localStorage
// ('wms_lg_hide_prerecon'). Default when never set: ON (checked).
var lgHidePreRecon = (localStorage.getItem('wms_lg_hide_prerecon') === null)
    ? true
    : localStorage.getItem('wms_lg_hide_prerecon') === '1';

// Expandable "Starting Booked P&L" breakdown (§E.15.17). When true, the pre-recon
// booked-P&L detail rows are shown under the Starting line so past data stays
// checkable on screen even though pre-recon transactions are hidden. Session-state
// only; persisted across the summary's price-refresh re-renders via this flag.
var lgBookedStartExpanded = false;

// Broker-statement split aggregation (LESSONS §E.17.11). Tracks which collapsed
// split-groups the user has expanded. Keyed by aggKey (date|symbol|price|side|
// firstTxnId). Session-state only — not persisted with the view.
var lgAggExpanded = {};

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
var lgInterestTotalCtrl = null;

// Sorting state
var lgSortCol = 'date';
var lgSortDir = 'asc';

// New entry date input (wmsDateInput instance)
var lgNewDateInput = null;

// Delete confirmation state
var lgPendingDeleteId = null;

// Active page tab ('transactions' or 'summary')
// (lgActivePage removed: Transactions / Summary tabs merged into a single
//  scrollable page where each block is independently collapsible)

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
    'DEMERGER': 'Demerger',
    'HISTORICAL_PL': 'Historical P&L',
    'CASH_RECEIVED': 'Cash In',
    'CASH_PAID': 'Cash Out',
    'OPENING_BALANCE': 'Opening Bal',
    'ADJUSTMENT': 'Adjustment',
    'INTEREST_BOOKED': 'Interest',
    'NFO_PNL': 'F&O P&L',
    'RECONCILIATION': '✓ Reconciled'
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
    'DEMERGER': 'lg-type-other',
    'HISTORICAL_PL': 'lg-type-other',
    'CASH_RECEIVED': 'lg-type-cash',
    'CASH_PAID': 'lg-type-sell',
    'OPENING_BALANCE': 'lg-type-cash',
    'ADJUSTMENT': 'lg-type-other',
    'INTEREST_BOOKED': 'lg-type-income',
    'NFO_PNL': 'lg-type-income',
    'RECONCILIATION': 'lg-type-recon'
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
            persistKey: 'wms_lg_datefilter', // browser-persistent (2026-08-05)
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

    // Filters toggle button \u2014 collapses the pill filter row.
    // The button now sits in Row 2 (filter row) with a "Pill filters" label
    // so the arrow direction stays paired with what it controls.
    var filtersToggle = document.getElementById('lgFiltersToggle');
    if (filtersToggle) {
        filtersToggle.addEventListener('click', function() {
            var filtersDiv = document.getElementById('lgFiltersBar');
            var isHidden = filtersDiv.style.display === 'none';
            filtersDiv.style.display = isHidden ? 'flex' : 'none';
            this.textContent = (isHidden ? '\u25BC' : '\u25B2') + ' Pill filters';
        });
    }

    // Transactions block collapsible (idempotent)
    var txnHdr = document.getElementById('lgTransactionsHeader');
    var txnBlk = document.getElementById('lgTransactionsBlock');
    if (txnHdr && txnBlk && !txnHdr.dataset.lgWired) {
        txnHdr.dataset.lgWired = '1';
        txnHdr.addEventListener('click', function() {
            txnBlk.classList.toggle('lg-booked-collapsed');
        });
    }

    // Export modal — opens a multi-option chooser (date range, sections, format).
    // Replaces the legacy 2-item dropdown. See LESSONS §E.18.1.
    var exportBtn = document.getElementById('lgExportBtn');
    if (exportBtn) exportBtn.addEventListener('click', lgExportOpen);
    lgInitModal('lgExportModal', 'lgExportModalClose');

    // Add Entry button
    var addBtn = document.getElementById('lgAddEntryBtn');
    if (addBtn) {
        addBtn.addEventListener('click', lgAddEntry);
    }

    // Modal close handlers — Interest Detail (4 ways: ✕, Cancel, click-outside, Escape)
    lgInitModal('lgInterestDetail', 'lgInterestDetailClose', 'lgInterestDetailCancelBtn');

    // Modal close handlers — Book Interest
    lgInitModal('lgBookInterestModal', 'lgBookInterestClose', 'lgBookCancelBtn');

    // Modal close handlers — Reconciliation Review (Layer 3b)
    lgInitModal('lgReconReviewModal', 'lgReconReviewClose', 'lgReconReviewCancelBtn');

    // Recon banner Review button (Layer 3a → 3b)
    var reconReviewBtn = document.getElementById('lgReconBannerReviewBtn');
    if (reconReviewBtn) reconReviewBtn.addEventListener('click', lgReconReviewOpen);

    // Cancel Reconciliation button inside the review modal (deletes the recon row).
    var reconDelBtn = document.getElementById('lgReconReviewDeleteBtn');
    if (reconDelBtn) reconDelBtn.addEventListener('click', lgReconReviewCancel);

    // Review modal: click a row to open the txn's Edit modal.
    var reconReviewBody = document.getElementById('lgReconReviewBody');
    if (reconReviewBody) {
        reconReviewBody.addEventListener('click', function(e) {
            var tr = e.target.closest('tr[data-txn-id]');
            if (!tr) return;
            var txnId = tr.getAttribute('data-txn-id');
            if (txnId && typeof trOpenEditModal === 'function') {
                lgReconReviewClose();
                trOpenEditModal(txnId);
            }
        });
    }

    // Interest post button
    var intPostBtn = document.getElementById('lgInterestPostBtn');
    if (intPostBtn) {
        intPostBtn.addEventListener('click', lgPostInterest);
    }

    // Wire global comma-formatted amount input to interest modal Total Interest field
    var lgIntTotalEl = document.getElementById('lgInterestTotalEdit');
    if (lgIntTotalEl && typeof wmsAttachAmountInput === 'function') {
        lgInterestTotalCtrl = wmsAttachAmountInput(lgIntTotalEl, {
            allowNegative: false,
            decimals: 0
        });
    }

    // Export modal — format buttons inside the body (see #lgExportModal).
    // Each fires the same data-gathering path with a different renderer.
    var expPdfBtn      = document.getElementById('lgExpPdf');
    var expXlsBtn      = document.getElementById('lgExpExcel');
    var expImgCopyBtn  = document.getElementById('lgExpCopyImage');
    var expImgDlBtn    = document.getElementById('lgExpDownloadImage');
    if (expPdfBtn)     expPdfBtn.addEventListener('click',     function() { lgExportRun('pdf'); });
    if (expXlsBtn)     expXlsBtn.addEventListener('click',     function() { lgExportRun('excel'); });
    if (expImgCopyBtn) expImgCopyBtn.addEventListener('click', function() { lgExportRun('image_copy'); });
    if (expImgDlBtn)   expImgDlBtn.addEventListener('click',   function() { lgExportRun('image_download'); });

    // Date-range radio change → auto-fill the From/To inputs.
    ['lgExpDateRangeCustom','lgExpDateRangeCurrentFY','lgExpDateRangePreviousFY','lgExpDateRangeSinceRecon']
        .forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('change', lgExportSyncDates);
        });

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
                lgVM.saveCurrentView(name);
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
        updateBtn.addEventListener('click', function() { lgVM.updateCurrentView(); });
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
            // Aggregated broker-split header → toggle expand/collapse (E.17.11).
            // (Member rows carry lg-row-agg-member, NOT lg-row-agg, so they fall
            // through to the edit path below.)
            var aggTr = e.target.closest('tr.lg-row-agg');
            if (aggTr) {
                var ak = aggTr.getAttribute('data-agg-key');
                if (ak) { lgAggExpanded[ak] = !lgAggExpanded[ak]; lgRenderEntries(lgCombined); }
                return;
            }
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

    // Statement-type toggle (Trader / Broker). Wired once; lgVM.applyFilters
    // calls lgSyncStatementTypeToggle whenever a view loads. LESSONS §E.15.12.
    lgInitStatementTypeToggle();

    // F&O futures show/hide toggle (LESSONS §E.15.14). Click on the checkbox
    // must not bubble to the section-header collapse handler.
    var futuresToggleEl = document.getElementById('lgFuturesToggle');
    if (futuresToggleEl && !futuresToggleEl.dataset.lgWired) {
        futuresToggleEl.dataset.lgWired = '1';
        futuresToggleEl.checked = lgShowFutures;
        futuresToggleEl.addEventListener('click', function(e) { e.stopPropagation(); });
        futuresToggleEl.addEventListener('change', function() {
            lgShowFutures = futuresToggleEl.checked;
            localStorage.setItem('wms_lg_show_fno', lgShowFutures ? '1' : '0');
            // Re-render the transactions list only — engine + margin + interest
            // unchanged (those run on the full transaction universe, not on
            // the displayed rows).
            lgRenderEntries(lgCombined);
        });
    }
    // Also block clicks on the toggle's label wrapper from bubbling.
    var futuresToggleWrap = document.getElementById('lgFuturesToggleWrap');
    if (futuresToggleWrap && !futuresToggleWrap.dataset.lgWired) {
        futuresToggleWrap.dataset.lgWired = '1';
        futuresToggleWrap.addEventListener('click', function(e) { e.stopPropagation(); });
    }

    // Hide-pre-recon toggle (LESSONS §E.15.15). When checked, rows on or before
    // the latest RECONCILIATION row are hidden and the OB row is overridden to
    // show the recon date + recon balance. Display-only — engine unaffected.
    var hideReconEl = document.getElementById('lgHidePreReconToggle');
    if (hideReconEl && !hideReconEl.dataset.lgWired) {
        hideReconEl.dataset.lgWired = '1';
        hideReconEl.checked = lgHidePreRecon;
        hideReconEl.addEventListener('click', function(e) { e.stopPropagation(); });
        hideReconEl.addEventListener('change', function() {
            lgHidePreRecon = hideReconEl.checked;
            localStorage.setItem('wms_lg_hide_prerecon', lgHidePreRecon ? '1' : '0');
            lgRenderEntries(lgCombined);
        });
    }
    var hideReconWrap = document.getElementById('lgHidePreReconWrap');
    if (hideReconWrap && !hideReconWrap.dataset.lgWired) {
        hideReconWrap.dataset.lgWired = '1';
        hideReconWrap.addEventListener('click', function(e) { e.stopPropagation(); });
    }

    // Load views and initial data
    lgVM.loadViews();

    // Live prices: register the Statements module's symbols with the shared refresh
    // protocol and trigger an immediate fetch so the Open Positions table
    // and Summary cards see CMP instead of falling back to avgCost.
    // Mirrors what trading.js does on Portfolio init.
    try {
        if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
        if (typeof wmsStandardRefresh === 'function') {
            wmsStandardRefresh(false).then(function() {
                if (typeof lgRenderSummary === 'function') lgRenderSummary();
            }).catch(function(err) {
                console.warn('Statements: initial price fetch failed:', err && err.message);
            });
        }
        if (typeof wmsStartRefreshTimer === 'function' &&
            typeof wmsIsMarketHours === 'function' && wmsIsMarketHours() &&
            window.fyersToken) {
            wmsStartRefreshTimer();
        }
    } catch (err) {
        console.warn('Statements: price fetch wiring failed:', err && err.message);
    }
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

// ----------------------------------------------------------------------------
// COUNTERPARTY-POV DISPLAY FLIP — LESSONS §E.15.13
// ----------------------------------------------------------------------------
// The engine (wmsBuildLedger, summary card formulas, interest base) ALL stay
// in the firm-POV convention: +ve cash balance = counterparty owes firm. This
// matters because the interest base uses `max(0, cashBalance) + margin` — the
// clamp only fires correctly in the firm-POV convention.
//
// The DISPLAY layer flips everything that is "balance-like" by ×(-1) so the
// statement reads from the counterparty's POV (the trader's perspective for
// Trader statements, the firm's perspective for Broker statements — both
// flip the same way relative to the engine's firm-receivable convention):
//   Trader statement: -ve balance = trader owes firm; +ve = firm owes trader
//   Broker statement: -ve balance = firm owes broker; +ve = broker owes firm
//
// Values that DO NOT flip: Holdings Value (always positive magnitude), NFO
// Margin (positive collateral magnitude), Potential Tax (positive liability),
// Booked P&L + MTM (universal +/- = profit/loss), Net Receivable & Balance
// w/o MTM (formulas Holdings − Cash − Tax already produce counterparty-POV
// signs because Cash is internally firm-POV).
//
// DB is untouched. Engine is untouched.
function lgD(v) { return (typeof v === 'number') ? -v : v; }

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
    if (row._rowType !== 'trade' && row._rowType !== 'nfo_pnl') return '';
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
    if (wmsIsDerivativeTxn(source)) {
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
    } else if (row._rowType === 'nfo_pnl') {
        type = 'NFO_PNL';
    } else if (row._rowType === 'trade') {
        type = row._source.transaction_type || '';
    }

    var label = LG_TYPE_LABELS[type] || type.replace(/_/g, ' ');
    cssClass = LG_TYPE_CSS[type] || 'lg-type-other';

    return '<span class="lg-type ' + cssClass + '">' + wmsEsc(label) + '</span>';
}

// SAVED STATEMENT VIEWS — delegated to lgVM (wmsViewManager instance)

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
    // Broker statements fetch ALL entry types (OPENING_BALANCE, RECONCILIATION,
    // INTEREST_BOOKED, CASH_RECEIVED, CASH_PAID) scoped to (broker_id [+ investor_id
    // when present]). The 2026-05-27 morning revision had restricted broker view
    // to OB + RECON only — that was wrong: it hid committed interest entries
    // (the POST went through, but lgRefresh's narrow fetch never pulled the
    // row back, so the same pending row regenerated and the user saw "nothing
    // happened"). Interest and cash flows ARE relevant on a broker-account view
    // because they're scoped by broker_id in the DB — they represent the cash
    // ledger on that specific broker account. See WMS-LESSONS §E.15.12 (rev 2).
    //
    // PostgREST filter syntax: `field=in.(values)` — NOT `field.in.(values)`
    // (the dotted form is silently ignored, returning the unfiltered set).
    var brokerOnly = (lgStatementType === 'broker');

    try {
        var qParts = [];
        if (brokerOnly) {
            // Broker view: scope by (broker_id [+ investor_id]). Pull every
            // entry type — wmsBuildLedger already handles per-perspective math.
            if (lgSelectedBrokerIds.length > 0) {
                qParts.push('broker_id=in.(' + lgSelectedBrokerIds.map(function(id) { return '"' + id + '"'; }).join(',') + ')');
            }
            if (lgSelectedInvestorIds.length > 0) {
                qParts.push('investor_id=in.(' + lgSelectedInvestorIds.map(function(id) { return '"' + id + '"'; }).join(',') + ')');
            }
        } else {
            // Investor / trader view: pull all entry types for the
            // selected investor(s). wmsBuildLedger will JS-side filter
            // again on perspective and tag/broker filters.
            if (entityIds.length > 0) {
                qParts.push('investor_id=in.(' + entityIds.map(function(id) { return '"' + id + '"'; }).join(',') + ')');
            }
        }
        var filterQs = qParts.length > 0 ? '&' + qParts.join('&') : '';
        var url = SUPABASE_URL + '/rest/v1/ledger_entries?select=*' + filterQs + '&order=entry_date.asc';
        var resp = await fetch(url, { headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}) });
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

    // Resolve perspective from the explicit statement type chosen by the user.
    //   - Broker type → always 'broker' (uses raw DB net_amount, futures P&L
    //     sign flipped — see wmsBuildLedger).
    //   - Trader type → preserve the pre-toggle auto-resolution:
    //         has investor filter → 'investor'
    //         else has trader filter → 'trader'
    //         else → 'investor' (default)
    //     'investor' and 'trader' produce identical engine output today (both
    //     use display_net_amount), but keep them distinct in case future rules
    //     diverge. LESSONS §E.15.9 + §E.15.12.
    var lgPerspective;
    if (lgStatementType === 'broker') {
        lgPerspective = 'broker';
    } else if (lgSelectedInvestorIds.length > 0) {
        lgPerspective = 'investor';
    } else if (lgSelectedTraderIds.length > 0) {
        lgPerspective = 'trader';
    } else {
        lgPerspective = 'investor';
    }

    // Build full-history ledger — running balance computed across ALL time.
    var fullCombined = wmsBuildLedger(lgLedgerEntries, txnFiltered, {
        investorIds: lgSelectedInvestorIds,
        traderIds: lgSelectedTraderIds,
        brokerIds: lgSelectedBrokerIds,
        tagNames: lgSelectedTagNames,
        tagLogic: lgTagFilterLogic,
        perspective: lgPerspective
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
    // On broker view, also resolve the effective broker — the lastPosted
    // INTEREST_BOOKED scan needs to scope by broker_id so a broker-specific
    // commit (e.g. on stmt_TG) isn't masked by interest entries on OTHER
    // brokers for the same investor.
    var effBrkIdForInterest = (lgStatementType === 'broker' && lgSelectedBrokerIds.length === 1)
        ? lgSelectedBrokerIds[0]
        : null;
    if (effInvId) {
        var invId = effInvId;
        // Interest terms resolve via IBA-first (broker-account override) then
        // investor-level — so a broker view picks up its own rate if set.
        var terms = wmsGetInterestTerms(invId, effBrkIdForInterest);
        var supportedFreq = terms && (terms.frequency === 'weekly_friday' || terms.frequency === 'daily_monthly_compound');
        if (terms && supportedFreq && terms.rate > 0) {
            // Last posted Saturday = max entry_date of INTEREST_BOOKED for
            // this (investor [+ broker on broker view]).
            var lastPosted = null;
            for (var li = 0; li < lgLedgerEntries.length; li++) {
                var le = lgLedgerEntries[li];
                if (le.entry_type !== 'INTEREST_BOOKED') continue;
                if (le.investor_id !== invId) continue;
                if (effBrkIdForInterest && le.broker_id !== effBrkIdForInterest) continue;
                if (!lastPosted || le.entry_date > lastPosted) lastPosted = le.entry_date;
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
                // Compute margin events from F&O transactions (full history).
                // Includes MCX commodity F&O via the shared predicate (§E.15).
                var nfoTxns = txnFiltered.filter(function(t) {
                    return wmsIsDerivativeTxn(t);
                }).sort(function(a, b) {
                    return (a.transaction_date || '').localeCompare(b.transaction_date || '');
                });
                // Broker view: apply the filter investor's IBA margin rate
                // UNIFORMLY across every trade (not per-trade trader_id).
                // T0's IBA with TG = 25%; without this override, T2-attributed
                // trades would use (T2, TG) IBA = 33.33%, mixing rates.
                // For trader/investor views: legacy per-trade lookup.
                // Defaults to T0 if no investor filter is set (firm's IBA).
                var marginOpts = {};
                if (lgStatementType === 'broker') {
                    var effInvForMargin = invId; // resolved earlier in this block
                    if (!effInvForMargin) {
                        // No investor filter — default to T0 by short_name lookup.
                        var t0 = (wmsRefData.investors || []).find(function(i) {
                            return (i.short_name || '').toUpperCase() === 'T0';
                        });
                        effInvForMargin = t0 ? t0.id : null;
                    }
                    if (effInvForMargin) marginOpts.marginRateInvestorId = effInvForMargin;
                }
                var marginEvents = wmsCalcMarginFIFO(nfoTxns, marginOpts);

                // Frequency-dispatch: pick the engine matching the configured
                // interest terms. Both engines emit the same period shape
                // ({period, postDate, interest, ...}) so downstream pending-row
                // generation is identical. `daily_monthly_compound` adds a
                // `trace` field per period for the detail modal (E.15.6c).
                var periods;
                if (terms.frequency === 'weekly_friday') {
                    periods = wmsCalcInterestWeeklyFriday(fullCombined, terms, genFrom, today, marginEvents);
                } else if (terms.frequency === 'daily_monthly_compound') {
                    periods = wmsCalcInterestDailyMonthlyCompound(fullCombined, terms, genFrom, today, marginEvents);
                } else {
                    console.warn('Unsupported interest frequency: ' + terms.frequency);
                    periods = [];
                }

                // Reference label adapts to the cadence — "Weekly interest"
                // for the weekly engine, "Monthly interest" for the monthly one.
                var refPrefix = (terms.frequency === 'daily_monthly_compound')
                    ? 'Monthly interest '
                    : 'Weekly interest ';

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
                        reference: refPrefix + p.period,
                        notes: ''
                    };
                    fullCombined.push(pendingRow);
                    lgPendingInterestRows.push(pendingRow);
                }

                // Re-sort and recompute running balance so pending rows flow into it.
                // MUST mirror wmsBuildLedger's balance loop EXACTLY — including the
                // `_nfoCashImpact !== false` check (Rule E.15.5a: futures trade rows
                // are line items but do NOT move the cash balance; only NFO_PNL rows
                // on cover do). Missing that check inflates the displayed balance
                // with every futures BUY/SELL while the interest engine (which uses
                // the correct balance from wmsBuildLedger) shows different numbers,
                // producing an apparent "balance up, interest unchanged" mismatch.
                if (lgPendingInterestRows.length > 0) {
                    fullCombined.sort(function(a, b) {
                        return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
                    });
                    var bal = 0;
                    for (var fi = 0; fi < fullCombined.length; fi++) {
                        var fr = fullCombined[fi];
                        // OPENING_BALANCE and RECONCILIATION are balance anchors —
                        // they hard-SET the running balance to their stored amount.
                        // Mirrors wmsBuildLedger in wms-shared.js (see LESSONS E.17.1).
                        if (fr._rowType === 'ledger' &&
                            (fr.entryType === 'OPENING_BALANCE' || fr.entryType === 'RECONCILIATION')) {
                            bal = fr.amount;
                        } else if (fr._isPending) {
                            // Pending (not-yet-committed) interest does NOT contribute
                            // to the running balance — the balance stays committed-only
                            // until the user clicks Commit on the pending row.
                        } else if (fr._nfoCashImpact !== false) {
                            bal += fr.amount;
                        }
                        // else: NFO futures trade row — balance unchanged (E.15.5a)
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

    // Stash for Layer 3a (recon drift detection) — see lgCheckReconDrift.
    lgFullCombined = fullCombined;

    // Refresh the view-filter lock state (which views have ledger entries)
    // — drives the Update View button's enabled state and the pre-POST gate.
    await lgLoadViewLockState();

    lgRenderEntries(lgCombined);
    lgRenderSummary();
    lgUpdateAddRowAvailability();
    lgUpdateViewLockUI();
    lgCheckReconDrift();
}

// ============================================================================
// BROKER-STATEMENT SPLIT AGGREGATION (LESSONS §E.17.11)
// A single broker fill that WMS split across traders shows as 2+ rows with the
// same date / symbol / price / side. The broker's own statement shows it as ONE
// line, so manual reconciliation is tedious. In a BROKER statement we collapse
// adjacent matching trade rows into one expandable display row. DISPLAY ONLY —
// the engine, running balances, interest and reconciliation all run on the
// underlying individual transactions upstream of this render layer.
// ============================================================================

function lgAggKey(row) {
    var s = row._source || {};
    var sym = (s.short_symbol || row.short_symbol || row.symbol || '').toUpperCase();
    var px = (s.price != null) ? s.price : '';
    var side = (s.transaction_type || '').toUpperCase();
    return (row.date || '') + '|' + sym + '|' + px + '|' + side;
}

function lgMakeAggRow(group, key) {
    var first = group[0], last = group[group.length - 1];
    var totQty = 0, totAmount = 0, totNet = 0;
    group.forEach(function(m) {
        totQty += Math.abs((m._source && m._source.quantity) || 0);
        totAmount += (m.amount || 0);
        totNet += (m.netAmount || 0);
    });
    var sign = ((first._source && first._source.quantity) || 0) < 0 ? -1 : 1;
    var agg = Object.assign({}, first);
    agg._rowType = 'trade';   // keep as a trade row so lgFormatSymbol/lgFormatType
    agg._isAgg = true;        // and the balance/total logic work natively
    agg._members = group;
    agg._aggKey = key + '|' + ((first._source && first._source.id) || '');
    agg._source = Object.assign({}, first._source, { quantity: sign * totQty });
    agg.quantity = sign * totQty;     // sign only — magnitude used for display
    agg.amount = totAmount;           // firm-POV signed sum (cash impact)
    agg.netAmount = totNet;           // magnitude sum (per-unit = net/qty)
    agg._runningBalance = last._runningBalance;  // balance after the last split
    delete agg._aggMember;
    return agg;
}

function lgAggregateBrokerSplits(rows) {
    // Only broker statements aggregate. Trader/investor views keep raw rows so
    // each trader's allocation stays an independent line.
    if (lgStatementType !== 'broker') return rows;
    var out = [];
    var i = 0;
    while (i < rows.length) {
        var r = rows[i];
        if (r._rowType === 'trade' && r._source && r._source.id) {
            var key = lgAggKey(r);
            var group = [r];
            var j = i + 1;
            while (j < rows.length) {
                var n = rows[j];
                if (n._rowType === 'trade' && n._source && n._source.id && lgAggKey(n) === key) {
                    group.push(n); j++;
                } else break;
            }
            if (group.length >= 2) {
                var aggRow = lgMakeAggRow(group, key);
                out.push(aggRow);
                // When expanded, also emit the individual member rows (rendered
                // normally + indented) so each trader split stays editable.
                if (lgAggExpanded[aggRow._aggKey]) {
                    group.forEach(function(m) { m._aggMember = true; m._aggKey = aggRow._aggKey; out.push(m); });
                }
                i = j;
                continue;
            } else {
                delete r._aggMember;  // clear any stale flag from a prior render
            }
        }
        out.push(r);
        i++;
    }
    return out;
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

    // Hide-pre-recon mode (LESSONS §E.15.15). Find the LATEST RECONCILIATION
    // row within the currently-visible rows. When found AND lgHidePreRecon is
    // true, all rows with date <= recon.date will be skipped below, and the
    // OB row is overridden to show the recon date + recon's running balance
    // (the snapshot anchor). Engine-side _runningBalance on rows AFTER the
    // recon is unchanged, so subsequent displayed balances stay consistent.
    var latestRecon = null;
    if (lgHidePreRecon) {
        for (var ri = 0; ri < sorted.length; ri++) {
            var rRow = sorted[ri];
            if (rRow._rowType === 'ledger' && rRow.entryType === 'RECONCILIATION') {
                if (!latestRecon || (rRow.date || '') > (latestRecon.date || '')) {
                    latestRecon = rRow;
                }
            }
        }
        if (latestRecon) {
            // Override OB to recon snapshot. Use the engine's _runningBalance
            // (firm-POV) — display flip is applied by lgRenderOpeningBalance
            // via lgD(). If drift exists between stored recon.amount and the
            // computed _runningBalance, the yellow drift banner separately
            // alerts the user; the displayed OB tracks the engine so that
            // subsequent row balances line up.
            openingBal = {
                id: null,
                date: latestRecon.date,
                amount: (typeof latestRecon._runningBalance === 'number') ? latestRecon._runningBalance : (latestRecon.amount || 0),
                storedAmount: 0,
                storedDate: '',
                isCarryForward: true,  // disables inline edit on the synthetic OB
                exists: false,
                isReconBased: true,    // marker for lgRenderOpeningBalance to swap layout
                reconId: (latestRecon._source && latestRecon._source.id) || ''
            };
        }
    }

    var html = '';
    var totalAmount = 0;
    var lastBalance = openingBal.amount || 0; // Start with opening balance (carry-forward)

    // Pre-filter BEFORE aggregation so hidden rows can't break adjacency:
    //  - F&O futures filter (LESSONS §E.15.14): when the toggle is OFF, hide
    //    futures trade rows with no cash impact (muted informational rows).
    //    Options (CE/PE) + NFO_PNL synthetic rows have _nfoCashImpact !== false.
    //  - Hide-pre-recon filter (LESSONS §E.15.15): skip rows dated on/before the
    //    latest reconciliation (the recon row becomes the synthesized OB row).
    // Engine/margin/interest read the full ledger upstream — unaffected.
    var visibleRows = sorted.filter(function(row) {
        if (!lgShowFutures && row._rowType === 'trade' && row._nfoCashImpact === false) return false;
        if (latestRecon && row.date && row.date <= latestRecon.date) return false;
        return true;
    });
    // Collapse broker split-trades into expandable rows (broker view only).
    var renderList = lgAggregateBrokerSplits(visibleRows);

    renderList.forEach(function(row) {
        var date = lgFmtDate(row.date);
        var symbol = '';
        var typeHtml = '';
        var qty = '';
        var price = '';
        var net = '';
        var amount = '';
        var balance = '';
        var actions = '';

        // Counterparty-POV display values (LESSONS §E.15.13). Engine still uses
        // raw firm-POV row.amount / row._runningBalance for totals + internal math.
        var dispAmt = lgD(row.amount);
        var dispBal = lgD(row._runningBalance);

        if (row._rowType === 'pending_interest') {
            // Synthetic, unposted weekly interest row
            typeHtml = '<span class="lg-type lg-type-income">Interest (pending)</span>';
            symbol = wmsEsc(row.reference || '');
            amount = '<span class="lg-int-amt" title="Click to view calculation / edit">' + lgFmt(Math.round(dispAmt)) + '</span>';
            balance = lgFmt(dispBal);
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
                    lgFmt(Math.round(dispAmt)) + '</span>';
            } else {
                amount = lgFmt(dispAmt);
            }

            // Show reference as symbol for ledger entries
            if (source.reference) {
                symbol = wmsEsc(source.reference);
            }

            balance = lgFmt(dispBal);
            lastBalance = row._runningBalance;

            // Edit/delete — standard icons (D.9: ✏️ edit, 🗑️ delete)
            actions = '<span class="lg-actions">' +
                '<a href="#" onclick="event.preventDefault(); lgEditEntry(\'' + wmsEsc(source.id) + '\');" title="Edit">✏️</a>' +
                '<a href="#" class="lg-del" onclick="event.preventDefault(); lgDeleteEntry(\'' + wmsEsc(source.id) + '\', this);" title="Delete">🗑️</a>' +
                '</span>';
        } else if (row._rowType === 'nfo_pnl') {
            // Synthetic realised P&L row from F&O cover (FIFO matched)
            symbol = lgFormatSymbol(row);
            typeHtml = lgFormatType(row);
            qty = row.quantity ? (typeof formatQuantity === 'function' ? formatQuantity(row.quantity) : String(Math.round(row.quantity))) : '';
            amount = lgFmt(dispAmt);
            balance = lgFmt(dispBal);
            lastBalance = row._runningBalance;
        } else if (row._rowType === 'trade') {
            var source = row._source;
            symbol = lgFormatSymbol(row);
            typeHtml = lgFormatType(row);

            // Aggregated broker-split header: caret + ×N badge (E.17.11).
            if (row._isAgg) {
                var caret = lgAggExpanded[row._aggKey] ? '▾' : '▸';
                symbol = '<span class="lg-agg-caret">' + caret + '</span>' + symbol +
                         '<span class="lg-agg-count">×' + row._members.length + '</span>';
            } else if (row._aggMember) {
                // Expanded member row: tag with the trader it's allocated to.
                var _tnm = (typeof wmsRefData !== 'undefined' && wmsRefData.investorObjMap)
                    ? wmsRefData.investorObjMap[source && source.trader_id] : null;
                var _tlabel = _tnm ? (_tnm.short_name || _tnm.name) : '';
                if (_tlabel) symbol += ' <span class="lg-agg-trader">· ' + wmsEsc(_tlabel) + '</span>';
            }

            // Qty column shows magnitude only — the Type badge ('Buy' / 'Sell' /
            // 'Rights' / 'Bonus' / 'Split') already indicates direction; signing
            // the qty as well would double-encode the information.
            var q = Math.abs(source.quantity || 0);
            if (q !== 0) {
                qty = typeof formatQuantity === 'function' ? formatQuantity(q) : String(Math.round(q));
            }

            price = source.price ? lgFmtPrice(source.price) : '';

            // Use row.netAmount (perspective-correct, already magnitude) and row.quantity
            // so the per-unit price matches the amount column for investor/trader/broker views.
            if (row.quantity && row.netAmount) {
                var netPerUnit = row.netAmount / Math.abs(row.quantity);
                net = lgFmtPrice(netPerUnit);
            }

            amount = lgFmt(dispAmt);
            balance = lgFmt(dispBal);
            lastBalance = row._runningBalance;
        }

        // Colour classes reflect the DISPLAYED (flipped) value so red = -ve in
        // the counterparty's view (their account in deficit / payment out).
        var amtClass = lgAmtClass(dispAmt);
        var balClass = lgAmtClass(dispBal);

        // Trade rows are clickable → open shared trading edit modal
        var trAttrs = '';
        var isReconRow = (row._rowType === 'ledger' && row.entryType === 'RECONCILIATION');
        if (isReconRow) {
            // Reconciliation audit snapshot — persistent green styling
            trAttrs = ' class="lg-row-recon" data-entry-id="' + wmsEsc((row._source && row._source.id) || '') + '"';
        } else if (row._isAgg) {
            // Aggregated broker-split header — click toggles expand (no edit).
            trAttrs = ' class="lg-row-agg" data-agg-key="' + wmsEsc(row._aggKey) + '"';
        } else if (row._rowType === 'nfo_pnl') {
            trAttrs = ' class="lg-row-nfo-pnl"';
        } else if (row._rowType === 'trade' && row.isNFO && !row._isOption) {
            // Futures trade rows are informational (no cash impact) — muted style
            trAttrs = ' class="lg-row-trade lg-row-nfo" data-txn-id="' + wmsEsc((row._source && row._source.id) || '') + '"';
        } else if (row._rowType === 'trade' && row._source && row._source.id) {
            trAttrs = ' class="lg-row-trade" data-txn-id="' + wmsEsc(row._source.id) + '"';
        } else if (row._rowType === 'pending_interest') {
            trAttrs = ' class="lg-row-pending" data-pending-key="' + wmsEsc(row._pendingKey) + '"';
        }

        // Indent + tag expanded split-member rows (E.17.11) while keeping the
        // lg-row-trade class + data-txn-id so each member stays editable.
        if (row._aggMember && trAttrs.indexOf('class="') >= 0) {
            trAttrs = trAttrs.replace('class="', 'class="lg-row-agg-member ');
        }

        // Futures trade rows: muted (no cash impact, balance unchanged).
        // Option trade rows: normal (premium is cash, balance changes).
        var isFuturesTrade = (row._rowType === 'trade' && row.isNFO && !row._isOption);
        var displayAmt = isFuturesTrade ? ('<span style="opacity:0.45">' + amount + '</span>') : amount;
        var displayBal = isFuturesTrade ? ('<span style="opacity:0.45">' + balance + '</span>') : balance;

        // Hover-triggered recon mark on the left of the date cell. Clicking
        // reconciles everything UP TO AND INCLUDING this row's date at the
        // row's running balance. Skipped on reconciliation rows (persistent
        // mark instead) and pending interest rows.
        var reconMark = '';
        if (isReconRow) {
            // Persistent ✓ badge for existing reconciliation rows — shows
            // this IS an audit snapshot, not a candidate for new recon. The
            // adjacent ✕ link calls lgCancelReconciliation (LESSONS §E.17.9)
            // to delete just this snapshot row (no trades / interest / cash
            // entries are affected). stopPropagation prevents the row-click
            // trade-edit modal from opening.
            var reconRowId = (row._source && row._source.id) || '';
            reconMark = '<span style="color:#059669; font-weight:700; margin-right:2px;">✓</span>' +
                '<a href="#" class="lg-recon-cancel" ' +
                'data-recon-id="' + wmsEsc(reconRowId) + '" ' +
                'data-recon-date="' + wmsEsc(row.date) + '" ' +
                'onclick="event.preventDefault(); event.stopPropagation(); lgCancelReconciliation(this.dataset.reconId, this.dataset.reconDate);" ' +
                'title="Cancel this reconciliation snapshot (trades + interest are untouched)">✕</a>';
        } else if (row._rowType !== 'pending_interest' && row.date) {
            reconMark = '<span class="lg-recon-trigger" ' +
                'data-recon-date="' + wmsEsc(row.date) + '" ' +
                'data-recon-balance="' + (row._runningBalance || 0) + '" ' +
                'onclick="event.stopPropagation(); lgReconcileUpTo(this.dataset.reconDate, parseFloat(this.dataset.reconBalance));" ' +
                'title="Reconcile all entries up to and including ' + wmsEsc(row.date) + '">✓</span>';
        }

        html += '<tr' + trAttrs + '>' +
            '<td class="text-right">' + reconMark + date + '</td>' +
            '<td>' + symbol + (actions ? ' ' + actions : '') + '</td>' +
            '<td>' + typeHtml + '</td>' +
            '<td class="text-right">' + qty + '</td>' +
            '<td class="text-right">' + price + '</td>' +
            '<td class="text-right">' + net + '</td>' +
            '<td class="text-right ' + amtClass + '">' + displayAmt + '</td>' +
            '<td class="text-right ' + balClass + '">' + displayBal + '</td>' +
            '</tr>';

        // Only accumulate cash-impact rows in the total.
        // Skip balance-anchor rows (OPENING_BALANCE, RECONCILIATION) — their
        // amount is a snapshot value, not a delta, and would double-count.
        var isAnchor = (row._rowType === 'ledger' &&
            (row.entryType === 'OPENING_BALANCE' || row.entryType === 'RECONCILIATION'));
        if (row._nfoCashImpact !== false && !isAnchor) {
            totalAmount += row.amount;
        }
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

    // Update totals in tfoot — only the closing Balance is shown (the Amount
    // sum was removed per owner spec — the closing Balance IS the total
    // receivable/payable). Label is dynamic based on Balance sign.
    var totalsLabelEl = document.getElementById('lgTotalsLabel');
    var totalBalEl = document.getElementById('lgTotalBalance');
    var dispLastBal = lgD(lastBalance);
    if (totalsLabelEl) {
        totalsLabelEl.textContent = (dispLastBal < 0) ? 'Total Payable' : 'Total Receivable';
    }
    if (totalBalEl) {
        totalBalEl.innerHTML = lgFmt(dispLastBal);
        totalBalEl.className = 'text-right ' + lgAmtClass(dispLastBal);
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
    //
    // CRITICAL: scope the lookup to the currently-effective investor. Without
    // this, a multi-investor ledger returns the *first* OPENING_BALANCE row
    // in the array regardless of which view is active, and the inline edit
    // then PATCHes the wrong investor's row (observed bug: editing on
    // stmt_T2 silently overwrote T3's opening balance).
    //
    // ALSO scope by broker_id for broker statements (e.g. stmt_TG). An
    // investor with multiple broker accounts has one OB row per broker;
    // without this filter the wrong broker's OB would be returned and the
    // inline edit would PATCH the wrong row. The save path
    // (lgSaveOpeningBalance) already includes broker_id in POST bodies.
    // WMS-CONTEXT 🎯 PRIORITY Issue 2.
    var effInvId = (typeof lgGetEffectiveInvestorId === 'function') ? lgGetEffectiveInvestorId() : null;
    var isBroker = (lgStatementType === 'broker');
    var effBrkId = (isBroker && lgSelectedBrokerIds.length === 1) ? lgSelectedBrokerIds[0] : null;
    var stored = lgLedgerEntries.find(function(e) {
        if (e.entry_type !== 'OPENING_BALANCE') return false;
        if (effInvId && e.investor_id !== effInvId) return false;
        if (effBrkId && e.broker_id !== effBrkId) return false;
        return true;
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
    var symbolEl = document.getElementById('lgObSymbol');

    if (dateEl) {
        // Hide-pre-recon mode (LESSONS §E.15.15): when the OB is synthesized
        // from the latest RECONCILIATION row, prefix the date with the green
        // ✓ marker AND a ✕ cancel link (LESSONS §E.17.9). This is the user's
        // only way to cancel a recon while hide-pre-recon is ON, since the
        // actual recon row is collapsed into this synthetic OB.
        var dateText = ob.date ? lgFmtDate(ob.date) : '';
        if (ob.isReconBased) {
            var cancelHtml = '';
            if (ob.reconId) {
                cancelHtml = '<a href="#" class="lg-recon-cancel" ' +
                    'data-recon-id="' + wmsEsc(ob.reconId) + '" ' +
                    'data-recon-date="' + wmsEsc(ob.date) + '" ' +
                    'onclick="event.preventDefault(); event.stopPropagation(); lgCancelReconciliation(this.dataset.reconId, this.dataset.reconDate);" ' +
                    'title="Cancel this reconciliation snapshot (trades + interest are untouched)">✕</a>';
            }
            dateEl.innerHTML = '<span style="color:#059669; font-weight:700; margin-right:2px;" title="Reconciled balance — pre-recon rows hidden">✓</span>' + cancelHtml + wmsEsc(dateText);
        } else {
            dateEl.textContent = dateText;
        }
    }

    // Symbol cell — for a recon-based OB, drop the "Opening Balance" text so
    // the row reads as a pure reconciliation anchor (Type column carries the
    // "✓ Reconciled" badge below). For a regular OB, restore the default text.
    if (symbolEl) {
        symbolEl.textContent = ob.isReconBased ? '' : 'Opening Balance';
    }
    if (amountEl) {
        if (lgObEditing) return; // Don't overwrite while editing
        // Editable only when the displayed date equals the stored OPENING_BALANCE's
        // entry_date — i.e. we're viewing the actual FY-start opening.
        // For any later window (mid-FY filter), the value is a computed carry-forward
        // and must not be editable.
        var isEditable = !ob.isCarryForward && (!ob.exists || ob.storedDate === ob.date);
        // Counterparty-POV display flip (LESSONS §E.15.13). ob.amount stays in
        // firm-POV internally — only display flips.
        var dispOb = lgD(ob.amount);
        var amtHtml;
        if (isEditable) {
            amtHtml = ob.exists ?
                '<span class="lg-ob-amount" title="Double-click to edit">' + lgFmt(dispOb) + '</span>' :
                '<span class="lg-ob-amount" style="color:#9ca3af;" title="Double-click to set opening balance">Set...</span>';
        } else {
            var titleText = ob.isReconBased
                ? 'Reconciled balance as of ' + wmsEsc(ob.date) + ' (pre-recon rows hidden — toggle "Hide pre-recon" to see them)'
                : 'Carry-forward running balance as of ' + wmsEsc(ob.date) + ' (not editable)';
            amtHtml = '<span title="' + titleText + '">' + lgFmt(dispOb) + '</span>';
        }
        amountEl.innerHTML = amtHtml;
        amountEl.className = 'text-right ' + lgAmtClass(dispOb);
    }
    if (balanceEl) {
        var dispObBal = lgD(ob.amount);
        balanceEl.innerHTML = lgFmt(dispObBal);
        balanceEl.className = 'text-right ' + lgAmtClass(dispObBal);
    }
    var descEl = document.getElementById('lgObDescription');
    if (descEl) {
        // Counterparty-POV labels — dispObDesc > 0 means firm owes counterparty
        // at start (their credit), dispObDesc < 0 means counterparty owes firm.
        var dispObDesc = lgD(ob.amount || 0);
        var label = '';
        if (ob.isReconBased) {
            // Hide-pre-recon mode (LESSONS \u00a7E.15.15): replace the arrow-style
            // description with a "\u2713 Reconciled" Type-column badge. descEl
            // spans Type / Qty / Price / Net via colspan=4, so the badge sits
            // visually in the Type column. The italic + grey of the parent
            // inline style is overridden so the badge reads cleanly.
            descEl.innerHTML = '<span class="lg-type lg-type-recon" style="font-style:normal;">\u2713 Reconciled</span>';
        } else {
            // Counterparty-POV phrasing: +ve = firm owes counterparty (their receivable);
            // -ve = counterparty owes firm (their payable). LESSONS \u00a7E.15.13.
            if (dispObDesc > 0) {
                label = '\u2190 opening receivable';
            } else if (dispObDesc < 0) {
                label = '\u2192 opening payable';
            } else {
                label = 'no opening balance';
            }
            descEl.textContent = label;
        }
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
    // Use the shared effective-investor resolver so a sole trader filter
    // (T2/T3 views) resolves to the underlying investor, mirroring the
    // add-entry row behaviour.
    var investorId = lgGetEffectiveInvestorId();

    if (!investorId) {
        showAlert('Select exactly one investor (or trader) to edit the opening balance', 'warning', 3000);
        lgCancelObEdit();
        return;
    }

    try {
        if (ob.exists && ob.id) {
            // Update existing opening balance — PATCH only amount, scope
            // columns/view_id preserved as originally saved.
            await fetch(SUPABASE_URL + '/rest/v1/ledger_entries?id=eq.' + ob.id, {
                method: 'PATCH',
                headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
                body: JSON.stringify({ amount: newAmount })
            });
        } else {
            // Create new opening balance entry — pre-ledger-POST gate required.
            var viewId = await lgEnsureViewSaved('set opening balance');
            if (!viewId) { lgObEditing = false; lgRefresh(); return; }
            var entryDate = lgDateFrom || new Date().toISOString().slice(0, 10);
            await fetch(SUPABASE_URL + '/rest/v1/ledger_entries', {
                method: 'POST',
                headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
                body: JSON.stringify({
                    investor_id: investorId,
                    trader_id: (lgSelectedTraderIds && lgSelectedTraderIds.length === 1) ? lgSelectedTraderIds[0] : null,
                    broker_id: (lgSelectedBrokerIds && lgSelectedBrokerIds.length === 1) ? lgSelectedBrokerIds[0] : null,
                    view_id: viewId,
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

// Tax rate on booked gains — resolved from investor/IBA DB fields via wmsGetTaxRate().
// Checks investor pill first; if no single investor, falls back to trader pill
// (traders are also in the investors table and can have their own tax rate).
// ============================================================================
// STATEMENT TYPE TOGGLE (Trader / Broker)
// ============================================================================
// Two-segment control in the view-tabs bar. Switching the toggle changes
// `lgStatementType` and re-runs `lgRefresh` immediately. The value is then
// persisted into `portfolio_views.filters` when the user saves the view.
// LESSONS §E.15.12.

function lgInitStatementTypeToggle() {
    var container = document.getElementById('lgStmtTypeToggle');
    if (!container || container.dataset.lgWired) return;
    container.dataset.lgWired = '1';
    container.addEventListener('click', function(e) {
        var btn = e.target.closest('.lg-stmt-type-btn');
        if (!btn) return;
        var newType = btn.getAttribute('data-type');
        if (!newType || newType === lgStatementType) return;
        lgStatementType = newType;
        lgSyncStatementTypeToggle();
        // lgVM.updateViewButtons rechecks dirty-state vs saved view filters,
        // including the new statementType field via lgFiltersEqual.
        if (lgVM && typeof lgVM.updateViewButtons === 'function') lgVM.updateViewButtons();
        lgRefresh();
    });
    lgSyncStatementTypeToggle();
}

function lgSyncStatementTypeToggle() {
    var container = document.getElementById('lgStmtTypeToggle');
    if (!container) return;
    var btns = container.querySelectorAll('.lg-stmt-type-btn');
    for (var i = 0; i < btns.length; i++) {
        var t = btns[i].getAttribute('data-type');
        if (t === lgStatementType) btns[i].classList.add('active');
        else btns[i].classList.remove('active');
    }
}

function lgGetEffectiveTaxRate() {
    var invId = (lgSelectedInvestorIds.length === 1) ? lgSelectedInvestorIds[0] : null;
    if (!invId) invId = (lgSelectedTraderIds.length === 1) ? lgSelectedTraderIds[0] : null;
    var brkId = (lgSelectedBrokerIds.length === 1) ? lgSelectedBrokerIds[0] : null;
    return wmsGetTaxRate(invId, brkId);
}

// Latest RECONCILIATION date the statement is anchored to, or '' when none
// applies (no recon in scope, or hide-pre-recon is off). Single source of
// truth for the "since last recon" split (§E.15.17). Reads lgFullCombined,
// which lgRefresh populates (line ~1095) BEFORE lgRenderSummary runs and which
// is already scoped to the active view's investor/trader/broker filter — so
// the split date always matches the reconciliation the transaction section is
// anchored to (§E.15.15).
function lgAnchorReconDate() {
    if (!lgHidePreRecon) return '';
    if (!Array.isArray(lgFullCombined)) return '';
    var latest = '';
    for (var i = 0; i < lgFullCombined.length; i++) {
        var r = lgFullCombined[i];
        if (r && r._rowType === 'ledger' && r.entryType === 'RECONCILIATION') {
            if ((r.date || '') > latest) latest = r.date || '';
        }
    }
    return latest;
}

// Split a set of FY booked gains into Starting (realised on/before the recon
// date) + New (realised after it), per §E.15.17. Returns
// { split, reconDate, startingGain, startingGains, newGains, total }. When no
// reconciliation falls inside the FY window, split=false and newGains = all FY
// gains, so the Booked P&L section renders exactly as it did before the split.
// `startingGains` is the pre-recon gain list (for the expandable Starting
// breakdown, §E.15.17); `total` is always the full-FY booked P&L (the tax base).
function lgSplitBookedGains(fyGains, fyStartStr, fyEndStr) {
    var reconDate = lgAnchorReconDate();
    var total = 0;
    fyGains.forEach(function(g) { total += (g.gain || 0); });
    var inFy = reconDate && reconDate >= fyStartStr && reconDate <= fyEndStr;
    if (!inFy) {
        return { split: false, reconDate: '', startingGain: 0, startingGains: [], newGains: fyGains.slice(), total: total };
    }
    var newGains = fyGains.filter(function(g) { return g.sellDate && g.sellDate > reconDate; });
    var startingGains = fyGains.filter(function(g) { return g.sellDate && g.sellDate <= reconDate; });
    var newSum = 0;
    newGains.forEach(function(g) { newSum += (g.gain || 0); });
    return { split: true, reconDate: reconDate, startingGain: total - newSum, startingGains: startingGains, newGains: newGains, total: total };
}

function lgRenderSummary() {
    var summaryBody = document.getElementById('lgSummaryBody');
    if (!summaryBody) return;

    // Resolve effective tax rate from DB (investor/IBA level, fallback to default)
    var taxRatePct = lgGetEffectiveTaxRate();

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

    // Use shared FIFO engine (wms-shared.js) — it now handles rights/bonus/
    // income/historical_pl natively and groups EQ across exchanges while
    // keeping NFO contracts distinct.
    var fifo = wmsCalcFifoCost(sorted);
    var holdingsMap = fifo.holdings;
    var allGains = fifo.gains || [];

    // Build source lookup for NFO symbol decoding — match the engine's key
    // scheme: EQ keys by short_symbol, NFO keys by full symbol with any
    // exchange prefix (e.g. "NSE:") stripped. wmsCalcFifoCost keys NFO rows
    // this way, so sourceLookup must match or decoding falls through to the
    // bare short_symbol and the contract detail is lost.
    var sourceLookup = {};
    for (var si = 0; si < sorted.length; si++) {
        var st = sorted[si];
        var sKey;
        if (wmsIsDerivativeSecurity(st.security_type)) {
            sKey = (st.symbol || '').replace(/^[A-Z]+:/, '');
        } else {
            sKey = st.short_symbol || st.symbol || '';
        }
        if (!sourceLookup[sKey]) sourceLookup[sKey] = st;
    }

    // Compute F&O running margin (final value = current open margin).
    // Includes MCX commodity F&O via the shared predicate (§E.15).
    var nfoTxnsForMargin = sorted.filter(function(t) {
        return wmsIsDerivativeTxn(t);
    });
    var marginEvents = wmsCalcMarginFIFO(nfoTxnsForMargin);
    var currentNfoMargin = marginEvents.length > 0 ? marginEvents[marginEvents.length - 1].runningMargin : 0;

    // ------------------------------------------------------------
    // Build holdings table rows — split EQ vs NFO
    //   EQ:  Value = Qty × CMP,  MTM = Value − Cost
    //   NFO: Value = MTM (open P&L from live price vs trade price).
    //        NFO has no notional "value" on the books — the position lives
    //        against blocked margin — so we surface the MTM in the Value
    //        column. This lets Open Positions footer totals match the
    //        summary card total (totalEqValue + totalNfoMtm) and makes
    //        the row visibly contribute to today's effective balance.
    // ------------------------------------------------------------
    var totalEqCost = 0;
    var totalEqValue = 0;
    var totalEqMtm = 0;
    var totalNfoMtm = 0;

    // Sort holdings by symbol (case-insensitive)
    var sortedKeys = Object.keys(holdingsMap).sort(function(a, b) {
        var ha = holdingsMap[a], hb = holdingsMap[b];
        var sa = (ha.shortSymbol || ha.symbol || '').toLowerCase();
        var sb = (hb.shortSymbol || hb.symbol || '').toLowerCase();
        if (sa < sb) return -1;
        if (sa > sb) return 1;
        return 0;
    });

    var rowsHtml = sortedKeys.map(function(key) {
        var h = holdingsMap[key];
        if (h.quantity === 0) return '';

        var qty = h.quantity;
        var cost = h.totalCost;
        var avgCost = h.avgCost;
        var isNfo = wmsIsDerivativeSecurity(h.securityType);

        // CMP from shared live price cache. For NFO contracts (options + futures)
        // the live-price lookup MUST use the full contract symbol — e.g.
        // 'PGEL26JUN500CE' or 'PGEL26MAYFUT' — NOT the underlying short_symbol.
        // The holdings map key IS the prefix-stripped contract symbol for NFO
        // (see _engineKey in wms-shared.js), so `key` is exactly what we need.
        // Bug pre-fix: shortSym='PGEL' returned the underlying equity spot
        // (478.45) for the PGEL 500 CE option row, producing a phantom MTM
        // computed as (spot − premium_avg) instead of (option_lp − premium_avg).
        // See LESSONS §E.15.17.
        var shortSym = h.shortSymbol || h.symbol;
        var priceLookupKey = isNfo ? key : shortSym;
        var priceEntry = (typeof wmsLivePrices === 'object' && wmsLivePrices) ? wmsLivePrices[priceLookupKey] : null;
        var cmp = (priceEntry && priceEntry.lp > 0) ? priceEntry.lp : avgCost;

        var value, mtm;
        if (isNfo) {
            mtm = (cmp - avgCost) * qty;
            value = mtm;           // NFO Value column reflects open P&L
            totalNfoMtm += mtm;
        } else {
            value = qty * cmp;
            mtm = value - cost;
            totalEqCost += cost;
            totalEqValue += value;
            totalEqMtm += mtm;
        }

        var mtmClass = lgAmtClass(mtm);
        var typeLabel = wmsSecTypeShortLabel(h.securityType);

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

        return '<tr class="lg-holding-row" data-key="' + wmsEsc(shortSym) + '" style="cursor:pointer;">' +
            '<td>' + symHtml + '</td>' +
            '<td class="lg-col-type">' + typeLabel + '</td>' +
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

    // Table footer totals — Value footer matches the summary card
    // (EQ value + NFO MTM) so the two surfaces always reconcile.
    var totalMtm = totalEqMtm + totalNfoMtm;
    var totalValue = totalEqValue + totalNfoMtm;
    var mtmTotalEl = document.getElementById('lgSummaryMtmTotal');
    var valTotalEl = document.getElementById('lgSummaryValueTotal');
    if (mtmTotalEl) {
        mtmTotalEl.innerHTML = lgFmt(totalMtm);
        mtmTotalEl.className = 'text-right ' + lgAmtClass(totalMtm);
    }
    if (valTotalEl) valTotalEl.innerHTML = lgFmt(totalValue);

    // ------------------------------------------------------------
    // Summary cards
    //   Ledger convention (same for investor AND trader perspectives —
    //   see LESSONS E.15.1, revised 2026-04-24):
    //     +ve cash balance  → counterparty owes the firm
    //     -ve cash balance  → firm owes the counterparty (credit)
    //   Raw cashBalance flows through to every card so negative balances
    //   are preserved end-to-end. Outstanding = raw cash + margin (may be
    //   negative if firm's cash debt exceeds the margin collateral).
    // ------------------------------------------------------------
    var cashBalance = (typeof lgCurrentCashBalance === 'number') ? lgCurrentCashBalance : (lgCarryForwardBalance || 0);
    var outstanding = cashBalance + currentNfoMargin;

    // Transactions block header — both Cash balance and F&O Margin are
    // signed in counterparty-POV (negative = trader owes). Margin is NOT
    // collateral the firm owes back — it's funding the firm has advanced
    // to support the trader's F&O positions, on which the trader pays
    // interest. Both legs are debts from the trader's perspective.
    // LESSONS §E.15.13 (revised 2026-05-25).
    var displayCash = lgD(cashBalance);
    var displayMargin = lgD(currentNfoMargin);
    var displayOutstanding = displayCash + displayMargin;
    var txnBalEl = document.getElementById('lgTransactionsBalance');
    if (txnBalEl) {
        var balanceTxt =
            '<span style="color:#718096; font-weight:500;">Balance</span> ' +
            '<span class="' + lgAmtClass(displayCash) + '">' + lgFmt(displayCash) + '</span>';
        if (Math.abs(currentNfoMargin) > 0.01) {
            balanceTxt +=
                ' <span style="color:#cbd5e0;">|</span> ' +
                '<span style="color:#718096; font-weight:500;">F&amp;O Margin</span> ' +
                '<span class="' + lgAmtClass(displayMargin) + '">' + lgFmt(displayMargin) + '</span>';
        }
        txnBalEl.innerHTML = balanceTxt;
    }

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

    // Split FY booked P&L into Starting (pre-recon) + New (since-recon) for the
    // Booked P&L section (§E.15.17). Tax + header total stay on the FY total.
    var lgBookedSplit = lgSplitBookedGains(fyGains, fyStartStr, fyEndStr);

    // Potential Tax — applies on BOTH trader and broker statements: it's the
    // firm-level tax exposure on already-booked gains (and on broker statements,
    // these are the gains realised via THAT broker). The rate resolves via
    // wmsGetTaxRate(investorId, brokerId) which prefers the IBA-level override
    // (investor_broker_accounts.tax_rate, migration 33) before falling back to
    // investor-level, so each broker can have its own rate.
    // Revised 2026-05-27 from the 2026-05-25 design that zero'd this for broker
    // views — that hid relevant tax exposure from the Net Receivable formula
    // (the broker statement IS the firm's view of the broker invoice; closing
    // positions to settle the invoice triggers real tax for the firm).
    // See LESSONS §E.15.12 (revised).
    var isBrokerStmt = (lgStatementType === 'broker');
    var potentialTax = Math.max(0, totalBookedGain) * (taxRatePct / 100);

    // Net Receivable = total holdings value (EQ + NFO MTM) − raw cash
    // balance − Tax. NFO margin is NOT subtracted (it's collateral, not
    // cash owed). Raw (unclamped) cash balance means a negative balance —
    // firm owes the counterparty — ADDS to what they're receivable (the
    // cash credit is part of what they'd take away if they closed out).
    // See LESSONS E.15.1 (revised 2026-04-24).
    var totalHoldingsValue = totalEqValue + totalNfoMtm;
    var netReceivable = totalHoldingsValue - cashBalance - potentialTax;

    // Balance w/o MTM — conservative variant per owner spec 2026-05-25:
    //   if MTM > 0 → BwoM = NR − MTM (close at cost, lose the unrealised gain)
    //   if MTM ≤ 0 → BwoM = NR        (no adjustment — losses don't flatter
    //                                   the picture; show worse of the two)
    // This is intentionally asymmetric so the card always reads as the more
    // conservative downside number from the counterparty's POV.
    var totalCurrentMtm = totalEqMtm + totalNfoMtm;
    var balNoMtm = (totalCurrentMtm > 0) ? (netReceivable - totalCurrentMtm) : netReceivable;
    // Ratio is meaningful only when outstanding is meaningfully positive;
    // when it's near-zero or negative, the ratio is either a divide risk
    // or semantically confusing, so suppress it.
    var pctBalOverOutstanding = outstanding > 0.01 ? (balNoMtm / outstanding) * 100 : 0;

    function setCard(id, val, useAmtClass) {
        var el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = lgFmt(val);
        if (useAmtClass) el.className = 'lg-summary-card-value ' + lgAmtClass(val);
    }
    setCard('lgCardHoldingsValue', totalHoldingsValue, false);
    // Outstanding card — counterparty-POV (LESSONS §E.15.13). Headline =
    // displayCash + Margin (matches the subtitle sum). Negative = counterparty
    // owes firm; positive = firm owes counterparty.
    setCard('lgCardOutstanding', displayOutstanding, true);
    var outBreakEl = document.getElementById('lgCardOutstandingBreakdown');
    if (outBreakEl) {
        // Subtitle — Cash and Margin shown side by side, both signed in
        // counterparty-POV. Headline is their sum. LESSONS §E.15.13 (rev).
        var sub = 'Cash ' + lgFmt(displayCash);
        if (Math.abs(currentNfoMargin) > 0.01) {
            sub += ' | Margin ' + lgFmt(displayMargin);
        }
        outBreakEl.innerHTML = sub;
    }
    setCard('lgCardPotentialTax', potentialTax, false);
    var taxLabelEl = document.getElementById('lgCardPotentialTaxLabel');
    if (taxLabelEl) taxLabelEl.textContent = 'Potential Tax (' + taxRatePct + '%)';
    // Potential Tax card is visible on BOTH trader AND broker statements
    // (revised 2026-05-27). The IBA-level tax_rate resolution gives each
    // broker its own rate, so on stmt_TG (T0/TG) the displayed rate comes
    // from investor_broker_accounts.tax_rate for (T0, TG). LESSONS §E.15.12.
    var taxCardWrap = document.getElementById('lgCardPotentialTaxWrap');
    var taxOpEl = document.getElementById('lgCardPotentialTaxOp');
    if (taxCardWrap) taxCardWrap.style.display = '';
    if (taxOpEl) taxOpEl.style.display = '';
    setCard('lgCardNetReceivable', netReceivable, true);
    // Dynamic label: positive netReceivable means counterparty receives net
    // (firm pays out); negative means counterparty pays net (LESSONS §E.15.13).
    var nrLabelEl = document.getElementById('lgCardNetReceivableLabel');
    if (nrLabelEl) {
        nrLabelEl.textContent = (netReceivable < 0) ? 'Net Payable' : 'Net Receivable';
    }
    // Balance w/o MTM — now a sub-text inside the NR card (LESSONS §E.15.13).
    // Only show the ratio when outstanding is meaningfully positive.
    var balEl = document.getElementById('lgCardBalNoMtm');
    if (balEl) {
        balEl.innerHTML = lgFmt(balNoMtm);
        balEl.className = lgAmtClass(balNoMtm);
    }
    var balSubEl = document.getElementById('lgCardBalNoMtmSub');
    if (balSubEl) balSubEl.textContent = outstanding > 0.01 ? ' (' + pctBalOverOutstanding.toFixed(1) + '%)' : '';

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
            // When a reconciliation splits the FY, the by-symbol rows show only
            // the NEW (since-recon) gains, bracketed by a Starting line above and
            // a New subtotal below; the header total stays on the FY figure
            // (§E.15.17). Without a recon, newGains === all FY gains → unchanged.
            var lgNewSum = totalBookedGain - lgBookedSplit.startingGain;

            // Reusable by-symbol row builder — shared by the New rows and the
            // expandable Starting (pre-recon) breakdown. Groups by symbol +
            // securityType (NFO keyed by prefix-stripped full symbol so distinct
            // expiries stay distinct; EQ by short_symbol) and decodes the NFO
            // contract label from the source txn (same as Open Positions).
            function _lgBookedRowsHtml(gains, rowClass, rowStyle) {
                var bySym = {};
                gains.forEach(function(g) {
                    var isNfo = wmsIsDerivativeSecurity(g.securityType);
                    var groupKey = isNfo
                        ? ((g.symbol || g.shortSymbol || '').replace(/^[A-Z]+:/, ''))
                        : (g.shortSymbol || g.symbol || '');
                    var k = groupKey + '|' + (g.securityType || 'EQ');
                    if (!bySym[k]) bySym[k] = {
                        shortSymbol: g.shortSymbol || g.symbol,
                        fullSymbol: (g.symbol || '').replace(/^[A-Z]+:/, ''),
                        securityType: g.securityType || 'EQ',
                        qty: 0, gain: 0
                    };
                    bySym[k].qty += g.qty || 0;
                    bySym[k].gain += g.gain || 0;
                });
                return Object.keys(bySym).sort().map(function(k) {
                    var b = bySym[k];
                    var cls = lgAmtClass(b.gain);
                    var typeL = wmsSecTypeShortLabel(b.securityType);
                    var symHtml = wmsEsc(b.shortSymbol || '');
                    if (wmsIsDerivativeSecurity(b.securityType) && typeof wmsFormatContract === 'function') {
                        var srcTxn = sourceLookup[b.fullSymbol];
                        if (srcTxn) {
                            var contract = wmsFormatContract(srcTxn);
                            if (contract && contract !== 'Equity' && contract !== 'NFO') {
                                symHtml = wmsEsc(b.shortSymbol || '') +
                                    ' <span style="color:#718096; font-size:10px;">' + wmsEsc(contract) + '</span>';
                            }
                        }
                    }
                    return '<tr' + (rowClass ? ' class="' + rowClass + '"' : '') + (rowStyle ? ' style="' + rowStyle + '"' : '') + '>' +
                        '<td>' + symHtml + '</td>' +
                        '<td class="lg-col-type">' + typeL + '</td>' +
                        '<td class="text-right">' + (typeof formatQuantity === 'function' ? formatQuantity(b.qty) : String(Math.round(b.qty))) + '</td>' +
                        '<td class="text-right ' + cls + '">' + lgFmt(b.gain) + '</td>' +
                        '</tr>';
                }).join('');
            }

            var lgStartRowHtml = '';
            var lgStartDetailHtml = '';
            var lgNewSubtotalHtml = '';
            if (lgBookedSplit.split) {
                // Starting Booked P&L — clickable to expand the pre-recon
                // breakdown so past booked data stays checkable on screen even
                // though pre-recon transactions are hidden (§E.15.17).
                var _caret = lgBookedStartExpanded ? '▼' : '▶';
                lgStartRowHtml = '<tr class="lg-booked-split-row lg-booked-start-toggle" style="cursor:pointer;">' +
                    '<td colspan="3"><span class="lg-booked-start-caret" style="display:inline-block; width:12px; color:#718096;">' + _caret + '</span>' +
                    'Starting Booked P&amp;L ' +
                    '<span style="color:#718096; font-size:10px;">as on ' + wmsEsc(lgFmtDate(lgBookedSplit.reconDate)) + '</span></td>' +
                    '<td class="text-right ' + lgAmtClass(lgBookedSplit.startingGain) + '">' + lgFmt(lgBookedSplit.startingGain) + '</td>' +
                    '</tr>';
                lgStartDetailHtml = _lgBookedRowsHtml(
                    lgBookedSplit.startingGains,
                    'lg-booked-start-detail',
                    'background:#f9fafb;' + (lgBookedStartExpanded ? '' : ' display:none;'));
                lgNewSubtotalHtml = '<tr class="lg-booked-split-row" style="font-weight:600; border-top:1px solid #e2e8f0;">' +
                    '<td colspan="3">New Booked P&amp;L ' +
                    '<span style="color:#718096; font-size:10px;">since recon</span></td>' +
                    '<td class="text-right ' + lgAmtClass(lgNewSum) + '">' + lgFmt(lgNewSum) + '</td>' +
                    '</tr>';
            }
            var bookedHtml = _lgBookedRowsHtml(lgBookedSplit.newGains, '', '');
            bookedRowsEl.innerHTML = lgStartRowHtml + lgStartDetailHtml + bookedHtml + lgNewSubtotalHtml;

            // Wire the Starting toggle → expand/collapse the pre-recon detail
            // rows. State persists in lgBookedStartExpanded across re-renders.
            var startToggle = bookedRowsEl.querySelector('.lg-booked-start-toggle');
            if (startToggle) {
                startToggle.addEventListener('click', function() {
                    lgBookedStartExpanded = !lgBookedStartExpanded;
                    var caret = startToggle.querySelector('.lg-booked-start-caret');
                    if (caret) caret.textContent = lgBookedStartExpanded ? '▼' : '▶';
                    bookedRowsEl.querySelectorAll('.lg-booked-start-detail').forEach(function(r) {
                        r.style.display = lgBookedStartExpanded ? '' : 'none';
                    });
                });
            }
        }
    }

    // Wire Open Positions header → toggles collapse (original behaviour).
    var openHdr = document.getElementById('lgOpenPosHeader');
    var openSec = document.getElementById('lgOpenPosSection');
    if (openHdr && openSec && !openHdr.dataset.lgWired) {
        openHdr.dataset.lgWired = '1';
        openHdr.addEventListener('click', function() {
            openSec.classList.toggle('lg-booked-collapsed');
        });
    }

    // Wire individual holding rows → open the shared Transactions modal for
    // that symbol, scoped to the Statements module's current filter selection (same as
    // Portfolio's row-click behaviour but honouring the ledger view). The
    // override is installed on window.trTxnModalFilterOverride and is
    // CONSUMED (one-shot) by _trSetTxnCtx at open time — it does not survive
    // past the open it was installed for (2026-08-05 stale-override fix).
    var holdingsBody = document.getElementById('lgSummaryBody');
    if (holdingsBody && !holdingsBody.dataset.lgWired) {
        holdingsBody.dataset.lgWired = '1';
        holdingsBody.addEventListener('click', function(e) {
            var tr = e.target.closest('tr.lg-holding-row');
            if (!tr) return;
            var key = tr.getAttribute('data-key');
            if (key && typeof trOpenTxnModal === 'function') {
                window.trTxnModalFilterOverride = {
                    investorIds: lgSelectedInvestorIds.slice(),
                    traderIds:   lgSelectedTraderIds.slice(),
                    brokerIds:   lgSelectedBrokerIds.slice(),
                    tagNames:    lgSelectedTagNames.slice(),
                    tagLogic:    lgTagFilterLogic || 'OR'
                };
                trOpenTxnModal(key, null);
            }
        });
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

// ============================================================================
// RECONCILIATION — audit snapshot of the running balance at a chosen date.
// The user hovers any ledger row, clicks the ✓ icon that appears to the
// left of the date, confirms the balance, and a RECONCILIATION ledger_entry
// is inserted at that date with amount = the row's running balance. All
// entries on/before that date are visually marked as reconciled.
// See LESSONS §E.17 + migration 38.
// ============================================================================

async function lgReconcileUpTo(reconDate, reconBalance) {
    if (!reconDate) return;
    var investorId = lgGetEffectiveInvestorId();
    if (!investorId) {
        showAlert('Select exactly one investor (or trader) to reconcile', 'warning', 4000);
        return;
    }

    // Pre-ledger-POST gate — every ledger write must carry view_id.
    var viewId = await lgEnsureViewSaved('reconcile');
    if (!viewId) return;

    var fmtBal = (typeof wmsFmtAmt === 'function') ? wmsFmtAmt(reconBalance) : String(reconBalance);
    var prettyDate = lgFmtDate(reconDate) || reconDate;
    var msg = 'Reconcile all entries up to and including ' + prettyDate + '?\n\n' +
              'Balance on this date: ' + fmtBal + '\n\n' +
              'Future edits to pre-reconciliation trades will be flagged for your review.';
    if (!window.confirm(msg)) return;

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/ledger_entries', {
            method: 'POST',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
            body: JSON.stringify({
                investor_id: investorId,
                // Carry trader + broker through if the current filter resolves to a
                // single value — legacy columns retained for queryability and as
                // scope fallback for rows predating the view_id migration (§39).
                trader_id: (lgSelectedTraderIds && lgSelectedTraderIds.length === 1) ? lgSelectedTraderIds[0] : null,
                broker_id: (lgSelectedBrokerIds && lgSelectedBrokerIds.length === 1) ? lgSelectedBrokerIds[0] : null,
                // Canonical scope — points at the portfolio_views row whose
                // filter was active when this reconciliation was saved.
                view_id: viewId,
                entry_date: reconDate,
                entry_type: 'RECONCILIATION',
                amount: reconBalance,
                reference: 'Reconciled',
                notes: ''
            })
        });
        if (resp.ok) {
            showAlert('Reconciled up to ' + prettyDate + ' at ' + fmtBal, 'success', 3500);
            lgRefresh();
        } else {
            var errText = '';
            try { errText = await resp.text(); } catch (_) {}
            var errMsg = 'Failed to reconcile (HTTP ' + resp.status + ')';
            try {
                var parsed = JSON.parse(errText);
                if (parsed && parsed.message) errMsg += ': ' + parsed.message;
            } catch (_) {
                if (errText) errMsg += ': ' + errText.slice(0, 200);
            }
            console.warn('lgReconcileUpTo failed:', resp.status, errText);
            showAlert(errMsg, 'error', 6000);
        }
    } catch (err) {
        console.warn('Failed to reconcile:', err.message);
        showAlert('Failed to reconcile: ' + err.message, 'error', 5000);
    }
}
window.lgReconcileUpTo = lgReconcileUpTo;

// ============================================================================
// LAYER 3a — RECONCILIATION DRIFT DETECTION
//
// After every lgRefresh we walk lgFullCombined with a PARALLEL running balance
// that mirrors wmsBuildLedger except it treats RECONCILIATION rows as NO-OP
// (not as anchors).  At each RECONCILIATION row we compare:
//
//     stored_amount   vs   parallel_balance_before_the_recon_row
//
// If they diverge for the LATEST recon (by sortKey — entry_date then created_at)
// we surface a yellow banner above the transactions block.  The diff catches
// both pre-recon edits (amount of a trade changed) AND deletes (row simply
// vanishes from lgFullCombined since there is no soft-delete), which an
// updated_at check alone would miss.
//
// See LESSONS §E.17.5.
// ============================================================================

function lgCheckReconDrift() {
    var banner = document.getElementById('lgReconBanner');
    if (!banner) return;

    // Defensive guard (LESSONS §A.1.18): if the initial trLoadData() hasn't
    // resolved yet, trTransactions is still []. lgRefresh would have built
    // lgFullCombined off an empty txnFiltered, so the parallel-balance pass
    // here misses every pre-recon trade and falsely flags ~"recon mismatch =
    // sum of missing trades". The primary fix lives in trLoadLedgerModule
    // (await trDataReady before lgInit/lgRefresh) — this guard catches any
    // other call site that races the data load.
    if (typeof window !== 'undefined' && window._trDataReadyResolved === false) {
        lgHideReconBanner();
        return;
    }

    var rows = lgFullCombined || [];
    if (rows.length === 0) { lgHideReconBanner(); return; }

    // Parallel-balance pass: ignore RECONCILIATION anchor effect, everything
    // else matches wmsBuildLedger / the pending-interest re-sort loop.
    var parallelBal = 0;
    var driftReports = [];  // {row, storedAmt, computedBal, diff}
    for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r._rowType === 'ledger' && r.entryType === 'RECONCILIATION') {
            // Capture drift AT this row — balance BEFORE applying it.
            var storedAmt = parseFloat(r.amount) || 0;
            var diff = storedAmt - parallelBal;
            driftReports.push({
                row: r,
                storedAmt: storedAmt,
                computedBal: parallelBal,
                diff: diff,
                sortKey: r.sortKey || (r.date + '|0|' + ((r._source && r._source.created_at) || ''))
            });
            // Do NOT advance parallelBal — recon is audit-only in this pass.
            continue;
        }
        if (r._rowType === 'ledger' && r.entryType === 'OPENING_BALANCE') {
            parallelBal = parseFloat(r.amount) || 0;
            continue;
        }
        if (r._isPending) continue;                       // pending interest not committed
        if (r._nfoCashImpact === false) continue;         // futures info rows
        parallelBal += parseFloat(r.amount) || 0;
    }

    if (driftReports.length === 0) { lgHideReconBanner(); return; }

    // Pick LATEST recon (by sortKey — entry_date then created_at).
    driftReports.sort(function(a, b) {
        return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
    });
    var latest = driftReports[driftReports.length - 1];

    // Floating-point tolerance — round to paise.
    if (Math.abs(latest.diff) < 0.01) { lgHideReconBanner(); return; }

    lgShowReconBanner(latest);
}

function lgHideReconBanner() {
    var banner = document.getElementById('lgReconBanner');
    if (banner) {
        banner.style.display = 'none';
        banner.classList.add('lg-recon-banner-hidden');
    }
    // Release any stashed review payload.
    lgReconBannerState = null;
}

var lgReconBannerState = null;  // {reconRow, storedAmt, computedBal, diff}

function lgShowReconBanner(report) {
    var banner = document.getElementById('lgReconBanner');
    var msgEl = document.getElementById('lgReconBannerMsg');
    if (!banner || !msgEl) return;

    var reconRow = report.row;
    var prettyDate = lgFmtDate(reconRow.date) || reconRow.date;
    var stored = (typeof wmsFmtAmt === 'function') ? wmsFmtAmt(report.storedAmt) : String(report.storedAmt);
    var computed = (typeof wmsFmtAmt === 'function') ? wmsFmtAmt(report.computedBal) : String(report.computedBal);
    var diffAmt = (typeof wmsFmtAmt === 'function') ? wmsFmtAmt(Math.abs(report.diff)) : String(Math.abs(report.diff));
    var direction = report.diff > 0 ? 'now lower' : 'now higher';

    msgEl.innerHTML =
        '<b>Balance mismatch on reconciliation ' + wmsEsc(prettyDate) + '</b> &middot; ' +
        'reconciled at <b>' + wmsEsc(stored) + '</b>, computed is <b>' + wmsEsc(computed) + '</b> ' +
        '<span class="lg-recon-banner-diff">(diff ' + wmsEsc(diffAmt) + ', balance ' + direction + ')</span>. ' +
        'A pre-reconciliation transaction was edited or deleted.';

    banner.classList.remove('lg-recon-banner-hidden');
    banner.style.display = 'flex';

    lgReconBannerState = report;
}

// ============================================================================
// LAYER 3b — REVIEW MODAL
// Lists pre-recon trades whose updated_at > recon.created_at and whose
// transaction_date <= recon.entry_date.  Deletes are not itemisable here
// (there's no soft-delete) — they surface via the banner's diff total only.
// ============================================================================

function lgReconReviewOpen() {
    if (!lgReconBannerState || !lgReconBannerState.row) return;
    var modal = document.getElementById('lgReconReviewModal');
    if (!modal) return;

    var reconRow = lgReconBannerState.row;
    var reconSrc = reconRow._source || {};
    var reconCreatedAt = reconSrc.created_at || '';
    var reconEntryDate = reconRow.date;
    var prettyDate = lgFmtDate(reconEntryDate) || reconEntryDate;

    // Stash the recon id on the modal so the "Cancel Reconciliation" button
    // knows which row to delete.
    modal.dataset.reconEntryId = (reconSrc.id || '');

    var diffAbs = Math.abs(lgReconBannerState.diff || 0);
    var diffStr = (typeof wmsFmtAmt === 'function') ? wmsFmtAmt(diffAbs) : String(diffAbs);
    var directionWord = lgReconBannerState.diff < 0 ? 'higher' : 'lower';
    var storedStr = (typeof wmsFmtAmt === 'function') ? wmsFmtAmt(lgReconBannerState.storedAmt || 0) : String(lgReconBannerState.storedAmt || 0);
    var computedStr = (typeof wmsFmtAmt === 'function') ? wmsFmtAmt(lgReconBannerState.computedBal || 0) : String(lgReconBannerState.computedBal || 0);

    // Scope-filter pre-recon txns modified since the recon.  updated_at is
    // populated server-side on every PATCH (after the 2026-04-24 edit-save
    // fix that uses return=representation — older edits saved before that
    // deploy may carry stale in-memory updated_at).
    //
    // Scope matching (§E.17.8): prefer the recon's view.filters (via its
    // view_id FK); fall back to the legacy investor_id/trader_id/broker_id
    // columns when view_id is absent (legacy rows / ad-hoc recons).
    var reconView = reconSrc.view_id
        ? lgVM.views.find(function(v) { return v.id === reconSrc.view_id; })
        : null;
    var matchByView = reconView && reconView.filters && typeof wmsMatchesViewFilter === 'function';

    // Both INSERT and EDIT of a pre-recon trade invalidate the recon snapshot.
    // - INSERT: row.created_at > recon.created_at (back-dated trade added after
    //   the recon was made). updated_at is also typically set on insert and
    //   equals created_at, but we don't require it because some Supabase setups
    //   only fire the updated_at trigger on UPDATE.
    // - EDIT: row.updated_at > recon.created_at && created_at <= recon.created_at.
    // LESSONS §E.17.6a — initial load MUST include created_at + updated_at in
    // the SELECT, otherwise both are null in memory and this filter never matches.
    if (!reconCreatedAt) {
        // Cannot run timestamp comparisons without recon.created_at — bail.
    }
    var dirty = (!reconCreatedAt ? [] : (trTransactions || [])).filter(function(t) {
        if (!t.transaction_date || t.transaction_date > reconEntryDate) return false;
        // Treat null timestamps as "before recon" (we can't know otherwise).
        var lastMod = t.updated_at || t.created_at || '';
        if (!lastMod || lastMod <= reconCreatedAt) return false;

        if (matchByView) {
            return wmsMatchesViewFilter(t, reconView.filters);
        }
        // Legacy column-based fallback — see wmsFindLatestReconForTxn.
        if (reconSrc.broker_id && t.broker_id !== reconSrc.broker_id) return false;
        var effTrader = t.trader_id || t.investor_id;
        if (reconSrc.investor_id === t.investor_id) {
            if (reconSrc.trader_id && reconSrc.trader_id !== effTrader) return false;
            return true;
        }
        if (reconSrc.investor_id === effTrader) return true;
        return false;
    }).map(function(t) {
        // Classify as insert vs edit so the modal can label rows distinctly.
        // An insert leaves created_at strictly greater than recon.created_at.
        // (Edits typically keep created_at unchanged from when the row was
        // first inserted, and only updated_at advances.)
        var isInsert = !!(t.created_at && t.created_at > reconCreatedAt);
        return { txn: t, action: isInsert ? 'inserted' : 'edited' };
    }).sort(function(a, b) {
        return (a.txn.transaction_date || '').localeCompare(b.txn.transaction_date || '');
    });

    // Split detection by action so the narrative can be specific.
    var inserts = dirty.filter(function(d) { return d.action === 'inserted'; });
    var edits   = dirty.filter(function(d) { return d.action === 'edited'; });

    // Headline summary — reconciled amount, computed amount, diff, and the
    // most likely cause classification.
    var summary = document.getElementById('lgReconReviewSummary');
    if (summary) {
        var causeMsg;
        if (dirty.length > 0) {
            var parts = [];
            if (inserts.length > 0) {
                parts.push('<b>' + inserts.length + '</b> back-dated trade' +
                    (inserts.length === 1 ? '' : 's') + ' inserted');
            }
            if (edits.length > 0) {
                parts.push('<b>' + edits.length + '</b> trade' +
                    (edits.length === 1 ? '' : 's') + ' edited');
            }
            causeMsg = parts.join(' and ') + ' since this reconciliation (listed below). ' +
                'If the balance mismatch equals the impact of these changes, that explains the drift. ' +
                'Any residual could still be a delete.';
        } else {
            causeMsg = '<b>No pre-reconciliation inserts or edits detected.</b> ' +
                'The drift is most likely due to a <b>deleted</b> pre-reconciliation trade. ' +
                'Deletes leave no audit trail in the current schema, so they cannot be itemised here. ' +
                'Cancel this reconciliation (button below) and re-reconcile against the current balance.';
        }
        summary.innerHTML =
            '<div style="margin-bottom:6px;">Reconciliation on <b>' + wmsEsc(prettyDate) + '</b> &middot; ' +
            'reconciled at <b>' + wmsEsc(storedStr) + '</b>, computed is <b>' + wmsEsc(computedStr) +
            '</b> (balance now ' + directionWord + ' by <b>' + wmsEsc(diffStr) + '</b>).</div>' +
            '<div>' + causeMsg + '</div>';
    }

    // Build the dirty-txn list (or an empty-state hint).
    var body = document.getElementById('lgReconReviewBody');
    if (!body) return;

    if (dirty.length === 0) {
        body.innerHTML =
            '<div class="lg-rr-hint">Most likely a <b>delete</b>. No inserts or edits to list here — click <b>Cancel Reconciliation</b> below to remove the stale snapshot, then re-reconcile on the latest balance.</div>';
    } else {
        var rowsHtml = dirty.map(function(d) {
            var t = d.txn;
            var sym = t.short_symbol || t.symbol || '-';
            var type = t.transaction_type || '-';
            var qty = Math.abs(t.quantity || 0);
            var net = (typeof wmsFmtAmt === 'function') ? wmsFmtAmt(t.display_net_amount || t.net_amount || 0) : String(t.net_amount || 0);
            var dt = lgFmtDate(t.transaction_date) || t.transaction_date || '-';
            var changeTs = t.updated_at || t.created_at || '';
            var changeDt = changeTs ? String(changeTs).slice(0, 19).replace('T', ' ') : '-';
            // Distinguish inserts (green ➕) from edits (orange ✏️).
            var actionLabel = d.action === 'inserted'
                ? '<span style="color:#047857; font-weight:600;">➕ Inserted</span>'
                : '<span style="color:#b45309; font-weight:600;">✏️ Edited</span>';
            return '<tr data-txn-id="' + wmsEsc(t.id) + '">' +
                '<td>' + wmsEsc(dt) + '</td>' +
                '<td>' + wmsEsc(sym) + '</td>' +
                '<td>' + wmsEsc(type) + '</td>' +
                '<td class="text-right">' + wmsEsc(String(qty)) + '</td>' +
                '<td class="text-right">' + wmsEsc(net) + '</td>' +
                '<td>' + actionLabel + '</td>' +
                '<td>' + wmsEsc(changeDt) + '</td>' +
                '</tr>';
        }).join('');
        body.innerHTML =
            '<div class="lg-rr-hint">Click any row to open its Edit modal and review. If the mismatch is not fully explained by these inserts / edits, a <b>delete</b> is the remaining suspect — cancel this reconciliation and re-do it.</div>' +
            '<table>' +
              '<thead><tr>' +
                '<th>Txn Date</th>' +
                '<th>Symbol</th>' +
                '<th>Type</th>' +
                '<th class="text-right">Qty</th>' +
                '<th class="text-right">Net (current)</th>' +
                '<th>Action</th>' +
                '<th>Changed At</th>' +
              '</tr></thead>' +
              '<tbody>' + rowsHtml + '</tbody>' +
            '</table>';
    }

    modal.classList.add('show');
}

// Shared recon-cancellation routine (LESSONS §E.17.9). Called from THREE
// surfaces — they all funnel through here so the prompt + DELETE + refresh
// behavior stays identical regardless of where the user clicked:
//   1. the ✕ next to the green ✓ on a visible RECONCILIATION row in the
//      Transactions table (Path 1 — works in show-all mode)
//   2. the ✕ next to the green ✓ on the synthesized Opening Balance row when
//      "Hide pre-recon" mode is ON (Path 1b — works while the recon row is
//      collapsed into the OB anchor)
//   3. the "Cancel Reconciliation" button inside the drift-review modal
//      (Path 2 — only available when the yellow drift banner is showing)
// Only the RECONCILIATION row is DELETEd — trades stay in `transactions`,
// INTEREST_BOOKED / CASH_RECEIVED / CASH_PAID / OPENING_BALANCE are all
// independent ledger_entries rows with their own ids and are NOT touched.
async function lgCancelReconciliation(reconId, reconDate, options) {
    if (!reconId) {
        showAlert('No reconciliation selected to cancel', 'warning', 3000);
        return false;
    }
    options = options || {};
    var prettyDate = reconDate ? (lgFmtDate(reconDate) || reconDate) : '';
    var msg = 'Cancel the reconciliation' + (prettyDate ? ' on ' + prettyDate : '') + '?\n\n' +
              'This removes the snapshot row ONLY — all trades, interest, and ' +
              'cash entries remain unchanged. Running balances will recompute ' +
              'from current transactions and the yellow drift banner (if shown) ' +
              'will clear. You can re-reconcile any time.';
    if (!window.confirm(msg)) return false;

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/ledger_entries?id=eq.' + encodeURIComponent(reconId), {
            method: 'DELETE',
            headers: wmsHeaders({'Prefer': 'return=minimal'})
        });
        if (resp.ok) {
            showAlert('Reconciliation cancelled', 'success', 2500);
            if (typeof options.onSuccess === 'function') {
                try { options.onSuccess(); } catch (e) { console.warn('lgCancelReconciliation onSuccess threw:', e); }
            }
            lgRefresh();
            return true;
        } else {
            var errText = '';
            try { errText = await resp.text(); } catch (_) {}
            showAlert('Failed to cancel reconciliation (HTTP ' + resp.status + ')' + (errText ? ': ' + errText.slice(0, 200) : ''), 'error', 6000);
            return false;
        }
    } catch (err) {
        showAlert('Failed to cancel reconciliation: ' + err.message, 'error', 5000);
        return false;
    }
}
window.lgCancelReconciliation = lgCancelReconciliation;

// Path 2: drift-review modal's "Cancel Reconciliation" button. Pulls the
// recon id off the modal dataset (stashed by lgReconReviewOpen) and delegates
// to the shared routine.
async function lgReconReviewCancel() {
    var modal = document.getElementById('lgReconReviewModal');
    if (!modal) return;
    var reconId = modal.dataset.reconEntryId || '';
    var reconRow = lgReconBannerState && lgReconBannerState.row;
    var reconDate = reconRow ? reconRow.date : '';
    await lgCancelReconciliation(reconId, reconDate, {
        onSuccess: function() { lgReconReviewClose(); }
    });
}

function lgReconReviewClose() {
    var modal = document.getElementById('lgReconReviewModal');
    if (modal) modal.classList.remove('show');
}

// ============================================================================
// VIEW-FILTER LOCK + PRE-LEDGER-POST GATE (LESSONS §E.17.8)
//
// A view becomes filter-locked once any ledger_entry references it. We track
// the set of locked views in `lgViewsWithEntries`, refreshed from the DB on
// every lgRefresh. Used by:
//   • wmsViewManager.updateCurrentView → refuses to mutate filters on locked
//     views (programmatic guard — the UI button is also disabled)
//   • lgUpdateViewLockUI → disables the Update View button + tooltip
//   • lgEnsureViewSaved → the pre-ledger-POST gate
// ============================================================================

var lgViewsWithEntries = {};   // {viewId: true} — populated from DB on refresh

async function lgLoadViewLockState() {
    try {
        var url = SUPABASE_URL + '/rest/v1/ledger_entries?select=view_id&view_id=not.is.null&limit=10000';
        var resp = await fetch(url, { headers: wmsHeaders({'Content-Type': 'application/json'}) });
        if (!resp.ok) return;
        var rows = await resp.json();
        lgViewsWithEntries = {};
        (rows || []).forEach(function(r) { if (r.view_id) lgViewsWithEntries[r.view_id] = true; });
    } catch (err) {
        console.warn('lgLoadViewLockState failed:', err && err.message);
    }
}

function lgIsViewLocked(viewId) {
    return !!(viewId && lgViewsWithEntries[viewId]);
}

function lgUpdateViewLockUI() {
    var updateBtn = document.getElementById('lgUpdateViewBtn');
    if (!updateBtn) return;
    var locked = lgIsViewLocked(lgVM.activeViewId);
    if (locked) {
        updateBtn.disabled = true;
        updateBtn.title = 'This view has ledger entries and is filter-locked — create a new view to change filters';
    } else {
        // Don't override if there's no change to save (the regular dirty-check
        // in wmsViewManager.updateViewButtons sets disabled appropriately).
        updateBtn.title = 'Update current view with active filters';
    }
}

// Deep-compare two filter objects. Filter shape is:
//   {investorIds: [...], traderIds: [...], brokerIds: [...], tagNames: [...],
//    tagLogic: 'OR'|'AND', statementType: 'trader'|'broker'}
// Empty array == missing key (both mean "no constraint"). Order-insensitive.
// Missing statementType defaults to 'trader' (backward-compat — views saved
// before the toggle shipped had no statementType key). LESSONS §E.15.12.
function lgFiltersEqual(a, b) {
    if (!a || !b) return false;
    var arrEq = function(x, y) {
        var xs = (x || []).slice().sort();
        var ys = (y || []).slice().sort();
        if (xs.length !== ys.length) return false;
        for (var i = 0; i < xs.length; i++) if (xs[i] !== ys[i]) return false;
        return true;
    };
    var normType = function(t) { return t === 'broker' ? 'broker' : 'trader'; };
    return arrEq(a.investorIds, b.investorIds) &&
           arrEq(a.traderIds, b.traderIds) &&
           arrEq(a.brokerIds, b.brokerIds) &&
           arrEq(a.tagNames, b.tagNames) &&
           (a.tagLogic || 'OR') === (b.tagLogic || 'OR') &&
           normType(a.statementType) === normType(b.statementType);
}

// Pre-ledger-POST gate. Every code path that writes to ledger_entries
// (reconcile, add entry, commit interest, opening balance) MUST call this
// first and include the returned view_id on the row being saved. Returns:
//   • view_id (string) — current view is saved and clean, proceed
//   • null             — user canceled, caller should abort
async function lgEnsureViewSaved(actionLabel) {
    var activeView = lgVM.views.find(function(v) { return v.id === lgVM.activeViewId; });
    var currentFilters = {
        investorIds: lgSelectedInvestorIds.slice(),
        traderIds:   lgSelectedTraderIds.slice(),
        brokerIds:   lgSelectedBrokerIds.slice(),
        tagNames:    lgSelectedTagNames.slice(),
        tagLogic:    lgTagFilterLogic,
        statementType: lgStatementType
    };

    // Clean, saved → straight through.
    if (activeView && lgFiltersEqual(activeView.filters || {}, currentFilters)) {
        return activeView.id;
    }

    // Dirty or ad-hoc. Ask the user inline.
    var name;
    if (activeView) {
        var locked = lgIsViewLocked(activeView.id);
        if (!locked) {
            // Dirty but not locked — offer Update-current or Save-as-new.
            var updateChoice = window.confirm(
                'Filters have changed since the saved view "' + activeView.name + '".\n\n' +
                'OK  →  update "' + activeView.name + '" with the current filters and ' + actionLabel + '.\n' +
                'Cancel  →  save the current filters as a new view instead.'
            );
            if (updateChoice) {
                var ok = await lgVM.updateCurrentView();
                return ok ? activeView.id : null;
            }
            name = window.prompt('Name for the new view:', '');
        } else {
            // Dirty + locked — must save as new (no update option).
            name = window.prompt(
                '"' + activeView.name + '" is filter-locked (has ledger entries).\n' +
                'Save the current filters as a NEW view to ' + actionLabel + ':',
                activeView.name + ' (copy)'
            );
        }
    } else {
        // No active view — ad-hoc filters.
        name = window.prompt(
            'Save your current filters as a view to ' + actionLabel + ':',
            ''
        );
    }

    if (!name || !name.trim()) return null;
    var newView = await lgVM.saveCurrentView(name.trim());
    return newView ? newView.id : null;
}

// Pre-delete confirmation — shown when the user tries to delete a view.
// Counts ledger_entries referencing this view and warns that ON DELETE SET
// NULL will orphan them (they remain, lose their view pointer, fall back to
// legacy column scope). Recreating the same view by name does NOT re-link.
async function lgConfirmViewDelete(viewId) {
    var view = lgVM.views.find(function(v) { return v.id === viewId; });
    var viewName = view ? view.name : '(unknown)';
    var count = 0;
    try {
        var url = SUPABASE_URL + '/rest/v1/ledger_entries?view_id=eq.' + encodeURIComponent(viewId) + '&select=id';
        var resp = await fetch(url, {
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'count=exact'})
        });
        if (resp.ok) {
            var rangeHdr = resp.headers.get('content-range');
            if (rangeHdr) {
                var m = rangeHdr.match(/\/(\d+)$/);
                if (m) count = parseInt(m[1], 10) || 0;
            } else {
                var rows = await resp.json();
                count = (rows || []).length;
            }
        }
    } catch (err) {
        console.warn('lgConfirmViewDelete: count failed:', err && err.message);
    }

    var msg;
    if (count > 0) {
        msg = 'Delete view "' + viewName + '"?\n\n' +
              '⚠ ' + count + ' ledger entr' + (count === 1 ? 'y' : 'ies') +
              ' (reconciliations, interest, adjustments) reference this view.\n' +
              'They will be ORPHANED — the entries stay, but their view context is lost ' +
              'and scope falls back to legacy columns. Re-creating a view with the same name ' +
              'does NOT re-link them.\n\nProceed?';
    } else {
        msg = 'Delete view "' + viewName + '"?\n\nNo ledger entries reference it.';
    }
    return window.confirm(msg);
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

    // Pre-ledger-POST gate.
    var viewId = await lgEnsureViewSaved(entryType === 'OPENING_BALANCE' ? 'set opening balance' : 'add this entry');
    if (!viewId) return;

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/ledger_entries', {
            method: 'POST',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
            body: JSON.stringify({
                investor_id: investorId,
                // Scope columns: single-value filter mirrors + canonical view_id.
                trader_id: (lgSelectedTraderIds && lgSelectedTraderIds.length === 1) ? lgSelectedTraderIds[0] : null,
                broker_id: (lgSelectedBrokerIds && lgSelectedBrokerIds.length === 1) ? lgSelectedBrokerIds[0] : null,
                view_id: viewId,
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
                headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'})
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

// ── Weekly-friday breakdown (single Friday EOD + rate × 1/52) ─────────────
function _lgRenderWeeklyBreakdown(calc) {
    var roundedInterest = Math.round(calc.interest);
    var cash = calc.closingBalance || 0;
    var margin = calc.marginBalance || 0;
    var base = calc.baseBalance != null ? calc.baseBalance : (cash + margin);
    var clampedBase = Math.max(0, base);

    var rowStyle = 'display:flex; justify-content:space-between; padding:8px 12px; font-size:13px;';
    var labelStyle = 'color:#4a5568;';
    var valueStyle = 'font-variant-numeric:tabular-nums; color:#1a202c;';

    var periodHeader =
        '<div style="padding:8px 12px; background:#f7fafc; border-radius:6px 6px 0 0; ' +
        'font-size:11px; text-transform:uppercase; letter-spacing:0.5px; ' +
        'color:#718096; font-weight:600;">Period</div>' +
        '<div style="' + rowStyle + ' border-bottom:1px solid #e2e8f0;">' +
            '<span style="' + labelStyle + '">' + wmsEsc(calc.period) + '</span>' +
        '</div>';

    // Show the DEBIT portion of the running balance, i.e. the magnitude that
    // the interest formula actually uses (`max(0, cash) + margin`).
    var debitBal = Math.max(0, cash);
    var balanceRow =
        '<div style="' + rowStyle + '">' +
            '<span style="' + labelStyle + '">Debit Balance</span>' +
            '<span style="' + valueStyle + '">' + lgFmt(debitBal) + '</span>' +
        '</div>';
    var marginRow =
        '<div style="' + rowStyle + '">' +
            '<span style="' + labelStyle + '">F&amp;O Margin</span>' +
            '<span style="' + valueStyle + '">' + lgFmt(margin) + '</span>' +
        '</div>';
    var totalRow =
        '<div style="' + rowStyle + ' border-top:1px solid #e2e8f0; background:#f7fafc; font-weight:600;">' +
            '<span style="color:#1a202c;">Total Base</span>' +
            '<span style="' + valueStyle + ' font-weight:700;">' + lgFmt(clampedBase) + '</span>' +
        '</div>';
    var rateRow =
        '<div style="' + rowStyle + '">' +
            '<span style="' + labelStyle + '">× Rate (' + calc.rate + '% p.a.) × (1/52)</span>' +
            '<span style="' + valueStyle + '"></span>' +
        '</div>';
    var interestRow =
        '<div style="' + rowStyle + ' border-top:1px solid #e2e8f0; background:#edf2f7; font-weight:700; font-size:14px;">' +
            '<span style="color:#1a202c;">Interest</span>' +
            '<span style="' + valueStyle + ' color:#2d3748; font-weight:700;">' + lgFmt(roundedInterest) + '</span>' +
        '</div>';

    return '<div style="border:1px solid #e2e8f0; border-radius:6px; overflow:hidden;">' +
        periodHeader + balanceRow + marginRow + totalRow + rateRow + interestRow +
        '</div>';
}

// Module-level sort state for the trace table — toggled by clicking the
// Date header. Default 'desc' = newest first (matches in-progress visibility).
var lgTraceSortDesc = true;

// Toggle and re-render — invoked by the Date header onclick.
window.lgToggleMonthlyTraceSort = function() {
    lgTraceSortDesc = !lgTraceSortDesc;
    // Re-render whichever calc the modal is currently showing. The pending
    // and posted paths both stash the calc differently — use whichever is set.
    var calc = null;
    if (lgPendingModalKey) {
        var pending = lgPendingInterestRows.find(function(r) { return r._pendingKey === lgPendingModalKey; });
        if (pending) calc = pending._calc;
    } else if (lgInterestDetailEntryId) {
        // For posted entries we don't keep _calc around; re-trigger the modal flow
        // so it recomputes. Simpler than caching.
        lgShowInterestDetail(lgInterestDetailEntryId);
        return;
    }
    if (calc) {
        var body = document.getElementById('lgInterestDetailBreakdown');
        if (body) body.innerHTML = _lgRenderMonthlyTrace(calc);
    }
};

// ── Daily-monthly-compound trace (one row per day) ─────────────────────────
// Shows the full per-day arithmetic so Vikash can audit each day's debit
// balance, margin, base, daily interest, and running monthly accrual.
function _lgRenderMonthlyTrace(calc) {
    var trace = calc.trace || [];
    var roundedInterest = Math.round(calc.interest);
    // Daily accrual is SIMPLE (per 2026-05-27 owner spec). Cross-month
    // compounding happens via the posted INTEREST_BOOKED entry — describe
    // the math, not the cross-month effect.
    var rateNote = '× Rate (' + calc.rate + '% p.a.) × (1/365) daily';

    // Compact styling — keep all 6 columns on screen with no horizontal
    // scroll inside the 720-px modal. 11-px font, 2-6 px padding.
    var thBase =
        'padding:5px 6px; font-size:10.5px; text-transform:uppercase; letter-spacing:0.3px; ' +
        'color:#64748b; font-weight:600; background:#f1f5f9; border-bottom:1px solid #cbd5e0; ' +
        'white-space:nowrap;';
    var thRight = thBase + ' text-align:right;';
    var tdBase = 'padding:2px 6px; font-size:11px; font-variant-numeric:tabular-nums; ' +
        'border-bottom:1px solid #f1f5f9; line-height:1.45; white-space:nowrap;';
    var tdRight = tdBase + ' text-align:right; color:#1a202c;';
    var tdDate = tdBase + ' text-align:right; color:#4a5568;';

    // Sort the trace per the current sort state. Date strings are ISO
    // (YYYY-MM-DD) so lexical comparison is chronological.
    var sortedTrace = trace.slice().sort(function(a, b) {
        return lgTraceSortDesc ? (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)
                                : (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    });
    var sortArrow = lgTraceSortDesc ? ' ▼' : ' ▲';

    var rowsHtml = '';
    for (var i = 0; i < sortedTrace.length; i++) {
        var t = sortedTrace[i];
        rowsHtml +=
            '<tr>' +
                '<td style="' + tdDate + '">' + lgFmtDate(t.date) + '</td>' +
                '<td style="' + tdRight + '">' + lgFmt(t.debitBal) + '</td>' +
                '<td style="' + tdRight + '">' + lgFmt(t.margin) + '</td>' +
                '<td style="' + tdRight + '">' + lgFmt(t.base) + '</td>' +
                '<td style="' + tdRight + '">' + lgFmt(t.dailyInterest) + '</td>' +
                '<td style="' + tdRight + ' font-weight:600; color:#2d3748;">' + lgFmt(t.accruedSoFar) + '</td>' +
            '</tr>';
    }

    var rowStyle = 'display:flex; justify-content:space-between; padding:6px 10px; font-size:12px;';
    var labelStyle = 'color:#4a5568;';
    var valueStyle = 'font-variant-numeric:tabular-nums; color:#1a202c;';

    var periodHeader =
        '<div style="padding:6px 10px; background:#f7fafc; border-radius:6px 6px 0 0; ' +
        'font-size:10.5px; text-transform:uppercase; letter-spacing:0.4px; ' +
        'color:#718096; font-weight:600;">Period · ' + trace.length + ' day' + (trace.length === 1 ? '' : 's') + '</div>' +
        '<div style="' + rowStyle + ' border-bottom:1px solid #e2e8f0;">' +
            '<span style="' + labelStyle + '">' + wmsEsc(calc.period) + '</span>' +
            '<span style="font-size:10.5px; color:#94a3b8;">' + rateNote + '</span>' +
        '</div>';

    // Explicit widths so the 6 columns fit within the 720-px modal content
    // area (~680 px after padding + scrollbar). Sum = 660 px; the table
    // width:100% absorbs the small remainder. Date column is RIGHT-aligned
    // per user request; click toggles sort direction.
    var colgroup =
        '<colgroup>' +
            '<col style="width:104px;">' +   // Date — "Wed, 30-Apr-26" fits
            '<col style="width:108px;">' +   // Debit Bal
            '<col style="width:108px;">' +   // F&O Margin
            '<col style="width:112px;">' +   // Base
            '<col style="width:100px;">' +   // Day Int
            '<col style="width:128px;">' +   // Accrued (largest end-of-month value)
        '</colgroup>';

    // NOTE: app-styles.css has a global `table { min-width: 940px }` rule that
    // forces every table in the app to be at least 940 px wide. That overrides
    // our 720-px modal and shoves the right columns off-screen. Reset min-width
    // to 0 here so table-layout:fixed + our colgroup widths actually take effect.
    var traceHtml =
        '<div style="max-height:560px; overflow-y:auto; overflow-x:auto; border-bottom:1px solid #e2e8f0;">' +
        '<table style="width:100%; min-width:0; border-collapse:collapse; table-layout:fixed;">' +
        colgroup +
        '<thead style="position:sticky; top:0; z-index:1;">' +
            '<tr>' +
                '<th style="' + thRight + ' cursor:pointer; user-select:none;" ' +
                    'onclick="lgToggleMonthlyTraceSort()" title="Click to toggle sort">Date' + sortArrow + '</th>' +
                '<th style="' + thRight + '">Debit Bal</th>' +
                '<th style="' + thRight + '">F&amp;O Margin</th>' +
                '<th style="' + thRight + '">Base</th>' +
                '<th style="' + thRight + '">Day Int</th>' +
                '<th style="' + thRight + '">Accrued</th>' +
            '</tr>' +
        '</thead>' +
        '<tbody>' + rowsHtml + '</tbody></table>' +
        '</div>';

    var interestRow =
        '<div style="' + rowStyle + ' background:#edf2f7; font-weight:700; font-size:13px;">' +
            '<span style="color:#1a202c;">Total Monthly Interest</span>' +
            '<span style="' + valueStyle + ' color:#2d3748; font-weight:700;">' + lgFmt(roundedInterest) + '</span>' +
        '</div>';

    return '<div style="border:1px solid #e2e8f0; border-radius:6px; overflow:hidden;">' +
        periodHeader + traceHtml + interestRow +
        '</div>';
}

// Render the interest detail modal with the calculation breakdown.
// Works for both posted rows (entry in DB) and pending rows (_calc in memory).
// Dispatches by `calc.frequency`:
//   - 'daily_monthly_compound' → renders a daily-trace table (one row per day)
//   - everything else (default = 'weekly_friday') → renders the single-Friday
//     breakdown unchanged from the pre-2026-05-27 layout.
function lgPopulateInterestDetail(calc, currentAmount) {
    var detailBody = document.getElementById('lgInterestDetailBreakdown');
    var totalEditEl = document.getElementById('lgInterestTotalEdit');

    if (detailBody) {
        if (calc && calc.frequency === 'daily_monthly_compound') {
            detailBody.innerHTML = _lgRenderMonthlyTrace(calc);
        } else if (calc) {
            detailBody.innerHTML = _lgRenderWeeklyBreakdown(calc);
        } else {
            detailBody.innerHTML = '<div class="text-center" style="padding:20px; color:#9ca3af;">No calculation data available</div>';
        }
    }

    if (totalEditEl) {
        var amtVal = currentAmount != null ? currentAmount : (calc ? Math.round(calc.interest) : 0);
        if (lgInterestTotalCtrl && typeof lgInterestTotalCtrl.setValue === 'function') {
            lgInterestTotalCtrl.setValue(amtVal);
        } else {
            totalEditEl.value = amtVal;
        }
    }
}

// Open interest detail modal for a POSTED interest entry (already in DB).
async function lgShowInterestDetail(entryId) {
    var entry = lgLedgerEntries.find(function(e) { return e.id === entryId; });
    if (!entry || entry.entry_type !== 'INTEREST_BOOKED') return;

    lgInterestDetailEntryId = entryId;
    lgPendingModalKey = null;

    var investorId = entry.investor_id;
    // Pass broker_id to resolve IBA-level terms (parity with the lgRefresh
    // pending-interest generator). Use entry's own broker_id if it carries
    // one (broker-account-scoped interest); else fall back to the current
    // single-broker filter if active.
    var brokerIdForTerms = entry.broker_id || ((lgStatementType === 'broker' && lgSelectedBrokerIds.length === 1)
        ? lgSelectedBrokerIds[0] : null);
    var interestTerms = wmsGetInterestTerms(investorId, brokerIdForTerms);

    if (!interestTerms) {
        showAlert('No interest terms configured', 'warning', 3000);
        return;
    }

    // Recompute the calculation for this row by finding the relevant period
    // and running the engine matching the terms' frequency.
    //   weekly_friday          → from = Friday before entry_date (single Friday)
    //   daily_monthly_compound → from = first day of entry_date's month,
    //                             to  = entry_date (month-end)
    var calc = null;
    try {
        var postDate = new Date(entry.entry_date);
        var fromStr, toStr;
        if (interestTerms.frequency === 'daily_monthly_compound') {
            // Whole month leading up to entry_date.
            var monthStart = new Date(Date.UTC(postDate.getUTCFullYear(), postDate.getUTCMonth(), 1));
            fromStr = monthStart.toISOString().slice(0, 10);
            toStr = entry.entry_date;
        } else {
            var friday = new Date(postDate);
            friday.setDate(friday.getDate() - 1);
            fromStr = friday.toISOString().slice(0, 10);
            toStr = fromStr;
        }

        // Build ledger excluding this entry itself (so the running balance matches
        // what it was just before this interest row was posted).
        //
        // IMPORTANT: match the txn filter to whatever the visible ledger uses.
        // Filtering purely by investor_id here would drop trades booked under a
        // parent investor but attributed to a trader (e.g. T3 trades held under
        // the T0 account), leaving intra-week balance movements out of the
        // Friday-EOD closing balance shown in the modal.
        var effInvId = (typeof lgGetEffectiveInvestorId === 'function') ? lgGetEffectiveInvestorId() : null;
        var traderMode = (typeof lgSelectedTraderIds !== 'undefined') && lgSelectedTraderIds.length > 0;
        var txnFiltered = trTransactions.filter(function(t) {
            if (t.dont_display) return false;
            if (!t.transaction_date) return false;
            if (traderMode) {
                var tid = t.trader_id || t.investor_id;
                if (!tid || lgSelectedTraderIds.indexOf(tid) < 0) return false;
            } else {
                if (t.investor_id !== investorId) return false;
            }
            if (typeof lgSelectedBrokerIds !== 'undefined' && lgSelectedBrokerIds.length > 0 &&
                lgSelectedBrokerIds.indexOf(t.broker_id) < 0) return false;
            if (typeof lgSelectedTagNames !== 'undefined' && lgSelectedTagNames.length > 0) {
                if (!wmsMatchTagsFilter(t.tags || [], lgSelectedTagNames, lgTagFilterLogic)) return false;
            }
            return true;
        });
        var entriesExSelf = lgLedgerEntries.filter(function(e) { return e.id !== entryId; });
        var buildOpts = traderMode
            ? { traderIds: lgSelectedTraderIds.slice(), perspective: 'trader' }
            : { investorIds: [investorId], perspective: 'investor' };
        var full = wmsBuildLedger(entriesExSelf, txnFiltered, buildOpts);

        var nfoTxns = txnFiltered.filter(function(t) {
            return wmsIsDerivativeTxn(t);
        }).sort(function(a, b) {
            var dc = (a.transaction_date || '').localeCompare(b.transaction_date || '');
            if (dc !== 0) return dc;
            var tc = (a.transaction_time || '').localeCompare(b.transaction_time || '');
            if (tc !== 0) return tc;
            return (a.id || 0) - (b.id || 0);
        });
        // Broker view: apply filter-investor's IBA margin rate uniformly.
        // For trader/investor views: per-trade legacy lookup. See E.15.6 / E.15.12.
        var marginOptsDetail = {};
        if (lgStatementType === 'broker') {
            var effInvDetail = investorId || ((wmsRefData.investors || [])
                .find(function(i) { return (i.short_name || '').toUpperCase() === 'T0'; }) || {}).id;
            if (effInvDetail) marginOptsDetail.marginRateInvestorId = effInvDetail;
        }
        var marginEvents = wmsCalcMarginFIFO(nfoTxns, marginOptsDetail);

        var periods;
        if (interestTerms.frequency === 'daily_monthly_compound') {
            periods = wmsCalcInterestDailyMonthlyCompound(full, interestTerms, fromStr, toStr, marginEvents);
        } else {
            periods = wmsCalcInterestWeeklyFriday(full, interestTerms, fromStr, toStr, marginEvents);
        }
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
        var v = (lgInterestTotalCtrl && typeof lgInterestTotalCtrl.getValue === 'function')
            ? lgInterestTotalCtrl.getValue()
            : parseFloat(totalEl.value);
        if (v != null && !isNaN(v)) amount = v;
    }

    if (amount <= 0) {
        showAlert('Interest must be greater than 0', 'warning', 3000);
        return;
    }

    // Pre-ledger-POST gate.
    var viewId = await lgEnsureViewSaved('commit interest');
    if (!viewId) return;

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/ledger_entries', {
            method: 'POST',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
            body: JSON.stringify({
                investor_id: pending.investorId,
                trader_id: (lgSelectedTraderIds && lgSelectedTraderIds.length === 1) ? lgSelectedTraderIds[0] : null,
                broker_id: (lgSelectedBrokerIds && lgSelectedBrokerIds.length === 1) ? lgSelectedBrokerIds[0] : null,
                view_id: viewId,
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
    var totalAmount = 0;
    if (lgInterestTotalCtrl && typeof lgInterestTotalCtrl.getValue === 'function') {
        var ctrlVal = lgInterestTotalCtrl.getValue();
        totalAmount = (ctrlVal != null && !isNaN(ctrlVal)) ? ctrlVal : 0;
    } else {
        totalAmount = parseFloat(totalEl ? totalEl.value : '0') || 0;
    }

    try {
        await fetch(SUPABASE_URL + '/rest/v1/ledger_entries?id=eq.' + lgInterestDetailEntryId, {
            method: 'PATCH',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
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

// ── Shared data-gathering for both export formats ─────────────────
// Returns a plain object with everything needed to build the export config.
// This mirrors the data that lgRenderEntries + lgRenderSummary compute,
// but pulled into a simple data structure instead of DOM html.

function lgGatherExportData(opts) {
    // opts (all optional):
    //   dateFrom, dateTo  — ISO yyyy-mm-dd window override; default = on-screen
    //   includeFutures    — false hides _nfoCashImpact===false rows; default true
    // Resolve effective tax rate from DB (same logic as lgRenderSummary)
    opts = opts || {};
    var taxRatePct = lgGetEffectiveTaxRate();
    var rangeFrom = opts.dateFrom || lgDateFrom || '';
    var rangeTo   = opts.dateTo   || lgDateTo   || '';
    var includeFutures = (opts.includeFutures !== false);

    // 1. Active view name & date range
    var activeView = lgVM.views.find(function(v) { return v.id === lgVM.activeViewId; });
    var viewName = activeView ? activeView.name : 'Statement';

    // Determine FY label from chosen range
    var dateLabel = '';
    if (rangeFrom) {
        var yr = parseInt(rangeFrom.slice(0, 4), 10);
        var mo = parseInt(rangeFrom.slice(5, 7), 10);
        var fyStart = (mo >= 4) ? yr : yr - 1;
        dateLabel = 'FY' + String(fyStart).slice(-2) + String(fyStart + 1).slice(-2);
    }
    if (!dateLabel) dateLabel = new Date().toISOString().slice(0, 10);

    // 2. Opening balance + the source rowset.
    //    When the caller passes an explicit date range different from on-screen,
    //    re-derive the OB carry-forward + clipped rows from lgFullCombined so we
    //    don't need to mutate lgDateFrom/lgDateTo + re-run lgRefresh (which
    //    would trigger an on-screen flicker). Engine math is unchanged — we
    //    just re-clip the already-computed running balance.
    var rowSet, openingBalDate, openingBalAmt;
    var rangeOverridden = (opts.dateFrom || opts.dateTo) &&
                          (opts.dateFrom !== lgDateFrom || opts.dateTo !== lgDateTo);
    if (rangeOverridden && Array.isArray(lgFullCombined) && lgFullCombined.length > 0) {
        var carry = 0;
        rowSet = [];
        var df = rangeFrom || '2000-01-01';
        var dt = rangeTo   || '2099-12-31';
        for (var fi = 0; fi < lgFullCombined.length; fi++) {
            var fr = lgFullCombined[fi];
            var isOB = (fr._rowType === 'ledger' && fr.entryType === 'OPENING_BALANCE');
            if ((fr.date && fr.date < df) || isOB) { carry = fr._runningBalance; }
            else if (fr.date && fr.date >= df && fr.date <= dt) { rowSet.push(fr); }
        }
        openingBalDate = df;
        openingBalAmt  = carry;
    } else {
        var ob = lgFindOpeningBalance();
        openingBalDate = ob.date || '';
        openingBalAmt  = ob.amount || 0;
        rowSet = lgCombined.slice();
    }

    // Apply F&O futures filter at the rowSet level so per-row math + totals
    // both see the trimmed list (engine is upstream — UNAFFECTED).
    if (!includeFutures) {
        rowSet = rowSet.filter(function(r) {
            return !(r._rowType === 'trade' && r._nfoCashImpact === false);
        });
    }

    // 3. Transaction rows (same order as on screen)
    var sorted = rowSet.slice();
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

    var txnRows = [];
    var totalAmount = 0;
    var lastBalance = openingBalAmt;

    sorted.forEach(function(row) {
        var date = row.date || '';
        var symbol = '';
        var typeLabel = '';
        var qty = null;
        var price = null;
        var net = null;
        var amount = row.amount || 0;
        var balance = row._runningBalance || 0;

        if (row._rowType === 'pending_interest') {
            typeLabel = 'Interest';
            symbol = row.reference || 'Interest';
            amount = Math.round(row.amount || 0);
        } else if (row._rowType === 'ledger') {
            var et = row.entryType || '';
            typeLabel = LG_TYPE_LABELS[et] || et.replace(/_/g, ' ');
            symbol = (row._source && row._source.reference) || '';
            amount = row.amount || 0;
        } else if (row._rowType === 'nfo_pnl') {
            typeLabel = "F&O P&L";
            symbol = _lgExportSymbol(row);
            qty = row.quantity || null;
            amount = row.amount || 0;
        } else if (row._rowType === 'trade') {
            var src = row._source;
            typeLabel = LG_TYPE_LABELS[src.transaction_type] || (src.transaction_type || '').replace(/_/g, ' ');
            symbol = _lgExportSymbol(row);
            var q = Math.abs(src.quantity || 0);
            if (src.transaction_type === 'SELL' || src.transaction_type === 'RIGHTS_ENTITLEMENT' || src.transaction_type === 'BONUS' || src.transaction_type === 'SPLIT') q = -q;
            qty = q !== 0 ? q : null;
            price = src.price || null;
            if (row.quantity && row.netAmount) {
                net = row.netAmount / Math.abs(row.quantity);
            }
        }

        if (row._nfoCashImpact !== false) totalAmount += row.amount;
        lastBalance = balance;

        // Counterparty-POV display flip (LESSONS §E.15.13) — flip amount &
        // balance for export so the downloaded statement matches the on-screen
        // sign convention.
        txnRows.push([date, symbol, typeLabel, qty, price, net, lgD(amount), lgD(balance)]);
    });

    // 4. Holdings (recompute from filtered transactions — same as lgRenderSummary)
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
    var sortedAll = allFiltered.slice().sort(function(a, b) {
        return (a.transaction_date || '').localeCompare(b.transaction_date || '');
    });
    var fifo = wmsCalcFifoCost(sortedAll);
    var holdingsMap = fifo.holdings;
    var allGains = fifo.gains || [];

    // Source lookup for NFO symbol decoding
    var sourceLookup = {};
    for (var si = 0; si < sortedAll.length; si++) {
        var st = sortedAll[si];
        var sKey = (st.security_type === 'NFO') ? (st.symbol || '').replace(/^[A-Z]+:/, '') : (st.short_symbol || st.symbol || '');
        if (!sourceLookup[sKey]) sourceLookup[sKey] = st;
    }

    // F&O margin (includes MCX commodity F&O via the shared predicate, §E.15)
    var nfoTxns = sortedAll.filter(function(t) {
        return wmsIsDerivativeTxn(t);
    });
    var marginEvents = wmsCalcMarginFIFO(nfoTxns);
    var currentNfoMargin = marginEvents.length > 0 ? marginEvents[marginEvents.length - 1].runningMargin : 0;

    // Build holdings rows
    var totalEqCost = 0, totalEqValue = 0, totalEqMtm = 0, totalNfoMtm = 0;
    var holdingSortedKeys = Object.keys(holdingsMap).sort(function(a, b) {
        var sa = (holdingsMap[a].shortSymbol || holdingsMap[a].symbol || '').toLowerCase();
        var sb = (holdingsMap[b].shortSymbol || holdingsMap[b].symbol || '').toLowerCase();
        return sa < sb ? -1 : sa > sb ? 1 : 0;
    });

    var holdingRows = [];
    holdingSortedKeys.forEach(function(key) {
        var h = holdingsMap[key];
        if (h.quantity === 0) return;
        var qty2 = h.quantity;
        var avgCost = h.avgCost;
        var isNfo = wmsIsDerivativeSecurity(h.securityType);
        var shortSym = h.shortSymbol || h.symbol;

        // Decode NFO symbol
        var displaySym = shortSym;
        var srcTxn = sourceLookup[key];
        if (srcTxn && isNfo && typeof wmsFormatContract === 'function') {
            var contract = wmsFormatContract(srcTxn);
            if (contract && contract !== 'Equity' && contract !== 'NFO') {
                displaySym = shortSym + ' ' + contract;
            }
        }

        // Same NFO price-lookup fix as the on-screen Positions table (LESSONS
        // §E.15.17). Use the holdings key (= full contract symbol) for NFO so
        // option / futures prices resolve correctly in exports too.
        var priceLookupKey2 = isNfo ? key : shortSym;
        var priceEntry = (typeof wmsLivePrices === 'object' && wmsLivePrices) ? wmsLivePrices[priceLookupKey2] : null;
        var cmp = (priceEntry && priceEntry.lp > 0) ? priceEntry.lp : avgCost;
        var value, mtm;
        if (isNfo) {
            mtm = (cmp - avgCost) * qty2;
            value = mtm;
            totalNfoMtm += mtm;
        } else {
            value = qty2 * cmp;
            mtm = value - h.totalCost;
            totalEqCost += h.totalCost;
            totalEqValue += value;
            totalEqMtm += mtm;
        }

        holdingRows.push([displaySym, wmsSecTypeShortLabel(h.securityType), qty2, avgCost, cmp, mtm, value]);
    });

    // 5. Summary card values (same formulas as lgRenderSummary — raw cash
    //    balance flows through so -ve balances are preserved end-to-end).
    var cashBalance = (typeof lgCurrentCashBalance === 'number') ? lgCurrentCashBalance : (lgCarryForwardBalance || 0);
    var outstanding = cashBalance + currentNfoMargin;
    var totalHoldingsValue = totalEqValue + totalNfoMtm;

    // Potential Tax + the Booked P&L TOTAL always tax the FULL financial year
    // (§E.15.17), independent of the statement's display window — this mirrors
    // the on-screen summary card and stops a "since last recon" export from
    // taxing only the since-recon slice. FY is anchored to the statement's
    // as-of date (the range end when one is set, else today). The Booked P&L
    // section then shows Starting (pre-recon) + New (since-recon, by symbol) +
    // Total (FY), split at the same reconciliation the transaction section uses.
    // Rate resolves via wmsGetTaxRate(invId, brokerId) (IBA override before
    // investor-level fallback), same as lgRenderSummary.
    var asOfStr = rangeTo || new Date().toISOString().slice(0, 10);
    var asOfY = parseInt(asOfStr.slice(0, 4), 10);
    var asOfM = parseInt(asOfStr.slice(5, 7), 10);
    var fyStartYearX = (asOfM >= 4) ? asOfY : asOfY - 1;
    var fyStartStrX = fyStartYearX + '-04-01';
    var fyEndStrX   = (fyStartYearX + 1) + '-03-31';
    var fyLabel = 'FY ' + fyStartYearX + '-' + String(fyStartYearX + 1).slice(-2);

    var fyGains = allGains.filter(function(g) {
        return g.sellDate && g.sellDate >= fyStartStrX && g.sellDate <= fyEndStrX;
    });
    var bookedSplitX = lgSplitBookedGains(fyGains, fyStartStrX, fyEndStrX);
    var totalBookedGain = bookedSplitX.total;
    var isBrokerStmt = (lgStatementType === 'broker');
    var potentialTax = Math.max(0, totalBookedGain) * (taxRatePct / 100);
    var netReceivable = totalHoldingsValue - cashBalance - potentialTax;
    var totalCurrentMtm = totalEqMtm + totalNfoMtm;
    // Conservative BwoM (LESSONS §E.15.13) — only subtract MTM when positive
    // (lose unrealised gain on a close-at-cost). Negative MTM doesn't flatter
    // BwoM upward; show the more conservative downside number.
    var balNoMtm = (totalCurrentMtm > 0) ? (netReceivable - totalCurrentMtm) : netReceivable;
    var pctBalOverOutstanding = outstanding > 0.01 ? (balNoMtm / outstanding) : 0;

    // Booked P&L rows (grouped by symbol) — the NEW (since-recon) gains only.
    // When there's no recon in the FY, newGains === all FY gains (unchanged).
    var bySym = {};
    bookedSplitX.newGains.forEach(function(g) {
        var k = (g.shortSymbol || g.symbol) + '|' + (g.securityType || 'EQ');
        if (!bySym[k]) bySym[k] = { shortSymbol: g.shortSymbol || g.symbol, securityType: g.securityType || 'EQ', qty: 0, gain: 0 };
        bySym[k].qty += g.qty || 0;
        bySym[k].gain += g.gain || 0;
    });
    var bookedRows = Object.keys(bySym).sort().map(function(k) {
        var b = bySym[k];
        return [b.shortSymbol, wmsSecTypeShortLabel(b.securityType), b.qty, b.gain];
    });

    // Counterparty-POV display values (LESSONS §E.15.13). Balance-like values
    // are flipped (×-1) for export so the downloaded statement matches the
    // on-screen sign convention. Holdings/Tax/Margin/NR/BalNoMtm stay as-is
    // (NR & BalNoMtm formulas already produce counterparty-POV signs).
    return {
        viewName: viewName,
        dateLabel: dateLabel,
        fyLabel: fyLabel,
        statementType: lgStatementType,
        openingBal: { date: openingBalDate, amount: lgD(openingBalAmt) },
        txnRows: txnRows,
        totalAmount: lgD(totalAmount),
        lastBalance: lgD(lastBalance),
        holdingRows: holdingRows,
        totalMtm: totalEqMtm + totalNfoMtm,
        totalValue: totalEqValue + totalNfoMtm,
        holdingsValue: totalHoldingsValue,
        outstanding: lgD(cashBalance) + currentNfoMargin,
        outstandingBal: lgD(cashBalance),
        outstandingMargin: currentNfoMargin,
        potentialTax: potentialTax,
        netReceivable: netReceivable,
        balNoMtm: balNoMtm,
        pctBalOverOutstanding: pctBalOverOutstanding,
        bookedRows: bookedRows,
        totalBookedGain: totalBookedGain,
        bookedSplit: bookedSplitX.split,
        bookedStarting: bookedSplitX.startingGain,
        bookedNew: (totalBookedGain - bookedSplitX.startingGain),
        bookedReconDate: bookedSplitX.reconDate
    };
}

// Plain-text symbol for export (strips HTML from lgFormatSymbol)
function _lgExportSymbol(row) {
    if (row._rowType !== 'trade' && row._rowType !== 'nfo_pnl') return '';
    var source = row._source;
    var sym = source.short_symbol || source.symbol || '';
    if (wmsIsDerivativeTxn(source)) {
        var contract = typeof wmsFormatContract === 'function' ? wmsFormatContract(source) : '';
        if (contract && contract !== 'Equity' && contract !== 'NFO') return sym + ' ' + contract;
    }
    return sym;
}

// ── Column definitions (shared between Excel & PDF) ───────────────

var LG_EXPORT_TXN_COLS = [
    // Date column: skill long format 'ddd, dd-mmm-yy' so the day-of-week
    // is visible. Uses the `date_long` preset (Excel format string + jsFmt
    // both produce 'Wed, 01-Apr-26'). Width 13ch fits 'Wed, 01-Apr-26'.
    { header: 'Date',    type: 'date_long', width: 13 },
    { header: 'Symbol',  type: 'text',   width: 20 },
    { header: 'Type',    type: 'type',   width: 10 },
    { header: 'Qty',     type: 'qty',    width: 9 },
    { header: 'Price',   type: 'price',  width: 10 },
    { header: 'Net',     type: 'price',  width: 10 },
    { header: 'Amount',  type: 'amount', width: 12 },
    { header: 'Balance', type: 'amount', width: 12 }
];

var LG_EXPORT_HOLD_COLS = [
    { header: 'Symbol',   type: 'text',   width: 20 },
    { header: 'Type',     type: 'type',   width: 6 },
    { header: 'Qty',      type: 'qty',    width: 9 },
    { header: 'Avg Cost', type: 'price',  width: 10 },
    { header: 'CMP',      type: 'price',  width: 10 },
    { header: 'MTM',      type: 'amount', width: 12 },
    { header: 'Value',    type: 'amount', width: 12 }
];

var LG_EXPORT_BOOKED_COLS = [
    { header: 'Symbol',       type: 'text',   width: 20 },
    { header: 'Type',         type: 'type',   width: 6 },
    { header: 'Qty Closed',   type: 'qty',    width: 10 },
    { header: 'Realised P&L', type: 'amount', width: 12 }
];

// ── Excel Export ──────────────────────────────────────────────────
// Accepts a pre-built data object (from lgExportRun). Honors section flags
// to skip unchecked blocks. Running layout (one sheet, sections top-to-
// bottom) per LESSONS §E.18.1. When called without args, defaults to all
// sections (legacy compatibility).

function lgExportExcel(d) {
    if (!d) {
        d = lgGatherExportData();
        d.sectionFlags = { txn: true, openPos: true, booked: true };
        d.txnSectionNet = {
            balance: d.lastBalance,
            holdingsValue: d.holdingsValue,
            potentialTax: d.potentialTax,
            net: d.lastBalance + d.holdingsValue - d.potentialTax
        };
    }
    var flags = d.sectionFlags || { txn: true, openPos: true, booked: true };
    if ((!flags.txn || !d.txnRows.length) && (!flags.openPos || !d.holdingRows.length) && (!flags.booked || !d.bookedRows.length)) {
        showAlert('No data to export for the chosen sections', 'info', 2500);
        return;
    }
    var taxRatePct = lgGetEffectiveTaxRate();

    // Column letters for formula references (0-based: A=Date, B=Symbol, ... H=Balance)
    // Txn cols: A=Date, B=Symbol, C=Type, D=Qty, E=Price, F=Net, G=Amount, H=Balance
    var C = wmsExColLetter; // shorthand
    var cAmt = C(6);  // G = Amount
    var cBal = C(7);  // H = Balance
    var cQty = C(3);  // D = Qty
    var cNet = C(5);  // F = Net

    // ── Row tracking ──
    // Sections render conditionally based on `flags`, so the absolute Excel
    // row of each block depends on which earlier blocks are present. Walk
    // forward with a counter; each block reserves the rows it will occupy
    // BEFORE the formulas are built, so cell references land correctly.
    // Layout (with snapshot_header + section titles):
    //   Row 1: snapshot header (bold left + grey right)
    //   Row 2: blank
    //   Transactions: 1 title + 1 header + 1 OB + N data + 1 total + 1 blank + 4 summary + 1 blank
    //   Open Positions: 1 title + 1 header + M data + 1 total + 1 blank
    //   Booked P&L: 1 title + 1 header + K data + 1 total
    var nextRow = 1;
    nextRow++;   // snapshot header
    nextRow++;   // blank under snapshot header

    var headerRow, obExcelRow, firstDataRow, lastDataRow, totalExcelRow, sumStartRow;
    if (flags.txn && d.txnRows.length > 0) {
        nextRow++;                         // section title 'TRANSACTIONS'
        headerRow    = nextRow++;
        obExcelRow   = nextRow++;
        firstDataRow = nextRow;
        nextRow     += d.txnRows.length;
        lastDataRow  = nextRow - 1;
        totalExcelRow = nextRow++;
        nextRow++;                         // blank
        sumStartRow  = nextRow;            // first of the 4 summary lines
        nextRow     += 4;                  // 4 summary lines (Balance/+Holdings/-Tax/=Net)
        nextRow++;                         // blank
    }

    var holdHeaderRow, holdFirstData, holdLastData, holdTotalRow;
    if (flags.openPos && d.holdingRows.length > 0) {
        nextRow++;                         // section title 'OPEN POSITIONS'
        holdHeaderRow = nextRow++;
        holdFirstData = nextRow;
        nextRow      += d.holdingRows.length;
        holdLastData  = nextRow - 1;
        holdTotalRow  = nextRow++;
        nextRow++;                         // blank
    }

    // Booked P&L renders whenever there is FY booked P&L to show — either
    // since-recon rows, or (recon exists but no new trades closed) a non-zero
    // FY total that still needs its Starting line + Total displayed (§E.15.17).
    var bookedShow = flags.booked && (d.bookedRows.length > 0 || (d.bookedSplit && Math.abs(d.totalBookedGain) > 0.005));
    var bookedHeaderRow, bookedStartRow, bookedFirstData, bookedLastData, bookedNewRow, bookedTotalRow;
    if (bookedShow) {
        nextRow++;                         // section title 'BOOKED P&L'
        bookedHeaderRow = nextRow++;
        if (d.bookedSplit) bookedStartRow = nextRow++;   // Starting Booked P&L line
        bookedFirstData = nextRow;
        nextRow        += d.bookedRows.length;
        bookedLastData  = nextRow - 1;
        if (d.bookedSplit) bookedNewRow = nextRow++;     // New Booked P&L subtotal
        bookedTotalRow  = nextRow++;
    }

    // ── Opening Balance row with formula for Balance ──
    var obRow = [d.openingBal.date, 'Opening Balance', '', null, null, null, null, d.openingBal.amount];
    obRow._bold = true;
    obRow._fill = 'FEFCE8';

    // ── Transaction rows: inject formulas for Amount & Balance ──
    var txnRowsWithFormulas = d.txnRows.map(function(row, idx) {
        var r = firstDataRow + idx; // Excel row number
        var newRow = row.slice(); // shallow copy

        // Amount (col G): if there's qty AND net, use formula =-D*F (negate so
        // the trader-POV sign comes out right — BUY's +ve qty produces -ve
        // amount [cash out], SELL's -ve qty produces +ve amount [cash in]).
        // Interest rows are hardcoded -ve in row[6]; we don't overwrite those.
        // LESSONS §E.15.13 sign convention + §E.18.1 export.
        if (row[3] !== null && row[5] !== null && row[3] !== 0) {
            newRow[6] = { formula: '-' + cQty + r + '*' + cNet + r, result: row[6] || 0 };
        }

        // Balance (col H): running sum = OB + SUM(Amount from first data row to this row)
        newRow[7] = {
            formula: cBal + obExcelRow + '+SUM(' + cAmt + firstDataRow + ':' + cAmt + r + ')',
            result: row[7] || 0
        };

        // Carry over row-level flags
        if (row._bold) newRow._bold = true;
        if (row._fill) newRow._fill = row._fill;
        return newRow;
    });

    // ── Totals row: formulas ──
    var totalAmtFormula = {
        formula: 'SUM(' + cAmt + firstDataRow + ':' + cAmt + lastDataRow + ')',
        result: d.totalAmount
    };
    var totalBalFormula = {
        formula: cBal + lastDataRow,
        result: d.lastBalance
    };

    // ── Holdings formulas (using row offsets computed above) ──
    // Holdings cols: A=Symbol, B=Type, C=Qty, D=AvgCost, E=CMP, F=MTM, G=Value
    var hcQty  = C(2); // C
    var hcAvg  = C(3); // D
    var hcCmp  = C(4); // E
    var hcMtm  = C(5); // F
    var hcVal  = C(6); // G

    var holdRowsWithFormulas = (flags.openPos ? d.holdingRows : []).map(function(row, idx) {
        var r = holdFirstData + idx;       // ABSOLUTE Excel row (offsets pre-computed)
        var newRow = row.slice();
        var isNfo = (row[1] === 'NFO' || row[1] === 'MCX');

        // MTM (col F) = (CMP - AvgCost) * Qty
        newRow[5] = {
            formula: '(' + hcCmp + r + '-' + hcAvg + r + ')*' + hcQty + r,
            result: row[5] || 0
        };

        // Value (col G): EQ = Qty*CMP, NFO = MTM
        if (isNfo) {
            newRow[6] = { formula: hcMtm + r, result: row[6] || 0 };
        } else {
            newRow[6] = { formula: hcQty + r + '*' + hcCmp + r, result: row[6] || 0 };
        }

        return newRow;
    });

    var holdTotalMtm = (flags.openPos && d.holdingRows.length > 0) ? {
        formula: 'SUM(' + hcMtm + holdFirstData + ':' + hcMtm + holdLastData + ')',
        result: d.totalMtm
    } : 0;
    var holdTotalVal = (flags.openPos && d.holdingRows.length > 0) ? {
        formula: 'SUM(' + hcVal + holdFirstData + ':' + hcVal + holdLastData + ')',
        result: d.totalValue
    } : 0;

    // ── Booked P&L total + (when split) New subtotal formulas ──
    // Booked cols: A=Symbol, B=Type, C=Qty, D=Gain
    var bcGain = C(3); // D
    // New subtotal = SUM of the since-recon symbol rows (0 hardcoded if none).
    var bookedNewFormula = (d.bookedRows.length > 0)
        ? { formula: 'SUM(' + bcGain + bookedFirstData + ':' + bcGain + bookedLastData + ')', result: d.bookedNew }
        : d.bookedNew;
    // Total: split → Starting cell + New subtotal cell; else SUM of the rows.
    var bookedTotalFormula;
    if (d.bookedSplit) {
        bookedTotalFormula = { formula: bcGain + bookedStartRow + '+' + bcGain + bookedNewRow, result: d.totalBookedGain };
    } else if (d.bookedRows.length > 0) {
        bookedTotalFormula = { formula: 'SUM(' + bcGain + bookedFirstData + ':' + bcGain + bookedLastData + ')', result: d.totalBookedGain };
    } else {
        bookedTotalFormula = d.totalBookedGain;
    }

    // Build sections according to checked flags. Single sheet, sections flow
    // top-to-bottom. The snapshot_header banner appears once at the very top
    // (mirrors the F&O snapshot pattern + the on-screen unit reminder).
    var sections = [];

    // F&O-snapshot-style banner (left = view + range, right = unit + date)
    var snapLeftText  = d.viewName + (d.dateLabel ? ' — ' + d.dateLabel : '');
    var snapUnitLabel = (typeof getUnitDescription === 'function') ? getUnitDescription() : "₹ '000";
    var snapTodayStr  = lgFmtDate(new Date().toISOString().slice(0, 10)) || new Date().toISOString().slice(0, 10);
    var snapRightText = 'all amounts in ' + snapUnitLabel + '  |  ' + snapTodayStr;
    sections.push({ type: 'snapshot_header', leftText: snapLeftText, rightText: snapRightText });
    sections.push({ type: 'blank' });

    if (flags.txn && d.txnRows.length > 0) {
        sections.push({ type: 'title', text: 'TRANSACTIONS' });
        sections.push({ type: 'header' });
        sections.push({ type: 'data', rows: [obRow] });
        sections.push({ type: 'data', rows: txnRowsWithFormulas });
        sections.push({ type: 'total', values: [null, null, null, null, null, 'TOTALS:', totalAmtFormula, totalBalFormula] });
        sections.push({ type: 'blank' });

        // Right-side summary block: F33 = label, H33 = value. Forms a visual
        // block aligned with the Amount/Balance columns above (LESSONS §E.18.1
        // / owner spec 2026-05-26 — "Move the text to F33 instead of A33").
        // Tax is rendered as a NEGATIVE value (it's a reduction); the Net
        // formula sums all three lines so Net = Balance + Holdings + (-Tax).
        // - Receivable / Payable label is dynamic on the closing Balance sign.
        // - Net row is bold + light-grey fill matching the user's T28 highlight.
        var balLabel    = (d.txnSectionNet.balance < 0) ? 'Payable' : 'Receivable';
        var netLabel    = (d.txnSectionNet.net < 0) ? '= Net Payable' : '= Net Receivable';
        var taxVal      = -Math.abs(d.txnSectionNet.potentialTax);
        var balRow      = sumStartRow;
        var holdSumRow  = sumStartRow + 1;
        var taxSumRow   = sumStartRow + 2;
        var netSumRow   = sumStartRow + 3;
        // Net is computed in-sheet so editing any of Balance / Holdings / Tax
        // updates Net live. Formula = sum of the 3 rows in col H.
        var netFormula  = {
            formula: cBal + balRow + '+' + cBal + holdSumRow + '+' + cBal + taxSumRow,
            result: d.txnSectionNet.net
        };
        // 4 data rows — empty A:E, label in F, value in H (G blank as gap).
        var summaryRows = [
            [null, null, null, null, null, balLabel,                               null, d.txnSectionNet.balance],
            [null, null, null, null, null, '+ Value of Holdings',                  null, d.txnSectionNet.holdingsValue],
            [null, null, null, null, null, '− Potential Tax (' + taxRatePct + '%)', null, taxVal],
            [null, null, null, null, null, netLabel,                                null, netFormula]
        ];
        // Highlight only the Net row.
        summaryRows[3]._bold = true;
        summaryRows[3]._fill = 'C0C0C0';  // light grey matching T28 in the user's annotated workbook
        sections.push({ type: 'data', rows: summaryRows });
        sections.push({ type: 'blank' });
    }

    if (flags.openPos && d.holdingRows.length > 0) {
        sections.push({ type: 'columns', columns: LG_EXPORT_HOLD_COLS });
        sections.push({ type: 'title', text: 'OPEN POSITIONS' });
        sections.push({ type: 'header' });
        sections.push({ type: 'data', rows: holdRowsWithFormulas });
        sections.push({ type: 'total', values: [null, null, null, null, null, holdTotalMtm, holdTotalVal] });
        sections.push({ type: 'blank' });
    }

    if (bookedShow) {
        sections.push({ type: 'columns', columns: LG_EXPORT_BOOKED_COLS });
        sections.push({ type: 'title', text: 'BOOKED P&L' });
        sections.push({ type: 'header' });
        if (d.bookedSplit) {
            var bkStartLabel = 'Starting Booked P&L' + (d.bookedReconDate ? ' (as on ' + (lgFmtDate(d.bookedReconDate) || d.bookedReconDate) + ')' : '');
            sections.push({ type: 'data', rows: [[bkStartLabel, null, null, d.bookedStarting]] });
        }
        if (d.bookedRows.length > 0) sections.push({ type: 'data', rows: d.bookedRows });
        if (d.bookedSplit) {
            sections.push({ type: 'total', values: ['New Booked P&L (since recon)', null, null, bookedNewFormula] });
        }
        sections.push({ type: 'total', values: [(d.bookedSplit ? ('Total Booked P&L (' + d.fyLabel + ')') : null), null, null, bookedTotalFormula] });
    }

    if (sections.length === 0) {
        showAlert('No data to export in the chosen range', 'info', 2500);
        return;
    }

    var filename = wmsExportFilename('Statement', d.viewName, d.dateLabel, 'xlsx');

    wmsExportExcel({
        filename: filename,
        sheets: [{
            name: d.viewName.slice(0, 31),
            columns: LG_EXPORT_TXN_COLS,
            sections: sections,
            freezeRow: 1,
            printSetup: {
                orientation: 'portrait',
                paperSize: 9,
                fitToPage: true,
                margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5 }
            }
        }]
    });
}

// ── PDF Export ─────────────────────────────────────────────────────
// Accepts a pre-built data object (from lgExportRun's gatherer). When called
// without args (legacy path), it gathers via lgGatherExportData() with all
// sections enabled — preserves backwards-compat with any other entry points.
// LESSONS §E.18.1 — modal-driven, one PDF page per checked section.

function lgExportPdf(d) {
    if (!d) {
        d = lgGatherExportData();
        d.sectionFlags = { txn: true, openPos: true, booked: true };
        d.txnSectionNet = {
            balance: d.lastBalance,
            holdingsValue: d.holdingsValue,
            potentialTax: d.potentialTax,
            net: d.lastBalance + d.holdingsValue - d.potentialTax
        };
    }
    var flags = d.sectionFlags || { txn: true, openPos: true, booked: true };
    if ((!flags.txn || !d.txnRows.length) && (!flags.openPos || !d.holdingRows.length) && (!flags.booked || !d.bookedRows.length)) {
        showAlert('No data to export for the chosen sections', 'info', 2500);
        return;
    }
    var taxRatePct = lgGetEffectiveTaxRate();

    // F&O-snapshot-style banner — bold view name on left, small grey unit
    // + date footnote on right. Repeated on every page.
    var snapLeft  = d.viewName + (d.dateLabel ? ' — ' + d.dateLabel : '');
    var unitLabel = (typeof getUnitDescription === 'function') ? getUnitDescription() : "₹ '000";
    var todayStr  = lgFmtDate(new Date().toISOString().slice(0, 10)) || new Date().toISOString().slice(0, 10);
    var snapRight = 'all amounts in ' + unitLabel + '  |  ' + todayStr;
    var snapshotHeader = { type: 'snapshot_header', leftText: snapLeft, rightText: snapRight };

    // Opening balance row for the Transactions table
    var obRow = [d.openingBal.date, 'Opening Balance', '', null, null, null, null, d.openingBal.amount];

    var filename = wmsExportFilename('Statement', d.viewName, d.dateLabel, 'pdf');
    var pages = [];

    if (flags.txn && d.txnRows.length > 0) {
        // Transactions block — own page with a TRANSACTIONS section title at
        // the top. Totals summary (right-side, labelCol=F, valueCol=H) below
        // the data: Balance + Value of Holdings − Potential Tax = Net.
        // (Tax displayed as -ve; Net row bold + light-grey highlight + border.)
        var txnNetLabel = (d.txnSectionNet.net < 0) ? '= Net Payable' : '= Net Receivable';
        var txnBalLabel = (d.txnSectionNet.balance < 0) ? 'Payable' : 'Receivable';
        var txnTaxValue = -Math.abs(d.txnSectionNet.potentialTax);
        pages.push({
            columns: LG_EXPORT_TXN_COLS,
            sections: [
                snapshotHeader,
                { type: 'title', text: 'TRANSACTIONS' },
                { type: 'header' },
                { type: 'data', rows: [obRow] },
                { type: 'data', rows: d.txnRows },
                { type: 'total', values: [null, null, null, null, null, 'TOTALS:', d.totalAmount, d.lastBalance] },
                { type: 'blank' },
                { type: 'summary', rows: [
                    { label: txnBalLabel,                                value: d.txnSectionNet.balance,       labelCol: 6, valueCol: 8 },
                    { label: '+ Value of Holdings',                       value: d.txnSectionNet.holdingsValue, labelCol: 6, valueCol: 8 },
                    { label: '− Potential Tax (' + taxRatePct + '%)',    value: txnTaxValue,                   labelCol: 6, valueCol: 8 },
                    { label: txnNetLabel,                                 value: d.txnSectionNet.net,           labelCol: 6, valueCol: 8, bold: true, fill: 'C0C0C0', border: true }
                ]}
            ]
        });
    }

    if (flags.openPos && d.holdingRows.length > 0) {
        // Open Positions block — own page with snapshot banner + section title.
        pages.push({
            columns: LG_EXPORT_HOLD_COLS,
            sections: [
                snapshotHeader,
                { type: 'title', text: 'OPEN POSITIONS' },
                { type: 'header' },
                { type: 'data', rows: d.holdingRows },
                { type: 'total', values: [null, null, null, null, null, d.totalMtm, d.totalValue] }
            ]
        });
    }

    var pdfBookedShow = flags.booked && (d.bookedRows.length > 0 || (d.bookedSplit && Math.abs(d.totalBookedGain) > 0.005));
    if (pdfBookedShow) {
        // Booked P&L block — own page with snapshot banner + section title.
        // Split (§E.15.17): Starting (pre-recon) + New (since-recon rows +
        // subtotal) + Total (FY). Without a recon it's the plain rows + total.
        var bkSections = [
            snapshotHeader,
            { type: 'title', text: 'BOOKED P&L' },
            { type: 'header' }
        ];
        if (d.bookedSplit) {
            var pdfStartLabel = 'Starting Booked P&L' + (d.bookedReconDate ? ' (as on ' + (lgFmtDate(d.bookedReconDate) || d.bookedReconDate) + ')' : '');
            bkSections.push({ type: 'data', rows: [[pdfStartLabel, null, null, d.bookedStarting]] });
        }
        if (d.bookedRows.length > 0) bkSections.push({ type: 'data', rows: d.bookedRows });
        if (d.bookedSplit) {
            bkSections.push({ type: 'total', values: ['New Booked P&L (since recon)', null, null, d.bookedNew] });
        }
        bkSections.push({ type: 'total', values: [(d.bookedSplit ? ('Total Booked P&L (' + d.fyLabel + ')') : null), null, null, d.totalBookedGain] });
        pages.push({ columns: LG_EXPORT_BOOKED_COLS, sections: bkSections });
    }

    if (pages.length === 0) {
        showAlert('No data to export in the chosen range', 'info', 2500);
        return;
    }

    // No title bar — the user wants "just the trades", no firm branding.
    wmsExportPdf({
        filename: filename,
        pages: pages
    });
}

// ── Image Export ──────────────────────────────────────────────────
// Draws the selected sections onto a tall canvas (one section after another)
// then tries to copy as PNG to clipboard. Falls back to download if the
// browser blocks clipboard writes. Layout is intentionally minimal — just
// the tables, no firm branding (LESSONS §E.18.1).

function lgExportImage(d, mode) {
    if (!d) return;
    mode = mode || 'copy';  // 'copy' = clipboard with download fallback; 'download' = file only
    var flags = d.sectionFlags || { txn: true, openPos: true, booked: true };
    var taxRatePct = lgGetEffectiveTaxRate();

    // Layout constants — skill / office-formatting (Aptos 9.5pt).
    var DPR = 2;
    var W = 1200;                    // CSS width
    var PAD = 16;
    var ROW_H = 20;
    var HEADER_H = 24;
    var TITLE_H = 26;
    var SNAP_H = 32;
    var SECTION_GAP = 10;
    var BLOCK_GAP = 22;
    var FONT = '12px Aptos, Helvetica, Arial, sans-serif';
    var FONT_BOLD = 'bold 12px Aptos, Helvetica, Arial, sans-serif';
    var FONT_SECTION = 'bold 14px Aptos, Helvetica, Arial, sans-serif';
    var FONT_SNAP_LEFT  = 'bold 15px Aptos, Helvetica, Arial, sans-serif';
    var FONT_SNAP_RIGHT = '11px Aptos, Helvetica, Arial, sans-serif';
    var TEXT_DARK = '#1a202c';
    var TEXT_MUTED = '#4a5568';
    var ROW_ALT = '#f7fafc';
    var BORDER = '#e2e8f0';

    // Helper — measure total canvas height before drawing
    function blockHeight(rowsCount, hasHeader, hasTotals, extraLines) {
        var h = 0;
        if (hasHeader) h += HEADER_H;
        h += rowsCount * ROW_H;
        if (hasTotals) h += ROW_H;
        if (extraLines) h += extraLines * ROW_H;
        return h;
    }

    var totalH = PAD;
    var pendingBlocks = [];

    // Reserve room for the snapshot-header banner at the top of the image.
    totalH += SNAP_H + 8;

    if (flags.txn && d.txnRows.length > 0) {
        // +1 for the OB row, +4 for the Net-summary lines (Balance / +Holdings / -Tax / =Net)
        var h = TITLE_H + blockHeight(d.txnRows.length + 1, true, true, 4 + 1) + SECTION_GAP;
        totalH += h;
        pendingBlocks.push({ kind: 'txn', height: h });
    }
    if (flags.openPos && d.holdingRows.length > 0) {
        var h2 = TITLE_H + blockHeight(d.holdingRows.length, true, true, 0);
        if (pendingBlocks.length > 0) totalH += BLOCK_GAP;
        totalH += h2;
        pendingBlocks.push({ kind: 'openpos', height: h2 });
    }
    var imgBookedShow = flags.booked && (d.bookedRows.length > 0 || (d.bookedSplit && Math.abs(d.totalBookedGain) > 0.005));
    if (imgBookedShow) {
        // +2 extra rows when split: the Starting line + the New subtotal.
        var h3 = TITLE_H + blockHeight(d.bookedRows.length, true, true, d.bookedSplit ? 2 : 0);
        if (pendingBlocks.length > 0) totalH += BLOCK_GAP;
        totalH += h3;
        pendingBlocks.push({ kind: 'booked', height: h3 });
    }
    totalH += PAD;

    if (pendingBlocks.length === 0) {
        if (typeof showAlert === 'function') showAlert('No data to export for the chosen sections', 'info', 2500);
        return;
    }

    // Create canvas at 2× DPR for sharpness
    var canvas = document.createElement('canvas');
    canvas.width = W * DPR;
    canvas.height = totalH * DPR;
    var ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, totalH);

    // fmtAmt — match WMS on-screen unit ('000 by default). formatAmountRaw
    // already applies the user's unit preference + Indian / international
    // comma grouping. fmtPrice keeps full rupees (per-unit prices don't get
    // divided). fmtQty is integer-comma.
    var fmtAmt = (typeof formatAmountRaw === 'function')
        ? formatAmountRaw
        : ((typeof wmsFmtAmt === 'function') ? wmsFmtAmt : function(v) { return String(v); });
    var fmtPrice = (typeof wmsFmtAmt === 'function') ? wmsFmtAmt : function(v) { return v == null ? '' : Number(v).toFixed(2); };
    var fmtQty = (typeof formatQuantity === 'function') ? formatQuantity : function(v) { return v == null ? '' : String(v); };
    var fmtDate = (typeof lgFmtDate === 'function') ? lgFmtDate : function(v) { return v; };

    // Drawing helper — render a single table row across given column widths.
    // Auto-applies red when the formatted value is in parens (e.g. '(12,345)'),
    // matching the skill's "negatives in red parens" convention. Caller-passed
    // `color` overrides only when not red-auto'd.
    var RED = '#dc2626';
    function drawCell(text, x, y, w, align, font, color) {
        ctx.font = font;
        var s = String(text == null ? '' : text);
        // Auto-red for parens-wrapped negatives.
        var isNegFmt = /^\(.*\)$/.test(s.trim());
        ctx.fillStyle = isNegFmt ? RED : (color || TEXT_DARK);
        ctx.textAlign = align || 'left';
        ctx.textBaseline = 'middle';
        var tx = align === 'right' ? x + w - 6 : (align === 'center' ? x + w / 2 : x + 6);
        // Clip overflow by truncating with ellipsis
        var maxW = w - 10;
        var original = s;
        while (s.length > 0 && ctx.measureText(s).width > maxW) {
            s = s.slice(0, -1);
        }
        if (s.length < original.length && s.length > 1) s = s.slice(0, -1) + '…';
        ctx.fillText(s, tx, y + ROW_H / 2);
    }

    function drawHeaderRow(y, headers, widths, aligns) {
        ctx.fillStyle = '#edf2f7';
        ctx.fillRect(PAD, y, W - 2 * PAD, HEADER_H);
        ctx.strokeStyle = BORDER;
        ctx.beginPath();
        ctx.moveTo(PAD, y + HEADER_H);
        ctx.lineTo(W - PAD, y + HEADER_H);
        ctx.stroke();
        var x = PAD;
        for (var i = 0; i < headers.length; i++) {
            drawCell(headers[i], x, y, widths[i], aligns[i], FONT_BOLD, TEXT_MUTED);
            x += widths[i];
        }
    }

    function drawDataRow(y, cells, widths, aligns, rowIdx, bold) {
        if (rowIdx % 2 === 1) {
            ctx.fillStyle = ROW_ALT;
            ctx.fillRect(PAD, y, W - 2 * PAD, ROW_H);
        }
        var x = PAD;
        for (var i = 0; i < cells.length; i++) {
            drawCell(cells[i], x, y, widths[i], aligns[i], bold ? FONT_BOLD : FONT, TEXT_DARK);
            x += widths[i];
        }
    }

    // Section title — bold uppercase header above each block (skill / image).
    function drawSectionTitle(y, text) {
        ctx.font = FONT_SECTION;
        ctx.fillStyle = TEXT_DARK;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, PAD, y + TITLE_H / 2);
        // Thin black underline so the title visually separates from the table
        ctx.strokeStyle = '#1a202c';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(PAD, y + TITLE_H - 2);
        ctx.lineTo(W - PAD, y + TITLE_H - 2);
        ctx.stroke();
    }

    // Snapshot-style banner — bold left title + small grey right footnote.
    // One-row band at the very top of the image (mirrors F&O snapshot style).
    function drawSnapshotHeader(y, leftText, rightText) {
        ctx.font = FONT_SNAP_LEFT;
        ctx.fillStyle = TEXT_DARK;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(leftText || '', PAD, y + SNAP_H / 2);

        ctx.font = FONT_SNAP_RIGHT;
        ctx.fillStyle = TEXT_MUTED;
        ctx.textAlign = 'right';
        ctx.fillText(rightText || '', W - PAD, y + SNAP_H / 2);

        // Thin underline below
        ctx.strokeStyle = '#cbd5e0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(PAD, y + SNAP_H);
        ctx.lineTo(W - PAD, y + SNAP_H);
        ctx.stroke();
    }

    var y = PAD;

    // ── Snapshot header (banner at top, one-row F&O-snapshot style) ──
    var imgSnapLeft  = d.viewName + (d.dateLabel ? ' — ' + d.dateLabel : '');
    var imgUnitLabel = (typeof getUnitDescription === 'function') ? getUnitDescription() : "₹ '000";
    var imgTodayStr  = lgFmtDate(new Date().toISOString().slice(0, 10)) || new Date().toISOString().slice(0, 10);
    drawSnapshotHeader(y, imgSnapLeft, 'all amounts in ' + imgUnitLabel + '  |  ' + imgTodayStr);
    y += SNAP_H + 8;

    // ── Transactions block ──
    if (flags.txn && d.txnRows.length > 0) {
        drawSectionTitle(y, 'TRANSACTIONS');
        y += TITLE_H;
        var txnHeaders = ['Date', 'Symbol', 'Type', 'Qty', 'Price', 'Net', 'Amount', 'Balance'];
        var txnAligns  = ['left',  'left',   'left', 'right','right','right','right', 'right'];
        var txnW = [80, 200, 110, 70, 80, 80, 100, 100];
        // Normalize widths to fit W - 2*PAD
        var sumW = txnW.reduce(function(a, b) { return a + b; }, 0);
        var scale = (W - 2 * PAD) / sumW;
        txnW = txnW.map(function(w) { return w * scale; });

        drawHeaderRow(y, txnHeaders, txnW, txnAligns);
        y += HEADER_H;

        // Opening Balance row
        drawDataRow(y, [
            fmtDate(d.openingBal.date) || d.openingBal.date,
            'Opening Balance', '', '', '', '', '', fmtAmt(d.openingBal.amount)
        ], txnW, txnAligns, 0, true);
        y += ROW_H;

        // Data rows — each item in d.txnRows is [date, sym, type, qty, price, net, amt, bal]
        // Price + Net are PER-UNIT prices (always full rupees, never unit-divided).
        // Amount + Balance follow the on-screen unit (divided when in '000).
        d.txnRows.forEach(function(r, i) {
            var cells = [
                fmtDate(r[0]) || r[0],
                r[1] || '',
                r[2] || '',
                r[3] == null ? '' : fmtQty(r[3]),
                r[4] == null ? '' : fmtPrice(r[4]),
                r[5] == null ? '' : fmtPrice(r[5]),
                r[6] == null ? '' : fmtAmt(r[6]),
                r[7] == null ? '' : fmtAmt(r[7])
            ];
            drawDataRow(y, cells, txnW, txnAligns, i + 1, false);
            y += ROW_H;
        });

        // Totals row
        drawDataRow(y, ['', '', '', '', '', 'TOTALS:', fmtAmt(d.totalAmount), fmtAmt(d.lastBalance)], txnW, txnAligns, 99, true);
        y += ROW_H;

        // Net-summary lines (Balance / +Holdings / −Tax / =Net) — right-aligned key+value
        var summaryLines = [
            ['Balance (closing)',                  d.txnSectionNet.balance,       false],
            ['+ Value of Holdings',                 d.txnSectionNet.holdingsValue, false],
            ['− Potential Tax (' + taxRatePct + '%)', d.txnSectionNet.potentialTax, false],
            [(d.txnSectionNet.net < 0 ? '= Net Payable' : '= Net Receivable'), d.txnSectionNet.net, true]
        ];
        // Add a gap row
        y += 6;
        summaryLines.forEach(function(s) {
            ctx.font = s[2] ? FONT_BOLD : FONT;
            ctx.fillStyle = TEXT_DARK;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(s[0], W - PAD - 130, y + ROW_H / 2);
            ctx.fillText(fmtAmt(s[1]), W - PAD - 6, y + ROW_H / 2);
            y += ROW_H;
        });
        y += SECTION_GAP;
    }

    // ── Open Positions block ──
    if (flags.openPos && d.holdingRows.length > 0) {
        if (flags.txn) y += 0; // already added BLOCK_GAP via height calc; keep gap visual
        drawSectionTitle(y, 'OPEN POSITIONS');
        y += TITLE_H;
        var posHeaders = ['Symbol', 'Type', 'Qty', 'Avg Cost', 'CMP', 'MTM', 'Value'];
        var posAligns  = ['left',   'left', 'right','right',   'right','right','right'];
        var posW = [220, 70, 100, 110, 110, 120, 120];
        var sumP = posW.reduce(function(a, b) { return a + b; }, 0);
        var scaleP = (W - 2 * PAD) / sumP;
        posW = posW.map(function(w) { return w * scaleP; });

        drawHeaderRow(y, posHeaders, posW, posAligns);
        y += HEADER_H;

        d.holdingRows.forEach(function(r, i) {
            // Avg Cost + CMP are per-unit prices (full rupees). MTM + Value
            // follow the on-screen unit.
            var cells = [
                r[0] || '',
                r[1] || '',
                r[2] == null ? '' : fmtQty(r[2]),
                r[3] == null ? '' : fmtPrice(r[3]),
                r[4] == null ? '' : fmtPrice(r[4]),
                r[5] == null ? '' : fmtAmt(r[5]),
                r[6] == null ? '' : fmtAmt(r[6])
            ];
            drawDataRow(y, cells, posW, posAligns, i + 1, false);
            y += ROW_H;
        });
        drawDataRow(y, ['', '', '', '', '', fmtAmt(d.totalMtm), fmtAmt(d.totalValue)], posW, posAligns, 99, true);
        y += ROW_H;
        y += SECTION_GAP;
    }

    // ── Booked P&L block ──
    if (imgBookedShow) {
        drawSectionTitle(y, 'BOOKED P&L');
        y += TITLE_H;
        var bkHeaders = ['Symbol', 'Type', 'Qty', 'Gain / (Loss)'];
        var bkAligns  = ['left',   'left', 'right','right'];
        var bkW = [240, 100, 120, 200];
        var sumB = bkW.reduce(function(a, b) { return a + b; }, 0);
        var scaleB = (W - 2 * PAD) / sumB;
        bkW = bkW.map(function(w) { return w * scaleB; });

        drawHeaderRow(y, bkHeaders, bkW, bkAligns);
        y += HEADER_H;

        // Starting Booked P&L (pre-recon) — one line above the since-recon rows.
        if (d.bookedSplit) {
            var imgStartLabel = 'Starting Booked P&L' + (d.bookedReconDate ? ' (as on ' + (fmtDate(d.bookedReconDate) || d.bookedReconDate) + ')' : '');
            drawDataRow(y, [imgStartLabel, '', '', fmtAmt(d.bookedStarting)], bkW, bkAligns, 0, false);
            y += ROW_H;
        }

        d.bookedRows.forEach(function(r, i) {
            var cells = [
                r[0] || '',
                r[1] || '',
                r[2] == null ? '' : fmtQty(r[2]),
                r[3] == null ? '' : fmtAmt(r[3])
            ];
            drawDataRow(y, cells, bkW, bkAligns, i + 1, false);
            y += ROW_H;
        });

        // New Booked P&L subtotal (since recon), then the FY Total.
        if (d.bookedSplit) {
            drawDataRow(y, ['New Booked P&L (since recon)', '', '', fmtAmt(d.bookedNew)], bkW, bkAligns, 99, true);
            y += ROW_H;
        }
        var imgTotalCells = d.bookedSplit
            ? ['Total Booked P&L (' + d.fyLabel + ')', '', '', fmtAmt(d.totalBookedGain)]
            : ['', '', 'TOTAL:', fmtAmt(d.totalBookedGain)];
        drawDataRow(y, imgTotalCells, bkW, bkAligns, 99, true);
        y += ROW_H;
    }

    // Deliver the rendered canvas — either to clipboard (with download
    // fallback) or as a direct download to the user's Downloads folder.
    //
    // A4 PORTRAIT FIT: the canvas is W=1200 px wide. Word / Pages / Preview
    // default to 96 DPI when no metadata is present → 1200 px ≈ 12.5", which
    // overflows A4 portrait (8.27"). Inject a pHYs chunk declaring 150 DPI so
    // 1200 px resolves to exactly 8" wide — fits inside A4 portrait with room
    // to spare. The visible pixel sharpness is unchanged (DPR=2 → 2400 px
    // internal raster). User concern, 2026-05-27.
    var filename = wmsExportFilename('Statement', d.viewName, d.dateLabel, 'png');
    canvas.toBlob(async function(blobRaw) {
        if (!blobRaw) {
            if (typeof showAlert === 'function') showAlert('Failed to render image', 'error', 3000);
            return;
        }
        // A4-fit DPI tag — non-fatal if helper missing (graceful degrade).
        var blob = blobRaw;
        try {
            if (typeof wmsAddPngDpi === 'function') blob = await wmsAddPngDpi(blobRaw, 150);
        } catch (err) {
            console.warn('wmsAddPngDpi failed, using untagged PNG —', err && err.message);
        }

        function downloadFile(msg) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function() { URL.revokeObjectURL(url); }, 1500);
            if (typeof showAlert === 'function' && msg) showAlert(msg, 'info', 4500);
        }

        if (mode === 'download') {
            downloadFile('Image saved as ' + filename);
            return;
        }

        // mode === 'copy' — try clipboard first, fall back to download.
        var clipboardOk = false;
        try {
            if (navigator.clipboard && window.ClipboardItem) {
                await navigator.clipboard.write([
                    new ClipboardItem({ 'image/png': blob })
                ]);
                clipboardOk = true;
            }
        } catch (err) {
            console.warn('Clipboard write failed, falling back to download:', err && err.message);
        }
        if (clipboardOk) {
            if (typeof showAlert === 'function') showAlert('Statement image copied to clipboard — paste it into your chat', 'success', 4000);
            return;
        }
        downloadFile('Image downloaded as ' + filename + ' (clipboard write was blocked)');
    }, 'image/png');
}

// ============================================================================
// EXPORT MODAL — single button → modal with date range + section + format
// pickers. Replaces the legacy 2-item dropdown (LESSONS §E.18.1).
// ============================================================================

// Open the modal and seed defaults: Current FY date range, all sections on,
// F&O on, dates auto-filled to current-FY bounds.
function lgExportOpen() {
    var modal = document.getElementById('lgExportModal');
    if (!modal) return;
    // Reset defaults — Current FY + all sections + F&O on
    var d = document.getElementById('lgExpDateRangeCurrentFY');
    if (d) d.checked = true;
    var fno = document.getElementById('lgExpShowFno');
    if (fno) fno.checked = true;
    var t = document.getElementById('lgExpSecTxn');
    if (t) t.checked = true;
    var p = document.getElementById('lgExpSecOpenPos');
    if (p) p.checked = true;
    var b = document.getElementById('lgExpSecBookedPL');
    if (b) b.checked = true;
    lgExportSyncDates();
    lgShowModal('lgExportModal');
}

// Wire-up: when the date-range radio changes, re-fill From/To unless Custom.
// "Since last recon": latest RECONCILIATION row's entry_date + 1 → today.
function lgExportSyncDates() {
    var checked = document.querySelector('input[name="lgExpDateRange"]:checked');
    if (!checked) return;
    var preset = checked.value;
    var fromEl = document.getElementById('lgExpDateFrom');
    var toEl   = document.getElementById('lgExpDateTo');
    if (!fromEl || !toEl) return;

    // Custom — leave fields untouched, just enable them.
    fromEl.disabled = (preset !== 'custom');
    toEl.disabled   = (preset !== 'custom');
    if (preset === 'custom') {
        // Seed with the on-screen range if empty
        if (!fromEl.value) fromEl.value = lgDateFrom || '';
        if (!toEl.value)   toEl.value   = lgDateTo   || '';
        return;
    }

    var today = new Date();
    var curY = today.getFullYear();
    var curM = today.getMonth() + 1;
    var fyStartY = (curM >= 4) ? curY : curY - 1;

    if (preset === 'currentFY') {
        fromEl.value = fyStartY + '-04-01';
        toEl.value   = (fyStartY + 1) + '-03-31';
    } else if (preset === 'previousFY') {
        fromEl.value = (fyStartY - 1) + '-04-01';
        toEl.value   = fyStartY + '-03-31';
    } else if (preset === 'sinceRecon') {
        var latestRecon = null;
        (lgFullCombined || []).forEach(function(r) {
            if (r._rowType === 'ledger' && r.entryType === 'RECONCILIATION') {
                if (!latestRecon || (r.date || '') > (latestRecon.date || '')) latestRecon = r;
            }
        });
        if (latestRecon) {
            // From = the day AFTER the recon date (the recon itself is the OB anchor)
            var d = new Date(latestRecon.date);
            d.setDate(d.getDate() + 1);
            fromEl.value = d.toISOString().slice(0, 10);
        } else {
            fromEl.value = fyStartY + '-04-01';
            if (typeof showAlert === 'function') {
                showAlert('No reconciliation found in this view — defaulting From to FY start', 'info', 3500);
            }
        }
        toEl.value = today.toISOString().slice(0, 10);
    }
}

// Orchestrator — read modal state, gather data, dispatch to format renderer.
function lgExportRun(format) {
    var fromEl = document.getElementById('lgExpDateFrom');
    var toEl   = document.getElementById('lgExpDateTo');
    var dateFrom = fromEl ? fromEl.value : '';
    var dateTo   = toEl   ? toEl.value   : '';
    var includeFutures = !!(document.getElementById('lgExpShowFno') || {}).checked;
    var includeTxn     = !!(document.getElementById('lgExpSecTxn') || {}).checked;
    var includeOpenPos = !!(document.getElementById('lgExpSecOpenPos') || {}).checked;
    var includeBooked  = !!(document.getElementById('lgExpSecBookedPL') || {}).checked;

    if (!includeTxn && !includeOpenPos && !includeBooked) {
        if (typeof showAlert === 'function') {
            showAlert('Tick at least one section (Transactions, Open Positions, or Booked P&L)', 'warning', 3500);
        }
        return;
    }
    if (dateFrom && dateTo && dateFrom > dateTo) {
        if (typeof showAlert === 'function') showAlert('From date is after To date', 'warning', 3000);
        return;
    }

    var data = lgGatherExportData({
        dateFrom: dateFrom || undefined,
        dateTo:   dateTo   || undefined,
        includeFutures: includeFutures
    });

    // Stash section flags on the data object so the renderers know what to emit.
    data.sectionFlags = {
        txn:     includeTxn,
        openPos: includeOpenPos,
        booked:  includeBooked
    };
    // Computed total when Transactions is shown: Balance + Holdings - Tax = Net.
    // Balance already in counterparty-POV. Holdings + (-Tax) gives Net.
    data.txnSectionNet = {
        balance:      data.lastBalance,
        holdingsValue: data.holdingsValue,
        potentialTax: data.potentialTax,
        net:          data.lastBalance + data.holdingsValue - data.potentialTax
    };

    if (format === 'pdf')   { lgExportPdf(data);   }
    else if (format === 'excel') { lgExportExcel(data); }
    else if (format === 'image_copy')     { lgExportImage(data, 'copy'); }
    else if (format === 'image_download') { lgExportImage(data, 'download'); }
    else if (format === 'image')          { lgExportImage(data, 'copy'); }  // legacy alias

    var modal = document.getElementById('lgExportModal');
    if (modal) modal.classList.remove('show');
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
window.lgApplyView = function(viewId) { lgVM.applyView(viewId); };
window.lgLoadViews = function() { lgVM.loadViews(); };
window.lgSaveOpeningBalance = lgSaveOpeningBalance;
window.lgCancelObEdit = lgCancelObEdit;
