// ============================================================================
// WMS PORTFOLIO MODULE
// ============================================================================

// Global state
let transactions = [];
let investors = [];
let brokers = [];
let selectedInvestorIds = [];
let selectedBrokerIds = [];
let selectedTagNames = [];
let tagFilterLogic = 'OR'; // 'OR' or 'AND'
let portfolioSortColumn = 'symbol';
let portfolioSortDirection = 'asc';
let portfolioSortByPct = false;  // for pl/daypl cols: false=sort by amount, true=sort by %
let expandedSymbol = null;
let showZeroHoldings = false; // hidden by default

function toggleZeroHoldings() {
    showZeroHoldings = !showZeroHoldings;
    const btn = document.getElementById('toggleZeroBtn');
    if (btn) {
        btn.textContent = showZeroHoldings ? '👁 Hide Zero Holdings' : '👁 Show Zero Holdings';
        btn.classList.toggle('active', showZeroHoldings);
    }
    renderPortfolio();
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initPortfolio() {
    showLoading(true);
    try {
        await loadPortfolioData();
    } catch (error) {
        console.error('❌ Error loading portfolio data:', error);
        showAlert('Failed to load portfolio data: ' + error.message, 'error');
        showLoading(false);
        return; // DB failed — nothing to render
    }

    // Fyers prices — best effort, never blocks render
    await fetchLivePrices();

    updateUnitLabels();
    renderPortfolio();
    showLoading(false);
}

// ============================================================================
// UPDATE UNIT LABELS
// ============================================================================

function updateUnitLabels() {
    const desc = getUnitDescription();
    const el = document.getElementById('portfolio-unit-desc');
    if (el) el.textContent = `all amounts in ${desc}`;
}

// ============================================================================
// DATA LOADING
// ============================================================================

async function loadPortfolioData() {
    console.log('Loading transactions...');
    
    // Load transactions
    const { data: txnData, error: txnError } = await supabaseClient
        .from('transactions')
        .select(`
            id,
            investor_id,
            broker_id,
            symbol,
            short_symbol,
            company_name,
            exchange,
            transaction_type,
            transaction_date,
            quantity,
            price,
            gross_amount,
            net_amount,
            tags,
            dont_display
        `)
        .eq('dont_display', false)
        .in('transaction_type', ['BUY', 'SELL'])
        .order('transaction_date', { ascending: true });

    if (txnError) {
        console.error('❌ Error loading transactions:', txnError);
        throw txnError;
    }
    
    console.log(`✅ Loaded ${txnData?.length || 0} transactions`);

    console.log('Loading investors...');
    
    // Load investors
    const { data: invData, error: invError } = await supabaseClient
        .from('investors')
        .select('id, name')
        .order('name');

    if (invError) {
        console.error('❌ Error loading investors:', invError);
        throw invError;
    }
    
    console.log(`✅ Loaded ${invData?.length || 0} investors`);

    console.log('Loading brokers...');
    
    // Load brokers
    const { data: brkData, error: brkError } = await supabaseClient
        .from('brokers')
        .select('id, name')
        .order('name');

    if (brkError) {
        console.error('❌ Error loading brokers:', brkError);
        throw brkError;
    }
    
    console.log(`✅ Loaded ${brkData?.length || 0} brokers`);

    // Transform transactions
    transactions = txnData.map(txn => ({
        id: txn.id,
        investorId: txn.investor_id,
        brokerId: txn.broker_id,
        symbol: txn.symbol,
        shortSymbol: txn.short_symbol,
        companyName: txn.company_name,
        exchange: txn.exchange,
        type: txn.transaction_type,
        date: txn.transaction_date,
        quantity: txn.quantity,
        price: txn.price,
        grossAmount: txn.gross_amount,
        netAmount: txn.net_amount,
        tags: txn.tags || []
    }));

    investors = invData;
    brokers = brkData;

    // Initialize filter dropdowns
    initializeFilterDropdowns();
}

async function refreshPortfolio() {
    showLoading(true);
    try {
        await loadPortfolioData();
    } catch (error) {
        showAlert('Failed to refresh data: ' + error.message, 'error');
        showLoading(false);
        return;
    }
    await fetchLivePrices(); // best effort
    renderPortfolio();
    showLoading(false);
    showAlert('Portfolio refreshed', 'success', 2000);
}

// ============================================================================
// LIVE PRICES FROM FYERS
// ============================================================================

// Cache: { 'NSE:RELIANCE-EQ': { lp, ch, chp, high, low } }
let livePrices = {};
let liveData = {}; // full market data per fyers symbol key

function getLiveData(holding) {
    const exch = (holding.exchange || 'NSE').toUpperCase();
    const fyersKey = exch === 'NFO'
        ? `NSE:${holding.symbol}`
        : `${exch}:${holding.shortSymbol || holding.symbol}-EQ`;
    return liveData[fyersKey] || null;
}

async function fetchLivePrices() {
    // Always resolves — never throws — so initPortfolio always continues to render
    try {
        if (!window.fyersToken) {
            updatePriceStatus('last-txn');
            return;
        }

        const holdings = calculateHoldings();
        if (holdings.length === 0) return;

        const fyersSymbols = holdings.map(h => {
            const exch = (h.exchange || 'NSE').toUpperCase();
            return exch === 'NFO'
                ? `NSE:${h.symbol}`
                : `${exch}:${h.shortSymbol || h.symbol}-EQ`;
        });

        updatePriceStatus('loading');

        const data = await window.fyersCall({ action: 'quotes', symbols: fyersSymbols });

        if (data && data.d && data.d.length > 0) {
            data.d.forEach(item => {
                if (item.v && item.v.symbol) {
                    const key = item.v.symbol;
                    livePrices[key] = item.v.lp || 0;
                    liveData[key] = {
                        lp:   item.v.lp            || 0,
                        ch:   item.v.ch            || 0,
                        chp:  item.v.chp           || 0,
                        high: item.v.high_price    || null,
                        low:  item.v.low_price     || null,
                    };
                }
            });
            updatePriceStatus('live');
        } else {
            updatePriceStatus('last-txn');
        }
    } catch (err) {
        // Any failure — silently fall back to last transaction prices, never block render
        console.warn('⚠️ Fyers price fetch failed, using last transaction prices:', err.message || err);
        updatePriceStatus('last-txn');
    }
}

function updatePriceStatus(status) {
    const el = document.getElementById('price-status');
    if (!el) return;
    const now = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    if (status === 'live') {
        el.innerHTML = `🟢 Live prices as of ${now}`;
        el.style.color = '#059669';
    } else if (status === 'loading') {
        el.innerHTML = `⏳ Fetching live prices...`;
        el.style.color = '#667eea';
    } else if (status === 'last-txn') {
        el.innerHTML = `🟡 Showing last transaction prices`;
        el.style.color = '#d97706';
    } else if (status === 'error') {
        el.innerHTML = `🔴 Price fetch failed - showing last transaction prices`;
        el.style.color = '#dc2626';
    }
}

// Resolve price for a holding: live price if available, else last transaction price
function getPrice(holding) {
    const exch = (holding.exchange || 'NSE').toUpperCase();
    const fyersKey = exch === 'NFO'
        ? `NSE:${holding.symbol}`                           // F&O: NSE:NATIONALUM26FEBFUT
        : `${exch}:${holding.shortSymbol || holding.symbol}-EQ`; // Equity: NSE:RELIANCE-EQ
    return livePrices[fyersKey] || holding.latestPrice;
}

// ============================================================================
// FILTER DROPDOWNS
// ============================================================================

function initializeFilterDropdowns() {
    // Populate investor dropdown
    const investorDropdown = document.getElementById('investor-dropdown');
    if (investorDropdown) {
        investorDropdown.innerHTML = investors
            .map(inv => `
                <div class="filter-dropdown-item" 
                     data-id="${inv.id}" 
                     onclick="toggleInvestorFilter('${inv.id}', '${inv.name}')">
                    ${inv.name}
                </div>
            `).join('');
    }

    // Populate broker dropdown
    const brokerDropdown = document.getElementById('broker-dropdown');
    if (brokerDropdown) {
        brokerDropdown.innerHTML = brokers
            .map(brk => `
                <div class="filter-dropdown-item" 
                     data-id="${brk.id}" 
                     onclick="toggleBrokerFilter('${brk.id}', '${brk.name}')">
                    ${brk.name}
                </div>
            `).join('');
    }

    // Populate tag dropdown with unique tags from transactions
    const allTags = new Set();
    transactions.forEach(txn => {
        if (txn.tags) {
            txn.tags.forEach(tag => allTags.add(tag));
        }
    });

    const tagDropdown = document.getElementById('tag-dropdown');
    if (tagDropdown) {
        tagDropdown.innerHTML = Array.from(allTags).sort()
            .map(tag => `
                <div class="filter-dropdown-item" 
                     data-tag="${tag}" 
                     onclick="toggleTagFilter('${tag}')">
                    ${tag}
                </div>
            `).join('');
    }
}

// ============================================================================
// INVESTOR FILTER
// ============================================================================

function showInvestorDropdown() {
    document.getElementById('investor-dropdown').classList.add('show');
    // Hide others
    document.getElementById('broker-dropdown').classList.remove('show');
    document.getElementById('tag-dropdown').classList.remove('show');
}

function filterInvestorSearch() {
    const search = document.getElementById('investor-search-input').value.toLowerCase();
    const items = document.querySelectorAll('#investor-dropdown .filter-dropdown-item');
    
    items.forEach(item => {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(search) ? 'block' : 'none';
    });
}

function toggleInvestorFilter(id, name) {
    const index = selectedInvestorIds.indexOf(id);
    if (index > -1) {
        selectedInvestorIds.splice(index, 1);
    } else {
        selectedInvestorIds.push(id);
    }
    
    updateSelectedInvestors();
    renderPortfolio();
}

function updateSelectedInvestors() {
    const container = document.getElementById('selected-investors');
    container.innerHTML = selectedInvestorIds
        .map(id => {
            const investor = investors.find(i => i.id === id);
            return `
                <div class="filter-tag-item">
                    ${investor.name}
                    <span class="filter-tag-remove" onclick="toggleInvestorFilter('${id}', '${investor.name}')">×</span>
                </div>
            `;
        }).join('');
}

function clearInvestorFilters() {
    selectedInvestorIds = [];
    updateSelectedInvestors();
    renderPortfolio();
}

// ============================================================================
// BROKER FILTER (NEW)
// ============================================================================

function showBrokerDropdown() {
    document.getElementById('broker-dropdown').classList.add('show');
    // Hide others
    document.getElementById('investor-dropdown').classList.remove('show');
    document.getElementById('tag-dropdown').classList.remove('show');
}

function filterBrokerSearch() {
    const search = document.getElementById('broker-search-input').value.toLowerCase();
    const items = document.querySelectorAll('#broker-dropdown .filter-dropdown-item');
    
    items.forEach(item => {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(search) ? 'block' : 'none';
    });
}

function toggleBrokerFilter(id, name) {
    const index = selectedBrokerIds.indexOf(id);
    if (index > -1) {
        selectedBrokerIds.splice(index, 1);
    } else {
        selectedBrokerIds.push(id);
    }
    
    updateSelectedBrokers();
    renderPortfolio();
}

function updateSelectedBrokers() {
    const container = document.getElementById('selected-brokers');
    container.innerHTML = selectedBrokerIds
        .map(id => {
            const broker = brokers.find(b => b.id === id);
            return `
                <div class="filter-tag-item">
                    ${broker.name}
                    <span class="filter-tag-remove" onclick="toggleBrokerFilter('${id}', '${broker.name}')">×</span>
                </div>
            `;
        }).join('');
}

function clearBrokerFilters() {
    selectedBrokerIds = [];
    updateSelectedBrokers();
    renderPortfolio();
}

// ============================================================================
// TAG FILTER
// ============================================================================

function showTagDropdown() {
    document.getElementById('tag-dropdown').classList.add('show');
    // Hide others
    document.getElementById('investor-dropdown').classList.remove('show');
    document.getElementById('broker-dropdown').classList.remove('show');
}

function filterTagSearch() {
    const search = document.getElementById('tag-search-input').value.toLowerCase();
    const items = document.querySelectorAll('#tag-dropdown .filter-dropdown-item');
    
    items.forEach(item => {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(search) ? 'block' : 'none';
    });
}

function toggleTagFilter(tag) {
    const index = selectedTagNames.indexOf(tag);
    if (index > -1) {
        selectedTagNames.splice(index, 1);
    } else {
        selectedTagNames.push(tag);
    }
    
    updateSelectedTags();
    renderPortfolio();
}

function updateSelectedTags() {
    const container = document.getElementById('selected-tags');
    container.innerHTML = selectedTagNames
        .map(tag => `
            <div class="filter-tag-item">
                ${tag}
                <span class="filter-tag-remove" onclick="toggleTagFilter('${tag}')">×</span>
            </div>
        `).join('');
}

function clearTagFilters() {
    selectedTagNames = [];
    updateSelectedTags();
    renderPortfolio();
}

function updateTagLogic() {
    const selectedLogic = document.querySelector('input[name="tag-logic"]:checked').value;
    tagFilterLogic = selectedLogic;
    renderPortfolio();
}

// ============================================================================
// HOLDINGS CALCULATION
// ============================================================================

function calculateHoldings() {
    const holdings = {};
    
    // Filter transactions
    let filteredTransactions = transactions;
    
    // Filter by investor
    if (selectedInvestorIds.length > 0) {
        filteredTransactions = filteredTransactions.filter(txn => 
            selectedInvestorIds.includes(txn.investorId)
        );
    }
    
    // Filter by broker
    if (selectedBrokerIds.length > 0) {
        filteredTransactions = filteredTransactions.filter(txn => 
            txn.brokerId && selectedBrokerIds.includes(txn.brokerId)
        );
    }
    
    // Filter by tags
    if (selectedTagNames.length > 0) {
        if (tagFilterLogic === 'AND') {
            // Must have ALL selected tags
            filteredTransactions = filteredTransactions.filter(txn => 
                selectedTagNames.every(tag => txn.tags.includes(tag))
            );
        } else {
            // Must have ANY selected tag
            filteredTransactions = filteredTransactions.filter(txn => 
                txn.tags.some(tag => selectedTagNames.includes(tag))
            );
        }
    }
    
    // Calculate holdings
    filteredTransactions.forEach(txn => {
        const key = `${txn.symbol}-${txn.exchange}`;
        
        if (!holdings[key]) {
            holdings[key] = {
                symbol: txn.symbol,
                shortSymbol: txn.shortSymbol,
                companyName: txn.companyName,
                exchange: txn.exchange,
                quantity: 0,
                totalCost: 0,
                tags: new Set(),
                latestPrice: 0,
                latestDate: null
            };
        }
        
        holdings[key].quantity += txn.quantity;
        holdings[key].totalCost += txn.netAmount;
        
        if (txn.tags) {
            txn.tags.forEach(tag => holdings[key].tags.add(tag));
        }
        
        // Track latest transaction price
        const txnDate = new Date(txn.date);
        if (!holdings[key].latestDate || txnDate > holdings[key].latestDate) {
            holdings[key].latestDate = txnDate;
            holdings[key].latestPrice = txn.price;
        }
    });
    
    // Filter: always show non-zero qty (including negatives = shorts). Hide qty===0 unless toggle on.
    return Object.values(holdings)
        .filter(h => showZeroHoldings ? true : h.quantity !== 0)
        .map(h => ({
            ...h,
            // For short/expired positions where totalCost=0 (SELL net_amount was NULL in DB),
            // fall back to latestPrice so avgCost isn't shown as 0
            avgCost: h.quantity !== 0
                ? (h.totalCost !== 0 ? h.totalCost / h.quantity : h.latestPrice)
                : 0,
            tags: Array.from(h.tags)
        }));
}

// ============================================================================
// SORTING
// ============================================================================

function sortPortfolio(column) {
    var isPLCol = (column === 'pl' || column === 'daypl');
    if (portfolioSortColumn === column) {
        if (isPLCol && !portfolioSortByPct) {
            // amount asc → pct asc (same direction, switch to %)
            portfolioSortByPct = true;
        } else if (isPLCol && portfolioSortByPct) {
            // pct asc → amount desc (flip direction, back to amount)
            portfolioSortByPct = false;
            portfolioSortDirection = portfolioSortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            // non-P&L column — just flip direction
            portfolioSortDirection = portfolioSortDirection === 'asc' ? 'desc' : 'asc';
        }
    } else {
        portfolioSortColumn = column;
        portfolioSortDirection = 'asc';
        portfolioSortByPct = false;
    }
    renderPortfolio();
}

// ============================================================================
// EXPAND/COLLAPSE
// ============================================================================

function toggleSymbolDetail(symbol, exchange) {
    const key = `${symbol}-${exchange}`;
    if (expandedSymbol === key) {
        expandedSymbol = null;
    } else {
        expandedSymbol = key;
    }
    renderPortfolio();
}

// ============================================================================
// SLIDER HELPER
// ============================================================================

function buildSlider(current, low, high, lo, hi) {
    if (!low || !high || high <= low) return '';
    const pct      = Math.min(100, Math.max(0, ((current - low) / (high - low)) * 100));
    const dotColor = pct >= 50 ? '#059669' : '#dc2626';
    return '<div class="price-slider">' +
               '<div class="price-slider-track">' +
                   '<div class="price-slider-dot" style="left:' + pct.toFixed(1) + '%;background:' + dotColor + ';"></div>' +
               '</div>' +
               '<div class="slider-tooltip">' +
                   '<span>' + lo + '</span>' +
                   '<span>' + hi + '</span>' +
               '</div>' +
           '</div>';
}

// ============================================================================
// RENDERING
// ============================================================================

function renderPortfolio() {
    const list = document.getElementById('portfolio-list');

    let holdings = calculateHoldings();

    if (holdings.length === 0) {
        list.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#9ca3af;">No holdings to display</td></tr>';
        document.getElementById('portfolio-summary').innerHTML = '';
        updateSortIndicators();
        return;
    }

    // Totals
    let totalInvested = 0;
    let totalValue = 0;
    holdings.forEach(h => {
        totalInvested += h.quantity * h.avgCost;
        totalValue    += h.quantity * getPrice(h);
    });
    const totalPL        = totalValue - totalInvested;
    const totalPLPercent = totalInvested !== 0 ? (totalPL / Math.abs(totalInvested)) * 100 : 0;

    // Sort
    holdings.sort((a, b) => {
        let valA, valB;
        const priceA = getPrice(a), priceB = getPrice(b);
        const mdA = getLiveData(a), mdB = getLiveData(b);
        switch (portfolioSortColumn) {
            case 'symbol':
                valA = a.symbol; valB = b.symbol; break;
            case 'invested':
                valA = a.quantity * a.avgCost; valB = b.quantity * b.avgCost; break;
            case 'pl':
                if (portfolioSortByPct) {
                    var invA = a.quantity * a.avgCost, invB = b.quantity * b.avgCost;
                    valA = invA !== 0 ? ((a.quantity * priceA - invA) / Math.abs(invA)) * 100 : 0;
                    valB = invB !== 0 ? ((b.quantity * priceB - invB) / Math.abs(invB)) * 100 : 0;
                } else {
                    valA = (a.quantity * priceA) - (a.quantity * a.avgCost);
                    valB = (b.quantity * priceB) - (b.quantity * b.avgCost);
                }
                break;
            case 'daypl':
                if (portfolioSortByPct) {
                    valA = mdA ? mdA.chp : 0;
                    valB = mdB ? mdB.chp : 0;
                } else {
                    valA = mdA ? a.quantity * mdA.ch : 0;
                    valB = mdB ? b.quantity * mdB.ch : 0;
                }
                break;
            case 'value':
                valA = a.quantity * priceA; valB = b.quantity * priceB; break;
            default:
                valA = a.symbol; valB = b.symbol;
        }
        if (typeof valA === 'string') {
            return portfolioSortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        return portfolioSortDirection === 'asc' ? valA - valB : valB - valA;
    });

    // Render rows
    const rows = holdings.map(function(h) {
        const price        = getPrice(h);
        const md           = getLiveData(h);
        const invested     = h.quantity * h.avgCost;
        const currentValue = h.quantity * price;
        const pl           = currentValue - invested;
        const plPercent    = invested !== 0 ? (pl / Math.abs(invested)) * 100 : 0;
        const invPct       = totalInvested !== 0 ? (invested / totalInvested) * 100 : 0;
        const valPct       = totalValue    !== 0 ? (currentValue / totalValue) * 100 : 0;
        const dayPL        = md ? h.quantity * md.ch : null;
        const dayChp       = md ? md.chp : null;  // % change for the day

        // CMP slider — day range (52w not available from Fyers Quotes API)
        const cmpSlider = (md && md.high && md.low)
            ? buildSlider(md.lp, md.low, md.high,
                formatPrice(md.low, false),
                formatPrice(md.high, false))
            : '';

        const qtyHtml = h.quantity < 0
            ? '<div class="number-main negative">(' + formatQuantity(Math.abs(h.quantity)) + ')</div>'
            : '<div class="number-main">' + formatQuantity(h.quantity) + '</div>';

        const symbolKey  = h.symbol + '-' + h.exchange;
        const isExpanded = expandedSymbol === symbolKey;
        const expClass   = isExpanded ? 'expanded-row' : '';

        const dayPLHtml = dayPL !== null
            ? '<div class="number-main ' + getAmountClass(dayPL) + '">' + formatAmount(dayPL) + '</div>' +
              '<div class="number-sub ' + getAmountClass(dayChp) + '">' + formatPercent(dayChp) + '</div>'
            : '<div class="number-main">-</div>';

        const mainRow =
            '<tr class="' + expClass + '">' +
                '<td class="symbol-cell">' +
                    '<div class="symbol-main symbol-clickable" onclick="toggleSymbolDetail(\'' + h.symbol + '\',\'' + h.exchange + '\')">' + h.symbol + '</div>' +
                    '<div class="symbol-sub">' + (h.companyName || '') + '</div>' +
                '</td>' +
                '<td class="text-right">' +
                    qtyHtml +
                    '<div class="number-sub">' + formatPrice(h.avgCost, false) + '</div>' +
                '</td>' +
                '<td class="text-right">' +
                    '<div class="number-main">' + formatAmount(invested) + '</div>' +
                    '<div class="number-sub">' + invPct.toFixed(2) + '%</div>' +
                '</td>' +
                '<td class="text-right">' +
                    '<div class="number-main">' + formatPrice(price, false) + '</div>' +
                    cmpSlider +
                '</td>' +
                '<td class="text-right">' + dayPLHtml + '</td>' +
                '<td class="text-right">' +
                    '<div class="number-main ' + getAmountClass(pl) + '">' + formatAmount(pl) + '</div>' +
                    '<div class="number-sub ' + getAmountClass(plPercent) + '">' + formatPercent(plPercent) + '</div>' +
                '</td>' +
                '<td class="text-right">' +
                    '<div class="number-main">' + formatAmount(currentValue) + '</div>' +
                    '<div class="number-sub">' + valPct.toFixed(2) + '%</div>' +
                '</td>' +
                '<td>' + h.tags.map(function(t) { return '<span class="tag-badge">' + t + '</span>'; }).join('') + '</td>' +
            '</tr>';

        // Detail row (expanded) — 8 cols, no sliders
        var detailRow = '';
        if (isExpanded) {
            var symbolTxns = transactions.filter(function(txn) {
                return txn.symbol === h.symbol && txn.exchange === h.exchange;
            });

            var investorGroups = {};
            symbolTxns.forEach(function(txn) {
                if (!investorGroups[txn.investorId]) {
                    var investor = investors.find(function(inv) { return inv.id === txn.investorId; });
                    investorGroups[txn.investorId] = {
                        name: investor ? investor.name : 'Unknown',
                        quantity: 0, totalCost: 0, tags: new Set()
                    };
                }
                investorGroups[txn.investorId].quantity  += txn.quantity;
                investorGroups[txn.investorId].totalCost += txn.netAmount;
                if (txn.tags) txn.tags.forEach(function(tag) { investorGroups[txn.investorId].tags.add(tag); });
            });

            var investorRows = Object.values(investorGroups)
                .filter(function(inv) { return inv.quantity !== 0; })
                .map(function(inv) {
                    var invAvgCost  = inv.quantity !== 0 ? (inv.totalCost !== 0 ? inv.totalCost / inv.quantity : h.latestPrice) : 0;
                    var invDayPL    = md ? inv.quantity * md.ch : null;
                    var invDayChp   = md ? md.chp : null;
                    var invValue    = inv.quantity * price;
                    var invInvested = inv.quantity * invAvgCost;
                    var invPL       = invValue - invInvested;
                    var invPLPct    = invInvested !== 0 ? (invPL / Math.abs(invInvested)) * 100 : 0;
                    var invInvPct   = invested !== 0 ? (invInvested / invested) * 100 : 0;
                    var invValPct   = currentValue !== 0 ? (invValue / currentValue) * 100 : 0;

                    var invQtyHtml = inv.quantity < 0
                        ? '<div class="number-main negative">(' + formatQuantity(Math.abs(inv.quantity)) + ')</div>'
                        : '<div class="number-main">' + formatQuantity(inv.quantity) + '</div>';

                    var invDayPLHtml = invDayPL !== null
                        ? '<div class="number-main ' + getAmountClass(invDayPL) + '">' + formatAmount(invDayPL) + '</div>' +
                          '<div class="number-sub ' + getAmountClass(invDayChp) + '">' + formatPercent(invDayChp) + '</div>'
                        : '<div class="number-main">-</div>';

                    return '<tr>' +
                        '<td class="symbol-cell"><div class="symbol-main">' + inv.name + '</div></td>' +
                        '<td class="text-right">' + invQtyHtml + '<div class="number-sub">' + formatPrice(invAvgCost, false) + '</div></td>' +
                        '<td class="text-right"><div class="number-main">' + formatAmount(invInvested) + '</div><div class="number-sub">' + invInvPct.toFixed(2) + '%</div></td>' +
                        '<td class="text-right"><div class="number-main">' + formatPrice(price, false) + '</div></td>' +
                        '<td class="text-right">' + invDayPLHtml + '</td>' +
                        '<td class="text-right"><div class="number-main ' + getAmountClass(invPL) + '">' + formatAmount(invPL) + '</div><div class="number-sub ' + getAmountClass(invPLPct) + '">' + formatPercent(invPLPct) + '</div></td>' +
                        '<td class="text-right"><div class="number-main">' + formatAmount(invValue) + '</div><div class="number-sub">' + invValPct.toFixed(2) + '%</div></td>' +
                        '<td>' + Array.from(inv.tags).map(function(t) { return '<span class="tag-badge">' + t + '</span>'; }).join('') + '</td>' +
                    '</tr>';
                }).join('');

            detailRow =
                '<tr class="detail-row">' +
                    '<td colspan="8">' +
                        '<table class="inner-table"><tbody>' + investorRows + '</tbody></table>' +
                    '</td>' +
                '</tr>';
        }

        return mainRow + detailRow;
    }).join('');

    // Total row
    var totalDayPL = Object.keys(liveData).length > 0
        ? holdings.reduce(function(sum, h) { var m = getLiveData(h); return sum + (m ? h.quantity * m.ch : 0); }, 0)
        : null;
    var totalDayPLPct = (totalDayPL !== null && totalInvested !== 0)
        ? (totalDayPL / Math.abs(totalInvested)) * 100
        : null;

    var totalDayPLHtml = totalDayPL !== null
        ? '<div class="' + getAmountClass(totalDayPL) + '">' + formatAmount(totalDayPL) + '</div>' +
          '<div class="number-sub ' + getAmountClass(totalDayPLPct) + '">' + formatPercent(totalDayPLPct) + '</div>'
        : '-';

    const totalRow =
        '<tr class="total-row">' +
            '<td>TOTAL</td>' +
            '<td class="text-right">' + holdings.length + ' stocks</td>' +
            '<td class="text-right">' + formatAmount(totalInvested) + '</td>' +
            '<td class="text-right">-</td>' +
            '<td class="text-right">' + totalDayPLHtml + '</td>' +
            '<td class="text-right">' +
                '<div class="' + getAmountClass(totalPL) + '">' + formatAmount(totalPL) + '</div>' +
                '<div class="number-sub ' + getAmountClass(totalPLPercent) + '">' + formatPercent(totalPLPercent) + '</div>' +
            '</td>' +
            '<td class="text-right">' + formatAmount(totalValue) + '</td>' +
            '<td>-</td>' +
        '</tr>';

    list.innerHTML = totalRow + rows;
    updateSortIndicators();
    renderSummaryCards(totalInvested, totalValue, totalPL, totalPLPercent, holdings.length);
}


function updateSortIndicators() {
    document.querySelectorAll('.sort-indicator').forEach(function(el) { el.textContent = ''; });
    var indicator = document.getElementById('sort-' + portfolioSortColumn);
    if (indicator) {
        var arrow = portfolioSortDirection === 'asc' ? '▲' : '▼';
        var label = (portfolioSortByPct && (portfolioSortColumn === 'pl' || portfolioSortColumn === 'daypl')) ? '%' : '';
        indicator.textContent = label + arrow;
    }
}

function renderSummaryCards(invested, value, pl, plPercent, stockCount) {
    const container = document.getElementById('portfolio-summary');
    
    container.innerHTML = `
        <div class="summary-card">
            <div class="summary-label">Total Invested</div>
            <div class="summary-value">${formatAmount(invested)}</div>
        </div>
        <div class="summary-card ${getAmountClass(pl)}">
            <div class="summary-label">Total P&L</div>
            <div class="summary-value">${formatAmount(pl)}</div>
            <div class="summary-percent">${formatPercent(plPercent)}</div>
        </div>
        <div class="summary-card">
            <div class="summary-label">Total Value</div>
            <div class="summary-value">${formatAmount(value)}</div>
        </div>
        <div class="summary-card">
            <div class="summary-label">Holdings</div>
            <div class="summary-value">${stockCount} stocks</div>
        </div>
    `;
}

// ============================================================================
// CLOSE DROPDOWNS ON OUTSIDE CLICK
// ============================================================================

document.addEventListener('click', (e) => {
    if (!e.target.closest('.filter-search-container')) {
        document.querySelectorAll('.filter-dropdown').forEach(dropdown => {
            dropdown.classList.remove('show');
        });
    }
});

// ============================================================================
// EXPORT
// ============================================================================

// Initialize on load
if (typeof window !== 'undefined') {
    window.toggleZeroHoldings = toggleZeroHoldings;
    window.initPortfolio = initPortfolio;
    window.refreshPortfolio = refreshPortfolio;
    window.sortPortfolio = sortPortfolio;
    window.toggleSymbolDetail = toggleSymbolDetail;
    window.toggleInvestorFilter = toggleInvestorFilter;
    window.toggleBrokerFilter = toggleBrokerFilter;
    window.toggleTagFilter = toggleTagFilter;
    window.clearInvestorFilters = clearInvestorFilters;
    window.clearBrokerFilters = clearBrokerFilters;
    window.clearTagFilters = clearTagFilters;
    window.updateTagLogic = updateTagLogic;
    window.showInvestorDropdown = showInvestorDropdown;
    window.showBrokerDropdown = showBrokerDropdown;
    window.showTagDropdown = showTagDropdown;
    window.filterInvestorSearch = filterInvestorSearch;
    window.filterBrokerSearch = filterBrokerSearch;
    window.filterTagSearch = filterTagSearch;
}
