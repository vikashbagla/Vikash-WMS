// ============================================================================
// WMS TRADING MODULE
// ============================================================================
// Uses 'tr' prefix to avoid naming conflicts with utils.js.
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
var trDefaultViewFilters = null;   // Filters from the default Portfolio view (for banner)
var trDefaultFnoViewFilters = null; // Filters from the default F&O view (for banner)
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
    var invIds = f.investorIds || [];
    var trdIds = f.traderIds || [];
    var brkIds = f.brokerIds || [];
    var tagNames = f.tagNames || [];
    var tagLogic = f.tagLogic || 'OR';

    var txns = trTransactions.filter(function(t) {
        return t.security_type === 'NFO' || t.security_type === 'MCX';
    });
    if (invIds.length > 0) txns = txns.filter(function(t) { return invIds.indexOf(t.investor_id) >= 0; });
    if (trdIds.length > 0) txns = txns.filter(function(t) { var tid = t.trader_id || t.investor_id; return tid && trdIds.indexOf(tid) >= 0; });
    if (brkIds.length > 0) txns = txns.filter(function(t) { return t.broker_id && brkIds.indexOf(t.broker_id) >= 0; });
    if (tagNames.length > 0) txns = txns.filter(function(t) { return wmsMatchTagsFilter(t.tags, tagNames, tagLogic); });

    // Fetch contract prices
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

    // Compute open + closed-today position totals using the shared LIFO engine.
    // MIGRATED (2026-04-11) from inline matching loop to `wmsCalcLifoCost` per
    // (investor|trader|broker|contract) slice. Live-diff: zero delta. See §J.5.H.
    var trades = txns.filter(function(t) { return t.transaction_type === 'BUY' || t.transaction_type === 'SELL'; });
    var totDayPnl = 0, totExposure = 0;
    var todayStr = new Date().toISOString().slice(0, 10);

    // Group trades by (inv|trd|brk|fullSym) — each group becomes one engine run.
    var byGroup = {};
    trades.forEach(function(t) {
        var fullSym = (t.symbol || '').replace(/^[A-Z]+:/, '');
        var key = (t.investor_id || '') + '|' + (t.trader_id || t.investor_id || '') + '|' + (t.broker_id || '') + '|' + fullSym;
        if (!byGroup[key]) byGroup[key] = { fullSym: fullSym, txns: [] };
        byGroup[key].txns.push(t);
    });

    Object.keys(byGroup).forEach(function(key) {
        var g = byGroup[key];
        var sorted = g.txns.slice().sort(function(a, b) {
            var da = a.transaction_date || '', db = b.transaction_date || '';
            if (da !== db) return da < db ? -1 : 1;
            return (a.id || 0) - (b.id || 0);
        });
        var result = wmsCalcLifoCost(sorted);
        var cache = wmsLivePrices[g.fullSym];

        // Closed-today Day P&L: one gain per match.
        result.gains.forEach(function(gain) {
            var isShort = gain.sellDate < gain.buyDate;
            var closerDate = isShort ? gain.buyDate : gain.sellDate;
            if (closerDate !== todayStr) return;
            var openerDate = isShort ? gain.sellDate : gain.buyDate;
            var openerPpu  = isShort ? gain.sellProceedsPerUnit : gain.buyCostPerUnit;
            var closerPpu  = isShort ? gain.buyCostPerUnit : gain.sellProceedsPerUnit;
            totDayPnl += wmsCalcFnoClosedTodayPnl(gain.qty, isShort, openerDate, openerPpu, closerPpu, cache, todayStr);
        });

        // Exposure + open-position Day P&L: one row per surviving lot.
        Object.keys(result.holdings).forEach(function(hk) {
            result.holdings[hk].lots.forEach(function(lot) {
                if (!lot.qty) return;
                var isShort = lot.qty < 0;
                var absQty = Math.abs(lot.qty);
                totExposure += absQty * lot.costPerUnit;
                totDayPnl += wmsCalcFnoDayPnl(absQty, isShort, lot.date, lot.costPerUnit, cache);
            });
        });
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
    document.getElementById('trEditDeleteBtn').addEventListener('click', function() {
        if (!trEditingTxnId) return;
        var txnId = trEditingTxnId;
        trCloseEditModal();
        trDeleteTransaction(txnId);
    });
    document.getElementById('trEditModal').addEventListener('click', function(e) {
        if (e.target === this) trCloseEditModal();
    });

    // Split transaction — toggle panel, preview, confirm
    document.getElementById('trSplitBtn').addEventListener('click', trToggleSplitPanel);
    document.getElementById('trSplitPreviewBtn').addEventListener('click', trPreviewSplit);
    document.getElementById('trSplitConfirmBtn').addEventListener('click', trExecuteSplit);

    // Edit modal — recalculate trader_charges when trader changes
    document.getElementById('trEditTrader').addEventListener('change', trRecalcTraderCharges);

    // Edit modal — recalculate amounts when qty or price changes
    document.getElementById('trEditQty').addEventListener('input', trRecalcEditAmounts);
    document.getElementById('trEditPrice').addEventListener('input', trRecalcEditAmounts);

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
function trRefreshAllViews() {
    trRenderPortfolio();
    if (trCurrentTxnModalKey) trTxnRefreshCurrentView();
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
        var activeView = trPortfolioVM.views.find(function(v) { return v.id === trPortfolioVM.activeViewId; });
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
    // Apply active view filters (same as trCalcHoldings / trBuildInvestorDetail).
    // If an external override is set (e.g. the Statements module opening the
    // modal from its own view scope), use those arrays instead of Portfolio's.
    var _ov = window.trTxnModalFilterOverride || null;
    var _invSel = _ov ? (_ov.investorIds || []) : trSelectedInvestorIds;
    var _trdSel = _ov ? (_ov.traderIds   || []) : trSelectedTraderIds;
    var _brkSel = _ov ? (_ov.brokerIds   || []) : trSelectedBrokerIds;
    var _tagSel = _ov ? (_ov.tagNames    || []) : trSelectedTagNames;
    var _tagLogic = _ov ? (_ov.tagLogic  || 'OR') : trTagFilterLogic;
    if (_invSel.length > 0) {
        txns = txns.filter(function(t) { return _invSel.indexOf(t.investor_id) >= 0; });
    }
    if (_trdSel.length > 0) {
        txns = txns.filter(function(t) { var tid = t.trader_id || t.investor_id; return tid && _trdSel.indexOf(tid) >= 0; });
    }
    if (_brkSel.length > 0) {
        txns = txns.filter(function(t) { return t.broker_id && _brkSel.indexOf(t.broker_id) >= 0; });
    }
    if (_tagSel.length > 0) {
        txns = txns.filter(function(t) {
            return wmsMatchTagsFilter(t.tags, _tagSel, _tagLogic);
        });
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
        if (!wmsIsQtyExcluded(t.transaction_type)) {
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
            var typeClass = (txn.transaction_type === 'BUY' || txn.transaction_type === 'RIGHTS_ENTITLEMENT') ? 'positive' : (txn.transaction_type === 'SELL' ? 'negative' : (txn.transaction_type === 'RIGHTS_PAYMENT' ? 'neutral' : ''));
            var qty = txn.quantity || 0;
            var _dispNet = txn.display_net_amount !== undefined ? txn.display_net_amount : txn.net_amount;
            var val = _dispNet || txn.gross_amount || 0;
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
    // Zero-qty: totalCost is residual realized P&L — display as 0
    var totalCost = netQty === 0 ? 0 : calc.totalCost;
    var avgCost = netQty === 0 ? 0 : calc.avgCost;

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
    // Clear any cross-module filter override installed by another module
    // (e.g. the Statements module opening the modal in its own view scope).
    window.trTxnModalFilterOverride = null;
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

    // MIGRATED (2026-04-11) to the shared FIFO/LIFO cost engine. Previously
    // used an inline per-contract matching loop that pre-filtered to BUY/SELL
    // only and grouped by raw `t.symbol` (no prefix strip). The shared engine
    // (a) handles corporate actions correctly (BONUS/RIGHTS_ENTITLEMENT as
    // zero-cost lots), (b) treats closers beyond available lots as new short
    // positions (replacing the old `unmatched-closer` row type), and (c)
    // normalises exchange-prefixed NFO symbols before grouping. User signed
    // off on all three delta categories 2026-04-11. See WMS-LESSONS §J.5.H.

    // Group by investor_id + trader_id + broker_id + full symbol (contract level),
    // stripping any exchange prefix so mixed-prefix NFO rows collapse correctly.
    var groups = {};
    txns.forEach(function(t) {
        // Engine-relevant txn types only (skip DIVIDEND/INTEREST/OTHER_INCOME
        // — these don't affect the matching display). The engine itself skips
        // them internally too, but excluding here keeps empty-group filtering
        // clean.
        var tt = t.transaction_type;
        if (tt !== 'BUY' && tt !== 'SELL' &&
            tt !== 'BONUS' && tt !== 'RIGHTS_ENTITLEMENT' &&
            tt !== 'RIGHTS_PAYMENT' && tt !== 'CAPITAL_REDUCTION' &&
            tt !== 'HISTORICAL_PL') return;
        var invId = t.investor_id || '';
        var trdId = t.trader_id || t.investor_id || '';  // normalize: empty trader = investor
        var brkId = t.broker_id || '';
        var fullSym = (t.symbol || t.short_symbol || '').replace(/^[A-Z]+:/, '');
        var key = invId + '|' + trdId + '|' + brkId + '|' + fullSym;
        if (!groups[key]) {
            groups[key] = {
                investorId: t.investor_id,
                traderId: t.trader_id,
                brokerId: t.broker_id,
                fullSymbol: fullSym,
                shortSymbol: t.short_symbol || t.symbol || '',
                contractLabel: wmsFormatContract(t),
                txns: []
            };
        }
        groups[key].txns.push(t);
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
    var matchMethod = trTxnMatchMethod === 'lifo' ? 'lifo' : 'fifo';

    Object.keys(groups).sort().forEach(function(key) {
        var g = groups[key];

        // Apply expiry filter
        if (trTxnContractFilter.length > 0 && trTxnContractFilter.indexOf(trGetExpiryLabel(g.contractLabel)) < 0) return;

        // Sort chronologically (stable tiebreak by txn id)
        var sorted = g.txns.slice().sort(function(a, b) {
            var da = a.transaction_date || '', db = b.transaction_date || '';
            if (da !== db) return da < db ? -1 : 1;
            return (a.id || 0) - (b.id || 0);
        });

        // Delegate to shared engine.
        var result = matchMethod === 'lifo' ? wmsCalcLifoCost(sorted) : wmsCalcFifoCost(sorted);

        // Get CMP: use contract-specific price for F&O, equity price for stocks
        var contractCache = wmsLivePrices[g.fullSymbol];
        var cmp = contractCache ? contractCache.lp : trGetPrice({ shortSymbol: g.shortSymbol, symbol: g.shortSymbol, exchange: 'NSE', latestPrice: 0 });

        var matchedRows = [];

        // Matched rows from gains[]
        result.gains.forEach(function(gain) {
            var rowIsShort = gain.sellDate < gain.buyDate;
            matchedRows.push({
                type: 'matched', isShort: rowIsShort,
                qty: gain.qty,
                buyDate: gain.buyDate, buyAvg: gain.buyCostPerUnit, buyAmount: gain.buyCost,
                sellDate: gain.sellDate, sellAvg: gain.sellProceedsPerUnit, sellAmount: gain.sellProceeds,
                pnl: gain.gain,
                buyTxnId: gain.buyTxnId, sellTxnId: gain.sellTxnId
            });
        });

        // Open rows from holdings[].lots — includes what were previously
        // labelled "unmatched-closer" (they become short-open lots).
        Object.keys(result.holdings).forEach(function(hk) {
            result.holdings[hk].lots.forEach(function(lot) {
                if (!lot.qty) return;
                var lotIsShort = lot.qty < 0;
                var absQty = Math.abs(lot.qty);
                var ppu = lot.costPerUnit;
                var row = {
                    type: 'open', isShort: lotIsShort,
                    qty: absQty, pnl: 0,
                    openerTxnId: lot.txnId
                };
                if (lotIsShort) {
                    row.buyDate = null; row.buyAvg = 0; row.buyAmount = 0;
                    row.sellDate = lot.date; row.sellAvg = ppu; row.sellAmount = absQty * ppu;
                } else {
                    row.buyDate = lot.date; row.buyAvg = ppu; row.buyAmount = absQty * ppu;
                    row.sellDate = null; row.sellAvg = 0; row.sellAmount = 0;
                }
                if (cmp > 0) {
                    row.cmp = cmp;
                    var openCostR = lotIsShort ? row.sellAmount : row.buyAmount;
                    var openValue = absQty * cmp;
                    row.unrealisedPnl = lotIsShort ? (openCostR - openValue) : (openValue - openCostR);
                }
                matchedRows.push(row);
            });
        });

        if (matchedRows.length === 0) return;

        // Group isShort: derive from open lot direction if any, else first row
        var isShort = false;
        var openRow = null;
        for (var ri = 0; ri < matchedRows.length; ri++) {
            if (matchedRows[ri].type === 'open') { openRow = matchedRows[ri]; break; }
        }
        if (openRow) isShort = openRow.isShort;
        else if (matchedRows.length > 0) isShort = matchedRows[0].isShort;

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
        headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'}),
        body: JSON.stringify(body)
    });

    if (resp.ok) {
        txn[flagName] = newValue;
        showAlert(flagName.replace(/_/g, ' ') + ' ' + (newValue ? 'enabled' : 'disabled'), 'success', 2000);
        trRefreshAllViews();
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
        headers: wmsHeaders({'Prefer': 'return=minimal'})
    });

    if (resp.ok) {
        trTransactions = trTransactions.filter(function(t) { return t.id !== txnId; });
        showAlert('Transaction deleted', 'success', 2000);
        if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
        trRefreshAllViews();
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
    var currentTags = (txn.tags || []).filter(function(t) { return !!t; });
    // Collect all existing tags across transactions for autocomplete
    var allExistingTags = {};
    trTransactions.forEach(function(t) {
        if (t.tags) t.tags.forEach(function(tag) { if (tag) allExistingTags[tag] = true; });
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

    // Reset split panel
    document.getElementById('trSplitSection').style.display = 'none';
    document.getElementById('trSplitQty').value = '';
    document.getElementById('trSplitStatus').textContent = '';

    // Disable editable fields and Save button if locked
    var isLocked = !!txn.is_locked;
    var editableFields = document.querySelectorAll('#trEditForm .editable-field, #trEditForm select.editable-field, #trEditForm input[type="checkbox"]:not(#trEditLocked)');
    editableFields.forEach(function(f) { f.disabled = isLocked; });
    document.getElementById('trEditSaveBtn').disabled = isLocked;
    document.getElementById('trEditDeleteBtn').disabled = isLocked;
    document.getElementById('trSplitBtn').disabled = isLocked;
    document.getElementById('trEditModalTitle').textContent = isLocked ? 'View Transaction (Locked)' : 'Edit Transaction';

    document.getElementById('trEditModal').classList.add('show');
}

function trCloseEditModal() {
    document.getElementById('trEditModal').classList.remove('show');
    trEditingTxnId = null;
    _trSplitData = null;
}

// Recalculate gross, charges, and net when qty or price changes in edit modal
function trRecalcEditAmounts() {
    if (!trEditingTxnId) return;
    var txn = trTransactions.find(function(t) { return t.id === trEditingTxnId; });
    if (!txn) return;

    var qty = trEditParse(document.getElementById('trEditQty'));
    var price = trEditParse(document.getElementById('trEditPrice'));
    var gross = wmsRoundMoney(Math.abs(qty) * price);

    document.getElementById('trEditGross').value = trEditFmt(gross);

    // Build a temporary row object for charge calculation
    var isSell = txn.transaction_type === 'SELL';
    var tempRow = {
        quantity: isSell ? -qty : qty,
        price: price,
        gross_amount: gross,
        transaction_type: txn.transaction_type,
        security_type: txn.security_type,
        asset_class: txn.asset_class,
        exchange: txn.exchange,
        product: txn.product,
        lots: parseFloat(txn.lots) || 0,
        lot_size: txn.lot_size || 1,
        brokerage: 0,
        stt: 0,
        other_charges: 0,
        gst: 0,
        tds: 0,
        total_charges: 0,
        trader_charges: 0,
        net_amount: 0,
        _exchange_charges: 0,
        _sebi_charges: 0,
        _stamp_duty: 0,
        _ipft: 0
    };

    // Calculate charges using the canonical function
    if (typeof wmsAutoCalcCharges === 'function' && wmsRefData) {
        wmsAutoCalcCharges(tempRow, {
            ibaRatesMap: wmsRefData.ibaRatesMap,
            regCharges: wmsRefData.regCharges,
            investorId: txn.investor_id,
            brokerId: txn.broker_id,
            preserveExisting: false,
            debug: false
        });
    }

    // Update all charge fields
    document.getElementById('trEditBrokerage').value = trEditFmt(tempRow.brokerage);
    document.getElementById('trEditStt').value = trEditFmt(tempRow.stt);
    document.getElementById('trEditOther').value = trEditFmt(tempRow.other_charges);
    document.getElementById('trEditGst').value = trEditFmt(tempRow.gst);
    document.getElementById('trEditTotalCharges').value = trEditFmt(tempRow.total_charges);
    document.getElementById('trEditNetAmount').value = trEditFmt(tempRow.net_amount);

    // Also recalculate trader charges
    trRecalcTraderCharges();

    // Auto-calc margin for F&O trades
    trRecalcMargin();
}

// Recalculate margin_blocked for F&O trades using margin_rate from IBA
function trRecalcMargin() {
    if (!trEditingTxnId) return;
    var txn = trTransactions.find(function(t) { return t.id === trEditingTxnId; });
    if (!txn) return;
    // Only apply margin for F&O (product check)
    var product = txn.product || '';
    if (product !== 'F&O' && product !== 'FNO') {
        // Not F&O — leave margin as-is (could be manually set)
        return;
    }
    var netAmount = trEditParse(document.getElementById('trEditNetAmount'));
    var marginRate = wmsGetMarginRate(txn.investor_id, txn.broker_id);
    var margin = wmsCalcMarginBlocked(netAmount, marginRate);
    document.getElementById('trEditMargin').value = trEditFmt(margin);
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
        // Rule G.2.9a — force trader_charges to use the same inclusive flag
        // as the investor's brokerage/total_charges so the two formulas can't
        // diverge on the same transaction.
        var inclusive = wmsIsChargesInclusive(wmsRefData.ibaRatesMap, investorId, brokerId);
        var traderCharges = wmsGetBrokerage(wmsRefData.ibaRatesMap, traderId, brokerId, gross,
            txn.security_type, txn.asset_class, txn.price, txn.quantity, txn.lots, inclusive);
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

    // Qty & Price — SELL txns display absolute values but DB stores negative qty
    var isSell = txn.transaction_type === 'SELL';
    var editedQty = trEditParse(document.getElementById('trEditQty'));
    var editedPrice = trEditParse(document.getElementById('trEditPrice'));
    // Restore negative sign for SELL quantities (user sees positive, DB stores negative)
    if (isSell && editedQty > 0) editedQty = -editedQty;

    // Save editable fields — values saved directly to DB as entered
    var body = {
        trader_id: traderVal || null,
        quantity: editedQty,
        price: editedPrice,
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
        headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'}),
        body: JSON.stringify(body)
    });

    if (resp.ok) {
        Object.keys(body).forEach(function(k) { txn[k] = body[k]; });
        // Recompute display_net_amount so the trading list reflects the new DB truth
        txn.display_net_amount = wmsComputeDisplayNetAmount(txn);
        showAlert('Transaction saved', 'success', 2000);
        trCloseEditModal();
        trRefreshAllViews();
    } else {
        var errText = await resp.text();
        showAlert('Failed to save: ' + errText, 'error');
    }
}

// ============================================================================
// SPLIT TRANSACTION
// ============================================================================

function trToggleSplitPanel() {
    var section = document.getElementById('trSplitSection');
    var isVisible = section.style.display !== 'none';
    if (isVisible) {
        section.style.display = 'none';
        return;
    }
    // Populate trader dropdown
    var txn = trTransactions.find(function(t) { return t.id === trEditingTxnId; });
    if (!txn) return;
    var sel = document.getElementById('trSplitTrader');
    sel.innerHTML = '<option value="">(Same as Investor)</option>' +
        trInvestors.map(function(inv) {
            var label = inv.short_name || inv.name;
            return '<option value="' + inv.id + '">' + label + '</option>';
        }).join('');
    document.getElementById('trSplitQty').value = '';
    document.getElementById('trSplitStatus').textContent = '';
    document.getElementById('trSplitPreview').style.display = 'none';
    document.getElementById('trSplitPreviewBody').innerHTML = '';
    section.style.display = '';
    document.getElementById('trSplitQty').focus();
}

// Cached split data from preview, used by confirm
var _trSplitData = null;

// Helper: calculate trader charges for a split row
function _trCalcSplitTraderCharges(txn, traderId, splitGross, splitQty, splitLots) {
    if (!traderId || traderId === txn.investor_id) return 0;
    if (!wmsRefData || !wmsRefData.ibaRatesMap) return 0;
    // Rule G.2.9a — force trader_charges to use the same inclusive flag
    // as the investor's brokerage/total_charges so split-row trader charges
    // match the parent transaction's formula.
    var inclusive = wmsIsChargesInclusive(wmsRefData.ibaRatesMap, txn.investor_id, txn.broker_id);
    return wmsGetBrokerage(wmsRefData.ibaRatesMap, traderId, txn.broker_id,
        Math.abs(splitGross), txn.security_type, txn.asset_class, txn.price, splitQty, splitLots,
        inclusive) || 0;
}

function trPreviewSplit() {
    var txn = trTransactions.find(function(t) { return t.id === trEditingTxnId; });
    if (!txn) return;

    var statusEl = document.getElementById('trSplitStatus');
    statusEl.textContent = '';
    statusEl.style.color = '';

    // Parse split qty (user enters absolute value)
    var splitQtyAbs = parseFloat((document.getElementById('trSplitQty').value || '0').replace(/,/g, ''));
    if (!splitQtyAbs || splitQtyAbs <= 0) {
        statusEl.textContent = 'Enter a valid quantity to split off.';
        statusEl.style.color = '#dc2626';
        return;
    }

    var isSell = txn.transaction_type === 'SELL';
    var origQtyAbs = Math.abs(txn.quantity || 0);

    if (splitQtyAbs >= origQtyAbs) {
        statusEl.textContent = 'Split qty must be less than original qty (' + trEditFmtInt(origQtyAbs) + ').';
        statusEl.style.color = '#dc2626';
        return;
    }

    var ratio = splitQtyAbs / origQtyAbs;
    var remainRatio = 1 - ratio;
    function r2(v) { return Math.round((v || 0) * 100) / 100; }

    var splitTraderVal = document.getElementById('trSplitTrader').value || null;

    // Remaining row (original, reduced)
    var remainQtyAbs = origQtyAbs - splitQtyAbs;
    var remainQty = isSell ? -remainQtyAbs : remainQtyAbs;
    var remainLots = r2((txn.lots || 0) * remainRatio);
    var remainGross = r2((txn.gross_amount || 0) * remainRatio);
    var remainBrokerage = r2((txn.brokerage || 0) * remainRatio);
    var remainStt = r2((txn.stt || 0) * remainRatio);
    var remainOther = r2((txn.other_charges || 0) * remainRatio);
    var remainGst = r2((txn.gst || 0) * remainRatio);
    var remainTds = r2((txn.tds || 0) * remainRatio);
    var remainTotalCharges = r2(remainBrokerage + remainStt + remainOther + remainGst);
    // Rule G.2.8 — BUY/buy-like: gross + charges; SELL: gross - charges.
    // Bug fix: previously the split function unconditionally added charges
    // for both legs, producing net = gross + charges on SELL splits (4
    // historical rows observed in late-March 2026 on Fyers NATIONALUM NFO SELLs).
    var remainNet = wmsIsBuyLikeType(txn.transaction_type)
        ? r2(remainGross + remainTotalCharges)
        : r2(remainGross - remainTotalCharges);
    // Recalculate trader charges for the remaining row using original trader
    var origTraderId = txn.trader_id || txn.investor_id;
    var remainTraderCharges = _trCalcSplitTraderCharges(txn, origTraderId, remainGross, remainQty, remainLots);

    // Split-off row (new)
    var splitQty = isSell ? -splitQtyAbs : splitQtyAbs;
    var splitLots = r2((txn.lots || 0) * ratio);
    var splitGross = r2((txn.gross_amount || 0) * ratio);
    var splitBrokerage = r2((txn.brokerage || 0) * ratio);
    var splitStt = r2((txn.stt || 0) * ratio);
    var splitOther = r2((txn.other_charges || 0) * ratio);
    var splitGst = r2((txn.gst || 0) * ratio);
    var splitTds = r2((txn.tds || 0) * ratio);
    var splitTotalCharges = r2(splitBrokerage + splitStt + splitOther + splitGst);
    var splitNet = wmsIsBuyLikeType(txn.transaction_type)
        ? r2(splitGross + splitTotalCharges)
        : r2(splitGross - splitTotalCharges);
    // Recalculate trader charges for the split-off row using selected trader
    var splitTraderId = splitTraderVal || txn.investor_id;
    var splitTraderCharges = _trCalcSplitTraderCharges(txn, splitTraderId, splitGross, splitQty, splitLots);

    // Trader display names
    var origTraderName = '(Investor)';
    if (origTraderId && origTraderId !== txn.investor_id) {
        var inv = trInvestors.find(function(i) { return i.id === origTraderId; });
        origTraderName = inv ? (inv.short_name || inv.name) : origTraderId;
    }
    var splitTraderName = '(Investor)';
    if (splitTraderId && splitTraderId !== txn.investor_id) {
        var inv2 = trInvestors.find(function(i) { return i.id === splitTraderId; });
        splitTraderName = inv2 ? (inv2.short_name || inv2.name) : splitTraderId;
    }

    // Build preview table
    var f = trEditFmt;
    var fi = trEditFmtInt;
    function row(label, trader, qty, price, gross, charges, traderChg, net, bgColor) {
        return '<tr style="border-bottom:1px solid #f1f5f9;background:' + bgColor + ';">' +
            '<td style="padding:4px 6px;font-weight:600;">' + label + '</td>' +
            '<td style="padding:4px 6px;">' + trader + '</td>' +
            '<td style="padding:4px 6px;text-align:right;">' + fi(qty) + '</td>' +
            '<td style="padding:4px 6px;text-align:right;">' + f(price) + '</td>' +
            '<td style="padding:4px 6px;text-align:right;">' + f(gross) + '</td>' +
            '<td style="padding:4px 6px;text-align:right;">' + f(charges) + '</td>' +
            '<td style="padding:4px 6px;text-align:right;">' + f(traderChg) + '</td>' +
            '<td style="padding:4px 6px;text-align:right;">' + f(net) + '</td></tr>';
    }

    var html = row('Original', origTraderName, remainQtyAbs, txn.price, Math.abs(remainGross), Math.abs(remainTotalCharges), remainTraderCharges, Math.abs(remainNet), '#fff') +
               row('Split-off', splitTraderName, splitQtyAbs, txn.price, Math.abs(splitGross), Math.abs(splitTotalCharges), splitTraderCharges, Math.abs(splitNet), '#f5f3ff');

    document.getElementById('trSplitPreviewBody').innerHTML = html;
    document.getElementById('trSplitPreview').style.display = '';

    // Cache the computed data for confirm
    _trSplitData = {
        newTxn: {
            investor_id: txn.investor_id,
            broker_id: txn.broker_id,
            trader_id: splitTraderVal,
            security_id: txn.security_id,
            security_type: txn.security_type,
            symbol: txn.symbol,
            short_symbol: txn.short_symbol,
            company_name: txn.company_name,
            asset_class: txn.asset_class,
            exchange: txn.exchange,
            product: txn.product,
            transaction_type: txn.transaction_type,
            transaction_date: txn.transaction_date,
            quantity: splitQty,
            lots: splitLots,
            price: txn.price,
            gross_amount: splitGross,
            brokerage: splitBrokerage,
            stt: splitStt,
            other_charges: splitOther,
            gst: splitGst,
            tds: splitTds,
            total_charges: splitTotalCharges,
            net_amount: splitNet,
            trader_charges: splitTraderCharges,
            margin_blocked: r2((txn.margin_blocked || 0) * ratio),
            broker_contract_note_no: txn.broker_contract_note_no,
            broker_trade_id: null,
            tags: (txn.tags || []).slice(),
            notes: '[SPLIT from txn ' + txn.id + '] ' + (txn.notes || ''),
            ignore_for_avg_cost: txn.ignore_for_avg_cost || false,
            dont_display: txn.dont_display || false
        },
        origUpdate: {
            quantity: remainQty,
            lots: remainLots,
            gross_amount: remainGross,
            brokerage: remainBrokerage,
            stt: remainStt,
            other_charges: remainOther,
            gst: remainGst,
            tds: remainTds,
            total_charges: remainTotalCharges,
            net_amount: remainNet,
            trader_charges: remainTraderCharges,
            margin_blocked: r2((txn.margin_blocked || 0) * remainRatio)
        }
    };
}

async function trExecuteSplit() {
    if (!trEditingTxnId || !_trSplitData) return;
    var txn = trTransactions.find(function(t) { return t.id === trEditingTxnId; });
    if (!txn) return;

    var statusEl = document.getElementById('trSplitStatus');
    statusEl.textContent = 'Splitting...';
    statusEl.style.color = '#718096';
    document.getElementById('trSplitConfirmBtn').disabled = true;

    try {
        // 1. Insert the new split-off transaction
        var insertResp = await fetch(SUPABASE_URL + '/rest/v1/transactions', {
            method: 'POST',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
            body: JSON.stringify(_trSplitData.newTxn)
        });
        if (!insertResp.ok) {
            var errText = await insertResp.text();
            throw new Error('Insert failed: ' + errText);
        }
        var insertedRows = await insertResp.json();
        var insertedTxn = Array.isArray(insertedRows) ? insertedRows[0] : insertedRows;

        // 2. Update the original transaction (reduce qty & charges)
        var patchResp = await fetch(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + txn.id, {
            method: 'PATCH',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'}),
            body: JSON.stringify(_trSplitData.origUpdate)
        });
        if (!patchResp.ok) {
            var errText2 = await patchResp.text();
            throw new Error('Update original failed: ' + errText2);
        }

        // 3. Update local state
        Object.keys(_trSplitData.origUpdate).forEach(function(k) { txn[k] = _trSplitData.origUpdate[k]; });
        txn.display_net_amount = wmsComputeDisplayNetAmount(txn);
        if (insertedTxn) insertedTxn.display_net_amount = wmsComputeDisplayNetAmount(insertedTxn);
        trTransactions.push(insertedTxn);
        _trSplitData = null;

        showAlert('Transaction split successfully', 'success', 2500);
        trCloseEditModal();
        trRefreshAllViews();
    } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.style.color = '#dc2626';
        document.getElementById('trSplitConfirmBtn').disabled = false;
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
    if (typeof lgInit === 'function') { lgInit(); lgRefresh(); }
}

// (Old statements code removed — now lazy-loaded from trading-ledger.js)

// ============================================================================
// WINDOW EXPORTS
// ============================================================================

window.initTrading = initTrading;
