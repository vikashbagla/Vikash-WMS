// ============================================================================
// WMS TRADING MODULE
// ============================================================================
// Uses 'tr' prefix to avoid naming conflicts with utils.js.
// All module-level state uses var (project convention — avoids TDZ on reload).

// INCOME_TYPES now canonical in wms-shared.js as WMS_INCOME_TYPES
var INCOME_TYPES = WMS_INCOME_TYPES;

var trTransactions = [];

// Promise that resolves the FIRST time `trLoadData()` finishes populating
// `trTransactions`. Subsequent loads (refresh button) re-fire trLoadData but
// the promise stays resolved — subscribers only need to know that initial
// transactions are in memory. Modules that lazy-load (Statements, F&O) MUST
// await this before calling any function that filters `trTransactions`,
// otherwise they race against the initial load and see an empty array.
// See LESSONS §A.1.18 (recon drift false-positive on page reload).
var trDataReady = null;
var _trDataReadyResolve = null;
window._trDataReadyResolved = false;  // sync mirror — checkable from anywhere without awaiting
(function _initTrDataReadyPromise() {
    trDataReady = new Promise(function(resolve) { _trDataReadyResolve = resolve; });
})();
window.trDataReady = trDataReady;

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
var trDefaultViewFilters = null;   // Filters from the default Portfolio view (for banner)
var trDefaultFnoViewFilters = null; // Filters from the default F&O view (for banner)
var trCompanySearchText = '';      // Inline company search filter
var trLivePrices = {};
var trLiveData = {};
var trOpenActionMenu = null;
// ---- Portfolio View Manager (wmsViewManager instance) ----
var trPortfolioVM = wmsViewManager({
    module: 'trading_portfolio',
    label: 'Portfolio',
    moduleFilter: 'or=(module.eq.trading_portfolio,module.is.null)',
    ids: {
        viewTabs: 'tr-view-tabs',
        moreList: 'tr-more-list',
        moreDropdown: 'tr-more-dropdown',
        updateBtn: 'tr-update-view-btn'
    },
    autoDefaultFirst: true,
    getPills: function() {
        return [
            { pill: trInvPillFilter, type: 'investor' },
            { pill: trTrdPillFilter, type: 'trader' },
            { pill: trBrkPillFilter, type: 'broker' },
            { pill: trTagPillFilter, type: 'tag' }
        ];
    },
    getFilters: function() {
        return {
            investorIds: trSelectedInvestorIds.slice(),
            traderIds: trSelectedTraderIds.slice(),
            brokerIds: trSelectedBrokerIds.slice(),
            tagNames: trSelectedTagNames.slice(),
            tagLogic: trTagFilterLogic,
            viewMode: trViewMode
        };
    },
    applyFilters: function(f) {
        // Mutate arrays in-place (B.2.3 — pill controllers hold references)
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

        // Sync pill UI
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
    },
    onRefresh: function() { trRenderPortfolio(); },
    onLoadComplete: function(defaultView) {
        if (defaultView) {
            trDefaultViewFilters = defaultView.filters || {};
        }
        trComputeBannerStats();
    },
    onDefaultChanged: function(newDefault) {
        trDefaultViewFilters = newDefault.filters || {};
        trComputeBannerStats();
    },
    onUpdateComplete: function(view) {
        if (view.is_default) {
            trDefaultViewFilters = view.filters;
            trComputeBannerStats();
        }
    },
    onSaveComplete: function() {
        var prompt = document.getElementById('tr-save-prompt');
        if (prompt) prompt.classList.remove('show');
        var nameInput = document.getElementById('tr-save-prompt-name');
        if (nameInput) nameInput.value = '';
        var saveNewBtn = document.getElementById('tr-save-new-btn');
        if (saveNewBtn) saveNewBtn.style.display = '';
    }
});

// ============================================================================
// DAY'S P&L BANNER (header card)
// ============================================================================
// Reads stored totals from renderPortfolio() and trFnoRender().
// Stocks = Portfolio − F&O | F&O | Total = Stocks + F&O
// Auto-updates on every render (including live price refreshes).

function trUpdateDayPLBanner() {
    var banner = document.getElementById('trDayPLBanner');
    if (!banner) return;

    var stocksPL = window._trStocksDayPL;   // null if no live data yet
    var fnoPL    = window._trFnoDayPnl;      // undefined if F&O not computed yet
    var stocksInv = window._trStocksInvested || 0;
    var fnoExp   = window._trFnoExposure || 0;
    var portfolioInvested = window._trPortfolioInvested || 0;
    var portfolioTotalPL = window._trPortfolioTotalPL;
    var portfolioTotalPLPct = window._trPortfolioTotalPLPct;

    // Don't show banner until at least one source has data
    if (stocksPL == null && fnoPL == null) {
        banner.innerHTML = '';
        return;
    }

    var sPL = (stocksPL != null) ? stocksPL : 0;
    var fPL = (fnoPL != null) ? fnoPL : 0;
    var dayTotal = sPL + fPL;

    // Day P&L percentages
    var sPct = (stocksInv !== 0) ? (sPL / Math.abs(stocksInv)) * 100 : null;
    var fPct = (fnoExp !== 0) ? (fPL / Math.abs(fnoExp)) * 100 : null;
    var dayBase = stocksInv + fnoExp;
    var dayTotalPct = (dayBase !== 0) ? (dayTotal / Math.abs(dayBase)) * 100 : null;

    function plColor(val) {
        if (val == null) return 'color:#a0aec0';
        return val > 0 ? 'color:#16a34a' : val < 0 ? 'color:#dc2626' : 'color:#4a5568';
    }
    function plHtml(val) {
        if (val == null) return '<span style="color:#a0aec0;">-</span>';
        return '<span style="' + plColor(val) + ';">' + formatAmount(val) + '</span>';
    }
    function pctHtml(val) {
        if (val == null) return '';
        return '<span style="' + plColor(val) + ';">' + formatPercent(val) + '</span>';
    }
    // Strip decimal portion for Portfolio block (use raw string, then wrap with tooltip)
    function fmtNoDec(val) {
        var raw = formatAmountRaw(val);
        if (raw === '-') return '-';
        var display = raw.replace(/\.\d{2}/, '');
        var absVal = Math.abs(val);
        var full = absVal.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        if (val < 0) full = '(' + full + ')';
        return '<span title="\u20B9 ' + full + '">' + display + '</span>';
    }
    function plHtmlNoDec(val) {
        if (val == null) return '<span style="color:#a0aec0;">-</span>';
        return '<span style="' + plColor(val) + ';">' + fmtNoDec(val) + '</span>';
    }

    function card(label, pl, pct) {
        return '<div class="tr-pl-card">' +
            '<div class="tr-pl-label">' + label + '</div>' +
            '<div class="tr-pl-value">' + plHtml(pl) + '</div>' +
            '<div class="tr-pl-pct">' + pctHtml(pct) + '</div>' +
        '</div>';
    }

    // --- Block 1: Day's P&L ---
    var dayBlock =
        '<div class="tr-pl-block">' +
            '<div class="tr-pl-block-label">Day\'s P&amp;L</div>' +
            '<div class="tr-pl-block-cards">' +
                card('Stocks', sPL, sPct) +
                '<div class="tr-pl-sep"></div>' +
                card('F&amp;O', fPL, fPct) +
                '<div class="tr-pl-sep"></div>' +
                card('Total', dayTotal, dayTotalPct) +
            '</div>' +
        '</div>';

    // --- Block 2: Portfolio (from default view) — no decimals ---
    var currentValue = portfolioInvested + (portfolioTotalPL || 0);
    var totalBlock =
        '<div class="tr-pl-block">' +
            '<div class="tr-pl-block-label">Portfolio</div>' +
            '<div class="tr-pl-block-cards">' +
                '<div class="tr-pl-card">' +
                    '<div class="tr-pl-label">Invested</div>' +
                    '<div class="tr-pl-value" style="color:#4a5568;">' + fmtNoDec(portfolioInvested) + '</div>' +
                '</div>' +
                '<div class="tr-pl-sep"></div>' +
                '<div class="tr-pl-card">' +
                    '<div class="tr-pl-label">Total P&amp;L</div>' +
                    '<div class="tr-pl-value">' + plHtmlNoDec(portfolioTotalPL) + '</div>' +
                    '<div class="tr-pl-pct">' + pctHtml(portfolioTotalPLPct) + '</div>' +
                '</div>' +
                '<div class="tr-pl-sep"></div>' +
                '<div class="tr-pl-card">' +
                    '<div class="tr-pl-label">Current Value</div>' +
                    '<div class="tr-pl-value" style="color:#4a5568;">' + fmtNoDec(currentValue) + '</div>' +
                '</div>' +
            '</div>' +
        '</div>';

    banner.innerHTML = dayBlock + '<div class="tr-pl-block-sep"></div>' + totalBlock;
}

// ============================================================================
// BANNER: Background F&O Day's P&L + Exposure (no F&O module dependency)
// Fetches contract prices and computes open position Day's P&L using
// LIFO matching — same logic as trFnoCalcPositions but no UI side effects.
// Lives in trading.js (not trading-fno.js) so it's available at init.
// ============================================================================

async function trFnoBannerRefresh(forceRefresh) {
    // Delegate to default-view-based banner computation
    return trFnoBannerRefreshFromDefault(forceRefresh);
}

// ============================================================================
// BANNER: Compute stats from DEFAULT view filters (not active view)
// Called on init, refresh, and live price updates. Decoupled from active view.
// ============================================================================

function trComputeBannerStats() {
    // Use default Portfolio view filters (or empty = all data if no default)
    var f = trDefaultViewFilters || {};
    var invIds = f.investorIds || [];
    var trdIds = f.traderIds || [];
    var brkIds = f.brokerIds || [];
    var tagNames = f.tagNames || [];
    var tagLogic = f.tagLogic || 'OR';
    var viewMode = f.viewMode || 'default';

    // Filter transactions using default view filters
    var filtered = trTransactions.filter(function(t) { return !t.dont_display; });
    if (invIds.length > 0) filtered = filtered.filter(function(t) { return invIds.indexOf(t.investor_id) >= 0; });
    if (trdIds.length > 0) filtered = filtered.filter(function(t) { var tid = t.trader_id || t.investor_id; return tid && trdIds.indexOf(tid) >= 0; });
    if (brkIds.length > 0) filtered = filtered.filter(function(t) { return t.broker_id && brkIds.indexOf(t.broker_id) >= 0; });
    if (tagNames.length > 0) filtered = filtered.filter(function(t) { return wmsMatchTagsFilter(t.tags, tagNames, tagLogic); });

    // View mode filter
    if (viewMode === 'holdings') {
        filtered = filtered.filter(function(t) { return t.security_type !== 'NFO'; });
    } else if (viewMode === 'fno') {
        filtered = filtered.filter(function(t) { return t.security_type === 'NFO'; });
    }

    // Group by short_symbol and calculate holdings (lightweight version of trCalcHoldings)
    var groups = {};
    filtered.forEach(function(txn) {
        var key = txn.short_symbol || txn.symbol;
        if (!key) return;
        if (!groups[key]) groups[key] = { txns: [], shortSymbol: key };
        groups[key].txns.push(txn);
    });

    var totalInvested = 0, totalValue = 0, stocksDayPL = 0, stocksInvested = 0;
    var hasLive = Object.keys(wmsLivePrices).length > 0;

    Object.keys(groups).forEach(function(key) {
        var g = groups[key];
        var calc = wmsCalcAvgCost(g.txns);
        if (calc.netQuantity === 0) return;

        // Get live price
        var sym = g.shortSymbol;
        var cache = wmsLivePrices[sym];
        var price = cache ? (cache.lp || calc.avgCost) : calc.avgCost;
        var currentValue = calc.netQuantity * price;
        totalInvested += calc.totalCost;
        totalValue += currentValue;

        // Stocks Day's P&L: use shared function (handles same-day trades correctly)
        if (hasLive && cache) {
            var sdp = wmsCalcStockDayPL(g.txns, cache);
            if (sdp !== null && sdp !== 0) {
                stocksDayPL += sdp;
                stocksInvested += calc.totalCost;
            }
        }
    });

    var totalPL = totalValue - totalInvested;
    var totalPLPct = totalInvested !== 0 ? (totalPL / Math.abs(totalInvested)) * 100 : 0;

    window._trStocksDayPL = hasLive ? stocksDayPL : null;
    window._trStocksInvested = stocksInvested;
    window._trPortfolioInvested = totalInvested;
    window._trPortfolioTotalPL = totalPL;
    window._trPortfolioTotalPLPct = totalPLPct;
    trUpdateDayPLBanner();
}

// Compute F&O banner stats from default F&O view filters
async function trFnoBannerRefreshFromDefault(forceRefresh) {
    var f = trDefaultFnoViewFilters || {};

    // Fetch contract prices for the txn set the default view will compute
    // against — same scope filter trFnoCalcPositions will use shortly.  Done
    // BEFORE the calc so live prices are populated when the engine reads
    // wmsLivePrices for Day P&L computation.
    var invIds = f.investorIds || [], trdIds = f.traderIds || [],
        brkIds = f.brokerIds || [], tagNames = f.tagNames || [],
        tagLogic = f.tagLogic || 'OR';
    var txns = trTransactions.filter(function(t) {
        return t.security_type === 'NFO' || t.security_type === 'MCX';
    });
    if (invIds.length > 0) txns = txns.filter(function(t) { return invIds.indexOf(t.investor_id) >= 0; });
    if (trdIds.length > 0) txns = txns.filter(function(t) { var tid = t.trader_id || t.investor_id; return tid && trdIds.indexOf(tid) >= 0; });
    if (brkIds.length > 0) txns = txns.filter(function(t) { return t.broker_id && brkIds.indexOf(t.broker_id) >= 0; });
    if (tagNames.length > 0) txns = txns.filter(function(t) { return wmsMatchTagsFilter(t.tags, tagNames, tagLogic); });

    var symbols = {};
    txns.forEach(function(t) {
        if (t.symbol && t.symbol !== t.short_symbol) {
            var sym = t.symbol.replace(/^[A-Z]+:/, '');
            symbols[sym] = true;
        }
    });
    var symList = Object.keys(symbols);
    if (symList.length > 0 && typeof wmsFetchFnoContractPrices === 'function') {
        await wmsFetchFnoContractPrices(symList, forceRefresh);
    }

    // Single source of truth: delegate to the F&O page's own calc function
    // with the default view's filters as an override.  trFnoCalcPositions
    // applies investor/trader/broker/tag/expiry/fnoMode/matchMethod consistently
    // — banner totals can never drift from page totals because they come from
    // the same code.  See LESSONS §J.6 for the filter contract.
    if (!trFnoLoaded) {
        try {
            await trLoadFnoModule();
        } catch (err) {
            console.warn('Banner refresh: F&O module load failed, skipping totals:', err && err.message);
            return;
        }
    }
    if (typeof trFnoCalcPositions !== 'function') {
        console.warn('Banner refresh: trFnoCalcPositions not available after module load');
        return;
    }

    var positions = trFnoCalcPositions(f);
    var totDayPnl = 0, totExposure = 0;
    (positions || []).forEach(function(p) {
        totDayPnl += p.totalDayPnl || 0;
        totExposure += p.totalOpenCost || 0;
    });
    window._trFnoDayPnl = totDayPnl;
    window._trFnoExposure = totExposure;
    trUpdateDayPLBanner();
}

// ============================================================================
// EARLY LOAD: F&O Default View Filters (before F&O module is loaded)
// Ensures the banner uses correct filters from the start, not all-unfiltered.
// ============================================================================

async function trLoadFnoDefaultFilters() {
    if (trDefaultFnoViewFilters) return; // Already loaded (e.g. F&O module ran first)
    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?module=eq.trading_fno&is_default=eq.true&select=filters&limit=1', {
            headers: wmsHeaders()
        });
        if (resp.ok) {
            var rows = await resp.json();
            if (rows.length > 0) {
                trDefaultFnoViewFilters = rows[0].filters || {};
                console.log('trLoadFnoDefaultFilters: loaded default F&O view filters');
            }
        }
    } catch (err) {
        console.warn('trLoadFnoDefaultFilters: failed:', err.message);
    }
}

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

    try {
        trUpdateUnitLabels();

        // Load F&O default view filters early — must be set BEFORE first wmsRefreshRender()
        // so banner uses correct filters, not all-unfiltered
        await trLoadFnoDefaultFilters();

        // Build master symbol list and do initial price fetch + render
        if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
        await wmsStandardRefresh(false); // first load: non-forced (triggers Stage 2+3 for unresolved)

        // Load saved views (may update default view filters → banner recompute)
        await trPortfolioVM.loadViews();

        // Re-init sub-modules if already loaded (pills need data that may not have been ready)
        if (window.trTxInit && trTxLoaded) {
            window.trTxInit();
        }
        if (typeof trFnoRender === 'function' && trFnoLoaded) {
            if (typeof trFnoResetFilters === 'function') trFnoResetFilters();
            trFnoRender();
        }

        // Start the single standard refresh timer (runs always, regardless of active tab)
        if (wmsIsMarketHours() && window.fyersToken) {
            wmsStartRefreshTimer();
        }
    } catch (error) {
        console.error('Trading: Error during post-load init:', error);
        showAlert('Trading loaded with errors: ' + error.message, 'warning');
    } finally {
        showLoading(false);
    }
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
    document.getElementById('trToggleZeroBtn').addEventListener('click', trToggleZeroHoldings);

    // Filter toggle — Portfolio
    document.getElementById('tr-filters-toggle').addEventListener('click', function() {
        var filtersDiv = document.getElementById('trPortfolioFilters');
        var isHidden = filtersDiv.style.display === 'none';
        filtersDiv.style.display = isHidden ? 'flex' : 'none';
        this.textContent = isHidden ? '▼' : '▲';
    });

    // Filter toggle — F&O: only hide investor/trader/broker/tag row; keep open/all + expiry row visible
    document.getElementById('tr-fno-filters-toggle').addEventListener('click', function() {
        var shared = document.getElementById('trFnoSharedFilters');
        var isHidden = shared.style.display === 'none';
        shared.style.display = isHidden ? 'flex' : 'none';
        this.textContent = isHidden ? '▼' : '▲';
    });

    // + Others dropdown
    var othersBtn = document.getElementById('trOthersBtn');
    var othersDropdown = document.getElementById('trOthersDropdown');
    if (othersBtn && othersDropdown) {
        othersBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            var isOpen = othersDropdown.style.display !== 'none';
            othersDropdown.style.display = isOpen ? 'none' : 'block';
        });
        document.addEventListener('click', function(e) {
            if (othersBtn.contains(e.target)) return;
            if (othersDropdown.contains(e.target)) return;
            othersDropdown.style.display = 'none';
        });
        othersDropdown.addEventListener('click', function(e) {
            var item = e.target.closest('.tr-others-item');
            if (!item) return;
            e.stopPropagation();
            othersDropdown.style.display = 'none';
            if (item.disabled) return;
            var txnType = item.dataset.type;
            if (txnType === 'RIGHTS_ENTITLEMENT') {
                trLoadRightsModule(function() { openRightsEntitlementModal(); });
            } else if (txnType === 'RIGHTS_PAYMENT') {
                trLoadRightsModule(function() { openRightsPaymentModal(); });
            } else if (WMS_INCOME_TYPES.indexOf(txnType) >= 0) {
                trLoadIncomeModule(function() { openIncomeModal(txnType); });
            } else if (txnType === 'HISTORICAL_PL') {
                trLoadHistPlModule(function() { openHistPlModal(); });
            } else if (txnType === 'BONUS') {
                trLoadBonusModule(function() { openBonusModal(); });
            } else if (txnType === 'SPLIT') {
                trLoadSplitModule(function() { openSplitModal(); });
            } else {
                alert('Transaction type "' + txnType + '" — form coming soon.');
            }
        });
    }

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
            if (trPortfolioVM.activeViewId) trPortfolioVM.updateCurrentView();
        });
    }

    // New blank view button
    var newViewBtn = document.getElementById('tr-new-view-btn');
    if (newViewBtn) {
        newViewBtn.addEventListener('click', function() {
            trPortfolioVM.createBlankView();
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
            if (name) trPortfolioVM.saveCurrentView(name);
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
                if (name) trPortfolioVM.saveCurrentView(name);
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
            var editModal = document.getElementById('wmsEditModal');
            var txnModal = document.getElementById('wmsTxnModal');
            if (editModal && editModal.classList.contains('show')) {
                wmsEditModalClose();
            } else if (txnModal && txnModal.classList.contains('show')) {
                wmsTxnModalClose();
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

    document.querySelectorAll('.trading-tab-btn').forEach(function(b) { b.classList.remove('active'); });
    document.querySelectorAll('.trading-tab-content').forEach(function(c) { c.classList.remove('active'); });

    var btn = document.querySelector('.trading-tab-btn[data-tab="' + tabId + '"]');
    var content = document.getElementById(tabId);
    if (btn) btn.classList.add('active');
    if (content) content.classList.add('active');

    localStorage.setItem('wms_trading_tab', tabId);

    // Load sub-modules on demand
    if (tabId === 'tr-watchlist') {
        trLoadWatchlistModule();
    }
    if (tabId === 'tr-transactions') {
        trLoadTransactionsModule();
    }
    if (tabId === 'tr-fno-positions') {
        trLoadFnoModule();
    }
    if (tabId === 'tr-ledger') {
        trLoadLedgerModule();
    }

    // Standard refresh: re-render the newly active tab with cached prices
    if (typeof wmsRefreshRender === 'function') wmsRefreshRender();
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
    var headers = wmsHeaders();

    // Load ALL transactions (no transaction_type filter — includes DIVIDEND, etc.)
    // Uses wmsFetchAllRaw() to paginate past Supabase's 1000-row default limit.
    var txnData = await wmsFetchAllRaw(
        SUPABASE_URL + '/rest/v1/transactions?select=id,investor_id,trader_id,broker_id,security_id,security_type,symbol,short_symbol,company_name,exchange,product,transaction_type,transaction_date,transaction_time,quantity,lots,price,gross_amount,net_amount,brokerage,stt,other_charges,gst,tds,total_charges,trader_charges,margin_blocked,broker_contract_note_no,broker_trade_id,tags,notes,is_locked,ignore_for_avg_cost,dont_display,created_at,updated_at&order=transaction_date.asc,transaction_time.asc.nullsfirst,id.asc'
    );
    console.log('Trading: Loaded ' + txnData.length + ' transactions (all types)');

    trTransactions = wmsSanitizeTransactions(txnData);

    // Refresh the shared tag autocomplete list from the freshly-loaded
    // transactions. This is the single source of truth for tag suggestions
    // across Add Transaction / Bonus / Split / Income / Rights / Hist P&L
    // modals (all of which read wmsRefData.tags). Keeping tags derived from
    // the in-memory array — instead of a separate DB query — guarantees
    // freshness after every save/import and side-steps the LESSONS A.1.14
    // 1000-row cap that silently dropped recent tags before 2026-05-12.
    if (typeof wmsRefreshTagsFromTransactions === 'function') {
        wmsRefreshTagsFromTransactions(trTransactions);
    }

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

    // Signal that initial transactions are in memory — lazy-loaded sub-modules
    // (Statements via trLoadLedgerModule, F&O) await `trDataReady` before
    // calling any function that filters `trTransactions`. Idempotent — safe
    // to call on every subsequent refresh (resolve() is a no-op once resolved).
    if (_trDataReadyResolve) { _trDataReadyResolve(); }
    window._trDataReadyResolved = true;
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

    // Rebuild symbol list (new transactions may have appeared) and force-refresh all prices
    if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
    await wmsStandardRefresh(true);

    // Transactions tab also needs explicit re-render (not price-driven)
    var activeTab = document.querySelector('.trading-tab-content.active');
    if (activeTab && activeTab.id === 'tr-transactions' && typeof trTxRender === 'function') {
        trTxRender();
    }

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
    var el = document.getElementById('fyers-refresh-time');
    if (!el) return;
    var now = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (status === 'loading') {
        el.textContent = 'Refreshing...';
        el.style.color = '#667eea';
    } else {
        // Always show last updated time; green if market open, red if closed
        el.textContent = now;
        var marketOpen = typeof wmsIsMarketHours === 'function' && wmsIsMarketHours();
        el.style.color = marketOpen ? '#059669' : '#dc2626';
    }
}

// ============================================================================
// PORTFOLIO AUTO-REFRESH — REMOVED (replaced by wmsStandardRefresh)
// Legacy function kept as no-op so any stray callers don't throw.
// ============================================================================
function trStartPortfolioAutoRefresh() { /* no-op: replaced by standard refresh */ }

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
        btn.classList.toggle('active', trShowZeroHoldings);
    }
    trRenderPortfolio();
}

// ============================================================================
// FILTERS (short_name / broker_code labels)
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

    // Tag filter (built from transactions) — case-insensitive dedup (Rule D.5.5)
    var tagContainer = document.getElementById('tr-filter-tag');
    if (tagContainer) {
        var tagItems = wmsBuildTagItems(trTransactions);
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
        filtered = filtered.filter(function(t) { var tid = t.trader_id || t.investor_id; return tid && trSelectedTraderIds.indexOf(tid) >= 0; });
    }
    if (trSelectedBrokerIds.length > 0) {
        filtered = filtered.filter(function(t) { return t.broker_id && trSelectedBrokerIds.indexOf(t.broker_id) >= 0; });
    }
    if (trSelectedTagNames.length > 0) {
        filtered = filtered.filter(function(t) {
            return wmsMatchTagsFilter(t.tags, trSelectedTagNames, trTagFilterLogic);
        });
    }

    // View Mode filter — use security_type (not exchange, which is always 'NSE' for NFO)
    if (trViewMode === 'holdings') {
        // Exclude F&O transactions
        filtered = filtered.filter(function(t) { return t.security_type !== 'NFO'; });
    } else if (trViewMode === 'fno') {
        // Only F&O transactions
        filtered = filtered.filter(function(t) { return t.security_type === 'NFO'; });
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

        if (txn.tags) txn.tags.forEach(function(tag) { if (tag) groups[key].tags[tag] = true; });
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

        // Compute non-NFO net quantity (for Stocks Day's P&L banner)
        var stockQty = 0;
        g.txns.forEach(function(t) {
            if (t.security_type !== 'NFO' && !wmsIsQtyExcluded(t.transaction_type)) {
                stockQty += t.quantity;
            }
        });

        // Resolve ISIN from securities master (needed for PE- fallback pricing)
        var _secMaster = g.securityId && wmsRefData.securitiesCmMap[g.securityId];
        // For zero-qty holdings, totalCost is residual realized P&L — display as 0 invested
        var displayTotalCost = calc.netQuantity === 0 ? 0 : calc.totalCost;
        var displayAvgCost = calc.netQuantity === 0 ? 0 : calc.avgCost;
        var rec = {
            key: key,
            symbol: g.symbol,
            shortSymbol: g.shortSymbol,
            companyName: g.companyName,
            securityId: g.securityId,
            isin: _secMaster ? _secMaster.isin : null,
            exchange: g.exchange,
            quantity: calc.netQuantity,
            stockQty: stockQty,
            totalCost: displayTotalCost,
            avgCost: displayAvgCost,
            tags: Object.keys(g.tags),
            latestPrice: g.latestPrice,
            _txns: g.txns    // raw transactions for Day P&L calculation
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

// Unified refresh — call after any transaction mutation (edit, delete, split).
// Refreshes all active views so the user sees updated data without a page reload.
// Modal refresh is handled by wmsTxnCtx.afterChange callback.
function trRefreshAllViews() {
    trRenderPortfolio();
    if (typeof trTxRender === 'function') trTxRender();
    if (typeof trFnoRender === 'function') trFnoRender();
}

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
                    valA = a._txns ? (wmsCalcStockDayPL(a._txns, mdA, null, {includeNfo:true}) || 0) : 0;
                    valB = b._txns ? (wmsCalcStockDayPL(b._txns, mdB, null, {includeNfo:true}) || 0) : 0;
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
        var dayPL = h._txns ? wmsCalcStockDayPL(h._txns, md, null, {includeNfo:true}) : (md ? h.quantity * md.ch : null);
        var dayChp = md ? md.chp : null;

        // CMP slider: use 52-week high/low from securities_db (not day H/L)
        var cmpSlider = '';
        var _sec52 = (wmsRefData.securitiesCm || []).find(function(s) {
            return s.symbol === h.shortSymbol || s.nse_symbol === h.shortSymbol || s.bse_symbol === h.shortSymbol;
        });
        if (_sec52 && _sec52.week_52_high && _sec52.week_52_low && _sec52.week_52_high > _sec52.week_52_low) {
            cmpSlider = trBuildSlider(price, _sec52.week_52_low, _sec52.week_52_high,
                formatPrice(_sec52.week_52_low, false), formatPrice(_sec52.week_52_high, false));
        }

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
    var hasLive = Object.keys(wmsLivePrices).length > 0 || Object.keys(trLiveData).length > 0;
    var totalDayPL = hasLive
        ? holdings.reduce(function(sum, h) { var m = trGetLiveData(h); return sum + (h._txns ? (wmsCalcStockDayPL(h._txns, m, null, {includeNfo:true}) || 0) : (m ? h.quantity * m.ch : 0)); }, 0)
        : null;
    var totalDayPLPct = (totalDayPL !== null && totalInvested !== 0)
        ? (totalDayPL / Math.abs(totalInvested)) * 100 : null;

    // Banner stats are now computed from default view filters via trComputeBannerStats()
    // (not from the active view). Refresh banner in case live prices updated.
    if (typeof trComputeBannerStats === 'function') trComputeBannerStats();

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
        symbolTxns = symbolTxns.filter(function(t) { var tid = t.trader_id || t.investor_id; return tid && trSelectedTraderIds.indexOf(tid) >= 0; });
    }
    if (trSelectedBrokerIds.length > 0) {
        symbolTxns = symbolTxns.filter(function(t) { return t.broker_id && trSelectedBrokerIds.indexOf(t.broker_id) >= 0; });
    }
    if (trSelectedTagNames.length > 0) {
        symbolTxns = symbolTxns.filter(function(t) {
            return wmsMatchTagsFilter(t.tags, trSelectedTagNames, trTagFilterLogic);
        });
    }
    // View Mode filter — use security_type (not exchange)
    if (trViewMode === 'holdings') {
        symbolTxns = symbolTxns.filter(function(t) { return t.security_type !== 'NFO'; });
    } else if (trViewMode === 'fno') {
        symbolTxns = symbolTxns.filter(function(t) { return t.security_type === 'NFO'; });
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
        if (txn.tags) txn.tags.forEach(function(tag) { if (tag) groups[txn.investor_id].tags[tag] = true; });
    });

    var investorRows = Object.values(groups)
        .map(function(g) {
            var calc = wmsCalcAvgCost(g.txns);
            g.quantity = calc.netQuantity;
            // Zero-qty: totalCost is residual realized P&L — display as 0
            g.totalCost = calc.netQuantity === 0 ? 0 : calc.totalCost;
            g.avgCost = calc.netQuantity === 0 ? 0 : calc.avgCost;
            return g;
        })
        .filter(function(g) { return g.txns.length > 0; })
        .map(function(g) {
            var avg = g.avgCost;
            var inv = g.totalCost;
            var val = g.quantity * price;
            var pl = val - inv;
            var plPct = inv !== 0 ? (pl / Math.abs(inv)) * 100 : 0;
            var dayPL = g.txns ? wmsCalcStockDayPL(g.txns, md, null, {includeNfo:true}) : (md ? g.quantity * md.ch : null);
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
// TRANSACTIONS MODAL (thin wrappers to shared modal)
// ============================================================================

// Build/refresh wmsTxnCtx with the Trading module's current data. Must be
// called BEFORE any txn-modal open. The shared modal (`wmsEditModalOpen`,
// `wmsTxnModalOpen`) silently bails with `if (!wmsTxnCtx) return;` — so
// forgetting this step = invisible no-op on click. Callable from both the
// list-modal entry (trOpenTxnModal) and the direct row-click edit entry
// (trOpenEditModal on the Transactions tab).
function _trSetTxnCtx() {
    wmsTxnCtx = {
        module: 'trading',
        transactions: trTransactions,
        investors: trInvestors,
        brokers: trBrokers,
        getPrice: function(shortSymbol) {
            return trGetPrice({ shortSymbol: shortSymbol, symbol: shortSymbol, exchange: 'NSE', latestPrice: 0 });
        },
        getLiveData: function(shortSymbol) {
            return trGetLiveData({ shortSymbol: shortSymbol, symbol: shortSymbol });
        },
        afterChange: function() {
            if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
            trRefreshAllViews();
        },
        filterOverride: window.trTxnModalFilterOverride || null
    };
    if (!wmsTxnCtx.filterOverride) {
        wmsTxnCtx.filterOverride = {
            investorIds: trSelectedInvestorIds,
            traderIds: trSelectedTraderIds,
            brokerIds: trSelectedBrokerIds,
            tagNames: trSelectedTagNames,
            tagLogic: trTagFilterLogic
        };
    }
}

function trOpenTxnModal(companyKey, investorId) {
    _trSetTxnCtx();
    wmsTxnModalOpen(companyKey, investorId);
}

function trCloseTxnModal() {
    wmsTxnModalClose();
    window.trTxnModalFilterOverride = null;
}

function trOpenEditModal(txnId) {
    // Row-click on Trading → Transactions tab comes here WITHOUT first going
    // through the list modal, so wmsTxnCtx may be null. Always reset it.
    _trSetTxnCtx();
    wmsEditModalOpen(txnId);
}

function trCloseEditModal() {
    wmsEditModalClose();
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

            // Remove any previous container before creating a fresh one.
            // Without this, a module switch-away + switch-back would stack up
            // duplicate #tr-add-txn-container divs in the DOM with duplicate
            // element IDs — getElementById returns the FIRST one, so listeners
            // end up attached to orphaned DOM. See LESSONS A.1.2a.
            var oldAtContainer = document.getElementById('tr-add-txn-container');
            if (oldAtContainer) oldAtContainer.remove();

            // Inject body content (modal overlays) into a container div
            var container = document.createElement('div');
            container.id = 'tr-add-txn-container';
            container.innerHTML = doc.body ? doc.body.innerHTML : htmlText;
            document.body.appendChild(container);

            // Load JS — remove any old script tag first (prevents double-init on reload)
            var oldAtScript = document.querySelector('script[src*="trading-add-transaction.js"]');
            if (oldAtScript) oldAtScript.remove();
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
// RIGHTS MODULE (loaded on demand)
// ============================================================================

var trRightsLoaded = false;
var trRightsLoading = false;       // prevents race condition on double-click
var trRightsCallbacks = [];        // queued callbacks while loading

async function trLoadRightsModule(callback) {
    if (trRightsLoaded) {
        if (typeof callback === 'function') callback();
        return;
    }
    // Queue callback if already loading (prevents double-load on fast clicks)
    if (trRightsLoading) {
        if (typeof callback === 'function') trRightsCallbacks.push(callback);
        return;
    }
    trRightsLoading = true;
    if (typeof callback === 'function') trRightsCallbacks.push(callback);

    try {
        // Load HTML
        var htmlResp = await fetch('trading-rights.html?t=' + Date.now());
        if (!htmlResp.ok) throw new Error('Failed to load trading-rights.html');
        var htmlText = await htmlResp.text();

        // Extract <style> and inject to <head>
        var parser = new DOMParser();
        var doc = parser.parseFromString(htmlText, 'text/html');
        var styles = doc.querySelectorAll('style');
        styles.forEach(function(s) { document.head.appendChild(s.cloneNode(true)); });

        // Remove old container before creating a fresh one — prevents
        // duplicate DOM IDs when the module re-loads. See LESSONS A.1.2a.
        var oldRhContainer = document.getElementById('tr-rights-container');
        if (oldRhContainer) oldRhContainer.remove();

        // Inject body content (modal overlays) into a container div
        var container = document.createElement('div');
        container.id = 'tr-rights-container';
        container.innerHTML = doc.body ? doc.body.innerHTML : htmlText;
        document.body.appendChild(container);

        // Load JS (remove any existing script tag first to prevent duplicates)
        var oldScript = document.querySelector('script[src*="trading-rights.js"]');
        if (oldScript) oldScript.remove();
        await new Promise(function(resolve, reject) {
            var script = document.createElement('script');
            script.src = 'trading-rights.js?t=' + Date.now();
            script.onload = resolve;
            script.onerror = function() { reject(new Error('Failed to load trading-rights.js')); };
            document.body.appendChild(script);
        });

        trRightsLoaded = true;

        // Small delay for init to complete, then fire all queued callbacks
        setTimeout(function() {
            if (typeof initRightsModule === 'function') initRightsModule();
            trRightsCallbacks.forEach(function(cb) { cb(); });
            trRightsCallbacks = [];
        }, 100);
    } catch (err) {
        console.error('Trading: Failed to load rights module:', err);
        showAlert('Failed to load Rights module: ' + err.message, 'error');
        trRightsLoading = false;
        trRightsCallbacks = [];
    }
}

// ============================================================================
// BONUS MODULE (loaded on demand — same pattern as Rights)
// ============================================================================

var trBonusLoaded = false;
var trBonusLoading = false;
var trBonusCallbacks = [];

async function trLoadBonusModule(callback) {
    if (trBonusLoaded) {
        if (typeof callback === 'function') callback();
        return;
    }
    if (trBonusLoading) {
        if (typeof callback === 'function') trBonusCallbacks.push(callback);
        return;
    }
    trBonusLoading = true;
    if (typeof callback === 'function') trBonusCallbacks.push(callback);

    try {
        // Load HTML
        var htmlResp = await fetch('trading-bonus.html?t=' + Date.now());
        if (!htmlResp.ok) throw new Error('Failed to load trading-bonus.html');
        var htmlText = await htmlResp.text();

        // Extract <style> and inject to <head>
        var parser = new DOMParser();
        var doc = parser.parseFromString(htmlText, 'text/html');
        var styles = doc.querySelectorAll('style');
        styles.forEach(function(s) { document.head.appendChild(s.cloneNode(true)); });

        // Remove old container before creating a fresh one — prevents
        // duplicate DOM IDs on module re-load. See LESSONS A.1.2a.
        var oldBonusContainer = document.getElementById('tr-bonus-container');
        if (oldBonusContainer) oldBonusContainer.remove();

        // Inject body content (modal overlay) into a container div
        var container = document.createElement('div');
        container.id = 'tr-bonus-container';
        container.innerHTML = doc.body ? doc.body.innerHTML : htmlText;
        document.body.appendChild(container);

        // Load JS
        var oldScript = document.querySelector('script[src*="trading-bonus.js"]');
        if (oldScript) oldScript.remove();
        await new Promise(function(resolve, reject) {
            var script = document.createElement('script');
            script.src = 'trading-bonus.js?t=' + Date.now();
            script.onload = resolve;
            script.onerror = function() { reject(new Error('Failed to load trading-bonus.js')); };
            document.body.appendChild(script);
        });

        trBonusLoaded = true;

        // Small delay for init to complete, then fire all queued callbacks
        setTimeout(function() {
            if (typeof initBonusModule === 'function') initBonusModule();
            trBonusCallbacks.forEach(function(cb) { cb(); });
            trBonusCallbacks = [];
        }, 100);
    } catch (err) {
        console.error('Trading: Failed to load bonus module:', err);
        showAlert('Failed to load Bonus module: ' + err.message, 'error');
        trBonusLoading = false;
        trBonusCallbacks = [];
    }
}

// ============================================================================
// EXPIRY SETTLEMENT MODULE (loaded on demand — JS-only, no separate HTML file;
//   the module injects its own modal DOM on first open)
// ============================================================================

var trExpiryLoaded = false;
var trExpiryLoading = false;
var trExpiryCallbacks = [];

async function trLoadExpiryModule(callback) {
    if (trExpiryLoaded) {
        if (typeof callback === 'function') callback();
        return;
    }
    if (trExpiryLoading) {
        if (typeof callback === 'function') trExpiryCallbacks.push(callback);
        return;
    }
    trExpiryLoading = true;
    if (typeof callback === 'function') trExpiryCallbacks.push(callback);

    try {
        var oldScript = document.querySelector('script[src*="trading-expiry.js"]');
        if (oldScript) oldScript.remove();
        await new Promise(function(resolve, reject) {
            var script = document.createElement('script');
            script.src = 'trading-expiry.js?t=' + Date.now();
            script.onload = resolve;
            script.onerror = function() { reject(new Error('Failed to load trading-expiry.js')); };
            document.body.appendChild(script);
        });
        trExpiryLoaded = true;
        trExpiryCallbacks.forEach(function(cb) { cb(); });
        trExpiryCallbacks = [];
    } catch (err) {
        console.error('Trading: Failed to load expiry module:', err);
        showAlert('Failed to load Expiry module: ' + err.message, 'error');
        trExpiryLoading = false;
        trExpiryCallbacks = [];
    }
}

// ============================================================================
// SPLIT MODULE (loaded on demand — same pattern as Bonus)
// ============================================================================

var trSplitLoaded = false;
var trSplitLoading = false;
var trSplitCallbacks = [];

async function trLoadSplitModule(callback) {
    if (trSplitLoaded) {
        if (typeof callback === 'function') callback();
        return;
    }
    if (trSplitLoading) {
        if (typeof callback === 'function') trSplitCallbacks.push(callback);
        return;
    }
    trSplitLoading = true;
    if (typeof callback === 'function') trSplitCallbacks.push(callback);

    try {
        // Load HTML
        var htmlResp = await fetch('trading-split.html?t=' + Date.now());
        if (!htmlResp.ok) throw new Error('Failed to load trading-split.html');
        var htmlText = await htmlResp.text();

        // Extract <style> and inject to <head>
        var parser = new DOMParser();
        var doc = parser.parseFromString(htmlText, 'text/html');
        var styles = doc.querySelectorAll('style');
        styles.forEach(function(s) { document.head.appendChild(s.cloneNode(true)); });

        // Remove old container before creating a fresh one — prevents
        // duplicate DOM IDs on module re-load. See LESSONS A.1.2a.
        var oldSplitContainer = document.getElementById('tr-split-container');
        if (oldSplitContainer) oldSplitContainer.remove();

        // Inject body content (modal overlay) into a container div
        var container = document.createElement('div');
        container.id = 'tr-split-container';
        container.innerHTML = doc.body ? doc.body.innerHTML : htmlText;
        document.body.appendChild(container);

        // Load JS
        var oldScript = document.querySelector('script[src*="trading-split.js"]');
        if (oldScript) oldScript.remove();
        await new Promise(function(resolve, reject) {
            var script = document.createElement('script');
            script.src = 'trading-split.js?t=' + Date.now();
            script.onload = resolve;
            script.onerror = function() { reject(new Error('Failed to load trading-split.js')); };
            document.body.appendChild(script);
        });

        trSplitLoaded = true;

        // Small delay for init to complete, then fire all queued callbacks
        setTimeout(function() {
            if (typeof initSplitModule === 'function') initSplitModule();
            trSplitCallbacks.forEach(function(cb) { cb(); });
            trSplitCallbacks = [];
        }, 100);
    } catch (err) {
        console.error('Trading: Failed to load split module:', err);
        showAlert('Failed to load Split module: ' + err.message, 'error');
        trSplitLoading = false;
        trSplitCallbacks = [];
    }
}

// ============================================================================
// INCOME MODULE (loaded on demand — same pattern as Rights)
// ============================================================================

var trIncomeLoaded = false;
var trIncomeLoading = false;
var trIncomeCallbacks = [];

async function trLoadIncomeModule(callback) {
    if (trIncomeLoaded) {
        if (typeof callback === 'function') callback();
        return;
    }
    if (trIncomeLoading) {
        if (typeof callback === 'function') trIncomeCallbacks.push(callback);
        return;
    }
    trIncomeLoading = true;
    if (typeof callback === 'function') trIncomeCallbacks.push(callback);

    // Income module needs the Rights module for date widget functions
    // Load Rights first if not already loaded
    if (!trRightsLoaded) {
        await new Promise(function(resolve, reject) {
            trLoadRightsModule(resolve);
            // Timeout safety: if rights doesn't load in 10s, reject
            setTimeout(function() { reject(new Error('Rights module timeout')); }, 10000);
        }).catch(function(err) {
            console.warn('Trading: Rights pre-load warning:', err.message);
        });
    }

    try {
        // Load HTML
        var htmlResp = await fetch('trading-income.html?t=' + Date.now());
        if (!htmlResp.ok) throw new Error('Failed to load trading-income.html');
        var htmlText = await htmlResp.text();

        // Extract <style> and inject to <head>
        var parser = new DOMParser();
        var doc = parser.parseFromString(htmlText, 'text/html');
        var styles = doc.querySelectorAll('style');
        styles.forEach(function(s) { document.head.appendChild(s.cloneNode(true)); });

        // Remove old container before creating a fresh one — prevents
        // duplicate DOM IDs on module re-load. See LESSONS A.1.2a.
        var oldIncContainer = document.getElementById('tr-income-container');
        if (oldIncContainer) oldIncContainer.remove();

        // Inject body content
        var container = document.createElement('div');
        container.id = 'tr-income-container';
        container.innerHTML = doc.body ? doc.body.innerHTML : htmlText;
        document.body.appendChild(container);

        // Load JS
        var oldScript = document.querySelector('script[src*="trading-income.js"]');
        if (oldScript) oldScript.remove();
        await new Promise(function(resolve, reject) {
            var script = document.createElement('script');
            script.src = 'trading-income.js?t=' + Date.now();
            script.onload = resolve;
            script.onerror = function() { reject(new Error('Failed to load trading-income.js')); };
            document.body.appendChild(script);
        });

        trIncomeLoaded = true;

        // Small delay for init to complete, then fire all queued callbacks
        setTimeout(function() {
            trIncomeCallbacks.forEach(function(cb) { cb(); });
            trIncomeCallbacks = [];
        }, 100);
    } catch (err) {
        console.error('Trading: Failed to load income module:', err);
        showAlert('Failed to load Income module: ' + err.message, 'error');
        trIncomeLoading = false;
        trIncomeCallbacks = [];
    }
}

// ============================================================================
// HISTORICAL P&L MODULE (lazy-loaded)
// ============================================================================

var trHistPlLoaded = false;
var trHistPlLoading = false;
var trHistPlCallbacks = [];

async function trLoadHistPlModule(callback) {
    if (trHistPlLoaded) {
        if (typeof callback === 'function') callback();
        return;
    }
    if (trHistPlLoading) {
        if (typeof callback === 'function') trHistPlCallbacks.push(callback);
        return;
    }
    trHistPlLoading = true;
    if (typeof callback === 'function') trHistPlCallbacks.push(callback);

    // HistPl module needs Rights module for date widget functions
    if (!trRightsLoaded) {
        await new Promise(function(resolve, reject) {
            trLoadRightsModule(resolve);
            setTimeout(function() { reject(new Error('Rights module timeout')); }, 10000);
        }).catch(function(err) {
            console.warn('Trading: Rights pre-load warning:', err.message);
        });
    }

    try {
        var htmlResp = await fetch('trading-histpl.html?t=' + Date.now());
        if (!htmlResp.ok) throw new Error('Failed to load trading-histpl.html');
        var htmlText = await htmlResp.text();

        var parser = new DOMParser();
        var doc = parser.parseFromString(htmlText, 'text/html');
        var styles = doc.querySelectorAll('style');
        styles.forEach(function(s) { document.head.appendChild(s.cloneNode(true)); });

        // Remove old container before creating a fresh one — prevents
        // duplicate DOM IDs on module re-load. See LESSONS A.1.2a.
        var oldHplContainer = document.getElementById('tr-histpl-container');
        if (oldHplContainer) oldHplContainer.remove();

        var container = document.createElement('div');
        container.id = 'tr-histpl-container';
        container.innerHTML = doc.body ? doc.body.innerHTML : htmlText;
        document.body.appendChild(container);

        var oldScript = document.querySelector('script[src*="trading-histpl.js"]');
        if (oldScript) oldScript.remove();
        await new Promise(function(resolve, reject) {
            var script = document.createElement('script');
            script.src = 'trading-histpl.js?t=' + Date.now();
            script.onload = resolve;
            script.onerror = function() { reject(new Error('Failed to load trading-histpl.js')); };
            document.body.appendChild(script);
        });

        trHistPlLoaded = true;

        setTimeout(function() {
            trHistPlCallbacks.forEach(function(cb) { cb(); });
            trHistPlCallbacks = [];
        }, 100);
    } catch (err) {
        console.error('Trading: Failed to load HistPl module:', err);
        showAlert('Failed to load Historical P&L module: ' + err.message, 'error');
        trHistPlLoading = false;
        trHistPlCallbacks = [];
    }
}

// ============================================================================
// SAVED PORTFOLIO VIEWS — delegated to trPortfolioVM (wmsViewManager instance)
// ============================================================================

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
// STATEMENTS TAB (lazy-loaded from trading-ledger.html + trading-ledger.js)
// ============================================================================

var trLedgerLoaded = false;
async function trLoadLedgerModule() {
    if (!trLedgerLoaded) {
        try {
            var container = document.getElementById('tr-ledger');
            if (!container) return;
            // Fetch HTML
            var resp = await fetch('trading-ledger.html?t=' + Date.now());
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            var html = await resp.text();
            container.innerHTML = html;
            // Load JS
            await new Promise(function(resolve, reject) {
                var script = document.createElement('script');
                script.src = 'trading-ledger.js?t=' + Date.now();
                script.onload = resolve;
                script.onerror = function() { reject(new Error('Failed to load trading-ledger.js')); };
                document.body.appendChild(script);
            });
            trLedgerLoaded = true;
        } catch (err) {
            console.error('Trading: Failed to load Statements module:', err);
            var c = document.getElementById('tr-ledger');
            if (c) c.innerHTML = '<div style="text-align:center;padding:40px;color:#dc2626;">Failed to load Statements module: ' + err.message + '</div>';
            return;
        }
    }
    // Ensure reference data is loaded before initializing statements filters
    if (!wmsRefData.ready) await wmsLoadRefData();
    if (!trInvestors || trInvestors.length === 0) {
        trInvestors = wmsRefData.investors || [];
        trBrokers  = wmsRefData.brokers  || [];
    }
    // Race-condition fix (LESSONS §A.1.18): trRestoreTab kicks this module off
    // BEFORE initTrading awaits trLoadData. Without this await, lgRefresh runs
    // with an empty trTransactions, wmsBuildLedger emits a partial ledger
    // (OB + interest only, no trades), and lgCheckReconDrift then flags a
    // spurious "balance mismatch" on any view that has a RECONCILIATION row.
    // The drift number equals exactly the sum of pre-recon trades that the
    // engine couldn't see. Waiting until trDataReady resolves guarantees a
    // consistent first paint.
    if (window.trDataReady && typeof window.trDataReady.then === 'function') {
        await window.trDataReady;
    }
    if (typeof lgInit === 'function') { lgInit(); lgRefresh(); }
}

// (Old statements code removed — now lazy-loaded from trading-ledger.js)

// ============================================================================
// WINDOW EXPORTS
// ============================================================================

window.initTrading = initTrading;
