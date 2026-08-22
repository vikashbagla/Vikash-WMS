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
var rptMfNav = {};           // { mfSymbol: latestNav } — MF market valuation (market_prices)
var rptMfSnake = [];         // snake_case MF trade rows for the drill-down modal (view-only)
var rptMfLastNav = {};       // { mfSymbol: lastTradeNav } — fallback price before the feed runs
var rptMfSymbolSet = {};     // { mfSymbol: true } — quick "is this an MF symbol" test

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
    rptInitConsol();
    await rptPortfolioVM.loadViews();
    await rptCGVM.loadViews();
    await rptConsolVM.loadViews();
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
    // Read from the ONE shared transactions cache (wms-shared.js, §A.9.6) — no
    // separate fetch. Map the shared snake_case rows into Reports' camelCase
    // view, excluding dont_display (hidden) trades exactly as the old
    // dont_display=eq.false query did. The shared cache is already sorted by
    // (transaction_date, transaction_time, id), which Reports relies on.
    await wmsLoadTransactions();
    var rptRows = window._wmsTxnCache.rows.filter(function(t) { return !t.dont_display; });
    console.log('✅ Reports: using ' + rptRows.length + ' shared transactions');

    rptTransactions = rptRows.map(function(txn) {
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

    // Mutual funds live in their OWN table (mf_trades — fractional units, kept out
    // of the Trading module). Fold them into rptTransactions so Portfolio + Capital
    // Gains include MF on the SAME FIFO/CG engine as equity. Load latest NAV too.
    await rptLoadMfTrades();
    await rptLoadMfNavs();
}

// Map an mf_trades txn_type to the reports/FIFO transaction type. PURCHASE /
// DIV_REINVEST add a lot (BUY, real units at NAV); REDEMPTION matches lots (SELL).
// DIV_PAYOUT is cash income with NO units — return '' so it is DROPPED, never fed
// to the FIFO: a 'DIVIDEND' type would make _wmsCostEngine do `adjustments -=
// |amount|` and wrongly shrink the MF cost basis (a payout is not a return of
// capital). Reports shows holdings + capital gains only, so MF income is out of scope.
function rptMfType(tt) {
    tt = String(tt || '').toUpperCase();
    if (tt === 'REDEMPTION') return 'SELL';
    if (tt === 'DIV_PAYOUT') return '';            // income — dropped from Reports
    return 'BUY';                                  // PURCHASE / DIV_REINVEST / SWITCH-in
}

// Fetch mf_trades, resolve each to its MF security, and append reports-shaped
// (camelCase) rows to rptTransactions. Fraction-safe: the shared FIFO consumes
// numeric quantity as-is (proven by the accounting MF postings).
async function rptLoadMfTrades() {
    try {
        var rows = await wmsFetchAllRaw(SUPABASE_URL + '/rest/v1/mf_trades?select=*&order=txn_date.asc,id.asc', { headers: wmsHeaders() });
        if (!rows || rows.length === 0) return;

        // security_id -> securities_db row (symbol/name/type). Backfill any missing.
        var secById = {};
        (wmsRefData.securitiesCm || []).forEach(function(s) { secById[s.id] = s; });
        var missing = {};
        rows.forEach(function(r) { if (r.security_id && !secById[r.security_id]) missing[r.security_id] = true; });
        var missIds = Object.keys(missing);
        if (missIds.length) {
            try {
                var extra = await wmsFetchAllRaw(SUPABASE_URL + '/rest/v1/securities_db?id=in.(' + missIds.join(',') + ')&select=id,symbol,company_name,security_type,exchange,capital_gains', { headers: wmsHeaders() });
                (extra || []).forEach(function(s) { secById[s.id] = s; });
            } catch (e2) { console.warn('⚠️ Reports MF: security backfill failed:', e2.message || e2); }
        }

        var mapped = rows.map(function(r) {
            var sec = secById[r.security_id] || {};
            var sym = sec.symbol || '';
            var type = rptMfType(r.txn_type);
            if (!sym || !type) return null;            // unresolved security or DIV_PAYOUT (income)
            var units = Math.abs(Number(r.units) || 0);
            var amt = Math.abs(Number(r.amount) || 0);
            return {
                id: r.id,
                investorId: r.investor_id,
                brokerId: null,                        // MF has no broker (PMS settlement)
                securityId: r.security_id,
                symbol: sym,
                shortSymbol: sym,                      // FIFO groups non-NFO by short symbol
                companyName: sec.company_name || sym,
                exchange: 'MF',
                securityType: 'MF',
                type: type,
                date: r.txn_date,
                quantity: units,
                price: Number(r.nav) || 0,
                grossAmount: amt,
                netAmount: amt,
                stt: 0,                                // MF STT not tracked in mf_trades
                tags: r.tag ? [r.tag] : ['mutual_fund'],
                _mf: true
            };
        }).filter(function(x) { return x; });

        rptTransactions = rptTransactions.concat(mapped);

        // Snake-case copies + helper maps: the drill-down modal renders from
        // snake_case rows (like the shared transactions cache); MF trades are
        // VIEW-ONLY there (they live in mf_trades, not the transactions table).
        rptMfSnake = mapped.map(function(m) {
            return {
                id: m.id, short_symbol: m.shortSymbol, symbol: m.symbol, company_name: m.companyName,
                security_type: 'MF', exchange: 'MF', transaction_type: m.type, transaction_date: m.date,
                quantity: m.quantity, price: m.price, gross_amount: m.grossAmount, net_amount: m.netAmount,
                display_net_amount: m.netAmount, stt: 0, investor_id: m.investorId, broker_id: null,
                tags: m.tags, dont_display: false, _mf: true
            };
        });
        rptMfLastNav = {}; rptMfSymbolSet = {};
        mapped.forEach(function(m) { rptMfSymbolSet[m.symbol] = true; rptMfLastNav[m.symbol] = m.price; }); // date-asc → last wins = latest trade NAV
        console.log('✅ Reports: folded in ' + mapped.length + ' MF trades');
    } catch (e) {
        console.warn('⚠️ Reports: MF trades load failed:', e.message || e);
    }
}

// Latest MF NAV per scheme from market_prices (written by the mf-nav-sync EF).
// Keyed by security symbol. Empty until the NAV feed runs — Portfolio then falls
// back to each holding's last-trade NAV (latestPrice), so MF still values sanely.
async function rptLoadMfNavs() {
    rptMfNav = {};
    try {
        var rows = await wmsFetchAllRaw(SUPABASE_URL + '/rest/v1/market_prices?security_type=eq.MF&resolution=eq.1D&select=security_id,close,price_date&order=price_date.desc', { headers: wmsHeaders() });
        if (!rows || rows.length === 0) return;
        var secById = {};
        (wmsRefData.securitiesCm || []).forEach(function(s) { secById[s.id] = s; });
        rows.forEach(function(r) {
            var sec = secById[r.security_id];
            if (!sec || !sec.symbol) return;
            if (rptMfNav[sec.symbol] === undefined) rptMfNav[sec.symbol] = Number(r.close) || 0;   // desc order → first = latest
        });
    } catch (e) {
        console.warn('⚠️ Reports: MF NAV load failed:', e.message || e);
    }
}

// MF unit display — rounded to whole units (owner pref 2026-08-18). The stored
// units stay fractional (FIFO/cost/value use full precision); only the on-screen
// quantity is rounded to 0 dp with Indian commas.
function rptFmtUnits(n) {
    return (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ============================================================================
// LIVE PRICES
// ============================================================================

function rptGetLiveData(holding) {
    // MF has no intraday tick — Day P&L is not applicable (valued at daily NAV).
    if (holding.securityType === 'MF') return null;
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
    // MF: value at latest NAV (market_prices via mf-nav-sync). Fall back to the
    // holding's last-trade NAV until the feed has run.
    if (holding.securityType === 'MF') {
        if (rptMfNav && rptMfNav[sym] > 0) return rptMfNav[sym];
        return holding.latestPrice || holding.fifoCost || 0;
    }
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

        // Get current holdings (non-F&O only). MF excluded — no Fyers tick; valued
        // at NAV (rptGetPrice/rptLoadMfNavs), so never sent to the quotes API.
        var filtered = rptFilterTransactions(rptTransactions);
        filtered = filtered.filter(function(t) { return t.securityType !== 'NFO' && t.securityType !== 'MCX' && t.securityType !== 'MF'; });
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
            if (tabId === 'rpt-consol') rptRenderConsol();
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
    // Full snake_case rows for the edit modal come straight from the shared
    // cache (§A.9.6) — no separate fetch. Filter to the symbol (or all).
    // Shared transactions cache (equity/F&O) PLUS the snake-case MF trades so an
    // MF holding's drill-down shows its mf_trades (they aren't in the cache).
    var allShared = (window._wmsTxnCache && window._wmsTxnCache.rows) || [];
    var combined = allShared.concat(rptMfSnake || []);
    var allTxns = (shortSymbol === '__ALL__')
        ? combined.slice()
        : combined.filter(function(t) { return t.short_symbol === shortSymbol; });

    // display_net_amount is already set by the shared load's sanitize; fill only if missing.
    allTxns.forEach(function(t) {
        if (t.display_net_amount === undefined) {
            t.display_net_amount = (typeof wmsComputeDisplayNetAmount === 'function')
                ? wmsComputeDisplayNetAmount(t) : t.net_amount;
        }
    });

    // Set shared modal context with Reports' data
    wmsTxnCtx = {
        module: 'reports',
        transactions: allTxns,
        investors: rptInvestors,
        brokers: rptBrokers,
        getPrice: function(sym) {
            if (rptMfSymbolSet && rptMfSymbolSet[sym]) {
                return (rptMfNav[sym] > 0) ? rptMfNav[sym] : (rptMfLastNav[sym] || 0);
            }
            return rptGetPrice({ shortSymbol: sym, symbol: sym, exchange: 'NSE', latestPrice: 0 });
        },
        getLiveData: function(sym) {
            if (rptMfSymbolSet && rptMfSymbolSet[sym]) return null;   // MF: no intraday tick
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

            // MF units are fractional (never rounded); equity/ETF qty stays integer.
            var qtyFmt = (h.securityType === 'MF') ? rptFmtUnits : function(v) { return formatQuantity(v); };
            var qtyHtml = h.quantity < 0
                ? '<div class="number-main negative">(' + qtyFmt(Math.abs(h.quantity)) + ')</div>'
                : '<div class="number-main">' + qtyFmt(h.quantity) + '</div>';

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

// Resolve a gain's per-security mapping (symbol -> { security_type, capital_gains }).
// Built lazily from the loaded securities and reset per CG render (below) so a
// background debt-securities load is picked up. Unfound → equity-default fallback.
var _rptSecCgMap = null;
function rptSecMapping(g) {
    if (_rptSecCgMap === null) {
        _rptSecCgMap = {};
        (wmsRefData.securitiesCm || []).forEach(function (s) {
            if (s.symbol && !_rptSecCgMap[s.symbol]) {
                _rptSecCgMap[s.symbol] = { security_type: s.security_type, capital_gains: s.capital_gains };
            }
        });
    }
    return _rptSecCgMap[g.shortSymbol || g.symbol] || { security_type: g.securityType, capital_gains: {} };
}

// Bucket a realised gain into INTRADAY (same-day) / STCG / LTCG — via the SHARED
// classifier (wms-cost-engine.js) so Reports and Accounting never diverge. The
// ST/LT decision comes from the security's capital_gains mapping (per-security
// lt_months), not the old hardcoded 365-day rule. rptClassifyGain (below) is now
// superseded for bucketing and kept only for its rate labels if referenced.
function rptCGBucket(g) {
    var cls = wmsGainClassify(g, rptSecMapping(g));
    if (cls.bucket === 'INTRADAY') return 'INTRADAY';
    return cls.bucket === 'LTCG' ? 'LTCG' : 'STCG';   // BUSINESS (F&O) folds into STCG — unchanged
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

    // Map stock → security_id (for master-data asset-class lookup, so the Type
    // matches the Portfolio tab regardless of per-trade security_type drift)
    var symSecId = {};
    rptTransactions.forEach(function(t) {
        var k = t.shortSymbol || t.symbol;
        if (k && !symSecId[k] && t.securityId) symSecId[k] = t.securityId;
    });

    // Aggregate per stock: buy/sell amounts + Intra-day / Short-term / Long-term buckets
    _rptSecCgMap = null;   // rebuild the per-security mapping cache fresh for this render
    var perStock = {};
    var totBuy = 0, totSell = 0, totIntraday = 0, totSTCG = 0, totLTCG = 0;
    fyGains.forEach(function(g) {
        var key = g.shortSymbol || g.symbol;
        if (!perStock[key]) {
            perStock[key] = {
                symbol: key,
                company: g.companyName || '',
                securityType: g.securityType || 'EQUITY',
                buyAmt: 0, sellAmt: 0, intraday: 0, stcg: 0, ltcg: 0
            };
        }
        perStock[key].buyAmt += g.buyCost;       totBuy += g.buyCost;
        perStock[key].sellAmt += g.sellProceeds; totSell += g.sellProceeds;
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

    // One row per stock. Asset class resolved from the MASTER security record
    // (curated source of truth) so it matches the Portfolio tab; fall back to the
    // trade's own security_type only when the security isn't in the master cache.
    var stocks = Object.keys(perStock).map(function(k) { return perStock[k]; });
    stocks.forEach(function(s) {
        var secId = symSecId[s.symbol];
        var rec = (secId && wmsRefData.securitiesCmMap) ? wmsRefData.securitiesCmMap[secId] : null;
        s.assetClass = rptGetAssetClass((rec && rec.security_type) ? rec.security_type : s.securityType);
    });
    // Sort by Type (asset class) then Company name
    stocks.sort(function(a, b) {
        var ai = RPT_ASSET_CLASS_ORDER.indexOf(a.assetClass); if (ai < 0) ai = 99;
        var bi = RPT_ASSET_CLASS_ORDER.indexOf(b.assetClass); if (bi < 0) bi = 99;
        if (ai !== bi) return ai - bi;
        return (a.company || a.symbol || '').localeCompare(b.company || b.symbol || '');
    });

    // Per-stock summary table — Type | Stock | Buy Amt | Sell Amt | Intra-day | Short-term | Long-term
    var html = '<table class="rpt-cg-table" style="width:100%; border-collapse:collapse; table-layout:fixed;">';
    html += '<colgroup>' +
        '<col style="width:14%">' +   // Type
        '<col style="width:26%">' +   // Stock
        '<col style="width:12%">' +   // Total Buy Amount
        '<col style="width:12%">' +   // Total Sell Amount
        '<col style="width:12%">' +   // Intra-day
        '<col style="width:12%">' +   // Short-term
        '<col style="width:12%">' +   // Long-term
    '</colgroup>';
    html += '<thead><tr>' +
        '<th>Type</th>' +
        '<th>Stock</th>' +
        '<th class="text-right cg-grp-start">Total Buy Amount</th>' +
        '<th class="text-right">Total Sell Amount</th>' +
        '<th class="text-right cg-grp-start">Intra-day Profit/Loss</th>' +
        '<th class="text-right">Short-term Capital Gain</th>' +
        '<th class="text-right">Long-term Capital Gain</th>' +
    '</tr></thead><tbody>';

    stocks.forEach(function(s) {
        var badge = RPT_AC_BADGE[s.assetClass] || '—';
        html += '<tr>' +
            '<td>' +
                '<span style="display:inline-block;border:1px solid #a0aec0;border-radius:3px;padding:0 5px;font-size:10px;font-weight:700;color:#4a5568;margin-right:5px;">' + badge + '</span>' +
                '<span style="font-size:11px;color:#718096;">' + s.assetClass + '</span>' +
            '</td>' +
            '<td>' +
                '<div style="font-weight:600; font-size:12px; color:#2d3748;">' + (s.company || s.symbol) + '</div>' +
                '<div style="font-size:10px; color:#a0aec0;">' + s.symbol + '</div>' +
            '</td>' +
            '<td class="text-right cg-grp-start"><div class="number-main">' + formatAmount(s.buyAmt) + '</div></td>' +
            '<td class="text-right"><div class="number-main">' + formatAmount(s.sellAmt) + '</div></td>' +
            '<td class="text-right cg-grp-start ' + getAmountClass(s.intraday) + '">' + formatAmount(s.intraday) + '</td>' +
            '<td class="text-right ' + getAmountClass(s.stcg) + '">' + formatAmount(s.stcg) + '</td>' +
            '<td class="text-right ' + getAmountClass(s.ltcg) + '">' + formatAmount(s.ltcg) + '</td>' +
        '</tr>';
    });

    html += '<tr class="total-row">' +
        '<td>TOTAL</td>' +
        '<td></td>' +
        '<td class="text-right cg-grp-start">' + formatAmount(totBuy) + '</td>' +
        '<td class="text-right">' + formatAmount(totSell) + '</td>' +
        '<td class="text-right cg-grp-start ' + getAmountClass(totIntraday) + '">' + formatAmount(totIntraday) + '</td>' +
        '<td class="text-right ' + getAmountClass(totSTCG) + '">' + formatAmount(totSTCG) + '</td>' +
        '<td class="text-right ' + getAmountClass(totLTCG) + '">' + formatAmount(totLTCG) + '</td>' +
    '</tr>';

    html += '</tbody></table>';
    bodyEl.innerHTML = html;
}

// ============================================================================
// CONSOLIDATION TAB  (accounting ledgers across multiple books)
// ----------------------------------------------------------------------------
// Self-contained: fetches acct_groups / acct_ledgers / acct_voucher_full over
// REST (does NOT depend on accounting.js globals). Mirrors the accounting
// natural-sign display (crNormal nature -> -net) and the BS / P&L grouped tree.
//
// Statement:  'bs' (Balance Sheet)  |  'pl' (Profit & Loss)
// Layout:     'books' (one column per book)  |  'quarters' (Q1..Q4)
//
//  • BS  columns carry the CUMULATIVE balance as at the column's date
//        (opening + all movements up to that date). Books layout adds a single
//        consolidated "Op Bal" column; Quarters layout adds "Op Bal" then each
//        quarter-END balance. A synthetic "Profit & Loss (Net Income)" section
//        sits on the equity side and a Total-Assets vs Total-Equity+Liab check
//        proves the sheet ties.
//  • P&L columns carry the PERIOD movement (booked P&L) — per book, or per
//        quarter — with a Net Profit/(Loss) line. Total = full-year P&L.
//
// Amounts follow the global F4 full-amount toggle.
// ============================================================================

var rptConsGroups = [];
var rptConsLedgers = [];
var rptConsGroupById = {};
var rptConsRows = [];              // live voucher rows for the selected books
var rptConsCatalogueLoaded = false;
var rptConsLoadedKey = '';        // book-id set last fetched (avoid refetch)

var rptConsolBookIds = [];        // selected books (ORDER = column order)
var rptConsStatement = 'bs';      // 'bs' | 'pl'
var rptConsolMode = 'books';      // 'books' | 'quarters'
var rptConsShowZero = false;
var rptConsNatureOrder = ['Assets', 'Liabilities', 'Income', 'Expenses', 'Capital'];

// ---- Browser-persistent prefs (books, statement, layout, show-zero, collapse) ----
var RPT_CONS_PREFS_KEY = 'wms_rpt_consol_prefs';
var RPT_CONS_COLLAPSE_KEY = 'wms_rpt_consol_collapsed';
var rptConsCollapsed = {};
function rptConsLoadPrefs() {
    try {
        var p = JSON.parse(localStorage.getItem(RPT_CONS_PREFS_KEY) || '{}');
        if (p && typeof p === 'object') {
            if (Array.isArray(p.bookIds)) rptConsolBookIds = p.bookIds.slice();
            if (p.statement === 'bs' || p.statement === 'pl') rptConsStatement = p.statement;
            if (p.mode === 'books' || p.mode === 'quarters') rptConsolMode = p.mode;
            rptConsShowZero = !!p.showZero;
        }
    } catch (e) {}
    try { var c = JSON.parse(localStorage.getItem(RPT_CONS_COLLAPSE_KEY) || '{}'); if (c && typeof c === 'object') rptConsCollapsed = c; } catch (e) {}
}
function rptConsSavePrefs() {
    try {
        localStorage.setItem(RPT_CONS_PREFS_KEY, JSON.stringify({
            bookIds: rptConsolBookIds, statement: rptConsStatement, mode: rptConsolMode, showZero: rptConsShowZero
        }));
    } catch (e) {}
}
function rptConsSaveCollapse() { try { localStorage.setItem(RPT_CONS_COLLAPSE_KEY, JSON.stringify(rptConsCollapsed || {})); } catch (e) {} }

// Display amount — identical rule to acctAmt (global F4 full-amount aware).
function rptConsAmt(n) {
    if (Math.abs(Number(n) || 0) < 0.005) return '-';
    if (typeof wmsIsFullAmount === 'function' && wmsIsFullAmount()) return (typeof formatAmountRaw === 'function') ? formatAmountRaw(n) : String(n);
    if (typeof formatAmount === 'function') return formatAmount(n);
    return String(n);
}
function rptConsRootName(groupId) {
    var g = rptConsGroupById[groupId], guard = 0;
    while (g && g.parent_group_id && guard++ < 20) g = rptConsGroupById[g.parent_group_id];
    return g ? g.name : '—';
}
// Natural-sign per nature: Liabilities/Income/Capital are credit-normal -> negate.
function rptConsLedgerDisp(net, lg, negate) {
    var nature = rptConsRootName(lg.group_id);
    var crNormal = (nature === 'Liabilities' || nature === 'Income' || nature === 'Capital');
    var v = net[lg.id] || 0;
    var base = crNormal ? -v : v;
    return negate ? -base : base;
}
function rptConsIsOpening(r, fyStart) {
    return r.voucher_type === 'OPENING_BALANCE' || (fyStart && r.voucher_date < fyStart);
}
// FY quarter index for a yyyy-mm-dd date: Apr-Jun=0 .. Jan-Mar=3.
function rptConsQuarterOf(dateStr) {
    if (!dateStr) return 0;
    var m = parseInt(String(dateStr).slice(5, 7), 10) || 1;
    return Math.floor(((m - 4 + 12) % 12) / 3);
}
// FY start (yyyy-04-01) containing the latest posting across the loaded rows.
function rptConsFyStart() {
    var maxD = '';
    rptConsRows.forEach(function (r) { if (r.voucher_type !== 'OPENING_BALANCE' && r.voucher_date > maxD) maxD = r.voucher_date; });
    var ref = maxD ? new Date(maxD + 'T00:00:00') : new Date();
    var y = (ref.getMonth() + 1) >= 4 ? ref.getFullYear() : ref.getFullYear() - 1;
    return y + '-04-01';
}
// Quarter-END dates for the FY starting at fyStart (Jun30, Sep30, Dec31, Mar31).
function rptConsQuarterEnds(fyStart) {
    var y = parseInt(fyStart.slice(0, 4), 10);
    return [y + '-06-30', y + '-09-30', y + '-12-31', (y + 1) + '-03-31'];
}

async function rptLoadConsolCatalogue() {
    if (rptConsCatalogueLoaded) return;
    var groups = await wmsFetchAllRaw(SUPABASE_URL + '/rest/v1/acct_groups?select=*&order=name.asc', { headers: wmsHeaders() });
    var ledgers = await wmsFetchAllRaw(SUPABASE_URL + '/rest/v1/acct_ledgers?select=*&order=name.asc', { headers: wmsHeaders() });
    rptConsGroups = groups || [];
    rptConsLedgers = ledgers || [];
    rptConsGroupById = {};
    rptConsGroups.forEach(function (g) { rptConsGroupById[g.id] = g; });
    rptConsCatalogueLoaded = true;
}
async function rptLoadConsol() {
    await rptLoadConsolCatalogue();
    var ids = rptConsolBookIds.slice();
    if (!ids.length) { rptConsRows = []; rptConsLoadedKey = ''; return; }
    var key = ids.slice().sort().join(',');
    if (key === rptConsLoadedKey && rptConsRows.length) return;
    var filter = ids.length === 1 ? ('investor_id=eq.' + ids[0]) : ('investor_id=in.(' + ids.join(',') + ')');
    var rows = await wmsFetchAllRaw(SUPABASE_URL + '/rest/v1/acct_voucher_full?' + filter +
        '&order=voucher_date.asc,voucher_number.asc,sort_order.asc', { headers: wmsHeaders() });
    rptConsRows = (rows || []).filter(function (r) { return !r.is_cancelled; });
    rptConsLoadedKey = key;
}

// ---------------------------------------------------------------------------
// COLUMN NET MAPS  — each column is { label, isTotal, isOpening, net:{ledgerId:Dr-Cr} }
// ---------------------------------------------------------------------------
function rptConsBuildColumns() {
    var fyStart = rptConsFyStart();
    function emptyNet() { return {}; }
    function addRow(map, r) { map[r.ledger_id] = (map[r.ledger_id] || 0) + (Number(r.debit_amount) || 0) - (Number(r.credit_amount) || 0); }

    // Consolidated opening (all selected books)
    var openCons = emptyNet();
    rptConsRows.forEach(function (r) { if (rptConsIsOpening(r, fyStart)) addRow(openCons, r); });

    var cols = [];
    if (rptConsStatement === 'bs') {
        // Balances = opening + movements up to the column date (cumulative).
        if (rptConsolMode === 'books') {
            cols.push({ label: 'Op Bal', isOpening: true, net: openCons });
            rptConsolBookIds.forEach(function (id) {
                var net = emptyNet();
                rptConsRows.forEach(function (r) { if (String(r.investor_id) === String(id)) addRow(net, r); });
                cols.push({ label: rptConsBookName(id), bookId: id, net: net });
            });
            var totB = emptyNet();
            rptConsRows.forEach(function (r) { addRow(totB, r); });
            cols.push({ label: 'Total', isTotal: true, net: totB });
        } else {
            var qEnds = rptConsQuarterEnds(fyStart);
            cols.push({ label: 'Op Bal', isOpening: true, net: openCons });
            qEnds.forEach(function (qe, i) {
                var net = emptyNet();
                rptConsRows.forEach(function (r) { if (rptConsIsOpening(r, fyStart) || r.voucher_date <= qe) addRow(net, r); });
                cols.push({ label: 'Q' + (i + 1), net: net });
            });
            var totQ = emptyNet();
            rptConsRows.forEach(function (r) { addRow(totQ, r); });
            cols.push({ label: 'Total', isTotal: true, net: totQ });
        }
    } else {
        // P&L = period movements only (exclude opening).
        if (rptConsolMode === 'books') {
            rptConsolBookIds.forEach(function (id) {
                var net = emptyNet();
                rptConsRows.forEach(function (r) { if (String(r.investor_id) === String(id) && !rptConsIsOpening(r, fyStart)) addRow(net, r); });
                cols.push({ label: rptConsBookName(id), bookId: id, net: net });
            });
            var totPB = emptyNet();
            rptConsRows.forEach(function (r) { if (!rptConsIsOpening(r, fyStart)) addRow(totPB, r); });
            cols.push({ label: 'Total', isTotal: true, net: totPB });
        } else {
            for (var q = 0; q < 4; q++) {
                (function (qi) {
                    var net = emptyNet();
                    rptConsRows.forEach(function (r) { if (!rptConsIsOpening(r, fyStart) && rptConsQuarterOf(r.voucher_date) === qi) addRow(net, r); });
                    cols.push({ label: 'Q' + (qi + 1), net: net });
                })(q);
            }
            var totPQ = emptyNet();
            rptConsRows.forEach(function (r) { if (!rptConsIsOpening(r, fyStart)) addRow(totPQ, r); });
            cols.push({ label: 'Total', isTotal: true, net: totPQ });
        }
    }
    return cols;
}
function rptConsBookName(id) {
    var inv = (rptInvestors || []).find(function (v) { return String(v.id) === String(id); });
    return inv ? (inv.short_name || inv.name) : String(id);
}

// ---------------------------------------------------------------------------
// TREE BUILDING  — per nature root -> groups -> ledgers, colVals[] + total.
// ---------------------------------------------------------------------------
function rptConsNatureTree(natureName, cols, depthBase) {
    var ncols = cols.length;
    function ledgerNode(lg) {
        var cv = cols.map(function (c) { return rptConsLedgerDisp(c.net, lg); });
        var anyNonZero = cv.some(function (v) { return Math.round(v * 100) !== 0; });
        if (!anyNonZero && !rptConsShowZero) return null;
        return { key: 'l:' + lg.id, label: lg.name, isLedger: true, colVals: cv, depth: 0 };
    }
    function mkGroup(key, label, children) {
        var cv = []; for (var i = 0; i < ncols; i++) cv.push(0);
        children.forEach(function (ch) { ch.colVals.forEach(function (v, i) { cv[i] += v; }); });
        return { key: key, label: label, children: children, colVals: cv, isGroup: true };
    }
    function buildGroup(groupId) {
        var out = [];
        rptConsLedgers.filter(function (l) { return l.group_id === groupId; })
            .sort(function (a, b) { return a.name.localeCompare(b.name); })
            .forEach(function (l) { var n = ledgerNode(l); if (n) out.push(n); });
        rptConsGroups.filter(function (g) { return g.parent_group_id === groupId; })
            .sort(function (a, b) { return a.name.localeCompare(b.name); })
            .forEach(function (cg) {
                var children = buildGroup(cg.id);
                if (!children.length && !rptConsShowZero) return;
                out.push(mkGroup('g:' + cg.id, cg.name, children));
            });
        return out;
    }
    var root = rptConsGroups.find(function (g) { return !g.parent_group_id && g.name === natureName; });
    if (!root) return null;
    var children = buildGroup(root.id);
    if (!children.length && !rptConsShowZero) return null;
    var node = mkGroup('r:' + natureName, natureName, children);
    node.isRoot = true;
    return node;
}
// Deep copy a node with all colVals negated (used to show Expenses within the P&L block).
function rptConsNegate(node) {
    if (!node) return node;
    var out = { key: node.key, label: node.label, isLedger: node.isLedger, isGroup: node.isGroup, isRoot: node.isRoot,
        colVals: node.colVals.map(function (v) { return -v; }) };
    if (node.children) out.children = node.children.map(rptConsNegate);
    return out;
}
function rptConsSumCols(nodes, ncols) {
    var cv = []; for (var i = 0; i < ncols; i++) cv.push(0);
    nodes.forEach(function (n) { if (n) n.colVals.forEach(function (v, i) { cv[i] += v; }); });
    return cv;
}
function rptConsAllGroupKeys(nodes, acc) {
    nodes.forEach(function (n) { if (n && (n.isGroup || n.isRoot)) { acc.push(n.key); if (n.children) rptConsAllGroupKeys(n.children, acc); } });
    return acc;
}

// ---------------------------------------------------------------------------
// ROW RENDERING
// ---------------------------------------------------------------------------
function rptConsNodeRows(node, depth, ncols) {
    if (!node) return '';
    var isGroup = node.isGroup || node.isRoot;
    var collapsed = isGroup && rptConsCollapsed[node.key];
    var pad = 8 + depth * 16;
    var icon = isGroup
        ? '<span class="rpt-consol-toggle">' + (collapsed ? '▶' : '▼') + '</span>'
        : '<span class="rpt-consol-toggle"></span>';
    var rowCls = isGroup ? ('rpt-consol-row-group' + (node.isRoot ? ' rpt-root' : '')) : 'rpt-consol-row-ledger';
    var attr = isGroup ? (' data-cnode="' + node.key + '"') : '';
    var h = '<tr class="' + rowCls + '"' + attr + '>';
    h += '<td class="rpt-c-name" style="padding-left:' + pad + 'px;">' + icon + wmsEsc(node.label) + '</td>';
    for (var i = 0; i < ncols; i++) {
        var totCls = (i === ncols - 1) ? ' rpt-consol-c-total' : '';
        h += '<td class="rpt-c-num' + totCls + '">' + rptConsAmt(node.colVals[i]) + '</td>';
    }
    h += '</tr>';
    if (isGroup && !collapsed && node.children) {
        node.children.forEach(function (c) { h += rptConsNodeRows(c, depth + 1, ncols); });
    }
    return h;
}
// A bold, non-collapsible summary/total line (Total Assets, Net Income, etc.).
function rptConsSummaryRow(label, colVals, ncols, extraCls) {
    var h = '<tr class="rpt-consol-row-summary ' + (extraCls || '') + '">';
    h += '<td class="rpt-c-name">' + wmsEsc(label) + '</td>';
    for (var i = 0; i < ncols; i++) {
        var totCls = (i === ncols - 1) ? ' rpt-consol-c-total' : '';
        h += '<td class="rpt-c-num' + totCls + '">' + rptConsAmt(colVals[i]) + '</td>';
    }
    return h + '</tr>';
}

function rptRenderConsol() {
    var body = document.getElementById('rptConsolBody');
    if (!body) return;
    rptConsRenderBooks();
    rptConsSyncControls();

    if (!rptConsolBookIds.length) {
        body.innerHTML = '<div class="rpt-consol-empty">Pick one or more books to consolidate…</div>';
        return;
    }
    var cols = rptConsBuildColumns();
    var ncols = cols.length;

    // Header
    var th = '<tr><th class="rpt-c-name">Ledger</th>';
    cols.forEach(function (c, i) {
        var totCls = (i === ncols - 1) ? ' rpt-consol-c-total' : '';
        th += '<th class="rpt-c-num' + totCls + '">' + wmsEsc(c.label) + '</th>';
    });
    th += '</tr>';

    var rows = '';
    if (rptConsStatement === 'bs') {
        var assets = rptConsNatureTree('Assets', cols);
        var liab = rptConsNatureTree('Liabilities', cols);
        var cap = rptConsNatureTree('Capital', cols);
        var inc = rptConsNatureTree('Income', cols);
        var exp = rptConsNatureTree('Expenses', cols);
        // Net Income block (equity side): Income (positive) + Expenses (negated).
        var plChildren = [];
        if (inc) plChildren.push(inc);
        if (exp) plChildren.push(rptConsNegate(exp));
        var plNode = null;
        if (plChildren.length) {
            plNode = { key: 'r:PL', label: 'Profit & Loss (Net Income)', isRoot: true, isGroup: true,
                children: plChildren, colVals: rptConsSumCols(plChildren, ncols) };
        }
        var assetsTot = assets ? assets.colVals : rptConsSumCols([], ncols);
        var eqLiab = rptConsSumCols([liab, cap, plNode], ncols);
        var diff = assetsTot.map(function (v, i) { return Math.round((v - eqLiab[i]) * 100) / 100; });

        rows += rptConsNodeRows(assets, 0, ncols);
        rows += rptConsSummaryRow('Total Assets', assetsTot, ncols, 'rpt-consol-sect');
        rows += rptConsNodeRows(liab, 0, ncols);
        rows += rptConsNodeRows(cap, 0, ncols);
        rows += rptConsNodeRows(plNode, 0, ncols);
        rows += rptConsSummaryRow('Total Equity & Liabilities', eqLiab, ncols, 'rpt-consol-sect');
        var anyDiff = diff.some(function (v) { return Math.abs(v) >= 0.005; });
        rows += rptConsSummaryRow(anyDiff ? '⚠ Difference (should be 0)' : '✓ Balanced — Difference', diff, ncols, anyDiff ? 'rpt-consol-diff' : 'rpt-consol-ok');
    } else {
        var incP = rptConsNatureTree('Income', cols);
        var expP = rptConsNatureTree('Expenses', cols);
        var incTot = incP ? incP.colVals : rptConsSumCols([], ncols);
        var expTot = expP ? expP.colVals : rptConsSumCols([], ncols);
        var netP = incTot.map(function (v, i) { return v - expTot[i]; });
        rows += rptConsNodeRows(incP, 0, ncols);
        rows += rptConsSummaryRow('Total Income', incTot, ncols, 'rpt-consol-sect');
        rows += rptConsNodeRows(expP, 0, ncols);
        rows += rptConsSummaryRow('Total Expenses', expTot, ncols, 'rpt-consol-sect');
        rows += rptConsSummaryRow('Net Profit / (Loss)', netP, ncols, 'rpt-consol-sect rpt-consol-net');
    }

    if (!rows) { body.innerHTML = '<div class="rpt-consol-empty">No ledger balances for the selected books.</div>'; return; }
    body.innerHTML = '<table class="rpt-consol-table"><thead>' + th + '</thead><tbody>' + rows + '</tbody></table>';

    body.querySelectorAll('tr.rpt-consol-row-group').forEach(function (tr) {
        tr.onclick = function () {
            var k = tr.dataset.cnode;
            if (rptConsCollapsed[k]) delete rptConsCollapsed[k]; else rptConsCollapsed[k] = true;
            rptConsSaveCollapse();
            rptRenderConsol();
        };
    });
}

// ---------------------------------------------------------------------------
// CONTROLS
// ---------------------------------------------------------------------------
function rptConsSyncControls() {
    document.querySelectorAll('#rpt-consol .rpt-consol-stmt-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.stmt === rptConsStatement); });
    document.querySelectorAll('#rpt-consol .rpt-consol-mode-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === rptConsolMode); });
    var zc = document.getElementById('rptConsolZeroChk'); if (zc) zc.checked = rptConsShowZero;
    var unit = document.getElementById('rptConsolUnit');
    if (unit) unit.textContent = 'all amounts in ' + ((typeof wmsIsFullAmount === 'function' && wmsIsFullAmount()) ? 'full ₹' : ((typeof getUnitDescription === 'function') ? getUnitDescription() : "₹ '000"));
    // Expand/collapse toggle label reflects current state.
    var tgl = document.getElementById('rptConsolToggleBtn');
    if (tgl) {
        var cols = rptConsolBookIds.length ? rptConsBuildColumns() : [];
        var keys = cols.length ? rptConsAllGroupKeys(rptConsCurrentTreeNodes(cols), []) : [];
        var anyOpen = keys.some(function (k) { return !rptConsCollapsed[k]; });
        tgl.textContent = anyOpen ? '⇵ Collapse all' : '⇵ Expand all';
    }
}
// The top-level nodes currently on screen (for expand/collapse/summary key sets).
function rptConsCurrentTreeNodes(cols) {
    if (rptConsStatement === 'bs') {
        var a = rptConsNatureTree('Assets', cols), l = rptConsNatureTree('Liabilities', cols),
            c = rptConsNatureTree('Capital', cols), inc = rptConsNatureTree('Income', cols), exp = rptConsNatureTree('Expenses', cols);
        var plc = []; if (inc) plc.push(inc); if (exp) plc.push(rptConsNegate(exp));
        var pl = plc.length ? { key: 'r:PL', isRoot: true, isGroup: true, children: plc, colVals: [] } : null;
        return [a, l, c, pl].filter(Boolean);
    }
    return [rptConsNatureTree('Income', cols), rptConsNatureTree('Expenses', cols)].filter(Boolean);
}

function rptConsRenderBooks() {
    var host = document.getElementById('rptConsolBooks');
    if (!host) return;
    var books = (rptInvestors || []).filter(function (v) { return v.accounting_enabled; });
    // Selected books first (in saved order), then the rest — so the draggable
    // chips ARE the column order for Books layout.
    var ordered = rptConsolBookIds.map(function (id) { return books.find(function (b) { return String(b.id) === String(id); }); }).filter(Boolean);
    books.forEach(function (b) { if (rptConsolBookIds.map(String).indexOf(String(b.id)) < 0) ordered.push(b); });
    var h = '';
    ordered.forEach(function (b) {
        var on = rptConsolBookIds.map(String).indexOf(String(b.id)) >= 0;
        h += '<span class="rpt-consol-book' + (on ? ' on' : '') + '" data-book="' + b.id + '"' + (on ? ' draggable="true"' : '') + '>' + wmsEsc(b.short_name || b.name) + '</span>';
    });
    host.innerHTML = h || '<span style="font-size:11px;color:#9ca3af;">No accounting books</span>';
    host.querySelectorAll('.rpt-consol-book').forEach(function (chip) {
        chip.onclick = async function () {
            if (chip._dragging) return;
            var id = chip.dataset.book;
            var i = rptConsolBookIds.map(String).indexOf(String(id));
            if (i >= 0) rptConsolBookIds.splice(i, 1); else rptConsolBookIds.push(id);
            rptConsSavePrefs();
            showLoading(true);
            try { await rptLoadConsol(); } catch (e) { console.error(e); showAlert('Failed to load books: ' + e.message, 'error'); }
            showLoading(false);
            rptRenderConsol();
        };
        // Drag to reorder (only selected chips are draggable).
        chip.addEventListener('dragstart', function (e) { chip._dragging = true; e.dataTransfer.setData('text/plain', chip.dataset.book); e.dataTransfer.effectAllowed = 'move'; });
        chip.addEventListener('dragend', function () { setTimeout(function () { chip._dragging = false; }, 0); });
        chip.addEventListener('dragover', function (e) { if (chip.classList.contains('on')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } });
        chip.addEventListener('drop', function (e) {
            e.preventDefault();
            var src = e.dataTransfer.getData('text/plain'), tgt = chip.dataset.book;
            if (!src || src === tgt) return;
            var arr = rptConsolBookIds.map(String);
            var si = arr.indexOf(String(src)), ti = arr.indexOf(String(tgt));
            if (si < 0 || ti < 0) return;
            arr.splice(si, 1); arr.splice(ti, 0, String(src));
            rptConsolBookIds = arr;
            rptConsSavePrefs();
            rptRenderConsol();
        });
    });
}

// ---- Consolidation view manager (saved views: books order + statement + layout) ----
var rptConsolVM = wmsViewManager({
    module: 'reports_consolidation',
    label: 'Rpt Consolidation',
    ids: {
        viewTabs: 'rpt-consol-view-tabs',
        moreList: 'rpt-consol-more-list',
        moreDropdown: 'rpt-consol-more-dropdown',
        updateBtn: 'rpt-consol-update-view-btn'
    },
    autoDefaultFirst: true,
    getFilters: function () { return { bookIds: rptConsolBookIds.slice(), statement: rptConsStatement, mode: rptConsolMode, showZero: rptConsShowZero }; },
    applyFilters: function (f) {
        rptConsolBookIds = (f && f.bookIds ? f.bookIds.slice() : []);
        rptConsStatement = (f && (f.statement === 'pl' || f.statement === 'bs')) ? f.statement : 'bs';
        rptConsolMode = (f && f.mode) || 'books';
        rptConsShowZero = !!(f && f.showZero);
        rptConsSavePrefs();
    },
    onRefresh: async function () {
        showLoading(true);
        try { await rptLoadConsol(); } catch (e) { console.error(e); }
        showLoading(false);
        rptRenderConsol();
    }
});

function rptInitConsol() {
    rptConsLoadPrefs();
    document.querySelectorAll('#rpt-consol .rpt-consol-stmt-btn').forEach(function (b) {
        b.addEventListener('click', function () { rptConsStatement = b.dataset.stmt; rptConsSavePrefs(); rptRenderConsol(); });
    });
    document.querySelectorAll('#rpt-consol .rpt-consol-mode-btn').forEach(function (b) {
        b.addEventListener('click', function () { rptConsolMode = b.dataset.mode; rptConsSavePrefs(); rptRenderConsol(); });
    });
    var tgl = document.getElementById('rptConsolToggleBtn');
    if (tgl) tgl.addEventListener('click', function () {
        if (!rptConsolBookIds.length) return;
        var cols = rptConsBuildColumns();
        var keys = rptConsAllGroupKeys(rptConsCurrentTreeNodes(cols), []);
        var anyOpen = keys.some(function (k) { return !rptConsCollapsed[k]; });
        if (anyOpen) keys.forEach(function (k) { rptConsCollapsed[k] = true; });
        else keys.forEach(function (k) { delete rptConsCollapsed[k]; });
        rptConsSaveCollapse(); rptRenderConsol();
    });
    var sm = document.getElementById('rptConsolSummaryBtn');
    if (sm) sm.addEventListener('click', function () {
        if (!rptConsolBookIds.length) return;
        var cols = rptConsBuildColumns();
        var roots = rptConsCurrentTreeNodes(cols);
        // Summary = roots expanded, every group below them collapsed.
        roots.forEach(function (r) { delete rptConsCollapsed[r.key]; if (r.children) rptConsAllGroupKeys(r.children, []).forEach(function (k) { rptConsCollapsed[k] = true; }); });
        rptConsSaveCollapse(); rptRenderConsol();
    });
    var zc = document.getElementById('rptConsolZeroChk');
    if (zc) zc.addEventListener('change', function () { rptConsShowZero = zc.checked; rptConsSavePrefs(); rptRenderConsol(); });

    rptInitConsolViewBar();
}

// View bar wiring (mirrors rptInitCGViewBar, using rptConsolVM)
function rptInitConsolViewBar() {
    var newBtn = document.getElementById('rpt-consol-new-view-btn');
    if (newBtn) newBtn.addEventListener('click', function () {
        rptConsolVM.activeViewId = null; rptConsolVM.renderViewTabs(); rptConsolVM.updateViewButtons();
    });
    var moreBtn = document.getElementById('rpt-consol-more-btn');
    if (moreBtn) moreBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var dd = document.getElementById('rpt-consol-more-dropdown');
        dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
    });
    var updateBtn = document.getElementById('rpt-consol-update-view-btn');
    if (updateBtn) updateBtn.addEventListener('click', function () { rptConsolVM.updateCurrentView(); });
    var saveNewBtn = document.getElementById('rpt-consol-save-new-btn');
    var savePrompt = document.getElementById('rpt-consol-save-prompt');
    var savePromptName = document.getElementById('rpt-consol-save-prompt-name');
    if (saveNewBtn && savePrompt) {
        saveNewBtn.addEventListener('click', function () {
            savePrompt.classList.add('show'); saveNewBtn.style.display = 'none'; savePromptName.value = ''; savePromptName.focus();
        });
        document.getElementById('rpt-consol-save-prompt-ok').addEventListener('click', function () {
            var name = savePromptName.value.trim();
            if (name) rptConsolVM.saveCurrentView(name);
            savePrompt.classList.remove('show'); saveNewBtn.style.display = '';
        });
        document.getElementById('rpt-consol-save-prompt-cancel').addEventListener('click', function () {
            savePrompt.classList.remove('show'); saveNewBtn.style.display = '';
        });
        savePromptName.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                var name = savePromptName.value.trim();
                if (name) rptConsolVM.saveCurrentView(name);
                savePrompt.classList.remove('show'); saveNewBtn.style.display = '';
            } else if (e.key === 'Escape') {
                savePrompt.classList.remove('show'); saveNewBtn.style.display = '';
            }
        });
    }
    document.addEventListener('click', function (e) {
        if (!e.target.closest('#rpt-consol-more-btn') && !e.target.closest('#rpt-consol-more-dropdown')) {
            var mdd = document.getElementById('rpt-consol-more-dropdown');
            if (mdd) mdd.style.display = 'none';
        }
    });
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
    window.rptRenderConsol = rptRenderConsol;
}
