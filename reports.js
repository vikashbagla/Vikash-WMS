// ============================================================================
// WMS REPORTS MODULE
// Portfolio (FIFO, grouped by asset class, no F&O) + Capital Gains
// Rule: use `var` for all declarations (Rule A.1.2 — avoid TDZ on script reload).
// ============================================================================

// ============================================================================
// STATE
// ============================================================================

var rptTransactions = [];    // all BUY/SELL txns (sorted by date asc)
var rptInvestors = [];
var rptBrokers = [];
var rptLivePrices = {};      // { fyersKey: price }
var rptLiveData = {};        // { fyersKey: { lp, ch, chp, high, low } }

// Portfolio tab filters
var rptSelectedInvestorIds = [];
var rptSelectedBrokerIds = [];
var rptSelectedTagNames = [];
var rptTagFilterLogic = 'OR';
var rptShowZero = false;
var rptSortColumn = 'symbol';
var rptSortDirection = 'asc';
var rptSortByPct = false;
var rptExpandedSymbol = null;
var rptCollapsedGroups = {};  // { 'Indian Equity': true } — collapsed groups

// Pill filter controller refs (wmsPillSearch instances)
var rptInvPillFilter = null;
var rptBrkPillFilter = null;
var rptTagPillFilter = null;

// Symbol search (double-click header to filter)
var rptSymbolSearchText = '';

// ---- Portfolio View Manager (wmsViewManager instance) ----
var rptPortfolioVM = wmsViewManager({
    module: 'reports_portfolio',
    label: 'Rpt Portfolio',
    ids: {
        viewTabs: 'rpt-view-tabs',
        moreList: 'rpt-more-list',
        moreDropdown: 'rpt-more-dropdown',
        updateBtn: 'rpt-update-view-btn'
    },
    autoDefaultFirst: true,
    getPills: function() {
        return [
            { pill: rptInvPillFilter, type: 'investor' },
            { pill: rptBrkPillFilter, type: 'broker' },
            { pill: rptTagPillFilter, type: 'tag' }
        ];
    },
    getFilters: function() {
        return {
            investorIds: rptSelectedInvestorIds.slice(),
            brokerIds: rptSelectedBrokerIds.slice(),
            tagNames: rptSelectedTagNames.slice(),
            tagLogic: rptTagFilterLogic
        };
    },
    applyFilters: function(f) {
        rptSelectedInvestorIds.length = 0;
        Array.prototype.push.apply(rptSelectedInvestorIds, f.investorIds || []);
        rptSelectedBrokerIds.length = 0;
        Array.prototype.push.apply(rptSelectedBrokerIds, f.brokerIds || []);
        rptSelectedTagNames.length = 0;
        Array.prototype.push.apply(rptSelectedTagNames, f.tagNames || []);
        rptTagFilterLogic = f.tagLogic || 'OR';

        // Sync pill UI
        var pills = [rptInvPillFilter, rptBrkPillFilter, rptTagPillFilter];
        pills.forEach(function(p) { if (p && p.syncStates) p.syncStates(); });

        // Update tag logic radio
        document.querySelectorAll('input[name="rpt-tag-logic"]').forEach(function(r) {
            r.checked = r.value === rptTagFilterLogic;
        });
    },
    onRefresh: function() { rptRenderPortfolio(); }
});

// Asset-class badge labels
var RPT_AC_BADGE = {
    'Indian Equity': 'EQ',
    'ETF': 'ETF',
    'Mutual Fund': 'MF',
    'Debt': 'DEBT',
    'Gold': 'GOLD',
    'Real Estate': 'REIT',
    'Infrastructure': 'INVIT',
    'Other': '—'
};

// Capital Gains tab filters
var rptCGSelectedInvestorIds = [];
var rptCGSelectedBrokerIds = [];
var rptCGInvPillFilter = null;   // wmsPillSearch instance
var rptCGBrkPillFilter = null;   // wmsPillSearch instance
var rptCGSelectedTagNames = [];
var rptCGTagFilterLogic = 'OR';
var rptCGTagPillFilter = null;   // wmsPillSearch instance

// ---- Capital Gains View Manager (wmsViewManager instance — same as Portfolio) ----
var rptCGVM = wmsViewManager({
    module: 'reports_capgains',
    label: 'Rpt CapGains',
    ids: {
        viewTabs: 'rpt-cg-view-tabs',
        moreList: 'rpt-cg-more-list',
        moreDropdown: 'rpt-cg-more-dropdown',
        updateBtn: 'rpt-cg-update-view-btn'
    },
    autoDefaultFirst: true,
    getPills: function() {
        return [
            { pill: rptCGInvPillFilter, type: 'investor' },
            { pill: rptCGBrkPillFilter, type: 'broker' },
            { pill: rptCGTagPillFilter, type: 'tag' }
        ];
    },
    getFilters: function() {
        return {
            investorIds: rptCGSelectedInvestorIds.slice(),
            brokerIds: rptCGSelectedBrokerIds.slice(),
            tagNames: rptCGSelectedTagNames.slice(),
            tagLogic: rptCGTagFilterLogic
        };
    },
    applyFilters: function(f) {
        rptCGSelectedInvestorIds.length = 0;
        Array.prototype.push.apply(rptCGSelectedInvestorIds, f.investorIds || []);
        rptCGSelectedBrokerIds.length = 0;
        Array.prototype.push.apply(rptCGSelectedBrokerIds, f.brokerIds || []);
        rptCGSelectedTagNames.length = 0;
        Array.prototype.push.apply(rptCGSelectedTagNames, f.tagNames || []);
        rptCGTagFilterLogic = f.tagLogic || 'OR';

        // Sync pill UI
        var pills = [rptCGInvPillFilter, rptCGBrkPillFilter, rptCGTagPillFilter];
        pills.forEach(function(p) { if (p && p.syncStates) p.syncStates(); });

        // Update tag logic radio
        document.querySelectorAll('input[name="rpt-cg-tag-logic"]').forEach(function(r) {
            r.checked = r.value === rptCGTagFilterLogic;
        });
    },
    onRefresh: function() { rptRenderCapGains(); }
});

// ============================================================================
// ASSET CLASS MAPPING
// ============================================================================

var RPT_ASSET_CLASS_ORDER = [
    'Indian Equity', 'ETF', 'Mutual Fund', 'Debt', 'Gold',
    'Real Estate', 'Infrastructure', 'Other'
];

function rptGetAssetClass(securityType) {
    if (!securityType) return 'Indian Equity';
    var map = {
        'EQUITY':     'Indian Equity',
        'EQUITY_SME': 'Indian Equity',
        'PREF_SHARE': 'Indian Equity',
        'RIGHTS':     'Indian Equity',
        'ETF':        'ETF',
        'MF':         'Mutual Fund',
        'NCD':        'Debt',
        'GOVT_BOND':  'Debt',
        'SGB':        'Gold',
        'INVIT':      'Infrastructure',
        'REIT':       'Real Estate'
    };
    return map[securityType] || 'Other';
}

// ============================================================================
// FIFO ENGINE WRAPPER
// Calls the shared wmsCalcFifoCost engine (wms-shared.js) and enriches
// holdings with reports-specific fields: assetClass, fifoCost, latestPrice, _txns.
// ============================================================================

function rptFifoEngine(txns) {
    // The shared engine accepts both snake_case and camelCase fields
    var result = wmsCalcFifoCost(txns);
    var holdings = result.holdings;

    // Enrich holdings with reports-specific properties
    var keys = Object.keys(holdings);
    for (var k = 0; k < keys.length; k++) {
        var h = holdings[keys[k]];
        h.assetClass = rptGetAssetClass(h.securityType);
        h.fifoCost = h.avgCost;
        h.latestPrice = 0;
        h._txns = [];
    }

    // Attach latestPrice (from last txn for each symbol) and _txns.
    // Engine grouping (J.2 updated): EQ → short_symbol, NFO → full symbol.
    for (var n = 0; n < rptTransactions.length; n++) {
        var tx = rptTransactions[n];
        var hKey = (tx.securityType === 'NFO')
            ? (tx.symbol || '')
            : (tx.shortSymbol || tx.symbol || '');
        if (holdings[hKey]) {
            holdings[hKey]._txns.push(tx);
            holdings[hKey].latestPrice = tx.price;
        }
    }

    return { holdings: holdings, gains: result.gains };
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initReports() {
    showLoading(true);
    try {
        await rptLoadData();
    } catch (error) {
        console.error('❌ Error loading reports data:', error);
        showAlert('Failed to load reports data: ' + error.message, 'error');
        showLoading(false);
        return;
    }

    // Live prices — build symbol list then use shared refresh system
    if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
    if (typeof wmsStandardRefresh === 'function') {
        await wmsStandardRefresh(false);
    }
    await rptFetchLivePrices();

    rptUpdateUnitLabels();
    rptSetupTabs();
    rptInitPillFilters();
    rptInitViewBar();
    rptInitFYSelector();
    rptInitCGFilters();
    rptInitCGViewBar();
    await rptPortfolioVM.loadViews();
    await rptCGVM.loadViews();
    // If no default view applied, render now
    if (!rptPortfolioVM.activeViewId) rptRenderPortfolio();
    if (!rptCGVM.activeViewId) rptRenderCapGains();
    showLoading(false);
}

async function rptRefresh() {
    showLoading(true);
    try {
        await rptLoadData();
    } catch (error) {
        showAlert('Failed to refresh data: ' + error.message, 'error');
        showLoading(false);
        return;
    }
    if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
    if (typeof wmsStandardRefresh === 'function') {
        await wmsStandardRefresh(true);
    }
    await rptFetchLivePrices();
    rptRenderPortfolio();
    rptRenderCapGains();
    showLoading(false);
    showAlert('Reports refreshed', 'success', 2000);
}

function rptUpdateUnitLabels() {
    var el = document.getElementById('rpt-unit-desc');
    if (el) el.textContent = 'all amounts in ' + getUnitDescription();
}

// ============================================================================
// DATA LOADING
// ============================================================================

async function rptLoadData() {
    // Load ALL transaction types — the FIFO engine handles each type correctly:
    // BUY/SELL (lots), BONUS/SPLIT/RIGHTS (qty & cost adjustments),
    // CAPITAL_REDUCTION (cost reduction), DIVIDEND/INTEREST/OTHER_INCOME (skipped by FIFO),
    // HISTORICAL_PL (skipped by FIFO). No query-level filtering needed.
    // Uses wmsFetchAllRaw() to paginate past Supabase's 1000-row default limit.
    var txnData = await wmsFetchAllRaw(
        SUPABASE_URL + '/rest/v1/transactions?select=id,investor_id,broker_id,security_id,symbol,short_symbol,company_name,exchange,security_type,transaction_type,transaction_date,transaction_time,quantity,price,gross_amount,net_amount,stt,tags,dont_display&dont_display=eq.false&order=transaction_date.asc,transaction_time.asc.nullsfirst,id.asc'
    );

    console.log('✅ Reports: loaded ' + txnData.length + ' transactions');

    rptTransactions = txnData.map(function(txn) {
        return {
            id: txn.id,
            investorId: txn.investor_id,
            brokerId: txn.broker_id,
            securityId: txn.security_id,
            symbol: txn.symbol,
            shortSymbol: txn.short_symbol,
            companyName: txn.company_name,
            exchange: txn.exchange,
            securityType: txn.security_type || 'EQUITY',
            type: txn.transaction_type,
            date: txn.transaction_date,
            quantity: txn.quantity,
            price: txn.price,
            grossAmount: txn.gross_amount,
            netAmount: txn.net_amount,
            stt: txn.stt,
            tags: txn.tags || []
        };
    });

    // Use shared reference data
    if (!wmsRefData.ready) await wmsLoadRefData();
    rptInvestors = wmsRefData.investors;
    rptBrokers = wmsRefData.brokers;
}

// ============================================================================
// LIVE PRICES
// ============================================================================

function rptGetLiveData(holding) {
    var sym = holding.shortSymbol || holding.symbol;
    // Check shared global cache first (populated by wmsStandardRefresh)
    var cached = wmsLivePrices[sym];
    if (cached && cached.lp > 0) return cached;
    // Fallback: module-level cache (old Fyers key format)
    var exch = (holding.exchange || 'NSE').toUpperCase();
    var key = exch === 'NFO'
        ? 'NSE:' + holding.symbol
        : exch + ':' + sym + '-EQ';
    return rptLiveData[key] || null;
}

function rptGetPrice(holding) {
    var sym = holding.shortSymbol || holding.symbol;
    // Check shared global cache first (populated by wmsStandardRefresh)
    var cached = wmsLivePrices[sym];
    if (cached && cached.lp > 0) return cached.lp;
    // Fallback: module-level cache (old Fyers key format)
    var exch = (holding.exchange || 'NSE').toUpperCase();
    var key = exch === 'NFO'
        ? 'NSE:' + holding.symbol
        : exch + ':' + sym + '-EQ';
    return rptLivePrices[key] || holding.fifoCost || holding.latestPrice;
}

async function rptFetchLivePrices() {
    try {
        if (!window.fyersToken) {
            rptUpdatePriceStatus('last-txn');
            return;
        }

        // Get current holdings (non-F&O only)
        var filtered = rptFilterTransactions(rptTransactions);
        filtered = filtered.filter(function(t) { return t.securityType !== 'NFO' && t.securityType !== 'MCX'; });
        var fifo = rptFifoEngine(filtered);
        var holdArr = Object.values(fifo.holdings).filter(function(h) { return h.quantity !== 0; });
        if (holdArr.length === 0) return;

        var symbols = holdArr.map(function(h) {
            var exch = (h.exchange || 'NSE').toUpperCase();
            return exch + ':' + (h.shortSymbol || h.symbol) + '-EQ';
        });

        rptUpdatePriceStatus('loading');
        var data = await window.fyersCall({ action: 'quotes', symbols: symbols });

        if (data && data.d && data.d.length > 0) {
            data.d.forEach(function(item) {
                if (item.v && item.v.symbol) {
                    var key = item.v.symbol;
                    rptLivePrices[key] = item.v.lp || 0;
                    rptLiveData[key] = {
                        lp: item.v.lp || 0,
                        ch: item.v.ch || 0,
                        chp: item.v.chp || 0,
                        high: item.v.high_price || null,
                        low: item.v.low_price || null
                    };
                }
            });
            rptUpdatePriceStatus('live');
        } else {
            rptUpdatePriceStatus('last-txn');
        }
    } catch (err) {
        console.warn('⚠️ Reports price fetch failed:', err.message || err);
        rptUpdatePriceStatus('last-txn');
    }
}

function rptUpdatePriceStatus(status) {
    var el = document.getElementById('rpt-price-status');
    if (!el) return;
    var now = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    if (status === 'live') {
        el.innerHTML = '🟢 Live prices as of ' + now;
        el.style.color = '#059669';
    } else if (status === 'loading') {
        el.innerHTML = '⏳ Fetching live prices...';
        el.style.color = '#667eea';
    } else if (status === 'last-txn') {
        el.innerHTML = '🟡 Showing last transaction prices';
        el.style.color = '#d97706';
    }
}

// ============================================================================
// TAB SWITCHING
// ============================================================================

function rptSetupTabs() {
    var tabBtns = document.querySelectorAll('#rptTabs .reports-tab-btn');
    tabBtns.forEach(function(btn) {
        btn.addEventListener('click', function() {
            tabBtns.forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            var tabId = btn.dataset.tab;
            document.querySelectorAll('.reports-tab-content').forEach(function(tc) {
                tc.classList.remove('active');
            });
            var target = document.getElementById(tabId);
            if (target) target.classList.add('active');
            // Render the active tab if needed
            if (tabId === 'rpt-capgains') rptRenderCapGains();
        });
    });
}

// ============================================================================
// FILTER SYSTEM (Portfolio tab)
// ============================================================================

function rptInitPillFilters() {
    // Investor pills
    var invContainer = document.getElementById('rpt-filter-investor');
    if (invContainer) {
        var invItems = rptInvestors.map(function(inv) {
            return { id: String(inv.id), label: inv.short_name || inv.name, searchText: (inv.name || '') + ' ' + (inv.short_name || '') };
        });
        rptInvPillFilter = wmsPillSearch(invContainer, {
            label: 'Investor',
            placeholder: 'Search investors...',
            items: invItems,
            selectedIds: rptSelectedInvestorIds,
            onChange: rptRenderPortfolio
        });
    }
    // Broker pills
    var brkContainer = document.getElementById('rpt-filter-broker');
    if (brkContainer) {
        var brkItems = rptBrokers.map(function(b) {
            return { id: String(b.id), label: b.broker_code || b.name, searchText: (b.name || '') + ' ' + (b.broker_code || '') };
        });
        rptBrkPillFilter = wmsPillSearch(brkContainer, {
            label: 'Broker',
            placeholder: 'Search brokers...',
            items: brkItems,
            selectedIds: rptSelectedBrokerIds,
            onChange: rptRenderPortfolio
        });
    }
    // Tag pills (with Any/All radio)
    var tagContainer = document.getElementById('rpt-filter-tag');
    if (tagContainer) {
        var allTags = {};
        rptTransactions.forEach(function(t) { if (t.tags) t.tags.forEach(function(tg) { allTags[tg] = true; }); });
        var tagItems = Object.keys(allTags).sort().map(function(tag) {
            return { id: tag, label: tag, searchText: tag };
        });
        var tagExtra = document.createElement('div');
        tagExtra.className = 'tag-match-options';
        tagExtra.innerHTML =
            '<span style="font-size:11px;color:#718096;">Match:</span>' +
            '<label class="radio-label"><input type="radio" name="rpt-tag-logic" value="OR" checked> <span>Any</span></label>' +
            '<label class="radio-label"><input type="radio" name="rpt-tag-logic" value="AND"> <span>All</span></label>';
        rptTagPillFilter = wmsPillSearch(tagContainer, {
            label: 'Tag',
            placeholder: 'Search tags...',
            items: tagItems,
            selectedIds: rptSelectedTagNames,
            onChange: rptRenderPortfolio,
            headerExtra: tagExtra
        });
        // Listen for tag logic change
        tagExtra.addEventListener('change', function(e) {
            if (e.target.name === 'rpt-tag-logic') {
                rptTagFilterLogic = e.target.value;
                rptRenderPortfolio();
            }
        });
    }
}

// ============================================================================
// VIEW BAR — wire buttons for saved views (shared wmsViewManager)
// ============================================================================

function rptInitViewBar() {
    // "+" New blank view
    var newBtn = document.getElementById('rpt-new-view-btn');
    if (newBtn) {
        newBtn.addEventListener('click', function() {
            rptPortfolioVM.activeViewId = null;
            rptPortfolioVM.renderViewTabs();
            rptPortfolioVM.updateViewButtons();
        });
    }

    // "▾ More" dropdown toggle
    var moreBtn = document.getElementById('rpt-more-btn');
    if (moreBtn) {
        moreBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            var dd = document.getElementById('rpt-more-dropdown');
            dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
        });
    }

    // "↻ Update" current view
    var updateBtn = document.getElementById('rpt-update-view-btn');
    if (updateBtn) {
        updateBtn.addEventListener('click', function() {
            rptPortfolioVM.updateCurrentView();
        });
    }

    // "+ Save New" / inline prompt
    var saveNewBtn = document.getElementById('rpt-save-new-btn');
    var savePrompt = document.getElementById('rpt-save-prompt');
    var savePromptName = document.getElementById('rpt-save-prompt-name');
    if (saveNewBtn && savePrompt) {
        saveNewBtn.addEventListener('click', function() {
            savePrompt.classList.add('show');
            saveNewBtn.style.display = 'none';
            savePromptName.value = '';
            savePromptName.focus();
        });
        document.getElementById('rpt-save-prompt-ok').addEventListener('click', function() {
            var name = savePromptName.value.trim();
            if (name) rptPortfolioVM.saveCurrentView(name);
            savePrompt.classList.remove('show');
            saveNewBtn.style.display = '';
        });
        document.getElementById('rpt-save-prompt-cancel').addEventListener('click', function() {
            savePrompt.classList.remove('show');
            saveNewBtn.style.display = '';
        });
        savePromptName.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                var name = savePromptName.value.trim();
                if (name) rptPortfolioVM.saveCurrentView(name);
                savePrompt.classList.remove('show');
                saveNewBtn.style.display = '';
            } else if (e.key === 'Escape') {
                savePrompt.classList.remove('show');
                saveNewBtn.style.display = '';
            }
        });
    }

    // "▲" Filters toggle
    var filtersToggle = document.getElementById('rpt-filters-toggle');
    var filtersDiv = document.getElementById('rptPortfolioFilters');
    if (filtersToggle && filtersDiv) {
        filtersToggle.addEventListener('click', function() {
            var isHidden = filtersDiv.style.display === 'none';
            filtersDiv.style.display = isHidden ? 'flex' : 'none';
            filtersToggle.textContent = isHidden ? '▲' : '▼';
        });
    }

    // Close More dropdown on outside click
    document.addEventListener('click', function(e) {
        if (!e.target.closest('#rpt-more-btn') && !e.target.closest('#rpt-more-dropdown')) {
            var mdd = document.getElementById('rpt-more-dropdown');
            if (mdd) mdd.style.display = 'none';
        }
    });
}

// View bar for the Capital Gains tab (mirrors rptInitViewBar, using rptCGVM)
function rptInitCGViewBar() {
    var newBtn = document.getElementById('rpt-cg-new-view-btn');
    if (newBtn) {
        newBtn.addEventListener('click', function() {
            rptCGVM.activeViewId = null;
            rptCGVM.renderViewTabs();
            rptCGVM.updateViewButtons();
        });
    }
    var moreBtn = document.getElementById('rpt-cg-more-btn');
    if (moreBtn) {
        moreBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            var dd = document.getElementById('rpt-cg-more-dropdown');
            dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
        });
    }
    var updateBtn = document.getElementById('rpt-cg-update-view-btn');
    if (updateBtn) {
        updateBtn.addEventListener('click', function() { rptCGVM.updateCurrentView(); });
    }
    var saveNewBtn = document.getElementById('rpt-cg-save-new-btn');
    var savePrompt = document.getElementById('rpt-cg-save-prompt');
    var savePromptName = document.getElementById('rpt-cg-save-prompt-name');
    if (saveNewBtn && savePrompt) {
        saveNewBtn.addEventListener('click', function() {
            savePrompt.classList.add('show');
            saveNewBtn.style.display = 'none';
            savePromptName.value = '';
            savePromptName.focus();
        });
        document.getElementById('rpt-cg-save-prompt-ok').addEventListener('click', function() {
            var name = savePromptName.value.trim();
            if (name) rptCGVM.saveCurrentView(name);
            savePrompt.classList.remove('show');
            saveNewBtn.style.display = '';
        });
        document.getElementById('rpt-cg-save-prompt-cancel').addEventListener('click', function() {
            savePrompt.classList.remove('show');
            saveNewBtn.style.display = '';
        });
        savePromptName.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                var name = savePromptName.value.trim();
                if (name) rptCGVM.saveCurrentView(name);
                savePrompt.classList.remove('show');
                saveNewBtn.style.display = '';
            } else if (e.key === 'Escape') {
                savePrompt.classList.remove('show');
                saveNewBtn.style.display = '';
            }
        });
    }
    var filtersToggle = document.getElementById('rpt-cg-filters-toggle');
    var filtersDiv = document.getElementById('rptCGFilters');
    if (filtersToggle && filtersDiv) {
        filtersToggle.addEventListener('click', function() {
            var isHidden = filtersDiv.style.display === 'none';
            filtersDiv.style.display = isHidden ? 'flex' : 'none';
            filtersToggle.textContent = isHidden ? '▲' : '▼';
        });
    }
    document.addEventListener('click', function(e) {
        if (!e.target.closest('#rpt-cg-more-btn') && !e.target.closest('#rpt-cg-more-dropdown')) {
            var mdd = document.getElementById('rpt-cg-more-dropdown');
            if (mdd) mdd.style.display = 'none';
        }
    });
}

// ============================================================================
// SYMBOL COLUMN INLINE SEARCH (double-click header)
// ============================================================================

function rptOpenSymbolSearch() {
    var th = document.getElementById('rpt-th-symbol');
    if (!th || document.getElementById('rpt-symbol-search-input')) return;

    th.dataset.originalHtml = th.innerHTML;
    th.innerHTML = '<input type="text" id="rpt-symbol-search-input" placeholder="Search symbol..." ' +
        'style="width:90%; padding:3px 6px; border:1px solid #667eea; border-radius:4px; font-size:12px; outline:none;">';

    var input = document.getElementById('rpt-symbol-search-input');
    input.focus();
    if (rptSymbolSearchText) input.value = rptSymbolSearchText;

    input.addEventListener('input', function() {
        rptSymbolSearchText = input.value;
        rptRenderPortfolio();
    });
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') rptCloseSymbolSearch();
        else if (e.key === 'Enter') rptCloseSymbolSearch(true);
        e.stopPropagation();
    });
    input.addEventListener('click', function(e) { e.stopPropagation(); });
}

function rptCloseSymbolSearch(keepFilter) {
    var th = document.getElementById('rpt-th-symbol');
    if (!th) return;
    if (!keepFilter) {
        rptSymbolSearchText = '';
        rptRenderPortfolio();
    }
    // Restore header — will be rebuilt on next render anyway
    rptRenderPortfolio();
}

function rptToggleZero() {
    rptShowZero = !rptShowZero;
    var btn = document.getElementById('rptToggleZeroBtn');
    if (btn) {
        btn.textContent = rptShowZero ? '👁 Hide Zero' : '👁 Show Zero';
        btn.classList.toggle('active', rptShowZero);
    }
    rptRenderPortfolio();
}

function rptToggleGroup(acName) {
    rptCollapsedGroups[acName] = !rptCollapsedGroups[acName];
    // Toggle visibility of rows belonging to this group
    var rows = document.querySelectorAll('tr[data-rpt-group="' + acName + '"]');
    var hidden = rptCollapsedGroups[acName];
    rows.forEach(function(row) { row.style.display = hidden ? 'none' : ''; });
    // Update chevron
    var chevron = document.getElementById('rpt-chevron-' + acName.replace(/\s+/g, '-'));
    if (chevron) chevron.textContent = hidden ? '▸' : '▾';
    // Update header toggle icon
    rptUpdateHeaderToggle();
}

function rptToggleAllGroups() {
    // If any group is expanded, collapse all; otherwise expand all
    var anyExpanded = false;
    RPT_ASSET_CLASS_ORDER.forEach(function(ac) {
        if (!rptCollapsedGroups[ac]) anyExpanded = true;
    });
    var collapse = anyExpanded;
    RPT_ASSET_CLASS_ORDER.forEach(function(ac) {
        rptCollapsedGroups[ac] = collapse;
        var rows = document.querySelectorAll('tr[data-rpt-group="' + ac + '"]');
        rows.forEach(function(row) { row.style.display = collapse ? 'none' : ''; });
        var chevron = document.getElementById('rpt-chevron-' + ac.replace(/\s+/g, '-'));
        if (chevron) chevron.textContent = collapse ? '▸' : '▾';
    });
    rptUpdateHeaderToggle();
}

function rptUpdateHeaderToggle() {
    var icon = document.getElementById('rpt-header-toggle');
    if (!icon) return;
    var anyExpanded = false;
    RPT_ASSET_CLASS_ORDER.forEach(function(ac) {
        if (!rptCollapsedGroups[ac]) anyExpanded = true;
    });
    icon.textContent = anyExpanded ? '▾' : '▸';
}

// Apply filters to transaction array
function rptFilterTransactions(txns) {
    var filtered = txns;
    if (rptSelectedInvestorIds.length > 0) {
        filtered = filtered.filter(function(t) { return rptSelectedInvestorIds.indexOf(t.investorId) >= 0; });
    }
    if (rptSelectedBrokerIds.length > 0) {
        filtered = filtered.filter(function(t) { return t.brokerId && rptSelectedBrokerIds.indexOf(t.brokerId) >= 0; });
    }
    if (rptSelectedTagNames.length > 0) {
        if (rptTagFilterLogic === 'AND') {
            filtered = filtered.filter(function(t) {
                return rptSelectedTagNames.every(function(tag) { return t.tags.indexOf(tag) >= 0; });
            });
        } else {
            filtered = filtered.filter(function(t) {
                return t.tags.some(function(tag) { return rptSelectedTagNames.indexOf(tag) >= 0; });
            });
        }
    }
    return filtered;
}

// ============================================================================
// HELPERS — investor name, action menus, cross-module navigation
// ============================================================================

function rptInvName(investorId) {
    var inv = rptInvestors.find(function(i) { return i.id === investorId; });
    return inv ? (inv.short_name || inv.name) : 'Unknown';
}

var rptOpenActionMenu = null;

function rptToggleActionMenu(menuId) {
    var menu = document.getElementById(menuId);
    if (!menu) return;
    var wasOpen = menu.classList.contains('show');
    rptCloseAllActionMenus();
    if (!wasOpen) {
        menu.classList.add('show');
        rptOpenActionMenu = menuId;
    }
}

function rptCloseAllActionMenus() {
    document.querySelectorAll('.action-menu.show').forEach(function(m) { m.classList.remove('show'); });
    rptOpenActionMenu = null;
}

// Open shared transaction modal for a symbol (stays in Reports)
async function rptShowTransactions(shortSymbol, investorId) {
    // Fetch ALL transactions for this symbol (full fields for edit modal)
    var filter = shortSymbol === '__ALL__'
        ? ''
        : '&short_symbol=eq.' + encodeURIComponent(shortSymbol);
    var resp = await fetchWithTimeout(
        SUPABASE_URL + '/rest/v1/transactions?select=*' + filter + '&order=transaction_date.asc',
        { headers: wmsHeaders() }
    );
    if (!resp.ok) {
        showAlert('Failed to load transactions', 'error');
        return;
    }
    var allTxns = await resp.json();

    // Compute display_net_amount for each txn
    allTxns.forEach(function(t) {
        t.display_net_amount = (typeof wmsComputeDisplayNetAmount === 'function')
            ? wmsComputeDisplayNetAmount(t) : t.net_amount;
    });

    // Set shared modal context with Reports' data
    wmsTxnCtx = {
        module: 'reports',
        transactions: allTxns,
        investors: rptInvestors,
        brokers: rptBrokers,
        getPrice: function(sym) {
            return rptGetPrice({ shortSymbol: sym, symbol: sym, exchange: 'NSE', latestPrice: 0 });
        },
        getLiveData: function(sym) {
            return rptGetLiveData({ shortSymbol: sym, symbol: sym, exchange: 'NSE' });
        },
        afterChange: function() {
            // Reload Reports data so portfolio reflects edits
            rptLoadData().then(function() { rptRenderPortfolio(); });
        },
        filterOverride: {
            investorIds: rptSelectedInvestorIds.slice(),
            traderIds: [],
            brokerIds: rptSelectedBrokerIds.slice(),
            tagNames: rptSelectedTagNames.slice(),
            tagLogic: rptTagFilterLogic
        }
    };
    wmsTxnModalOpen(shortSymbol, investorId || null);
}

// Build investor-breakdown detail row (replaces lot-level FIFO table)
function rptBuildInvestorDetail(h, price, md) {
    // Filter transactions for this symbol from the already-filtered set
    var symbolTxns = rptFilterTransactions(rptTransactions).filter(function(t) {
        return t.securityType !== 'NFO' && t.securityType !== 'MCX';
    }).filter(function(t) {
        var tKey = (t.shortSymbol || t.symbol || '');
        return tKey === h.shortSymbol || tKey === h.symbol;
    });

    // Group by investor
    var groups = {};
    symbolTxns.forEach(function(txn) {
        if (!groups[txn.investorId]) {
            groups[txn.investorId] = {
                investorId: txn.investorId,
                name: rptInvName(txn.investorId),
                tags: {},
                txns: []
            };
        }
        groups[txn.investorId].txns.push(txn);
        if (txn.tags) txn.tags.forEach(function(tag) { if (tag) groups[txn.investorId].tags[tag] = true; });
    });

    var investorRows = Object.values(groups)
        .map(function(g) {
            // Run FIFO per investor
            var fifo = wmsCalcFifoCost(g.txns);
            var hKey = Object.keys(fifo.holdings)[0];
            var ih = hKey ? fifo.holdings[hKey] : null;
            g.quantity = ih ? ih.quantity : 0;
            g.totalCost = (g.quantity === 0) ? 0 : (ih ? ih.totalCost : 0);
            g.avgCost = (g.quantity === 0) ? 0 : (ih ? ih.avgCost : 0);
            return g;
        })
        .filter(function(g) { return g.txns.length > 0; })
        .map(function(g) {
            var avg = g.avgCost;
            var inv = g.totalCost;
            var val = g.quantity * price;
            var pl = val - inv;
            var plPct = inv !== 0 ? (pl / Math.abs(inv)) * 100 : 0;
            var dayPL = g.txns ? wmsCalcStockDayPL(g.txns, md, null, {includeNfo: false}) : (md ? g.quantity * md.ch : null);
            var dayChp = md ? md.chp : null;

            var qtyHtml = g.quantity < 0
                ? '<div class="number-main negative">(' + formatQuantity(Math.abs(g.quantity)) + ')</div>'
                : '<div class="number-main">' + formatQuantity(g.quantity) + '</div>';

            var dayPLHtml = dayPL !== null
                ? '<div class="number-main ' + getAmountClass(dayPL) + '">' + formatAmount(dayPL) + '</div>' +
                  '<div class="number-sub ' + getAmountClass(dayChp) + '">' + formatPercent(dayChp) + '</div>'
                : '<div class="number-main">-</div>';

            var invTags = Object.keys(g.tags);
            var tagsPills = invTags.length > 0
                ? invTags.map(function(t) { return '<span class="tag-badge">' + t + '</span>'; }).join('')
                : '';

            var shortSym = h.shortSymbol || h.symbol;
            var invMenuId = 'rpt-inv-am-' + g.investorId.substring(0, 8) + '-' + shortSym.replace(/[^a-zA-Z0-9]/g, '_');

            return '<tr class="rpt-investor-row" data-rpt-group="' + (h.assetClass || 'Other') + '" style="background:#fcfcfd;">' +
                '<td style="padding:4px 8px 4px 42px;"><span class="investor-name-link" data-key="' + shortSym + '" data-investor-id="' + g.investorId + '">' + g.name + '</span></td>' +
                '<td class="text-right" style="padding:4px 8px;">' + qtyHtml + '<div class="number-sub">' + formatPrice(avg, false) + '</div></td>' +
                '<td class="text-right" style="padding:4px 8px;"><div class="number-main">' + formatAmount(inv) + '</div></td>' +
                '<td class="text-right" style="padding:4px 8px;"><div class="number-main">' + formatPrice(price, false) + '</div></td>' +
                '<td class="text-right" style="padding:4px 8px;">' + dayPLHtml + '</td>' +
                '<td class="text-right" style="padding:4px 8px;"><div class="number-main ' + getAmountClass(pl) + '">' + formatAmount(pl) + '</div><div class="number-sub ' + getAmountClass(plPct) + '">' + formatPercent(plPct) + '</div></td>' +
                '<td class="text-right" style="padding:4px 8px;"><div class="number-main">' + formatAmount(val) + '</div></td>' +
                '<td style="padding:4px 8px;">' + tagsPills + '</td>' +
                '<td class="action-cell" style="padding:4px 8px;">' +
                    '<button class="btn-action inv-action-btn" data-menu-id="' + invMenuId + '" title="Actions">⋮</button>' +
                    '<div class="action-menu" id="' + invMenuId + '">' +
                        '<button class="action-menu-item" data-action="transactions" data-key="' + shortSym + '" data-investor-id="' + g.investorId + '">📋 Show Transactions</button>' +
                    '</div>' +
                '</td>' +
            '</tr>';
        }).join('');

    return investorRows;
}

// One-time: close action menus on outside click
var rptDocClickBound = false;

// Attach click listeners for expand/collapse, action menus, investor links
function rptAttachRowListeners() {
    // Close menus on outside click — bind only once
    if (!rptDocClickBound) {
        document.addEventListener('click', function() { rptCloseAllActionMenus(); });
        rptDocClickBound = true;
    }

    // Stock-level action buttons
    document.querySelectorAll('.rpt-btn-action[data-menu-id]').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            rptToggleActionMenu(btn.dataset.menuId);
        });
    });

    // Stock-level action menu items
    document.querySelectorAll('.rpt-action-menu .action-menu-item[data-action]').forEach(function(item) {
        item.addEventListener('click', function(e) {
            e.stopPropagation();
            rptCloseAllActionMenus();
            if (item.dataset.action === 'transactions') {
                rptShowTransactions(item.dataset.key, item.dataset.investorId || null);
            }
        });
    });

    // Investor name click → show transactions
    document.querySelectorAll('.investor-name-link').forEach(function(el) {
        el.addEventListener('click', function(e) {
            e.stopPropagation();
            rptShowTransactions(el.dataset.key, el.dataset.investorId);
        });
    });

    // Investor-level action buttons
    document.querySelectorAll('.inv-action-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            rptToggleActionMenu(btn.dataset.menuId);
        });
    });

    // Investor-level action menu items
    document.querySelectorAll('.detail-row .action-menu-item[data-action]').forEach(function(item) {
        item.addEventListener('click', function(e) {
            e.stopPropagation();
            rptCloseAllActionMenus();
            if (item.dataset.action === 'transactions') {
                rptShowTransactions(item.dataset.key, item.dataset.investorId || null);
            }
        });
    });
}

// ============================================================================
// PORTFOLIO TAB — RENDER (Grouped by Asset Class, FIFO, No F&O)
// ============================================================================

function rptSortPortfolio(column) {
    var isPLCol = (column === 'pl' || column === 'daypl');
    if (rptSortColumn === column) {
        if (isPLCol && !rptSortByPct) {
            rptSortByPct = true;
        } else if (isPLCol && rptSortByPct) {
            rptSortByPct = false;
            rptSortDirection = rptSortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            rptSortDirection = rptSortDirection === 'asc' ? 'desc' : 'asc';
        }
    } else {
        rptSortColumn = column;
        rptSortDirection = 'asc';
        rptSortByPct = false;
    }
    rptRenderPortfolio();
}

function rptToggleSymbolDetail(symbol, exchange) {
    var key = symbol + '-' + exchange;
    rptExpandedSymbol = (rptExpandedSymbol === key) ? null : key;
    rptRenderPortfolio();
}

function rptRenderPortfolio() {
    var body = document.getElementById('rptPortfolioBody');
    if (!body) return;

    // 1. Filter transactions
    var filtered = rptFilterTransactions(rptTransactions);
    // 2. Exclude F&O and MCX (holdings portfolio only)
    filtered = filtered.filter(function(t) {
        return t.securityType !== 'NFO' && t.securityType !== 'MCX';
    });

    // 3. Run FIFO
    var fifo = rptFifoEngine(filtered);
    var allHoldings = Object.values(fifo.holdings);

    // 4. Filter zero holdings
    if (!rptShowZero) {
        allHoldings = allHoldings.filter(function(h) { return h.quantity !== 0; });
    }

    if (allHoldings.length === 0) {
        body.innerHTML = '<div style="text-align:center;padding:40px;color:#9ca3af;">No holdings to display</div>';
        document.getElementById('rpt-portfolio-summary').innerHTML = '';
        return;
    }

    // 52-week data from securities_db cache
    var secBySymbol = {};
    (wmsRefData.securitiesCm || []).forEach(function(s) {
        if (!secBySymbol[s.symbol]) secBySymbol[s.symbol] = s;
    });

    // 5. Compute grand totals
    var grandTotalInvested = 0, grandTotalValue = 0;
    allHoldings.forEach(function(h) {
        grandTotalInvested += h.totalCost;
        grandTotalValue += h.quantity * rptGetPrice(h);
    });

    // 6. Group by asset class
    var groups = {};
    allHoldings.forEach(function(h) {
        var ac = h.assetClass || 'Other';
        if (!groups[ac]) groups[ac] = [];
        groups[ac].push(h);
    });

    // 7. Sort function
    var sortFn = function(a, b) {
        var valA, valB;
        var priceA = rptGetPrice(a), priceB = rptGetPrice(b);
        switch (rptSortColumn) {
            case 'symbol':
                valA = a.symbol; valB = b.symbol; break;
            case 'invested':
                valA = a.totalCost; valB = b.totalCost; break;
            case 'pl':
                if (rptSortByPct) {
                    valA = a.totalCost !== 0 ? ((a.quantity * priceA - a.totalCost) / Math.abs(a.totalCost)) * 100 : 0;
                    valB = b.totalCost !== 0 ? ((b.quantity * priceB - b.totalCost) / Math.abs(b.totalCost)) * 100 : 0;
                } else {
                    valA = (a.quantity * priceA) - a.totalCost;
                    valB = (b.quantity * priceB) - b.totalCost;
                }
                break;
            case 'daypl':
                var mdA = rptGetLiveData(a), mdB = rptGetLiveData(b);
                if (rptSortByPct) {
                    valA = mdA ? mdA.chp : 0;
                    valB = mdB ? mdB.chp : 0;
                } else {
                    valA = a._txns ? (wmsCalcStockDayPL(a._txns, mdA, null, {includeNfo: false}) || 0) : 0;
                    valB = b._txns ? (wmsCalcStockDayPL(b._txns, mdB, null, {includeNfo: false}) || 0) : 0;
                }
                break;
            case 'value':
                valA = a.quantity * priceA; valB = b.quantity * priceB; break;
            default:
                valA = a.symbol; valB = b.symbol;
        }
        if (typeof valA === 'string') {
            return rptSortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        return rptSortDirection === 'asc' ? valA - valB : valB - valA;
    };

    // 8. Build HTML — single table with page-level header
    var sortArrow = rptSortDirection === 'asc' ? '▲' : '▼';
    var sortLabel = (rptSortByPct && (rptSortColumn === 'pl' || rptSortColumn === 'daypl')) ? '%' : '';

    // 8a. Apply symbol search filter
    if (rptSymbolSearchText) {
        var searchLower = rptSymbolSearchText.toLowerCase();
        allHoldings = allHoldings.filter(function(h) {
            return (h.symbol && h.symbol.toLowerCase().indexOf(searchLower) >= 0) ||
                   (h.companyName && h.companyName.toLowerCase().indexOf(searchLower) >= 0);
        });
    }

    var html = '<table style="width:100%; border-collapse:collapse; table-layout:fixed;">' +
        '<colgroup><col style="width:17%"><col style="width:9%"><col style="width:11%"><col style="width:10%"><col style="width:11%"><col style="width:11%"><col style="width:11%"><col style="width:9%"><col style="width:40px"></colgroup>';

    // Symbol header content (with search indicator if active)
    var symbolSortArrow = rptSortColumn === 'symbol' ? sortArrow : '';
    var symbolSearchBadge = rptSymbolSearchText
        ? ' <span style="font-size:10px;color:#667eea;">🔍 ' + rptSymbolSearchText + '</span>'
        : '';

    // Page-level header (single, not repeated per group) — uses app-standard global th styling
    html += '<thead><tr>' +
        '<th id="rpt-th-symbol" class="sortable" onclick="rptSortPortfolio(\'symbol\')" style="width:17%; text-align:left; cursor:pointer;">' +
            '<span id="rpt-header-toggle" onclick="event.stopPropagation(); rptToggleAllGroups();" style="display:inline-block;width:16px;font-size:12px;color:#718096;cursor:pointer;vertical-align:middle;" title="Collapse/Expand All">▾</span>' +
            'Company ' + symbolSortArrow + symbolSearchBadge +
        '</th>' +
        '<th class="text-right" style="width:9%;">Qty<br><span class="subheader">FIFO Cost</span></th>' +
        '<th class="text-right sortable" onclick="rptSortPortfolio(\'invested\')" style="width:11%;">Invested ' + (rptSortColumn === 'invested' ? sortArrow : '') + '</th>' +
        '<th class="text-right" style="width:10%;">Price</th>' +
        '<th class="text-right sortable" onclick="rptSortPortfolio(\'daypl\')" style="width:11%;">Day P&L ' + (rptSortColumn === 'daypl' ? sortLabel + sortArrow : '') + '</th>' +
        '<th class="text-right sortable" onclick="rptSortPortfolio(\'pl\')" style="width:11%;">Gain ' + (rptSortColumn === 'pl' ? sortLabel + sortArrow : '') + '</th>' +
        '<th class="text-right sortable" onclick="rptSortPortfolio(\'value\')" style="width:11%;">Value ' + (rptSortColumn === 'value' ? sortArrow : '') + '</th>' +
        '<th style="width:9%;">Tags</th>' +
        '<th style="width:40px;"></th>' +
    '</tr></thead><tbody>';

    // Iterate groups
    for (var gi = 0; gi < RPT_ASSET_CLASS_ORDER.length; gi++) {
        var acName = RPT_ASSET_CLASS_ORDER[gi];
        var groupHoldings = groups[acName];
        if (!groupHoldings || groupHoldings.length === 0) continue;

        groupHoldings.sort(sortFn);

        // Group totals
        var grpInvested = 0, grpValue = 0, grpDayPL = 0;
        var hasDayData = false;
        groupHoldings.forEach(function(h) {
            grpInvested += h.totalCost;
            grpValue += h.quantity * rptGetPrice(h);
            var md = rptGetLiveData(h);
            var dp = h._txns ? wmsCalcStockDayPL(h._txns, md, null, {includeNfo: false}) : (md ? h.quantity * md.ch : null);
            if (dp !== null) { grpDayPL += dp; hasDayData = true; }
        });
        var grpPL = grpValue - grpInvested;
        var grpPLPct = grpInvested !== 0 ? (grpPL / Math.abs(grpInvested)) * 100 : 0;
        var grpDayPLPct = grpInvested !== 0 ? (grpDayPL / Math.abs(grpInvested)) * 100 : 0;

        var isCollapsed = !!rptCollapsedGroups[acName];
        var chevronId = 'rpt-chevron-' + acName.replace(/\s+/g, '-');
        var badge = RPT_AC_BADGE[acName] || '—';

        // Group header row (MProfit style: inline totals in same columns as data)
        html += '<tr class="rpt-group-header-row" onclick="rptToggleGroup(\'' + acName + '\')" style="background:#f7fafc; cursor:pointer; border-top:1px solid #e2e8f0;">' +
            '<td colspan="2" style="padding:7px 8px; font-size:13px; font-weight:700; color:#2d3748;">' +
                '<span id="' + chevronId + '" style="display:inline-block;width:16px;font-size:12px;color:#718096;vertical-align:middle;">' + (isCollapsed ? '▸' : '▾') + '</span>' +
                '<span style="display:inline-block;border:1px solid #a0aec0;border-radius:3px;padding:0 4px;font-size:10px;font-weight:700;color:#4a5568;margin-right:6px;vertical-align:middle;">' + badge + '</span>' +
                acName + ' <span style="font-weight:500;font-size:11px;color:#718096;">(' + groupHoldings.length + ')</span>' +
            '</td>' +
            '<td class="text-right" style="padding:7px 8px; font-size:12px; font-weight:700;">' + formatAmount(grpInvested) + '</td>' +
            '<td class="text-right" style="padding:7px 8px;"></td>' +
            '<td class="text-right" style="padding:7px 8px; font-size:12px; font-weight:700;">' +
                (hasDayData ? '<span class="' + getAmountClass(grpDayPL) + '">' + formatAmount(grpDayPL) + '</span><br><span class="number-sub ' + getAmountClass(grpDayPLPct) + '">' + formatPercent(grpDayPLPct) + '</span>' : '') +
            '</td>' +
            '<td class="text-right" style="padding:7px 8px; font-size:12px; font-weight:700;">' +
                '<span class="' + getAmountClass(grpPL) + '">' + formatAmount(grpPL) + '</span><br>' +
                '<span class="number-sub ' + getAmountClass(grpPLPct) + '">' + formatPercent(grpPLPct) + '</span>' +
            '</td>' +
            '<td class="text-right" style="padding:7px 8px; font-size:12px; font-weight:700;">' + formatAmount(grpValue) + '</td>' +
            '<td style="padding:7px 8px;"></td>' +
            '<td style="padding:7px 8px;"></td>' +
        '</tr>';

        // Data rows for this group
        var rowDisplay = isCollapsed ? ' style="display:none;"' : '';

        for (var hi = 0; hi < groupHoldings.length; hi++) {
            var h = groupHoldings[hi];
            var price = rptGetPrice(h);
            var md = rptGetLiveData(h);
            var invested = h.totalCost;
            var currentValue = h.quantity * price;
            var pl = currentValue - invested;
            var plPct = invested !== 0 ? (pl / Math.abs(invested)) * 100 : 0;
            var dayPL = h._txns ? wmsCalcStockDayPL(h._txns, md, null, {includeNfo: false}) : (md ? h.quantity * md.ch : null);
            var dayChp = md ? md.chp : null;

            // 52-week slider
            var sec52 = secBySymbol[h.symbol];
            var w52h = sec52 && sec52.week_52_high ? Number(sec52.week_52_high) : null;
            var w52l = sec52 && sec52.week_52_low ? Number(sec52.week_52_low) : null;
            var cmpSlider = (w52h && w52l && typeof buildSlider === 'function')
                ? buildSlider(price, w52l, w52h, formatPrice(w52l, false), formatPrice(w52h, false))
                : '';

            var qtyHtml = h.quantity < 0
                ? '<div class="number-main negative">(' + formatQuantity(Math.abs(h.quantity)) + ')</div>'
                : '<div class="number-main">' + formatQuantity(h.quantity) + '</div>';

            var symbolKey = h.symbol + '-' + h.exchange;
            var shortSym = h.shortSymbol || h.symbol;
            var isExpanded = rptExpandedSymbol === symbolKey;
            var expClass = isExpanded ? ' expanded-row' : '';

            var dayPLHtml = dayPL !== null
                ? '<div class="number-main ' + getAmountClass(dayPL) + '">' + formatAmount(dayPL) + '</div>' +
                  '<div class="number-sub ' + getAmountClass(dayChp) + '">' + formatPercent(dayChp) + '</div>'
                : '<div class="number-main" style="color:#a0aec0;">-</div>';

            html += '<tr data-rpt-group="' + acName + '" class="rpt-data-row' + expClass + '"' + rowDisplay + '>' +
                '<td class="company-cell" style="padding:6px 8px 6px 32px;">' +
                    '<div class="company-main" onclick="rptToggleSymbolDetail(\'' + h.symbol + '\',\'' + h.exchange + '\')" title="' + wmsEsc(h.companyName || h.shortSymbol) + '">' + wmsEsc(h.companyName || h.shortSymbol) + '</div>' +
                    '<div class="company-sub">' + wmsEsc(h.shortSymbol || h.symbol) + '</div>' +
                '</td>' +
                '<td class="text-right" style="padding:6px 8px;">' +
                    qtyHtml +
                    '<div class="number-sub">' + formatPrice(h.fifoCost, false) + '</div>' +
                '</td>' +
                '<td class="text-right" style="padding:6px 8px;">' +
                    '<div class="number-main">' + formatAmount(invested) + '</div>' +
                '</td>' +
                '<td class="text-right" style="padding:6px 8px;">' +
                    '<div class="number-main">' + formatPrice(price, false) + '</div>' +
                    cmpSlider +
                '</td>' +
                '<td class="text-right" style="padding:6px 8px;">' + dayPLHtml + '</td>' +
                '<td class="text-right" style="padding:6px 8px;">' +
                    '<div class="number-main ' + getAmountClass(pl) + '">' + formatAmount(pl) + '</div>' +
                    '<div class="number-sub ' + getAmountClass(plPct) + '">' + formatPercent(plPct) + '</div>' +
                '</td>' +
                '<td class="text-right" style="padding:6px 8px;">' +
                    '<div class="number-main">' + formatAmount(currentValue) + '</div>' +
                '</td>' +
                '<td style="padding:6px 8px;">' + h.tags.map(function(t) { return '<span class="tag-badge">' + t + '</span>'; }).join('') + '</td>' +
                '<td class="action-cell" style="padding:6px 8px;">' +
                    '<button class="btn-action rpt-btn-action" data-menu-id="rpt-am-' + shortSym.replace(/[^a-zA-Z0-9]/g, '_') + '" title="Actions">⋮</button>' +
                    '<div class="action-menu rpt-action-menu" id="rpt-am-' + shortSym.replace(/[^a-zA-Z0-9]/g, '_') + '">' +
                        '<button class="action-menu-item" data-action="transactions" data-key="' + shortSym + '">📋 Show Transactions</button>' +
                    '</div>' +
                '</td>' +
            '</tr>';

            // Expanded: show investor-wise breakdown (matching Trading > Portfolio)
            if (isExpanded) {
                var detailHtml = rptBuildInvestorDetail(h, price, md);
                if (detailHtml) {
                    html += detailHtml;
                }
            }
        }
    }

    html += '</tbody></table>';
    body.innerHTML = html;

    // Attach dblclick on Symbol header for inline search
    var symTh = document.getElementById('rpt-th-symbol');
    if (symTh) {
        symTh.addEventListener('dblclick', function(e) {
            e.preventDefault();
            e.stopPropagation();
            rptOpenSymbolSearch();
        });
    }

    // Attach click listeners for action menus, investor links
    rptAttachRowListeners();

    // Summary cards (grand totals)
    var grandPL = grandTotalValue - grandTotalInvested;
    var grandPLPct = grandTotalInvested !== 0 ? (grandPL / Math.abs(grandTotalInvested)) * 100 : 0;
    rptRenderSummaryCards(grandTotalInvested, grandTotalValue, grandPL, grandPLPct, allHoldings.length);
}

function rptRenderSummaryCards(invested, value, pl, plPct, count) {
    var container = document.getElementById('rpt-portfolio-summary');
    if (!container) return;
    container.innerHTML =
        '<div class="summary-card">' +
            '<div class="summary-label">Total Invested (FIFO)</div>' +
            '<div class="summary-value">' + formatAmount(invested) + '</div>' +
        '</div>' +
        '<div class="summary-card ' + getAmountClass(pl) + '">' +
            '<div class="summary-label">Total P&L</div>' +
            '<div class="summary-value">' + formatAmount(pl) + '</div>' +
            '<div class="summary-percent">' + formatPercent(plPct) + '</div>' +
        '</div>' +
        '<div class="summary-card">' +
            '<div class="summary-label">Total Value</div>' +
            '<div class="summary-value">' + formatAmount(value) + '</div>' +
        '</div>' +
        '<div class="summary-card">' +
            '<div class="summary-label">Holdings</div>' +
            '<div class="summary-value">' + count + ' stocks</div>' +
        '</div>';
}

// ============================================================================
// CAPITAL GAINS TAB
// ============================================================================

// Indian Capital Gains Rules (post-Jul 2024 budget, applicable FY 2025-26 onward):
//
// Listed Equity (STT paid):
//   > 12 months → LTCG @ 12.5% (₹1.25L annual exemption)
//   ≤ 12 months → STCG @ 20%
//
// ETF (equity-oriented, STT paid):
//   Same as listed equity
//
// REIT / InvIT (listed, STT paid):
//   Same as listed equity
//
// Debt MF / NCD / Bonds (purchased after 1 Apr 2023):
//   Always STCG regardless of holding period → taxed at slab rates
//
// SGB (Sovereign Gold Bond):
//   If held to maturity → exempt
//   Otherwise: > 12 months → LTCG @ 12.5%; ≤ 12 months → STCG at slab
//
// F&O: Business income (not capital gains) — excluded from this report

var RPT_CG_LTCG_HOLDING_DAYS = 365;  // > 12 months for listed equity
var RPT_CG_LTCG_RATE = 12.5;         // %
var RPT_CG_STCG_RATE = 20;           // % for listed equity with STT
var RPT_CG_LTCG_EXEMPTION = 125000;  // ₹1.25 lakh annual exemption

function rptClassifyGain(gain) {
    var secType = gain.securityType || 'EQUITY';
    var isDebt = (secType === 'NCD' || secType === 'GOVT_BOND');
    // Debt instruments purchased after 1 Apr 2023 — always STCG
    if (isDebt) {
        return { type: 'STCG', rate: 'Slab', rateNote: 'Debt — always STCG (post Apr 2023 rules)', taxable: true };
    }
    // F&O / MCX — business income (should not appear here, but safety)
    if (secType === 'NFO' || secType === 'MCX') {
        return { type: 'Business', rate: 'Slab', rateNote: 'F&O / Commodities — business income', taxable: true };
    }
    // SGB — exempt if held to maturity (we can't know maturity, so classify normally)
    // Listed equity, ETF, REIT, InvIT, SGB — standard equity rules
    if (gain.holdingDays > RPT_CG_LTCG_HOLDING_DAYS) {
        return { type: 'LTCG', rate: RPT_CG_LTCG_RATE + '%', rateNote: 'LTCG @ ' + RPT_CG_LTCG_RATE + '% (exempt up to ₹' + (RPT_CG_LTCG_EXEMPTION / 100000).toFixed(2) + ' L)', taxable: true };
    } else {
        return { type: 'STCG', rate: RPT_CG_STCG_RATE + '%', rateNote: 'STCG @ ' + RPT_CG_STCG_RATE + '% (STT paid)', taxable: true };
    }
}

// ----------------------------------------------------------------------------
// Capital-gains engine (STT-aware). STT is NOT a permitted CG deduction, but
// WMS lets each investor flag STT as a separate expense (stt_accounting_method).
//   • flag ON  (STT booked as a separate expense) → STT is EXCLUDED from the CG
//     cost/proceeds: removed from buy cost, added back to sell proceeds.
//   • flag OFF (STT capitalised into the trade)    → STT stays in (net_amount).
// The flag is resolved PER TRADE by the trade's own investor (E.14: charges
// belong to the executing investor_id). We reuse the shared FIFO engine for all
// lot-matching + corporate-action logic and only feed it STT-adjusted amounts.
// ----------------------------------------------------------------------------
function rptCalcCapGains(txns) {
    var invFlag = {};
    rptInvestors.forEach(function(inv) { invFlag[String(inv.id)] = !!inv.stt_accounting_method; });

    var adj = txns.map(function(t) {
        var stt = Math.abs(parseFloat(t.stt) || 0);
        if (stt <= 0) return t;                              // nothing to strip
        if (!invFlag[String(t.investorId)]) return t;        // flag OFF → STT stays in CG
        // flag ON → STT is a separate expense → strip it from the CG basis
        var base = (t.netAmount !== undefined ? t.netAmount : t.net_amount) || 0;
        var ty = (t.type || t.transaction_type || '').toUpperCase();
        var c = {}; for (var k in t) c[k] = t[k];
        if (ty === 'BUY' || ty === 'RIGHTS_PAYMENT') c.net_amount = base - stt;   // buy cost ↓
        else if (ty === 'SELL')                      c.net_amount = base + stt;   // sell proceeds ↑
        else                                         c.net_amount = base;
        return c;                                            // net_amount (snake) wins over netAmount in the engine
    });

    return wmsCalcFifoCost(adj).gains;
}

// Bucket a realised gain into INTRADAY (same-day) / STCG / LTCG.
function rptCGBucket(g) {
    if (g.buyDate && g.sellDate && g.buyDate === g.sellDate) return 'INTRADAY';
    return rptClassifyGain(g).type === 'LTCG' ? 'LTCG' : 'STCG';
}

function rptInitFYSelector() {
    var select = document.getElementById('rpt-fy-select');
    if (!select) return;

    // Determine FY range from transactions
    var years = {};
    rptTransactions.forEach(function(t) {
        if (!t.date) return;
        var d = new Date(t.date);
        var yr = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; // FY starts April
        years[yr] = true;
    });

    var fyList = Object.keys(years).map(Number).sort(function(a, b) { return b - a; });
    // Add current FY if not present
    var now = new Date();
    var currentFY = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    if (fyList.indexOf(currentFY) < 0) fyList.unshift(currentFY);

    select.innerHTML = fyList.map(function(yr) {
        var label = 'FY ' + yr + '-' + String(yr + 1).slice(2);
        return '<option value="' + yr + '"' + (yr === currentFY ? ' selected' : '') + '>' + label + '</option>';
    }).join('');
}

// Capital Gains filter system
function rptInitCGFilters() {
    // Investor pills (shared widget — same as Portfolio tab and the rest of the app)
    var invContainer = document.getElementById('rpt-cg-filter-investor');
    if (invContainer) {
        var invItems = rptInvestors.map(function(inv) {
            return { id: String(inv.id), label: inv.short_name || inv.name, searchText: (inv.name || '') + ' ' + (inv.short_name || '') };
        });
        rptCGInvPillFilter = wmsPillSearch(invContainer, {
            label: 'Investor',
            placeholder: 'Search investors...',
            items: invItems,
            selectedIds: rptCGSelectedInvestorIds,
            onChange: rptRenderCapGains
        });
    }
    // Broker pills
    var brkContainer = document.getElementById('rpt-cg-filter-broker');
    if (brkContainer) {
        var brkItems = rptBrokers.map(function(b) {
            return { id: String(b.id), label: b.broker_code || b.name, searchText: (b.name || '') + ' ' + (b.broker_code || '') };
        });
        rptCGBrkPillFilter = wmsPillSearch(brkContainer, {
            label: 'Broker',
            placeholder: 'Search brokers...',
            items: brkItems,
            selectedIds: rptCGSelectedBrokerIds,
            onChange: rptRenderCapGains
        });
    }
    // Tag pills (with Any/All radio) — same as Portfolio tab
    var tagContainer = document.getElementById('rpt-cg-filter-tag');
    if (tagContainer) {
        var allTags = {};
        rptTransactions.forEach(function(t) { if (t.tags) t.tags.forEach(function(tg) { allTags[tg] = true; }); });
        var tagItems = Object.keys(allTags).sort().map(function(tag) {
            return { id: tag, label: tag, searchText: tag };
        });
        var tagExtra = document.createElement('div');
        tagExtra.className = 'tag-match-options';
        tagExtra.innerHTML =
            '<span style="font-size:11px;color:#718096;">Match:</span>' +
            '<label class="radio-label"><input type="radio" name="rpt-cg-tag-logic" value="OR" checked> <span>Any</span></label>' +
            '<label class="radio-label"><input type="radio" name="rpt-cg-tag-logic" value="AND"> <span>All</span></label>';
        rptCGTagPillFilter = wmsPillSearch(tagContainer, {
            label: 'Tag',
            placeholder: 'Search tags...',
            items: tagItems,
            selectedIds: rptCGSelectedTagNames,
            onChange: rptRenderCapGains,
            headerExtra: tagExtra
        });
        tagExtra.addEventListener('change', function(e) {
            if (e.target.name === 'rpt-cg-tag-logic') {
                rptCGTagFilterLogic = e.target.value;
                rptRenderCapGains();
            }
        });
    }
}


function rptRenderCapGains() {
    var summaryEl = document.getElementById('rpt-cg-summary');
    var bodyEl = document.getElementById('rptCGBody');
    if (!summaryEl || !bodyEl) return;

    var select = document.getElementById('rpt-fy-select');
    if (!select || !select.value) return;

    var fy = parseInt(select.value);
    var fyStart = fy + '-04-01';        // 1 April
    var fyEnd = (fy + 1) + '-03-31';    // 31 March

    // Filter: exclude F&O/MCX, apply CG investor/broker filters
    var filtered = rptTransactions.filter(function(t) {
        return t.securityType !== 'NFO' && t.securityType !== 'MCX';
    });
    if (rptCGSelectedInvestorIds.length > 0) {
        filtered = filtered.filter(function(t) { return rptCGSelectedInvestorIds.indexOf(t.investorId) >= 0; });
    }
    if (rptCGSelectedBrokerIds.length > 0) {
        filtered = filtered.filter(function(t) { return t.brokerId && rptCGSelectedBrokerIds.indexOf(t.brokerId) >= 0; });
    }
    if (rptCGSelectedTagNames.length > 0) {
        if (rptCGTagFilterLogic === 'AND') {
            filtered = filtered.filter(function(t) {
                return rptCGSelectedTagNames.every(function(tag) { return (t.tags || []).indexOf(tag) >= 0; });
            });
        } else {
            filtered = filtered.filter(function(t) {
                return (t.tags || []).some(function(tag) { return rptCGSelectedTagNames.indexOf(tag) >= 0; });
            });
        }
    }

    // STT-aware capital-gains engine (runs on the filtered set for correct lot matching)
    var gains = rptCalcCapGains(filtered);

    // Keep gains whose SELL falls within the selected FY
    var fyGains = gains.filter(function(g) {
        return g.sellDate >= fyStart && g.sellDate <= fyEnd;
    });

    if (fyGains.length === 0) {
        summaryEl.innerHTML = '';
        bodyEl.innerHTML = '<div style="text-align:center;padding:40px;color:#9ca3af;">No capital gains for FY ' + fy + '-' + String(fy + 1).slice(2) + '</div>';
        return;
    }

    // Aggregate per stock into Intra-day / Short-term / Long-term buckets
    var perStock = {};
    var totIntraday = 0, totSTCG = 0, totLTCG = 0;
    fyGains.forEach(function(g) {
        var key = g.shortSymbol || g.symbol;
        if (!perStock[key]) {
            perStock[key] = {
                symbol: key,
                company: g.companyName || '',
                securityType: g.securityType || 'EQUITY',
                intraday: 0, stcg: 0, ltcg: 0
            };
        }
        var b = rptCGBucket(g);
        if (b === 'INTRADAY') { perStock[key].intraday += g.gain; totIntraday += g.gain; }
        else if (b === 'LTCG') { perStock[key].ltcg += g.gain; totLTCG += g.gain; }
        else { perStock[key].stcg += g.gain; totSTCG += g.gain; }
    });

    // Estimated tax (capital gains only; intra-day is taxed at slab and excluded)
    var ltcgTaxable = Math.max(0, totLTCG - RPT_CG_LTCG_EXEMPTION);
    var estLTCGTax = ltcgTaxable * RPT_CG_LTCG_RATE / 100;
    var estSTCGTax = totSTCG > 0 ? totSTCG * RPT_CG_STCG_RATE / 100 : 0;

    // Summary cards: Intra-day · Short-term · Long-term · Est. tax
    summaryEl.innerHTML =
        '<div class="rpt-cg-card">' +
            '<div class="rpt-cg-card-label">Intra-day Profit/Loss</div>' +
            '<div class="rpt-cg-card-value ' + getAmountClass(totIntraday) + '">' + formatAmount(totIntraday) + '</div>' +
            '<div class="rpt-cg-card-sub">taxed at slab (speculative)</div>' +
        '</div>' +
        '<div class="rpt-cg-card">' +
            '<div class="rpt-cg-card-label">Short-term Capital Gain</div>' +
            '<div class="rpt-cg-card-value ' + getAmountClass(totSTCG) + '">' + formatAmount(totSTCG) + '</div>' +
            '<div class="rpt-cg-card-sub">' + RPT_CG_STCG_RATE + '% (listed equity)</div>' +
        '</div>' +
        '<div class="rpt-cg-card">' +
            '<div class="rpt-cg-card-label">Long-term Capital Gain</div>' +
            '<div class="rpt-cg-card-value ' + getAmountClass(totLTCG) + '">' + formatAmount(totLTCG) + '</div>' +
            '<div class="rpt-cg-card-sub">' + RPT_CG_LTCG_RATE + '% above ₹' + (RPT_CG_LTCG_EXEMPTION / 100000).toFixed(2) + 'L</div>' +
        '</div>' +
        '<div class="rpt-cg-card">' +
            '<div class="rpt-cg-card-label">Est. Tax Liability</div>' +
            '<div class="rpt-cg-card-value">' + formatAmount(estLTCGTax + estSTCGTax) + '</div>' +
            '<div class="rpt-cg-card-sub">LTCG: ' + formatAmount(estLTCGTax) + ' · STCG: ' + formatAmount(estSTCGTax) + '</div>' +
        '</div>';

    // One row per stock, ordered by asset class then symbol
    var stocks = Object.keys(perStock).map(function(k) { return perStock[k]; });
    stocks.forEach(function(s) { s.assetClass = rptGetAssetClass(s.securityType); });
    stocks.sort(function(a, b) {
        var ai = RPT_ASSET_CLASS_ORDER.indexOf(a.assetClass); if (ai < 0) ai = 99;
        var bi = RPT_ASSET_CLASS_ORDER.indexOf(b.assetClass); if (bi < 0) bi = 99;
        if (ai !== bi) return ai - bi;
        return (a.symbol || '').localeCompare(b.symbol || '');
    });

    // Per-stock summary table — Stock | Type | Intra-day | Short-term | Long-term
    var html = '<table class="rpt-cg-table" style="width:100%; border-collapse:collapse; table-layout:fixed;">';
    html += '<colgroup>' +
        '<col style="width:30%">' +   // Stock
        '<col style="width:16%">' +   // Type
        '<col style="width:18%">' +   // Intra-day
        '<col style="width:18%">' +   // Short-term
        '<col style="width:18%">' +   // Long-term
    '</colgroup>';
    html += '<thead><tr>' +
        '<th>Stock</th>' +
        '<th>Type</th>' +
        '<th class="text-right cg-grp-start">Intra-day Profit/Loss</th>' +
        '<th class="text-right">Short-term Capital Gain</th>' +
        '<th class="text-right">Long-term Capital Gain</th>' +
    '</tr></thead><tbody>';

    stocks.forEach(function(s) {
        var badge = RPT_AC_BADGE[s.assetClass] || '—';
        html += '<tr>' +
            '<td>' +
                '<div style="font-weight:600; font-size:12px; color:#2d3748;">' + s.symbol + '</div>' +
                '<div style="font-size:10px; color:#a0aec0;">' + s.company + '</div>' +
            '</td>' +
            '<td>' +
                '<span style="display:inline-block;border:1px solid #a0aec0;border-radius:3px;padding:0 5px;font-size:10px;font-weight:700;color:#4a5568;margin-right:5px;">' + badge + '</span>' +
                '<span style="font-size:11px;color:#718096;">' + s.assetClass + '</span>' +
            '</td>' +
            '<td class="text-right cg-grp-start ' + getAmountClass(s.intraday) + '">' + formatAmount(s.intraday) + '</td>' +
            '<td class="text-right ' + getAmountClass(s.stcg) + '">' + formatAmount(s.stcg) + '</td>' +
            '<td class="text-right ' + getAmountClass(s.ltcg) + '">' + formatAmount(s.ltcg) + '</td>' +
        '</tr>';
    });

    html += '<tr class="total-row">' +
        '<td>TOTAL</td>' +
        '<td></td>' +
        '<td class="text-right cg-grp-start ' + getAmountClass(totIntraday) + '">' + formatAmount(totIntraday) + '</td>' +
        '<td class="text-right ' + getAmountClass(totSTCG) + '">' + formatAmount(totSTCG) + '</td>' +
        '<td class="text-right ' + getAmountClass(totLTCG) + '">' + formatAmount(totLTCG) + '</td>' +
    '</tr>';

    html += '</tbody></table>';
    bodyEl.innerHTML = html;
}

// ============================================================================
// EXPORTS
// ============================================================================

if (typeof window !== 'undefined') {
    window.initReports = initReports;
    window.rptRefresh = rptRefresh;
    window.rptSortPortfolio = rptSortPortfolio;
    window.rptToggleSymbolDetail = rptToggleSymbolDetail;
    window.rptToggleZero = rptToggleZero;
    window.rptToggleGroup = rptToggleGroup;
    window.rptToggleAllGroups = rptToggleAllGroups;
    window.rptOpenSymbolSearch = rptOpenSymbolSearch;
    window.rptCloseSymbolSearch = rptCloseSymbolSearch;
    window.rptShowTransactions = rptShowTransactions;
    window.rptCloseAllActionMenus = rptCloseAllActionMenus;
    window.rptRenderPortfolio = rptRenderPortfolio;
    window.rptRenderCapGains = rptRenderCapGains;
}
