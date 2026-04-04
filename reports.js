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

// Capital Gains tab filters
var rptCGSelectedInvestorIds = [];
var rptCGSelectedBrokerIds = [];

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
// FIFO ENGINE
// Processes sorted BUY/SELL transactions → returns { holdings[], gains[] }
//   holdings: open lots with individual cost and acquisition date
//   gains:    realized gain events with buy/sell dates, amounts, holding period
// ============================================================================

function rptFifoEngine(txns) {
    // txns must be sorted by date ascending
    var lots = {};   // key → [ { date, qty, price, netPerUnit, investorId, brokerId, tags } ]
    var gains = [];  // realized gain events

    for (var i = 0; i < txns.length; i++) {
        var t = txns[i];
        if (wmsIsQtyExcluded(t.type)) continue;

        var key = t.symbol + '-' + t.exchange;
        if (!lots[key]) lots[key] = [];

        if (t.type === 'BUY') {
            var costPerUnit = t.quantity !== 0 ? t.netAmount / t.quantity : t.price;
            lots[key].push({
                date: t.date,
                qty: t.quantity,
                price: t.price,
                costPerUnit: costPerUnit,
                investorId: t.investorId,
                brokerId: t.brokerId,
                tags: t.tags || [],
                securityType: t.securityType
            });
        } else if (t.type === 'SELL') {
            var remainingSellQty = Math.abs(t.quantity); // quantity is negative for SELL in DB
            var sellPricePerUnit = remainingSellQty !== 0 ? t.netAmount / remainingSellQty : t.price;
            var sellDate = t.date;

            // Consume lots FIFO
            while (remainingSellQty > 0 && lots[key].length > 0) {
                var lot = lots[key][0];
                var matchQty = Math.min(remainingSellQty, lot.qty);

                var buyCost = matchQty * lot.costPerUnit;
                var sellProceeds = matchQty * sellPricePerUnit;
                var gain = sellProceeds - buyCost;

                // Holding period in days
                var buyDate = new Date(lot.date);
                var sellD = new Date(sellDate);
                var holdingDays = Math.floor((sellD - buyDate) / (1000 * 60 * 60 * 24));

                gains.push({
                    symbol: t.symbol,
                    shortSymbol: t.shortSymbol,
                    companyName: t.companyName,
                    exchange: t.exchange,
                    securityType: t.securityType || lot.securityType,
                    buyDate: lot.date,
                    sellDate: sellDate,
                    qty: matchQty,
                    buyPrice: lot.price,
                    buyCostPerUnit: lot.costPerUnit,
                    sellPrice: t.price,
                    sellProceedsPerUnit: sellPricePerUnit,
                    buyCost: buyCost,
                    sellProceeds: sellProceeds,
                    gain: gain,
                    holdingDays: holdingDays,
                    investorId: t.investorId,
                    brokerId: t.brokerId
                });

                lot.qty -= matchQty;
                remainingSellQty -= matchQty;
                if (lot.qty <= 0) lots[key].shift();
            }
            // If remainingSellQty > 0 it means short sell — treat as new negative lot
            if (remainingSellQty > 0) {
                lots[key].push({
                    date: sellDate,
                    qty: -remainingSellQty,
                    price: t.price,
                    costPerUnit: sellPricePerUnit,
                    investorId: t.investorId,
                    brokerId: t.brokerId,
                    tags: t.tags || [],
                    securityType: t.securityType
                });
            }
        }
    }

    // Build holdings summary from remaining lots
    var holdings = {};
    var keys = Object.keys(lots);
    for (var k = 0; k < keys.length; k++) {
        var sym = keys[k];
        var lotArr = lots[sym];
        if (lotArr.length === 0) continue;

        var totalQty = 0;
        var totalCost = 0;
        var tagsSet = {};
        var latestPrice = 0;
        var latestDate = null;
        var secType = null;
        var symParts = sym.split('-');
        var symbolName = '', shortSym = '', compName = '', exchName = '';

        for (var j = 0; j < lotArr.length; j++) {
            var lt = lotArr[j];
            totalQty += lt.qty;
            totalCost += lt.qty * lt.costPerUnit;
            if (lt.tags) {
                for (var ti = 0; ti < lt.tags.length; ti++) tagsSet[lt.tags[ti]] = true;
            }
            if (!secType && lt.securityType) secType = lt.securityType;
        }

        // We need the original txn info for symbol/company etc — find from rptTransactions
        for (var m = 0; m < rptTransactions.length; m++) {
            var tt = rptTransactions[m];
            if (tt.symbol + '-' + tt.exchange === sym) {
                symbolName = tt.symbol;
                shortSym = tt.shortSymbol;
                compName = tt.companyName;
                exchName = tt.exchange;
                if (!secType) secType = tt.securityType;
                latestPrice = tt.price;
                latestDate = tt.date;
                break;
            }
        }
        // Get latest price from last txn for this symbol
        for (var m2 = rptTransactions.length - 1; m2 >= 0; m2--) {
            if (rptTransactions[m2].symbol + '-' + rptTransactions[m2].exchange === sym) {
                latestPrice = rptTransactions[m2].price;
                latestDate = rptTransactions[m2].date;
                break;
            }
        }

        holdings[sym] = {
            symbol: symbolName,
            shortSymbol: shortSym,
            companyName: compName,
            exchange: exchName,
            securityType: secType,
            assetClass: rptGetAssetClass(secType),
            quantity: totalQty,
            totalCost: totalCost,
            fifoCost: totalQty !== 0 ? totalCost / totalQty : 0,
            tags: Object.keys(tagsSet),
            latestPrice: latestPrice,
            lots: lotArr,
            _txns: []
        };
    }

    // Attach raw txns for Day P&L calculation
    for (var n = 0; n < rptTransactions.length; n++) {
        var tx = rptTransactions[n];
        var hKey = tx.symbol + '-' + tx.exchange;
        if (holdings[hKey]) holdings[hKey]._txns.push(tx);
    }

    return { holdings: holdings, gains: gains };
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

    // Live prices — best effort
    await rptFetchLivePrices();

    rptUpdateUnitLabels();
    rptSetupTabs();
    rptInitFilterDropdowns();
    rptInitFYSelector();
    rptInitCGFilters();
    rptRenderPortfolio();
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
    // Load all BUY/SELL transactions (need security_type for asset class + CG classification)
    var resp = await fetchWithTimeout(
        SUPABASE_URL + '/rest/v1/transactions?select=id,investor_id,broker_id,symbol,short_symbol,company_name,exchange,security_type,transaction_type,transaction_date,quantity,price,gross_amount,net_amount,tags,dont_display&dont_display=eq.false&transaction_type=in.(BUY,SELL)&order=transaction_date.asc',
        {
            headers: wmsHeaders()
        }
    );
    if (!resp.ok) throw new Error('DB error: ' + resp.status + ' — ' + (await resp.text()));
    var txnData = await resp.json();

    console.log('✅ Reports: loaded ' + txnData.length + ' transactions');

    rptTransactions = txnData.map(function(txn) {
        return {
            id: txn.id,
            investorId: txn.investor_id,
            brokerId: txn.broker_id,
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
    var exch = (holding.exchange || 'NSE').toUpperCase();
    var key = exch === 'NFO'
        ? 'NSE:' + holding.symbol
        : exch + ':' + (holding.shortSymbol || holding.symbol) + '-EQ';
    return rptLiveData[key] || null;
}

function rptGetPrice(holding) {
    var exch = (holding.exchange || 'NSE').toUpperCase();
    var key = exch === 'NFO'
        ? 'NSE:' + holding.symbol
        : exch + ':' + (holding.shortSymbol || holding.symbol) + '-EQ';
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

function rptInitFilterDropdowns() {
    // Investors
    var invDd = document.getElementById('rpt-investor-dropdown');
    if (invDd) {
        invDd.innerHTML = rptInvestors.map(function(inv) {
            return '<div class="filter-dropdown-item" data-id="' + inv.id + '" onclick="rptToggleFilter(\'investor\',\'' + inv.id + '\',\'' + (inv.name || '').replace(/'/g, "\\'") + '\')">' + inv.name + '</div>';
        }).join('');
    }
    // Brokers
    var brkDd = document.getElementById('rpt-broker-dropdown');
    if (brkDd) {
        brkDd.innerHTML = rptBrokers.map(function(brk) {
            return '<div class="filter-dropdown-item" data-id="' + brk.id + '" onclick="rptToggleFilter(\'broker\',\'' + brk.id + '\',\'' + (brk.name || '').replace(/'/g, "\\'") + '\')">' + brk.name + '</div>';
        }).join('');
    }
    // Tags
    var allTags = {};
    rptTransactions.forEach(function(t) { if (t.tags) t.tags.forEach(function(tg) { allTags[tg] = true; }); });
    var tagDd = document.getElementById('rpt-tag-dropdown');
    if (tagDd) {
        tagDd.innerHTML = Object.keys(allTags).sort().map(function(tag) {
            return '<div class="filter-dropdown-item" data-tag="' + tag + '" onclick="rptToggleFilter(\'tag\',\'' + tag + '\')">' + tag + '</div>';
        }).join('');
    }
}

function rptShowDropdown(type) {
    var types = ['investor', 'broker', 'tag'];
    types.forEach(function(t) {
        var dd = document.getElementById('rpt-' + t + '-dropdown');
        if (dd) dd.classList.toggle('show', t === type);
    });
}

function rptFilterSearch(type) {
    var search = document.getElementById('rpt-' + type + '-search').value.toLowerCase();
    var items = document.querySelectorAll('#rpt-' + type + '-dropdown .filter-dropdown-item');
    items.forEach(function(item) {
        item.style.display = item.textContent.toLowerCase().indexOf(search) >= 0 ? 'block' : 'none';
    });
}

function rptToggleFilter(type, id, name) {
    var arr;
    if (type === 'investor') arr = rptSelectedInvestorIds;
    else if (type === 'broker') arr = rptSelectedBrokerIds;
    else arr = rptSelectedTagNames;

    var idx = arr.indexOf(id);
    if (idx > -1) arr.splice(idx, 1);
    else arr.push(id);

    rptUpdateFilterPills(type);
    rptRenderPortfolio();
}

function rptUpdateFilterPills(type) {
    var arr, container, list;
    if (type === 'investor') {
        arr = rptSelectedInvestorIds;
        container = document.getElementById('rpt-selected-investors');
        list = rptInvestors;
    } else if (type === 'broker') {
        arr = rptSelectedBrokerIds;
        container = document.getElementById('rpt-selected-brokers');
        list = rptBrokers;
    } else {
        container = document.getElementById('rpt-selected-tags');
        container.innerHTML = rptSelectedTagNames.map(function(tag) {
            return '<div class="filter-tag-item">' + tag + ' <span class="filter-tag-remove" onclick="rptToggleFilter(\'tag\',\'' + tag + '\')">×</span></div>';
        }).join('');
        return;
    }
    container.innerHTML = arr.map(function(id) {
        var item = list.find(function(x) { return x.id === id; });
        var name = item ? item.name : id;
        return '<div class="filter-tag-item">' + name + ' <span class="filter-tag-remove" onclick="rptToggleFilter(\'' + type + '\',\'' + id + '\',\'' + (name || '').replace(/'/g, "\\'") + '\')">×</span></div>';
    }).join('');
}

function rptClearFilter(type) {
    if (type === 'investor') rptSelectedInvestorIds = [];
    else if (type === 'broker') rptSelectedBrokerIds = [];
    else rptSelectedTagNames = [];
    rptUpdateFilterPills(type);
    rptRenderPortfolio();
}

function rptUpdateTagLogic() {
    var sel = document.querySelector('input[name="rpt-tag-logic"]:checked');
    rptTagFilterLogic = sel ? sel.value : 'OR';
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
    // 2. Exclude F&O and MCX
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

    // 5. Compute totals
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

    // 7. Sort within each group
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

    // 8. Build HTML
    var html = '';
    var sortArrow = rptSortDirection === 'asc' ? '▲' : '▼';
    var sortLabel = (rptSortByPct && (rptSortColumn === 'pl' || rptSortColumn === 'daypl')) ? '%' : '';

    for (var gi = 0; gi < RPT_ASSET_CLASS_ORDER.length; gi++) {
        var acName = RPT_ASSET_CLASS_ORDER[gi];
        var groupHoldings = groups[acName];
        if (!groupHoldings || groupHoldings.length === 0) continue;

        groupHoldings.sort(sortFn);

        // Group totals
        var grpInvested = 0, grpValue = 0;
        groupHoldings.forEach(function(h) {
            grpInvested += h.totalCost;
            grpValue += h.quantity * rptGetPrice(h);
        });
        var grpPL = grpValue - grpInvested;
        var grpPLPct = grpInvested !== 0 ? (grpPL / Math.abs(grpInvested)) * 100 : 0;

        // Group header
        html += '<div class="rpt-asset-group-header">' +
                    '<span>' + acName + ' (' + groupHoldings.length + ')</span>' +
                    '<div class="rpt-group-summary">' +
                        '<span>Invested: ' + formatAmount(grpInvested) + '</span>' +
                        '<span class="' + getAmountClass(grpPL) + '">P&L: ' + formatAmount(grpPL) + ' (' + formatPercent(grpPLPct) + ')</span>' +
                        '<span>Value: ' + formatAmount(grpValue) + '</span>' +
                    '</div>' +
                '</div>';

        // Table for this group
        html += '<table style="width:100%; border-collapse:collapse;">';
        html += '<thead><tr>' +
            '<th class="sortable" onclick="rptSortPortfolio(\'symbol\')" style="width:18%; text-align:left; padding:4px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Symbol ' + (rptSortColumn === 'symbol' ? sortArrow : '') + '</th>' +
            '<th class="text-right" style="width:10%; padding:4px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Qty<br><span class="subheader">FIFO Cost</span></th>' +
            '<th class="text-right sortable" onclick="rptSortPortfolio(\'invested\')" style="width:12%; padding:4px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Investment ' + (rptSortColumn === 'invested' ? sortArrow : '') + '<br><span class="subheader">% of Total</span></th>' +
            '<th class="text-right" style="width:12%; padding:4px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">CMP (₹)</th>' +
            '<th class="text-right sortable" onclick="rptSortPortfolio(\'daypl\')" style="width:11%; padding:4px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Day\'s P&L ' + (rptSortColumn === 'daypl' ? sortLabel + sortArrow : '') + '<br><span class="subheader">Day %</span></th>' +
            '<th class="text-right sortable" onclick="rptSortPortfolio(\'pl\')" style="width:12%; padding:4px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Total P&L ' + (rptSortColumn === 'pl' ? sortLabel + sortArrow : '') + '<br><span class="subheader">P&L %</span></th>' +
            '<th class="text-right sortable" onclick="rptSortPortfolio(\'value\')" style="width:12%; padding:4px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Current Value ' + (rptSortColumn === 'value' ? sortArrow : '') + '<br><span class="subheader">% of Total</span></th>' +
            '<th style="width:13%; padding:4px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Tags</th>' +
            '</tr></thead><tbody>';

        for (var hi = 0; hi < groupHoldings.length; hi++) {
            var h = groupHoldings[hi];
            var price = rptGetPrice(h);
            var md = rptGetLiveData(h);
            var invested = h.totalCost;
            var currentValue = h.quantity * price;
            var pl = currentValue - invested;
            var plPct = invested !== 0 ? (pl / Math.abs(invested)) * 100 : 0;
            var invPct = grandTotalInvested !== 0 ? (invested / grandTotalInvested) * 100 : 0;
            var valPct = grandTotalValue !== 0 ? (currentValue / grandTotalValue) * 100 : 0;
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
            var isExpanded = rptExpandedSymbol === symbolKey;
            var expClass = isExpanded ? 'expanded-row' : '';

            var dayPLHtml = dayPL !== null
                ? '<div class="number-main ' + getAmountClass(dayPL) + '">' + formatAmount(dayPL) + '</div>' +
                  '<div class="number-sub ' + getAmountClass(dayChp) + '">' + formatPercent(dayChp) + '</div>'
                : '<div class="number-main">-</div>';

            html += '<tr class="' + expClass + '">' +
                '<td class="symbol-cell" style="padding:6px 8px;">' +
                    '<div class="symbol-main symbol-clickable" onclick="rptToggleSymbolDetail(\'' + h.symbol + '\',\'' + h.exchange + '\')">' + h.symbol + '</div>' +
                    '<div class="symbol-sub">' + (h.companyName || '') + '</div>' +
                '</td>' +
                '<td class="text-right" style="padding:6px 8px;">' +
                    qtyHtml +
                    '<div class="number-sub">' + formatPrice(h.fifoCost, false) + '</div>' +
                '</td>' +
                '<td class="text-right" style="padding:6px 8px;">' +
                    '<div class="number-main">' + formatAmount(invested) + '</div>' +
                    '<div class="number-sub">' + invPct.toFixed(2) + '%</div>' +
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
                    '<div class="number-sub">' + valPct.toFixed(2) + '%</div>' +
                '</td>' +
                '<td style="padding:6px 8px;">' + h.tags.map(function(t) { return '<span class="tag-badge">' + t + '</span>'; }).join('') + '</td>' +
            '</tr>';

            // Expanded: show FIFO lot breakdown
            if (isExpanded && h.lots && h.lots.length > 0) {
                html += '<tr class="detail-row"><td colspan="8" style="padding:4px 8px;">' +
                    '<table class="inner-table" style="width:100%;"><thead><tr>' +
                    '<th style="text-align:left; font-size:10px; color:#718096;">Buy Date</th>' +
                    '<th class="text-right" style="font-size:10px; color:#718096;">Lot Qty</th>' +
                    '<th class="text-right" style="font-size:10px; color:#718096;">Buy Price</th>' +
                    '<th class="text-right" style="font-size:10px; color:#718096;">FIFO Cost/Unit</th>' +
                    '<th class="text-right" style="font-size:10px; color:#718096;">Lot Investment</th>' +
                    '<th class="text-right" style="font-size:10px; color:#718096;">Current Value</th>' +
                    '<th class="text-right" style="font-size:10px; color:#718096;">P&L</th>' +
                    '<th class="text-right" style="font-size:10px; color:#718096;">Holding Days</th>' +
                    '</tr></thead><tbody>';

                for (var li = 0; li < h.lots.length; li++) {
                    var lot = h.lots[li];
                    if (lot.qty === 0) continue;
                    var lotInv = lot.qty * lot.costPerUnit;
                    var lotVal = lot.qty * price;
                    var lotPL = lotVal - lotInv;
                    var lotDays = Math.floor((new Date() - new Date(lot.date)) / (1000 * 60 * 60 * 24));

                    html += '<tr>' +
                        '<td style="padding:3px 6px; font-size:11px;">' + formatDate(lot.date) + '</td>' +
                        '<td class="text-right" style="padding:3px 6px; font-size:11px;">' + formatQuantity(Math.abs(lot.qty)) + '</td>' +
                        '<td class="text-right" style="padding:3px 6px; font-size:11px;">' + formatPrice(lot.price, false) + '</td>' +
                        '<td class="text-right" style="padding:3px 6px; font-size:11px;">' + formatPrice(lot.costPerUnit, false) + '</td>' +
                        '<td class="text-right" style="padding:3px 6px; font-size:11px;">' + formatAmount(lotInv) + '</td>' +
                        '<td class="text-right" style="padding:3px 6px; font-size:11px;">' + formatAmount(lotVal) + '</td>' +
                        '<td class="text-right ' + getAmountClass(lotPL) + '" style="padding:3px 6px; font-size:11px;">' + formatAmount(lotPL) + '</td>' +
                        '<td class="text-right" style="padding:3px 6px; font-size:11px;">' + lotDays + 'd</td>' +
                    '</tr>';
                }

                html += '</tbody></table></td></tr>';
            }
        }

        // Group total row
        html += '<tr class="total-row" style="background:#f0f4f8; font-weight:700;">' +
            '<td style="padding:5px 8px; font-size:12px;">' + acName + ' Total</td>' +
            '<td class="text-right" style="padding:5px 8px; font-size:12px;">' + groupHoldings.length + ' stocks</td>' +
            '<td class="text-right" style="padding:5px 8px; font-size:12px;">' + formatAmount(grpInvested) + '</td>' +
            '<td class="text-right" style="padding:5px 8px;">-</td>' +
            '<td class="text-right" style="padding:5px 8px;">-</td>' +
            '<td class="text-right" style="padding:5px 8px;"><span class="' + getAmountClass(grpPL) + '">' + formatAmount(grpPL) + '</span></td>' +
            '<td class="text-right" style="padding:5px 8px;">' + formatAmount(grpValue) + '</td>' +
            '<td style="padding:5px 8px;">-</td>' +
        '</tr>';

        html += '</tbody></table>';
    }

    body.innerHTML = html;

    // Summary cards
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
    var invDd = document.getElementById('rpt-cg-investor-dropdown');
    if (invDd) {
        invDd.innerHTML = rptInvestors.map(function(inv) {
            return '<div class="filter-dropdown-item" data-id="' + inv.id + '" onclick="rptCGToggleFilter(\'investor\',\'' + inv.id + '\',\'' + (inv.name || '').replace(/'/g, "\\'") + '\')">' + inv.name + '</div>';
        }).join('');
    }
    var brkDd = document.getElementById('rpt-cg-broker-dropdown');
    if (brkDd) {
        brkDd.innerHTML = rptBrokers.map(function(brk) {
            return '<div class="filter-dropdown-item" data-id="' + brk.id + '" onclick="rptCGToggleFilter(\'broker\',\'' + brk.id + '\',\'' + (brk.name || '').replace(/'/g, "\\'") + '\')">' + brk.name + '</div>';
        }).join('');
    }
}

function rptCGShowDropdown(type) {
    var types = ['investor', 'broker'];
    types.forEach(function(t) {
        var dd = document.getElementById('rpt-cg-' + t + '-dropdown');
        if (dd) dd.classList.toggle('show', t === type);
    });
}

function rptCGFilterSearch(type) {
    var search = document.getElementById('rpt-cg-' + type + '-search').value.toLowerCase();
    var items = document.querySelectorAll('#rpt-cg-' + type + '-dropdown .filter-dropdown-item');
    items.forEach(function(item) {
        item.style.display = item.textContent.toLowerCase().indexOf(search) >= 0 ? 'block' : 'none';
    });
}

function rptCGToggleFilter(type, id, name) {
    var arr = type === 'investor' ? rptCGSelectedInvestorIds : rptCGSelectedBrokerIds;
    var idx = arr.indexOf(id);
    if (idx > -1) arr.splice(idx, 1);
    else arr.push(id);
    rptCGUpdateFilterPills(type);
    rptRenderCapGains();
}

function rptCGUpdateFilterPills(type) {
    var arr, container, list;
    if (type === 'investor') {
        arr = rptCGSelectedInvestorIds;
        container = document.getElementById('rpt-cg-selected-investors');
        list = rptInvestors;
    } else {
        arr = rptCGSelectedBrokerIds;
        container = document.getElementById('rpt-cg-selected-brokers');
        list = rptBrokers;
    }
    container.innerHTML = arr.map(function(id) {
        var item = list.find(function(x) { return x.id === id; });
        var name = item ? item.name : id;
        return '<div class="filter-tag-item">' + name + ' <span class="filter-tag-remove" onclick="rptCGToggleFilter(\'' + type + '\',\'' + id + '\',\'' + (name || '').replace(/'/g, "\\'") + '\')">×</span></div>';
    }).join('');
}

function rptCGClearFilter(type) {
    if (type === 'investor') rptCGSelectedInvestorIds = [];
    else rptCGSelectedBrokerIds = [];
    rptCGUpdateFilterPills(type);
    rptRenderCapGains();
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

    // Run FIFO on ALL transactions (not just FY) to get correct lot matching
    var fifo = rptFifoEngine(filtered);

    // Filter gains to selected FY (sell date within FY)
    var fyGains = fifo.gains.filter(function(g) {
        return g.sellDate >= fyStart && g.sellDate <= fyEnd;
    });

    if (fyGains.length === 0) {
        summaryEl.innerHTML = '';
        bodyEl.innerHTML = '<div style="text-align:center;padding:40px;color:#9ca3af;">No capital gains for FY ' + fy + '-' + String(fy + 1).slice(2) + '</div>';
        return;
    }

    // Classify and aggregate
    var totalLTCG = 0, totalSTCG = 0, totalGain = 0;
    var ltcgCount = 0, stcgCount = 0;

    fyGains.forEach(function(g) {
        var cls = rptClassifyGain(g);
        g._cgType = cls.type;
        g._cgRate = cls.rate;
        g._cgRateNote = cls.rateNote;
        totalGain += g.gain;
        if (cls.type === 'LTCG') {
            totalLTCG += g.gain;
            ltcgCount++;
        } else {
            totalSTCG += g.gain;
            stcgCount++;
        }
    });

    // Estimated tax
    var ltcgTaxable = Math.max(0, totalLTCG - RPT_CG_LTCG_EXEMPTION);
    var estLTCGTax = ltcgTaxable * RPT_CG_LTCG_RATE / 100;
    var estSTCGTax = totalSTCG > 0 ? totalSTCG * RPT_CG_STCG_RATE / 100 : 0;

    // Summary cards
    summaryEl.innerHTML =
        '<div class="rpt-cg-card">' +
            '<div class="rpt-cg-card-label">Total Realized Gains</div>' +
            '<div class="rpt-cg-card-value ' + getAmountClass(totalGain) + '">' + formatAmount(totalGain) + '</div>' +
            '<div class="rpt-cg-card-sub">' + fyGains.length + ' transactions</div>' +
        '</div>' +
        '<div class="rpt-cg-card">' +
            '<div class="rpt-cg-card-label">Long Term (LTCG)</div>' +
            '<div class="rpt-cg-card-value ' + getAmountClass(totalLTCG) + '">' + formatAmount(totalLTCG) + '</div>' +
            '<div class="rpt-cg-card-sub">' + ltcgCount + ' txns · ' + RPT_CG_LTCG_RATE + '% above ₹' + (RPT_CG_LTCG_EXEMPTION / 100000).toFixed(2) + 'L</div>' +
        '</div>' +
        '<div class="rpt-cg-card">' +
            '<div class="rpt-cg-card-label">Short Term (STCG)</div>' +
            '<div class="rpt-cg-card-value ' + getAmountClass(totalSTCG) + '">' + formatAmount(totalSTCG) + '</div>' +
            '<div class="rpt-cg-card-sub">' + stcgCount + ' txns · ' + RPT_CG_STCG_RATE + '% (listed equity)</div>' +
        '</div>' +
        '<div class="rpt-cg-card">' +
            '<div class="rpt-cg-card-label">Est. Tax Liability</div>' +
            '<div class="rpt-cg-card-value">' + formatAmount(estLTCGTax + estSTCGTax) + '</div>' +
            '<div class="rpt-cg-card-sub">LTCG: ' + formatAmount(estLTCGTax) + ' · STCG: ' + formatAmount(estSTCGTax) + '</div>' +
        '</div>';

    // Sort gains: most recent sell date first
    fyGains.sort(function(a, b) {
        if (a.sellDate > b.sellDate) return -1;
        if (a.sellDate < b.sellDate) return 1;
        return a.symbol.localeCompare(b.symbol);
    });

    // Detail table
    var html = '<table class="rpt-cg-table" style="width:100%; border-collapse:collapse;">';
    html += '<thead><tr>' +
        '<th style="text-align:left; padding:6px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Symbol</th>' +
        '<th style="text-align:left; padding:6px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Type</th>' +
        '<th style="text-align:left; padding:6px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Buy Date</th>' +
        '<th style="text-align:left; padding:6px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Sell Date</th>' +
        '<th class="text-right" style="padding:6px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Qty</th>' +
        '<th class="text-right" style="padding:6px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Buy Price</th>' +
        '<th class="text-right" style="padding:6px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Sell Price</th>' +
        '<th class="text-right" style="padding:6px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Buy Cost</th>' +
        '<th class="text-right" style="padding:6px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Sell Proceeds</th>' +
        '<th class="text-right" style="padding:6px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Gain/Loss</th>' +
        '<th class="text-right" style="padding:6px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Holding</th>' +
        '<th style="padding:6px 8px; font-size:11px; color:#718096; border-bottom:1px solid #e2e8f0;">Tax Rate</th>' +
    '</tr></thead><tbody>';

    for (var i = 0; i < fyGains.length; i++) {
        var g = fyGains[i];
        var badgeClass = g._cgType === 'LTCG' ? 'ltcg' : 'stcg';
        var holdLabel = g.holdingDays + 'd';
        if (g.holdingDays > 365) holdLabel = Math.floor(g.holdingDays / 365) + 'y ' + (g.holdingDays % 365) + 'd';

        html += '<tr style="border-bottom:1px solid #f0f4f8;">' +
            '<td style="padding:5px 8px;">' +
                '<div style="font-weight:600; font-size:12px;">' + g.symbol + '</div>' +
                '<div style="font-size:10px; color:#a0aec0;">' + (g.companyName || '') + '</div>' +
            '</td>' +
            '<td style="padding:5px 8px;"><span class="rpt-cg-type-badge ' + badgeClass + '">' + g._cgType + '</span></td>' +
            '<td style="padding:5px 8px; font-size:12px;">' + formatDate(g.buyDate) + '</td>' +
            '<td style="padding:5px 8px; font-size:12px;">' + formatDate(g.sellDate) + '</td>' +
            '<td class="text-right" style="padding:5px 8px; font-size:12px;">' + formatQuantity(g.qty) + '</td>' +
            '<td class="text-right" style="padding:5px 8px; font-size:12px;">' + formatPrice(g.buyPrice, false) + '</td>' +
            '<td class="text-right" style="padding:5px 8px; font-size:12px;">' + formatPrice(g.sellPrice, false) + '</td>' +
            '<td class="text-right" style="padding:5px 8px; font-size:12px;">' + formatAmount(g.buyCost) + '</td>' +
            '<td class="text-right" style="padding:5px 8px; font-size:12px;">' + formatAmount(g.sellProceeds) + '</td>' +
            '<td class="text-right ' + getAmountClass(g.gain) + '" style="padding:5px 8px; font-size:12px; font-weight:600;">' + formatAmount(g.gain) + '</td>' +
            '<td class="text-right" style="padding:5px 8px; font-size:11px; color:#718096;">' + holdLabel + '</td>' +
            '<td style="padding:5px 8px; font-size:11px; color:#718096;" title="' + g._cgRateNote + '">' + g._cgRate + '</td>' +
        '</tr>';
    }

    // Totals row
    var totalBuyCost = 0, totalSellProceeds = 0;
    fyGains.forEach(function(g) { totalBuyCost += g.buyCost; totalSellProceeds += g.sellProceeds; });
    html += '<tr class="total-row" style="background:#f0f4f8; font-weight:700; border-top:2px solid #cbd5e0;">' +
        '<td style="padding:6px 8px;">TOTAL</td>' +
        '<td colspan="3" style="padding:6px 8px;">' + fyGains.length + ' transactions</td>' +
        '<td class="text-right" style="padding:6px 8px;">' + formatQuantity(fyGains.reduce(function(s, g) { return s + g.qty; }, 0)) + '</td>' +
        '<td colspan="2" style="padding:6px 8px;"></td>' +
        '<td class="text-right" style="padding:6px 8px;">' + formatAmount(totalBuyCost) + '</td>' +
        '<td class="text-right" style="padding:6px 8px;">' + formatAmount(totalSellProceeds) + '</td>' +
        '<td class="text-right ' + getAmountClass(totalGain) + '" style="padding:6px 8px;">' + formatAmount(totalGain) + '</td>' +
        '<td colspan="2" style="padding:6px 8px;"></td>' +
    '</tr>';

    html += '</tbody></table>';
    bodyEl.innerHTML = html;
}

// ============================================================================
// CLOSE DROPDOWNS ON OUTSIDE CLICK
// ============================================================================

document.addEventListener('click', function(e) {
    if (!e.target.closest('.filter-search-container')) {
        document.querySelectorAll('.reports-container .filter-dropdown').forEach(function(dd) {
            dd.classList.remove('show');
        });
    }
});

// ============================================================================
// EXPORTS
// ============================================================================

if (typeof window !== 'undefined') {
    window.initReports = initReports;
    window.rptRefresh = rptRefresh;
    window.rptSortPortfolio = rptSortPortfolio;
    window.rptToggleSymbolDetail = rptToggleSymbolDetail;
    window.rptToggleZero = rptToggleZero;
    window.rptShowDropdown = rptShowDropdown;
    window.rptFilterSearch = rptFilterSearch;
    window.rptToggleFilter = rptToggleFilter;
    window.rptClearFilter = rptClearFilter;
    window.rptUpdateTagLogic = rptUpdateTagLogic;
    window.rptRenderPortfolio = rptRenderPortfolio;
    window.rptRenderCapGains = rptRenderCapGains;
    window.rptCGShowDropdown = rptCGShowDropdown;
    window.rptCGFilterSearch = rptCGFilterSearch;
    window.rptCGToggleFilter = rptCGToggleFilter;
    window.rptCGClearFilter = rptCGClearFilter;
}
