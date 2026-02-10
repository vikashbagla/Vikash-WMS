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
let expandedSymbol = null; // Track which symbol is expanded

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
    const label = getUnitLabel();
    console.log('Setting unit labels to:', label);
    
    // Update only value-related unit labels (not prices)
    // unit-label-2: Invested Value
    // unit-label-4: P&L
    // unit-label-5: Total Value
    const labelIds = ['unit-label-2', 'unit-label-4', 'unit-label-5'];
    
    labelIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = `₹${label}`;
        }
    });
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
    await loadPortfolioData();
    renderPortfolio();
    showAlert('Portfolio refreshed', 'success', 2000);
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
    
    // Filter out zero/negative holdings and calculate avg cost
    return Object.values(holdings)
        .filter(h => h.quantity > 0)
        .map(h => ({
            ...h,
            avgCost: h.totalCost / h.quantity,
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
// RENDERING
// ============================================================================

function renderPortfolio() {
    const list = document.getElementById('portfolio-list');
    
    let holdings = calculateHoldings();
    
    if (holdings.length === 0) {
        list.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px; color: #9ca3af;">No holdings to display</td></tr>';
        document.getElementById('portfolio-summary').innerHTML = '';
        updateSortIndicators();
        return;
    }

    // Calculate totals
    let totalInvested = 0;
    let totalValue = 0;
    
    holdings.forEach(h => {
        const invested = h.quantity * h.avgCost;
        const value = h.quantity * h.latestPrice;
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
                valA = (a.quantity * a.latestPrice) - (a.quantity * a.avgCost);
                valB = (b.quantity * b.latestPrice) - (b.quantity * b.avgCost);
                break;
            case 'value':
                valA = a.quantity * a.latestPrice;
                valB = b.quantity * b.latestPrice;
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
        const invested = h.quantity * h.avgCost;
        const currentValue = h.quantity * h.latestPrice;
        const pl = currentValue - invested;
        const plPercent = invested > 0 ? (pl / invested) * 100 : 0;
        const investedPercent = totalInvested > 0 ? (invested / totalInvested) * 100 : 0;
        const valuePercent = totalValue > 0 ? (currentValue / totalValue) * 100 : 0;
        
        const symbolKey = `${h.symbol}-${h.exchange}`;
        const isExpanded = expandedSymbol === symbolKey;
        
        // Main row
        let mainRow = `
            <tr class="${isExpanded ? 'expanded-row' : ''}">
                <td class="symbol-cell">
                    <div class="symbol-main symbol-clickable" onclick="toggleSymbolDetail('${h.symbol}', '${h.exchange}')">${h.symbol}</div>
                    <div class="symbol-sub">${h.companyName}</div>
                </td>
                <td class="text-right">
                    <div class="number-main">${formatQuantity(h.quantity)}</div>
                    <div class="number-sub">${formatPrice(h.avgCost, false)}</div>
                </td>
                <td class="text-right">
                    <div class="number-main">${formatAmount(invested)}</div>
                    <div class="number-sub">${investedPercent.toFixed(2)}%</div>
                </td>
                <td class="text-right number-main">${formatPrice(h.latestPrice, false)}</td>
                <td class="text-right">
                    <div class="number-main ${getAmountClass(pl)}">${formatAmount(pl)}</div>
                    <div class="number-sub ${getAmountClass(plPercent)}">${formatPercent(plPercent)}</div>
                </td>
                <td class="text-right">
                    <div class="number-main">${formatAmount(currentValue)}</div>
                    <div class="number-sub">${valuePercent.toFixed(2)}%</div>
                </td>
                <td>
                    ${h.tags.map(tag => `<span class="tag-badge">${tag}</span>`).join('')}
                </td>
            </tr>
        `;
        
        // Detail row if expanded
        let detailRow = '';
        if (isExpanded) {
            // Get all transactions for this symbol
            const symbolTxns = transactions.filter(txn => 
                txn.symbol === h.symbol && txn.exchange === h.exchange
            );
            
            // Group by investor
            const investorGroups = {};
            symbolTxns.forEach(txn => {
                if (!investorGroups[txn.investorId]) {
                    const investor = investors.find(inv => inv.id === txn.investorId);
                    investorGroups[txn.investorId] = {
                        name: investor ? investor.name : 'Unknown',
                        quantity: 0,
                        totalCost: 0,
                        tags: new Set()
                    };
                }
                investorGroups[txn.investorId].quantity += txn.quantity;
                investorGroups[txn.investorId].totalCost += txn.netAmount;
                if (txn.tags) {
                    txn.tags.forEach(tag => investorGroups[txn.investorId].tags.add(tag));
                }
            });
            
            // Build investor rows
            const investorRows = Object.values(investorGroups)
                .filter(inv => inv.quantity > 0)
                .map(inv => {
                    const invAvgCost = inv.totalCost / inv.quantity;
                    const invValue = inv.quantity * h.latestPrice;
                    const invInvested = inv.quantity * invAvgCost;
                    const invPL = invValue - invInvested;
                    const invPLPercent = invInvested > 0 ? (invPL / invInvested) * 100 : 0;
                    
                    // Calculate % of this symbol's total
                    const invInvestedPercent = invested > 0 ? (invInvested / invested) * 100 : 0;
                    const invValuePercent = currentValue > 0 ? (invValue / currentValue) * 100 : 0;
                    
                    return `
                        <tr>
                            <td class="symbol-cell">
                                <div class="symbol-main">${inv.name}</div>
                            </td>
                            <td class="text-right">
                                <div class="number-main">${formatQuantity(inv.quantity)}</div>
                                <div class="number-sub">${formatPrice(invAvgCost, false)}</div>
                            </td>
                            <td class="text-right">
                                <div class="number-main">${formatAmount(invInvested)}</div>
                                <div class="number-sub">${invInvestedPercent.toFixed(2)}%</div>
                            </td>
                            <td class="text-right number-main">${formatPrice(h.latestPrice, false)}</td>
                            <td class="text-right">
                                <div class="number-main ${getAmountClass(invPL)}">${formatAmount(invPL)}</div>
                                <div class="number-sub ${getAmountClass(invPLPercent)}">${formatPercent(invPLPercent)}</div>
                            </td>
                            <td class="text-right">
                                <div class="number-main">${formatAmount(invValue)}</div>
                                <div class="number-sub">${invValuePercent.toFixed(2)}%</div>
                            </td>
                            <td>${Array.from(inv.tags).map(tag => `<span class="tag-badge">${tag}</span>`).join('')}</td>
                        </tr>
                    `;
                }).join('');
            
            detailRow = `
                <tr class="detail-row">
                    <td colspan="7">
                        <table class="inner-table">
                            <tbody>
                                ${investorRows}
                            </tbody>
                        </table>
                    </td>
                </tr>
            `;
        }
        
        return mainRow + detailRow;
    }).join('');
    
    // Add total row
    const totalRow = `
        <tr class="total-row">
            <td><strong>TOTAL</strong></td>
            <td class="text-right"><strong>${holdings.length} stocks</strong></td>
            <td class="text-right"><strong>${formatAmount(totalInvested)}</strong></td>
            <td class="text-right">-</td>
            <td class="text-right">
                <div class="number-main ${getAmountClass(totalPL)}"><strong>${formatAmount(totalPL)}</strong></div>
                <div class="number-sub ${getAmountClass(totalPLPercent)}"><strong>${formatPercent(totalPLPercent)}</strong></div>
            </td>
            <td class="text-right"><strong>${formatAmount(totalValue)}</strong></td>
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
        <div class="summary-card">
            <div class="summary-label">Current Value</div>
            <div class="summary-value">${formatAmount(value)}</div>
        </div>
        <div class="summary-card ${getAmountClass(pl)}">
            <div class="summary-label">Total P&L</div>
            <div class="summary-value">${formatAmount(pl)}</div>
            <div class="summary-percent">${formatPercent(plPercent)}</div>
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
