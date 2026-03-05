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
var trFnoExpiryFilter = [];       // [] = show all, else array of expiry labels
var trFnoFlatView = false;        // true = flat (ungrouped) for snapshot
var trFnoExpandedSymbols = {};    // { symbol: true } for expanded rows
var trFnoInitDone = false;
var trFnoColCount = 10;

function trFnoInit() {
    if (trFnoInitDone) return;
    trFnoInitDone = true;

    // Build interactive filter widgets for F&O tab
    trFnoInitFilters();

    // Open/All toggle
    document.querySelectorAll('.trFno-toggle-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.trFno-toggle-btn').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            trFnoMode = btn.dataset.fnoMode;
            trFnoRender();
        });
    });

    // Match method
    var methodSel = document.getElementById('trFnoMatchMethod');
    if (methodSel) {
        methodSel.addEventListener('change', function() {
            trFnoMatchMethod = methodSel.value;
            trFnoRender();
        });
    }

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

    // Snapshot button
    var snapBtn = document.getElementById('trFnoSnapBtn');
    if (snapBtn) {
        snapBtn.addEventListener('click', trFnoSnapshot);
    }
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
        var symbolTotalRealisedPnl = 0, symbolTotalUnrealisedPnl = 0;
        var symbolTotalOpenQty = 0, symbolTotalCost = 0;
        var symbolTotalBuyAmt = 0, symbolTotalSellAmt = 0;
        var hasOpenPosition = false;

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
                    matchedRows.push({
                        type: 'matched', isShort: isShort, qty: matchQty,
                        buyDate: buyDate, buyAvg: buyAvg, buyAmount: buyAmount,
                        sellDate: sellDate, sellAvg: sellAvg, sellAmount: sellAmount,
                        pnl: sellAmount - buyAmount
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
                } else {
                    row.buyDate = opener.date; row.buyAvg = ppu; row.buyAmount = opener.remaining * ppu;
                    row.sellDate = null; row.sellAvg = 0; row.sellAmount = 0;
                }
                // Unrealised P&L using CMP
                var mockH = { shortSymbol: underlying, symbol: underlying, exchange: 'NSE', latestPrice: 0 };
                var cmp = trGetPrice(mockH);
                if (cmp > 0) {
                    row.cmp = cmp;
                    var openCost = row.isShort ? row.sellAmount : row.buyAmount;
                    var openValue = row.qty * cmp;
                    row.unrealisedPnl = row.isShort ? (openCost - openValue) : (openValue - openCost);
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
            var openQty = 0, unrealisedPnl = 0, openCost = 0;
            matchedRows.forEach(function(r) {
                if (r.type === 'matched') {
                    totalQty += r.qty; totalBuyAmt += r.buyAmount;
                    totalSellAmt += r.sellAmount; totalPnl += r.pnl;
                }
                if (r.type === 'open') {
                    openQty += r.qty;
                    openCost += r.isShort ? r.sellAmount : r.buyAmount;
                    if (r.unrealisedPnl !== undefined) unrealisedPnl += r.unrealisedPnl;
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
            symbolTotalOpenQty += openQty;
            symbolTotalCost += openCost;
            symbolTotalBuyAmt += totalBuyAmt;
            symbolTotalSellAmt += totalSellAmt;

            contractGroups.push({
                groupLabel: groupLabel, contractLabel: g.contractLabel,
                isShort: isShort, rows: matchedRows,
                totalQty: totalQty, totalBuyAmt: totalBuyAmt, totalSellAmt: totalSellAmt,
                totalPnl: totalPnl, openQty: openQty, openCost: openCost,
                unrealisedPnl: unrealisedPnl
            });
        });

        if (contractGroups.length === 0) return;

        // In "open" mode, skip symbols with no open positions
        if (trFnoMode === 'open' && !hasOpenPosition) return;

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

        // Get CMP for underlying
        var mockH = { shortSymbol: underlying, symbol: underlying, exchange: 'NSE', latestPrice: 0 };
        var cmp = trGetPrice(mockH);

        symbolResults.push({
            underlying: underlying, companyName: companyName, cmp: cmp,
            contractGroups: contractGroups,
            totalRealisedPnl: symbolTotalRealisedPnl,
            totalUnrealisedPnl: symbolTotalUnrealisedPnl,
            totalOpenQty: symbolTotalOpenQty,
            totalOpenCost: symbolTotalCost,
            totalBuyAmt: symbolTotalBuyAmt,
            totalSellAmt: symbolTotalSellAmt
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
    if (!positions || positions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="' + trFnoColCount + '" style="text-align:center;padding:40px;color:#9ca3af;">No F&O positions found</td></tr>';
        trFnoRenderSummary(positions || []);
        return;
    }

    var html = trFnoFlatView ? trFnoRenderFlat(positions) : trFnoRenderGrouped(positions);
    tbody.innerHTML = html;

    // Wire symbol row click handlers for expand/collapse (grouped view only)
    if (!trFnoFlatView) {
        tbody.querySelectorAll('.trFno-symbol-row').forEach(function(row) {
            row.addEventListener('click', function() {
                var sym = row.dataset.fnoSymbol;
                if (trFnoExpandedSymbols[sym]) delete trFnoExpandedSymbols[sym];
                else trFnoExpandedSymbols[sym] = true;
                trFnoRender();
            });
        });
    }

    trFnoRenderSummary(positions);
}

// ============================================================================
// RENDERING: Grouped view (symbol → contract group → detail rows)
// Columns: Underlying | Contract | Qty | Buy Date | Buy Price | Buy Amt | Sell Date | Sell Price | Sell Amt | P&L
// ============================================================================

function trFnoRenderGrouped(positions) {
    var html = '';

    positions.forEach(function(p) {
        var isExpanded = trFnoExpandedSymbols[p.underlying];
        var expandIcon = isExpanded ? '▼' : '▶';

        var realisedClass = p.totalRealisedPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';
        var totalPnl = p.totalRealisedPnl + p.totalUnrealisedPnl;
        var totalPnlClass = totalPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';

        // Contract summary
        var contractLabels = {};
        p.contractGroups.forEach(function(cg) { contractLabels[cg.contractLabel] = true; });
        var contractSummary = Object.keys(contractLabels).join(', ');

        // Symbol-level summary row (10 cols)
        html += '<tr class="trFno-symbol-row" data-fno-symbol="' + wmsEsc(p.underlying) + '">' +
            '<td><span class="trFno-collapse-icon">' + expandIcon + '</span> ' +
                '<span class="trFno-symbol-name">' + wmsEsc(p.companyName) + '</span>' +
                '<div class="trFno-symbol-sub">' + wmsEsc(p.underlying) + '</div></td>' +
            '<td style="font-size:10px;color:#718096;">' + wmsEsc(contractSummary) + '</td>' +
            '<td class="text-right">' + (p.totalOpenQty > 0 ? formatQuantity(p.totalOpenQty) : '-') + '</td>' +
            '<td class="trM-buy-start"></td>' +
            '<td class="text-right"></td>' +
            '<td class="text-right">' + (p.totalBuyAmt > 0 ? formatAmount(p.totalBuyAmt) : '-') + '</td>' +
            '<td class="trM-sell-start"></td>' +
            '<td class="text-right"></td>' +
            '<td class="text-right">' + (p.totalSellAmt > 0 ? formatAmount(p.totalSellAmt) : '-') + '</td>' +
            '<td class="text-right"><span class="' + totalPnlClass + '">' + formatAmount(totalPnl) + '</span></td>' +
        '</tr>';

        // Expanded detail
        if (isExpanded) {
            p.contractGroups.forEach(function(cg) {
                var shortLabel = cg.isShort ? ' <span style="color:#dc2626;font-size:10px;">(Short)</span>' : '';
                var grpPnlClass = cg.totalPnl >= 0 ? 'trM-pnl-positive' : 'trM-pnl-negative';

                // Contract group header
                html += '<tr class="trFno-detail-header">' +
                    '<td colspan="3" style="padding-left:24px;">' + wmsEsc(cg.groupLabel) + ' — ' + wmsEsc(cg.contractLabel) + shortLabel + '</td>' +
                    '<td class="trM-buy-start"></td>' +
                    '<td class="text-right"></td>' +
                    '<td class="text-right">' + (cg.totalBuyAmt > 0 ? formatAmount(cg.totalBuyAmt) : '') + '</td>' +
                    '<td class="trM-sell-start"></td>' +
                    '<td class="text-right"></td>' +
                    '<td class="text-right">' + (cg.totalSellAmt > 0 ? formatAmount(cg.totalSellAmt) : '') + '</td>' +
                    '<td class="text-right"><span class="' + grpPnlClass + '">' + formatAmount(cg.totalPnl) + '</span></td>' +
                '</tr>';

                // Detail rows
                cg.rows.forEach(function(r) {
                    html += trFnoRenderDetailRow(r, cg, p.cmp);
                });
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
                    isShort: cg.isShort, row: row, cmp: p.cmp
                });
            });
        });
    });

    // Sort: underlying_symbol, then date (buy for long, sell for short)
    flatRows.sort(function(a, b) {
        var c = a.underlying.localeCompare(b.underlying);
        if (c !== 0) return c;
        var dateA = a.isShort ? (a.row.sellDate || '9999') : (a.row.buyDate || '9999');
        var dateB = b.isShort ? (b.row.sellDate || '9999') : (b.row.buyDate || '9999');
        return new Date(dateA) - new Date(dateB);
    });

    var html = '';
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
        var buyAmtHtml = hasBuy ? formatAmount(r.buyAmount) : '-';
        var sellPriceHtml = hasSell ? formatPrice(r.sellAvg, false) : '-';
        var sellAmtHtml = hasSell ? formatAmount(r.sellAmount) : '-';

        if (isOpen && r.cmp > 0) {
            if (!r.isShort && !hasSell) {
                sellPriceHtml = '<span class="trM-unrealised">' + formatPrice(r.cmp, false) + '</span>';
                sellAmtHtml = '-';
            } else if (r.isShort && !hasBuy) {
                buyPriceHtml = '<span class="trM-unrealised">' + formatPrice(r.cmp, false) + '</span>';
                buyAmtHtml = '-';
            }
        }

        var pnlHtml = trFnoFormatPnl(r);

        html += '<tr class="' + rowClass + '">' +
            '<td>' + wmsEsc(fr.companyName) + '<div class="trFno-symbol-sub">' + wmsEsc(fr.groupLabel) + '</div></td>' +
            '<td>' + wmsEsc(fr.contractLabel) + '</td>' +
            '<td class="text-right">' + formatQuantity(r.qty) + '</td>' +
            '<td class="trM-buy-start">' + buyDateHtml + '</td>' +
            '<td class="text-right">' + buyPriceHtml + '</td>' +
            '<td class="text-right">' + buyAmtHtml + '</td>' +
            '<td class="trM-sell-start">' + sellDateHtml + '</td>' +
            '<td class="text-right">' + sellPriceHtml + '</td>' +
            '<td class="text-right">' + sellAmtHtml + '</td>' +
            '<td class="text-right">' + pnlHtml + '</td>' +
        '</tr>';
    });

    return html;
}

// ============================================================================
// RENDERING: Single detail row helper (10 columns matching txn modal)
// ============================================================================

function trFnoRenderDetailRow(r, cg, cmp) {
    var isOpen = r.type === 'open';
    var rowClass = 'trFno-detail-row';
    if (isOpen) rowClass += ' trFno-detail-open';

    var buyDateHtml = r.buyDate ? formatDate(r.buyDate) : '-';
    var sellDateHtml = r.sellDate ? formatDate(r.sellDate) : '-';
    var hasBuy = r.buyAvg > 0 || r.buyAmount > 0;
    var hasSell = r.sellAvg > 0 || r.sellAmount > 0;

    var buyPriceHtml = hasBuy ? formatPrice(r.buyAvg, false) : '-';
    var buyAmtHtml = hasBuy ? formatAmount(r.buyAmount) : '-';
    var sellPriceHtml = hasSell ? formatPrice(r.sellAvg, false) : '-';
    var sellAmtHtml = hasSell ? formatAmount(r.sellAmount) : '-';

    if (isOpen && r.cmp > 0) {
        if (!r.isShort && !hasSell) {
            sellPriceHtml = '<span class="trM-unrealised">' + formatPrice(r.cmp, false) + '</span>';
            sellAmtHtml = '-';
        } else if (r.isShort && !hasBuy) {
            buyPriceHtml = '<span class="trM-unrealised">' + formatPrice(r.cmp, false) + '</span>';
            buyAmtHtml = '-';
        }
    }

    var pnlHtml = trFnoFormatPnl(r);

    return '<tr class="' + rowClass + '">' +
        '<td style="padding-left:36px;">' + wmsEsc(cg.groupLabel) + '</td>' +
        '<td>' + wmsEsc(cg.contractLabel) + '</td>' +
        '<td class="text-right">' + formatQuantity(r.qty) + '</td>' +
        '<td class="trM-buy-start">' + buyDateHtml + '</td>' +
        '<td class="text-right">' + buyPriceHtml + '</td>' +
        '<td class="text-right">' + buyAmtHtml + '</td>' +
        '<td class="trM-sell-start">' + sellDateHtml + '</td>' +
        '<td class="text-right">' + sellPriceHtml + '</td>' +
        '<td class="text-right">' + sellAmtHtml + '</td>' +
        '<td class="text-right">' + pnlHtml + '</td>' +
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
// SNAPSHOT: Capture table as image for WhatsApp sharing
// ============================================================================

function trFnoSnapshot() {
    var tableWrap = document.getElementById('trFnoTableWrap');
    if (!tableWrap) return;

    // Temporarily switch to flat view for snapshot
    var wasFlat = trFnoFlatView;
    if (!wasFlat) {
        trFnoFlatView = true;
        tableWrap.classList.add('trFno-flat-mode');
        trFnoRender();
    }

    // Use html2canvas (lazy-load if needed)
    if (typeof html2canvas !== 'undefined') {
        html2canvas(tableWrap, { scale: 1.5, backgroundColor: '#ffffff' }).then(function(canvas) {
            // Resize for WhatsApp (max width ~800px)
            var maxW = 800;
            var ratio = canvas.width > maxW ? maxW / canvas.width : 1;
            var resizedCanvas = document.createElement('canvas');
            resizedCanvas.width = canvas.width * ratio;
            resizedCanvas.height = canvas.height * ratio;
            var ctx = resizedCanvas.getContext('2d');
            ctx.drawImage(canvas, 0, 0, resizedCanvas.width, resizedCanvas.height);

            resizedCanvas.toBlob(function(blob) {
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = 'fno-positions-' + new Date().toISOString().slice(0, 10) + '.png';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                showAlert('Snapshot saved!', 'success', 2000);
            }, 'image/png');

            // Restore if needed
            if (!wasFlat) {
                trFnoFlatView = false;
                tableWrap.classList.remove('trFno-flat-mode');
                trFnoRender();
                var cb = document.getElementById('trFnoFlatToggle');
                if (cb) cb.checked = false;
            }
        });
    } else {
        // Dynamically load html2canvas
        var script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
        script.onload = function() { trFnoSnapshot(); };
        document.head.appendChild(script);
        showAlert('Loading snapshot library...', 'info', 2000);
    }
}
