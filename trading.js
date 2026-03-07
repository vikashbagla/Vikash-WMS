// ============================================================================
// WMS TRADING MODULE
// ============================================================================
// Uses 'tr' prefix to avoid naming conflicts with portfolio.js and utils.js.
// All module-level state uses var (project convention — avoids TDZ on reload).

// INCOME_TYPES now canonical in wms-shared.js as WMS_INCOME_TYPES
var INCOME_TYPES = WMS_INCOME_TYPES;

var trTransactions = [];
var trInvestors = [];
var trBrokers = [];
var trSelectedInvestorIds = [];
var trSelectedTraderIds = [];
var trSelectedBrokerIds = [];
var trSelectedTagNames = [];
var trTagFilterLogic = 'OR';
var trInvPillFilter = null;
var trTrdPillFilter = null;
var trBrkPillFilter = null;
var trTagPillFilter = null;
var trViewMode = 'default';        // 'default' | 'holdings' | 'fno'
var trSortColumn = 'company';
var trSortDirection = 'asc';
var trSortByPct = false;
var trExpandedKey = null;
var trShowZeroHoldings = false;
var trPortfolioViews = [];         // Saved views from DB
var trActiveViewId = null;         // Currently active saved view
var trCompanySearchText = '';      // Inline company search filter
var trLivePrices = {};
var trLiveData = {};
var trOpenActionMenu = null;
var trCurrentTxnModalKey = null;
var trCurrentTxnInvestorId = null; // optional investor filter for txn modal
var trEditingTxnId = null;
var trEditTagCtrl = null;  // wmsTagInput controller for edit modal

// Txn modal state
var trTxnSortColumn = 'date';
var trTxnSortDirection = 'asc';
var trTxnHiddenIds = {};        // temp hidden trade IDs (UI only)
var trShowHiddenTrades = false;  // toggle for showing hidden trades
var trTxnViewMode = 'list';     // 'list' | 'matching'
var trTxnDaysFilter = 0;        // 0 = ALL, else # of days
var trTxnMatchMethod = 'lifo';  // 'fifo' | 'lifo' (default LIFO)
var trTxnFnoPricesFetched = false;  // reset each modal open
var trTxnContractFilter = [];   // [] = show all, else array of expiry labels (e.g. "Mar 26") to show
var trRenamingTab = false;       // flag: true while inline rename input is active (prevents trApplyView from firing)

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initTrading() {
    showLoading(true);
    trSetupEventHandlers();
    trRestoreTab();

    try {
        await trLoadData();
    } catch (error) {
        console.error('Trading: Error loading data:', error);
        showAlert('Failed to load trading data: ' + error.message, 'error');
        showLoading(false);
        return;
    }

    await trFetchLivePrices();
    trUpdateUnitLabels();
    trRenderPortfolio();
    trStartPortfolioAutoRefresh();

    // Load saved views
    await trLoadViews();

    // Re-init transactions module if already loaded (pills need data that may not have been ready)
    if (window.trTxInit && trTxLoaded) {
        window.trTxInit();
    }

    showLoading(false);
}

// ============================================================================
// EVENT HANDLERS (all via addEventListener — no inline handlers)
// ============================================================================

function trSetupEventHandlers() {
    // Tabs
    document.querySelectorAll('.trading-tab-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            trSwitchTab(btn.dataset.tab);
        });
    });

    // Header buttons
    document.getElementById('trAddTxnBtn').addEventListener('click', function() {
        trOpenAddTransaction();
    });
    document.getElementById('trRefreshBtn').addEventListener('click', trRefresh);
    document.getElementById('trToggleZeroBtn').addEventListener('click', trToggleZeroHoldings);

    // Sort headers
    document.getElementById('tr-th-company').addEventListener('click', function() { trSort('company'); });
    document.getElementById('tr-th-invested').addEventListener('click', function() { trSort('invested'); });
    document.getElementById('tr-th-daypl').addEventListener('click', function() { trSort('daypl'); });
    document.getElementById('tr-th-pl').addEventListener('click', function() { trSort('pl'); });
    document.getElementById('tr-th-value').addEventListener('click', function() { trSort('value'); });

    // Filters
    trSetupFilters();

    // Tag logic radio
    document.querySelectorAll('input[name="tr-tag-logic"]').forEach(function(r) {
        r.addEventListener('change', function() {
            trTagFilterLogic = r.value;
            trRenderPortfolio();
        });
    });

    // View Mode toggle
    document.querySelectorAll('.tr-view-mode-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.tr-view-mode-btn').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            trViewMode = btn.dataset.mode;
            trRenderPortfolio();
        });
    });

    // More dropdown toggle
    var moreBtn = document.getElementById('tr-more-btn');
    if (moreBtn) {
        moreBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            var dd = document.getElementById('tr-more-dropdown');
            dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
        });
    }

    // Update View button
    var updateBtn = document.getElementById('tr-update-view-btn');
    if (updateBtn) {
        updateBtn.addEventListener('click', function() {
            if (trActiveViewId) trUpdateCurrentView();
        });
    }

    // New blank view button
    var newViewBtn = document.getElementById('tr-new-view-btn');
    if (newViewBtn) {
        newViewBtn.addEventListener('click', function() {
            trCreateBlankView();
        });
    }

    // Save New button → show inline prompt
    var saveNewBtn = document.getElementById('tr-save-new-btn');
    if (saveNewBtn) {
        saveNewBtn.addEventListener('click', function() {
            var prompt = document.getElementById('tr-save-prompt');
            if (prompt.classList.contains('show')) {
                prompt.classList.remove('show');
            } else {
                prompt.classList.add('show');
                saveNewBtn.style.display = 'none';
                document.getElementById('tr-save-prompt-name').focus();
            }
        });
    }
    var savePromptOk = document.getElementById('tr-save-prompt-ok');
    if (savePromptOk) {
        savePromptOk.addEventListener('click', function() {
            var name = document.getElementById('tr-save-prompt-name').value.trim();
            if (name) trSaveCurrentView(name);
        });
    }
    var savePromptCancel = document.getElementById('tr-save-prompt-cancel');
    if (savePromptCancel) {
        savePromptCancel.addEventListener('click', function() {
            document.getElementById('tr-save-prompt').classList.remove('show');
            document.getElementById('tr-save-prompt-name').value = '';
            document.getElementById('tr-save-new-btn').style.display = '';
        });
    }
    // Enter key in save prompt
    var savePromptName = document.getElementById('tr-save-prompt-name');
    if (savePromptName) {
        savePromptName.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                var name = savePromptName.value.trim();
                if (name) trSaveCurrentView(name);
            } else if (e.key === 'Escape') {
                document.getElementById('tr-save-prompt').classList.remove('show');
                savePromptName.value = '';
                document.getElementById('tr-save-new-btn').style.display = '';
            }
        });
    }

    // Company column: double-click → inline search, single-click → sort
    var companyTh = document.getElementById('tr-th-company');
    if (companyTh) {
        companyTh.addEventListener('dblclick', function(e) {
            e.preventDefault();
            e.stopPropagation();
            trOpenCompanySearch();
        });
    }

    // Transactions modal close
    document.getElementById('trTxnModalClose').addEventListener('click', trCloseTxnModal);
    document.getElementById('trTxnModal').addEventListener('click', function(e) {
        if (e.target === this) trCloseTxnModal();
    });

    // Txn modal sort headers
    document.getElementById('trTxnThDate').addEventListener('click', function() { trTxnSort('date'); });
    document.getElementById('trTxnThSymbol').addEventListener('click', function() { trTxnSort('symbol'); });

    // Toggle hidden trades button
    document.getElementById('trToggleHiddenBtn').addEventListener('click', trToggleShowHidden);

    // Txn modal view toggle (List / Matching)
    document.querySelectorAll('.txn-vtog').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.txn-vtog').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            trTxnViewMode = btn.dataset.view;
            trTxnSwitchView();
        });
    });

    // Txn modal days filter
    document.getElementById('trTxnDaysFilter').addEventListener('change', function() {
        trTxnDaysFilter = parseInt(this.value) || 0;
        trTxnRefreshCurrentView();
    });

    // Txn modal FIFO/LIFO toggle
    document.querySelectorAll('.txn-mtog').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.txn-mtog').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            trTxnMatchMethod = btn.dataset.method;
            trRenderTxnMatchingView();
        });
    });

    // Edit modal close/save
    document.getElementById('trEditModalClose').addEventListener('click', trCloseEditModal);
    document.getElementById('trEditCancelBtn').addEventListener('click', trCloseEditModal);
    document.getElementById('trEditSaveBtn').addEventListener('click', trSaveEdit);
    document.getElementById('trEditModal').addEventListener('click', function(e) {
        if (e.target === this) trCloseEditModal();
    });

    // Edit modal — recalculate trader_charges when trader changes
    document.getElementById('trEditTrader').addEventListener('change', trRecalcTraderCharges);

    // Close action menus on outside click
    document.addEventListener('click', function(e) {
        if (trOpenActionMenu && !e.target.closest('.action-cell')) {
            trCloseAllActionMenus();
        }
    });

    // ESC key closes modals + company search
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            // Close company search first
            if (document.getElementById('tr-company-search-input')) {
                trCloseCompanySearch();
                return;
            }
            if (document.getElementById('trEditModal').classList.contains('show')) {
                trCloseEditModal();
            } else if (document.getElementById('trTxnModal').classList.contains('show')) {
                trCloseTxnModal();
            }
        }
    });
}

// ============================================================================
// TABS
// ============================================================================

var trWlLoaded = false;  // Whether watchlist HTML+JS have been loaded

function trSwitchTab(tabId) {
    // Notify previous tab it's being deactivated
    var prevTab = document.querySelector('.trading-tab-content.active');
    if (prevTab && prevTab.id === 'tr-watchlist' && window.trWlDestroy) {
        window.trWlDestroy();
    }
    // Stop auto-refresh for tabs being left
    if (prevTab && prevTab.id === 'tr-fno-positions' && typeof trFnoStopAutoRefresh === 'function') {
        trFnoStopAutoRefresh();
    }
    if (prevTab && prevTab.id === 'tr-portfolio' && typeof wmsStopAutoRefresh === 'function') {
        wmsStopAutoRefresh('portfolio');
    }

    document.querySelectorAll('.trading-tab-btn').forEach(function(b) { b.classList.remove('active'); });
    document.querySelectorAll('.trading-tab-content').forEach(function(c) { c.classList.remove('active'); });

    var btn = document.querySelector('.trading-tab-btn[data-tab="' + tabId + '"]');
    var content = document.getElementById(tabId);
    if (btn) btn.classList.add('active');
    if (content) content.classList.add('active');

    localStorage.setItem('wms_trading_tab', tabId);

    // Load watchlist sub-module on demand
    if (tabId === 'tr-watchlist') {
        trLoadWatchlistModule();
    }

    // Load transactions sub-module on demand
    if (tabId === 'tr-transactions') {
        trLoadTransactionsModule();
    }

    // Load F&O positions sub-module on demand
    if (tabId === 'tr-fno-positions') {
        trLoadFnoModule();
    }

    // Restart auto-refresh for the tab being entered
    if (tabId === 'tr-portfolio') {
        trStartPortfolioAutoRefresh();
    }
}

async function trLoadWatchlistModule() {
    var container = document.getElementById('tr-watchlist-container');
    if (!container) return;

    if (!trWlLoaded) {
        try {
            // Load HTML
            var htmlResp = await fetch('trading-watchlist.html?t=' + Date.now());
            if (!htmlResp.ok) throw new Error('Failed to load trading-watchlist.html');
            var htmlText = await htmlResp.text();

            // Extract <style> and inject to <head>
            var parser = new DOMParser();
            var doc = parser.parseFromString(htmlText, 'text/html');
            var styles = doc.querySelectorAll('style');
            styles.forEach(function(s) { document.head.appendChild(s.cloneNode(true)); });

            // Inject body content
            container.innerHTML = doc.body ? doc.body.innerHTML : htmlText;

            // Load JS
            await new Promise(function(resolve, reject) {
                var script = document.createElement('script');
                script.src = 'trading-watchlist.js?t=' + Date.now();
                script.onload = resolve;
                script.onerror = function() { reject(new Error('Failed to load trading-watchlist.js')); };
                document.body.appendChild(script);
            });

            trWlLoaded = true;
        } catch (err) {
            console.error('Trading: Failed to load watchlist module:', err);
            container.innerHTML = '<div style="text-align:center;padding:60px;color:#dc2626;">Failed to load watchlist: ' + err.message + '</div>';
            return;
        }
    }

    // Initialize or re-activate watchlist
    if (window.trWlInit) {
        window.trWlInit();
    }
}

function trRestoreTab() {
    var saved = localStorage.getItem('wms_trading_tab');
    trSwitchTab(saved || 'tr-watchlist');
}

// ============================================================================
// DATA LOADING
// ============================================================================

async function trLoadData() {
    var headers = { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY };

    // Load ALL transactions (no transaction_type filter — includes DIVIDEND, etc.)
    var resp = await fetchWithTimeout(SUPABASE_URL + '/rest/v1/transactions?select=id,investor_id,trader_id,broker_id,security_id,security_type,symbol,short_symbol,company_name,exchange,product,transaction_type,transaction_date,quantity,lots,price,gross_amount,net_amount,brokerage,stt,other_charges,gst,tds,total_charges,trader_charges,margin_blocked,broker_contract_note_no,broker_trade_id,tags,notes,is_locked,ignore_for_avg_cost,dont_display&order=transaction_date.asc', {
        headers: headers
    });
    if (!resp.ok) throw new Error('Failed to load transactions: HTTP ' + resp.status);
    var txnData = await resp.json();
    console.log('Trading: Loaded ' + txnData.length + ' transactions (all types)');

    trTransactions = wmsSanitizeTransactions(txnData);

    // Build comprehensive search text for each transaction (Rule B.9.2)
    trTransactions.forEach(function(txn) {
        txn._searchText = wmsBuildSecuritySearchText({
            securityId: txn.security_id, symbol: txn.symbol,
            shortSymbol: txn.short_symbol, companyName: txn.company_name
        });
    });

    // Use shared reference data for investors and brokers (loaded at app startup)
    if (!wmsRefData.ready) await wmsLoadRefData();
    trInvestors = wmsRefData.investors;
    trBrokers = wmsRefData.brokers;

    trInitFilterPills();
}

async function trRefresh() {
    showLoading(true);
    try {
        await trLoadData();
    } catch (error) {
        showAlert('Failed to refresh: ' + error.message, 'error');
        showLoading(false);
        return;
    }
    await trFetchLivePrices();
    trRenderPortfolio();
    showLoading(false);
    showAlert('Refreshed', 'success', 2000);
}

// ============================================================================
// HELPER: investor / broker display names
// ============================================================================

function trInvName(investorId) {
    var inv = trInvestors.find(function(i) { return i.id === investorId; });
    return inv ? (inv.short_name || inv.name) : 'Unknown';
}

function trBrkCode(brokerId) {
    var brk = trBrokers.find(function(b) { return b.id === brokerId; });
    return brk ? (brk.broker_code || brk.name) : '';
}

function trInvBrk(txn) {
    var inv = trInvName(txn.investor_id);
    var trd = txn.trader_id ? trInvName(txn.trader_id) : '';
    var brk = trBrkCode(txn.broker_id);
    var parts = [inv];
    if (trd && trd !== inv) parts.push(trd);
    if (brk) parts.push(brk);
    return parts.join(' > ');
}

// ============================================================================
// LIVE PRICES FROM FYERS
// ============================================================================

function trGetPrice(h) {
    var sym = h.shortSymbol || h.symbol;
    var cached = wmsLivePrices[sym];
    if (cached && cached.lp > 0) return cached.lp;
    // Legacy fallback to module-level cache (for backward compat)
    var fk = 'NSE:' + sym + '-EQ';
    if (trLivePrices[fk]) return trLivePrices[fk];
    // PE security fallback: use avg cost as CMP when no live price available
    if (h.isin && h.isin.startsWith('PE-') && h.avgCost > 0) return h.avgCost;
    return h.latestPrice;
}

function trGetLiveData(h) {
    var sym = h.shortSymbol || h.symbol;
    var cached = wmsLivePrices[sym];
    if (cached && cached.lp > 0) return cached;
    // Legacy fallback
    var fk = 'NSE:' + sym + '-EQ';
    return trLiveData[fk] || null;
}

async function trFetchLivePrices(forceRefresh) {
    try {
        if (!window.fyersToken) {
            trUpdatePriceStatus('last-txn');
            return;
        }
        var holdings = trCalcHoldings();
        if (holdings.length === 0) {
            trUpdatePriceStatus('last-txn');
            return;
        }

        // Build items for shared price fetch
        var priceItems = holdings.map(function(h) {
            return { shortSymbol: h.shortSymbol, securityId: h.securityId };
        });

        if (!forceRefresh) trUpdatePriceStatus('loading');
        await wmsFetchEquityPrices(priceItems, forceRefresh);

        // Check if any prices were loaded
        var hasLive = holdings.some(function(h) {
            var cached = wmsLivePrices[h.shortSymbol];
            return cached && cached.lp > 0;
        });
        trUpdatePriceStatus(hasLive ? 'live' : 'last-txn');
    } catch (err) {
        console.warn('Trading: Price fetch failed:', err.message || err);
        trUpdatePriceStatus('last-txn');
    }
}

function trUpdatePriceStatus(status) {
    var el = document.getElementById('tr-price-status');
    if (!el) return;
    var now = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    if (status === 'live') {
        el.innerHTML = '🟢 Live prices as of ' + now;
        el.style.color = '#059669';
    } else if (status === 'loading') {
        el.innerHTML = '⏳ Fetching live prices...';
        el.style.color = '#667eea';
    } else {
        el.innerHTML = '🟡 Last transaction prices';
        el.style.color = '#d97706';
    }
}

// ============================================================================
// PORTFOLIO AUTO-REFRESH (Rule D.12.11)
// Uses shared wmsStartAutoRefresh from wms-shared.js
// ============================================================================

function trStartPortfolioAutoRefresh() {
    if (typeof wmsStartAutoRefresh !== 'function') return;
    wmsStartAutoRefresh('portfolio', {
        interval: 10000,
        fetchFn: function(force) { return trFetchLivePrices(force); },
        renderFn: function() {
            trRenderPortfolio();
            var now = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
            trUpdatePriceStatus('live');
        },
        isActiveFn: function() {
            var tab = document.getElementById('tr-portfolio');
            return tab && tab.classList.contains('active');
        },
        onMarketClose: function() {
            trUpdatePriceStatus('last-txn');
        }
    });
}

// ============================================================================
// UNIT LABELS
// ============================================================================

function trUpdateUnitLabels() {
    var el = document.getElementById('tr-unit-desc');
    if (el) el.textContent = 'all amounts in ' + getUnitDescription();
}

// ============================================================================
// TOGGLE ZERO HOLDINGS
// ============================================================================

function trToggleZeroHoldings() {
    trShowZeroHoldings = !trShowZeroHoldings;
    var btn = document.getElementById('trToggleZeroBtn');
    if (btn) {
        btn.textContent = trShowZeroHoldings ? '👁 Hide Zero Holdings' : '👁 Show Zero Holdings';
        btn.classList.toggle('active', trShowZeroHoldings);
    }
    trRenderPortfolio();
}

// ============================================================================
// FILTERS (same pattern as portfolio.js, with short_name / broker_code labels)
// ============================================================================

function trInitFilterPills() {
    // Investor filter
    var invContainer = document.getElementById('tr-filter-investor');
    if (invContainer) {
        var invItems = trInvestors.map(function(inv) { return {id: inv.id, label: inv.short_name || inv.name, searchText: (inv.name || '') + ' ' + (inv.short_name || '')}; });
        trInvPillFilter = wmsPillSearch(invContainer, {
            label: 'Filter by Investor',
            placeholder: 'Type to search investors...',
            items: invItems,
            selectedIds: trSelectedInvestorIds,
            onChange: function() { trRenderPortfolio(); }
        });
    }

    // Trader filter (same investors list)
    var trdContainer = document.getElementById('tr-filter-trader');
    if (trdContainer) {
        var trdItems = trInvestors.map(function(inv) { return {id: inv.id, label: inv.short_name || inv.name, searchText: (inv.name || '') + ' ' + (inv.short_name || '')}; });
        trTrdPillFilter = wmsPillSearch(trdContainer, {
            label: 'Filter by Trader',
            placeholder: 'Type to search traders...',
            items: trdItems,
            selectedIds: trSelectedTraderIds,
            onChange: function() { trRenderPortfolio(); }
        });
    }

    // Broker filter
    var brkContainer = document.getElementById('tr-filter-broker');
    if (brkContainer) {
        var brkItems = trBrokers.map(function(b) { return {id: b.id, label: b.broker_code || b.name, searchText: (b.name || '') + ' ' + (b.broker_code || '')}; });
        trBrkPillFilter = wmsPillSearch(brkContainer, {
            label: 'Filter by Broker',
            placeholder: 'Type to search brokers...',
            items: brkItems,
            selectedIds: trSelectedBrokerIds,
            onChange: function() { trRenderPortfolio(); }
        });
    }

    // Tag filter (built from transactions)
    var allTags = {};
    trTransactions.forEach(function(t) {
        if (t.tags) t.tags.forEach(function(tag) { if (tag !== 'blank') allTags[tag] = true; });
    });
    var tagContainer = document.getElementById('tr-filter-tag');
    if (tagContainer) {
        var tagItems = Object.keys(allTags).sort().map(function(tag) { return {id: tag, label: tag}; });
        // Build tag-logic radios as headerExtra
        var tagExtra = document.createElement('div');
        tagExtra.className = 'tag-match-options';
        tagExtra.innerHTML =
            '<span style="font-size:11px;color:#718096;">Match:</span>' +
            '<label class="radio-label"><input type="radio" name="tr-tag-logic" value="OR" checked> <span>Any</span></label>' +
            '<label class="radio-label"><input type="radio" name="tr-tag-logic" value="AND"> <span>All</span></label>';
        trTagPillFilter = wmsPillSearch(tagContainer, {
            label: 'Filter by Tag',
            placeholder: 'Type to search tags...',
            items: tagItems,
            selectedIds: trSelectedTagNames,
            onChange: function() { trRenderPortfolio(); },
            headerExtra: tagExtra
        });
    }
}

function trGetFilterArray(type) {
    if (type === 'investor') return trSelectedInvestorIds;
    if (type === 'trader') return trSelectedTraderIds;
    if (type === 'broker') return trSelectedBrokerIds;
    return trSelectedTagNames;
}

function trAttachPillListeners() {
    // Functionality now handled by wmsPillFilter — kept for compatibility
}

function trSetupFilters() {
    // Clear buttons now handled internally by wmsPillSearch

    // Close More dropdown on outside click (keep existing More dropdown logic)
    document.addEventListener('click', function(e) {
        if (!e.target.closest('#tr-more-btn') && !e.target.closest('#tr-more-dropdown')) {
            var mdd = document.getElementById('tr-more-dropdown');
            if (mdd) mdd.style.display = 'none';
        }
    });
}

function trRenderSelectedTags(type) {
    // Delegate to pill filter controller's renderSelectedTags method
    if (type === 'investor' && trInvPillFilter) {
        trInvPillFilter.renderSelectedTags();
    } else if (type === 'trader' && trTrdPillFilter) {
        trTrdPillFilter.renderSelectedTags();
    } else if (type === 'broker' && trBrkPillFilter) {
        trBrkPillFilter.renderSelectedTags();
    } else if ((type === 'tag' || !type) && trTagPillFilter) {
        trTagPillFilter.renderSelectedTags();
    }
}

function trSyncPillStates(type) {
    // Delegate to pill filter controller's syncStates method
    if (type === 'investor' && trInvPillFilter) {
        trInvPillFilter.syncStates();
    } else if (type === 'trader' && trTrdPillFilter) {
        trTrdPillFilter.syncStates();
    } else if (type === 'broker' && trBrkPillFilter) {
        trBrkPillFilter.syncStates();
    } else if ((type === 'tag' || !type) && trTagPillFilter) {
        trTagPillFilter.syncStates();
    }
}

// ============================================================================
// HOLDINGS CALCULATION
// ============================================================================

function trCalcHoldings() {
    // Filter transactions (only non-hidden for portfolio display)
    var filtered = trTransactions.filter(function(t) { return !t.dont_display; });

    if (trSelectedInvestorIds.length > 0) {
        filtered = filtered.filter(function(t) { return trSelectedInvestorIds.indexOf(t.investor_id) >= 0; });
    }
    if (trSelectedTraderIds.length > 0) {
        filtered = filtered.filter(function(t) { return t.trader_id && trSelectedTraderIds.indexOf(t.trader_id) >= 0; });
    }
    if (trSelectedBrokerIds.length > 0) {
        filtered = filtered.filter(function(t) { return t.broker_id && trSelectedBrokerIds.indexOf(t.broker_id) >= 0; });
    }
    if (trSelectedTagNames.length > 0) {
        if (trTagFilterLogic === 'AND') {
            filtered = filtered.filter(function(t) {
                return trSelectedTagNames.every(function(tag) { return t.tags && t.tags.indexOf(tag) >= 0; });
            });
        } else {
            filtered = filtered.filter(function(t) {
                return t.tags && t.tags.some(function(tag) { return trSelectedTagNames.indexOf(tag) >= 0; });
            });
        }
    }

    // View Mode filter
    if (trViewMode === 'holdings') {
        // Exclude F&O transactions (NFO exchange)
        filtered = filtered.filter(function(t) { return t.exchange !== 'NFO'; });
    } else if (trViewMode === 'fno') {
        // Only F&O transactions
        filtered = filtered.filter(function(t) { return t.exchange === 'NFO'; });
    }

    // Group by short_symbol (underlying) — combines equity + F&O
    var groups = {};
    filtered.forEach(function(txn) {
        var key = txn.short_symbol || txn.symbol;
        if (!key) return;

        if (!groups[key]) {
            // Only use company_name from equity txns (NFO names are contract names like "MANAPPURAM 26 Feb 24 FUT")
            // Check security_type (not exchange) — NFO txns can have exchange='NSE'
            var isNFO = txn.security_type === 'NFO';
            var initName = (!isNFO && txn.company_name) ? txn.company_name : null;
            groups[key] = {
                symbol: txn.symbol,
                shortSymbol: txn.short_symbol || txn.symbol,
                companyName: initName,
                securityId: txn.security_id,
                exchange: txn.exchange || 'NSE',
                tags: {},
                latestPrice: 0,
                latestDate: null,
                txns: []
            };
        }

        groups[key].txns.push(txn);

        // Prefer NSE exchange for Fyers lookup
        if ((txn.exchange || 'NSE') === 'NSE') {
            groups[key].exchange = 'NSE';
        }
        // Use company_name from equity txn (not F&O contract name)
        if (txn.company_name && txn.security_type !== 'NFO' && !groups[key].companyName) {
            groups[key].companyName = txn.company_name;
        }

        if (txn.tags) txn.tags.forEach(function(tag) { if (tag !== 'blank') groups[key].tags[tag] = true; });
        var isIncome = INCOME_TYPES.indexOf(txn.transaction_type) >= 0;
        var txnDate = new Date(txn.transaction_date);
        if (!isIncome && (!groups[key].latestDate || txnDate > groups[key].latestDate)) {
            groups[key].latestDate = txnDate;
            groups[key].latestPrice = txn.price;
        }
    });

    // Resolve company names from CM securities master for groups without an equity company name
    Object.keys(groups).forEach(function(key) {
        var g = groups[key];
        if (!g.companyName) {
            // Try wmsRefData CM securities
            if (wmsRefData.securitiesCmReady) {
                for (var i = 0; i < wmsRefData.securitiesCm.length; i++) {
                    var s = wmsRefData.securitiesCm[i];
                    if (s.symbol === g.shortSymbol || s.nse_symbol === g.shortSymbol || s.bse_symbol === g.shortSymbol) {
                        g.companyName = s.company_name || g.shortSymbol;
                        break;
                    }
                }
            }
            // Final fallback: use shortSymbol if nothing found
            if (!g.companyName) g.companyName = g.shortSymbol;
        }
    });

    return Object.keys(groups).map(function(key) {
        var g = groups[key];
        // Use consolidated global function (Spec A1)
        // Open options exclusion is built into wmsCalcAvgCost (Rule E.12)
        var calc = wmsCalcAvgCost(g.txns);
        if (!trShowZeroHoldings && calc.netQuantity === 0) return null;
        // Resolve ISIN from securities master (needed for PE- fallback pricing)
        var _secMaster = g.securityId && wmsRefData.securitiesCmMap[g.securityId];
        var rec = {
            key: key,
            symbol: g.symbol,
            shortSymbol: g.shortSymbol,
            companyName: g.companyName,
            securityId: g.securityId,
            isin: _secMaster ? _secMaster.isin : null,
            exchange: g.exchange,
            quantity: calc.netQuantity,
            totalCost: calc.totalCost,
            avgCost: calc.avgCost,
            tags: Object.keys(g.tags),
            latestPrice: g.latestPrice
        };
        // Build comprehensive search text from wmsRefData (Rule B.9.2)
        rec._searchText = wmsBuildSecuritySearchText({
            securityId: g.securityId, symbol: g.symbol,
            shortSymbol: g.shortSymbol, companyName: g.companyName
        });
        return rec;
    }).filter(function(h) { return h !== null; });
}

// ============================================================================
// SORTING
// ============================================================================

function trSort(column) {
    var isPL = (column === 'pl' || column === 'daypl');
    if (trSortColumn === column) {
        if (isPL && !trSortByPct) { trSortByPct = true; }
        else if (isPL && trSortByPct) { trSortByPct = false; trSortDirection = trSortDirection === 'asc' ? 'desc' : 'asc'; }
        else { trSortDirection = trSortDirection === 'asc' ? 'desc' : 'asc'; }
    } else {
        trSortColumn = column;
        trSortDirection = 'asc';
        trSortByPct = false;
    }
    trRenderPortfolio();
}

function trUpdateSortIndicators() {
    document.querySelectorAll('#tr-portfolio-table .sort-indicator').forEach(function(el) { el.textContent = ''; });
    var indicator = document.getElementById('tr-sort-' + trSortColumn);
    if (indicator) {
        var arrow = trSortDirection === 'asc' ? '▲' : '▼';
        var label = (trSortByPct && (trSortColumn === 'pl' || trSortColumn === 'daypl')) ? '%' : '';
        indicator.textContent = label + arrow;
    }
}

// ============================================================================
// SLIDER HELPER
// ============================================================================

function trBuildSlider(current, low, high, lo, hi) {
    if (!low || !high || high <= low) return '';
    var pct = Math.min(100, Math.max(0, ((current - low) / (high - low)) * 100));
    var dotColor = pct >= 50 ? '#059669' : '#dc2626';
    return '<div class="price-slider">' +
        '<div class="price-slider-track">' +
        '<div class="price-slider-dot" style="left:' + pct.toFixed(1) + '%;background:' + dotColor + ';"></div>' +
        '</div>' +
        '<div class="slider-tooltip"><span>' + lo + '</span><span>' + hi + '</span></div>' +
        '</div>';
}

// ============================================================================
// PORTFOLIO RENDERING
// ============================================================================

function trRenderPortfolio() {
    var list = document.getElementById('tr-portfolio-list');
    if (!list) return;

    var holdings = trCalcHoldings();

    // Inline company search filter (uses enriched _searchText from wmsRefData)
    if (trCompanySearchText) {
        var tokens = wmsTokenize(trCompanySearchText);
        holdings = holdings.filter(function(h) {
            return wmsMultiTokenMatch(tokens, h._searchText);
        });
    }

    if (holdings.length === 0) {
        if (list) list.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:#9ca3af;">No holdings to display</td></tr>';
        var summaryEl = document.getElementById('tr-portfolio-summary');
        if (summaryEl) summaryEl.innerHTML = '';
        trUpdateSortIndicators();
        return;
    }

    // Totals
    var totalInvested = 0, totalValue = 0;
    holdings.forEach(function(h) {
        var price = trGetPrice(h);
        totalInvested += h.totalCost;
        totalValue += h.quantity * price;
    });
    var totalPL = totalValue - totalInvested;
    var totalPLPct = totalInvested !== 0 ? (totalPL / Math.abs(totalInvested)) * 100 : 0;

    // Sort
    holdings.sort(function(a, b) {
        var valA, valB;
        var prA = trGetPrice(a), prB = trGetPrice(b);
        var mdA = trGetLiveData(a), mdB = trGetLiveData(b);
        switch (trSortColumn) {
            case 'company':
                valA = (a.companyName || a.shortSymbol || '').toLowerCase();
                valB = (b.companyName || b.shortSymbol || '').toLowerCase();
                return trSortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
            case 'invested':
                valA = a.totalCost; valB = b.totalCost; break;
            case 'pl':
                if (trSortByPct) {
                    valA = a.totalCost !== 0 ? ((a.quantity * prA - a.totalCost) / Math.abs(a.totalCost)) * 100 : 0;
                    valB = b.totalCost !== 0 ? ((b.quantity * prB - b.totalCost) / Math.abs(b.totalCost)) * 100 : 0;
                } else {
                    valA = (a.quantity * prA) - a.totalCost;
                    valB = (b.quantity * prB) - b.totalCost;
                }
                break;
            case 'daypl':
                if (trSortByPct) {
                    valA = mdA ? mdA.chp : 0; valB = mdB ? mdB.chp : 0;
                } else {
                    valA = mdA ? a.quantity * mdA.ch : 0; valB = mdB ? b.quantity * mdB.ch : 0;
                }
                break;
            case 'value':
                valA = a.quantity * prA; valB = b.quantity * prB; break;
            default:
                valA = (a.companyName || '').toLowerCase(); valB = (b.companyName || '').toLowerCase();
                return trSortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        return trSortDirection === 'asc' ? valA - valB : valB - valA;
    });

    // Render rows
    var rows = holdings.map(function(h) {
        var price = trGetPrice(h);
        var md = trGetLiveData(h);
        var invested = h.totalCost;
        var currentValue = h.quantity * price;
        var pl = currentValue - invested;
        var plPct = invested !== 0 ? (pl / Math.abs(invested)) * 100 : 0;
        var invPct = totalInvested !== 0 ? (invested / Math.abs(totalInvested)) * 100 : 0;
        var valPct = totalValue !== 0 ? (currentValue / Math.abs(totalValue)) * 100 : 0;
        var dayPL = md ? h.quantity * md.ch : null;
        var dayChp = md ? md.chp : null;

        var cmpSlider = (md && md.high && md.low)
            ? trBuildSlider(md.lp, md.low, md.high, formatPrice(md.low, false), formatPrice(md.high, false))
            : '';

        var qtyHtml = h.quantity < 0
            ? '<div class="number-main negative">(' + formatQuantity(Math.abs(h.quantity)) + ')</div>'
            : '<div class="number-main">' + formatQuantity(h.quantity) + '</div>';

        var symbolKey = h.key;
        var isExpanded = trExpandedKey === symbolKey;
        var expClass = isExpanded ? 'expanded-row' : '';

        var dayPLHtml = dayPL !== null
            ? '<div class="number-main ' + getAmountClass(dayPL) + '">' + formatAmount(dayPL) + '</div>' +
              '<div class="number-sub ' + getAmountClass(dayChp) + '">' + formatPercent(dayChp) + '</div>'
            : '<div class="number-main">-</div>';

        // Tags pills
        var tagsPills = h.tags.length > 0
            ? '<div class="tag-pills">' + h.tags.map(function(t) { return '<span class="tag-pill">' + t + '</span>'; }).join('') + '</div>'
            : '';

        var menuSafeKey = symbolKey.replace(/[^a-zA-Z0-9]/g, '_');

        var mainRow =
            '<tr class="' + expClass + '">' +
                '<td class="company-cell">' +
                    '<div class="company-main" data-key="' + symbolKey + '" title="' + wmsEsc(h.companyName || h.shortSymbol) + '">' + wmsEsc(h.companyName || h.shortSymbol) + '</div>' +
                    '<div class="company-sub">' + wmsEsc(h.shortSymbol) + '</div>' +
                '</td>' +
                '<td class="text-right">' + qtyHtml +
                    '<div class="number-sub">' + formatPrice(h.avgCost, false) + '</div></td>' +
                '<td class="text-right">' +
                    '<div class="number-main">' + formatAmount(invested) + '</div>' +
                    '<div class="number-sub">' + invPct.toFixed(1) + '%</div></td>' +
                '<td class="text-right">' +
                    '<div class="number-main">' + formatPrice(price, false) + '</div>' + cmpSlider + '</td>' +
                '<td class="text-right">' + dayPLHtml + '</td>' +
                '<td class="text-right">' +
                    '<div class="number-main ' + getAmountClass(pl) + '">' + formatAmount(pl) + '</div>' +
                    '<div class="number-sub ' + getAmountClass(plPct) + '">' + formatPercent(plPct) + '</div></td>' +
                '<td class="text-right">' +
                    '<div class="number-main">' + formatAmount(currentValue) + '</div>' +
                    '<div class="number-sub">' + valPct.toFixed(1) + '%</div></td>' +
                '<td>' + tagsPills + '</td>' +
                '<td class="action-cell">' +
                    '<button class="btn-action" data-key="' + symbolKey + '" title="Actions">⋮</button>' +
                    '<div class="action-menu" id="am-' + menuSafeKey + '">' +
                        '<button class="action-menu-item" data-action="transactions" data-key="' + symbolKey + '">📋 Show Transactions</button>' +
                    '</div>' +
                '</td>' +
            '</tr>';

        var detailRow = '';
        if (isExpanded) {
            detailRow = trBuildInvestorDetail(h, price, md);
        }

        return mainRow + detailRow;
    }).join('');

    // Total row
    var totalDayPL = (Object.keys(wmsLivePrices).length > 0 || Object.keys(trLiveData).length > 0)
        ? holdings.reduce(function(sum, h) { var m = trGetLiveData(h); return sum + (m ? h.quantity * m.ch : 0); }, 0)
        : null;
    var totalDayPLPct = (totalDayPL !== null && totalInvested !== 0)
        ? (totalDayPL / Math.abs(totalInvested)) * 100 : null;

    var totalDayPLHtml = totalDayPL !== null
        ? '<div class="number-main ' + getAmountClass(totalDayPL) + '">' + formatAmount(totalDayPL) + '</div>' +
          '<div class="number-sub ' + getAmountClass(totalDayPLPct) + '">' + formatPercent(totalDayPLPct) + '</div>'
        : '-';

    var totalRow =
        '<tr class="total-row">' +
            '<td>TOTAL</td>' +
            '<td class="text-right">' + holdings.length + ' stocks</td>' +
            '<td class="text-right">' + formatAmount(totalInvested) + '</td>' +
            '<td class="text-right">-</td>' +
            '<td class="text-right">' + totalDayPLHtml + '</td>' +
            '<td class="text-right"><div class="number-main ' + getAmountClass(totalPL) + '">' + formatAmount(totalPL) + '</div>' +
                '<div class="number-sub ' + getAmountClass(totalPLPct) + '">' + formatPercent(totalPLPct) + '</div></td>' +
            '<td class="text-right">' + formatAmount(totalValue) + '</td>' +
            '<td>-</td>' +
            '<td class="action-cell">' +
                '<button class="btn-action" data-key="__ALL__" title="Actions">⋮</button>' +
                '<div class="action-menu" id="am-__ALL__">' +
                    '<button class="action-menu-item" data-action="transactions" data-key="__ALL__">📋 Show Transactions</button>' +
                '</div>' +
            '</td>' +
        '</tr>';

    list.innerHTML = totalRow + rows;
    trUpdateSortIndicators();
    trAttachRowListeners();
}

// ============================================================================
// ATTACH LISTENERS TO DYNAMIC ROWS
// ============================================================================

function trAttachRowListeners() {
    // Company name click → expand
    document.querySelectorAll('.company-main[data-key]').forEach(function(el) {
        el.addEventListener('click', function() {
            var key = el.dataset.key;
            trExpandedKey = (trExpandedKey === key) ? null : key;
            trRenderPortfolio();
        });
    });

    // Action buttons (company level)
    document.querySelectorAll('.btn-action[data-key]').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            trToggleActionMenu(btn.dataset.key);
        });
    });

    // Action menu items (company level)
    document.querySelectorAll('.action-menu-item[data-action]').forEach(function(item) {
        item.addEventListener('click', function(e) {
            e.stopPropagation();
            trCloseAllActionMenus();
            if (item.dataset.action === 'transactions') {
                trOpenTxnModal(item.dataset.key, item.dataset.investorId || null);
            }
        });
    });

    // Investor breakdown — name click opens txn modal
    document.querySelectorAll('.investor-name-link').forEach(function(el) {
        el.addEventListener('click', function(e) {
            e.stopPropagation();
            trOpenTxnModal(el.dataset.key, el.dataset.investorId);
        });
    });

    // Investor breakdown — action buttons
    document.querySelectorAll('.inv-action-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var menuId = btn.dataset.menuId;
            var menu = document.getElementById(menuId);
            if (!menu) return;
            var wasOpen = menu.classList.contains('show');
            trCloseAllActionMenus();
            if (!wasOpen) {
                menu.classList.add('show');
                trOpenActionMenu = menuId;
            }
        });
    });
}

// ============================================================================
// ACTION MENU
// ============================================================================

function trToggleActionMenu(key) {
    var menuId = 'am-' + key.replace(/[^a-zA-Z0-9]/g, '_');
    var menu = document.getElementById(menuId);
    if (!menu) return;

    var wasOpen = menu.classList.contains('show');
    trCloseAllActionMenus();
    if (!wasOpen) {
        menu.classList.add('show');
        trOpenActionMenu = menuId;
    }
}

function trCloseAllActionMenus() {
    document.querySelectorAll('.action-menu.show').forEach(function(m) { m.classList.remove('show'); });
    trOpenActionMenu = null;
}

// ============================================================================
// INVESTOR DETAIL (expandable row) — with actions
// ============================================================================

function trBuildInvestorDetail(h, price, md) {
    // Apply the same filters as trCalcHoldings so detail rows respect active filters
    var symbolTxns = trTransactions.filter(function(txn) {
        return !txn.dont_display && (txn.short_symbol || txn.symbol) === h.shortSymbol;
    });
    if (trSelectedInvestorIds.length > 0) {
        symbolTxns = symbolTxns.filter(function(t) { return trSelectedInvestorIds.indexOf(t.investor_id) >= 0; });
    }
    if (trSelectedTraderIds.length > 0) {
        symbolTxns = symbolTxns.filter(function(t) { return t.trader_id && trSelectedTraderIds.indexOf(t.trader_id) >= 0; });
    }
    if (trSelectedBrokerIds.length > 0) {
        symbolTxns = symbolTxns.filter(function(t) { return t.broker_id && trSelectedBrokerIds.indexOf(t.broker_id) >= 0; });
    }
    if (trSelectedTagNames.length > 0) {
        if (trTagFilterLogic === 'AND') {
            symbolTxns = symbolTxns.filter(function(t) {
                return trSelectedTagNames.every(function(tag) { return t.tags && t.tags.indexOf(tag) >= 0; });
            });
        } else {
            symbolTxns = symbolTxns.filter(function(t) {
                return t.tags && t.tags.some(function(tag) { return trSelectedTagNames.indexOf(tag) >= 0; });
            });
        }
    }
    // View Mode filter
    if (trViewMode === 'holdings') {
        symbolTxns = symbolTxns.filter(function(t) { return t.exchange !== 'NFO'; });
    } else if (trViewMode === 'fno') {
        symbolTxns = symbolTxns.filter(function(t) { return t.exchange === 'NFO'; });
    }

    // Group transactions by investor, then use wmsCalcAvgCost per investor
    var groups = {};
    symbolTxns.forEach(function(txn) {
        if (!groups[txn.investor_id]) {
            groups[txn.investor_id] = {
                investorId: txn.investor_id,
                name: trInvName(txn.investor_id),
                tags: {},
                txns: []
            };
        }
        groups[txn.investor_id].txns.push(txn);
        if (txn.tags) txn.tags.forEach(function(tag) { if (tag !== 'blank') groups[txn.investor_id].tags[tag] = true; });
    });

    var investorRows = Object.values(groups)
        .map(function(g) {
            var calc = wmsCalcAvgCost(g.txns);
            g.quantity = calc.netQuantity;
            g.totalCost = calc.totalCost;
            g.avgCost = calc.avgCost;
            return g;
        })
        .filter(function(g) { return g.txns.length > 0; })
        .map(function(g) {
            var avg = g.avgCost;
            var inv = g.totalCost;
            var val = g.quantity * price;
            var pl = val - inv;
            var plPct = inv !== 0 ? (pl / Math.abs(inv)) * 100 : 0;
            var dayPL = md ? g.quantity * md.ch : null;
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
                ? '<div class="tag-pills">' + invTags.map(function(t) { return '<span class="tag-pill">' + t + '</span>'; }).join('') + '</div>'
                : '';

            var invMenuId = 'inv-am-' + g.investorId.substring(0, 8) + '-' + h.key.replace(/[^a-zA-Z0-9]/g, '_');

            return '<tr>' +
                '<td><span class="investor-name-link" data-key="' + h.key + '" data-investor-id="' + g.investorId + '">' + g.name + '</span></td>' +
                '<td class="text-right">' + qtyHtml + '<div class="number-sub">' + formatPrice(avg, false) + '</div></td>' +
                '<td class="text-right"><div class="number-main">' + formatAmount(inv) + '</div></td>' +
                '<td class="text-right"><div class="number-main">' + formatPrice(price, false) + '</div></td>' +
                '<td class="text-right">' + dayPLHtml + '</td>' +
                '<td class="text-right"><div class="number-main ' + getAmountClass(pl) + '">' + formatAmount(pl) + '</div><div class="number-sub ' + getAmountClass(plPct) + '">' + formatPercent(plPct) + '</div></td>' +
                '<td class="text-right"><div class="number-main">' + formatAmount(val) + '</div></td>' +
                '<td>' + tagsPills + '</td>' +
                '<td class="action-cell">' +
                    '<button class="btn-action inv-action-btn" data-menu-id="' + invMenuId + '" title="Actions">⋮</button>' +
                    '<div class="action-menu" id="' + invMenuId + '">' +
                        '<button class="action-menu-item" data-action="transactions" data-key="' + h.key + '" data-investor-id="' + g.investorId + '">📋 Show Transactions</button>' +
                    '</div>' +
                '</td>' +
            '</tr>';
        }).join('');

    return '<tr class="detail-row"><td colspan="9"><table class="inner-table"><tbody>' + investorRows + '</tbody></table></td></tr>';
}

// ============================================================================
// SUMMARY CARDS
// ============================================================================

// Summary cards removed — TOTAL row in the table already shows all summary info

// ============================================================================
// TRANSACTIONS MODAL
// ============================================================================

function trOpenTxnModal(companyKey, investorId) {
    trCurrentTxnModalKey = companyKey;
    trCurrentTxnInvestorId = investorId || null;
    trTxnHiddenIds = {};
    trShowHiddenTrades = false;
    trTxnFnoPricesFetched = false;

    var txns = trGetTxnModalTxns();

    // Resolve title
    var companyName = '';
    var titleExtra = '';
    if (companyKey === '__ALL__') {
        // Portfolio-level: use active view name
        var activeView = trPortfolioViews.find(function(v) { return v.id === trActiveViewId; });
        companyName = 'All Transactions';
        titleExtra = activeView ? ' <span style="font-size:11px;color:#667eea;">(' + wmsEsc(activeView.name) + ')</span>' : '';
    } else {
        // Company-level: prefer equity txn, then CM master, then shortSymbol
        for (var i = 0; i < txns.length; i++) {
            if (txns[i].company_name && txns[i].security_type !== 'NFO') {
                companyName = txns[i].company_name; break;
            }
        }
        if (!companyName && wmsRefData.securitiesCmReady) {
            for (var j = 0; j < wmsRefData.securitiesCm.length; j++) {
                var s = wmsRefData.securitiesCm[j];
                if (s.symbol === companyKey || s.nse_symbol === companyKey || s.bse_symbol === companyKey) {
                    companyName = s.company_name; break;
                }
            }
        }
        companyName = companyName || companyKey;
        if (investorId) {
            titleExtra = ' <span style="font-size:11px;color:#667eea;">(' + trInvName(investorId) + ')</span>';
        }
    }
    document.getElementById('trTxnModalTitle').innerHTML = wmsEsc(companyName) +
        (companyKey !== '__ALL__' ? '<span class="company-sub">' + wmsEsc(companyKey) + '</span>' : '') + titleExtra;

    // Reset sort
    trTxnSortColumn = 'date';
    trTxnSortDirection = 'asc';

    // Reset view mode
    trTxnViewMode = 'list';
    trTxnDaysFilter = 0;
    trTxnMatchMethod = 'lifo';
    trTxnContractFilter = [];

    // Update toggle button
    var toggleBtn = document.getElementById('trToggleHiddenBtn');
    toggleBtn.classList.remove('active');
    toggleBtn.textContent = '👁 Show All';

    // Reset controls UI
    document.querySelectorAll('.txn-vtog').forEach(function(b) { b.classList.toggle('active', b.dataset.view === 'list'); });
    document.getElementById('trTxnDaysFilter').value = '0';
    document.querySelectorAll('.txn-mtog').forEach(function(b) { b.classList.toggle('active', b.dataset.method === 'lifo'); });
    document.getElementById('trTxnMatchMethodWrap').style.display = 'none';
    document.getElementById('trToggleHiddenBtn').style.display = '';

    // Show list, hide matching
    document.getElementById('trTxnListView').style.display = '';
    document.getElementById('trTxnMatchView').style.display = 'none';
    // Show list summary, hide matching summary (both now in footer)
    var listSummary = document.getElementById('trTxnSummary');
    var matchSummary = document.getElementById('trTxnMatchSummary');
    if (listSummary) listSummary.style.display = '';
    if (matchSummary) matchSummary.style.display = 'none';

    // Render
    trRenderTxnTable(txns);

    // Show modal
    document.getElementById('trTxnModal').classList.add('show');
}

function trGetTxnModalTxns() {
    var shortSymbol = trCurrentTxnModalKey;
    var txns;
    if (shortSymbol === '__ALL__') {
        txns = trTransactions.slice();   // portfolio-level: all transactions
    } else {
        txns = trTransactions.filter(function(t) {
            return (t.short_symbol || t.symbol) === shortSymbol;
        });
    }
    // Apply specific investor filter (from detail row click)
    if (trCurrentTxnInvestorId) {
        txns = txns.filter(function(t) { return t.investor_id === trCurrentTxnInvestorId; });
    }
    // Apply active view filters (same as trCalcHoldings / trBuildInvestorDetail)
    if (trSelectedInvestorIds.length > 0) {
        txns = txns.filter(function(t) { return trSelectedInvestorIds.indexOf(t.investor_id) >= 0; });
    }
    if (trSelectedTraderIds.length > 0) {
        txns = txns.filter(function(t) { return t.trader_id && trSelectedTraderIds.indexOf(t.trader_id) >= 0; });
    }
    if (trSelectedBrokerIds.length > 0) {
        txns = txns.filter(function(t) { return t.broker_id && trSelectedBrokerIds.indexOf(t.broker_id) >= 0; });
    }
    if (trSelectedTagNames.length > 0) {
        if (trTagFilterLogic === 'AND') {
            txns = txns.filter(function(t) {
                return trSelectedTagNames.every(function(tag) { return t.tags && t.tags.indexOf(tag) >= 0; });
            });
        } else {
            txns = txns.filter(function(t) {
                return t.tags && t.tags.some(function(tag) { return trSelectedTagNames.indexOf(tag) >= 0; });
            });
        }
    }
    // Apply days filter
    if (trTxnDaysFilter > 0) {
        var cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - trTxnDaysFilter);
        txns = txns.filter(function(t) {
            return new Date(t.transaction_date) >= cutoff;
        });
    }
    return txns;
}

function trRenderTxnTable(txns) {
    if (!txns) txns = trGetTxnModalTxns();

    // Build expiry filter for list view (from unfiltered txns)
    if (trTxnViewMode === 'list') {
        var allExpiries = {};
        var monthIdx = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
        txns.forEach(function(t) {
            var expiry = trGetExpiryLabel(wmsFormatContract(t));
            allExpiries[expiry] = true;
        });
        var expiryKeys = Object.keys(allExpiries);
        expiryKeys.sort(function(a, b) {
            if (a === 'Equity' && b === 'Equity') return 0;
            if (a === 'Equity') return 1;
            if (b === 'Equity') return -1;
            var pa = a.split(' '), pb = b.split(' ');
            var tA = (monthIdx[pa[0]] !== undefined) ? new Date(2000 + parseInt(pa[1], 10), monthIdx[pa[0]], 1).getTime() : -1;
            var tB = (monthIdx[pb[0]] !== undefined) ? new Date(2000 + parseInt(pb[1], 10), monthIdx[pb[0]], 1).getTime() : -1;
            return tB - tA;
        });
        trBuildContractFilter(expiryKeys);
    }

    // Calculate running qty (always chronological, excluding income — hide is visual only)
    var chronoTxns = txns.slice().sort(function(a, b) {
        return new Date(a.transaction_date) - new Date(b.transaction_date);
    });
    var runningQtyMap = {};
    var runSum = 0;
    chronoTxns.forEach(function(t) {
        var isIncome = INCOME_TYPES.indexOf(t.transaction_type) >= 0;
        if (!isIncome) {
            runSum += (t.quantity || 0);
        }
        runningQtyMap[t.id] = runSum;
    });

    // Apply expiry filter in list view
    if (trTxnContractFilter.length > 0) {
        txns = txns.filter(function(t) {
            var expiry = trGetExpiryLabel(wmsFormatContract(t));
            return trTxnContractFilter.indexOf(expiry) >= 0;
        });
    }

    // Sort for display
    var displayTxns = txns.slice();
    displayTxns.sort(function(a, b) {
        if (trTxnSortColumn === 'symbol') {
            var sA = (a.symbol || '').toLowerCase(), sB = (b.symbol || '').toLowerCase();
            return trTxnSortDirection === 'asc' ? sA.localeCompare(sB) : sB.localeCompare(sA);
        }
        // Default: date
        var dA = new Date(a.transaction_date), dB = new Date(b.transaction_date);
        return trTxnSortDirection === 'asc' ? dA - dB : dB - dA;
    });

    var tbody = document.getElementById('trTxnModalBody');
    if (displayTxns.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:#9ca3af;">No transactions found</td></tr>';
    } else {
        tbody.innerHTML = displayTxns.map(function(txn) {
            var invBrk = trInvBrk(txn);
            var isIncome = INCOME_TYPES.indexOf(txn.transaction_type) >= 0;
            var typeClass = txn.transaction_type === 'BUY' ? 'positive' : (txn.transaction_type === 'SELL' ? 'negative' : '');
            var qty = txn.quantity || 0;
            var val = txn.net_amount || txn.gross_amount || 0;
            var displayPrice = (qty !== 0) ? Math.abs(val / qty) : 0;
            var runQty = runningQtyMap[txn.id] || 0;

            var rowClass = 'clickable-row';
            if (txn.ignore_for_avg_cost) rowClass += ' ignored-row';
            else if (txn.dont_display) rowClass += ' hidden-row';

            var isTempHidden = trTxnHiddenIds[txn.id];
            if (isTempHidden && !trShowHiddenTrades) return ''; // skip hidden
            if (isTempHidden) rowClass += ' temp-hidden-row';

            var hideIcon = '👁';
            var menuId = 'txm-' + txn.id.substring(0, 8);

            return '<tr class="' + rowClass + '" data-txn-id="' + txn.id + '">' +
                '<td>' + formatDate(txn.transaction_date) + '</td>' +
                '<td>' + invBrk + '</td>' +
                '<td><span class="' + typeClass + '" style="font-weight:600;">' + txn.transaction_type + '</span> ' + txn.symbol + '</td>' +
                '<td class="text-right">' + (qty !== 0 ? formatQuantity(Math.abs(qty)) : '-') + '</td>' +
                '<td class="text-right">' + (qty !== 0 ? formatPrice(displayPrice, false) : '-') + '</td>' +
                '<td class="text-right ' + getAmountClass(val) + '">' + formatAmount(val) + '</td>' +
                '<td class="text-right">' + formatQuantity(runQty) + '</td>' +
                '<td class="action-cell" style="position:relative;">' +
                    '<button class="btn-hide-txn" data-txn-id="' + txn.id + '" title="Toggle visibility">' + hideIcon + '</button>' +
                    '<button class="btn-action txn-action-btn" data-txn-id="' + txn.id + '" title="Actions">⋮</button>' +
                    '<div class="action-menu" id="' + menuId + '">' +
                        '<button class="action-menu-item" data-txn-action="edit" data-txn-id="' + txn.id + '">✏️ Edit</button>' +
                        '<button class="action-menu-item" data-txn-action="toggle-display" data-txn-id="' + txn.id + '">' +
                            (txn.dont_display ? '👁 Show in Display' : '👁 Hide from Display') + '</button>' +
                        '<button class="action-menu-item" data-txn-action="toggle-ignore" data-txn-id="' + txn.id + '">' +
                            (txn.ignore_for_avg_cost ? '✅ Include in Avg Cost' : '🚫 Ignore for Avg Cost') + '</button>' +
                        '<button class="action-menu-item danger" data-txn-action="delete" data-txn-id="' + txn.id + '">🗑️ Delete</button>' +
                    '</div>' +
                '</td>' +
            '</tr>';
        }).join('');
    }

    // Summary cards (respect temp-hidden)
    trRenderTxnSummary(txns);

    // Update sort indicators
    document.getElementById('trTxnSortDate').textContent = trTxnSortColumn === 'date' ? (trTxnSortDirection === 'asc' ? '▲' : '▼') : '';
    document.getElementById('trTxnSortSymbol').textContent = trTxnSortColumn === 'symbol' ? (trTxnSortDirection === 'asc' ? '▲' : '▼') : '';

    // Attach listeners
    trAttachTxnModalListeners();
}

function trTxnSort(column) {
    if (trTxnSortColumn === column) {
        trTxnSortDirection = trTxnSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        trTxnSortColumn = column;
        trTxnSortDirection = 'asc';
    }
    trRenderTxnTable();
}

function trToggleShowHidden() {
    trShowHiddenTrades = !trShowHiddenTrades;
    var btn = document.getElementById('trToggleHiddenBtn');
    btn.classList.toggle('active', trShowHiddenTrades);
    btn.textContent = trShowHiddenTrades ? '👁 Hide Filtered' : '👁 Show All';
    trRenderTxnTable();
}

function trToggleTempHide(txnId) {
    if (trTxnHiddenIds[txnId]) {
        delete trTxnHiddenIds[txnId];
    } else {
        trTxnHiddenIds[txnId] = true;
    }
    trRenderTxnTable();
}

function trAttachTxnModalListeners() {
    // Clickable rows → edit
    document.querySelectorAll('#trTxnModalBody .clickable-row').forEach(function(row) {
        row.addEventListener('click', function(e) {
            if (e.target.closest('.action-cell')) return;
            trOpenEditModal(row.dataset.txnId);
        });
    });

    // Temp hide buttons
    document.querySelectorAll('#trTxnModalBody .btn-hide-txn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            trToggleTempHide(btn.dataset.txnId);
        });
    });

    // Transaction action buttons
    document.querySelectorAll('#trTxnModalBody .txn-action-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var menuId = 'txm-' + btn.dataset.txnId.substring(0, 8);
            var menu = document.getElementById(menuId);
            if (!menu) return;
            var wasOpen = menu.classList.contains('show');
            document.querySelectorAll('#trTxnModalBody .action-menu.show').forEach(function(m) { m.classList.remove('show'); });
            if (!wasOpen) menu.classList.add('show');
        });
    });

    // Transaction action menu items
    document.querySelectorAll('#trTxnModalBody .action-menu-item').forEach(function(item) {
        item.addEventListener('click', function(e) {
            e.stopPropagation();
            document.querySelectorAll('#trTxnModalBody .action-menu.show').forEach(function(m) { m.classList.remove('show'); });
            var action = item.dataset.txnAction;
            var txnId = item.dataset.txnId;
            if (action === 'edit') trOpenEditModal(txnId);
            else if (action === 'toggle-display') trToggleTxnFlag(txnId, 'dont_display');
            else if (action === 'toggle-ignore') trToggleTxnFlag(txnId, 'ignore_for_avg_cost');
            else if (action === 'delete') trDeleteTransaction(txnId);
        });
    });
}

function trRenderTxnSummary(txns) {
    var container = document.getElementById('trTxnSummary');
    if (!container) return;

    // Calculate summary — open options exclusion is built into wmsCalcAvgCost (Rule E.12)
    var calc = wmsCalcAvgCost(txns);
    var netQty = calc.netQuantity;
    var totalCost = calc.totalCost;
    var avgCost = calc.avgCost;

    // Current price
    var shortSymbol = trCurrentTxnModalKey;
    var mockHolding = { symbol: shortSymbol, shortSymbol: shortSymbol, exchange: 'NSE', latestPrice: 0 };
    var currentPrice = trGetPrice(mockHolding);
    var currentValue = netQty * currentPrice;
    var pl = currentValue - totalCost;
    var plPct = totalCost !== 0 ? (pl / Math.abs(totalCost)) * 100 : 0;

    container.innerHTML =
        '<div class="txn-summary-card">' +
            '<div class="summary-label">Net Quantity</div>' +
            '<div class="summary-value">' + formatQuantity(netQty) + '</div>' +
        '</div>' +
        '<div class="txn-summary-card">' +
            '<div class="summary-label">Invested Amount</div>' +
            '<div class="summary-value">' + formatAmount(totalCost) + '</div>' +
            '<div class="summary-sub">Avg Cost: ' + formatPrice(avgCost, false) + '</div>' +
        '</div>' +
        '<div class="txn-summary-card ' + getAmountClass(pl) + '">' +
            '<div class="summary-label">Current Value</div>' +
            '<div class="summary-value">' + formatAmount(currentValue) + '</div>' +
            '<div class="summary-sub ' + getAmountClass(pl) + '">P&L: ' + formatAmount(pl) + ' (' + formatPercent(plPct) + ')</div>' +
        '</div>';
}

function trCloseTxnModal() {
    document.getElementById('trTxnModal').classList.remove('show');
    trCurrentTxnModalKey = null;
    trCurrentTxnInvestorId = null;
    trTxnHiddenIds = {};
    trShowHiddenTrades = false;
    trTxnViewMode = 'list';
    trTxnDaysFilter = 0;
    trTxnMatchMethod = 'lifo';
    trTxnContractFilter = [];
}

// ============================================================================
// TXN MODAL: VIEW SWITCHING & MATCHING TRADE VIEW
// ============================================================================

function trTxnSwitchView() {
    var listView = document.getElementById('trTxnListView');
    var matchView = document.getElementById('trTxnMatchView');
    var matchMethodWrap = document.getElementById('trTxnMatchMethodWrap');
    var hiddenBtn = document.getElementById('trToggleHiddenBtn');
    var contractFilterWrap = document.getElementById('trTxnContractFilterWrap');
    var listSummary = document.getElementById('trTxnSummary');
    var matchSummary = document.getElementById('trTxnMatchSummary');

    if (trTxnViewMode === 'matching') {
        listView.style.display = 'none';
        matchView.style.display = '';
        matchMethodWrap.style.display = '';
        hiddenBtn.style.display = 'none';
        if (listSummary) listSummary.style.display = 'none';
        if (matchSummary) matchSummary.style.display = '';
        trRenderTxnMatchingView();
    } else {
        listView.style.display = '';
        matchView.style.display = 'none';
        matchMethodWrap.style.display = 'none';
        hiddenBtn.style.display = '';
        if (listSummary) listSummary.style.display = '';
        if (matchSummary) matchSummary.style.display = 'none';
        trRenderTxnTable();
    }
}

function trTxnRefreshCurrentView() {
    if (trTxnViewMode === 'matching') {
        trRenderTxnMatchingView();
    } else {
        trRenderTxnTable();
    }
}

function trRenderTxnMatchingView() {
    var tbody = document.getElementById('trTxnMatchBody');
    if (!tbody) return;

    var txns = trGetTxnModalTxns();

    // Only BUY and SELL for matching
    var trades = txns.filter(function(t) {
        return t.transaction_type === 'BUY' || t.transaction_type === 'SELL';
    });

    // Group by investor_id + trader_id + broker_id + full symbol (contract level)
    var groups = {};
    trades.forEach(function(t) {
        var invId = t.investor_id || '';
        var trdId = t.trader_id || '';
        var brkId = t.broker_id || '';
        var fullSym = t.symbol || t.short_symbol || '';
        var key = invId + '|' + trdId + '|' + brkId + '|' + fullSym;
        if (!groups[key]) {
            groups[key] = {
                investorId: t.investor_id,
                traderId: t.trader_id,
                brokerId: t.broker_id,
                fullSymbol: fullSym,
                shortSymbol: t.short_symbol || t.symbol || '',
                contractLabel: wmsFormatContract(t),
                buys: [],
                sells: []
            };
        }
        var entry = {
            date: t.transaction_date,
            qty: Math.abs(t.quantity || 0),
            netAmount: Math.abs(t.net_amount || 0),
            remaining: Math.abs(t.quantity || 0),
            txn: t
        };
        if (t.transaction_type === 'BUY') {
            groups[key].buys.push(entry);
        } else {
            groups[key].sells.push(entry);
        }
    });

    // Build expiry filter options (group contracts by expiry e.g. "Mar 26")
    var allExpiries = {};
    Object.keys(groups).forEach(function(k) {
        var expiry = trGetExpiryLabel(groups[k].contractLabel);
        allExpiries[expiry] = true;
    });
    // Sort expiries: latest first, "Equity" last
    var expiryKeys = Object.keys(allExpiries);
    var monthIdx = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
    expiryKeys.sort(function(a, b) {
        if (a === 'Equity' && b === 'Equity') return 0;
        if (a === 'Equity') return 1;
        if (b === 'Equity') return -1;
        // Parse "Mon YY" e.g. "Mar 26"
        var pa = a.split(' '), pb = b.split(' ');
        var tA = (monthIdx[pa[0]] !== undefined) ? new Date(2000 + parseInt(pa[1], 10), monthIdx[pa[0]], 1).getTime() : -1;
        var tB = (monthIdx[pb[0]] !== undefined) ? new Date(2000 + parseInt(pb[1], 10), monthIdx[pb[0]], 1).getTime() : -1;
        return tB - tA;   // latest first
    });
    trBuildContractFilter(expiryKeys);

    // Build matched results per group
    var groupResults = [];
    var colCount = 10;

    Object.keys(groups).sort().forEach(function(key) {
        var g = groups[key];

        // Apply expiry filter
        if (trTxnContractFilter.length > 0 && trTxnContractFilter.indexOf(trGetExpiryLabel(g.contractLabel)) < 0) return;

        // Sort chronologically
        g.buys.sort(function(a, b) { return new Date(a.date) - new Date(b.date); });
        g.sells.sort(function(a, b) { return new Date(a.date) - new Date(b.date); });

        // Detect short position
        var firstBuyDate = g.buys.length > 0 ? new Date(g.buys[0].date) : new Date('9999-12-31');
        var firstSellDate = g.sells.length > 0 ? new Date(g.sells[0].date) : new Date('9999-12-31');
        var isShort = firstSellDate < firstBuyDate;

        var buys = g.buys.map(function(b) {
            return { date: b.date, qty: b.qty, netAmount: b.netAmount, remaining: b.qty, txn: b.txn };
        });
        var sells = g.sells.map(function(s) {
            return { date: s.date, qty: s.qty, netAmount: s.netAmount, remaining: s.qty, txn: s.txn };
        });

        var openers = isShort ? sells : buys;
        var closers = isShort ? buys : sells;
        var openerOrder = trTxnMatchMethod === 'lifo' ? openers.slice().reverse() : openers.slice();

        var matchedRows = [];

        // Match closers against openers
        closers.forEach(function(closer) {
            var closerRemaining = closer.remaining;
            var closerPpu = closer.qty > 0 ? closer.netAmount / closer.qty : 0;

            for (var oi = 0; oi < openerOrder.length && closerRemaining > 0; oi++) {
                var opener = openerOrder[oi];
                if (opener.remaining <= 0) continue;
                var matchQty = Math.min(closerRemaining, opener.remaining);
                var openerPpu = opener.qty > 0 ? opener.netAmount / opener.qty : 0;

                var buyDate, buyAvg, buyAmount, sellDate, sellAvg, sellAmount, openerTxn, closerTxn;
                if (isShort) {
                    sellDate = opener.date; sellAvg = openerPpu; sellAmount = matchQty * openerPpu;
                    buyDate = closer.date; buyAvg = closerPpu; buyAmount = matchQty * closerPpu;
                    openerTxn = opener.txn; closerTxn = closer.txn;
                } else {
                    buyDate = opener.date; buyAvg = openerPpu; buyAmount = matchQty * openerPpu;
                    sellDate = closer.date; sellAvg = closerPpu; sellAmount = matchQty * closerPpu;
                    openerTxn = opener.txn; closerTxn = closer.txn;
                }

                matchedRows.push({
                    type: 'matched', isShort: isShort,
                    qty: matchQty, buyDate: buyDate, buyAvg: buyAvg, buyAmount: buyAmount,
                    sellDate: sellDate, sellAvg: sellAvg, sellAmount: sellAmount,
                    pnl: sellAmount - buyAmount,
                    buyTxnId: isShort ? closerTxn.id : openerTxn.id,
                    sellTxnId: isShort ? openerTxn.id : closerTxn.id
                });
                opener.remaining -= matchQty;
                closerRemaining -= matchQty;
            }
            closer.remaining = closerRemaining;
        });

        // Open positions (unmatched openers)
        // Get CMP: use contract-specific price for F&O, equity price for stocks
        var contractCache = wmsLivePrices[g.fullSymbol];
        var cmp = contractCache ? contractCache.lp : trGetPrice({ shortSymbol: g.shortSymbol, symbol: g.shortSymbol, exchange: 'NSE', latestPrice: 0 });

        openerOrder.forEach(function(opener) {
            if (opener.remaining <= 0) return;
            var ppu = opener.qty > 0 ? opener.netAmount / opener.qty : 0;
            var row = {
                type: 'open', isShort: isShort,
                qty: opener.remaining, pnl: 0,
                openerTxnId: opener.txn.id
            };
            if (isShort) {
                row.buyDate = null; row.buyAvg = 0; row.buyAmount = 0;
                row.sellDate = opener.date; row.sellAvg = ppu; row.sellAmount = opener.remaining * ppu;
            } else {
                row.buyDate = opener.date; row.buyAvg = ppu; row.buyAmount = opener.remaining * ppu;
                row.sellDate = null; row.sellAvg = 0; row.sellAmount = 0;
            }
            // Unrealised P&L using contract-specific CMP
            if (cmp > 0) {
                row.cmp = cmp;
                var openCost = row.isShort ? row.sellAmount : row.buyAmount;
                var openValue = row.qty * cmp;
                row.unrealisedPnl = row.isShort ? (openCost - openValue) : (openValue - openCost);
            }
            matchedRows.push(row);
        });

        // Unmatched closers
        closers.forEach(function(closer) {
            if (closer.remaining <= 0) return;
            var ppu = closer.qty > 0 ? closer.netAmount / closer.qty : 0;
            var row = {
                type: 'unmatched-closer', isShort: isShort,
                qty: closer.remaining,
                closerTxnId: closer.txn.id
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

        // Sort by opening date (buy date for long, sell date for short)
        matchedRows.sort(function(a, b) {
            var dateA = isShort ? (a.sellDate || '9999') : (a.buyDate || '9999');
            var dateB = isShort ? (b.sellDate || '9999') : (b.buyDate || '9999');
            return new Date(dateA) - new Date(dateB);
        });

        // Totals for matched (completed) trades only
        var totalQty = 0, totalBuyAmt = 0, totalSellAmt = 0, totalPnl = 0;
        var totalOpenQty = 0, totalUnrealisedPnl = 0;
        matchedRows.forEach(function(r) {
            if (r.type === 'matched') {
                totalQty += r.qty; totalBuyAmt += r.buyAmount;
                totalSellAmt += r.sellAmount; totalPnl += r.pnl;
            }
            if (r.type === 'open') {
                totalOpenQty += r.qty;
                if (r.unrealisedPnl !== undefined) totalUnrealisedPnl += r.unrealisedPnl;
            }
        });

        // Build inv > trader > broker label
        var invLabel = trInvName(g.investorId);
        var trdLabel = g.traderId ? trInvName(g.traderId) : '';
        var brkLabel = trBrkCode(g.brokerId);
        var groupLabel = invLabel;
        if (trdLabel && trdLabel !== invLabel) groupLabel += ' > ' + trdLabel;
        if (brkLabel) groupLabel += ' > ' + brkLabel;

        groupResults.push({
            fullSymbol: g.fullSymbol, contractLabel: g.contractLabel,
            groupLabel: groupLabel, isShort: isShort,
            rows: matchedRows, totalQty: totalQty, totalOpenQty: totalOpenQty,
            totalBuyAmt: totalBuyAmt, totalSellAmt: totalSellAmt,
            totalPnl: totalPnl, totalUnrealisedPnl: totalUnrealisedPnl
        });
    });

    if (groupResults.length === 0) {
        tbody.innerHTML = '<tr><td colspan="' + colCount + '" style="text-align:center;padding:40px;color:#9ca3af;">No matching trades found</td></tr>';
        trRenderTxnMatchSummary(groupResults);
        return;
    }

    // Render groups
    var html = '';
    var globalRowIdx = 0;

    groupResults.forEach(function(grp, gi) {
        var groupId = 'trMG-' + gi;
        var shortLabel = grp.isShort ? ' <span style="color:#dc2626;font-size:10px;">(Short)</span>' : '';

        // Totals display
        var totalPnlClass = grp.totalPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
        var totalPnlHtml = grp.totalPnl < 0
            ? '<span class="' + totalPnlClass + '">(' + formatAmount(Math.abs(grp.totalPnl)) + ')</span>'
            : '<span class="' + totalPnlClass + '">' + formatAmount(grp.totalPnl) + '</span>';

        // Group header: starts expanded for single-group, collapsed for multi
        var startCollapsed = groupResults.length > 1;
        var collapsedClass = startCollapsed ? ' collapsed' : '';

        html += '<tr class="trM-group-header' + collapsedClass + '" data-group-id="' + groupId + '">' +
            '<td colspan="3">' +
                '<span class="trM-collapse-icon">▼</span> ' +
                wmsEsc(grp.groupLabel) + ' — ' + wmsEsc(grp.contractLabel) + shortLabel +
            '</td>' +
            '<td class="trM-buy-start"></td>' +
            '<td></td>' +
            '<td class="text-right"><span class="trM-group-total">' + (grp.totalBuyAmt > 0 ? formatAmount(grp.totalBuyAmt) : '') + '</span></td>' +
            '<td class="trM-sell-start"></td>' +
            '<td></td>' +
            '<td class="text-right"><span class="trM-group-total">' + (grp.totalSellAmt > 0 ? formatAmount(grp.totalSellAmt) : '') + '</span></td>' +
            '<td class="text-right"><span class="trM-group-total">' + totalPnlHtml + '</span></td>' +
        '</tr>';

        // Detail rows
        grp.rows.forEach(function(row) {
            var rowId = 'trMR-' + globalRowIdx;
            globalRowIdx++;

            var isOpen = row.type === 'open';
            var isUnmatched = row.type === 'unmatched-closer';
            var rowClass = 'trM-detail-row trM-clickable';
            if (startCollapsed) rowClass += ' collapsed-row';
            if (isOpen) rowClass += ' trM-match-open';

            // Store original txn IDs for click-to-edit
            var buyTxnId = row.buyTxnId || row.openerTxnId || '';
            var sellTxnId = row.sellTxnId || row.closerTxnId || '';

            // P&L column
            var pnlHtml = '';
            if (isOpen) {
                if (row.unrealisedPnl !== undefined) {
                    var uPnlClass = row.unrealisedPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
                    var uPnlFmt = row.unrealisedPnl < 0
                        ? '(' + formatAmount(Math.abs(row.unrealisedPnl)) + ')'
                        : formatAmount(row.unrealisedPnl);
                    pnlHtml = '<span class="trM-unrealised">' + uPnlFmt + '</span>';
                } else {
                    pnlHtml = '<span class="trM-unrealised">' + (row.isShort ? 'Short Open' : 'Open') + '</span>';
                }
            } else if (isUnmatched) {
                pnlHtml = '<span style="color:#718096;">Unmatched</span>';
            } else {
                var pnlClass = row.pnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
                pnlHtml = row.pnl < 0
                    ? '<span class="' + pnlClass + '">(' + formatAmount(Math.abs(row.pnl)) + ')</span>'
                    : '<span class="' + pnlClass + '">' + formatAmount(row.pnl) + '</span>';
            }

            var buyDateHtml = row.buyDate ? formatDate(row.buyDate) : '-';
            var sellDateHtml = row.sellDate ? formatDate(row.sellDate) : '-';
            var hasBuy = row.buyAvg > 0 || row.buyAmount > 0;
            var hasSell = row.sellAvg > 0 || row.sellAmount > 0;

            // For open positions, show CMP in the empty price cell (sell for long, buy for short)
            var buyPriceHtml = hasBuy ? formatPrice(row.buyAvg, false) : '-';
            var buyAmtHtml = hasBuy ? formatAmount(row.buyAmount) : '-';
            var sellPriceHtml = hasSell ? formatPrice(row.sellAvg, false) : '-';
            var sellAmtHtml = hasSell ? formatAmount(row.sellAmount) : '-';
            if (isOpen && row.cmp > 0) {
                if (!row.isShort && !hasSell) {
                    sellPriceHtml = formatPrice(row.cmp, false);
                    sellAmtHtml = '-';
                } else if (row.isShort && !hasBuy) {
                    buyPriceHtml = formatPrice(row.cmp, false);
                    buyAmtHtml = '-';
                }
            }

            html += '<tr class="' + rowClass + '" data-group-id="' + groupId + '" data-row-id="' + rowId + '"' +
                ' data-buy-txn-id="' + buyTxnId + '" data-sell-txn-id="' + sellTxnId + '">' +
                '<td>' + wmsEsc(grp.groupLabel) + '</td>' +
                '<td class="trM-contract-col">' + wmsEsc(grp.contractLabel) + '</td>' +
                '<td class="text-right">' + formatQuantity(row.qty) + '</td>' +
                '<td class="trM-buy-start">' + buyDateHtml + '</td>' +
                '<td class="text-right">' + buyPriceHtml + '</td>' +
                '<td class="text-right">' + buyAmtHtml + '</td>' +
                '<td class="trM-sell-start">' + sellDateHtml + '</td>' +
                '<td class="text-right">' + sellPriceHtml + '</td>' +
                '<td class="text-right">' + sellAmtHtml + '</td>' +
                '<td class="text-right">' + pnlHtml + '</td>' +
            '</tr>';
        });
    });

    tbody.innerHTML = html;

    // Collapse/expand handlers on group headers
    tbody.querySelectorAll('.trM-group-header').forEach(function(header) {
        header.addEventListener('click', function() {
            var gid = header.dataset.groupId;
            var isCollapsed = header.classList.toggle('collapsed');
            tbody.querySelectorAll('.trM-detail-row[data-group-id="' + gid + '"]').forEach(function(row) {
                if (isCollapsed) row.classList.add('collapsed-row');
                else row.classList.remove('collapsed-row');
            });
        });
    });

    // Click-to-edit on detail rows
    tbody.querySelectorAll('.trM-clickable').forEach(function(row) {
        row.addEventListener('click', function(e) {
            if (e.target.closest('.trM-group-header')) return;
            // Determine which side was clicked (buy or sell)
            var cell = e.target.closest('td');
            var allTds = Array.prototype.slice.call(row.children);
            var cellIdx = allTds.indexOf(cell);
            var txnId = '';
            // Columns: 0=group, 1=contract, 2=qty, 3=buyDate, 4=buyPrice, 5=buyAmt, 6=sellDate, 7=sellPrice, 8=sellAmt, 9=pnl
            if (cellIdx >= 6 && cellIdx <= 8 && row.dataset.sellTxnId) {
                txnId = row.dataset.sellTxnId;
            } else if (row.dataset.buyTxnId) {
                txnId = row.dataset.buyTxnId;
            } else if (row.dataset.sellTxnId) {
                txnId = row.dataset.sellTxnId;
            }
            if (txnId) trOpenEditModal(txnId);
        });
    });

    // Render matching summary
    trRenderTxnMatchSummary(groupResults);

    // Async: fetch F&O contract prices if any F&O symbols need pricing
    if (!trTxnFnoPricesFetched) {
        var fnoSymbols = {};
        txns.forEach(function(t) {
            if ((t.security_type === 'NFO' || t.security_type === 'MCX') && t.symbol && t.symbol !== t.short_symbol) {
                fnoSymbols[t.symbol] = true;
            }
        });
        var fnoSymList = Object.keys(fnoSymbols);
        if (fnoSymList.length > 0 && window.fyersToken && typeof wmsFetchFnoContractPrices === 'function') {
            trTxnFnoPricesFetched = true;
            wmsFetchFnoContractPrices(fnoSymList).then(function() {
                trRenderTxnMatchingView(); // Re-render with updated contract prices
            });
        }
    }
}

// Extract expiry label from contract label: "27 Feb 25 Fut" → "Feb 25", "Equity" → "Equity"
function trGetExpiryLabel(contractLabel) {
    if (!contractLabel || contractLabel === 'Equity') return 'Equity';
    var parts = contractLabel.split(' ');
    // Format: "DD Mon YY ..." — extract "Mon YY"
    if (parts.length >= 3) {
        var monthIdx = { Jan:1, Feb:1, Mar:1, Apr:1, May:1, Jun:1, Jul:1, Aug:1, Sep:1, Oct:1, Nov:1, Dec:1 };
        if (monthIdx[parts[1]]) return parts[1] + ' ' + parts[2];
    }
    return contractLabel;
}

// Build/update the contract filter dropdown in the modal header
function trBuildContractFilter(contractLabels) {
    var wrap = document.getElementById('trTxnContractFilterWrap');
    if (!wrap) return;
    if (contractLabels.length <= 1) {
        // Only one contract type (e.g., all Equity) — hide filter
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = '';
    var html = '<button class="trM-cf-btn" id="trMCfToggle">Expiry ▾</button>' +
        '<div class="trM-cf-dropdown" id="trMCfDropdown" style="display:none;">';
    contractLabels.forEach(function(cl) {
        var checked = (trTxnContractFilter.length === 0 || trTxnContractFilter.indexOf(cl) >= 0) ? ' checked' : '';
        html += '<label class="trM-cf-item"><input type="checkbox" value="' + wmsEsc(cl) + '"' + checked + '> ' + wmsEsc(cl) + '</label>';
    });
    html += '</div>';
    wrap.innerHTML = html;

    // Toggle dropdown
    var toggleBtn = document.getElementById('trMCfToggle');
    var dropdown = document.getElementById('trMCfDropdown');
    toggleBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        dropdown.style.display = dropdown.style.display === 'none' ? '' : 'none';
    });

    // Checkbox changes
    dropdown.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
        cb.addEventListener('change', function() {
            var checked = [];
            dropdown.querySelectorAll('input[type="checkbox"]:checked').forEach(function(c) {
                checked.push(c.value);
            });
            // If all checked, reset to empty (show all)
            if (checked.length === contractLabels.length) {
                trTxnContractFilter = [];
            } else {
                trTxnContractFilter = checked;
            }
            trTxnRefreshCurrentView();
        });
    });

    // Close on outside click
    document.addEventListener('click', function trMCfOutside(e) {
        if (!wrap.contains(e.target)) {
            dropdown.style.display = 'none';
        }
    });
}

function trRenderTxnMatchSummary(groupResults) {
    var container = document.getElementById('trTxnMatchSummary');
    if (!container) return;

    var totalMatchedQty = 0, totalBuyAmt = 0, totalSellAmt = 0, totalPnl = 0;
    var totalOpenQty = 0, totalUnrealisedPnl = 0;
    var hasUnrealised = false;
    groupResults.forEach(function(grp) {
        totalBuyAmt += grp.totalBuyAmt;
        totalSellAmt += grp.totalSellAmt;
        totalPnl += grp.totalPnl;
        totalMatchedQty += grp.totalQty;
        totalOpenQty += (grp.totalOpenQty || 0);
        if (grp.totalUnrealisedPnl) { totalUnrealisedPnl += grp.totalUnrealisedPnl; hasUnrealised = true; }
    });

    var pnlPct = totalBuyAmt !== 0 ? (totalPnl / totalBuyAmt) * 100 : 0;

    // Open Qty is primary, Matched Qty is secondary
    var openCard =
        '<div class="txn-summary-card">' +
            '<div class="summary-label">Open Position</div>' +
            '<div class="summary-value">' + formatQuantity(totalOpenQty) + '</div>' +
            '<div class="summary-sub">Matched: ' + formatQuantity(totalMatchedQty) + '</div>' +
        '</div>';

    var realisedCard =
        '<div class="txn-summary-card ' + getAmountClass(totalPnl) + '">' +
            '<div class="summary-label">Realised P&L</div>' +
            '<div class="summary-value ' + getAmountClass(totalPnl) + '">' + formatAmount(totalPnl) + '</div>' +
            '<div class="summary-sub ' + getAmountClass(totalPnl) + '">' + formatPercent(pnlPct) + ' on buy</div>' +
        '</div>';

    var unrealisedCard = '';
    if (hasUnrealised) {
        unrealisedCard =
            '<div class="txn-summary-card ' + getAmountClass(totalUnrealisedPnl) + '">' +
                '<div class="summary-label">Unrealised P&L</div>' +
                '<div class="summary-value ' + getAmountClass(totalUnrealisedPnl) + '">' + formatAmount(totalUnrealisedPnl) + '</div>' +
            '</div>';
    }

    var buyCard =
        '<div class="txn-summary-card">' +
            '<div class="summary-label">Total Buy</div>' +
            '<div class="summary-value">' + formatAmount(totalBuyAmt) + '</div>' +
        '</div>';

    container.innerHTML = openCard + buyCard + realisedCard + unrealisedCard;
}

// ============================================================================
// TOGGLE FLAGS (dont_display, ignore_for_avg_cost)
// ============================================================================

async function trToggleTxnFlag(txnId, flagName) {
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
        if (trCurrentTxnModalKey) trTxnRefreshCurrentView();
        trRenderPortfolio();
    } else {
        showAlert('Failed to update: HTTP ' + resp.status, 'error');
    }
}

// ============================================================================
// DELETE TRANSACTION
// ============================================================================

async function trDeleteTransaction(txnId) {
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
        if (trCurrentTxnModalKey) trTxnRefreshCurrentView();
        trRenderPortfolio();
    } else {
        showAlert('Failed to delete: HTTP ' + resp.status, 'error');
    }
}

// ============================================================================
// EDIT MODAL
// ============================================================================

// Format number: 2 decimal places with comma grouping (no unit conversion)
// Format number: 2 decimal places with comma grouping
function trEditFmt(val) {
    var n = parseFloat(val) || 0;
    return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Format integer with comma grouping (0 decimal places)
function trEditFmtInt(val) {
    var n = parseInt(val) || 0;
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Parse formatted number back to float (strip commas)
function trEditParse(el) {
    return parseFloat((el.value || '0').replace(/,/g, '')) || 0;
}

function trOpenEditModal(txnId) {
    var txn = trTransactions.find(function(t) { return t.id === txnId; });
    if (!txn) return;
    trEditingTxnId = txnId;

    var isSell = txn.transaction_type === 'SELL';

    // Security identity banner
    document.getElementById('trEditBannerSymbol').textContent = txn.short_symbol || txn.symbol || '-';
    document.getElementById('trEditBannerCompany').textContent = txn.company_name || '';
    document.getElementById('trEditBannerType').textContent = txn.security_type || '-';

    // Parties
    document.getElementById('trEditInvestor').value = trInvName(txn.investor_id);
    document.getElementById('trEditBroker').value = trBrkCode(txn.broker_id) || '-';
    document.getElementById('trEditCnNo').value = txn.broker_contract_note_no || '';

    // Trader dropdown (editable)
    var traderSelect = document.getElementById('trEditTrader');
    traderSelect.innerHTML = '<option value="">(Same as Investor)</option>' +
        trInvestors.map(function(inv) {
            var label = inv.short_name || inv.name;
            var selected = inv.id === txn.trader_id ? ' selected' : '';
            return '<option value="' + inv.id + '"' + selected + '>' + label + '</option>';
        }).join('');

    // Trade details (all read-only)
    document.getElementById('trEditDate').value = formatDate(txn.transaction_date);
    document.getElementById('trEditType').value = txn.transaction_type || '-';
    document.getElementById('trEditExchange').value = txn.exchange || '-';
    document.getElementById('trEditProduct').value = txn.product || '-';

    // Lots before Qty — for SELL show both as absolute values (schema stores negative qty, lots can be negative)
    var lotsVal = parseFloat(txn.lots) || 0;
    var qtyVal = txn.quantity || 0;
    document.getElementById('trEditLots').value = trEditFmt(isSell ? Math.abs(lotsVal) : lotsVal);
    document.getElementById('trEditQty').value = trEditFmtInt(isSell ? Math.abs(qtyVal) : qtyVal);
    document.getElementById('trEditPrice').value = trEditFmt(txn.price || 0);

    // Gross amount (editable, computed highlight)
    document.getElementById('trEditGross').value = trEditFmt(txn.gross_amount || 0);

    // Charges (all editable, formatted with commas)
    document.getElementById('trEditBrokerage').value = trEditFmt(txn.brokerage || 0);
    document.getElementById('trEditStt').value = trEditFmt(txn.stt || 0);
    document.getElementById('trEditOther').value = trEditFmt(txn.other_charges || 0);
    document.getElementById('trEditGst').value = trEditFmt(txn.gst || 0);
    document.getElementById('trEditTds').value = trEditFmt(txn.tds || 0);
    document.getElementById('trEditTotalCharges').value = trEditFmt(txn.total_charges || 0);

    // Net amount, then trader charges, then margin
    document.getElementById('trEditNetAmount').value = trEditFmt(txn.net_amount || 0);
    document.getElementById('trEditTraderCharges').value = trEditFmt(txn.trader_charges || 0);
    document.getElementById('trEditMargin').value = trEditFmt(txn.margin_blocked || 0);

    // Tags — pill-based input using wmsTagInput
    if (trEditTagCtrl) { trEditTagCtrl.destroy(); trEditTagCtrl = null; }
    var currentTags = (txn.tags || []).filter(function(t) { return t !== 'blank'; });
    // Collect all existing tags across transactions for autocomplete
    var allExistingTags = {};
    trTransactions.forEach(function(t) {
        if (t.tags) t.tags.forEach(function(tag) { if (tag && tag !== 'blank') allExistingTags[tag] = true; });
    });
    var tagInput = document.getElementById('trEditTagsInput');
    var tagPills = document.getElementById('trEditTagPills');
    var tagDd = document.getElementById('trEditTagDd');
    tagInput.value = '';
    tagPills.innerHTML = '';
    tagDd.innerHTML = '';
    trEditTagCtrl = wmsTagInput(tagInput, tagPills, tagDd, {
        tags: currentTags.slice(),
        existingTags: Object.keys(allExistingTags).sort(),
        onChange: function() {}
    });

    // Notes (editable)
    document.getElementById('trEditNotes').value = txn.notes || '';

    // Flags
    document.getElementById('trEditLocked').checked = !!txn.is_locked;
    document.getElementById('trEditIgnoreAvg').checked = !!txn.ignore_for_avg_cost;
    document.getElementById('trEditDontDisplay').checked = !!txn.dont_display;

    // Lock warning
    var lockWarn = document.getElementById('trEditLockWarning');
    lockWarn.style.display = txn.is_locked ? '' : 'none';

    // Disable editable fields and Save button if locked
    var isLocked = !!txn.is_locked;
    var editableFields = document.querySelectorAll('#trEditForm .editable-field, #trEditForm select.editable-field, #trEditForm input[type="checkbox"]:not(#trEditLocked)');
    editableFields.forEach(function(f) { f.disabled = isLocked; });
    document.getElementById('trEditSaveBtn').disabled = isLocked;
    document.getElementById('trEditModalTitle').textContent = isLocked ? 'View Transaction (Locked)' : 'Edit Transaction';

    document.getElementById('trEditModal').classList.add('show');
}

function trCloseEditModal() {
    document.getElementById('trEditModal').classList.remove('show');
    trEditingTxnId = null;
}

// Recalculate trader_charges when trader dropdown changes
function trRecalcTraderCharges() {
    if (!trEditingTxnId) return;
    var txn = trTransactions.find(function(t) { return t.id === trEditingTxnId; });
    if (!txn) return;

    var traderId = document.getElementById('trEditTrader').value || txn.investor_id;
    var investorId = txn.investor_id;
    var brokerId = txn.broker_id;

    if (traderId !== investorId && wmsRefData && wmsRefData.ibaRatesMap) {
        var gross = Math.abs(parseFloat(txn.gross_amount) || 0);
        var traderCharges = wmsGetBrokerage(wmsRefData.ibaRatesMap, traderId, brokerId, gross,
            txn.security_type, txn.asset_class, txn.price, txn.quantity, txn.lots);
        document.getElementById('trEditTraderCharges').value = trEditFmt(traderCharges);
    } else {
        document.getElementById('trEditTraderCharges').value = trEditFmt(0);
    }
}

async function trSaveEdit() {
    if (!trEditingTxnId) return;

    var txn = trTransactions.find(function(t) { return t.id === trEditingTxnId; });
    if (!txn) return;

    // Locked transactions cannot be edited
    if (txn.is_locked) {
        showAlert('Transaction is locked and cannot be edited.', 'error');
        return;
    }

    var tags = trEditTagCtrl ? trEditTagCtrl.getTags() : [];
    if (tags.length === 0) tags = ['blank'];

    var traderVal = document.getElementById('trEditTrader').value;

    // Save editable fields — values saved directly to DB as entered
    var body = {
        trader_id: traderVal || null,
        gross_amount: trEditParse(document.getElementById('trEditGross')),
        brokerage: trEditParse(document.getElementById('trEditBrokerage')),
        stt: trEditParse(document.getElementById('trEditStt')),
        other_charges: trEditParse(document.getElementById('trEditOther')),
        gst: trEditParse(document.getElementById('trEditGst')),
        tds: trEditParse(document.getElementById('trEditTds')),
        total_charges: trEditParse(document.getElementById('trEditTotalCharges')),
        net_amount: trEditParse(document.getElementById('trEditNetAmount')),
        trader_charges: trEditParse(document.getElementById('trEditTraderCharges')),
        margin_blocked: trEditParse(document.getElementById('trEditMargin')),
        broker_contract_note_no: document.getElementById('trEditCnNo').value.trim() || null,
        tags: tags,
        notes: document.getElementById('trEditNotes').value || null,
        ignore_for_avg_cost: document.getElementById('trEditIgnoreAvg').checked,
        dont_display: document.getElementById('trEditDontDisplay').checked
    };

    var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + trEditingTxnId, {
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
        Object.keys(body).forEach(function(k) { txn[k] = body[k]; });
        showAlert('Transaction saved', 'success', 2000);
        trCloseEditModal();
        if (trCurrentTxnModalKey) trTxnRefreshCurrentView();
        trRenderPortfolio();
    } else {
        var errText = await resp.text();
        showAlert('Failed to save: ' + errText, 'error');
    }
}

// ============================================================================
// TRANSACTIONS SUB-MODULE (on-demand loading, same pattern as watchlist)
// ============================================================================

var trTxLoaded = false;

async function trLoadTransactionsModule() {
    var container = document.getElementById('tr-transactions-container');
    if (!container) return;

    if (!trTxLoaded) {
        try {
            // Load HTML
            var htmlResp = await fetch('trading-transactions.html?t=' + Date.now());
            if (!htmlResp.ok) throw new Error('Failed to load trading-transactions.html');
            var htmlText = await htmlResp.text();

            // Extract <style> and inject to <head>
            var parser = new DOMParser();
            var doc = parser.parseFromString(htmlText, 'text/html');
            var styles = doc.querySelectorAll('style');
            styles.forEach(function(s) { document.head.appendChild(s.cloneNode(true)); });

            // Inject body content
            container.innerHTML = doc.body ? doc.body.innerHTML : htmlText;

            // Load JS
            await new Promise(function(resolve, reject) {
                var script = document.createElement('script');
                script.src = 'trading-transactions.js?t=' + Date.now();
                script.onload = resolve;
                script.onerror = function() { reject(new Error('Failed to load trading-transactions.js')); };
                document.body.appendChild(script);
            });

            trTxLoaded = true;
        } catch (err) {
            console.error('Trading: Failed to load transactions module:', err);
            container.innerHTML = '<div style="text-align:center;padding:60px;color:#dc2626;">Failed to load transactions: ' + err.message + '</div>';
            return;
        }
    }

    // Initialize or re-activate
    if (window.trTxInit) {
        window.trTxInit();
    }
}

// ============================================================================
// ADD TRANSACTION MODULE (loaded on demand)
// ============================================================================

var trAddTxnLoaded = false;

async function trOpenAddTransaction() {
    if (!trAddTxnLoaded) {
        try {
            // Load HTML
            var htmlResp = await fetch('trading-add-transaction.html?t=' + Date.now());
            if (!htmlResp.ok) throw new Error('Failed to load trading-add-transaction.html');
            var htmlText = await htmlResp.text();

            // Extract <style> and inject to <head>
            var parser = new DOMParser();
            var doc = parser.parseFromString(htmlText, 'text/html');
            var styles = doc.querySelectorAll('style');
            styles.forEach(function(s) { document.head.appendChild(s.cloneNode(true)); });

            // Inject body content (modal overlays) into a container div
            var container = document.createElement('div');
            container.id = 'tr-add-txn-container';
            container.innerHTML = doc.body ? doc.body.innerHTML : htmlText;
            document.body.appendChild(container);

            // Load JS
            await new Promise(function(resolve, reject) {
                var script = document.createElement('script');
                script.src = 'trading-add-transaction.js?t=' + Date.now();
                script.onload = resolve;
                script.onerror = function() { reject(new Error('Failed to load trading-add-transaction.js')); };
                document.body.appendChild(script);
            });

            trAddTxnLoaded = true;

            // Small delay for init to complete, then open
            setTimeout(function() {
                if (typeof window.openAddTxnModal === 'function') {
                    window.openAddTxnModal();
                }
            }, 100);
        } catch (err) {
            console.error('Trading: Failed to load add-transaction module:', err);
            showAlert('Failed to load Add Transaction: ' + err.message, 'error');
        }
    } else {
        // Already loaded — just open
        if (typeof window.openAddTxnModal === 'function') {
            window.openAddTxnModal();
        }
    }
}

// ============================================================================
// SAVED PORTFOLIO VIEWS
// ============================================================================

async function trLoadViews() {
    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?or=(module.eq.trading_portfolio,module.is.null)&select=id,name,filters,sort_order,is_default,show_in_tabs&order=sort_order.asc,created_at.asc', {
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
        });
        trPortfolioViews = resp.ok ? await resp.json() : [];
    } catch (err) {
        console.warn('Trading: Failed to load views:', err.message);
        trPortfolioViews = [];
    }
    trRenderViewTabs();
    trRenderMoreDropdown();
    trUpdateViewButtons();

    // Auto-apply default view on first load (if no view active yet)
    if (!trActiveViewId) {
        var defaultView = trPortfolioViews.find(function(v) { return v.is_default; });
        if (defaultView) {
            trApplyView(defaultView.id);
        }
    }
}

// ---- VIEW TABS ----

function trRenderViewTabs() {
    var container = document.getElementById('tr-view-tabs');
    if (!container) return;

    // Default view first (locked left), then other tabs
    var defaultView = trPortfolioViews.find(function(v) { return v.is_default; });
    var tabViews = trPortfolioViews.filter(function(v) {
        return v.show_in_tabs !== false && !v.is_default;
    });

    var html = '';

    // Default view tab (if exists)
    if (defaultView) {
        var isActive = defaultView.id === trActiveViewId;
        html += '<button class="tr-view-tab' + (isActive ? ' active' : '') + '" data-view-id="' + defaultView.id + '">' +
            '<span class="tr-tab-star">★</span> ' + defaultView.name +
            '</button>';
    }

    // Other pinned tabs
    tabViews.forEach(function(v) {
        var isActive = v.id === trActiveViewId;
        html += '<button class="tr-view-tab' + (isActive ? ' active' : '') + '" data-view-id="' + v.id + '">' +
            v.name +
            ' <span class="tr-tab-close" data-close-id="' + v.id + '" title="Remove from tabs">✕</span>' +
            '</button>';
    });

    container.innerHTML = html;

    // Attach click/dblclick handlers with delay to distinguish them
    container.querySelectorAll('.tr-view-tab').forEach(function(tab) {
        var clickTimer = null;
        tab.addEventListener('click', function(e) {
            if (e.target.classList.contains('tr-tab-close')) {
                e.stopPropagation();
                trCloseViewTab(e.target.dataset.closeId);
                return;
            }
            // Delay single click to allow dblclick to cancel it
            if (clickTimer) clearTimeout(clickTimer);
            clickTimer = setTimeout(function() {
                clickTimer = null;
                if (trRenamingTab) return;   // don't re-render while rename input is active
                trApplyView(tab.dataset.viewId);
            }, 250);
        });
        // Double-click to rename
        tab.addEventListener('dblclick', function(e) {
            e.preventDefault();
            e.stopPropagation();
            // Cancel the pending single click
            if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
            trRenamingTab = true;

            var viewId = tab.dataset.viewId;
            var view = trPortfolioViews.find(function(v) { return v.id === viewId; });
            if (!view) return;

            // Make sure this view is active
            trActiveViewId = viewId;

            // Replace tab content with inline input
            var input = document.createElement('input');
            input.type = 'text';
            input.value = view.name;
            input.style.cssText = 'width:100px; font-size:11px; padding:1px 4px; border:1px solid #667eea; border-radius:3px; outline:none; background:white;';
            tab.innerHTML = '';
            tab.appendChild(input);
            input.focus();
            input.select();

            // Isolate input from parent button — prevent ALL events from bubbling
            // to the tab's click handler (which would trigger trApplyView → re-render → destroy input)
            ['click', 'mousedown', 'mouseup', 'dblclick', 'keydown', 'keyup', 'keypress'].forEach(function(evt) {
                input.addEventListener(evt, function(ie) { ie.stopPropagation(); });
            });

            var finished = false;
            function finishRename() {
                if (finished) return;
                finished = true;
                trRenamingTab = false;
                var newName = input.value.trim();
                if (newName && newName !== view.name) {
                    view.name = newName;
                    // Persist to DB
                    fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + viewId, {
                        method: 'PATCH',
                        headers: {
                            'apikey': SUPABASE_ANON_KEY,
                            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                            'Content-Type': 'application/json',
                            'Prefer': 'return=minimal'
                        },
                        body: JSON.stringify({ name: newName })
                    }).catch(function(err) { console.warn('Failed to rename view:', err.message); });
                }
                trRenderViewTabs();
                trRenderMoreDropdown();
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

async function trCloseViewTab(viewId) {
    // Set show_in_tabs = false in DB
    try {
        await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + viewId, {
            method: 'PATCH',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ show_in_tabs: false })
        });
    } catch (err) {
        console.warn('Failed to update tab state:', err.message);
    }

    // Update local state
    var v = trPortfolioViews.find(function(v) { return v.id === viewId; });
    if (v) v.show_in_tabs = false;

    // If closing the active tab, switch to default view
    if (trActiveViewId === viewId) {
        var defaultView = trPortfolioViews.find(function(v) { return v.is_default; });
        if (defaultView) {
            trApplyView(defaultView.id);
            return; // trApplyView already re-renders tabs/more/buttons
        } else {
            trActiveViewId = null;
        }
    }

    trRenderViewTabs();
    trRenderMoreDropdown();
}

// ---- MORE DROPDOWN ----

function trRenderMoreDropdown() {
    var list = document.getElementById('tr-more-list');
    if (!list) return;

    if (trPortfolioViews.length === 0) {
        list.innerHTML = '<div style="padding:8px 12px; font-size:12px; color:#a0aec0;">No saved views</div>';
        return;
    }

    list.innerHTML = trPortfolioViews.map(function(v) {
        var isActive = v.id === trActiveViewId;
        var isDefault = v.is_default;
        var inTabs = v.show_in_tabs !== false;
        return '<div class="tr-more-item' + (isActive ? ' active' : '') + '" data-view-id="' + v.id + '">' +
            (isActive ? '<span style="color:#667eea;font-size:11px;">✓</span> ' : '<span style="width:16px;display:inline-block;"></span> ') +
            '<span class="tr-more-name">' + v.name + '</span>' +
            (isDefault ? '<span class="tr-more-badge">★ Default</span>' : '') +
            '<span class="tr-more-actions">' +
                (!isDefault ? '<button class="tr-more-action-btn" data-action="default" data-id="' + v.id + '" title="Set as default">★</button>' : '') +
                (inTabs && !isDefault ? '<button class="tr-more-action-btn" data-action="hide-tab" data-id="' + v.id + '" title="Remove from tabs">⊟</button>' : '') +
                (!inTabs ? '<button class="tr-more-action-btn" data-action="show-tab" data-id="' + v.id + '" title="Show in tabs">⊞</button>' : '') +
                '<button class="tr-more-action-btn danger" data-action="delete" data-id="' + v.id + '" title="Delete view">✕</button>' +
            '</span>' +
        '</div>';
    }).join('');

    // Click to apply
    list.querySelectorAll('.tr-more-item').forEach(function(item) {
        item.addEventListener('click', function(e) {
            if (e.target.closest('.tr-more-action-btn')) return;
            trApplyView(item.dataset.viewId);
            document.getElementById('tr-more-dropdown').style.display = 'none';
        });
    });

    // Action buttons
    list.querySelectorAll('.tr-more-action-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var action = btn.dataset.action;
            var id = btn.dataset.id;
            if (action === 'default') trSetDefaultView(id);
            else if (action === 'hide-tab') trCloseViewTab(id);
            else if (action === 'show-tab') trShowViewTab(id);
            else if (action === 'delete') trDeleteView(id);
        });
    });
}

// ---- APPLY VIEW ----

function trApplyView(viewId) {
    var view = trPortfolioViews.find(function(v) { return v.id === viewId; });
    if (!view) return;

    // Auto-add to tabs if not already showing
    if (view.show_in_tabs === false || view.show_in_tabs === null) {
        view.show_in_tabs = true;
        // Persist to DB
        fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + viewId, {
            method: 'PATCH',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ show_in_tabs: true })
        }).catch(function(err) { console.warn('Failed to show tab:', err.message); });
    }

    var f = view.filters || {};
    // Mutate arrays in-place so wmsPillSearch controllers keep valid references
    trSelectedInvestorIds.length = 0;
    Array.prototype.push.apply(trSelectedInvestorIds, f.investorIds || []);
    trSelectedTraderIds.length = 0;
    Array.prototype.push.apply(trSelectedTraderIds, f.traderIds || []);
    trSelectedBrokerIds.length = 0;
    Array.prototype.push.apply(trSelectedBrokerIds, f.brokerIds || []);
    trSelectedTagNames.length = 0;
    Array.prototype.push.apply(trSelectedTagNames, f.tagNames || []);
    trTagFilterLogic = f.tagLogic || 'OR';
    trViewMode = f.viewMode || 'default';
    trActiveViewId = viewId;

    // Update filter UI
    ['investor', 'trader', 'broker', 'tag'].forEach(function(type) {
        trSyncPillStates(type);
        trRenderSelectedTags(type);
    });

    // Update tag logic radio
    document.querySelectorAll('input[name="tr-tag-logic"]').forEach(function(r) {
        r.checked = r.value === trTagFilterLogic;
    });

    // Update view mode buttons
    document.querySelectorAll('.tr-view-mode-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.mode === trViewMode);
    });

    trRenderViewTabs();
    trRenderMoreDropdown();
    trUpdateViewButtons();
    trRenderPortfolio();
}

function trUpdateViewButtons() {
    var updateBtn = document.getElementById('tr-update-view-btn');
    if (updateBtn) {
        updateBtn.disabled = !trActiveViewId;
    }
}

// ---- GET / SAVE / UPDATE / DELETE ----

function trGetCurrentFilters() {
    return {
        investorIds: trSelectedInvestorIds.slice(),
        traderIds: trSelectedTraderIds.slice(),
        brokerIds: trSelectedBrokerIds.slice(),
        tagNames: trSelectedTagNames.slice(),
        tagLogic: trTagFilterLogic,
        viewMode: trViewMode
    };
}

async function trCreateBlankView() {
    var blankFilters = {};
    var sortOrder = trPortfolioViews.length;
    var name = 'New View';

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/portfolio_views', {
            method: 'POST',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation'
            },
            body: JSON.stringify({ name: name, filters: blankFilters, sort_order: sortOrder, is_default: false, show_in_tabs: true, module: 'trading_portfolio' })
        });
        if (resp.ok) {
            var rows = await resp.json();
            if (rows.length > 0) {
                trPortfolioViews.push(rows[0]);
                trApplyView(rows[0].id);
                showAlert('New view created — double-click tab to rename', 'success', 3000);
            }
        } else {
            showAlert('Failed to create view', 'error');
        }
    } catch (err) {
        showAlert('Failed to create view: ' + err.message, 'error');
    }
}

async function trSaveCurrentView(name) {
    var filters = trGetCurrentFilters();
    var sortOrder = trPortfolioViews.length;
    var isFirst = trPortfolioViews.length === 0; // First view becomes default

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/portfolio_views', {
            method: 'POST',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation'
            },
            body: JSON.stringify({ name: name, filters: filters, sort_order: sortOrder, is_default: isFirst, show_in_tabs: true, module: 'trading_portfolio' })
        });
        if (resp.ok) {
            var rows = await resp.json();
            if (rows.length > 0) {
                trPortfolioViews.push(rows[0]);
                trActiveViewId = rows[0].id;
                trRenderViewTabs();
                trRenderMoreDropdown();
                trUpdateViewButtons();
                showAlert('View "' + name + '" saved', 'success', 2000);
            }
        } else {
            showAlert('Failed to save view', 'error');
        }
    } catch (err) {
        showAlert('Failed to save view: ' + err.message, 'error');
    }

    // Hide prompt
    document.getElementById('tr-save-prompt').classList.remove('show');
    document.getElementById('tr-save-prompt-name').value = '';
    document.getElementById('tr-save-new-btn').style.display = '';
}

async function trUpdateCurrentView() {
    if (!trActiveViewId) return;
    var filters = trGetCurrentFilters();

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + trActiveViewId, {
            method: 'PATCH',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ filters: filters })
        });
        if (resp.ok) {
            // Update local state
            var v = trPortfolioViews.find(function(v) { return v.id === trActiveViewId; });
            if (v) v.filters = filters;
            showAlert('View updated', 'success', 2000);
        } else {
            showAlert('Failed to update view', 'error');
        }
    } catch (err) {
        showAlert('Failed to update view: ' + err.message, 'error');
    }
}

async function trDeleteView(viewId) {
    if (!confirm('Delete this saved view?')) return;

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + viewId, {
            method: 'DELETE',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                'Prefer': 'return=minimal'
            }
        });
        if (resp.ok) {
            trPortfolioViews = trPortfolioViews.filter(function(v) { return v.id !== viewId; });
            if (trActiveViewId === viewId) {
                trActiveViewId = null;
            }
            trRenderViewTabs();
            trRenderMoreDropdown();
            trUpdateViewButtons();
            showAlert('View deleted', 'success', 2000);
        }
    } catch (err) {
        showAlert('Failed to delete view: ' + err.message, 'error');
    }
}

// ---- DEFAULT VIEW ----

async function trSetDefaultView(viewId) {
    // Unset old default
    var oldDefault = trPortfolioViews.find(function(v) { return v.is_default; });
    if (oldDefault && oldDefault.id !== viewId) {
        try {
            await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + oldDefault.id, {
                method: 'PATCH',
                headers: {
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify({ is_default: false })
            });
            oldDefault.is_default = false;
        } catch (err) {
            console.warn('Failed to unset old default:', err.message);
        }
    }

    // Set new default
    try {
        await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + viewId, {
            method: 'PATCH',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ is_default: true, show_in_tabs: true })
        });
        var v = trPortfolioViews.find(function(v) { return v.id === viewId; });
        if (v) { v.is_default = true; v.show_in_tabs = true; }
    } catch (err) {
        console.warn('Failed to set default:', err.message);
    }

    trRenderViewTabs();
    trRenderMoreDropdown();
    showAlert('Default view updated', 'success', 2000);
}

// ---- SHOW VIEW TAB ----

async function trShowViewTab(viewId) {
    try {
        await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + viewId, {
            method: 'PATCH',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ show_in_tabs: true })
        });
    } catch (err) {
        console.warn('Failed to show tab:', err.message);
    }

    var v = trPortfolioViews.find(function(v) { return v.id === viewId; });
    if (v) v.show_in_tabs = true;

    trRenderViewTabs();
    trRenderMoreDropdown();
}

// ============================================================================
// COMPANY COLUMN INLINE SEARCH
// ============================================================================

function trOpenCompanySearch() {
    var th = document.getElementById('tr-th-company');
    if (!th || document.getElementById('tr-company-search-input')) return; // Already open

    // Save original content
    th.dataset.originalHtml = th.innerHTML;

    // Replace with search input
    th.innerHTML = '<input type="text" id="tr-company-search-input" placeholder="Search company..." ' +
        'style="width:90%; padding:3px 6px; border:1px solid #667eea; border-radius:4px; font-size:12px; outline:none;">';

    var input = document.getElementById('tr-company-search-input');
    input.focus();

    // Pre-fill if there's an existing search
    if (trCompanySearchText) input.value = trCompanySearchText;

    input.addEventListener('input', function() {
        trCompanySearchText = input.value;
        trRenderPortfolio();
    });

    input.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            trCloseCompanySearch();
        } else if (e.key === 'Enter') {
            // Keep filter, close input
            trCloseCompanySearch(true);
        }
        e.stopPropagation(); // Don't let ESC propagate to modal handler
    });

    // Don't let single-click sort trigger while search is open
    input.addEventListener('click', function(e) { e.stopPropagation(); });
}

function trCloseCompanySearch(keepFilter) {
    var th = document.getElementById('tr-th-company');
    if (!th) return;

    if (!keepFilter) {
        trCompanySearchText = '';
        trRenderPortfolio();
    }

    // Restore header
    if (th.dataset.originalHtml) {
        th.innerHTML = th.dataset.originalHtml;
    } else {
        th.innerHTML = 'Company <span class="sort-indicator" id="tr-sort-company"></span>';
    }

    // Show search indicator if filter is active
    if (trCompanySearchText) {
        var indicator = document.createElement('span');
        indicator.style.cssText = 'font-size:10px; color:#667eea; margin-left:4px;';
        indicator.textContent = '🔍 ' + trCompanySearchText;
        indicator.title = 'Double-click to edit, Esc to clear';
        th.appendChild(indicator);
    }

    trUpdateSortIndicators();
}

// ============================================================================
// F&O POSITIONS TAB (loaded from trading-fno.js)
// ============================================================================

var trFnoLoaded = false;

async function trLoadFnoModule() {
    if (!trFnoLoaded) {
        try {
            await new Promise(function(resolve, reject) {
                var script = document.createElement('script');
                script.src = 'trading-fno.js?t=' + Date.now();
                script.onload = resolve;
                script.onerror = function() { reject(new Error('Failed to load trading-fno.js')); };
                document.body.appendChild(script);
            });
            trFnoLoaded = true;
        } catch (err) {
            console.error('Trading: Failed to load F&O module:', err);
            var body = document.getElementById('trFnoBody');
            if (body) body.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:#dc2626;">Failed to load F&O module: ' + err.message + '</td></tr>';
            return;
        }
    }
    if (typeof trFnoRender === 'function') trFnoRender();
}

// ============================================================================
// WINDOW EXPORTS
// ============================================================================

window.initTrading = initTrading;
