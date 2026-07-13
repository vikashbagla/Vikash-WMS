// ============================================================================
// TRADING MODULE: F&O POSITIONS SUB-MODULE
// Dependencies: trading.js globals (trTransactions, trSelectedInvestorIds,
//   trSelectedTraderIds, trSelectedBrokerIds, trSelectedTagNames,
//   trTagFilterLogic, trGetPrice, trGetLiveData, trInvName, trBrkCode,
//   _wmsTxnGetExpiryLabel, wmsFormatContract, wmsEsc, formatAmount, formatPrice,
//   formatQuantity, formatDate, formatPercent, getAmountClass, showAlert,
//   trBuildFilterWidget, trSelectedInvestorIds etc.)
// ============================================================================

var trFnoMode = 'open';           // 'open' | 'all'
var trFnoMatchMethod = 'lifo';    // 'fifo' | 'lifo'
var trFnoExpiryHide = null;        // exclusion model (§D.12.23): live user override of hidden expiry labels for THIS session. null = no override → derive from the active view's saved filter each render. [] = nothing hidden = everything (incl. new contracts) shown.
var trFnoFlatView = false;        // true = flat (ungrouped) for snapshot
var trFnoExpandedSymbols = {};    // { symbol: true } for expanded symbol rows
var trFnoExpandedGroups = {};     // { 'symbol|idx': true } for expanded sub-group rows
var trFnoMobileContractKey = null; // phone: 'symbol|idx' of the contract row whose detail is expanded
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

    // Settle Expired Options button — lazy-loads trading-expiry.js then opens modal
    var settleBtn = document.getElementById('trFnoSettleExpiredBtn');
    if (settleBtn) {
        settleBtn.addEventListener('click', function() {
            if (typeof trLoadExpiryModule === 'function') {
                trLoadExpiryModule(function() {
                    if (typeof trExpOpen === 'function') trExpOpen();
                });
            }
        });
    }

    // ---- View bar event handlers ----

    // More dropdown toggle — wired via trFnoWireMore() (element-guarded; also
    // re-called from trFnoRenderMobile so the live button is always wired).
    trFnoWireMore();

    // Update View button
    var fnoUpdateBtn = document.getElementById('tr-fno-update-view-btn');
    if (fnoUpdateBtn) {
        fnoUpdateBtn.addEventListener('click', function() {
            if (trFnoVM.activeViewId) trFnoVM.updateCurrentView();
        });
    }

    // New blank view button
    var fnoNewViewBtn = document.getElementById('tr-fno-new-view-btn');
    if (fnoNewViewBtn) {
        fnoNewViewBtn.addEventListener('click', function() {
            trFnoVM.createBlankView();
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
            if (name) trFnoVM.saveCurrentView(name);
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
                if (name) trFnoVM.saveCurrentView(name);
            } else if (e.key === 'Escape') {
                document.getElementById('tr-fno-save-prompt').classList.remove('show');
                fnoSaveName.value = '';
                document.getElementById('tr-fno-save-new-btn').style.display = '';
            }
        });
    }

    // Close More dropdown on outside click — wired ONCE globally (document
    // persists across module reloads, so guard against stacking duplicates).
    if (!window._trFnoMoreOutsideWired) {
        window._trFnoMoreOutsideWired = true;
        document.addEventListener('click', function(e) {
            if (!e.target.closest('#tr-fno-more-btn') && !e.target.closest('#tr-fno-more-dropdown')) {
                var mdd = document.getElementById('tr-fno-more-dropdown');
                if (mdd) mdd.style.display = 'none';
            }
        });
    }

    // Load saved views from DB
    trFnoVM.loadViews();
}

// ============================================================================
// SHARED FILTERS: Build interactive inv/trader/broker/tag pill filters
// Uses the same global selectedIds arrays — changes apply across tabs.
// ============================================================================

var trFnoInvPillFilter = null;
var trFnoTrdPillFilter = null;
var trFnoBrkPillFilter = null;
var trFnoTagPillFilter = null;

/**
 * Reset pill filter refs so trFnoInitFilters() rebuilds them.
 * Called from trading.js after trLoadData() completes when F&O was loaded before data was ready.
 */
function trFnoResetFilters() {
    trFnoInvPillFilter = null;
    trFnoTrdPillFilter = null;
    trFnoBrkPillFilter = null;
    trFnoTagPillFilter = null;
}

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
        var tagItems = wmsBuildTagItems(trTransactions);
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
        txns = txns.filter(function(t) { var tid = t.trader_id || t.investor_id; return tid && trSelectedTraderIds.indexOf(tid) >= 0; });
    }
    if (trSelectedBrokerIds.length > 0) {
        txns = txns.filter(function(t) { return t.broker_id && trSelectedBrokerIds.indexOf(t.broker_id) >= 0; });
    }
    if (trSelectedTagNames.length > 0) {
        txns = txns.filter(function(t) {
            return wmsMatchTagsFilter(t.tags, trSelectedTagNames, trTagFilterLogic);
        });
    }
    return txns;
}

// ============================================================================
// MATCHING: Calculate F&O positions with FIFO/LIFO matching
// ============================================================================

function trFnoCalcPositions(filtersOverride) {
    // MIGRATED (2026-04-11) to the shared FIFO/LIFO cost engine in wms-shared.js.
    // Previously used an inline per-contract matching loop; now delegates to
    // `wmsCalcFifoCost` / `wmsCalcLifoCost` per (investor|trader|broker|contract)
    // slice and consumes `gains[]` for matched rows and `holdings[].lots` for
    // open rows. Live-diff vs the old inline engine: zero delta across
    // fifo/lifo × all/open × filtered/unfiltered. See WMS-LESSONS §J.5.H.
    //
    // Optional `filtersOverride` (added 2026-04-27) lets the Day-P&L banner
    // call this function with the default view's filters instead of the live
    // page filters.  Single source of truth for the F&O computation — no
    // duplicated loop in trading.js, banner totals can never drift from the
    // page (e.g. when a new filter dimension like expiryFilter is added).
    // Shape: { investorIds, traderIds, brokerIds, tagNames, tagLogic,
    //          expiryFilter, fnoMode, matchMethod } — same as
    //          portfolio_views.filters JSON.  Any field omitted falls back
    //          to the corresponding global (live page state).
    var fO = filtersOverride || null;
    var effInvIds   = fO && fO.investorIds  != null ? fO.investorIds  : trSelectedInvestorIds;
    var effTrdIds   = fO && fO.traderIds    != null ? fO.traderIds    : trSelectedTraderIds;
    var effBrkIds   = fO && fO.brokerIds    != null ? fO.brokerIds    : trSelectedBrokerIds;
    var effTagNames = fO && fO.tagNames     != null ? fO.tagNames     : trSelectedTagNames;
    var effTagLogic = fO && fO.tagLogic     != null ? fO.tagLogic     : trTagFilterLogic;
    var effMode     = fO && fO.fnoMode      != null ? fO.fnoMode      : trFnoMode;
    var effMatch    = fO && fO.matchMethod  != null ? fO.matchMethod  : trFnoMatchMethod;

    // Build the F&O txn slice using effective filters (replaces trFnoGetTxns
    // when an override is in play).  Logic mirrors trFnoGetTxns exactly.
    var txns;
    if (fO) {
        txns = trTransactions.filter(function(t) {
            return t.security_type === 'NFO' || t.security_type === 'MCX';
        });
        if (effInvIds && effInvIds.length > 0) txns = txns.filter(function(t) { return effInvIds.indexOf(t.investor_id) >= 0; });
        if (effTrdIds && effTrdIds.length > 0) txns = txns.filter(function(t) { var tid = t.trader_id || t.investor_id; return tid && effTrdIds.indexOf(tid) >= 0; });
        if (effBrkIds && effBrkIds.length > 0) txns = txns.filter(function(t) { return t.broker_id && effBrkIds.indexOf(t.broker_id) >= 0; });
        if (effTagNames && effTagNames.length > 0) txns = txns.filter(function(t) { return wmsMatchTagsFilter(t.tags, effTagNames, effTagLogic); });
    } else {
        txns = trFnoGetTxns();
    }
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
        var expiry = _wmsTxnGetExpiryLabel(wmsFormatContract(t));
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

    // Resolve the effective HIDDEN expiry set (exclusion model, §D.12.23). A view
    // stores the expiries the user HID; everything else — including brand-new
    // contracts — shows. Legacy views that stored an inclusion list convert on
    // the fly via trFnoResolveHide. The override/banner path resolves from the
    // default view's raw filters; the interactive path caches into
    // trFnoExpiryHide once the label universe (expiryKeys) is known.
    // Resolve the effective HIDDEN expiry set (exclusion model, §D.12.23),
    // derived FRESH every render — never cached — so a reload / module re-exec
    // (A.1.2a) always reflects the right source:
    //   • banner/override path → the override's own filters;
    //   • a live user override (trFnoExpiryHide non-null, set by toggling the
    //     dropdown this session) → use it verbatim;
    //   • otherwise → the ACTIVE view's saved filters (wmsViewManager sets
    //     activeViewId BEFORE applyFilters, so this is always current). Legacy
    //     inclusion filters convert inside trFnoResolveHide; genuinely-no-filter
    //     resolves to [] (all shown, incl. new contracts).
    var effHide;
    if (fO) {
        effHide = trFnoResolveHide(fO, expiryKeys);
    } else if (trFnoExpiryHide !== null) {
        effHide = trFnoExpiryHide;
    } else {
        var _activeView = (typeof trFnoVM !== 'undefined' && trFnoVM && trFnoVM.activeViewId && Array.isArray(trFnoVM.views))
            ? trFnoVM.views.find(function(v) { return v && v.id === trFnoVM.activeViewId; })
            : null;
        effHide = trFnoResolveHide(_activeView ? _activeView.filters : null, expiryKeys);
    }

    // Rebuild the expiry dropdown on render — but NOT while it's open, and not
    // on the banner-override path. Skipping the rebuild while open lets the user
    // toggle several expiries in one go: each toggle re-filters the table live,
    // but the dropdown DOM persists and only closes on outside-click (same as
    // the tag dropdown). §D.12.23
    var _expDd = document.getElementById('trFnoExpiryDropdown');
    var _expOpen = !!(_expDd && _expDd.style.display !== 'none');
    if (!fO && !_expOpen) trFnoBuildExpiryFilter(expiryKeys, effHide);

    // Process each underlying symbol
    var symbolResults = [];
    var todayStr = new Date().toISOString().slice(0, 10);
    var matchMethod = effMatch === 'lifo' ? 'lifo' : 'fifo';

    Object.keys(bySymbol).sort().forEach(function(underlying) {
        var symbolTrades = bySymbol[underlying];

        // Second level: group by inv + trader + broker + full symbol (contract)
        // The engine is invoked once per group on the group's full txn slice.
        var groups = {};
        symbolTrades.forEach(function(t) {
            var invId = t.investor_id || '';
            var trdId = t.trader_id || t.investor_id || '';  // normalize: empty trader = investor
            var brkId = t.broker_id || '';
            var fullSym = (t.symbol || t.short_symbol || '').replace(/^[A-Z]+:/, '');
            var key = invId + '|' + trdId + '|' + brkId + '|' + fullSym;
            if (!groups[key]) {
                groups[key] = {
                    investorId: t.investor_id, traderId: t.trader_id, brokerId: t.broker_id,
                    fullSymbol: fullSym, shortSymbol: t.short_symbol || t.symbol || '',
                    contractLabel: wmsFormatContract(t), txns: []
                };
            }
            groups[key].txns.push(t);
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
            var contractExpiry = _wmsTxnGetExpiryLabel(g.contractLabel);

            // Apply expiry filter (exclusion model, §D.12.23): hide only the
            // labels the user explicitly hid; everything else — incl. new
            // contracts — shows.
            if (effHide && effHide.length > 0 && effHide.indexOf(contractExpiry) >= 0) return;

            // Sort chronologically: date, then time (null = 00:00:00), then id as tie-breaker
            var sorted = g.txns.slice().sort(function(a, b) {
                var da = a.transaction_date || '', db = b.transaction_date || '';
                if (da !== db) return da < db ? -1 : 1;
                var ta = a.transaction_time || '', tb = b.transaction_time || '';
                if (ta !== tb) return ta < tb ? -1 : 1;
                return (a.id || 0) - (b.id || 0);
            });

            // Delegate to shared engine — it walks txns, matches lots per
            // FIFO/LIFO, records gains[] (matched) and holdings[].lots (open).
            var result = matchMethod === 'lifo' ? wmsCalcLifoCost(sorted) : wmsCalcFifoCost(sorted);

            // Contract-level CMP (wmsLivePrices keyed by bare symbol).
            var contractCache = wmsLivePrices[g.fullSymbol];
            var cmp = contractCache ? contractCache.lp : 0;

            var matchedRows = [];

            // Matched rows come from gains[]. Short-cover gains have buyDate > sellDate.
            result.gains.forEach(function(gain) {
                var rowIsShort = gain.sellDate < gain.buyDate;
                var mRow = {
                    type: 'matched', isShort: rowIsShort, qty: gain.qty,
                    buyDate: gain.buyDate, buyAvg: gain.buyCostPerUnit, buyAmount: gain.buyCost,
                    sellDate: gain.sellDate, sellAvg: gain.sellProceedsPerUnit, sellAmount: gain.sellProceeds,
                    pnl: gain.gain,
                    buyTxnId: gain.buyTxnId, sellTxnId: gain.sellTxnId
                };
                // Day P&L for positions closed today (closer = buy for short, sell for long)
                var closerDate = rowIsShort ? gain.buyDate : gain.sellDate;
                if (closerDate === todayStr) {
                    var openerDate = rowIsShort ? gain.sellDate : gain.buyDate;
                    var openerPpu  = rowIsShort ? gain.sellProceedsPerUnit : gain.buyCostPerUnit;
                    var closerPpu  = rowIsShort ? gain.buyCostPerUnit : gain.sellProceedsPerUnit;
                    var dp = wmsCalcFnoClosedTodayPnl(gain.qty, rowIsShort, openerDate, openerPpu, closerPpu, contractCache, todayStr);
                    if (dp !== 0) mRow.dayPnl = dp;
                }
                matchedRows.push(mRow);
            });

            // Open rows come from holdings[].lots. Engine invariant: within a
            // single contract slice, all surviving lots have the same sign
            // (all long or all short) because BUY-covers-short consumes shorts
            // before pushing long, and SELL-consumes-long before pushing short.
            Object.keys(result.holdings).forEach(function(hk) {
                var h = result.holdings[hk];
                h.lots.forEach(function(lot) {
                    if (!lot.qty) return;
                    var lotIsShort = lot.qty < 0;
                    var absQty = Math.abs(lot.qty);
                    var ppu = lot.costPerUnit;
                    var row = { type: 'open', isShort: lotIsShort, qty: absQty, pnl: 0 };
                    if (lotIsShort) {
                        row.buyDate = null; row.buyAvg = 0; row.buyAmount = 0;
                        row.sellDate = lot.date; row.sellAvg = ppu; row.sellAmount = absQty * ppu;
                        row.sellTxnId = lot.txnId;
                    } else {
                        row.buyDate = lot.date; row.buyAvg = ppu; row.buyAmount = absQty * ppu;
                        row.sellDate = null; row.sellAvg = 0; row.sellAmount = 0;
                        row.buyTxnId = lot.txnId;
                    }
                    if (cmp > 0) {
                        row.cmp = cmp;
                        var openCostR = lotIsShort ? row.sellAmount : row.buyAmount;
                        var openValue = absQty * cmp;
                        row.unrealisedPnl = lotIsShort ? (openCostR - openValue) : (openValue - openCostR);
                    }
                    var tradeDate  = lotIsShort ? row.sellDate : row.buyDate;
                    var tradePrice = lotIsShort ? row.sellAvg  : row.buyAvg;
                    var dpO = wmsCalcFnoDayPnl(absQty, lotIsShort, tradeDate, tradePrice, contractCache);
                    if (dpO !== 0) row.dayPnl = dpO;
                    matchedRows.push(row);
                });
            });

            if (matchedRows.length === 0) return;

            // Group isShort: use an open lot's direction if any; otherwise fall
            // back to the first matched row (fully-closed group).
            var isShort = false;
            var openRow = null;
            for (var ri = 0; ri < matchedRows.length; ri++) {
                if (matchedRows[ri].type === 'open') { openRow = matchedRows[ri]; break; }
            }
            if (openRow) isShort = openRow.isShort;
            else if (matchedRows.length > 0) isShort = matchedRows[0].isShort;

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
                    if (r.dayPnl !== undefined) dayPnl += r.dayPnl;  // closed-today Day P&L
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
                fullSymbol: g.fullSymbol,
                isShort: isShort, isFuture: isFuture, rows: matchedRows,
                totalQty: totalQty, totalBuyAmt: totalBuyAmt, totalSellAmt: totalSellAmt,
                totalPnl: totalPnl, openQty: openQty, openCost: openCost,
                unrealisedPnl: unrealisedPnl, dayPnl: dayPnl
            });
        });

        if (contractGroups.length === 0) return;

        // In "open" mode, filter contract groups to only those with open positions
        if (effMode === 'open') {
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
    trFnoInitFilters();  // Idempotent — rebuilds only if pill refs are null
    var tbody = document.getElementById('trFnoBody');
    if (!tbody) return;

    var positions = trFnoCalcPositions();
    window._trFnoLastPositions = positions;  // Store for snapshot
    if (!positions || positions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="' + trFnoColCount + '" style="text-align:center;padding:40px;color:#9ca3af;">No F&O positions found</td></tr>';
        var emptyCards = document.getElementById('tr-fno-cards');
        if (emptyCards) emptyCards.innerHTML = '<div class="trm-empty">No F&O positions found</div>';
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

    // Phone compact list — grouped by symbol, same positions data as the table
    trFnoRenderMobile(positions);

    // On first F&O render, rebuild symbol list (may include new F&O contracts)
    // and trigger a refresh. Subsequent refreshes handled by standard timer.
    if (!trFnoContractPricesFetched && window.fyersToken) {
        trFnoContractPricesFetched = true;
        if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
        if (typeof wmsStandardRefresh === 'function') wmsStandardRefresh(true);
    }
}

// ============================================================================
// PHONE COMPACT LIST (≤480px) — grouped by symbol → contract rows → tap-to-expand
// Reuses the SAME positions objects the desktop table renders from. Symbol-level
// expand reuses trFnoExpandedSymbols (so Collapse/Expand-all drives it too);
// contract-detail expand uses trFnoMobileContractKey.
// ============================================================================
// Distinct investor + broker names for a contract group (resolved from the
// leg transactions via shared trInvName / trBrkCode).
function trFnoCgParties(cg) {
    var ids = {};
    (cg.rows || []).forEach(function(r) { if (r.buyTxnId) ids[r.buyTxnId] = 1; if (r.sellTxnId) ids[r.sellTxnId] = 1; });
    var invs = {}, brks = {};
    Object.keys(ids).forEach(function(id) {
        var t = (typeof trTransactions !== 'undefined') ? trTransactions.find(function(x) { return x.id === id; }) : null;
        if (t) { invs[trInvName(t.investor_id)] = 1; var bc = trBrkCode(t.broker_id); if (bc) brks[bc] = 1; }
    });
    return { inv: Object.keys(invs).join(', ') || '-', brk: Object.keys(brks).join(', ') || '-' };
}

// Signed qty display — short positions show as negative (in parentheses).
function trFnoQty(q) {
    return q < 0 ? '(' + formatQuantity(Math.abs(q)) + ')' : formatQuantity(q);
}

// CMP (₹) only for a contract group (from the open leg).
function trFnoCgCmp(cg) {
    var o = (cg.rows || []).filter(function(r) { return r.type === 'open' && r.cmp > 0; })[0];
    return o ? trFmtRupee(o.cmp) : '-';
}

// CMP (₹) + day% for a contract group (CMP from open leg, day% from live cache).
function trFnoCgCmpDay(cg) {
    var openRow = (cg.rows || []).filter(function(r) { return r.type === 'open' && r.cmp > 0; })[0];
    if (!openRow) return '-';
    var chp = null;
    if (cg.fullSymbol) { var fc = wmsLivePrices[cg.fullSymbol.replace(/^[A-Z]+:/, '')]; if (fc && fc.chp !== undefined && fc.chp !== null) chp = fc.chp; }
    return trFmtRupee(openRow.cmp) + (chp != null ? ' <span class="' + getAmountClass(chp) + '">' + formatPercent(chp) + '</span>' : '');
}

// Wire the ▾More dropdown toggle on the (live) F&O view-tabs button. Element-
// guarded via dataset so repeated calls never stack listeners; repositions to
// the viewport synchronously on open (phone) so it can't be clipped or raced
// by F&O's frequent live-price re-renders.
function trFnoWireMore() {
    var btn = document.getElementById('tr-fno-more-btn');
    if (!btn || btn.dataset.moreWired) return;
    btn.dataset.moreWired = '1';
    btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var dd = document.getElementById('tr-fno-more-dropdown');
        if (!dd) return;
        var willOpen = (dd.style.display === 'none' || dd.style.display === '');
        dd.style.display = willOpen ? 'block' : 'none';
        if (willOpen && typeof trReposDropdownMobile === 'function') trReposDropdownMobile(dd, btn);
    });
}

function trFnoRenderMobile(positions) {
    var box = document.getElementById('tr-fno-cards');
    if (!box) return;
    trFnoWireMore();
    if (!positions || positions.length === 0) {
        box.innerHTML = '<div class="trm-empty">No F&O positions found</div>';
        return;
    }

    // Same ordering as grouped table: symbols with any open position first, then alpha
    var ordered = positions.slice().sort(function(a, b) {
        var ao = (a.contractGroups || []).some(function(cg) { return cg.openQty > 0; }) ? 0 : 1;
        var bo = (b.contractGroups || []).some(function(cg) { return cg.openQty > 0; }) ? 0 : 1;
        if (ao !== bo) return ao - bo;
        return (a.underlying || '').localeCompare(b.underlying || '');
    });

    var totExp = 0, totDay = 0, totReal = 0, totUnreal = 0;
    ordered.forEach(function(p) { totExp += p.totalOpenCost; totDay += p.totalDayPnl || 0; totReal += p.totalRealisedPnl; totUnreal += p.totalUnrealisedPnl; });
    var totNet = totReal + totUnreal;

    // Single clean row that is BOTH the page totals AND the column headers
    var totRow =
        '<div class="trm-fno-tot fc3">' +
            '<div class="fc-a"><span class="trm-tot-k">Exposure</span> <span class="trm-tot-v">' + formatAmount(totExp) + '</span></div>' +
            '<div class="fc-b"><div class="trm-tot-k">Day\'s P&L</div><div class="trm-tot-v ' + getAmountClass(totDay) + '">' + formatAmount(totDay) + '</div></div>' +
            '<div class="fc-c"><div class="trm-tot-k">Total P&L</div><div class="trm-tot-v ' + getAmountClass(totNet) + '">' + formatAmount(totNet) + '</div></div>' +
        '</div>';

    var body = ordered.map(function(p) {
        var symOpen = !!trFnoExpandedSymbols[p.underlying];
        var net = p.totalRealisedPnl + p.totalUnrealisedPnl;

        // 3-zone line 2 (mirrors Portfolio): Qty@Avg (left) · CMP day% (middle) ·
        // net P&L% of exposure (right). Values from the representative open
        // contract (prefer the open futures leg). Ticker/expiry → expanded detail.
        var exposure = p.totalOpenCost;
        var repCg = (p.contractGroups || []).filter(function(cg) { return cg.isFuture && cg.openQty; })[0]
                 || (p.contractGroups || []).filter(function(cg) { return cg.openQty; })[0];
        // Symbol-level Qty/Avg = TOTAL across all open contracts (the per-contract
        // breakup is shown when expanded). CMP from the representative contract.
        // Symbol Qty/Avg = FUTURES ONLY (options do not change a future's qty or
        // avg — see trFnoCalcPositions "options distort qty"). Short = negative.
        // CMP from the representative (futures-preferred) contract. Options-only
        // symbols fall back to their representative option contract.
        var aL2;
        if (p.futOpenQty > 0) {
            var sQ = p.futIsShort ? -p.futOpenQty : p.futOpenQty;
            aL2 = trFnoQty(sQ) + ' <span class="trm-at">@</span> ' + trFmtRupee(p.futAvgCost) + ' &middot; ' + (repCg ? trFnoCgCmpDay(repCg) : '-');
        } else if (repCg) {
            var oQ = repCg.isShort ? -Math.abs(repCg.openQty) : Math.abs(repCg.openQty);
            var oAvg = (repCg.openQty && repCg.openCost) ? trFmtRupee(repCg.openCost / Math.abs(repCg.openQty)) : '-';
            aL2 = trFnoQty(oQ) + ' <span class="trm-at">@</span> ' + oAvg + ' &middot; ' + trFnoCgCmpDay(repCg);
        } else {
            aL2 = '<span style="color:#a0aec0;">Closed</span>';
        }
        var dPnl = p.totalDayPnl || 0;
        var dPctS = (exposure > 0 && dPnl !== 0) ? formatPercent((dPnl / exposure) * 100) : '';
        var nPctS = (exposure > 0 && net !== 0) ? formatPercent((net / exposure) * 100) : '';

        var grp =
            '<div class="trm-grp" data-fno-symbol="' + wmsEsc(p.underlying) + '">' +
                '<div class="fc3">' +
                    '<div class="fc-a">' +
                        '<div class="fc-a-l1"><span class="fc-a-txt">' + wmsEsc(p.companyName || p.underlying) + '</span></div>' +
                        '<div class="fc-a-l2">' + aL2 + '</div>' +
                    '</div>' +
                    '<div class="fc-b"><div class="fc-amt ' + getAmountClass(dPnl) + '">' + formatAmount(dPnl) + '</div><div class="fc-pct ' + getAmountClass(dPnl) + '">' + dPctS + '</div></div>' +
                    '<div class="fc-c"><div class="fc-amt ' + getAmountClass(net) + '">' + formatAmount(net) + '</div><div class="fc-pct ' + getAmountClass(net) + '">' + nPctS + '</div></div>' +
                '</div>' +
            '</div>';

        var contracts = '';
        if (symOpen) {
            contracts = p.contractGroups.map(function(cg, cgIdx) {
                var key = p.underlying + '|' + cgIdx;
                var cOpen = trFnoMobileContractKey === key;
                var cReal = cg.totalPnl || 0, cUnreal = cg.unrealisedPnl || 0, cNet = cReal + cUnreal, cDay = cg.dayPnl || 0, cExp = cg.openCost || 0;
                var shortTag = cg.isShort ? ' <span style="color:#dc2626;font-size:10px;">(S)</span>' : '';
                var avg = (cg.openQty && cExp) ? trFmtRupee(cExp / cg.openQty) : '-';
                var cSignedQty = cg.isShort ? -Math.abs(cg.openQty) : Math.abs(cg.openQty);
                var caL2 = trFnoQty(cSignedQty) + ' <span class="trm-at">@</span> ' + avg + ' &middot; ' + trFnoCgCmpDay(cg);
                var cDPctS = (cExp > 0 && cDay !== 0) ? formatPercent((cDay / cExp) * 100) : '';
                var cNPctS = (cExp > 0 && cNet !== 0) ? formatPercent((cNet / cExp) * 100) : '';

                var row =
                    '<div class="trm-row trm-sub' + (cOpen ? ' trm-open' : '') + '" data-fno-ckey="' + wmsEsc(key) + '">' +
                        '<div class="fc3">' +
                            '<div class="fc-a">' +
                                '<div class="fc-a-l1"><span class="fc-a-txt">' + wmsEsc(cg.contractLabel) + shortTag + '</span></div>' +
                                '<div class="fc-a-l2">' + caL2 + '</div>' +
                            '</div>' +
                            '<div class="fc-b"><div class="fc-amt ' + getAmountClass(cDay) + '">' + formatAmount(cDay) + '</div><div class="fc-pct ' + getAmountClass(cDay) + '">' + cDPctS + '</div></div>' +
                            '<div class="fc-c"><div class="fc-amt ' + getAmountClass(cNet) + '">' + formatAmount(cNet) + '</div><div class="fc-pct ' + getAmountClass(cNet) + '">' + cNPctS + '</div></div>' +
                        '</div>' +
                    '</div>';

                var detail = '';
                if (cOpen) {
                    var openRow = (cg.rows || []).filter(function(r) { return r.type === 'open' && r.cmp > 0; })[0];
                    var cmpStr = openRow ? trFmtRupee(openRow.cmp) : '-';
                    var parties = trFnoCgParties(cg);
                    detail =
                        '<div class="trm-detail"><div class="trm-detail-grid">' +
                            '<div class="trm-d-item"><span class="trm-d-k">Symbol</span><span class="trm-d-v">' + wmsEsc(p.underlying) + '</span></div>' +
                            '<div class="trm-d-item"><span class="trm-d-k">Expiry</span><span class="trm-d-v">' + wmsEsc(cg.groupLabel || '-') + '</span></div>' +
                            '<div class="trm-d-item"><span class="trm-d-k">Open qty</span><span class="trm-d-v">' + formatQuantity(cg.openQty) + '</span></div>' +
                            '<div class="trm-d-item"><span class="trm-d-k">Avg</span><span class="trm-d-v">' + avg + '</span></div>' +
                            '<div class="trm-d-item"><span class="trm-d-k">CMP</span><span class="trm-d-v">' + cmpStr + '</span></div>' +
                            '<div class="trm-d-item"><span class="trm-d-k">Day P&L</span><span class="trm-d-v ' + getAmountClass(cDay) + '">' + formatAmount(cDay) + '</span></div>' +
                            '<div class="trm-d-item"><span class="trm-d-k">Exposure</span><span class="trm-d-v">' + formatAmount(cExp) + '</span></div>' +
                            '<div class="trm-d-item"><span class="trm-d-k">Realised</span><span class="trm-d-v ' + getAmountClass(cReal) + '">' + formatAmount(cReal) + '</span></div>' +
                            '<div class="trm-d-item"><span class="trm-d-k">Unrealised</span><span class="trm-d-v ' + getAmountClass(cUnreal) + '">' + formatAmount(cUnreal) + '</span></div>' +
                            '<div class="trm-d-item"><span class="trm-d-k">Net</span><span class="trm-d-v ' + getAmountClass(cNet) + '">' + formatAmount(cNet) + '</span></div>' +
                            '<div class="trm-d-item trm-d-wide"><span class="trm-d-k">Investor</span><span class="trm-d-v">' + wmsEsc(parties.inv) + '</span></div>' +
                            '<div class="trm-d-item trm-d-wide"><span class="trm-d-k">Broker</span><span class="trm-d-v">' + wmsEsc(parties.brk) + '</span></div>' +
                        '</div></div>';
                }
                return row + detail;
            }).join('');
        }
        return grp + contracts;
    }).join('');

    box.innerHTML = totRow + body;

    box.querySelectorAll('.trm-grp[data-fno-symbol]').forEach(function(el) {
        el.addEventListener('click', function() {
            var sym = el.dataset.fnoSymbol;
            if (trFnoExpandedSymbols[sym]) delete trFnoExpandedSymbols[sym]; else trFnoExpandedSymbols[sym] = true;
            trFnoRender();
        });
    });
    box.querySelectorAll('.trm-row[data-fno-ckey]').forEach(function(el) {
        el.addEventListener('click', function(e) {
            e.stopPropagation();
            var key = el.dataset.fnoCkey;
            trFnoMobileContractKey = (trFnoMobileContractKey === key) ? null : key;
            trFnoRender();
        });
    });
}

// ============================================================================
// RENDERING: Total row helper (split into cells so borders show)
// ============================================================================

function trFnoBuildTotalRow(totExposure, totDayPnl, totRealised, totUnrealised, totNet) {
    // No color class for zero (neutral '-' display)
    var ptDClass = totDayPnl === 0 ? '' : (totDayPnl > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');
    var ptRClass = totRealised === 0 ? '' : (totRealised > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');
    var ptUClass = totUnrealised === 0 ? '' : (totUnrealised > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');
    var ptNClass = totNet === 0 ? '' : (totNet > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');

    // % of exposure for Day's P&L, Unreal P&L, Net P&L in total row
    var totDPctHtml = '', totUPctHtml = '', totNPctHtml = '';
    if (totExposure > 0) {
        var dPct = (totDayPnl / totExposure) * 100;
        var uPct = (totUnrealised / totExposure) * 100;
        var nPct = (totNet / totExposure) * 100;
        totDPctHtml = '<div style="font-size:11px;" class="' + ptDClass + '">(' + (dPct >= 0 ? '+' : '') + dPct.toFixed(2) + '%)</div>';
        totUPctHtml = '<div style="font-size:11px;" class="' + ptUClass + '">(' + (uPct >= 0 ? '+' : '') + uPct.toFixed(2) + '%)</div>';
        totNPctHtml = '<div style="font-size:11px;" class="' + ptNClass + '">(' + (nPct >= 0 ? '+' : '') + nPct.toFixed(2) + '%)</div>';
    }

    return '<tr class="trFno-total-row">' +
        '<td colspan="3">TOTAL</td>' +
        '<td colspan="2" class="trM-buy-start"></td>' +
        '<td colspan="2" class="trM-sell-start"></td>' +
        '<td class="text-right trFno-pnl-start">' + formatAmount(totExposure) + '</td>' +
        '<td class="text-right"><span class="' + ptDClass + '">' + formatAmount(totDayPnl) + '</span>' + totDPctHtml + '</td>' +
        '<td class="text-right"><span class="' + ptRClass + '">' + formatAmount(totRealised) + '</span></td>' +
        '<td class="text-right"><span class="' + ptUClass + '">' + formatAmount(totUnrealised) + '</span>' + totUPctHtml + '</td>' +
        '<td class="text-right"><span class="' + ptNClass + '">' + formatAmount(totNet) + '</span>' + totNPctHtml + '</td>' +
    '</tr>';
}

// ============================================================================
// RENDERING: Grouped view (symbol → contract group → detail rows)
// ============================================================================

function trFnoRenderGrouped(positions) {
    // Sort: symbols with any open position first, then fully-closed symbols.
    // Within each half keep the existing alphabetical underlying order.
    // In "Open" mode positions only contains open symbols already, so this
    // is a no-op there. Matches the flat-view ordering (line 887-897).
    // 2026-05-12 — owner request: in "All" mode show open positions on top.
    positions.sort(function(a, b) {
        var aOpen = (a.contractGroups || []).some(function(cg) { return cg.openQty > 0; }) ? 0 : 1;
        var bOpen = (b.contractGroups || []).some(function(cg) { return cg.openQty > 0; }) ? 0 : 1;
        if (aOpen !== bOpen) return aOpen - bOpen;
        return (a.underlying || '').localeCompare(b.underlying || '');
    });

    // Page totals — exposure = only open positions
    var pageTotExposure = 0, pageTotDayPnl = 0, pageTotRealised = 0, pageTotUnrealised = 0, pageTotNet = 0;

    positions.forEach(function(p) {
        pageTotExposure += p.totalOpenCost;
        pageTotDayPnl += p.totalDayPnl || 0;
        pageTotRealised += p.totalRealisedPnl;
        pageTotUnrealised += p.totalUnrealisedPnl;
        pageTotNet += p.totalRealisedPnl + p.totalUnrealisedPnl;
    });

    // Banner stats now computed from default view filters via trFnoBannerRefreshFromDefault()

    // TOTAL row at the top (sticky below header)
    var html = trFnoBuildTotalRow(pageTotExposure, pageTotDayPnl, pageTotRealised, pageTotUnrealised, pageTotNet);

    positions.forEach(function(p) {
        var isExpanded = trFnoExpandedSymbols[p.underlying];

        var rPnl = p.totalRealisedPnl;
        var uPnl = p.totalUnrealisedPnl;
        var dPnl = p.totalDayPnl || 0;
        var netPnl = rPnl + uPnl;
        var exposure = p.totalOpenCost;
        // No color class for zero (neutral '-' display)
        var dClass = dPnl === 0 ? '' : (dPnl > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');
        var rClass = rPnl === 0 ? '' : (rPnl > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');
        var uClass = uPnl === 0 ? '' : (uPnl > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');
        var nClass = netPnl === 0 ? '' : (netPnl > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');

        // Avg cost: buy-price if net long, sell-price if net short
        var avgBuyPrice = (!p.futIsShort && p.futAvgCost > 0) ? formatPrice(p.futAvgCost, false) : '';
        var avgSellPrice = (p.futIsShort && p.futAvgCost > 0) ? formatPrice(p.futAvgCost, false) : '';

        // Current month contract % change + live CMP — find nearest-expiry futures contract
        var contractChpHtml = '';
        var futCmpStr = '';
        var nearestFut = null;
        p.contractGroups.forEach(function(cg) {
            if (!cg.isFuture || !cg.openQty) return;
            // Pick first futures contract with open positions (they're sorted by expiry)
            if (!nearestFut) nearestFut = cg;
        });
        if (nearestFut && nearestFut.fullSymbol) {
            var futSym = nearestFut.fullSymbol.replace(/^[A-Z]+:/, '');
            var futCache = wmsLivePrices[futSym];
            if (futCache && futCache.chp !== undefined) {
                var chpVal = futCache.chp;
                var chpSign = chpVal >= 0 ? '+' : '';
                var chpColor = chpVal > 0 ? '#059669' : chpVal < 0 ? '#dc2626' : '#9ca3af';
                contractChpHtml = '<div style="font-size:11px;color:' + chpColor + ';">' + chpSign + chpVal.toFixed(2) + '%</div>';
            }
            if (futCache && futCache.lp > 0) {
                futCmpStr = '<span class="trFno-grp-cmp" title="Live CMP — current-expiry contract (' + wmsEsc(nearestFut.contractLabel || '') + ')">' + formatPrice(futCache.lp, false) + '</span>';
            }
        }

        // Live CMP of the current-expiry futures contract goes in the "closing side"
        // price column: Sell Price for a net-long group, Buy Price for a net-short
        // group. Mirrors the per-contract detail-row behaviour (D.12.2).
        var grpBuyCell = avgBuyPrice;
        var grpSellCell = avgSellPrice;
        if (futCmpStr) {
            if (p.futIsShort) grpBuyCell = futCmpStr;
            else grpSellCell = futCmpStr;
        }

        // P&L as % of exposure
        var uPctHtml = '';
        var nPctHtml = '';
        if (exposure > 0) {
            var uPct = (uPnl / exposure) * 100;
            var nPct = (netPnl / exposure) * 100;
            uPctHtml = '<div style="font-size:11px;" class="' + uClass + '">(' + (uPct >= 0 ? '+' : '') + uPct.toFixed(2) + '%)</div>';
            nPctHtml = '<div style="font-size:11px;" class="' + nClass + '">(' + (nPct >= 0 ? '+' : '') + nPct.toFixed(2) + '%)</div>';
        }

        // Symbol-level summary row — highlighted, no arrow, no contract list
        html += '<tr class="trFno-symbol-row" data-fno-symbol="' + wmsEsc(p.underlying) + '">' +
            '<td><span class="trFno-symbol-name">' + wmsEsc(p.companyName) + '</span>' +
                '<div class="trFno-symbol-sub">' + wmsEsc(p.underlying) + '</div></td>' +
            '<td></td>' +
            '<td class="text-right">' + formatQuantity(p.futOpenQty) + '</td>' +
            '<td class="trM-buy-start"></td>' +
            '<td class="text-right">' + grpBuyCell + '</td>' +
            '<td class="trM-sell-start"></td>' +
            '<td class="text-right">' + grpSellCell + '</td>' +
            '<td class="text-right trFno-pnl-start">' + formatAmount(exposure) + '</td>' +
            '<td class="text-right"><span class="' + dClass + '">' + formatAmount(dPnl) + '</span>' + contractChpHtml + '</td>' +
            '<td class="text-right"><span class="' + rClass + '">' + formatAmount(rPnl) + '</span></td>' +
            '<td class="text-right"><span class="' + uClass + '">' + formatAmount(uPnl) + '</span>' + uPctHtml + '</td>' +
            '<td class="text-right"><span class="' + nClass + '">' + formatAmount(netPnl) + '</span>' + nPctHtml + '</td>' +
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
                // No color class for zero (neutral '-' display)
                var cgDClass = cgDayPnl === 0 ? '' : (cgDayPnl > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');
                var cgRClass = cgRealised === 0 ? '' : (cgRealised > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');
                var cgUClass = cgUnrealised === 0 ? '' : (cgUnrealised > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');
                var cgNClass = cgNet === 0 ? '' : (cgNet > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');

                // Sub-group avg price
                var cgAvgPrice = (cg.openQty > 0 && cgExposure > 0) ? formatPrice(cgExposure / cg.openQty, false) : '';
                var cgBuyPrice = (!cg.isShort && cgAvgPrice) ? cgAvgPrice : '';
                var cgSellPrice = (cg.isShort && cgAvgPrice) ? cgAvgPrice : '';

                // Sub-group header row (clickable to expand detail rows)
                html += '<tr class="trFno-detail-header trFno-group-row" data-fno-group="' + wmsEsc(groupKey) + '">' +
                    '<td style="padding-left:24px;">' + wmsEsc(cg.groupLabel) + '</td>' +
                    '<td>' + wmsEsc(cg.contractLabel) + shortLabel + '</td>' +
                    '<td class="text-right">' + formatQuantity(cg.openQty) + '</td>' +
                    '<td class="trM-buy-start"></td>' +
                    '<td class="text-right">' + cgBuyPrice + '</td>' +
                    '<td class="trM-sell-start"></td>' +
                    '<td class="text-right">' + cgSellPrice + '</td>' +
                    '<td class="text-right trFno-pnl-start">' + formatAmount(cgExposure) + '</td>' +
                    '<td class="text-right"><span class="' + cgDClass + '">' + formatAmount(cgDayPnl) + '</span></td>' +
                    '<td class="text-right"><span class="' + cgRClass + '">' + formatAmount(cgRealised) + '</span></td>' +
                    '<td class="text-right"><span class="' + cgUClass + '">' + formatAmount(cgUnrealised) + '</span></td>' +
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
            if (r.dayPnl !== undefined) pageTotDayPnl += r.dayPnl;  // closed-today Day P&L
        }
    });
    pageTotNet = pageTotRealised + pageTotUnrealised;

    // Banner stats now computed from default view filters via trFnoBannerRefreshFromDefault()

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
                sellPriceHtml = formatPrice(r.cmp, false);
            } else if (r.isShort && !hasBuy) {
                buyPriceHtml = formatPrice(r.cmp, false);
            }
        }

        // Exposure = qty × opening price (only for open positions)
        var exposureHtml = '-';
        if (r.type === 'open') {
            var exposure = r.isShort ? r.sellAmount : r.buyAmount;
            exposureHtml = formatAmount(exposure);
        }

        // P&L columns
        var dayPnl = (r.dayPnl !== undefined) ? r.dayPnl : 0;
        var realisedPnl = (r.type === 'matched') ? r.pnl : 0;
        var unrealisedPnl = (r.type === 'open' && r.unrealisedPnl !== undefined) ? r.unrealisedPnl : 0;
        var netPnl = realisedPnl + unrealisedPnl;

        // No color class for zero (neutral '-' display)
        var dClass = dayPnl === 0 ? '' : (dayPnl > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');
        var rClass = realisedPnl === 0 ? '' : (realisedPnl > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');
        var uClass = unrealisedPnl === 0 ? '' : (unrealisedPnl > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');
        var nClass = netPnl === 0 ? '' : (netPnl > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');

        // formatAmount returns '-' for zero values (centralized rule)
        var dayPnlHtml = (r.dayPnl !== undefined || r.type === 'open') ? '<span class="' + dClass + '">' + formatAmount(dayPnl) + '</span>' : '-';
        var realisedHtml = (r.type === 'matched') ? '<span class="' + rClass + '">' + formatAmount(realisedPnl) + '</span>' : '-';
        var unrealisedHtml = (r.type === 'open') ? '<span class="' + uClass + '">' + formatAmount(unrealisedPnl) + '</span>' : '-';
        var netHtml = '<span class="' + nClass + '">' + formatAmount(netPnl) + '</span>';

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
            sellPriceHtml = formatPrice(r.cmp, false);
        } else if (r.isShort && !hasBuy) {
            buyPriceHtml = formatPrice(r.cmp, false);
        }
    }

    // Exposure = qty × opening price (only for open positions)
    var exposureHtml = '-';
    if (r.type === 'open') {
        var exposure = r.isShort ? r.sellAmount : r.buyAmount;
        exposureHtml = formatAmount(exposure);
    }

    // P&L columns
    var dayPnl = (r.type === 'open' && r.dayPnl !== undefined) ? r.dayPnl : 0;
    var realisedPnl = (r.type === 'matched') ? r.pnl : 0;
    var unrealisedPnl = (r.type === 'open' && r.unrealisedPnl !== undefined) ? r.unrealisedPnl : 0;
    var netPnl = realisedPnl + unrealisedPnl;

    // No color class for zero (neutral '-' display)
    var dClass = dayPnl === 0 ? '' : (dayPnl > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');
    var rClass = realisedPnl === 0 ? '' : (realisedPnl > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');
    var uClass = unrealisedPnl === 0 ? '' : (unrealisedPnl > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');
    var nClass = netPnl === 0 ? '' : (netPnl > 0 ? 'trM-pnl-positive' : 'trM-pnl-negative');

    // formatAmount returns '-' for zero values (centralized rule)
    var dayPnlHtml = (r.type === 'open') ? '<span class="' + dClass + '">' + formatAmount(dayPnl) + '</span>' : '-';
    var realisedHtml = (r.type === 'matched') ? '<span class="' + rClass + '">' + formatAmount(realisedPnl) + '</span>' : '-';
    var unrealisedHtml = (r.type === 'open') ? '<span class="' + uClass + '">' + formatAmount(unrealisedPnl) + '</span>' : '-';
    var netHtml = '<span class="' + nClass + '">' + formatAmount(netPnl) + '</span>';

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
            return '<span class="' + uCls + '">' + uFmt + '</span>';
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

// Timestamp (ms) for an expiry label like "Jul 26". 'Equity' and unparseable
// labels sort as oldest (-Infinity). Used for FY grouping + the divider.
function trFnoExpiryTime(label) {
    if (!label || label === 'Equity') return -Infinity;
    var p = String(label).split(' ');
    var mi = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
    if (mi[p[0]] === undefined || p[1] === undefined) return -Infinity;
    return new Date(2000 + parseInt(p[1], 10), mi[p[0]], 1).getTime();
}

// Current financial year (Apr–Mar) bounds as ms timestamps.
function trFnoCurrentFYBounds() {
    var now = new Date();
    var y = (now.getMonth() >= 3) ? now.getFullYear() : now.getFullYear() - 1;  // Apr = month 3
    return { start: new Date(y, 3, 1).getTime(), end: new Date(y + 1, 2, 31, 23, 59, 59).getTime() };
}

// Resolve the effective HIDDEN expiry set from a view's raw stored filters
// (§D.12.23 exclusion model). Preference: explicit `expiryHide` → use verbatim.
// Legacy `expiryFilter` (inclusion list) → hide the labels NOT included that
// are no newer than the newest included one; anything newer (new contracts)
// stays visible. Nothing stored → hide nothing (all shown, incl. new).
function trFnoResolveHide(rawFilters, expiryLabels) {
    rawFilters = rawFilters || {};
    if (Array.isArray(rawFilters.expiryHide)) return rawFilters.expiryHide.slice();
    if (Array.isArray(rawFilters.expiryFilter) && rawFilters.expiryFilter.length > 0) {
        var inc = rawFilters.expiryFilter;
        var maxT = -Infinity;
        inc.forEach(function(l) { var t = trFnoExpiryTime(l); if (t > maxT) maxT = t; });
        return (expiryLabels || []).filter(function(l) {
            return inc.indexOf(l) < 0 && trFnoExpiryTime(l) <= maxT;
        });
    }
    return [];
}

function trFnoBuildExpiryFilter(expiryLabels, hideArg) {
    var wrap = document.getElementById('trFnoExpiryWrap');
    if (!wrap) return;
    if (expiryLabels.length <= 1) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = '';

    // Effective hidden set is computed by trFnoCalcPositions and passed in.
    var hide = Array.isArray(hideArg) ? hideArg : (Array.isArray(trFnoExpiryHide) ? trFnoExpiryHide : []);

    var fy = trFnoCurrentFYBounds();
    function inFY(el) { var t = trFnoExpiryTime(el); return t >= fy.start && t <= fy.end; }

    // Current expiry label for the "Deselect All" fallback (keep current month).
    var _monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var _now = new Date();
    var _curExpiryLabel = _monthNames[_now.getMonth()] + ' ' + String(_now.getFullYear()).slice(-2);

    var noneHidden = (hide.length === 0);
    var html = '<button class="trM-cf-btn" id="trFnoExpiryToggle">Expiry ▾</button>' +
        '<div class="trM-cf-dropdown" id="trFnoExpiryDropdown" style="display:none;">' +
        '<div style="display:flex; align-items:center; gap:8px; padding:4px 12px; border-bottom:1px solid #e2e8f0; margin-bottom:2px;">' +
          '<span id="trFnoExpirySelectAll" style="font-size:11px; color:#667eea; cursor:pointer; font-weight:600;">' + (noneHidden ? 'Deselect All' : 'Select All') + '</span>' +
          '<span style="color:#cbd5e0;">|</span>' +
          '<span id="trFnoExpirySelectFY" style="font-size:11px; color:#667eea; cursor:pointer; font-weight:600;">Select FY</span>' +
        '</div>';
    // Labels are already sorted newest→oldest. Insert one divider before the
    // first label older than the current FY start (separates current FY from
    // older contracts, e.g. between Apr and Mar).
    var dividerDone = false;
    expiryLabels.forEach(function(el) {
        if (!dividerDone && trFnoExpiryTime(el) < fy.start) {
            html += '<div style="border-top:1px solid #cbd5e0; margin:3px 8px;"></div>';
            dividerDone = true;
        }
        var checked = (hide.indexOf(el) < 0) ? ' checked' : '';
        html += '<label class="trM-cf-item"><input type="checkbox" value="' + wmsEsc(el) + '"' + checked + '> ' + wmsEsc(el) + '</label>';
    });
    html += '</div>';
    wrap.innerHTML = html;

    var toggleBtn = document.getElementById('trFnoExpiryToggle');
    var dropdown = document.getElementById('trFnoExpiryDropdown');
    var selectAllEl = document.getElementById('trFnoExpirySelectAll');
    var selectFYEl = document.getElementById('trFnoExpirySelectFY');
    toggleBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        dropdown.style.display = dropdown.style.display === 'none' ? '' : 'none';
    });

    function domHide() {
        var h = [];
        dropdown.querySelectorAll('input[type="checkbox"]').forEach(function(c) { if (!c.checked) h.push(c.value); });
        return h;
    }
    function updateSelectAllLabel() {
        var anyUnchecked = false;
        dropdown.querySelectorAll('input[type="checkbox"]').forEach(function(c) { if (!c.checked) anyUnchecked = true; });
        selectAllEl.textContent = anyUnchecked ? 'Select All' : 'Deselect All';
    }

    selectAllEl.addEventListener('click', function(e) {
        e.stopPropagation();
        var anyUnchecked = false;
        dropdown.querySelectorAll('input[type="checkbox"]').forEach(function(c) { if (!c.checked) anyUnchecked = true; });
        if (anyUnchecked) {
            // Select All → hide nothing
            dropdown.querySelectorAll('input[type="checkbox"]').forEach(function(c) { c.checked = true; });
            trFnoExpiryHide = [];
        } else {
            // Deselect All → keep only the current expiry month visible
            dropdown.querySelectorAll('input[type="checkbox"]').forEach(function(c) { c.checked = (c.value === _curExpiryLabel); });
            trFnoExpiryHide = expiryLabels.filter(function(el) { return el !== _curExpiryLabel; });
        }
        updateSelectAllLabel();
        trFnoRender();
    });

    selectFYEl.addEventListener('click', function(e) {
        e.stopPropagation();
        // Select FY → show only current-FY (Apr–Mar) expiries, hide the rest.
        dropdown.querySelectorAll('input[type="checkbox"]').forEach(function(c) { c.checked = inFY(c.value); });
        trFnoExpiryHide = expiryLabels.filter(function(el) { return !inFY(el); });
        updateSelectAllLabel();
        trFnoRender();
    });

    dropdown.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
        cb.addEventListener('change', function() {
            var h = domHide();
            // Guard: if the user hides EVERYTHING, keep the current month visible.
            if (h.length === expiryLabels.length) {
                dropdown.querySelectorAll('input[type="checkbox"]').forEach(function(c) { if (c.value === _curExpiryLabel) c.checked = true; });
                h = expiryLabels.filter(function(el) { return el !== _curExpiryLabel; });
            }
            trFnoExpiryHide = h;
            updateSelectAllLabel();
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

// ---- F&O View Manager (wmsViewManager instance) ----
var trFnoVM = wmsViewManager({
    module: 'trading_fno',
    label: 'F&O',
    ids: {
        viewTabs: 'tr-fno-view-tabs',
        moreList: 'tr-fno-more-list',
        moreDropdown: 'tr-fno-more-dropdown',
        updateBtn: 'tr-fno-update-view-btn'
    },
    autoDefaultFirst: true,
    getPills: function() {
        return [
            { pill: trFnoInvPillFilter, type: 'investor' },
            { pill: trFnoTrdPillFilter, type: 'trader' },
            { pill: trFnoBrkPillFilter, type: 'broker' },
            { pill: trFnoTagPillFilter, type: 'tag' }
        ];
    },
    getFilters: function() {
        return {
            investorIds: trSelectedInvestorIds.slice(),
            traderIds: trSelectedTraderIds.slice(),
            brokerIds: trSelectedBrokerIds.slice(),
            tagNames: trSelectedTagNames.slice(),
            tagLogic: trTagFilterLogic,
            fnoMode: trFnoMode,
            matchMethod: trFnoMatchMethod,
            expiryHide: trFnoExpiryHide ? trFnoExpiryHide.slice() : [],
            flatView: trFnoFlatView
        };
    },
    applyFilters: function(f) {
        // Shared filters — mutate in-place (B.2.3 — pill controllers hold references)
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
        // Expiry uses the exclusion model (expiryHide, §D.12.23). Clear any live
        // user override so the newly-active view's own saved filter takes effect
        // (trFnoCalcPositions derives the hidden set from the active view).
        trFnoExpiryHide = null;
        trFnoFlatView = f.flatView || false;

        // Sync pill UI
        if (trFnoInvPillFilter) trFnoInvPillFilter.syncStates();
        if (trFnoTrdPillFilter) trFnoTrdPillFilter.syncStates();
        if (trFnoBrkPillFilter) trFnoBrkPillFilter.syncStates();
        if (trFnoTagPillFilter) trFnoTagPillFilter.syncStates();
        if (trFnoInvPillFilter) trFnoInvPillFilter.renderSelectedTags();
        if (trFnoTrdPillFilter) trFnoTrdPillFilter.renderSelectedTags();
        if (trFnoBrkPillFilter) trFnoBrkPillFilter.renderSelectedTags();
        if (trFnoTagPillFilter) trFnoTagPillFilter.renderSelectedTags();

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
    },
    onRefresh: function() { trFnoRender(); },
    onLoadComplete: function(defaultView) {
        if (defaultView) {
            trDefaultFnoViewFilters = defaultView.filters || {};
            if (typeof trFnoBannerRefreshFromDefault === 'function' && window.fyersToken) {
                trFnoBannerRefreshFromDefault();
            }
        }
    },
    onDefaultChanged: function(newDefault) {
        trDefaultFnoViewFilters = newDefault.filters || {};
        if (typeof trFnoBannerRefreshFromDefault === 'function') trFnoBannerRefreshFromDefault();
    },
    onUpdateComplete: function(view) {
        if (view.is_default) {
            trDefaultFnoViewFilters = view.filters;
            if (typeof trFnoBannerRefreshFromDefault === 'function') trFnoBannerRefreshFromDefault();
        }
    },
    onSaveComplete: function() {
        var prompt = document.getElementById('tr-fno-save-prompt');
        if (prompt) prompt.classList.remove('show');
        var nameInput = document.getElementById('tr-fno-save-prompt-name');
        if (nameInput) nameInput.value = '';
        var saveNewBtn = document.getElementById('tr-fno-save-new-btn');
        if (saveNewBtn) saveNewBtn.style.display = '';
    }
});

// SAVED F&O VIEWS — delegated to trFnoVM (wmsViewManager instance)
