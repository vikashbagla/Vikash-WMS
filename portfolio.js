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
    console.log('=== PORTFOLIO INIT START ===');
    
    // Check if supabaseClient exists
    if (typeof supabaseClient === 'undefined') {
        console.error('❌ supabaseClient is not defined!');
        if (typeof window.supabaseClient !== 'undefined') {
            console.log('✅ Found supabaseClient on window, using that');
            window.supabaseClient = window.supabaseClient;
        } else {
            console.error('❌ supabaseClient not found anywhere!');
            showAlert('Error: Database client not initialized', 'error');
            return;
        }
    } else {
        console.log('✅ supabaseClient is available');
    }
    
    showLoading(true);
    try {
        console.log('Loading portfolio data...');
        await loadPortfolioData();
        console.log('Fetching live prices...');
        await fetchLivePrices();
        console.log('Updating unit labels...');
        updateUnitLabels();
        console.log('Rendering portfolio...');
        renderPortfolio();
        showLoading(false);
        console.log('=== PORTFOLIO INIT COMPLETE ===');
    } catch (error) {
        console.error('❌ Error initializing portfolio:', error);
        showAlert('Failed to load portfolio data: ' + error.message, 'error');
        showLoading(false);
    }
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
    await loadPortfolioData();
    await fetchLivePrices();
    renderPortfolio();
    showLoading(false);
    showAlert('Portfolio refreshed with live prices', 'success', 2000);
}

// ============================================================================
// LIVE PRICES FROM FYERS
// ============================================================================

// Cache: { 'NSE:RELIANCE-EQ': { lp, ch, chp, high, low, w52h, w52l } }
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
    // Skip if Fyers not connected
    if (!window.fyersToken) {
        console.log('⚠️ Fyers not connected - using last transaction prices');
        updatePriceStatus('last-txn');
        return;
    }

    // Build list of unique Fyers symbols from all holdings
    const holdings = calculateHoldings();
    if (holdings.length === 0) return;

    // Build Fyers symbols for all holdings
    // Equity: NSE:RELIANCE-EQ  |  F&O: NSE:NATIONALUM26FEBFUT (no -EQ, always NSE prefix)
    const fyersSymbols = holdings.map(h => {
        const exch = (h.exchange || 'NSE').toUpperCase();
        if (exch === 'NFO') {
            // F&O - always use full symbol (e.g. NATIONALUM26FEBFUT), prefix NSE:
            return `NSE:${h.symbol}`;
        } else {
            // Equity - use shortSymbol if available, with -EQ suffix
            const sym = h.shortSymbol || h.symbol;
            return `${exch}:${sym}-EQ`;
        }
    });

    console.log('📡 Sending to Fyers:', fyersSymbols);
    updatePriceStatus('loading');

    try {
        const data = await window.fyersCall({
            action: 'quotes',
            symbols: fyersSymbols
        });

        if (data && data.d && data.d.length > 0) {
            data.d.forEach(item => {
                if (item.v && item.v.lp && item.v.symbol) {
                    const key = item.v.symbol;
                    livePrices[key] = item.v.lp;
                    liveData[key] = {
                        lp:   item.v.lp,                          // last price
                        ch:   item.v.ch   || 0,                   // change ₹
                        chp:  item.v.chp  || 0,                   // change %
                        high: item.v.high_price || null,          // day high
                        low:  item.v.low_price  || null,          // day low
                        w52h: item.v['52_week_high'] || null,     // 52w high
                        w52l: item.v['52_week_low']  || null,     // 52w low
                    };
                }
            });
            console.log('✅ Live prices fetched:', livePrices);
            updatePriceStatus('live');
        } else {
            console.warn('⚠️ No price data returned from Fyers:', data);
            updatePriceStatus('last-txn');
        }
    } catch (err) {
        if (err.message === 'FYERS_NOT_AUTHENTICATED') {
            updatePriceStatus('last-txn');
        } else {
            console.error('❌ Fyers price fetch error:', err);
            updatePriceStatus('error');
        }
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
    if (portfolioSortColumn === column) {
        portfolioSortDirection = portfolioSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        portfolioSortColumn = column;
        portfolioSortDirection = 'asc';
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

function buildSlider(current, low, high, tooltip) {
    if (high <= low) return '';
    const pct = Math.min(100, Math.max(0, ((current - low) / (high - low)) * 100));
    // Dot colour: green if in upper half, red if in lower half
    const dotColor = pct >= 50 ? '#059669' : '#dc2626';
    return `
        <div class="price-slider" data-tip="${tooltip}">
            <div class="price-slider-track">
                <div class="price-slider-dot" style="left:${pct.toFixed(1)}%;background:${dotColor};"></div>
            </div>
        </div>
    `;
}

// ============================================================================
// RENDERING
// ============================================================================

function renderPortfolio() {
    const list = document.getElementById('portfolio-list');
    
    let holdings = calculateHoldings();
    
    if (holdings.length === 0) {
        list.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 40px; color: #9ca3af;">No holdings to display</td></tr>';
        document.getElementById('portfolio-summary').innerHTML = '';
        updateSortIndicators();
        return;
    }

    // Calculate totals
    let totalInvested = 0;
    let totalValue = 0;
    
    holdings.forEach(h => {
        const invested = h.quantity * h.avgCost;
        const value = h.quantity * getPrice(h);
        totalInvested += invested;
        totalValue += value;
    });
    
    const totalPL = totalValue - totalInvested;
    const totalPLPercent = totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0;
    
    // Sort holdings
    holdings.sort((a, b) => {
        let valA, valB;
        
        switch(portfolioSortColumn) {
            case 'symbol':
                valA = a.symbol;
                valB = b.symbol;
                break;
            case 'invested':
                valA = a.quantity * a.avgCost;
                valB = b.quantity * b.avgCost;
                break;
            case 'pl':
                valA = (a.quantity * getPrice(a)) - (a.quantity * a.avgCost);
                valB = (b.quantity * getPrice(b)) - (b.quantity * b.avgCost);
                break;
            case 'value':
                valA = a.quantity * getPrice(a);
                valB = b.quantity * getPrice(b);
                break;
            default:
                valA = a.symbol;
                valB = b.symbol;
        }
        
        if (typeof valA === 'string') {
            return portfolioSortDirection === 'asc' 
                ? valA.localeCompare(valB)
                : valB.localeCompare(valA);
        }
        
        return portfolioSortDirection === 'asc' ? valA - valB : valB - valA;
    });
    
    // Render rows
    const rows = holdings.map(h => {
        const price    = getPrice(h);
        const md       = getLiveData(h);
        const invested = h.quantity * h.avgCost;
        const currentValue = h.quantity * price;
        const pl           = currentValue - invested;
        const plPercent    = invested !== 0 ? (pl / Math.abs(invested)) * 100 : 0;
        const investedPercent = totalInvested !== 0 ? (invested / totalInvested) * 100 : 0;
        const valuePercent    = totalValue    !== 0 ? (currentValue / totalValue) * 100 : 0;

        // Day P&L: quantity x change in price
        const dayPL = md ? h.quantity * md.ch : null;

        // Qty: red + parentheses for negative
        const qtyDisplay = h.quantity < 0
            ? `<div class="number-main negative">(${formatQuantity(Math.abs(h.quantity))})</div>`
            : `<div class="number-main">${formatQuantity(h.quantity)}</div>`;

        // CMP slider — 52w range
        const cmpSlider = (md && md.w52h && md.w52l)
            ? buildSlider(md.lp, md.w52l, md.w52h,
                `52W L:${formatPrice(md.w52l,false)} | CMP:${formatPrice(md.lp,false)} | 52W H:${formatPrice(md.w52h,false)}`)
            : '';

        // Day slider — day high/low
        const daySlider = (md && md.high && md.low)
            ? buildSlider(md.lp, md.low, md.high,
                `Day L:${formatPrice(md.low,false)} | CMP:${formatPrice(md.lp,false)} | Day H:${formatPrice(md.high,false)}`)
            : '';

        const symbolKey = `${h.symbol}-${h.exchange}`;
        const isExpanded = expandedSymbol === symbolKey;

        const mainRow = `
            <tr class="${isExpanded ? 'expanded-row' : ''}">
                <td class="symbol-cell">
                    <div class="symbol-main symbol-clickable" onclick="toggleSymbolDetail('${h.symbol}','${h.exchange}')">${h.symbol}</div>
                    <div class="symbol-sub">${h.companyName || ''}</div>
                </td>
                <td class="text-right">
                    ${qtyDisplay}
                    <div class="number-sub">${formatPrice(h.avgCost, false)}</div>
                </td>
                <td class="text-right">
                    <div class="number-main">${formatAmount(invested)}</div>
                    <div class="number-sub">${investedPercent.toFixed(2)}%</div>
                </td>
                <td class="text-right">
                    <div class="number-main">${formatPrice(price, false)}</div>
                    ${cmpSlider}
                </td>
                <td class="text-right">
                    <div class="number-main ${dayPL !== null ? getAmountClass(dayPL) : ''}">${dayPL !== null ? formatAmount(dayPL) : '-'}</div>
                    ${daySlider}
                </td>
                <td class="text-right">
                    <div class="number-main ${getAmountClass(pl)}">${formatAmount(pl)}</div>
                    <div class="number-sub ${getAmountClass(plPercent)}">${formatPercent(plPercent)}</div>
                </td>
                <td class="text-right">
                    <div class="number-main">${formatAmount(currentValue)}</div>
                    <div class="number-sub">${valuePercent.toFixed(2)}%</div>
                </td>
                <td>${h.tags.map(tag => `<span class="tag-badge">${tag}</span>`).join('')}</td>
            </tr>
        `;

        // Detail row — 8 cols, no sliders
        let detailRow = '';
        if (isExpanded) {
            const symbolTxns = transactions.filter(txn =>
                txn.symbol === h.symbol && txn.exchange === h.exchange
            );
            const investorGroups = {};
            symbolTxns.forEach(txn => {
                if (!investorGroups[txn.investorId]) {
                    const investor = investors.find(inv => inv.id === txn.investorId);
                    investorGroups[txn.investorId] = {
                        name: investor ? investor.name : 'Unknown',
                        quantity: 0, totalCost: 0, tags: new Set()
                    };
                }
                investorGroups[txn.investorId].quantity  += txn.quantity;
                investorGroups[txn.investorId].totalCost += txn.netAmount;
                if (txn.tags) txn.tags.forEach(tag => investorGroups[txn.investorId].tags.add(tag));
            });

            const investorRows = Object.values(investorGroups)
                .filter(inv => inv.quantity !== 0)
                    const invAvgCost = inv.quantity !== 0 ? inv.totalCost / inv.quantity : 0;
                    const invDayPL   = md ? inv.quantity * md.ch : null;
                    const invValue   = inv.quantity * price;
                    const invInvested = inv.quantity * invAvgCost;
                    const invPL      = invValue - invInvested;
                    const invPLPct   = invInvested !== 0 ? (invPL / Math.abs(invInvested)) * 100 : 0;
                    const invInvPct  = invested !== 0 ? (invInvested / invested) * 100 : 0;
                    const invValPct  = currentValue !== 0 ? (invValue / currentValue) * 100 : 0;
                    const invQty = inv.quantity < 0
                        ? `<div class="number-main negative">(${formatQuantity(Math.abs(inv.quantity))})</div>`
                        : `<div class="number-main">${formatQuantity(inv.quantity)}</div>`;
                    return `
                        <tr>
                            <td class="symbol-cell"><div class="symbol-main">${inv.name}</div></td>
                            <td class="text-right">
                                ${invQty}
                                <div class="number-sub">${formatPrice(invAvgCost, false)}</div>
                            </td>
                            <td class="text-right">
                                <div class="number-main">${formatAmount(invInvested)}</div>
                                <div class="number-sub">${invInvPct.toFixed(2)}%</div>
                            </td>
                            <td class="text-right"><div class="number-main">${formatPrice(price, false)}</div></td>
                            <td class="text-right">
                                <div class="number-main ${invDayPL !== null ? getAmountClass(invDayPL) : ''}">${invDayPL !== null ? formatAmount(invDayPL) : '-'}</div>
                            </td>
                            <td class="text-right">
                                <div class="number-main ${getAmountClass(invPL)}">${formatAmount(invPL)}</div>
                                <div class="number-sub ${getAmountClass(invPLPct)}">${formatPercent(invPLPct)}</div>
                            </td>
                            <td class="text-right">
                                <div class="number-main">${formatAmount(invValue)}</div>
                                <div class="number-sub">${invValPct.toFixed(2)}%</div>
                            </td>
                            <td>${Array.from(inv.tags).map(tag => `<span class="tag-badge">${tag}</span>`).join('')}</td>
                        </tr>
                    `;
                }).join('');

            detailRow = `
                <tr class="detail-row">
                    <td colspan="8">
                        <table class="inner-table">
                            <tbody>${investorRows}</tbody>
                        </table>
                    </td>
                </tr>
            `;
        }
        return mainRow + detailRow;
    }).join('');

    // Total row — 8 cols, Day P&L sum
    const totalDayPL = Object.keys(liveData).length > 0
        ? holdings.reduce((sum, h) => { const m = getLiveData(h); return sum + (m ? h.quantity * m.ch : 0); }, 0)
        : null;

    const totalRow = `
        <tr class="total-row">
            <td>TOTAL</td>
            <td class="text-right">${holdings.length} stocks</td>
            <td class="text-right">${formatAmount(totalInvested)}</td>
            <td class="text-right">-</td>
            <td class="text-right ${totalDayPL !== null ? getAmountClass(totalDayPL) : ''}">${totalDayPL !== null ? formatAmount(totalDayPL) : '-'}</td>
            <td class="text-right">
                <div class="${getAmountClass(totalPL)}">${formatAmount(totalPL)}</div>
                <div class="number-sub ${getAmountClass(totalPLPercent)}">${formatPercent(totalPLPercent)}</div>
            </td>
            <td class="text-right">${formatAmount(totalValue)}</td>
            <td>-</td>
        </tr>
    `;
    
    list.innerHTML = totalRow + rows;
    
    // Update sort indicators
    updateSortIndicators();
    
    // Render summary cards
    renderSummaryCards(totalInvested, totalValue, totalPL, totalPLPercent, holdings.length);
}

function updateSortIndicators() {
    // Clear all indicators
    document.querySelectorAll('.sort-indicator').forEach(el => el.textContent = '');
    
    // Set current indicator
    const indicator = document.getElementById(`sort-${portfolioSortColumn}`);
    if (indicator) {
        indicator.textContent = portfolioSortDirection === 'asc' ? '▲' : '▼';
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
