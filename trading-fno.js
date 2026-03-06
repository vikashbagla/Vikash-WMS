// ============================================================================
// TRADING MODULE: F&O POSITIONS SUB-MODULE
// Dependencies: trading.js globals (trTransactions, trSelectedInvestorIds,
//   trSelectedTraderIds, trSelectedBrokerIds, trSelectedTagNames,
//   trTagFilterLogic, trGetPrice, trGetLiveData, trInvName, trBrkCode,
//   trGetExpiryLabel, wmsFormatContract, wmsEsc, formatAmount, formatPrice,
//   formatQuantity, formatDate, formatPercent, getAmountClass, showAlert,
//   trBuildFilterWidget, trSelectedInvestorIds etc.)
// ============================================================================

var trFnoMode = 'open';           // 'open' | 'all'
var trFnoMatchMethod = 'lifo';    // 'fifo' | 'lifo'
var trFnoExpiryFilter = null;      // null = not yet initialized (will default to current+prev month)
var trFnoFlatView = false;        // true = flat (ungrouped) for snapshot
var trFnoExpandedSymbols = {};    // { symbol: true } for expanded symbol rows
var trFnoExpandedGroups = {};     // { 'symbol|idx': true } for expanded sub-group rows
var trFnoInitDone = false;
var trFnoColCount = 12;
var trFnoContractPricesFetched = false;

function trFnoInit() {
    if (trFnoInitDone) return;
    trFnoInitDone = true;

    // Build interactive filter widgets for F&O tab
    trFnoInitFilters();

    // Open/All toggle
    document.querySelectorAll('[data-fno-mode]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('[data-fno-mode]').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            trFnoMode = btn.dataset.fnoMode;
            trFnoRender();
        });
    });

    // Match method toggle (LIFO/FIFO)
    document.querySelectorAll('[data-fno-match]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('[data-fno-match]').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            trFnoMatchMethod = btn.dataset.fnoMatch;
            trFnoRender();
        });
    });

    // Flat view toggle
    var flatToggle = document.getElementById('trFnoFlatToggle');
    if (flatToggle) {
        flatToggle.addEventListener('change', function() {
            trFnoFlatView = flatToggle.checked;
            var tableWrap = document.getElementById('trFnoTableWrap');
            if (tableWrap) tableWrap.classList.toggle('trFno-flat-mode', trFnoFlatView);
            trFnoRender();
        });
    }

    // Collapse All / Expand All buttons
    var collapseBtn = document.getElementById('trFnoCollapseAll');
    if (collapseBtn) {
        collapseBtn.addEventListener('click', function() {
            trFnoExpandedSymbols = {};
            trFnoExpandedGroups = {};
            trFnoRender();
        });
    }
    var expandBtn = document.getElementById('trFnoExpandAll');
    if (expandBtn) {
        expandBtn.addEventListener('click', function() {
            // Expand all symbols and all sub-groups
            var positions = window._trFnoLastPositions;
            if (positions) {
                positions.forEach(function(p) {
                    trFnoExpandedSymbols[p.underlying] = true;
                    p.contractGroups.forEach(function(cg, cgIdx) {
                        trFnoExpandedGroups[p.underlying + '|' + cgIdx] = true;
                    });
                });
            }
            trFnoRender();
        });
    }

    // Snapshot button — use wrapper so it always calls current trFnoSnapshot
    var snapBtn = document.getElementById('trFnoSnapBtn');
    if (snapBtn) {
        snapBtn.addEventListener('click', function() { trFnoSnapshot(); });
    }

    // ---- View bar event handlers ----

    // More dropdown toggle
    var fnoMoreBtn = document.getElementById('tr-fno-more-btn');
    if (fnoMoreBtn) {
        fnoMoreBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            var dd = document.getElementById('tr-fno-more-dropdown');
            dd.style.display = (dd.style.display === 'none') ? 'block' : 'none';
        });
    }

    // Update View button
    var fnoUpdateBtn = document.getElementById('tr-fno-update-view-btn');
    if (fnoUpdateBtn) {
        fnoUpdateBtn.addEventListener('click', function() {
            if (trFnoActiveViewId) trFnoUpdateCurrentView();
        });
    }

    // New blank view button
    var fnoNewViewBtn = document.getElementById('tr-fno-new-view-btn');
    if (fnoNewViewBtn) {
        fnoNewViewBtn.addEventListener('click', function() {
            trFnoCreateBlankView();
        });
    }

    // Save New button → show inline prompt
    var fnoSaveNewBtn = document.getElementById('tr-fno-save-new-btn');
    if (fnoSaveNewBtn) {
        fnoSaveNewBtn.addEventListener('click', function() {
            var prompt = document.getElementById('tr-fno-save-prompt');
            prompt.classList.add('show');
            document.getElementById('tr-fno-save-prompt-name').focus();
            fnoSaveNewBtn.style.display = 'none';
        });
    }

    // Confirm save in inline prompt
    var fnoSaveOk = document.getElementById('tr-fno-save-prompt-ok');
    if (fnoSaveOk) {
        fnoSaveOk.addEventListener('click', function() {
            var name = document.getElementById('tr-fno-save-prompt-name').value.trim();
            if (name) trFnoSaveCurrentView(name);
        });
    }

    // Cancel save prompt
    var fnoSaveCancel = document.getElementById('tr-fno-save-prompt-cancel');
    if (fnoSaveCancel) {
        fnoSaveCancel.addEventListener('click', function() {
            document.getElementById('tr-fno-save-prompt').classList.remove('show');
            document.getElementById('tr-fno-save-prompt-name').value = '';
            document.getElementById('tr-fno-save-new-btn').style.display = '';
        });
    }

    // Enter/Escape in save prompt name field
    var fnoSaveName = document.getElementById('tr-fno-save-prompt-name');
    if (fnoSaveName) {
        fnoSaveName.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                var name = e.target.value.trim();
                if (name) trFnoSaveCurrentView(name);
            } else if (e.key === 'Escape') {
                document.getElementById('tr-fno-save-prompt').classList.remove('show');
                fnoSaveName.value = '';
                document.getElementById('tr-fno-save-new-btn').style.display = '';
            }
        });
    }

    // Close More dropdown on outside click
    document.addEventListener('click', function(e) {
        if (!e.target.closest('#tr-fno-more-btn') && !e.target.closest('#tr-fno-more-dropdown')) {
            var mdd = document.getElementById('tr-fno-more-dropdown');
            if (mdd) mdd.style.display = 'none';
        }
    });

    // Load saved views from DB
    trFnoLoadViews();
}

// ============================================================================
// SHARED FILTERS: Build interactive inv/trader/broker/tag pill filters
// Uses the same global selectedIds arrays — changes apply across tabs.
// ============================================================================

var trFnoInvPillFilter = null;
var trFnoTrdPillFilter = null;
var trFnoBrkPillFilter = null;
var trFnoTagPillFilter = null;

function trFnoInitFilters() {
    // Investor
    var invC = document.getElementById('tr-fno-filter-investor');
    if (invC && !trFnoInvPillFilter) {
        var invItems = trInvestors.map(function(inv) {
            return { id: inv.id, label: inv.short_name || inv.name, searchText: (inv.name || '') + ' ' + (inv.short_name || '') };
        });
        trFnoInvPillFilter = wmsPillSearch(invC, {
            label: 'Filter by Investor',
            placeholder: 'Type to search investors...',
            items: invItems,
            selectedIds: trSelectedInvestorIds,
            onChange: function() { trFnoRender(); trRenderPortfolio(); }
        });
    }

    // Trader
    var trdC = document.getElementById('tr-fno-filter-trader');
    if (trdC && !trFnoTrdPillFilter) {
        var trdItems = trInvestors.map(function(inv) {
            return { id: inv.id, label: inv.short_name || inv.name, searchText: (inv.name || '') + ' ' + (inv.short_name || '') };
        });
        trFnoTrdPillFilter = wmsPillSearch(trdC, {
            label: 'Filter by Trader',
            placeholder: 'Type to search traders...',
            items: trdItems,
            selectedIds: trSelectedTraderIds,
            onChange: function() { trFnoRender(); trRenderPortfolio(); }
        });
    }

    // Broker
    var brkC = document.getElementById('tr-fno-filter-broker');
    if (brkC && !trFnoBrkPillFilter) {
        var brkItems = trBrokers.map(function(b) {
            return { id: b.id, label: b.broker_code || b.name, searchText: (b.name || '') + ' ' + (b.broker_code || '') };
        });
        trFnoBrkPillFilter = wmsPillSearch(brkC, {
            label: 'Filter by Broker',
            placeholder: 'Type to search brokers...',
            items: brkItems,
            selectedIds: trSelectedBrokerIds,
            onChange: function() { trFnoRender(); trRenderPortfolio(); }
        });
    }

    // Tag
    var tagC = document.getElementById('tr-fno-filter-tag');
    if (tagC && !trFnoTagPillFilter) {
        var allTags = {};
        trTransactions.forEach(function(t) {
            if (t.tags) t.tags.forEach(function(tag) { if (tag !== 'blank') allTags[tag] = true; });
        });
        var tagItems = Object.keys(allTags).sort().map(function(tag) { return { id: tag, label: tag }; });
        var tagExtra = document.createElement('div');
        tagExtra.className = 'tag-match-options';
        tagExtra.innerHTML =
            '<span style="font-size:11px;color:#718096;">Match:</span>' +
            '<label class="radio-label"><input type="radio" name="tr-fno-tag-logic" value="OR"' + (trTagFilterLogic !== 'AND' ? ' checked' : '') + '> <span>Any</span></label>' +
            '<label class="radio-label"><input type="radio" name="tr-fno-tag-logic" value="AND"' + (trTagFilterLogic === 'AND' ? ' checked' : '') + '> <span>All</span></label>';
        tagExtra.querySelectorAll('input[type="radio"]').forEach(function(r) {
            r.addEventListener('change', function() {
                trTagFilterLogic = r.value;
                trFnoRender();
                trRenderPortfolio();
            });
        });
        trFnoTagPillFilter = wmsPillSearch(tagC, {
            label: 'Filter by Tag',
            placeholder: 'Type to search tags...',
            items: tagItems,
            selectedIds: trSelectedTagNames,
            onChange: function() { trFnoRender(); trRenderPortfolio(); },
            headerExtra: tagExtra
        });
    }
}

// ============================================================================
// DATA: Get F&O transactions with current portfolio filters applied
// ============================================================================

function trFnoGetTxns() {
    var txns = trTransactions.filter(function(t) {
        return t.security_type === 'NFO' || t.security_type === 'MCX';
    });
    // Apply same portfolio filters (investor, trader, broker, tag)
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
    return txns;
}

// ============================================================================
// MATCHING: Calculate F&O positions with FIFO/LIFO matching
// ============================================================================

function trFnoCalcPositions() {
    var txns = trFnoGetTxns();
    var trades = txns.filter(function(t) {
        return t.transaction_type === 'BUY' || t.transaction_type === 'SELL';
    });

    // First level: group by underlying_symbol (short_symbol)
    var bySymbol = {};
    trades.forEach(function(t) {
        var underlying = t.short_symbol || t.symbol || '';
        if (!bySymbol[underlying]) bySymbol[underlying] = [];
        bySymbol[underlying].push(t);
    });

    // Build expiry options from all trades
    var allExpiries = {};
    var monthIdx = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
    trades.forEach(function(t) {
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
    trFnoBuildExpiryFilter(expiryKeys);

    // Process each underlying symbol
    var symbolResults = [];

    Object.keys(bySymbol).sort().forEach(function(underlying) {
        var symbolTrades = bySymbol[underlying];

        // Second level: group by inv + trader + broker + full symbol (contract)
        var groups = {};
        symbolTrades.forEach(function(t) {
            var invId = t.investor_id || '';
            var trdId = t.trader_id || '';
            var brkId = t.broker_id || '';
            var fullSym = t.symbol || t.short_symbol || '';
            var key = invId + '|' + trdId + '|' + brkId + '|' + fullSym;
            if (!groups[key]) {
                groups[key] = {
                    investorId: t.investor_id, traderId: t.trader_id, brokerId: t.broker_id,
                    fullSymbol: fullSym, shortSymbol: t.short_symbol || t.symbol || '',
                    contractLabel: wmsFormatContract(t), buys: [], sells: []
                };
            }
            var entry = {
                date: t.transaction_date, qty: Math.abs(t.quantity || 0),
                netAmount: Math.abs(t.net_amount || 0), remaining: Math.abs(t.quantity || 0), txn: t
            };
            if (t.transaction_type === 'BUY') groups[key].buys.push(entry);
            else groups[key].sells.push(entry);
        });

        var contractGroups = [];
        var symbolTotalRealisedPnl = 0, symbolTotalUnrealisedPnl = 0, symbolTotalDayPnl = 0;
        var symbolTotalOpenQty = 0, symbolTotalCost = 0;
        var symbolTotalBuyAmt = 0, symbolTotalSellAmt = 0;
        var hasOpenPosition = false;
        // Futures-only tracking (options distort qty and avg_cost)
        var symbolFutOpenQty = 0, symbolFutOpenCost = 0;
        var symbolFutIsShort = false;

        Object.keys(groups).sort().forEach(function(key) {
            var g = groups[key];
            var contractExpiry = trGetExpiryLabel(g.contractLabel);

            // Apply expiry filter
            if (trFnoExpiryFilter.length > 0 && trFnoExpiryFilter.indexOf(contractExpiry) < 0) return;

            // Sort chronologically
            g.buys.sort(function(a, b) { return new Date(a.date) - new Date(b.date); });
            g.sells.sort(function(a, b) { return new Date(a.date) - new Date(b.date); });

            // Detect short position
            var firstBuyDate = g.buys.length > 0 ? new Date(g.buys[0].date) : new Date('9999-12-31');
            var firstSellDate = g.sells.length > 0 ? new Date(g.sells[0].date) : new Date('9999-12-31');
            var isShort = firstSellDate < firstBuyDate;

            var buys = g.buys.map(function(b) { return { date: b.date, qty: b.qty, netAmount: b.netAmount, remaining: b.qty, txn: b.txn }; });
            var sells = g.sells.map(function(s) { return { date: s.date, qty: s.qty, netAmount: s.netAmount, remaining: s.qty, txn: s.txn }; });

            var openers = isShort ? sells : buys;
            var closers = isShort ? buys : sells;
            var openerOrder = trFnoMatchMethod === 'lifo' ? openers.slice().reverse() : openers.slice();
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
                    var buyDate, buyAvg, buyAmount, sellDate, sellAvg, sellAmount;
                    if (isShort) {
                        sellDate = opener.date; sellAvg = openerPpu; sellAmount = matchQty * openerPpu;
                        buyDate = closer.date; buyAvg = closerPpu; buyAmount = matchQty * closerPpu;
                    } else {
                        buyDate = opener.date; buyAvg = openerPpu; buyAmount = matchQty * openerPpu;
                        sellDate = closer.date; sellAvg = closerPpu; sellAmount = matchQty * closerPpu;
                    }
                    var buyTxnId, sellTxnId;
                    if (isShort) {
                        sellTxnId = opener.txn.id; buyTxnId = closer.txn.id;
                    } else {
                        buyTxnId = opener.txn.id; sellTxnId = closer.txn.id;
                    }
                    matchedRows.push({
                        type: 'matched', isShort: isShort, qty: matchQty,
                        buyDate: buyDate, buyAvg: buyAvg, buyAmount: buyAmount,
                        sellDate: sellDate, sellAvg: sellAvg, sellAmount: sellAmount,
                        pnl: sellAmount - buyAmount,
                        buyTxnId: buyTxnId, sellTxnId: sellTxnId
                    });
                    opener.remaining -= matchQty;
                    closerRemaining -= matchQty;
                }
                closer.remaining = closerRemaining;
            });

            // Open positions (unmatched openers)
            openerOrder.forEach(function(opener) {
                if (opener.remaining <= 0) return;
                var ppu = opener.qty > 0 ? opener.netAmount / opener.qty : 0;
                var row = { type: 'open', isShort: isShort, qty: opener.remaining, pnl: 0 };
                if (isShort) {
                    row.buyDate = null; row.buyAvg = 0; row.buyAmount = 0;
                    row.sellDate = opener.date; row.sellAvg = ppu; row.sellAmount = opener.remaining * ppu;
                    row.sellTxnId = opener.txn.id;
                } else {
                    row.buyDate = opener.date; row.buyAvg = ppu; row.buyAmount = opener.remaining * ppu;
                    row.sellDate = null; row.sellAvg = 0; row.sellAmount = 0;
                    row.buyTxnId = opener.txn.id;
                }
                // Unrealised P&L using contract-specific CMP (not equity CMP)
                var contractSym = opener.txn.symbol;
                var contractCache = wmsLivePrices[contractSym];
                var cmp = contractCache ? contractCache.lp : 0;
                if (cmp > 0) {
                    row.cmp = cmp;
                    var openCost = row.isShort ? row.sellAmount : row.buyAmount;
                    var openValue = row.qty * cmp;
                    row.unrealisedPnl = row.isShort ? (openCost - openValue) : (openValue - openCost);
                }
                // Day's P&L = qty × today's price change (ch)
                var ch = contractCache ? (contractCache.ch || 0) : 0;
                if (ch !== 0) {
                    row.dayPnl = row.isShort ? (-row.qty * ch) : (row.qty * ch);
                }
                matchedRows.push(row);
            });

            if (matchedRows.length === 0) return;

            // Sort: buy date for long, sell date for short
            matchedRows.sort(function(a, b) {
                var dateA = isShort ? (a.sellDate || '9999') : (a.buyDate || '9999');
                var dateB = isShort ? (b.sellDate || '9999') : (b.buyDate || '9999');
                return new Date(dateA) - new Date(dateB);
            });

            // Aggregate totals
            var totalQty = 0, totalBuyAmt = 0, totalSellAmt = 0, totalPnl = 0;
            var openQty = 0, unrealisedPnl = 0, openCost = 0, dayPnl = 0;
            matchedRows.forEach(function(r) {
                if (r.type === 'matched') {
                    totalQty += r.qty; totalBuyAmt += r.buyAmount;
                    totalSellAmt += r.sellAmount; totalPnl += r.pnl;
                }
                if (r.type === 'open') {
                    openQty += r.qty;
                    openCost += r.isShort ? r.sellAmount : r.buyAmount;
                    if (r.unrealisedPnl !== undefined) unrealisedPnl += r.unrealisedPnl;
                    if (r.dayPnl !== undefined) dayPnl += r.dayPnl;
                    hasOpenPosition = true;
                }
            });

            // Inv > Trader > Broker label
            var invLabel = trInvName(g.investorId);
            var trdLabel = g.traderId ? trInvName(g.traderId) : '';
            var brkLabel = trBrkCode(g.brokerId);
            var groupLabel = invLabel;
            if (trdLabel && trdLabel !== invLabel) groupLabel += ' > ' + trdLabel;
            if (brkLabel) groupLabel += ' > ' + brkLabel;

            symbolTotalRealisedPnl += totalPnl;
            symbolTotalUnrealisedPnl += unrealisedPnl;
            symbolTotalDayPnl += dayPnl;
            symbolTotalOpenQty += openQty;
            symbolTotalCost += openCost;
            symbolTotalBuyAmt += totalBuyAmt;
            symbolTotalSellAmt += totalSellAmt;

            // Track futures-only data (options distort qty & avg_cost)
            var isFuture = g.contractLabel.indexOf('Fut') >= 0;
            if (isFuture && openQty > 0) {
                symbolFutOpenQty += isShort ? -openQty : openQty;
                symbolFutOpenCost += openCost;
                symbolFutIsShort = isShort;
            }

            contractGroups.push({
                groupLabel: groupLabel, contractLabel: g.contractLabel,
                isShort: isShort, isFuture: isFuture, rows: matchedRows,
                totalQty: totalQty, totalBuyAmt: totalBuyAmt, totalSellAmt: totalSellAmt,
                totalPnl: totalPnl, openQty: openQty, openCost: openCost,
                unrealisedPnl: unrealisedPnl, dayPnl: dayPnl
            });
        });

        if (contractGroups.length === 0) return;

        // In "open" mode, filter contract groups to only those with open positions
        if (trFnoMode === 'open') {
            contractGroups = contractGroups.filter(function(cg) { return cg.openQty > 0; });
            if (contractGroups.length === 0) return;
        }

        // Resolve company name from CM securities master
        var companyName = underlying;
        if (wmsRefData.securitiesCmReady) {
            for (var i = 0; i < wmsRefData.securitiesCm.length; i++) {
                var s = wmsRefData.securitiesCm[i];
                if (s.symbol === underlying || s.nse_symbol === underlying || s.bse_symbol === underlying) {
                    companyName = s.company_name || underlying;
                    break;
                }
            }
        }

        // Futures avg cost
        var absFutQty = Math.abs(symbolFutOpenQty);
        var futAvgCost = absFutQty > 0 ? symbolFutOpenCost / absFutQty : 0;

        symbolResults.push({
            underlying: underlying, companyName: companyName,
            contractGroups: contractGroups,
            totalRealisedPnl: symbolTotalRealisedPnl,
            totalUnrealisedPnl: symbolTotalUnrealisedPnl,
            totalDayPnl: symbolTotalDayPnl,
            totalOpenQty: symbolTotalOpenQty,
            totalOpenCost: symbolTotalCost,
            totalBuyAmt: symbolTotalBuyAmt,
            totalSellAmt: symbolTotalSellAmt,
            futOpenQty: absFutQty,
            futAvgCost: futAvgCost,
            futIsShort: symbolFutIsShort
        });
    });

    return symbolResults;
}

// ============================================================================
// RENDERING: Main render dispatcher
// ============================================================================

function trFnoRender() {
    trFnoInit();
    var tbody = document.getElementById('trFnoBody');
    if (!tbody) return;

    var positions = trFnoCalcPositions();
    window._trFnoLastPositions = positions;  // Store for snapshot
    if (!positions || positions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="' + trFnoColCount + '" style="text-align:center;padding:40px;color:#9ca3af;">No F&O positions found</td></tr>';
        return;
    }

    var html = trFnoFlatView ? trFnoRenderFlat(positions) : trFnoRenderGrouped(positions);
    tbody.innerHTML = html;

    // Wire click handlers for expand/collapse (grouped view only)
    if (!trFnoFlatView) {
        // Symbol-level expand/collapse
        tbody.querySelectorAll('.trFno-symbol-row').forEach(function(row) {
            row.addEventListener('click', function() {
                var sym = row.dataset.fnoSymbol;
                if (trFnoExpandedSymbols[sym]) delete trFnoExpandedSymbols[sym];
                else trFnoExpandedSymbols[sym] = true;
                trFnoRender();
            });
        });
        // Sub-group expand/collapse
        tbody.querySelectorAll('.trFno-group-row').forEach(function(row) {
            row.addEventListener('click', function(e) {
                e.stopPropagation();
                var gk = row.dataset.fnoGroup;
                if (trFnoExpandedGroups[gk]) delete trFnoExpandedGroups[gk];
                else trFnoExpandedGroups[gk] = true;
                trFnoRender();
            });
        });
    }

    // Click-to-edit: clicking buy/sell side opens the edit modal for that transaction
    tbody.querySelectorAll('.trFno-detail-row.clickable-row').forEach(function(row) {
        row.addEventListener('click', function(e) {
            // Don't interfere with expand/collapse rows
            if (e.target.closest('.trFno-symbol-row') || e.target.closest('.trFno-group-row')) return;
            var td = e.target.closest('td');
            if (!td) return;
            var tdIndex = Array.from(row.children).indexOf(td);
            var txnId;
            // Grouped view: cols 0-1=underlying/contract, 2=qty, 3-4=buy, 5-6=sell, 7-10=pnl
            // Flat view: cols 0-1=name/contract, 2=qty, 3-4=buy, 5-6=sell, 7-10=pnl
            if (tdIndex === 3 || tdIndex === 4) {
                txnId = row.dataset.buyTxnId;
            } else if (tdIndex === 5 || tdIndex === 6) {
                txnId = row.dataset.sellTxnId;
            } else {
                // Default: open whichever side exists (buy preferred)
                txnId = row.dataset.buyTxnId || row.dataset.sellTxnId;
            }
            if (txnId) trOpenEditModal(txnId);
        });
    });

    // Async: fetch F&O contract prices on first render, then start auto-refresh
    if (!trFnoContractPricesFetched && window.fyersToken) {
        trFnoContractPricesFetched = true;
        trFnoFetchAndRefresh().then(function() {
            trFnoStartAutoRefresh();
        });
    } else if (trFnoContractPricesFetched) {
        // Re-entering the tab — restart auto-refresh
        trFnoStartAutoRefresh();
    }
}

// ============================================================================
// RENDERING: Total row helper (split into cells so borders show)
// ============================================================================

function trFnoBuildTotalRow(totExposure, totDayPnl, totRealised, totUnrealised, totNet) {
    var ptDClass = totDayPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
    var ptRClass = totRealised >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
    var ptUClass = totUnrealised >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
    var ptNClass = totNet >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
    return '<tr class="trFno-total-row">' +
        '<td colspan="3">TOTAL</td>' +
        '<td colspan="2" class="trM-buy-start"></td>' +
        '<td colspan="2" class="trM-sell-start"></td>' +
        '<td class="text-right trFno-pnl-start">' + formatAmount(totExposure) + '</td>' +
        '<td class="text-right"><span class="' + ptDClass + '">' + (totDayPnl !== 0 ? formatAmount(totDayPnl) : '-') + '</span></td>' +
        '<td class="text-right"><span class="' + ptRClass + '">' + formatAmount(totRealised) + '</span></td>' +
        '<td class="text-right"><span class="' + ptUClass + '">' + formatAmount(totUnrealised) + '</span></td>' +
        '<td class="text-right"><span class="' + ptNClass + '">' + formatAmount(totNet) + '</span></td>' +
    '</tr>';
}

// ============================================================================
// RENDERING: Grouped view (symbol → contract group → detail rows)
// ============================================================================

function trFnoRenderGrouped(positions) {
    // Page totals — exposure = only open positions
    var pageTotExposure = 0, pageTotDayPnl = 0, pageTotRealised = 0, pageTotUnrealised = 0, pageTotNet = 0;

    positions.forEach(function(p) {
        pageTotExposure += p.totalOpenCost;
        pageTotDayPnl += p.totalDayPnl || 0;
        pageTotRealised += p.totalRealisedPnl;
        pageTotUnrealised += p.totalUnrealisedPnl;
        pageTotNet += p.totalRealisedPnl + p.totalUnrealisedPnl;
    });

    // TOTAL row at the top (sticky below header)
    var html = trFnoBuildTotalRow(pageTotExposure, pageTotDayPnl, pageTotRealised, pageTotUnrealised, pageTotNet);

    positions.forEach(function(p) {
        var isExpanded = trFnoExpandedSymbols[p.underlying];

        var rPnl = p.totalRealisedPnl;
        var uPnl = p.totalUnrealisedPnl;
        var dPnl = p.totalDayPnl || 0;
        var netPnl = rPnl + uPnl;
        var exposure = p.totalOpenCost;
        var dClass = dPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
        var rClass = rPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
        var uClass = uPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
        var nClass = netPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';

        // Avg cost: buy-price if net long, sell-price if net short
        var avgBuyPrice = (!p.futIsShort && p.futAvgCost > 0) ? formatPrice(p.futAvgCost, false) : '';
        var avgSellPrice = (p.futIsShort && p.futAvgCost > 0) ? formatPrice(p.futAvgCost, false) : '';

        // Symbol-level summary row — highlighted, no arrow, no contract list
        html += '<tr class="trFno-symbol-row" data-fno-symbol="' + wmsEsc(p.underlying) + '">' +
            '<td><span class="trFno-symbol-name">' + wmsEsc(p.companyName) + '</span>' +
                '<div class="trFno-symbol-sub">' + wmsEsc(p.underlying) + '</div></td>' +
            '<td></td>' +
            '<td class="text-right">' + (p.futOpenQty > 0 ? formatQuantity(p.futOpenQty) : '-') + '</td>' +
            '<td class="trM-buy-start"></td>' +
            '<td class="text-right">' + avgBuyPrice + '</td>' +
            '<td class="trM-sell-start"></td>' +
            '<td class="text-right">' + avgSellPrice + '</td>' +
            '<td class="text-right trFno-pnl-start">' + (exposure > 0 ? formatAmount(exposure) : '-') + '</td>' +
            '<td class="text-right"><span class="' + dClass + '">' + (dPnl !== 0 ? formatAmount(dPnl) : '-') + '</span></td>' +
            '<td class="text-right"><span class="' + rClass + '">' + formatAmount(rPnl) + '</span></td>' +
            '<td class="text-right"><span class="' + uClass + '">' + formatAmount(uPnl) + '</span></td>' +
            '<td class="text-right"><span class="' + nClass + '">' + formatAmount(netPnl) + '</span></td>' +
        '</tr>';

        // Expanded: show contract sub-groups (each also expandable)
        if (isExpanded) {
            p.contractGroups.forEach(function(cg, cgIdx) {
                var groupKey = p.underlying + '|' + cgIdx;
                var isGroupExpanded = trFnoExpandedGroups[groupKey];
                var shortLabel = cg.isShort ? ' <span style="color:#dc2626;font-size:10px;">(Short)</span>' : '';

                // Sub-group P&L breakdown
                var cgRealised = cg.totalPnl;
                var cgUnrealised = cg.unrealisedPnl || 0;
                var cgDayPnl = cg.dayPnl || 0;
                var cgNet = cgRealised + cgUnrealised;
                var cgExposure = cg.openCost || 0;
                var cgDClass = cgDayPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
                var cgRClass = cgRealised >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
                var cgUClass = cgUnrealised >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
                var cgNClass = cgNet >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';

                // Sub-group avg price
                var cgAvgPrice = (cg.openQty > 0 && cgExposure > 0) ? formatPrice(cgExposure / cg.openQty, false) : '';
                var cgBuyPrice = (!cg.isShort && cgAvgPrice) ? cgAvgPrice : '';
                var cgSellPrice = (cg.isShort && cgAvgPrice) ? cgAvgPrice : '';

                // Sub-group header row (clickable to expand detail rows)
                html += '<tr class="trFno-detail-header trFno-group-row" data-fno-group="' + wmsEsc(groupKey) + '">' +
                    '<td style="padding-left:24px;">' + wmsEsc(cg.groupLabel) + '</td>' +
                    '<td>' + wmsEsc(cg.contractLabel) + shortLabel + '</td>' +
                    '<td class="text-right">' + (cg.openQty > 0 ? formatQuantity(cg.openQty) : '-') + '</td>' +
                    '<td class="trM-buy-start"></td>' +
                    '<td class="text-right">' + cgBuyPrice + '</td>' +
                    '<td class="trM-sell-start"></td>' +
                    '<td class="text-right">' + cgSellPrice + '</td>' +
                    '<td class="text-right trFno-pnl-start">' + (cgExposure > 0 ? formatAmount(cgExposure) : '-') + '</td>' +
                    '<td class="text-right"><span class="' + cgDClass + '">' + (cgDayPnl !== 0 ? formatAmount(cgDayPnl) : '-') + '</span></td>' +
                    '<td class="text-right"><span class="' + cgRClass + '">' + formatAmount(cgRealised) + '</span></td>' +
                    '<td class="text-right"><span class="' + cgUClass + '">' + (cgUnrealised !== 0 ? formatAmount(cgUnrealised) : '-') + '</span></td>' +
                    '<td class="text-right"><span class="' + cgNClass + '">' + formatAmount(cgNet) + '</span></td>' +
                '</tr>';

                // Detail rows — only if sub-group is expanded
                if (isGroupExpanded) {
                    cg.rows.forEach(function(r) {
                        html += trFnoRenderDetailRow(r, cg);
                    });
                }
            });
        }
    });

    return html;
}

// ============================================================================
// RENDERING: Flat view (all rows ungrouped, for snapshot sharing)
// ============================================================================

function trFnoRenderFlat(positions) {
    // Collect all rows
    var flatRows = [];
    positions.forEach(function(p) {
        p.contractGroups.forEach(function(cg) {
            cg.rows.forEach(function(row) {
                flatRows.push({
                    underlying: p.underlying, companyName: p.companyName,
                    contractLabel: cg.contractLabel, groupLabel: cg.groupLabel,
                    isShort: cg.isShort, row: row
                });
            });
        });
    });

    // Sort: open positions first, then closed; within each group sort by symbol then date
    flatRows.sort(function(a, b) {
        var aOpen = a.row.type === 'open' ? 0 : 1;
        var bOpen = b.row.type === 'open' ? 0 : 1;
        if (aOpen !== bOpen) return aOpen - bOpen;
        var c = a.underlying.localeCompare(b.underlying);
        if (c !== 0) return c;
        var dateA = a.row.buyDate || a.row.sellDate || '9999';
        var dateB = b.row.buyDate || b.row.sellDate || '9999';
        return new Date(dateA) - new Date(dateB);
    });

    // Calculate page totals first — exposure only from open positions
    var pageTotExposure = 0, pageTotDayPnl = 0, pageTotRealised = 0, pageTotUnrealised = 0, pageTotNet = 0;
    flatRows.forEach(function(fr) {
        var r = fr.row;
        if (r.type === 'open') {
            pageTotExposure += r.isShort ? r.sellAmount : r.buyAmount;
            pageTotDayPnl += (r.dayPnl !== undefined) ? r.dayPnl : 0;
            pageTotUnrealised += (r.unrealisedPnl !== undefined) ? r.unrealisedPnl : 0;
        }
        if (r.type === 'matched') {
            pageTotRealised += r.pnl;
        }
    });
    pageTotNet = pageTotRealised + pageTotUnrealised;

    // TOTAL row at the top (sticky below header)
    var html = trFnoBuildTotalRow(pageTotExposure, pageTotDayPnl, pageTotRealised, pageTotUnrealised, pageTotNet);

    flatRows.forEach(function(fr) {
        var r = fr.row;
        var isOpen = r.type === 'open';
        var rowClass = 'trFno-detail-row';
        if (isOpen) rowClass += ' trFno-detail-open';

        var buyDateHtml = r.buyDate ? formatDate(r.buyDate) : '-';
        var sellDateHtml = r.sellDate ? formatDate(r.sellDate) : '-';
        var hasBuy = r.buyAvg > 0 || r.buyAmount > 0;
        var hasSell = r.sellAvg > 0 || r.sellAmount > 0;

        var buyPriceHtml = hasBuy ? formatPrice(r.buyAvg, false) : '-';
        var sellPriceHtml = hasSell ? formatPrice(r.sellAvg, false) : '-';

        if (isOpen && r.cmp > 0) {
            if (!r.isShort && !hasSell) {
                sellPriceHtml = '<span class="trM-unrealised">' + formatPrice(r.cmp, false) + '</span>';
            } else if (r.isShort && !hasBuy) {
                buyPriceHtml = '<span class="trM-unrealised">' + formatPrice(r.cmp, false) + '</span>';
            }
        }

        // Exposure = qty × opening price (only for open positions)
        var exposureHtml = '-';
        if (r.type === 'open') {
            var exposure = r.isShort ? r.sellAmount : r.buyAmount;
            exposureHtml = exposure > 0 ? formatAmount(exposure) : '-';
        }

        // P&L columns
        var dayPnl = (r.type === 'open' && r.dayPnl !== undefined) ? r.dayPnl : 0;
        var realisedPnl = (r.type === 'matched') ? r.pnl : 0;
        var unrealisedPnl = (r.type === 'open' && r.unrealisedPnl !== undefined) ? r.unrealisedPnl : 0;
        var netPnl = realisedPnl + unrealisedPnl;

        var dClass = dayPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
        var rClass = realisedPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
        var uClass = unrealisedPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
        var nClass = netPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';

        var dayPnlHtml = (r.type === 'open' && dayPnl !== 0) ? '<span class="trM-unrealised ' + dClass + '">' + formatAmount(dayPnl) + '</span>' : '-';
        var realisedHtml = (r.type === 'matched') ? '<span class="' + rClass + '">' + formatAmount(realisedPnl) + '</span>' : '-';
        var unrealisedHtml = (r.type === 'open' && unrealisedPnl !== 0) ? '<span class="trM-unrealised ' + uClass + '">' + formatAmount(unrealisedPnl) + '</span>' : '-';
        var netHtml = netPnl !== 0 ? '<span class="' + nClass + '">' + formatAmount(netPnl) + '</span>' : '-';

        var dataAttrs = '';
        if (r.buyTxnId) dataAttrs += ' data-buy-txn-id="' + wmsEsc(r.buyTxnId) + '"';
        if (r.sellTxnId) dataAttrs += ' data-sell-txn-id="' + wmsEsc(r.sellTxnId) + '"';

        html += '<tr class="' + rowClass + ' clickable-row" style="cursor:pointer;"' + dataAttrs + '>' +
            '<td>' + wmsEsc(fr.companyName) + '<div class="trFno-symbol-sub">' + wmsEsc(fr.groupLabel) + '</div></td>' +
            '<td>' + wmsEsc(fr.contractLabel) + '</td>' +
            '<td class="text-right">' + formatQuantity(r.qty) + '</td>' +
            '<td class="text-right trM-buy-start">' + buyDateHtml + '</td>' +
            '<td class="text-right">' + buyPriceHtml + '</td>' +
            '<td class="text-right trM-sell-start">' + sellDateHtml + '</td>' +
            '<td class="text-right">' + sellPriceHtml + '</td>' +
            '<td class="text-right trFno-pnl-start">' + exposureHtml + '</td>' +
            '<td class="text-right">' + dayPnlHtml + '</td>' +
            '<td class="text-right">' + realisedHtml + '</td>' +
            '<td class="text-right">' + unrealisedHtml + '</td>' +
            '<td class="text-right">' + netHtml + '</td>' +
        '</tr>';
    });

    return html;
}

// ============================================================================
// RENDERING: Single detail row helper (11 columns)
// Cols: Underlying | Contract | Qty | Buy Date | Buy Price | Sell Date | Sell Price | Exposure | Realised | Unrealised | Net
// ============================================================================

function trFnoRenderDetailRow(r, cg) {
    var isOpen = r.type === 'open';
    var rowClass = 'trFno-detail-row';
    if (isOpen) rowClass += ' trFno-detail-open';

    var buyDateHtml = r.buyDate ? formatDate(r.buyDate) : '-';
    var sellDateHtml = r.sellDate ? formatDate(r.sellDate) : '-';
    var hasBuy = r.buyAvg > 0 || r.buyAmount > 0;
    var hasSell = r.sellAvg > 0 || r.sellAmount > 0;

    var buyPriceHtml = hasBuy ? formatPrice(r.buyAvg, false) : '-';
    var sellPriceHtml = hasSell ? formatPrice(r.sellAvg, false) : '-';

    // CMP display for open positions
    if (isOpen && r.cmp > 0) {
        if (!r.isShort && !hasSell) {
            sellPriceHtml = '<span class="trM-unrealised">' + formatPrice(r.cmp, false) + '</span>';
        } else if (r.isShort && !hasBuy) {
            buyPriceHtml = '<span class="trM-unrealised">' + formatPrice(r.cmp, false) + '</span>';
        }
    }

    // Exposure = qty × opening price (only for open positions)
    var exposureHtml = '-';
    if (r.type === 'open') {
        var exposure = r.isShort ? r.sellAmount : r.buyAmount;
        exposureHtml = exposure > 0 ? formatAmount(exposure) : '-';
    }

    // P&L columns
    var dayPnl = (r.type === 'open' && r.dayPnl !== undefined) ? r.dayPnl : 0;
    var realisedPnl = (r.type === 'matched') ? r.pnl : 0;
    var unrealisedPnl = (r.type === 'open' && r.unrealisedPnl !== undefined) ? r.unrealisedPnl : 0;
    var netPnl = realisedPnl + unrealisedPnl;

    var dClass = dayPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
    var rClass = realisedPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
    var uClass = unrealisedPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
    var nClass = netPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';

    var dayPnlHtml = (r.type === 'open' && dayPnl !== 0) ? '<span class="trM-unrealised ' + dClass + '">' + formatAmount(dayPnl) + '</span>' : '-';
    var realisedHtml = (r.type === 'matched') ? '<span class="' + rClass + '">' + formatAmount(realisedPnl) + '</span>' : '-';
    var unrealisedHtml = (r.type === 'open' && unrealisedPnl !== 0) ? '<span class="trM-unrealised ' + uClass + '">' + formatAmount(unrealisedPnl) + '</span>' : '-';
    var netHtml = netPnl !== 0 ? '<span class="' + nClass + '">' + formatAmount(netPnl) + '</span>' : '-';

    var dataAttrs = '';
    if (r.buyTxnId) dataAttrs += ' data-buy-txn-id="' + wmsEsc(r.buyTxnId) + '"';
    if (r.sellTxnId) dataAttrs += ' data-sell-txn-id="' + wmsEsc(r.sellTxnId) + '"';

    return '<tr class="' + rowClass + ' clickable-row" style="cursor:pointer;"' + dataAttrs + '>' +
        '<td style="padding-left:36px;"></td>' +
        '<td></td>' +
        '<td class="text-right">' + formatQuantity(r.qty) + '</td>' +
        '<td class="text-right trM-buy-start">' + buyDateHtml + '</td>' +
        '<td class="text-right">' + buyPriceHtml + '</td>' +
        '<td class="text-right trM-sell-start">' + sellDateHtml + '</td>' +
        '<td class="text-right">' + sellPriceHtml + '</td>' +
        '<td class="text-right trFno-pnl-start">' + exposureHtml + '</td>' +
        '<td class="text-right">' + dayPnlHtml + '</td>' +
        '<td class="text-right">' + realisedHtml + '</td>' +
        '<td class="text-right">' + unrealisedHtml + '</td>' +
        '<td class="text-right">' + netHtml + '</td>' +
    '</tr>';
}

// ============================================================================
// RENDERING: P&L cell formatter (same logic as txn modal)
// ============================================================================

function trFnoFormatPnl(r) {
    if (r.type === 'open') {
        if (r.unrealisedPnl !== undefined) {
            var uCls = r.unrealisedPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
            var uFmt = r.unrealisedPnl < 0
                ? '(' + formatAmount(Math.abs(r.unrealisedPnl)) + ')'
                : formatAmount(r.unrealisedPnl);
            return '<span class="trM-unrealised ' + uCls + '">' + uFmt + '</span>';
        }
        return '<span class="trM-unrealised">' + (r.isShort ? 'Short Open' : 'Open') + '</span>';
    }
    var cls = r.pnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
    return r.pnl < 0
        ? '<span class="' + cls + '">(' + formatAmount(Math.abs(r.pnl)) + ')</span>'
        : '<span class="' + cls + '">' + formatAmount(r.pnl) + '</span>';
}

// ============================================================================
// RENDERING: Summary footer cards
// ============================================================================

function trFnoRenderSummary(positions) {
    var container = document.getElementById('trFnoSummary');
    if (!container) return;

    var totalRealised = 0, totalUnrealised = 0, totalOpenCost = 0, symbolCount = 0;
    positions.forEach(function(p) {
        totalRealised += p.totalRealisedPnl;
        totalUnrealised += p.totalUnrealisedPnl;
        totalOpenCost += p.totalOpenCost;
        symbolCount++;
    });

    var rClass = totalRealised >= 0 ? 'positive' : 'negative';
    var uClass = totalUnrealised >= 0 ? 'positive' : 'negative';
    var netPnl = totalRealised + totalUnrealised;
    var nClass = netPnl >= 0 ? 'positive' : 'negative';

    container.innerHTML =
        '<div class="trFno-summary-card">' +
            '<div class="trFno-summary-label">Symbols</div>' +
            '<div class="trFno-summary-value">' + symbolCount + '</div>' +
        '</div>' +
        '<div class="trFno-summary-card">' +
            '<div class="trFno-summary-label">Open Cost</div>' +
            '<div class="trFno-summary-value">' + formatAmount(totalOpenCost) + '</div>' +
        '</div>' +
        '<div class="trFno-summary-card">' +
            '<div class="trFno-summary-label">Realised P&L</div>' +
            '<div class="trFno-summary-value ' + rClass + '">' + formatAmount(totalRealised) + '</div>' +
        '</div>' +
        '<div class="trFno-summary-card">' +
            '<div class="trFno-summary-label">Unrealised P&L</div>' +
            '<div class="trFno-summary-value ' + uClass + '">' + formatAmount(totalUnrealised) + '</div>' +
        '</div>' +
        '<div class="trFno-summary-card">' +
            '<div class="trFno-summary-label">Net P&L</div>' +
            '<div class="trFno-summary-value ' + nClass + '">' + formatAmount(netPnl) + '</div>' +
        '</div>';
}

// ============================================================================
// EXPIRY FILTER: Dropdown for F&O tab
// ============================================================================

function trFnoBuildExpiryFilter(expiryLabels) {
    var wrap = document.getElementById('trFnoExpiryWrap');
    if (!wrap) return;
    if (expiryLabels.length <= 1) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = '';

    // Default: current + previous month on first load
    if (trFnoExpiryFilter === null) {
        var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var now = new Date();
        var curMon = monthNames[now.getMonth()];
        var curYY = String(now.getFullYear()).slice(-2);
        var prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        var prevMon = monthNames[prevDate.getMonth()];
        var prevYY = String(prevDate.getFullYear()).slice(-2);
        var defaults = [curMon + ' ' + curYY, prevMon + ' ' + prevYY];
        var matched = expiryLabels.filter(function(el) { return defaults.indexOf(el) >= 0; });
        trFnoExpiryFilter = matched.length > 0 ? matched : [];
    }

    var html = '<button class="trM-cf-btn" id="trFnoExpiryToggle">Expiry ▾</button>' +
        '<div class="trM-cf-dropdown" id="trFnoExpiryDropdown" style="display:none;">';
    expiryLabels.forEach(function(el) {
        var checked = (trFnoExpiryFilter.length === 0 || trFnoExpiryFilter.indexOf(el) >= 0) ? ' checked' : '';
        html += '<label class="trM-cf-item"><input type="checkbox" value="' + wmsEsc(el) + '"' + checked + '> ' + wmsEsc(el) + '</label>';
    });
    html += '</div>';
    wrap.innerHTML = html;

    var toggleBtn = document.getElementById('trFnoExpiryToggle');
    var dropdown = document.getElementById('trFnoExpiryDropdown');
    toggleBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        dropdown.style.display = dropdown.style.display === 'none' ? '' : 'none';
    });

    dropdown.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
        cb.addEventListener('change', function() {
            var checked = [];
            dropdown.querySelectorAll('input[type="checkbox"]:checked').forEach(function(c) {
                checked.push(c.value);
            });
            trFnoExpiryFilter = (checked.length === expiryLabels.length) ? [] : checked;
            trFnoRender();
        });
    });

    document.addEventListener('click', function trFnoExpiryOutside(e) {
        if (!wrap.contains(e.target)) dropdown.style.display = 'none';
    });
}

// ============================================================================
// F&O CONTRACT PRICES: Async fetch for open position CMP
// ============================================================================

async function trFnoFetchAndRefresh(forceRefresh) {
    var txns = trFnoGetTxns();
    var symbols = {};
    txns.forEach(function(t) {
        // Collect full F&O symbols (different from short_symbol)
        if (t.symbol && t.symbol !== t.short_symbol) {
            symbols[t.symbol] = true;
        }
    });
    var symList = Object.keys(symbols);
    if (symList.length > 0 && typeof wmsFetchFnoContractPrices === 'function') {
        await wmsFetchFnoContractPrices(symList, forceRefresh);
        trFnoRender(); // Re-render with updated contract prices
    }
}

// ============================================================================
// AUTO-REFRESH: Uses shared wmsStartAutoRefresh (Rule D.12.11)
// ============================================================================

function trFnoStartAutoRefresh() {
    if (typeof wmsStartAutoRefresh !== 'function') return;
    wmsStartAutoRefresh('fno', {
        interval: 10000,
        fetchFn: function(force) { return trFnoFetchAndRefresh(force); },
        renderFn: null, // trFnoFetchAndRefresh already calls trFnoRender
        isActiveFn: function() {
            var tab = document.getElementById('tr-fno-positions');
            return tab && tab.classList.contains('active');
        }
    });
}

function trFnoStopAutoRefresh() {
    if (typeof wmsStopAutoRefresh === 'function') wmsStopAutoRefresh('fno');
}

// ============================================================================
// SNAPSHOT: Build table image from data for WhatsApp sharing
// Draws directly on canvas — no html2canvas, no scroll/viewport limits
// ============================================================================

function trFnoSnapshot() {
    // Get flat positions data (reuse the same logic as trFnoRenderFlat)
    var positions = window._trFnoLastPositions;
    if (!positions || positions.length === 0) {
        showAlert('No positions to snapshot', 'error', 2000);
        return;
    }

    // Collect flat rows
    var flatRows = [];
    positions.forEach(function(p) {
        p.contractGroups.forEach(function(cg) {
            cg.rows.forEach(function(row) {
                flatRows.push({
                    underlying: p.underlying, companyName: p.companyName,
                    contractLabel: cg.contractLabel, isShort: cg.isShort, row: row
                });
            });
        });
    });

    // Sort: open first, then closed; within each sort by symbol then date
    flatRows.sort(function(a, b) {
        var aOpen = a.row.type === 'open' ? 0 : 1;
        var bOpen = b.row.type === 'open' ? 0 : 1;
        if (aOpen !== bOpen) return aOpen - bOpen;
        var c = a.underlying.localeCompare(b.underlying);
        if (c !== 0) return c;
        var dateA = a.row.buyDate || a.row.sellDate || '9999';
        var dateB = b.row.buyDate || b.row.sellDate || '9999';
        return new Date(dateA) - new Date(dateB);
    });

    // Calculate totals (exposure only from open)
    var totExposure = 0, totRealised = 0, totUnrealised = 0, totNet = 0;
    flatRows.forEach(function(fr) {
        var r = fr.row;
        if (r.type === 'open') {
            totExposure += r.isShort ? r.sellAmount : r.buyAmount;
            totUnrealised += (r.unrealisedPnl !== undefined) ? r.unrealisedPnl : 0;
        }
        if (r.type === 'matched') totRealised += r.pnl;
    });
    totNet = totRealised + totUnrealised;

    // Column definitions: label, width, align (merged underlying+contract into one)
    var cols = [
        { label: 'CONTRACT',    w: 230, align: 'left' },
        { label: 'QTY',         w: 55,  align: 'right' },
        { label: 'BUY DATE',    w: 75,  align: 'right' },
        { label: 'BUY PRICE',   w: 80,  align: 'right' },
        { label: 'SELL DATE',   w: 75,  align: 'right' },
        { label: 'SELL PRICE',  w: 80,  align: 'right' },
        { label: 'EXPOSURE',    w: 80,  align: 'right' },
        { label: 'REALISED P&L', w: 90, align: 'right' },
        { label: 'UNREAL. P&L', w: 90,  align: 'right' },
        { label: 'NET P&L',     w: 85,  align: 'right' }
    ];

    var dpr = 2;
    var pad = 6;
    var rowH = 22;
    var titleH = 22;
    var headerH = 26;
    var totalRowH = 26;
    var totalW = cols.reduce(function(s, c) { return s + c.w; }, 0) + pad * 2;
    var totalH = titleH + headerH + totalRowH + flatRows.length * rowH + pad;

    var canvas = document.createElement('canvas');
    canvas.width = totalW * dpr;
    canvas.height = totalH * dpr;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalW, totalH);

    // Helper to format numbers (divide by 1000 to match page display unit)
    var fmtAmt = function(v) {
        if (v === 0 || v === undefined || v === null) return '-';
        var neg = v < 0;
        var abs = (Math.abs(v) / 1000).toFixed(2);
        var parts = abs.split('.');
        var intPart = parts[0].replace(/\B(?=(\d{2})+(\d)(?!\d))/g, ',');
        var result = intPart + '.' + parts[1];
        return neg ? '(' + result + ')' : result;
    };
    var fmtQty = function(v) {
        return v.toString().replace(/\B(?=(\d{2})+(\d)(?!\d))/g, ',');
    };
    var fmtDate = function(d) {
        if (!d) return '-';
        var dt = new Date(d);
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return ('0' + dt.getDate()).slice(-2) + '-' + months[dt.getMonth()] + '-' + String(dt.getFullYear()).slice(-2);
    };
    var fmtPrice = function(v) {
        if (!v || v === 0) return '-';
        return v.toFixed(2);
    };

    // Draw text helper
    var drawCell = function(text, x, w, y, align, color, bold) {
        ctx.fillStyle = color || '#2d3748';
        ctx.font = (bold ? 'bold ' : '') + '10px -apple-system, BlinkMacSystemFont, sans-serif';
        var tx = align === 'right' ? x + w - 4 : x + 4;
        ctx.textAlign = align === 'right' ? 'right' : 'left';
        ctx.textBaseline = 'middle';
        // Truncate if needed
        var maxW = w - 8;
        if (ctx.measureText(text).width > maxW) {
            while (text.length > 0 && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
            text = text + '…';
        }
        ctx.fillText(text, tx, y);
    };

    // Column borders (buy group, sell group, pnl group)
    var drawColBorders = function(y, h) {
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 0.5;
        // Buy group left border (after CONTRACT, QTY = cols 0,1)
        var bx = pad + cols[0].w + cols[1].w;
        ctx.beginPath(); ctx.moveTo(bx, y); ctx.lineTo(bx, y + h); ctx.stroke();
        // Sell group left border (after BUY DATE, BUY PRICE = cols 2,3)
        var sx = bx + cols[2].w + cols[3].w;
        ctx.beginPath(); ctx.moveTo(sx, y); ctx.lineTo(sx, y + h); ctx.stroke();
        // Pnl group left border (after SELL DATE, SELL PRICE = cols 4,5)
        var px = sx + cols[4].w + cols[5].w;
        ctx.beginPath(); ctx.moveTo(px, y); ctx.lineTo(px, y + h); ctx.stroke();
    };

    var y = 0;

    // --- TITLE ROW ---
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, y, totalW, titleH);
    ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = '#2d3748';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('F&O Positions', pad + 4, y + titleH / 2);
    ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = '#a0aec0';
    ctx.textAlign = 'right';
    var today = new Date();
    var dateStr = ('0' + today.getDate()).slice(-2) + '-' +
        ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][today.getMonth()] + '-' +
        today.getFullYear();
    ctx.fillText('all amounts in \u20B9 \'000  |  ' + dateStr, totalW - pad - 4, y + titleH / 2);
    y += titleH;

    // --- HEADER ROW ---
    ctx.fillStyle = '#f7fafc';
    ctx.fillRect(0, y, totalW, headerH);
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y + headerH); ctx.lineTo(totalW, y + headerH); ctx.stroke();
    var hx = pad;
    cols.forEach(function(col) {
        drawCell(col.label, hx, col.w, y + headerH / 2, col.align, '#718096', true);
        hx += col.w;
    });
    drawColBorders(y, headerH);
    y += headerH;

    // --- TOTAL ROW ---
    ctx.fillStyle = '#edf2f7';
    ctx.fillRect(0, y, totalW, totalRowH);
    ctx.strokeStyle = '#cbd5e0';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, y + totalRowH); ctx.lineTo(totalW, y + totalRowH); ctx.stroke();
    drawCell('TOTAL', pad, cols[0].w, y + totalRowH / 2, 'left', '#2d3748', true);
    var tx = pad;
    for (var ti = 0; ti < 6; ti++) tx += cols[ti].w;
    drawCell(fmtAmt(totExposure), tx, cols[6].w, y + totalRowH / 2, 'right', '#2d3748', true);
    tx += cols[6].w;
    drawCell(fmtAmt(totRealised), tx, cols[7].w, y + totalRowH / 2, 'right', totRealised >= 0 ? '#38a169' : '#e53e3e', true);
    tx += cols[7].w;
    drawCell(fmtAmt(totUnrealised), tx, cols[8].w, y + totalRowH / 2, 'right', totUnrealised >= 0 ? '#38a169' : '#e53e3e', true);
    tx += cols[8].w;
    drawCell(fmtAmt(totNet), tx, cols[9].w, y + totalRowH / 2, 'right', totNet >= 0 ? '#38a169' : '#e53e3e', true);
    drawColBorders(y, totalRowH);
    y += totalRowH;

    // --- DATA ROWS ---
    flatRows.forEach(function(fr, idx) {
        var r = fr.row;
        var isOpen = r.type === 'open';
        var textColor = isOpen ? '#2d3748' : '#a0aec0';

        // Alternate row background
        if (idx % 2 === 1) {
            ctx.fillStyle = '#f9fafb';
            ctx.fillRect(0, y, totalW, rowH);
        }

        // Row bottom border
        ctx.strokeStyle = '#edf2f7';
        ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(0, y + rowH); ctx.lineTo(totalW, y + rowH); ctx.stroke();

        var rx = pad;
        // Contract (merged: symbol + contractLabel)
        var contractName = fr.underlying + ' ' + fr.contractLabel;
        drawCell(contractName, rx, cols[0].w, y + rowH / 2, 'left', textColor, false);
        rx += cols[0].w;
        // Qty
        drawCell(fmtQty(r.qty), rx, cols[1].w, y + rowH / 2, 'right', textColor, false);
        rx += cols[1].w;
        // Buy Date
        drawCell(fmtDate(r.buyDate), rx, cols[2].w, y + rowH / 2, 'right', textColor, false);
        rx += cols[2].w;
        // Buy Price
        var bpText = (r.buyAvg > 0) ? fmtPrice(r.buyAvg) : '-';
        if (isOpen && r.cmp > 0 && r.isShort && !(r.buyAvg > 0)) bpText = fmtPrice(r.cmp);
        drawCell(bpText, rx, cols[3].w, y + rowH / 2, 'right', textColor, false);
        rx += cols[3].w;
        // Sell Date
        drawCell(fmtDate(r.sellDate), rx, cols[4].w, y + rowH / 2, 'right', textColor, false);
        rx += cols[4].w;
        // Sell Price
        var spText = (r.sellAvg > 0) ? fmtPrice(r.sellAvg) : '-';
        if (isOpen && r.cmp > 0 && !r.isShort && !(r.sellAvg > 0)) spText = fmtPrice(r.cmp);
        drawCell(spText, rx, cols[5].w, y + rowH / 2, 'right', textColor, false);
        rx += cols[5].w;
        // Exposure
        var expText = '-';
        if (isOpen) {
            var exp = r.isShort ? r.sellAmount : r.buyAmount;
            expText = exp > 0 ? fmtAmt(exp) : '-';
        }
        drawCell(expText, rx, cols[6].w, y + rowH / 2, 'right', textColor, false);
        rx += cols[6].w;
        // Realised P&L
        var realPnl = (r.type === 'matched') ? r.pnl : 0;
        var realColor = isOpen ? textColor : (realPnl >= 0 ? '#38a169' : '#e53e3e');
        if (!isOpen) realColor = realPnl >= 0 ? '#b7d4c4' : '#e8a8a8';
        drawCell(r.type === 'matched' ? fmtAmt(realPnl) : '-', rx, cols[7].w, y + rowH / 2, 'right', realColor, false);
        rx += cols[7].w;
        // Unrealised P&L
        var unPnl = (isOpen && r.unrealisedPnl !== undefined) ? r.unrealisedPnl : 0;
        var unColor = isOpen ? (unPnl >= 0 ? '#38a169' : '#e53e3e') : textColor;
        drawCell(isOpen && unPnl !== 0 ? fmtAmt(unPnl) : '-', rx, cols[8].w, y + rowH / 2, 'right', unColor, false);
        rx += cols[8].w;
        // Net P&L
        var netPnl = realPnl + unPnl;
        var netColor = textColor;
        if (isOpen) netColor = netPnl >= 0 ? '#38a169' : '#e53e3e';
        else if (r.type === 'matched') netColor = netPnl >= 0 ? '#b7d4c4' : '#e8a8a8';
        drawCell(netPnl !== 0 ? fmtAmt(netPnl) : '-', rx, cols[9].w, y + rowH / 2, 'right', netColor, false);

        drawColBorders(y, rowH);
        y += rowH;
    });

    // Copy canvas to clipboard
    canvas.toBlob(function(blob) {
        if (!blob) { showAlert('Snapshot failed', 'error', 2000); return; }
        if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
            navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(function() {
                showAlert('Snapshot copied to clipboard!', 'success', 2000);
            }).catch(function(err) {
                showAlert('Clipboard copy failed: ' + err.message, 'error', 3000);
            });
        } else {
            showAlert('Clipboard not supported in this browser', 'error', 2000);
        }
    }, 'image/png');
}

// ============================================================================
// SAVE VIEW: State variables and functions (mirrors Portfolio pattern)
// DB: portfolio_views table with module='trading_fno'
// ============================================================================

var trFnoViews = [];
var trFnoActiveViewId = null;
var trFnoRenamingTab = false;

// ---- GET CURRENT FILTERS (shared + F&O-specific) ----

function trFnoGetCurrentFilters() {
    return {
        investorIds: trSelectedInvestorIds.slice(),
        traderIds: trSelectedTraderIds.slice(),
        brokerIds: trSelectedBrokerIds.slice(),
        tagNames: trSelectedTagNames.slice(),
        tagLogic: trTagFilterLogic,
        fnoMode: trFnoMode,
        matchMethod: trFnoMatchMethod,
        expiryFilter: trFnoExpiryFilter ? trFnoExpiryFilter.slice() : [],
        flatView: trFnoFlatView
    };
}

// ---- SYNC F&O PILL STATES (after view apply) ----

function trFnoSyncPillStates() {
    if (trFnoInvPillFilter) trFnoInvPillFilter.syncStates();
    if (trFnoTrdPillFilter) trFnoTrdPillFilter.syncStates();
    if (trFnoBrkPillFilter) trFnoBrkPillFilter.syncStates();
    if (trFnoTagPillFilter) trFnoTagPillFilter.syncStates();
}

function trFnoRenderSelectedTags() {
    if (trFnoInvPillFilter) trFnoInvPillFilter.renderSelectedTags();
    if (trFnoTrdPillFilter) trFnoTrdPillFilter.renderSelectedTags();
    if (trFnoBrkPillFilter) trFnoBrkPillFilter.renderSelectedTags();
    if (trFnoTagPillFilter) trFnoTagPillFilter.renderSelectedTags();
}

// ---- LOAD VIEWS FROM DB ----

async function trFnoLoadViews() {
    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?module=eq.trading_fno&select=id,name,filters,sort_order,is_default,show_in_tabs&order=sort_order.asc,created_at.asc', {
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
        });
        trFnoViews = resp.ok ? await resp.json() : [];
    } catch (err) {
        console.warn('F&O: Failed to load views:', err.message);
        trFnoViews = [];
    }
    trFnoRenderViewTabs();
    trFnoRenderMoreDropdown();
    trFnoUpdateViewButtons();

    // Auto-apply default view on first load
    if (!trFnoActiveViewId) {
        var defaultView = trFnoViews.find(function(v) { return v.is_default; });
        if (defaultView) {
            trFnoApplyView(defaultView.id);
        }
    }
}

// ---- RENDER VIEW TABS ----

function trFnoRenderViewTabs() {
    var container = document.getElementById('tr-fno-view-tabs');
    if (!container) return;

    var defaultView = trFnoViews.find(function(v) { return v.is_default; });
    var tabViews = trFnoViews.filter(function(v) {
        return v.show_in_tabs !== false && !v.is_default;
    });

    var html = '';

    if (defaultView) {
        var isActive = defaultView.id === trFnoActiveViewId;
        html += '<button class="tr-view-tab' + (isActive ? ' active' : '') + '" data-view-id="' + defaultView.id + '">' +
            '<span class="tr-tab-star">\u2605</span> ' + defaultView.name +
            '</button>';
    }

    tabViews.forEach(function(v) {
        var isActive = v.id === trFnoActiveViewId;
        html += '<button class="tr-view-tab' + (isActive ? ' active' : '') + '" data-view-id="' + v.id + '">' +
            v.name +
            ' <span class="tr-tab-close" data-close-id="' + v.id + '" title="Remove from tabs">\u2715</span>' +
            '</button>';
    });

    container.innerHTML = html;

    // Attach click/dblclick handlers
    container.querySelectorAll('.tr-view-tab').forEach(function(tab) {
        var clickTimer = null;
        tab.addEventListener('click', function(e) {
            if (e.target.classList.contains('tr-tab-close')) {
                e.stopPropagation();
                trFnoCloseViewTab(e.target.dataset.closeId);
                return;
            }
            if (clickTimer) clearTimeout(clickTimer);
            clickTimer = setTimeout(function() {
                clickTimer = null;
                if (trFnoRenamingTab) return;
                trFnoApplyView(tab.dataset.viewId);
            }, 250);
        });
        // Double-click to rename
        tab.addEventListener('dblclick', function(e) {
            e.preventDefault();
            e.stopPropagation();
            if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
            trFnoRenamingTab = true;

            var viewId = tab.dataset.viewId;
            var view = trFnoViews.find(function(v) { return v.id === viewId; });
            if (!view) return;

            trFnoActiveViewId = viewId;

            var input = document.createElement('input');
            input.type = 'text';
            input.value = view.name;
            input.style.cssText = 'width:100px; font-size:11px; padding:1px 4px; border:1px solid #667eea; border-radius:3px; outline:none; background:white;';
            tab.innerHTML = '';
            tab.appendChild(input);
            input.focus();
            input.select();

            ['click', 'mousedown', 'mouseup', 'dblclick', 'keydown', 'keyup', 'keypress'].forEach(function(evt) {
                input.addEventListener(evt, function(ie) { ie.stopPropagation(); });
            });

            var finished = false;
            function finishRename() {
                if (finished) return;
                finished = true;
                trFnoRenamingTab = false;
                var newName = input.value.trim();
                if (newName && newName !== view.name) {
                    view.name = newName;
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
                trFnoRenderViewTabs();
                trFnoRenderMoreDropdown();
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

// ---- CLOSE VIEW TAB ----

async function trFnoCloseViewTab(viewId) {
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

    var v = trFnoViews.find(function(v) { return v.id === viewId; });
    if (v) v.show_in_tabs = false;

    if (trFnoActiveViewId === viewId) {
        var defaultView = trFnoViews.find(function(v) { return v.is_default; });
        if (defaultView) {
            trFnoApplyView(defaultView.id);
            return;
        } else {
            trFnoActiveViewId = null;
        }
    }

    trFnoRenderViewTabs();
    trFnoRenderMoreDropdown();
}

// ---- MORE DROPDOWN ----

function trFnoRenderMoreDropdown() {
    var list = document.getElementById('tr-fno-more-list');
    if (!list) return;

    if (trFnoViews.length === 0) {
        list.innerHTML = '<div style="padding:8px 12px; font-size:12px; color:#a0aec0;">No saved views</div>';
        return;
    }

    list.innerHTML = trFnoViews.map(function(v) {
        var isActive = v.id === trFnoActiveViewId;
        var isDefault = v.is_default;
        var inTabs = v.show_in_tabs !== false;
        return '<div class="tr-more-item' + (isActive ? ' active' : '') + '" data-view-id="' + v.id + '">' +
            (isActive ? '<span style="color:#667eea;font-size:11px;">\u2713</span> ' : '<span style="width:16px;display:inline-block;"></span> ') +
            '<span class="tr-more-name">' + v.name + '</span>' +
            (isDefault ? '<span class="tr-more-badge">\u2605 Default</span>' : '') +
            '<span class="tr-more-actions">' +
                (!isDefault ? '<button class="tr-more-action-btn" data-action="default" data-id="' + v.id + '" title="Set as default">\u2605</button>' : '') +
                (inTabs && !isDefault ? '<button class="tr-more-action-btn" data-action="hide-tab" data-id="' + v.id + '" title="Remove from tabs">\u229F</button>' : '') +
                (!inTabs ? '<button class="tr-more-action-btn" data-action="show-tab" data-id="' + v.id + '" title="Show in tabs">\u229E</button>' : '') +
                '<button class="tr-more-action-btn danger" data-action="delete" data-id="' + v.id + '" title="Delete view">\u2715</button>' +
            '</span>' +
        '</div>';
    }).join('');

    // Click to apply
    list.querySelectorAll('.tr-more-item').forEach(function(item) {
        item.addEventListener('click', function(e) {
            if (e.target.closest('.tr-more-action-btn')) return;
            trFnoApplyView(item.dataset.viewId);
            document.getElementById('tr-fno-more-dropdown').style.display = 'none';
        });
    });

    // Action buttons
    list.querySelectorAll('.tr-more-action-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var action = btn.dataset.action;
            var id = btn.dataset.id;
            if (action === 'default') trFnoSetDefaultView(id);
            else if (action === 'hide-tab') trFnoCloseViewTab(id);
            else if (action === 'show-tab') trFnoShowViewTab(id);
            else if (action === 'delete') trFnoDeleteView(id);
        });
    });
}

// ---- APPLY VIEW ----

function trFnoApplyView(viewId) {
    var view = trFnoViews.find(function(v) { return v.id === viewId; });
    if (!view) return;

    // Auto-add to tabs if not already showing
    if (view.show_in_tabs === false || view.show_in_tabs === null) {
        view.show_in_tabs = true;
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

    // Shared filters — mutate in-place to preserve pill controller references
    trSelectedInvestorIds.length = 0;
    Array.prototype.push.apply(trSelectedInvestorIds, f.investorIds || []);
    trSelectedTraderIds.length = 0;
    Array.prototype.push.apply(trSelectedTraderIds, f.traderIds || []);
    trSelectedBrokerIds.length = 0;
    Array.prototype.push.apply(trSelectedBrokerIds, f.brokerIds || []);
    trSelectedTagNames.length = 0;
    Array.prototype.push.apply(trSelectedTagNames, f.tagNames || []);
    trTagFilterLogic = f.tagLogic || 'OR';

    // F&O-specific state
    trFnoMode = f.fnoMode || 'open';
    trFnoMatchMethod = f.matchMethod || 'lifo';
    if (f.expiryFilter !== undefined) {
        trFnoExpiryFilter = f.expiryFilter && f.expiryFilter.length > 0 ? f.expiryFilter.slice() : [];
    }
    trFnoFlatView = f.flatView || false;

    trFnoActiveViewId = viewId;

    // Update F&O pill filter UI
    trFnoSyncPillStates();
    trFnoRenderSelectedTags();

    // Update tag logic radio
    document.querySelectorAll('input[name="tr-fno-tag-logic"]').forEach(function(r) {
        r.checked = r.value === trTagFilterLogic;
    });

    // Update F&O toggle buttons
    document.querySelectorAll('[data-fno-mode]').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.fnoMode === trFnoMode);
    });
    document.querySelectorAll('[data-fno-match]').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.fnoMatch === trFnoMatchMethod);
    });

    // Update flat view checkbox
    var flatToggle = document.getElementById('trFnoFlatToggle');
    if (flatToggle) flatToggle.checked = trFnoFlatView;
    var tableWrap = document.getElementById('trFnoTableWrap');
    if (tableWrap) tableWrap.classList.toggle('trFno-flat-mode', trFnoFlatView);

    trFnoRenderViewTabs();
    trFnoRenderMoreDropdown();
    trFnoUpdateViewButtons();
    trFnoRender();
}

// ---- UPDATE VIEW BUTTONS ----

function trFnoUpdateViewButtons() {
    var updateBtn = document.getElementById('tr-fno-update-view-btn');
    if (updateBtn) {
        updateBtn.disabled = !trFnoActiveViewId;
    }
}

// ---- SAVE CURRENT VIEW ----

async function trFnoSaveCurrentView(name) {
    var filters = trFnoGetCurrentFilters();
    var sortOrder = trFnoViews.length;
    var isFirst = trFnoViews.length === 0;

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/portfolio_views', {
            method: 'POST',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation'
            },
            body: JSON.stringify({ name: name, filters: filters, sort_order: sortOrder, is_default: isFirst, show_in_tabs: true, module: 'trading_fno' })
        });
        if (resp.ok) {
            var rows = await resp.json();
            if (rows.length > 0) {
                trFnoViews.push(rows[0]);
                trFnoActiveViewId = rows[0].id;
                trFnoRenderViewTabs();
                trFnoRenderMoreDropdown();
                trFnoUpdateViewButtons();
                showAlert('View "' + name + '" saved', 'success', 2000);
            }
        } else {
            showAlert('Failed to save view', 'error');
        }
    } catch (err) {
        showAlert('Failed to save view: ' + err.message, 'error');
    }

    // Hide prompt
    document.getElementById('tr-fno-save-prompt').classList.remove('show');
    document.getElementById('tr-fno-save-prompt-name').value = '';
    document.getElementById('tr-fno-save-new-btn').style.display = '';
}

// ---- CREATE BLANK VIEW ----

async function trFnoCreateBlankView() {
    var blankFilters = {};
    var sortOrder = trFnoViews.length;
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
            body: JSON.stringify({ name: name, filters: blankFilters, sort_order: sortOrder, is_default: false, show_in_tabs: true, module: 'trading_fno' })
        });
        if (resp.ok) {
            var rows = await resp.json();
            if (rows.length > 0) {
                trFnoViews.push(rows[0]);
                trFnoApplyView(rows[0].id);
                showAlert('New view created \u2014 double-click tab to rename', 'success', 3000);
            }
        } else {
            showAlert('Failed to create view', 'error');
        }
    } catch (err) {
        showAlert('Failed to create view: ' + err.message, 'error');
    }
}

// ---- UPDATE CURRENT VIEW ----

async function trFnoUpdateCurrentView() {
    if (!trFnoActiveViewId) return;
    var filters = trFnoGetCurrentFilters();

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + trFnoActiveViewId, {
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
            var v = trFnoViews.find(function(v) { return v.id === trFnoActiveViewId; });
            if (v) v.filters = filters;
            showAlert('View updated', 'success', 2000);
        } else {
            showAlert('Failed to update view', 'error');
        }
    } catch (err) {
        showAlert('Failed to update view: ' + err.message, 'error');
    }
}

// ---- DELETE VIEW ----

async function trFnoDeleteView(viewId) {
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
            trFnoViews = trFnoViews.filter(function(v) { return v.id !== viewId; });
            if (trFnoActiveViewId === viewId) {
                trFnoActiveViewId = null;
            }
            trFnoRenderViewTabs();
            trFnoRenderMoreDropdown();
            trFnoUpdateViewButtons();
            showAlert('View deleted', 'success', 2000);
        }
    } catch (err) {
        showAlert('Failed to delete view: ' + err.message, 'error');
    }
}

// ---- SET DEFAULT VIEW ----

async function trFnoSetDefaultView(viewId) {
    var oldDefault = trFnoViews.find(function(v) { return v.is_default; });
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
        var v = trFnoViews.find(function(v) { return v.id === viewId; });
        if (v) { v.is_default = true; v.show_in_tabs = true; }
    } catch (err) {
        console.warn('Failed to set default:', err.message);
    }

    trFnoRenderViewTabs();
    trFnoRenderMoreDropdown();
    showAlert('Default view updated', 'success', 2000);
}

// ---- SHOW VIEW TAB ----

async function trFnoShowViewTab(viewId) {
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

    var v = trFnoViews.find(function(v) { return v.id === viewId; });
    if (v) v.show_in_tabs = true;

    trFnoRenderViewTabs();
    trFnoRenderMoreDropdown();
}
