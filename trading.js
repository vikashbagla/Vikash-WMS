// ============================================================================
// WMS TRADING MODULE
// ============================================================================
// Uses 'tr' prefix to avoid naming conflicts with portfolio.js and utils.js.
// All module-level state uses var (project convention — avoids TDZ on reload).

var INCOME_TYPES = ['DIVIDEND', 'INTEREST', 'OTHER_INCOME', 'CAPITAL_REDUCTION'];

var trTransactions = [];
var trInvestors = [];
var trBrokers = [];
var trSelectedInvestorIds = [];
var trSelectedBrokerIds = [];
var trSelectedTagNames = [];
var trTagFilterLogic = 'OR';
var trSortColumn = 'company';
var trSortDirection = 'asc';
var trSortByPct = false;
var trExpandedKey = null;
var trShowZeroHoldings = false;
var trLivePrices = {};
var trLiveData = {};
var trOpenActionMenu = null;
var trCurrentTxnModalKey = null;
var trCurrentTxnInvestorId = null; // optional investor filter for txn modal
var trEditingTxnId = null;

// Txn modal state
var trTxnSortColumn = 'date';
var trTxnSortDirection = 'asc';
var trTxnHiddenIds = {};        // temp hidden trade IDs (UI only)
var trShowHiddenTrades = false;  // toggle for showing hidden trades

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
        showAlert('Add Transaction — Coming soon!', 'info', 2000);
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

    // Edit modal close/save
    document.getElementById('trEditModalClose').addEventListener('click', trCloseEditModal);
    document.getElementById('trEditCancelBtn').addEventListener('click', trCloseEditModal);
    document.getElementById('trEditSaveBtn').addEventListener('click', trSaveEdit);
    document.getElementById('trEditModal').addEventListener('click', function(e) {
        if (e.target === this) trCloseEditModal();
    });

    // Edit modal auto-calc
    ['trEditQty', 'trEditPrice'].forEach(function(id) {
        document.getElementById(id).addEventListener('input', trRecalcGross);
    });
    ['trEditBrokerage', 'trEditStt', 'trEditOther', 'trEditGst', 'trEditTds'].forEach(function(id) {
        document.getElementById(id).addEventListener('input', trRecalcCharges);
    });

    // Close action menus on outside click
    document.addEventListener('click', function(e) {
        if (trOpenActionMenu && !e.target.closest('.action-cell')) {
            trCloseAllActionMenus();
        }
    });

    // ESC key closes modals
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
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

function trSwitchTab(tabId) {
    document.querySelectorAll('.trading-tab-btn').forEach(function(b) { b.classList.remove('active'); });
    document.querySelectorAll('.trading-tab-content').forEach(function(c) { c.classList.remove('active'); });

    var btn = document.querySelector('.trading-tab-btn[data-tab="' + tabId + '"]');
    var content = document.getElementById(tabId);
    if (btn) btn.classList.add('active');
    if (content) content.classList.add('active');

    localStorage.setItem('wms_trading_tab', tabId);
}

function trRestoreTab() {
    var saved = localStorage.getItem('wms_trading_tab');
    if (saved) trSwitchTab(saved);
}

// ============================================================================
// DATA LOADING
// ============================================================================

async function trLoadData() {
    // Load ALL transactions (no transaction_type filter — includes DIVIDEND, etc.)
    var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions?select=id,investor_id,broker_id,security_id,security_type,symbol,short_symbol,company_name,exchange,transaction_type,transaction_date,quantity,price,gross_amount,net_amount,brokerage,stt,other_charges,gst,tds,total_charges,margin_blocked,broker_contract_note_no,broker_trade_id,tags,notes,is_locked,ignore_for_avg_cost,dont_display&order=transaction_date.asc', {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
    });
    if (!resp.ok) throw new Error('Failed to load transactions: HTTP ' + resp.status);
    var txnData = await resp.json();
    console.log('Trading: Loaded ' + txnData.length + ' transactions (all types)');

    trTransactions = txnData;

    // Load investors
    var invResp = await fetch(SUPABASE_URL + '/rest/v1/investors?select=id,name,short_name&order=name', {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
    });
    trInvestors = invResp.ok ? await invResp.json() : [];

    // Load brokers
    var brkResp = await fetch(SUPABASE_URL + '/rest/v1/brokers?select=id,name,broker_code&order=name', {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
    });
    trBrokers = brkResp.ok ? await brkResp.json() : [];

    trInitFilterDropdowns();
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
    var brk = trBrkCode(txn.broker_id);
    return brk ? inv + ' > ' + brk : inv;
}

// ============================================================================
// LIVE PRICES FROM FYERS
// ============================================================================

function trGetFyersKey(h) {
    // Always use equity key: NSE:SYMBOL-EQ
    return 'NSE:' + (h.shortSymbol || h.symbol) + '-EQ';
}

function trGetPrice(h) {
    return trLivePrices[trGetFyersKey(h)] || h.latestPrice;
}

function trGetLiveData(h) {
    return trLiveData[trGetFyersKey(h)] || null;
}

async function trFetchLivePrices() {
    try {
        if (!window.fyersToken) {
            trUpdatePriceStatus('last-txn');
            return;
        }
        var holdings = trCalcHoldings();
        if (holdings.length === 0) return;

        var symbols = holdings.map(function(h) { return trGetFyersKey(h); });
        // Deduplicate
        symbols = symbols.filter(function(s, i) { return symbols.indexOf(s) === i; });

        trUpdatePriceStatus('loading');
        var data = await window.fyersCall({ action: 'quotes', symbols: symbols });

        if (data && data.d && data.d.length > 0) {
            data.d.forEach(function(item) {
                if (item.v && item.v.symbol) {
                    var key = item.v.symbol;
                    trLivePrices[key] = item.v.lp || 0;
                    trLiveData[key] = {
                        lp: item.v.lp || 0,
                        ch: item.v.ch || 0,
                        chp: item.v.chp || 0,
                        high: item.v.high_price || null,
                        low: item.v.low_price || null
                    };
                }
            });
            trUpdatePriceStatus('live');
        } else {
            trUpdatePriceStatus('last-txn');
        }
    } catch (err) {
        console.warn('Trading: Fyers price fetch failed:', err.message || err);
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

function trInitFilterDropdowns() {
    var invDd = document.getElementById('tr-investor-dropdown');
    if (invDd) {
        invDd.innerHTML = trInvestors.map(function(inv) {
            var label = inv.short_name || inv.name;
            return '<div class="filter-dropdown-item" data-id="' + inv.id + '">' + label + '</div>';
        }).join('');
        invDd.querySelectorAll('.filter-dropdown-item').forEach(function(item) {
            item.addEventListener('click', function() {
                trToggleFilter('investor', item.dataset.id, item.textContent.trim());
            });
        });
    }
    var brkDd = document.getElementById('tr-broker-dropdown');
    if (brkDd) {
        brkDd.innerHTML = trBrokers.map(function(b) {
            var label = b.broker_code || b.name;
            return '<div class="filter-dropdown-item" data-id="' + b.id + '">' + label + '</div>';
        }).join('');
        brkDd.querySelectorAll('.filter-dropdown-item').forEach(function(item) {
            item.addEventListener('click', function() {
                trToggleFilter('broker', item.dataset.id, item.textContent.trim());
            });
        });
    }
    // Tags
    var allTags = {};
    trTransactions.forEach(function(t) {
        if (t.tags) t.tags.forEach(function(tag) { if (tag !== 'blank') allTags[tag] = true; });
    });
    var tagDd = document.getElementById('tr-tag-dropdown');
    if (tagDd) {
        tagDd.innerHTML = Object.keys(allTags).sort().map(function(tag) {
            return '<div class="filter-dropdown-item" data-id="' + tag + '">' + tag + '</div>';
        }).join('');
        tagDd.querySelectorAll('.filter-dropdown-item').forEach(function(item) {
            item.addEventListener('click', function() {
                trToggleFilter('tag', item.dataset.id, item.textContent.trim());
            });
        });
    }
}

function trSetupFilters() {
    ['investor', 'broker', 'tag'].forEach(function(type) {
        var input = document.getElementById('tr-' + type + '-search');
        var dd = document.getElementById('tr-' + type + '-dropdown');
        if (!input || !dd) return;
        input.addEventListener('click', function() { dd.classList.add('show'); });
        input.addEventListener('input', function() {
            dd.classList.add('show');
            var query = input.value.toLowerCase();
            dd.querySelectorAll('.filter-dropdown-item').forEach(function(item) {
                item.style.display = item.textContent.toLowerCase().indexOf(query) >= 0 ? '' : 'none';
            });
        });
    });
    document.getElementById('tr-clear-investors').addEventListener('click', function() {
        trSelectedInvestorIds = [];
        trRenderSelectedFilters('investor');
        trRenderPortfolio();
    });
    document.getElementById('tr-clear-brokers').addEventListener('click', function() {
        trSelectedBrokerIds = [];
        trRenderSelectedFilters('broker');
        trRenderPortfolio();
    });
    document.getElementById('tr-clear-tags').addEventListener('click', function() {
        trSelectedTagNames = [];
        trRenderSelectedFilters('tag');
        trRenderPortfolio();
    });
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.filter-search-container')) {
            document.querySelectorAll('.filter-dropdown').forEach(function(dd) { dd.classList.remove('show'); });
        }
    });
}

function trToggleFilter(type, id, name) {
    var arr;
    if (type === 'investor') arr = trSelectedInvestorIds;
    else if (type === 'broker') arr = trSelectedBrokerIds;
    else arr = trSelectedTagNames;

    var idx = arr.indexOf(id);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(id);

    trRenderSelectedFilters(type);
    trRenderPortfolio();
}

function trRenderSelectedFilters(type) {
    var arr, container, labelFn;
    if (type === 'investor') {
        arr = trSelectedInvestorIds;
        container = document.getElementById('tr-selected-investors');
        labelFn = function(id) { var inv = trInvestors.find(function(i) { return i.id === id; }); return inv ? (inv.short_name || inv.name) : id; };
    } else if (type === 'broker') {
        arr = trSelectedBrokerIds;
        container = document.getElementById('tr-selected-brokers');
        labelFn = function(id) { var b = trBrokers.find(function(i) { return i.id === id; }); return b ? (b.broker_code || b.name) : id; };
    } else {
        arr = trSelectedTagNames;
        container = document.getElementById('tr-selected-tags');
        labelFn = function(id) { return id; };
    }
    if (!container) return;
    container.innerHTML = arr.map(function(id) {
        return '<span class="filter-tag-item">' + labelFn(id) +
            ' <span class="filter-tag-remove" data-type="' + type + '" data-id="' + id + '">×</span></span>';
    }).join('');
    container.querySelectorAll('.filter-tag-remove').forEach(function(btn) {
        btn.addEventListener('click', function() {
            trToggleFilter(btn.dataset.type, btn.dataset.id, '');
        });
    });
    var dd = document.getElementById('tr-' + type + '-dropdown');
    if (dd) {
        dd.querySelectorAll('.filter-dropdown-item').forEach(function(item) {
            item.classList.toggle('selected', arr.indexOf(item.dataset.id) >= 0);
        });
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

    // Group by short_symbol (underlying) — combines equity + F&O
    var holdings = {};
    filtered.forEach(function(txn) {
        var key = txn.short_symbol || txn.symbol;
        if (!key) return;

        if (!holdings[key]) {
            holdings[key] = {
                symbol: txn.symbol,
                shortSymbol: txn.short_symbol || txn.symbol,
                companyName: txn.company_name,
                exchange: txn.exchange || 'NSE',
                quantity: 0,
                totalCost: 0,
                tags: {},
                latestPrice: 0,
                latestDate: null
            };
        }

        // Prefer NSE exchange for Fyers lookup
        if ((txn.exchange || 'NSE') === 'NSE') {
            holdings[key].exchange = 'NSE';
        }
        // Use company_name from first equity txn if available
        if (txn.company_name && (!holdings[key].companyName || holdings[key].companyName === holdings[key].shortSymbol)) {
            holdings[key].companyName = txn.company_name;
        }

        var isIncome = INCOME_TYPES.indexOf(txn.transaction_type) >= 0;

        if (isIncome) {
            // Income transactions reduce cost basis, don't affect quantity
            if (!txn.ignore_for_avg_cost) {
                holdings[key].totalCost -= Math.abs(txn.net_amount || 0);
            }
        } else {
            // BUY/SELL: add quantity
            holdings[key].quantity += txn.quantity;
            // Add to cost only if not ignored
            if (!txn.ignore_for_avg_cost) {
                holdings[key].totalCost += txn.net_amount || 0;
            }
        }

        if (txn.tags) txn.tags.forEach(function(tag) { if (tag !== 'blank') holdings[key].tags[tag] = true; });
        var txnDate = new Date(txn.transaction_date);
        if (!isIncome && (!holdings[key].latestDate || txnDate > holdings[key].latestDate)) {
            holdings[key].latestDate = txnDate;
            holdings[key].latestPrice = txn.price;
        }
    });

    return Object.keys(holdings).map(function(key) {
        var h = holdings[key];
        if (!trShowZeroHoldings && h.quantity === 0) return null;
        return {
            key: key,
            symbol: h.symbol,
            shortSymbol: h.shortSymbol,
            companyName: h.companyName,
            exchange: h.exchange,
            quantity: h.quantity,
            totalCost: h.totalCost,
            avgCost: h.quantity !== 0
                ? (h.totalCost !== 0 ? h.totalCost / Math.abs(h.quantity) : h.latestPrice)
                : 0,
            tags: Object.keys(h.tags),
            latestPrice: h.latestPrice
        };
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

    if (holdings.length === 0) {
        list.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:#9ca3af;">No holdings to display</td></tr>';
        document.getElementById('tr-portfolio-summary').innerHTML = '';
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
                    '<div class="company-main" data-key="' + symbolKey + '">' + (h.companyName || h.shortSymbol) + '</div>' +
                    '<div class="company-sub">' + h.shortSymbol + '</div>' +
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
                    '<button class="btn-action" data-key="' + symbolKey + '" title="Actions">⚙️</button>' +
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
    var totalDayPL = Object.keys(trLiveData).length > 0
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
            '<td>-</td>' +
        '</tr>';

    list.innerHTML = totalRow + rows;
    trUpdateSortIndicators();
    trRenderSummaryCards(totalInvested, totalValue, totalPL, totalPLPct, holdings.length);
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
    var symbolTxns = trTransactions.filter(function(txn) {
        return !txn.dont_display && (txn.short_symbol || txn.symbol) === h.shortSymbol;
    });

    var groups = {};
    symbolTxns.forEach(function(txn) {
        if (!groups[txn.investor_id]) {
            groups[txn.investor_id] = {
                investorId: txn.investor_id,
                name: trInvName(txn.investor_id),
                quantity: 0,
                totalCost: 0,
                tags: {}
            };
        }
        var isIncome = INCOME_TYPES.indexOf(txn.transaction_type) >= 0;
        if (isIncome) {
            if (!txn.ignore_for_avg_cost) {
                groups[txn.investor_id].totalCost -= Math.abs(txn.net_amount || 0);
            }
        } else {
            groups[txn.investor_id].quantity += txn.quantity;
            if (!txn.ignore_for_avg_cost) {
                groups[txn.investor_id].totalCost += txn.net_amount || 0;
            }
        }
        if (txn.tags) txn.tags.forEach(function(tag) { if (tag !== 'blank') groups[txn.investor_id].tags[tag] = true; });
    });

    var investorRows = Object.values(groups)
        .filter(function(g) { return trShowZeroHoldings || g.quantity !== 0; })
        .map(function(g) {
            var avg = g.quantity !== 0 ? (g.totalCost !== 0 ? g.totalCost / Math.abs(g.quantity) : h.latestPrice) : 0;
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
                    '<button class="btn-action inv-action-btn" data-menu-id="' + invMenuId + '" title="Actions">⚙️</button>' +
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

function trRenderSummaryCards(invested, value, pl, plPct, stockCount) {
    var container = document.getElementById('tr-portfolio-summary');
    if (!container) return;
    container.innerHTML =
        '<div class="summary-card"><div class="summary-label">Total Invested</div><div class="summary-value">' + formatAmount(invested) + '</div></div>' +
        '<div class="summary-card ' + getAmountClass(pl) + '"><div class="summary-label">Total P&L</div><div class="summary-value">' + formatAmount(pl) + '</div><div class="number-sub">' + formatPercent(plPct) + '</div></div>' +
        '<div class="summary-card"><div class="summary-label">Current Value</div><div class="summary-value">' + formatAmount(value) + '</div></div>' +
        '<div class="summary-card"><div class="summary-label">Holdings</div><div class="summary-value">' + stockCount + ' stocks</div></div>';
}

// ============================================================================
// TRANSACTIONS MODAL
// ============================================================================

function trOpenTxnModal(companyKey, investorId) {
    trCurrentTxnModalKey = companyKey;
    trCurrentTxnInvestorId = investorId || null;
    trTxnHiddenIds = {};
    trShowHiddenTrades = false;

    var shortSymbol = companyKey;

    // Get all transactions for this company (including hidden + ignored + income)
    var txns = trTransactions.filter(function(t) {
        return (t.short_symbol || t.symbol) === shortSymbol;
    });

    // Optional investor filter
    if (investorId) {
        txns = txns.filter(function(t) { return t.investor_id === investorId; });
    }

    var companyName = '';
    for (var i = 0; i < txns.length; i++) {
        if (txns[i].company_name) { companyName = txns[i].company_name; break; }
    }
    companyName = companyName || shortSymbol;

    // Title
    var titleExtra = '';
    if (investorId) {
        titleExtra = ' <span style="font-size:11px;color:#667eea;">(' + trInvName(investorId) + ')</span>';
    }
    document.getElementById('trTxnModalTitle').innerHTML = companyName +
        '<span class="company-sub">' + shortSymbol + '</span>' + titleExtra;

    // Reset sort
    trTxnSortColumn = 'date';
    trTxnSortDirection = 'asc';

    // Update toggle button
    var toggleBtn = document.getElementById('trToggleHiddenBtn');
    toggleBtn.classList.remove('active');
    toggleBtn.textContent = '👁 Show All';

    // Render
    trRenderTxnTable(txns);

    // Show modal
    document.getElementById('trTxnModal').classList.add('show');
}

function trGetTxnModalTxns() {
    var shortSymbol = trCurrentTxnModalKey;
    var txns = trTransactions.filter(function(t) {
        return (t.short_symbol || t.symbol) === shortSymbol;
    });
    if (trCurrentTxnInvestorId) {
        txns = txns.filter(function(t) { return t.investor_id === trCurrentTxnInvestorId; });
    }
    return txns;
}

function trRenderTxnTable(txns) {
    if (!txns) txns = trGetTxnModalTxns();

    // Calculate running qty (always chronological, excluding income & temp-hidden)
    var chronoTxns = txns.slice().sort(function(a, b) {
        return new Date(a.transaction_date) - new Date(b.transaction_date);
    });
    var runningQtyMap = {};
    var runSum = 0;
    chronoTxns.forEach(function(t) {
        var isIncome = INCOME_TYPES.indexOf(t.transaction_type) >= 0;
        if (!isIncome && !trTxnHiddenIds[t.id]) {
            runSum += (t.quantity || 0);
        }
        runningQtyMap[t.id] = runSum;
    });

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

            var hideIcon = isTempHidden ? '🙈' : '👁';
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
                    '<button class="btn-action txn-action-btn" data-txn-id="' + txn.id + '" title="Actions">⚙️</button>' +
                    '<div class="action-menu" id="' + menuId + '">' +
                        '<button class="action-menu-item" data-txn-action="edit" data-txn-id="' + txn.id + '">✏️ Edit</button>' +
                        '<button class="action-menu-item" data-txn-action="toggle-display" data-txn-id="' + txn.id + '">' +
                            (txn.dont_display ? '👁 Show in Display' : '🙈 Hide from Display') + '</button>' +
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

    // Show/hide the Show All button based on whether any trades are temp-hidden
    var hiddenCount = Object.keys(trTxnHiddenIds).length;
    var toggleBtn = document.getElementById('trToggleHiddenBtn');
    toggleBtn.style.display = hiddenCount > 0 ? '' : 'none';

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
    btn.textContent = trShowHiddenTrades ? '🙈 Hide Filtered' : '👁 Show All';
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

    // Calculate summary (always exclude temp-hidden, exclude ignore_for_avg_cost)
    var netQty = 0, totalCost = 0;
    txns.forEach(function(t) {
        if (trTxnHiddenIds[t.id]) return;
        if (t.ignore_for_avg_cost) return;

        var isIncome = INCOME_TYPES.indexOf(t.transaction_type) >= 0;
        if (isIncome) {
            totalCost -= Math.abs(t.net_amount || 0);
        } else {
            netQty += t.quantity || 0;
            totalCost += t.net_amount || t.gross_amount || 0;
        }
    });

    var avgCost = netQty !== 0 ? totalCost / Math.abs(netQty) : 0;

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
        if (trCurrentTxnModalKey) trRenderTxnTable();
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
        if (trCurrentTxnModalKey) trRenderTxnTable();
        trRenderPortfolio();
    } else {
        showAlert('Failed to delete: HTTP ' + resp.status, 'error');
    }
}

// ============================================================================
// EDIT MODAL
// ============================================================================

function trOpenEditModal(txnId) {
    var txn = trTransactions.find(function(t) { return t.id === txnId; });
    if (!txn) return;
    trEditingTxnId = txnId;

    document.getElementById('trEditInvestor').value = trInvName(txn.investor_id);
    document.getElementById('trEditBroker').value = trBrkCode(txn.broker_id) || '-';
    document.getElementById('trEditDate').value = txn.transaction_date || '';
    document.getElementById('trEditType').value = txn.transaction_type || 'BUY';
    document.getElementById('trEditSymbol').value = txn.symbol || '';
    document.getElementById('trEditExchange').value = txn.exchange || '';
    document.getElementById('trEditQty').value = Math.abs(txn.quantity) || '';
    document.getElementById('trEditPrice').value = txn.price || '';
    document.getElementById('trEditGross').value = txn.gross_amount || '';
    document.getElementById('trEditBrokerage').value = txn.brokerage || 0;
    document.getElementById('trEditStt').value = txn.stt || 0;
    document.getElementById('trEditOther').value = txn.other_charges || 0;
    document.getElementById('trEditGst').value = txn.gst || 0;
    document.getElementById('trEditTds').value = txn.tds || 0;
    document.getElementById('trEditTotalCharges').value = txn.total_charges || 0;
    document.getElementById('trEditNetAmount').value = txn.net_amount || '';
    document.getElementById('trEditMargin').value = txn.margin_blocked || 0;
    document.getElementById('trEditTags').value = (txn.tags || []).filter(function(t) { return t !== 'blank'; }).join(', ');
    document.getElementById('trEditNotes').value = txn.notes || '';
    document.getElementById('trEditLocked').checked = !!txn.is_locked;
    document.getElementById('trEditIgnoreAvg').checked = !!txn.ignore_for_avg_cost;
    document.getElementById('trEditDontDisplay').checked = !!txn.dont_display;

    // Lock warning
    var lockWarn = document.getElementById('trEditLockWarning');
    lockWarn.style.display = txn.is_locked ? '' : 'none';

    // Disable fields if locked
    var fields = document.querySelectorAll('#trEditForm input:not(#trEditLocked):not(#trEditInvestor):not(#trEditBroker), #trEditForm select, #trEditForm textarea');
    fields.forEach(function(f) { f.disabled = !!txn.is_locked; });

    document.getElementById('trEditModal').classList.add('show');
}

function trCloseEditModal() {
    document.getElementById('trEditModal').classList.remove('show');
    trEditingTxnId = null;
}

function trRecalcGross() {
    var qty = parseFloat(document.getElementById('trEditQty').value) || 0;
    var price = parseFloat(document.getElementById('trEditPrice').value) || 0;
    document.getElementById('trEditGross').value = (qty * price).toFixed(2);
    trRecalcCharges();
}

function trRecalcCharges() {
    var brokerage = parseFloat(document.getElementById('trEditBrokerage').value) || 0;
    var stt = parseFloat(document.getElementById('trEditStt').value) || 0;
    var other = parseFloat(document.getElementById('trEditOther').value) || 0;
    var gst = parseFloat(document.getElementById('trEditGst').value) || 0;
    var tds = parseFloat(document.getElementById('trEditTds').value) || 0;
    var totalCharges = brokerage + stt + other + gst + tds;
    document.getElementById('trEditTotalCharges').value = totalCharges.toFixed(2);

    var gross = parseFloat(document.getElementById('trEditGross').value) || 0;
    var type = document.getElementById('trEditType').value;
    var net = type === 'BUY' ? gross + totalCharges : gross - totalCharges;
    document.getElementById('trEditNetAmount').value = net.toFixed(2);
}

async function trSaveEdit() {
    if (!trEditingTxnId) return;

    var txn = trTransactions.find(function(t) { return t.id === trEditingTxnId; });
    if (!txn) return;

    var isLocked = document.getElementById('trEditLocked').checked;
    if (txn.is_locked && isLocked) {
        showAlert('Transaction is locked. Uncheck the lock to save changes.', 'error');
        return;
    }

    var qty = parseInt(document.getElementById('trEditQty').value) || 0;
    var type = document.getElementById('trEditType').value;
    var signedQty = type === 'SELL' ? -Math.abs(qty) : Math.abs(qty);

    var tagsRaw = document.getElementById('trEditTags').value.trim();
    var tags = tagsRaw ? tagsRaw.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; }) : ['blank'];

    var body = {
        transaction_date: document.getElementById('trEditDate').value,
        transaction_type: type,
        symbol: document.getElementById('trEditSymbol').value,
        exchange: document.getElementById('trEditExchange').value,
        quantity: signedQty,
        price: parseFloat(document.getElementById('trEditPrice').value) || 0,
        gross_amount: parseFloat(document.getElementById('trEditGross').value) || 0,
        brokerage: parseFloat(document.getElementById('trEditBrokerage').value) || 0,
        stt: parseFloat(document.getElementById('trEditStt').value) || 0,
        other_charges: parseFloat(document.getElementById('trEditOther').value) || 0,
        gst: parseFloat(document.getElementById('trEditGst').value) || 0,
        tds: parseFloat(document.getElementById('trEditTds').value) || 0,
        total_charges: parseFloat(document.getElementById('trEditTotalCharges').value) || 0,
        net_amount: parseFloat(document.getElementById('trEditNetAmount').value) || 0,
        margin_blocked: parseFloat(document.getElementById('trEditMargin').value) || 0,
        tags: tags,
        notes: document.getElementById('trEditNotes').value || null,
        is_locked: isLocked,
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
        if (trCurrentTxnModalKey) trRenderTxnTable();
        trRenderPortfolio();
    } else {
        var errText = await resp.text();
        showAlert('Failed to save: ' + errText, 'error');
    }
}

// ============================================================================
// WINDOW EXPORTS
// ============================================================================

window.initTrading = initTrading;
