// ============================================================================
// WMS TRADING MODULE — WATCHLIST SUB-MODULE
// ============================================================================
// Loaded on-demand when user switches to the Watchlist tab.
// All functions/state use 'trWl' prefix to avoid conflicts.
// All module-level state uses var (project convention — avoids TDZ on reload).

var trWlWatchlists = [];       // Array of { id, name, sort_order, is_collapsed, items: [] }
var trWlPrices = {};           // Fyers symbol → { lp, ch, chp, high, low }
var trWlRefreshTimer = null;   // setInterval ID for auto-refresh
var trWlRefreshInterval = 10000; // 10 seconds
var trWlInitialized = false;   // Prevent double-init
var trWlAddTargetId = null;    // Which watchlist we're adding to
var trWlSearchCache = [];      // Cached search results from DB
var trWlOpenMenuId = null;     // Currently open card menu
var trWlRenamingId = null;     // Currently renaming watchlist
var trWlSortState = {};        // watchlist_id → { field: 'name'|'chp', dir: 'asc'|'desc' }
var trWlDragItemState = null;  // { wlId, itemId, fromIdx } for drag-reorder within card
var trWlResolvedSymbols = {};  // security_id → true (tracks which items have been resolved)
var trWlFirstFetchDone = false; // Skip resolution/Yahoo on auto-refresh cycles
var trWlSearchDdCtrl = null;   // wmsDropdown controller for search autocomplete
var trWlAddModal = null;       // wmsModal controller for add-security dialog
var trWlReorderModal = null;   // wmsModal controller for reorder dialog

// ============================================================================
// INITIALIZATION
// ============================================================================

async function trWlInit() {
    if (trWlInitialized) {
        // Already initialized — just refresh prices and re-render
        await trWlFetchPrices();
        trWlRender();
        if (wmsIsMarketHours()) {
            trWlStartAutoRefresh();
        } else {
            trWlUpdatePriceStatus('market-closed');
        }
        return;
    }
    trWlInitialized = true;
    trWlSetupEventHandlers();
    await trWlLoad();
    await trWlFetchPrices();
    trWlRender();
    if (wmsIsMarketHours()) {
        trWlStartAutoRefresh();
    } else {
        trWlUpdatePriceStatus('market-closed');
    }
}

function trWlDestroy() {
    // Called when switching away from watchlist tab
    trWlStopAutoRefresh();
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

function trWlSetupEventHandlers() {
    // New watchlist button
    document.getElementById('trWlNewBtn').addEventListener('click', function() {
        document.getElementById('trWlNewWrap').classList.add('show');
        document.getElementById('trWlNewBtn').style.display = 'none';
        var input = document.getElementById('trWlNewName');
        input.value = '';
        input.focus();
    });

    document.getElementById('trWlNewSave').addEventListener('click', trWlCreateWatchlist);
    document.getElementById('trWlNewCancel').addEventListener('click', trWlCancelNewWatchlist);
    document.getElementById('trWlNewName').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') trWlCreateWatchlist();
        if (e.key === 'Escape') trWlCancelNewWatchlist();
    });

    // Add dialog — initialize modal and dropdown with wms-shared.js
    var searchInput = document.getElementById('trWlAddSearch');
    var addResultsEl = document.getElementById('trWlAddResults');
    var addOverlayEl = document.getElementById('trWlAddOverlay');
    var searchTimer = null;

    // Create wmsModal for add dialog (handles ESC and click-outside)
    trWlAddModal = wmsModal(addOverlayEl, {
        onClose: function() {
            trWlAddTargetId = null;
            trWlRender(); // Re-render to show any newly added items
            if (trWlSearchDdCtrl) trWlSearchDdCtrl.close();
        }
    });

    // Setup close buttons (buttons now call modal.close instead of classList manipulation)
    document.getElementById('trWlAddClose').addEventListener('click', function() {
        trWlAddModal.close();
    });
    document.getElementById('trWlAddCancelBtn').addEventListener('click', function() {
        trWlAddModal.close();
    });

    // Create wmsDropdown for search autocomplete
    trWlSearchDdCtrl = wmsDropdown(searchInput, addResultsEl, {
        itemSelector: '.wl-add-result-item:not(.added)',
        closeOnSelect: false,  // Dialog stays open for adding more items
        blurDelay: 0,           // Modal dialog, not standard input
        escClearsInput: false,  // ESC handled by wmsModal
        onSelect: function(itemEl) {
            var idx = parseInt(itemEl.dataset.idx);
            var cached = trWlSearchCache[idx];
            if (!cached) return;
            trWlAddItem(cached);
            // Reset dropdown highlight since items list changed
            if (trWlSearchDdCtrl) trWlSearchDdCtrl.resetIdx();
        }
    });

    // Add dialog — search input with debounced search
    searchInput.addEventListener('input', function() {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function() {
            trWlSearchSecurities(searchInput.value.trim());
        }, 300);
    });

    // Manual refresh button
    document.getElementById('trWlRefreshBtn').addEventListener('click', async function() {
        await trWlFetchPrices();
        trWlUpdatePricesInPlace();
        // Restart auto-refresh if market is open
        if (wmsIsMarketHours()) {
            trWlStartAutoRefresh();
        }
    });

    // Reorder button
    document.getElementById('trWlReorderBtn').addEventListener('click', trWlOpenReorderModal);

    // Reorder modal — initialize with wms-shared.js (handles ESC and click-outside)
    var reorderOverlayEl = document.getElementById('trWlReorderOverlay');
    trWlReorderModal = wmsModal(reorderOverlayEl, {
        onClose: function() {
            trWlReorderList = [];
        }
    });

    // Reorder modal — close/save buttons
    document.getElementById('trWlReorderClose').addEventListener('click', function() {
        trWlReorderModal.close();
    });
    document.getElementById('trWlReorderCancelBtn').addEventListener('click', function() {
        trWlReorderModal.close();
    });
    document.getElementById('trWlReorderSaveBtn').addEventListener('click', trWlSaveReorder);

    // Close card menus and alert popover on outside click
    document.addEventListener('click', function(e) {
        if (trWlOpenMenuId && !e.target.closest('.wl-card-actions')) {
            trWlCloseAllMenus();
        }
        // Close alert popover if click is outside it
        if (trWlAlertPopoverRow && !e.target.closest('.wl-alert-popover') && !e.target.closest('.wl-sec-price') && !e.target.closest('.wl-alert-dot')) {
            trWlCloseAlertPopover();
        }
    });

    // Visibility API — pause/resume auto-refresh
    document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
            trWlStopAutoRefresh();
        } else {
            // Resume only if watchlist tab is active
            var wlTab = document.getElementById('tr-watchlist');
            if (wlTab && wlTab.classList.contains('active')) {
                trWlFetchPrices().then(function() { trWlUpdatePricesInPlace(); });
                if (wmsIsMarketHours()) {
                    trWlStartAutoRefresh();
                } else {
                    trWlUpdatePriceStatus('market-closed');
                }
            }
        }
    });

    // ESC handling is now provided by wmsModal (applied to both add and reorder dialogs)
}

// ============================================================================
// DATA LOADING
// ============================================================================

async function trWlLoad() {
    var userId = window.currentUser ? window.currentUser.id : null;
    if (!userId) return;

    // Load watchlists
    var wlResp = await fetch(SUPABASE_URL + '/rest/v1/watchlists?user_id=eq.' + userId + '&order=sort_order,created_at', {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
    });
    var watchlists = wlResp.ok ? await wlResp.json() : [];

    // Load all watchlist items
    var wlIds = watchlists.map(function(w) { return w.id; });
    var items = [];
    if (wlIds.length > 0) {
        var itemResp = await fetch(SUPABASE_URL + '/rest/v1/watchlist_items?watchlist_id=in.(' + wlIds.join(',') + ')&order=sort_order,created_at', {
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
        });
        items = itemResp.ok ? await itemResp.json() : [];
    }

    // Merge items into watchlists
    var itemMap = {};
    items.forEach(function(item) {
        if (!itemMap[item.watchlist_id]) itemMap[item.watchlist_id] = [];
        itemMap[item.watchlist_id].push(item);
    });

    trWlWatchlists = watchlists.map(function(w) {
        w.items = itemMap[w.id] || [];
        return w;
    });

    // Now we need broker_tokens for each security to derive Fyers symbols
    // Load from securities_db and securities_nfo
    await trWlLoadBrokerTokens();
}

async function trWlLoadBrokerTokens() {
    // Ensure securities cache is loaded before looking up broker tokens
    if (!wmsRefData.securitiesCmReady) {
        console.log('Watchlist: Waiting for CM cache before loading broker tokens...');
        await wmsLoadSecuritiesCm(0, {all: true});
    }
    if (!wmsRefData.securitiesNfoReady) {
        console.log('Watchlist: Waiting for NFO cache before loading broker tokens...');
        await wmsLoadSecuritiesNfo();
    }

    // Collect all security IDs by source
    var dbIds = [];
    var nfoIds = [];
    trWlWatchlists.forEach(function(wl) {
        wl.items.forEach(function(item) {
            if (item.security_source === 'options_dynamic') {
                // Options: Fyers symbol IS the security_id — no DB lookup needed
                item._fyersSymbol = item.security_id;
                item._displaySymbol = item.short_symbol;
            } else if (item.security_source === 'securities_nfo') {
                nfoIds.push(item.security_id);
            } else {
                dbIds.push(item.security_id);
            }
        });
    });

    // Deduplicate
    dbIds = dbIds.filter(function(v, i, a) { return a.indexOf(v) === i; });
    nfoIds = nfoIds.filter(function(v, i, a) { return a.indexOf(v) === i; });

    // Lookup broker_tokens from shared cache (no network calls)
    var dbTokenMap = {};
    if (dbIds.length > 0) {
        dbIds.forEach(function(id) {
            var cached = wmsRefData.securitiesCmMap[id];
            if (cached) dbTokenMap[id] = cached;
        });
    }

    var nfoTokenMap = {};
    if (nfoIds.length > 0) {
        nfoIds.forEach(function(id) {
            var cached = wmsRefData.securitiesNfoMap[id];
            if (cached) nfoTokenMap[id] = cached;
        });
    }

    // Attach Fyers symbol and display symbol to each item
    trWlWatchlists.forEach(function(wl) {
        wl.items.forEach(function(item) {
            if (item.security_source === 'securities_nfo') {
                var nfoRec = nfoTokenMap[item.security_id];
                // For NFO, use full symbol (e.g. NATIONALUM26APRFUT) for display
                if (nfoRec && nfoRec.symbol) {
                    item._displaySymbol = nfoRec.symbol;
                }
                // Store expiry date and exchange from DB
                if (nfoRec) {
                    item._expiryDate = nfoRec.expiry_date || null; // YYYY-MM-DD string from DB
                    item._nfoExchange = nfoRec.exchange || '';
                    item._instrumentName = nfoRec.instrument_name || '';
                }
                if (nfoRec && nfoRec.broker_tokens && nfoRec.broker_tokens.fyers) {
                    item._fyersSymbol = nfoRec.broker_tokens.fyers.symbol || nfoRec.broker_tokens.fyers.nse_symbol;
                } else if (nfoRec) {
                    item._fyersSymbol = nfoRec.symbol;
                }
            } else {
                var dbRec = dbTokenMap[item.security_id];
                item._dbRec = dbRec; // Keep ref for lazy resolution

                // Priority 1: Use broker_tokens.fyers NSE symbol (most reliable)
                if (dbRec && dbRec.broker_tokens && dbRec.broker_tokens.fyers) {
                    var bt = dbRec.broker_tokens.fyers;
                    if (bt.nse_symbol) {
                        item._fyersSymbol = bt.nse_symbol;
                    } else if (bt.bse_symbol) {
                        // Fyers API supports BSE quotes — use BSE symbol directly
                        item._fyersSymbol = bt.bse_symbol;
                    } else if (bt.symbol) {
                        item._fyersSymbol = bt.symbol;
                    }
                }

                // Priority 2: Derive from DB columns
                if (!item._fyersSymbol && dbRec) {
                    if (dbRec.nse_symbol) {
                        item._fyersSymbol = 'NSE:' + dbRec.nse_symbol + '-EQ';
                    } else if (dbRec.bse_symbol) {
                        // Try BSE directly (Fyers supports BSE quotes)
                        item._fyersSymbol = 'BSE:' + dbRec.bse_symbol;
                    }
                }

                // Priority 3: Use short_symbol from watchlist item
                if (!item._fyersSymbol && item.short_symbol) {
                    item._fyersSymbol = 'NSE:' + item.short_symbol + '-EQ';
                }
            }
            if (!item._fyersSymbol) {
                item._fyersSymbol = null;
                console.warn('Watchlist: No Fyers symbol for', item.short_symbol, '(security_id:', item.security_id + ')');
            }
        });
    });

    // Log symbol mapping summary
    var symbolMap = [];
    trWlWatchlists.forEach(function(wl) {
        wl.items.forEach(function(item) {
            if (item._fyersSymbol) {
                symbolMap.push(item.short_symbol + ' → ' + item._fyersSymbol);
            }
        });
    });
    if (symbolMap.length > 0) {
        console.log('Watchlist: Symbol mapping:\n  ' + symbolMap.join('\n  '));
    }
}

// ============================================================================
// FYERS PRICE FETCHING
// ============================================================================

async function trWlFetchPrices() {
    try {
        if (!window.fyersToken) {
            trWlUpdatePriceStatus('no-token');
            return;
        }

        // Collect all Fyers symbols across all watchlists
        var allSymbols = [];
        trWlWatchlists.forEach(function(wl) {
            wl.items.forEach(function(item) {
                if (item._fyersSymbol && allSymbols.indexOf(item._fyersSymbol) < 0) {
                    allSymbols.push(item._fyersSymbol);
                }
            });
        });

        if (allSymbols.length === 0) {
            trWlUpdatePriceStatus('empty');
            return;
        }

        trWlUpdatePriceStatus('loading');
        var t0 = performance.now();

        // Track which requested symbols got a valid response (Fyers returned data for them)
        var respondedSymbols = {};

        // Batch into chunks of 50
        var batchSize = 50;
        for (var i = 0; i < allSymbols.length; i += batchSize) {
            var chunk = allSymbols.slice(i, i + batchSize);
            try {
                var data = await window.fyersCall({ action: 'quotes', symbols: chunk });
                if (data && data.d && data.d.length > 0) {
                    data.d.forEach(function(item) {
                        if (item.v && item.v.symbol) {
                            var priceData = {
                                lp: item.v.lp || 0,
                                ch: item.v.ch || 0,
                                chp: item.v.chp || 0,
                                high: item.v.high_price || null,
                                low: item.v.low_price || null
                            };
                            trWlPrices[item.v.symbol] = priceData;
                            respondedSymbols[item.v.symbol] = true;

                            // Also store under the requested symbol if base matches
                            chunk.forEach(function(reqSym) {
                                var retBase = item.v.symbol.replace(/^[A-Z]+:/, '');
                                var reqBase = reqSym.replace(/^[A-Z]+:/, '');
                                if (retBase === reqBase || reqSym === item.v.symbol) {
                                    trWlPrices[reqSym] = priceData;
                                    respondedSymbols[reqSym] = true;
                                }
                            });
                        }
                    });
                }
            } catch (err) {
                console.warn('Watchlist: Fyers batch error:', err.message);
            }
            if (i + batchSize < allSymbols.length) {
                await new Promise(function(resolve) { setTimeout(resolve, 200); });
            }
        }

        var t1 = performance.now();
        console.log('Watchlist: Stage 1 (Fyers batch) took ' + Math.round(t1 - t0) + 'ms for ' + allSymbols.length + ' symbols');

        // Identify items that Fyers did NOT respond for at all (symbol not recognized).
        // Items with lp=0 but a valid response are NOT unresolved — Fyers knows the symbol,
        // the stock just has no trades (illiquid, market closed, etc.)
        var noResponseItems = [];
        trWlWatchlists.forEach(function(wl) {
            wl.items.forEach(function(item) {
                if (item._fyersSymbol && !respondedSymbols[item._fyersSymbol]) {
                    noResponseItems.push(item.short_symbol + ' (' + item._fyersSymbol + ')');
                }
            });
        });
        if (noResponseItems.length > 0) {
            console.log('Watchlist: No Fyers response for:', noResponseItems.join(', '));
        }

        // Lazy resolution + Yahoo fallback: ONLY on first load, not auto-refresh.
        // Delegates to shared wmsFetchEquityPrices() (wms-shared.js) — single protocol.
        if (!trWlFirstFetchDone) {
            // Collect unresolved equity items for shared resolution
            var unresolvedEquity = [];
            var seenSids = {};
            trWlWatchlists.forEach(function(wl) {
                wl.items.forEach(function(item) {
                    if (!item._fyersSymbol) return;
                    if (item.security_source !== 'securities_db') return;
                    // Only resolve items Fyers did NOT respond to, or responded with lp=0
                    var existing = trWlPrices[item._fyersSymbol];
                    if (existing && existing.lp > 0) return;
                    if (seenSids[item.security_id]) return;
                    seenSids[item.security_id] = true;
                    unresolvedEquity.push({ shortSymbol: item.short_symbol, securityId: item.security_id });
                });
            });

            if (unresolvedEquity.length > 0) {
                console.log('Watchlist: Delegating', unresolvedEquity.length, 'unresolved to shared wmsFetchEquityPrices');
                await wmsFetchEquityPrices(unresolvedEquity);

                // Map resolved prices back to watchlist structures
                trWlWatchlists.forEach(function(wl) {
                    wl.items.forEach(function(item) {
                        if (!item.short_symbol || item.security_source !== 'securities_db') return;
                        var cached = wmsLivePrices[item.short_symbol];
                        if (!cached || cached.lp <= 0) return;
                        // Already has a good price? Skip.
                        var existing = trWlPrices[item._fyersSymbol];
                        if (existing && existing.lp > 0) return;
                        // Store in watchlist's price map and update _fyersSymbol
                        var resolvedKey = cached.resolvedSymbol || item._fyersSymbol;
                        trWlPrices[resolvedKey] = {
                            lp: cached.lp, ch: cached.ch, chp: cached.chp,
                            high: cached.high, low: cached.low
                        };
                        item._fyersSymbol = resolvedKey;
                    });
                });
            }

            trWlFirstFetchDone = true;
        }

        // Sync all equity prices to shared cache (for Positions tab)
        trWlSyncToSharedCache();

        var t2 = performance.now();
        console.log('Watchlist: Total price fetch took ' + Math.round(t2 - t0) + 'ms');

        trWlUpdatePriceStatus('live');
    } catch (err) {
        console.warn('Watchlist: Price fetch failed:', err.message || err);
        trWlUpdatePriceStatus('error');
    }
}

/**
 * Copy equity prices from watchlist's trWlPrices into the shared wmsLivePrices cache.
 * This allows Positions to reuse prices already fetched by the Watchlist.
 */
function trWlSyncToSharedCache() {
    if (typeof wmsLivePrices === 'undefined') return;
    var count = 0;
    trWlWatchlists.forEach(function(wl) {
        wl.items.forEach(function(item) {
            if (!item._fyersSymbol || !item.short_symbol) return;
            // Only sync securities_db equity items (not options_dynamic)
            if (item.security_source !== 'securities_db') return;
            var price = trWlPrices[item._fyersSymbol];
            if (!price || price.lp <= 0) return;
            var sym = item.short_symbol;
            // Don't overwrite if shared cache already has a positive price
            if (wmsLivePrices[sym] && wmsLivePrices[sym].lp > 0) return;
            wmsLivePrices[sym] = {
                lp: price.lp, ch: price.ch, chp: price.chp,
                high: price.high, low: price.low,
                resolvedSymbol: item._fyersSymbol
            };
            count++;
        });
    });
    if (count > 0) console.log('Watchlist: Synced', count, 'prices to shared cache');
}

// ── REMOVED: trWlResolveUnpricedItems + trWlYahooFallback ──
// Equity price resolution (alternate Fyers symbols + Yahoo Finance fallback)
// is now handled by the shared wmsFetchEquityPrices() in wms-shared.js.
// See trWlFetchPrices() above which delegates to it for unresolved equity items.
// ────────────────────────────────────────────────────────────────────────────

// [LEGACY - kept for reference, no longer called]
async function trWlResolveUnpricedItems_LEGACY(respondedSymbols) {
    if (!window.fyersToken) return;
    var t0 = performance.now();

    var unresolvedItems = [];
    trWlWatchlists.forEach(function(wl) {
        wl.items.forEach(function(item) {
            if (!item._fyersSymbol) return;
            // Only resolve items Fyers did NOT respond to at all (symbol not recognized).
            // Items with lp=0 are valid — Fyers knows the symbol, just no trades.
            if (respondedSymbols[item._fyersSymbol]) return;
            // Skip if we already attempted resolution for this security
            if (trWlResolvedSymbols[item.security_id]) return;
            // Only resolve securities_db items (NFO/options symbols are constructed correctly)
            if (item.security_source !== 'securities_db') return;
            unresolvedItems.push(item);
        });
    });

    if (unresolvedItems.length === 0) {
        console.log('Watchlist: Stage 2 — nothing to resolve (' + Math.round(performance.now() - t0) + 'ms)');
        return;
    }

    console.log('Watchlist: Stage 2 — resolving', unresolvedItems.length, 'unrecognized symbols:');
    unresolvedItems.forEach(function(item) {
        var hasBT = item._dbRec && item._dbRec.broker_tokens && item._dbRec.broker_tokens.fyers;
        console.log('  →', item.short_symbol, '| fyersSym:', item._fyersSymbol,
            '| broker_tokens.fyers:', hasBT ? JSON.stringify(item._dbRec.broker_tokens.fyers) : 'NONE',
            '| security_id:', item.security_id);
    });

    for (var i = 0; i < unresolvedItems.length; i++) {
        var item = unresolvedItems[i];
        trWlResolvedSymbols[item.security_id] = true; // Mark attempted

        // Build candidate symbols to try — both NSE and BSE variants
        var candidates = [];
        var dbRec = item._dbRec;
        var sym = item.short_symbol;

        // Collect all possible base symbols for this security
        var baseSymbols = [];
        if (dbRec) {
            if (dbRec.nse_symbol && baseSymbols.indexOf(dbRec.nse_symbol) < 0) baseSymbols.push(dbRec.nse_symbol);
            if (dbRec.bse_symbol && baseSymbols.indexOf(dbRec.bse_symbol) < 0) baseSymbols.push(dbRec.bse_symbol);
            if (dbRec.symbol && baseSymbols.indexOf(dbRec.symbol) < 0) baseSymbols.push(dbRec.symbol);
        }
        if (sym && baseSymbols.indexOf(sym) < 0) baseSymbols.push(sym);

        // Add broker_tokens BSE symbol if available (exact format from Fyers)
        if (dbRec && dbRec.broker_tokens && dbRec.broker_tokens.fyers) {
            var btFyers = dbRec.broker_tokens.fyers;
            if (btFyers.bse_symbol && candidates.indexOf(btFyers.bse_symbol) < 0) candidates.push(btFyers.bse_symbol);
            if (btFyers.nse_symbol && candidates.indexOf(btFyers.nse_symbol) < 0) candidates.push(btFyers.nse_symbol);
        }

        // All known BSE series suffixes (comprehensive list)
        var bseSuffixes = ['', '-A', '-B', '-D', '-E', '-G', '-M', '-P', '-R', '-T', '-W', '-X', '-Z'];

        // For each base symbol, try NSE and BSE variants
        baseSymbols.forEach(function(bs) {
            // NSE first
            var nseEq = 'NSE:' + bs + '-EQ';
            var nseSm = 'NSE:' + bs + '-SM';
            if (candidates.indexOf(nseEq) < 0) candidates.push(nseEq);
            if (candidates.indexOf(nseSm) < 0) candidates.push(nseSm);
            // Then all BSE series
            bseSuffixes.forEach(function(sfx) {
                var bseSym = 'BSE:' + bs + sfx;
                if (candidates.indexOf(bseSym) < 0) candidates.push(bseSym);
            });
        });

        // Remove the symbol we already tried (it didn't work)
        candidates = candidates.filter(function(c) { return c !== item._fyersSymbol; });
        if (candidates.length === 0) continue;

        console.log('Watchlist: Resolving', sym, '— trying:', candidates.join(', '));

        try {
            var data = await window.fyersCall({ action: 'quotes', symbols: candidates });
            if (data && data.d && data.d.length > 0) {
                for (var j = 0; j < data.d.length; j++) {
                    var q = data.d[j];
                    if (q.v && q.v.lp > 0) {
                        var resolvedSym = q.v.symbol;
                        console.log('Watchlist: Resolved', sym, '→', resolvedSym);

                        // Store the price
                        trWlPrices[resolvedSym] = {
                            lp: q.v.lp || 0,
                            ch: q.v.ch || 0,
                            chp: q.v.chp || 0,
                            high: q.v.high_price || null,
                            low: q.v.low_price || null
                        };

                        // Update _fyersSymbol on ALL items that reference this security
                        trWlWatchlists.forEach(function(wl) {
                            wl.items.forEach(function(it) {
                                if (it.security_id === item.security_id && it.security_source === item.security_source) {
                                    it._fyersSymbol = resolvedSym;
                                }
                            });
                        });

                        // Persist to DB in background
                        trWlUpdateSecurityBrokerTokens(item.security_id, resolvedSym);
                        break; // Found a working symbol
                    }
                }
            }
        } catch (err) {
            console.warn('Watchlist: Resolution failed for', sym, ':', err.message);
        }

        // Small delay between resolution attempts
        if (i < unresolvedItems.length - 1) {
            await new Promise(function(resolve) { setTimeout(resolve, 150); });
        }
    }

    console.log('Watchlist: Stage 2 done (' + Math.round(performance.now() - t0) + 'ms)');
}

// Yahoo Finance fallback — fetch prices for items without a usable price.
// Covers two cases:
//   (a) Fyers didn't respond at all (symbol not recognized, even after Stage 2 resolution)
//   (b) Fyers responded with lp=0 (valid symbol but no trades — illiquid/market closed)
async function trWlYahooFallback_LEGACY() {
    var yahooItems = [];
    trWlWatchlists.forEach(function(wl) {
        wl.items.forEach(function(item) {
            if (!item._fyersSymbol) return;
            if (item.security_source !== 'securities_db') return;
            // Skip if we already have a positive price from Fyers (or a previous Yahoo fetch)
            var existing = trWlPrices[item._fyersSymbol];
            if (existing && existing.lp > 0) return;
            // Avoid duplicates
            var already = yahooItems.some(function(y) { return y.security_id === item.security_id; });
            if (already) return;
            yahooItems.push(item);
        });
    });

    if (yahooItems.length === 0) {
        console.log('Watchlist: Stage 3 (Yahoo) — nothing to fetch');
        return;
    }

    console.log('Watchlist: Stage 3 (Yahoo) — fetching for', yahooItems.length, 'items:');
    yahooItems.forEach(function(item) {
        var existing = trWlPrices[item._fyersSymbol];
        var reason = existing ? 'Fyers lp=0' : 'no Fyers response';
        console.log('  →', item.short_symbol, '| reason:', reason, '| fyersSym:', item._fyersSymbol);
    });

    // Build Yahoo symbol list: SYMBOL.NS for NSE, SYMBOL.BO for BSE
    var yahooSymbolMap = {}; // yahooSymbol → [items]
    yahooItems.forEach(function(item) {
        var dbRec = item._dbRec;
        var baseSymbols = [];
        if (dbRec) {
            if (dbRec.nse_symbol) baseSymbols.push({ sym: dbRec.nse_symbol + '.NS', exchange: 'NSE' });
            if (dbRec.bse_symbol) baseSymbols.push({ sym: dbRec.bse_symbol + '.BO', exchange: 'BSE' });
            if (!dbRec.nse_symbol && !dbRec.bse_symbol && dbRec.symbol) {
                baseSymbols.push({ sym: dbRec.symbol + '.NS', exchange: 'NSE' });
                baseSymbols.push({ sym: dbRec.symbol + '.BO', exchange: 'BSE' });
            }
        }
        if (baseSymbols.length === 0 && item.short_symbol) {
            baseSymbols.push({ sym: item.short_symbol + '.NS', exchange: 'NSE' });
            baseSymbols.push({ sym: item.short_symbol + '.BO', exchange: 'BSE' });
        }
        baseSymbols.forEach(function(bs) {
            if (!yahooSymbolMap[bs.sym]) yahooSymbolMap[bs.sym] = [];
            yahooSymbolMap[bs.sym].push({ item: item, exchange: bs.exchange });
        });
    });

    var yahooSymbols = Object.keys(yahooSymbolMap);
    if (yahooSymbols.length === 0) return;

    try {
        var resp = await fetch(SUPABASE_URL + '/functions/v1/yahoo-finance', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
            },
            body: JSON.stringify({ symbols: yahooSymbols })
        });
        if (!resp.ok) {
            console.warn('Watchlist: Yahoo Finance API error:', resp.status);
            return;
        }
        var result = await resp.json();
        if (!result || !result.results) return;

        // Map Yahoo prices back to watchlist items
        var resolvedCount = 0;
        yahooSymbols.forEach(function(ySym) {
            var yData = result.results[ySym];
            if (!yData || !yData.regularMarketPrice || yData.regularMarketPrice <= 0) return;

            var mappedItems = yahooSymbolMap[ySym];
            mappedItems.forEach(function(mapped) {
                var item = mapped.item;
                // Skip if already resolved by a previous Yahoo symbol (e.g. NSE already worked)
                if (trWlPrices[item._fyersSymbol] && trWlPrices[item._fyersSymbol].lp > 0) return;

                // Store price under a Yahoo-prefixed key
                var yahooKey = 'YAHOO:' + ySym;
                trWlPrices[yahooKey] = {
                    lp: yData.regularMarketPrice,
                    ch: yData.regularMarketChange || 0,
                    chp: yData.regularMarketChangePercent || 0,
                    high: yData.regularMarketDayHigh || null,
                    low: yData.regularMarketDayLow || null
                };

                // Update the item's symbol to point to Yahoo price
                trWlWatchlists.forEach(function(wl) {
                    wl.items.forEach(function(it) {
                        if (it.security_id === item.security_id && it.security_source === item.security_source) {
                            it._fyersSymbol = yahooKey;
                        }
                    });
                });

                resolvedCount++;
                console.log('Watchlist: Yahoo resolved', item.short_symbol, '→', ySym,
                    '(₹' + yData.regularMarketPrice + ')');
            });
        });

        if (resolvedCount > 0) {
            console.log('Watchlist: Yahoo Finance resolved', resolvedCount, 'items');
        }
    } catch (err) {
        console.warn('Watchlist: Yahoo Finance fallback error:', err.message);
    }
}

function trWlUpdatePriceStatus(status) {
    var el = document.getElementById('trWlPriceStatus');
    if (!el) return;
    var now = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    if (status === 'live') {
        el.innerHTML = '🟢 Live as of ' + now;
        el.style.color = '#059669';
    } else if (status === 'loading') {
        el.innerHTML = '⏳ Fetching prices...';
        el.style.color = '#667eea';
    } else if (status === 'no-token') {
        el.innerHTML = '🔴 Fyers not connected';
        el.style.color = '#dc2626';
    } else if (status === 'market-closed') {
        el.innerHTML = '🔵 Market closed · Last ' + now;
        el.style.color = '#6366f1';
    } else if (status === 'empty') {
        el.innerHTML = '';
    } else {
        el.innerHTML = '🟡 Price fetch error';
        el.style.color = '#d97706';
    }
}

// ============================================================================
// AUTO-REFRESH TIMER
// ============================================================================

function trWlStartAutoRefresh() {
    trWlStopAutoRefresh(); // Clear any existing
    trWlRefreshTimer = setInterval(async function() {
        // Only refresh if page is visible and watchlist tab is active
        if (document.hidden) return;
        var wlTab = document.getElementById('tr-watchlist');
        if (!wlTab || !wlTab.classList.contains('active')) return;

        // Check market hours — stop auto-refresh if market is closed
        if (!wmsIsMarketHours()) {
            trWlStopAutoRefresh();
            trWlUpdatePriceStatus('market-closed');
            return;
        }

        await trWlFetchPrices();
        // Update prices in-place instead of full re-render (preserves scroll position)
        trWlUpdatePricesInPlace();
    }, trWlRefreshInterval);
}

function trWlStopAutoRefresh() {
    if (trWlRefreshTimer) {
        clearInterval(trWlRefreshTimer);
        trWlRefreshTimer = null;
    }
}

// ============================================================================
// IN-PLACE PRICE UPDATE (no DOM rebuild — preserves scroll position)
// ============================================================================

function trWlUpdatePricesInPlace() {
    var rows = document.querySelectorAll('.wl-security-row');
    rows.forEach(function(row) {
        var itemId = row.dataset.itemId;
        var wlId = row.dataset.wlId;

        // Find the item
        var item = null;
        for (var w = 0; w < trWlWatchlists.length; w++) {
            var wl = trWlWatchlists[w];
            if (wl.id !== wlId) continue;
            for (var i = 0; i < wl.items.length; i++) {
                if (wl.items[i].id === itemId) { item = wl.items[i]; break; }
            }
            if (item) break;
        }
        if (!item) return;

        var price = trWlPrices[item._fyersSymbol];
        var cmp = price ? price.lp : null;
        var ch = price ? price.ch : null;
        var chp = price ? price.chp : null;
        var high = price ? price.high : null;
        var low = price ? price.low : null;

        // Update price
        var priceEl = row.querySelector('.wl-price-main');
        if (priceEl) {
            var isExpOpt = item.security_source === 'options_dynamic' && (cmp === null || cmp === 0);
            if (isExpOpt) {
                priceEl.innerHTML = '<span style="color:#a0aec0;font-size:11px;">Expired</span>';
            } else {
                priceEl.innerHTML = cmp !== null ? formatPrice(cmp, false) : '<span style="color:#a0aec0;">—</span>';
            }
        }

        // Update change
        var changeEl = row.querySelector('.wl-sec-change');
        if (changeEl) {
            if (ch !== null) {
                var changeClass = ch >= 0 ? 'positive' : 'negative';
                var sign = ch >= 0 ? '+' : '';
                changeEl.innerHTML = '<div class="wl-change-main ' + changeClass + '">' + sign + formatPrice(ch, false) + '</div>' +
                    '<div class="wl-change-sub ' + changeClass + '">(' + (chp >= 0 ? '+' : '') + chp.toFixed(2) + '%)</div>';
            } else {
                changeEl.innerHTML = '<div class="wl-change-main" style="color:#a0aec0;">—</div>';
            }
        }

        // Update slider
        var sliderWrap = row.querySelector('.wl-row-slider');
        if (cmp !== null && high && low && high > low) {
            var pct = Math.min(100, Math.max(0, ((cmp - low) / (high - low)) * 100));
            var dotColor = pct >= 50 ? '#059669' : '#dc2626';
            var sliderHtml = '<div class="price-slider">' +
                '<div class="price-slider-track">' +
                    '<div class="price-slider-dot" style="left:' + pct.toFixed(1) + '%;background:' + dotColor + ';"></div>' +
                '</div>' +
                '<div class="slider-tooltip">' +
                    '<span>' + formatPrice(low, false) + '</span>' +
                    '<span>' + formatPrice(high, false) + '</span>' +
                '</div>' +
            '</div>';
            if (sliderWrap) {
                sliderWrap.innerHTML = sliderHtml;
            } else {
                row.insertAdjacentHTML('beforeend', '<div class="wl-row-slider">' + sliderHtml + '</div>');
            }
        } else if (sliderWrap) {
            sliderWrap.remove();
        }
    });

    // Update alert visuals based on new prices
    trWlUpdateAlertsInPlace();

    // Update price status timestamp
    trWlUpdatePriceStatus('live');
}

// ============================================================================
// MARKET HOURS CHECK — now uses shared wmsIsMarketHours() from wms-shared.js (Rule D.12.11)
// ============================================================================

// ============================================================================
// RENDERING
// ============================================================================

function trWlRender() {
    var grid = document.getElementById('trWlGrid');
    var collapsedBar = document.getElementById('trWlCollapsedBar');
    if (!grid) return;

    // Update count
    var countEl = document.getElementById('trWlCount');
    var totalItems = trWlWatchlists.reduce(function(sum, wl) { return sum + wl.items.length; }, 0);
    if (countEl) {
        countEl.textContent = trWlWatchlists.length + ' watchlist' + (trWlWatchlists.length !== 1 ? 's' : '') +
            ' · ' + totalItems + ' securit' + (totalItems !== 1 ? 'ies' : 'y');
    }

    if (trWlWatchlists.length === 0) {
        if (collapsedBar) { collapsedBar.style.display = 'none'; collapsedBar.innerHTML = ''; }
        grid.innerHTML = '<div class="wl-page-empty">' +
            '<div class="wl-empty-icon">📋</div>' +
            '<div class="wl-empty-text">No watchlists yet</div>' +
            '<button class="btn-new-watchlist" onclick="document.getElementById(\'trWlNewBtn\').click()">+ Create Your First Watchlist</button>' +
            '</div>';
        return;
    }

    // Separate collapsed and expanded watchlists
    var collapsed = [];
    var expanded = [];
    trWlWatchlists.forEach(function(wl) {
        if (wl.is_collapsed) collapsed.push(wl);
        else expanded.push(wl);
    });

    // Render collapsed watchlists as compact chips above the grid
    if (collapsedBar) {
        if (collapsed.length > 0) {
            collapsedBar.style.display = 'flex';
            collapsedBar.innerHTML = collapsed.map(function(wl) {
                return '<div class="wl-collapsed-chip" data-wl-id="' + wl.id + '" title="Click to expand">' +
                    '<span class="wl-chip-arrow">►</span>' +
                    '<span class="wl-chip-name">' + wmsEsc(wl.name) + '</span>' +
                    '<span class="wl-chip-count">(' + wl.items.length + ')</span>' +
                '</div>';
            }).join('');

            // Attach click handlers to chips — expand on click
            collapsedBar.querySelectorAll('.wl-collapsed-chip').forEach(function(chip) {
                chip.addEventListener('click', function() {
                    trWlToggleCollapse(chip.dataset.wlId);
                });
            });
        } else {
            collapsedBar.style.display = 'none';
            collapsedBar.innerHTML = '';
        }
    }

    // Render expanded watchlists in the grid
    if (expanded.length === 0) {
        grid.innerHTML = '';
    } else {
        grid.innerHTML = expanded.map(function(wl) {
            var menuId = 'wlm-' + wl.id.substring(0, 8);

            var itemsHtml = '';
            if (wl.items.length === 0) {
                itemsHtml = '<div class="wl-empty-card">No securities added yet. Click + to add.</div>';
            } else {
                var sortedItems = trWlGetSortedItems(wl);
                itemsHtml = sortedItems.map(function(item) {
                    return trWlRenderSecurityRow(item);
                }).join('');
            }

            // Sort indicator
            var ss = trWlSortState[wl.id];
            var sortNameClass = ss && ss.field === 'name' ? ' active' : '';
            var sortChpClass = ss && ss.field === 'chp' ? ' active' : '';
            var sortNameArrow = ss && ss.field === 'name' ? (ss.dir === 'asc' ? ' ▲' : ' ▼') : '';
            var sortChpArrow = ss && ss.field === 'chp' ? (ss.dir === 'asc' ? ' ▲' : ' ▼') : '';

            return '<div class="wl-card" data-wl-id="' + wl.id + '">' +
                '<div class="wl-card-header" data-wl-id="' + wl.id + '">' +
                    '<div class="wl-card-title">' +
                        '<span class="wl-arrow">▼</span>' +
                        '<span class="wl-name" data-wl-id="' + wl.id + '">' + wmsEsc(wl.name) + '</span>' +
                        '<span class="wl-item-count">(' + wl.items.length + ')</span>' +
                    '</div>' +
                    '<div class="wl-card-actions" style="position:relative;">' +
                        '<div class="wl-sort-btns">' +
                            '<button class="btn-wl-sort' + sortNameClass + '" data-wl-id="' + wl.id + '" data-sort="name" title="Sort by name">A-Z' + sortNameArrow + '</button>' +
                            '<button class="btn-wl-sort' + sortChpClass + '" data-wl-id="' + wl.id + '" data-sort="chp" title="Sort by % change">%' + sortChpArrow + '</button>' +
                        '</div>' +
                        '<button class="btn-wl-add" data-wl-id="' + wl.id + '" title="Add security">+</button>' +
                        '<button class="btn-wl-menu" data-wl-id="' + wl.id + '" data-menu-id="' + menuId + '" title="Options">⋮</button>' +
                        '<div class="wl-card-menu" id="' + menuId + '">' +
                            '<button class="wl-card-menu-item" data-action="rename" data-wl-id="' + wl.id + '">✏️ Rename</button>' +
                            '<button class="wl-card-menu-item danger" data-action="delete" data-wl-id="' + wl.id + '">🗑️ Delete Watchlist</button>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="wl-card-body">' + itemsHtml + '</div>' +
            '</div>';
        }).join('');
    }

    trWlAttachCardListeners();
}

function trWlRenderSecurityRow(item) {
    var price = trWlPrices[item._fyersSymbol];
    var cmp = price ? price.lp : null;
    var ch = price ? price.ch : null;
    var chp = price ? price.chp : null;
    var high = price ? price.high : null;
    var low = price ? price.low : null;

    // Display symbol — for NFO/Options, prefer _displaySymbol
    var rawDisplaySym = item._displaySymbol || item.short_symbol;

    // Strip exchange prefix (NSE:, MCX:, BSE:) from display — show in tooltip/sub-row instead
    var displayExchange = '';
    var displaySym = rawDisplaySym;
    var prefixMatch = rawDisplaySym.match(/^(NSE|MCX|BSE):/);
    if (prefixMatch) {
        displayExchange = prefixMatch[1];
        displaySym = rawDisplaySym.substring(prefixMatch[0].length);
    }
    // Fallback: use exchange from DB for NFO items
    if (!displayExchange && item._nfoExchange) {
        displayExchange = item._nfoExchange;
    }

    // For NFO/options, build a better sub-row with expiry date and exchange
    var subRowText = item.company_name || '';
    if (item.security_source === 'securities_nfo' || item.security_source === 'options_dynamic') {
        var expirySubRow = trWlBuildExpirySubRow(item, displaySym, displayExchange);
        if (expirySubRow) {
            subRowText = expirySubRow;
        } else if (displayExchange) {
            subRowText = displayExchange + (item.company_name ? ' · ' + item.company_name : '');
        }
    }

    // Check if this is an expired option (options_dynamic with lp=0 or no price)
    var isExpiredOption = item.security_source === 'options_dynamic' && (cmp === null || cmp === 0);

    // Price display
    var priceHtml;
    if (isExpiredOption) {
        priceHtml = '<span style="color:#a0aec0;font-size:11px;">Expired</span>';
    } else if (cmp !== null) {
        priceHtml = formatPrice(cmp, false);
    } else {
        priceHtml = '<span style="color:#a0aec0;">—</span>';
    }

    // Change display
    var changeHtml = '';
    if (ch !== null) {
        var changeClass = ch >= 0 ? 'positive' : 'negative';
        var sign = ch >= 0 ? '+' : '';
        changeHtml = '<div class="wl-change-main ' + changeClass + '">' + sign + formatPrice(ch, false) + '</div>' +
            '<div class="wl-change-sub ' + changeClass + '">(' + (chp >= 0 ? '+' : '') + chp.toFixed(2) + '%)</div>';
    } else {
        changeHtml = '<div class="wl-change-main" style="color:#a0aec0;">—</div>';
    }

    // Slider — portfolio style: just track + dot, low/high as tooltip on hover
    var sliderHtml = '';
    if (cmp !== null && high && low && high > low) {
        var pct = Math.min(100, Math.max(0, ((cmp - low) / (high - low)) * 100));
        var dotColor = pct >= 50 ? '#059669' : '#dc2626';
        sliderHtml = '<div class="price-slider">' +
            '<div class="price-slider-track">' +
                '<div class="price-slider-dot" style="left:' + pct.toFixed(1) + '%;background:' + dotColor + ';"></div>' +
            '</div>' +
            '<div class="slider-tooltip">' +
                '<span>' + formatPrice(low, false) + '</span>' +
                '<span>' + formatPrice(high, false) + '</span>' +
            '</div>' +
        '</div>';
    }

    // Alert dot — single dot on left of price
    var alertDotHtml = '';
    var hasAbove = item.alert_above != null;
    var hasBelow = item.alert_below != null;
    if (hasAbove || hasBelow) {
        var alertState = trWlGetAlertState(item, cmp);
        var dotTitle = '';
        if (hasBelow) dotTitle += '▼ ₹' + Number(item.alert_below).toLocaleString('en-IN');
        if (hasAbove && hasBelow) dotTitle += '  ';
        if (hasAbove) dotTitle += '▲ ₹' + Number(item.alert_above).toLocaleString('en-IN');
        alertDotHtml = '<span class="wl-alert-dot ' + alertState.dotClass + '" title="' + dotTitle + '"></span>';
    }

    // Build tooltip: exchange + symbol + company name
    var tooltipText = (displayExchange ? displayExchange + ':' : '') + displaySym + (item.company_name ? ' — ' + item.company_name : '');

    var expiredClass = isExpiredOption ? ' wl-expired-option' : '';
    return '<div class="wl-security-row' + expiredClass + '" data-item-id="' + item.id + '" data-wl-id="' + item.watchlist_id + '" draggable="true" title="' + wmsEsc(tooltipText) + '" style="position:relative;">' +
        '<div class="wl-row-top">' +
            '<div class="wl-sec-drag" title="Drag to reorder">☰</div>' +
            '<div class="wl-sec-symbol">' +
                '<div class="wl-sym-main">' + wmsEsc(displaySym) + '</div>' +
                '<div class="wl-sym-sub">' + wmsEsc(subRowText) + '</div>' +
            '</div>' +
            '<div class="wl-sec-price">' +
                alertDotHtml +
                '<div class="wl-price-main">' + priceHtml + '</div>' +
            '</div>' +
            '<div class="wl-sec-change">' + changeHtml + '</div>' +
            '<div class="wl-sec-delete">' +
                '<button class="btn-wl-delete" data-item-id="' + item.id + '" data-wl-id="' + item.watchlist_id + '" title="Remove">✕</button>' +
            '</div>' +
        '</div>' +
        (sliderHtml ? '<div class="wl-row-slider">' + sliderHtml + '</div>' : '') +
    '</div>';
}

// ============================================================================
// ATTACH DYNAMIC LISTENERS
// ============================================================================

function trWlAttachCardListeners() {
    // Card header click → toggle collapse
    document.querySelectorAll('.wl-card-header').forEach(function(header) {
        header.addEventListener('click', function(e) {
            // Don't collapse if clicking buttons inside actions
            if (e.target.closest('.wl-card-actions')) return;
            trWlToggleCollapse(header.dataset.wlId);
        });
    });

    // Add button
    document.querySelectorAll('.btn-wl-add').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            trWlOpenAddDialog(btn.dataset.wlId);
        });
    });

    // Menu button
    document.querySelectorAll('.btn-wl-menu').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var menuId = btn.dataset.menuId;
            var menu = document.getElementById(menuId);
            if (!menu) return;
            var wasOpen = menu.classList.contains('show');
            trWlCloseAllMenus();
            if (!wasOpen) {
                menu.classList.add('show');
                trWlOpenMenuId = menuId;
            }
        });
    });

    // Menu items (rename, delete)
    document.querySelectorAll('.wl-card-menu-item').forEach(function(item) {
        item.addEventListener('click', function(e) {
            e.stopPropagation();
            trWlCloseAllMenus();
            var action = item.dataset.action;
            var wlId = item.dataset.wlId;
            if (action === 'rename') trWlStartRename(wlId);
            else if (action === 'delete') trWlDeleteWatchlist(wlId);
        });
    });

    // Delete security buttons
    document.querySelectorAll('.btn-wl-delete').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            trWlDeleteItem(btn.dataset.itemId, btn.dataset.wlId);
        });
    });

    // Sort buttons
    document.querySelectorAll('.btn-wl-sort').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            trWlToggleSort(btn.dataset.wlId, btn.dataset.sort);
        });
    });

    // Double-click on price → open alert popover
    document.querySelectorAll('.wl-sec-price').forEach(function(priceEl) {
        priceEl.addEventListener('dblclick', function(e) {
            e.stopPropagation();
            var row = priceEl.closest('.wl-security-row');
            if (row) trWlOpenAlertPopover(row);
        });
    });

    // Click on alert dot → open alert popover
    document.querySelectorAll('.wl-alert-dot').forEach(function(dot) {
        dot.addEventListener('click', function(e) {
            e.stopPropagation();
            var row = dot.closest('.wl-security-row');
            if (row) trWlOpenAlertPopover(row);
        });
    });

    // Item drag-reorder within cards
    trWlSetupItemDrag();
}

function trWlCloseAllMenus() {
    document.querySelectorAll('.wl-card-menu.show').forEach(function(m) { m.classList.remove('show'); });
    trWlOpenMenuId = null;
}

// ============================================================================
// WATCHLIST CRUD
// ============================================================================

async function trWlCreateWatchlist() {
    var input = document.getElementById('trWlNewName');
    var name = input.value.trim();
    if (!name) {
        showAlert('Please enter a watchlist name', 'error', 2000);
        return;
    }

    var userId = window.currentUser ? window.currentUser.id : null;
    if (!userId) return;

    var sortOrder = trWlWatchlists.length;

    var resp = await fetch(SUPABASE_URL + '/rest/v1/watchlists', {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        },
        body: JSON.stringify({ user_id: userId, name: name, sort_order: sortOrder })
    });

    if (resp.ok) {
        var newWl = (await resp.json())[0];
        newWl.items = [];
        trWlWatchlists.push(newWl);
        trWlCancelNewWatchlist();
        trWlRender();
        showAlert('Watchlist "' + name + '" created', 'success', 2000);
    } else {
        showAlert('Failed to create watchlist', 'error');
    }
}

function trWlCancelNewWatchlist() {
    document.getElementById('trWlNewWrap').classList.remove('show');
    document.getElementById('trWlNewBtn').style.display = '';
    document.getElementById('trWlNewName').value = '';
}

async function trWlDeleteWatchlist(wlId) {
    var wl = trWlWatchlists.find(function(w) { return w.id === wlId; });
    if (!wl) return;
    if (!confirm('Delete watchlist "' + wl.name + '" and all its items?\n\nThis cannot be undone.')) return;

    var resp = await fetch(SUPABASE_URL + '/rest/v1/watchlists?id=eq.' + wlId, {
        method: 'DELETE',
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
            'Prefer': 'return=minimal'
        }
    });

    if (resp.ok) {
        trWlWatchlists = trWlWatchlists.filter(function(w) { return w.id !== wlId; });
        trWlRender();
        showAlert('Watchlist deleted', 'success', 2000);
    } else {
        showAlert('Failed to delete watchlist', 'error');
    }
}

function trWlStartRename(wlId) {
    var nameEl = document.querySelector('.wl-name[data-wl-id="' + wlId + '"]');
    if (!nameEl) return;
    var wl = trWlWatchlists.find(function(w) { return w.id === wlId; });
    if (!wl) return;

    trWlRenamingId = wlId;
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'wl-rename-input';
    input.value = wl.name;
    input.maxLength = 40;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    function finishRename() {
        var newName = input.value.trim();
        if (newName && newName !== wl.name) {
            trWlRenameWatchlist(wlId, newName);
        } else {
            trWlRender(); // revert
        }
        trWlRenamingId = null;
    }

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { input.blur(); }
        if (e.key === 'Escape') { trWlRenamingId = null; trWlRender(); }
    });
}

async function trWlRenameWatchlist(wlId, newName) {
    var resp = await fetch(SUPABASE_URL + '/rest/v1/watchlists?id=eq.' + wlId, {
        method: 'PATCH',
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ name: newName })
    });

    if (resp.ok) {
        var wl = trWlWatchlists.find(function(w) { return w.id === wlId; });
        if (wl) wl.name = newName;
        trWlRender();
    } else {
        showAlert('Failed to rename', 'error');
        trWlRender();
    }
}

async function trWlToggleCollapse(wlId) {
    var wl = trWlWatchlists.find(function(w) { return w.id === wlId; });
    if (!wl) return;
    wl.is_collapsed = !wl.is_collapsed;
    trWlRender();

    // Persist collapse state
    fetch(SUPABASE_URL + '/rest/v1/watchlists?id=eq.' + wlId, {
        method: 'PATCH',
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ is_collapsed: wl.is_collapsed })
    });
}

// ============================================================================
// ADD SECURITY DIALOG
// ============================================================================

function trWlOpenAddDialog(wlId) {
    trWlAddTargetId = wlId;
    var wl = trWlWatchlists.find(function(w) { return w.id === wlId; });
    document.getElementById('trWlAddTitle').textContent = 'Add Security to ' + (wl ? wl.name : 'Watchlist');
    document.getElementById('trWlAddSearch').value = '';
    document.getElementById('trWlAddResults').innerHTML = '<div class="wl-add-no-results">Type to search securities...</div>';
    if (trWlAddModal) trWlAddModal.open();
    if (trWlSearchDdCtrl) trWlSearchDdCtrl.close(); // Close dropdown on open
    setTimeout(function() { document.getElementById('trWlAddSearch').focus(); }, 100);
}

/**
 * Build the sub-row text for NFO/options items.
 * Shows exchange + month/year only (no exact expiry date — rules vary by exchange/instrument).
 */
function trWlBuildExpirySubRow(item, displaySym, displayExchange) {
    // 1) NFO items — show exchange + month & year from expiry_date
    if (item.security_source === 'securities_nfo') {
        var nfoParts = [];
        if (displayExchange) nfoParts.push(displayExchange);
        if (item._expiryDate) {
            var d = new Date(item._expiryDate + 'T00:00:00');
            if (!isNaN(d.getTime())) {
                var monthName = MONTHS_SHORT[d.getMonth()].charAt(0) + MONTHS_SHORT[d.getMonth()].slice(1).toLowerCase();
                nfoParts.push(monthName + ' ' + d.getFullYear());
            }
        }
        if (item._instrumentName) nfoParts.push(item._instrumentName);
        else if (item.company_name) nfoParts.push(item.company_name);
        return nfoParts.length > 0 ? nfoParts.join(' · ') : null;
    }

    // 2) Options dynamic — show exchange + month & year from symbol
    if (item.security_source === 'options_dynamic') {
        var symParts = displaySym.split(' ');
        var expiryToken = symParts[symParts.length - 1]; // e.g., "26MAR" or "27FEB26"
        var expiryText = null;

        // Monthly: "26MAR" (YYMMM) → "Mar 2026"
        var monthlyMatch = expiryToken.match(/^(\d{2})([A-Z]{3})$/);
        if (monthlyMatch) {
            var mIdx = MONTHS_SHORT.indexOf(monthlyMatch[2]);
            if (mIdx >= 0) {
                expiryText = monthlyMatch[2].charAt(0) + monthlyMatch[2].slice(1).toLowerCase() + ' ' + (2000 + parseInt(monthlyMatch[1]));
            }
        }
        // Weekly: "27FEB26" (DDMMMYY) → "Feb 2026"
        if (!expiryText) {
            var weeklyMatch = expiryToken.match(/^(\d{2})([A-Z]{3})(\d{2})$/);
            if (weeklyMatch) {
                var mIdx2 = MONTHS_SHORT.indexOf(weeklyMatch[2]);
                if (mIdx2 >= 0) {
                    expiryText = weeklyMatch[2].charAt(0) + weeklyMatch[2].slice(1).toLowerCase() + ' ' + (2000 + parseInt(weeklyMatch[3]));
                }
            }
        }

        if (expiryText) {
            var optParts = [];
            if (displayExchange) optParts.push(displayExchange);
            optParts.push(expiryText);
            return optParts.join(' · ');
        }
    }

    return null;
}

function trWlHighlightSearchResult(items, idx) {
    // Stub: highlighting now handled by wmsDropdown using '.wms-dd-highlight' class
    // Kept for backward compatibility if referenced elsewhere
}

function trWlCloseAddDialog() {
    // Use modal controller to close (handles cleanup via onClose callback)
    if (trWlAddModal) trWlAddModal.close();
}

// ============================================================================
// OPTIONS ON-DEMAND SEARCH
// ============================================================================

// Options constants — aliases for wms-shared.js (used by other functions in this file)
var MONTHS_SHORT = WMS_MONTHS_SHORT;
var WEEKLY_EXPIRY_UNDERLYINGS = WMS_WEEKLY_EXPIRY_UNDERLYINGS;

/**
 * Delegated to wms-shared.js (wmsParseOptionsQuery)
 */
function trWlParseOptionsQuery(query) { return wmsParseOptionsQuery(query); }

/**
 * Delegated to wms-shared.js (wmsBuildOptionsCandidates)
 */
function trWlBuildOptionsCandidates(underlying, strike, optionType, expiryHint) { return wmsBuildOptionsCandidates(underlying, strike, optionType, expiryHint); }

// Date helpers (wmsNextThursday, wmsGetWeeklyExpiries, wmsGetMonthlyExpiry) now in wms-shared.js

/**
 * Delegated to wms-shared.js (wmsFormatOptionsDisplay)
 */
function trWlFormatOptionsDisplay(fyersSymbol, underlying, strike, optionType) { return wmsFormatOptionsDisplay(fyersSymbol, underlying, strike, optionType); }

/**
 * Search options via Fyers API — builds candidates, batch validates, returns valid ones.
 */
async function trWlSearchOptions(parsed, resultsEl) {
    if (!window.fyersToken) {
        resultsEl.innerHTML = '<div class="wl-add-no-results">Fyers not connected — cannot search options.<br>' +
            '<span style="font-size:11px;color:#718096;">Options search requires an active Fyers connection.</span></div>';
        return;
    }

    resultsEl.innerHTML = '<div class="wl-add-no-results">Searching options...</div>';

    var candidates = trWlBuildOptionsCandidates(parsed.underlying, parsed.strike, parsed.optionType, parsed.expiryHint);

    if (candidates.length === 0) {
        resultsEl.innerHTML = '<div class="wl-add-no-results">Could not build option symbols for "' +
            wmsEsc(parsed.underlying) + '"</div>';
        return;
    }

    console.log('Watchlist: Options search — candidates:', candidates);

    try {
        var data = await window.fyersCall({ action: 'quotes', symbols: candidates });
        var validResults = [];

        console.log('Watchlist: Options search — raw Fyers response:', JSON.stringify(data));

        if (data && data.d && data.d.length > 0) {
            data.d.forEach(function(item) {
                console.log('Watchlist: Options candidate result:', item.v ? item.v.symbol : 'no-v', 'lp:', item.v ? item.v.lp : 'N/A', 'sent:', candidates);
                if (item.v && item.v.lp > 0) {
                    validResults.push({
                        symbol: item.v.symbol,
                        lp: item.v.lp,
                        ch: item.v.ch || 0,
                        chp: item.v.chp || 0
                    });
                }
            });
        }

        if (validResults.length === 0) {
            resultsEl.innerHTML = '<div class="wl-add-no-results">No active options found for "' +
                wmsEsc(parsed.underlying + ' ' + parsed.strike + ' ' + parsed.optionType) + '"<br>' +
                '<span style="font-size:11px;color:#718096;">Try a different strike price or expiry month.</span></div>';
            return;
        }

        // Check which are already in the watchlist
        var wl = trWlWatchlists.find(function(w) { return w.id === trWlAddTargetId; });
        var existingKeys = {};
        if (wl) {
            wl.items.forEach(function(item) {
                existingKeys[item.security_source + ':' + item.security_id] = true;
            });
        }

        // Build search cache with options results
        trWlSearchCache = [];
        validResults.forEach(function(r) {
            var displayLabel = trWlFormatOptionsDisplay(r.symbol, parsed.underlying, parsed.strike, parsed.optionType);
            trWlSearchCache.push({
                security_id: r.symbol,  // Fyers symbol IS the ID for options_dynamic
                security_source: 'options_dynamic',
                short_symbol: displayLabel,
                company_name: parsed.underlying + ' Option',
                security_type: 'OPT',
                exchange: r.symbol.split(':')[0] || 'NSE',
                broker_tokens: {},
                nse_symbol: '',
                bse_symbol: '',
                isAdded: !!existingKeys['options_dynamic:' + r.symbol],
                _lp: r.lp,
                _ch: r.ch,
                _chp: r.chp
            });
        });

        // Render options results
        var html = '';
        trWlSearchCache.forEach(function(item, idx) {
            var priceHtml = '<span style="font-size:11px;color:#4a5568;">₹' + formatPrice(item._lp, false) + '</span>';
            var chpClass = item._chp >= 0 ? 'positive' : 'negative';
            var chpSign = item._chp >= 0 ? '+' : '';
            var changeHtml = '<span style="font-size:10px;" class="' + chpClass + '">' + chpSign + item._chp.toFixed(2) + '%</span>';

            var tagsHtml = '<span class="wl-res-tags">' +
                '<span class="wl-res-type">OPT</span>' +
                '<span class="wl-res-exchange">' + wmsEsc(item.exchange) + '</span>' +
                priceHtml + ' ' + changeHtml +
                (item.isAdded ? '<span style="font-size:10px;color:#059669;">✓</span>' : '') +
                '</span>';
            html += '<div class="wl-add-result-item' + (item.isAdded ? ' added' : '') + '" data-idx="' + idx + '" title="' + wmsEsc(item.security_id) + '">' +
                '<span class="wl-res-symbol">' + wmsEsc(item.short_symbol) + '</span>' +
                '<span class="wl-res-name">' + wmsEsc(item.company_name) + '</span>' +
                tagsHtml +
                '</div>';
        });

        resultsEl.innerHTML = html;

        // Attach click handlers
        resultsEl.querySelectorAll('.wl-add-result-item:not(.added)').forEach(function(el) {
            el.addEventListener('click', function() {
                var idx = parseInt(el.dataset.idx);
                var cached = trWlSearchCache[idx];
                if (!cached) return;
                trWlAddItem(cached);
            });
        });

        // Show dropdown with results
        if (trWlSearchDdCtrl) trWlSearchDdCtrl.show();

    } catch (err) {
        resultsEl.innerHTML = '<div class="wl-add-no-results">Options search failed: ' + err.message + '</div>';
    }
}

async function trWlSearchSecurities(query) {
    var resultsEl = document.getElementById('trWlAddResults');
    if (!query || query.length < 2) {
        resultsEl.innerHTML = '<div class="wl-add-no-results">Type at least 2 characters to search...</div>';
        return;
    }

    // Check if this is an options query (contains CE/PE + strike)
    var optionsParsed = trWlParseOptionsQuery(query);
    if (optionsParsed) {
        await trWlSearchOptions(optionsParsed, resultsEl);
        return;
    }

    try {
        // Ensure securities cache is loaded (wait if still downloading on startup)
        if (!wmsRefData.securitiesCmReady || !wmsRefData.securitiesNfoReady) {
            resultsEl.innerHTML = '<div class="wl-add-no-results">Loading securities data...</div>';
            if (!wmsRefData.securitiesCmReady) await wmsLoadSecuritiesCm(0, {all: true});
            if (!wmsRefData.securitiesNfoReady) await wmsLoadSecuritiesNfo();
        }

        // Client-side search from shared cache (no network calls)
        var cached = wmsSearchSecurities(query);

        // Check which securities are already in the target watchlist
        var wl = trWlWatchlists.find(function(w) { return w.id === trWlAddTargetId; });
        var existingKeys = {};
        if (wl) {
            wl.items.forEach(function(item) {
                existingKeys[item.security_source + ':' + item.security_id] = true;
            });
        }

        // Build search cache from shared cache results
        trWlSearchCache = [];

        cached.forEach(function(r) {
            if (r._isNfo) {
                // NFO result
                trWlSearchCache.push({
                    security_id: r.id,
                    security_source: 'securities_nfo',
                    short_symbol: r.symbol || r.underlying_symbol,
                    company_name: r.instrument_name || r.symbol,
                    security_type: r.instrument_type || 'F&O',
                    exchange: r.exchange || '',
                    broker_tokens: r.broker_tokens || {},
                    nse_symbol: '',
                    bse_symbol: '',
                    isAdded: !!existingKeys['securities_nfo:' + r.id],
                    _expiryDate: r.expiry_date || null,
                    _instrumentName: r.instrument_name || ''
                });
            } else {
                // CM result
                var displaySymbol = r.nse_symbol || r.bse_symbol || r.symbol;
                trWlSearchCache.push({
                    security_id: r.id,
                    security_source: 'securities_db',
                    short_symbol: displaySymbol,
                    company_name: r.company_name || '',
                    security_type: r.security_type || 'EQ',
                    exchange: r.nse_symbol ? 'NSE' : (r.bse_symbol ? 'BSE' : ''),
                    broker_tokens: r.broker_tokens || {},
                    nse_symbol: r.nse_symbol || '',
                    bse_symbol: r.bse_symbol || '',
                    isAdded: !!existingKeys['securities_db:' + r.id]
                });
            }
        });

        // Render results — only data-idx attribute needed (index into trWlSearchCache)
        var html = '';
        trWlSearchCache.forEach(function(item, idx) {
            var tagsHtml = '<span class="wl-res-tags">' +
                '<span class="wl-res-type">' + wmsEsc(item.security_type) + '</span>' +
                (item.exchange ? '<span class="wl-res-exchange">' + wmsEsc(item.exchange) + '</span>' : '') +
                (item.isAdded ? '<span style="font-size:10px;color:#059669;">✓</span>' : '') +
                '</span>';
            html += '<div class="wl-add-result-item' + (item.isAdded ? ' added' : '') + '" data-idx="' + idx + '" title="' + wmsEsc(item.company_name) + '">' +
                '<span class="wl-res-symbol">' + wmsEsc(item.short_symbol) + '</span>' +
                '<span class="wl-res-name">' + wmsEsc(item.company_name) + '</span>' +
                tagsHtml +
                '</div>';
        });

        if (!html) {
            html = '<div class="wl-add-no-results">' +
                'No results found for "' + wmsEsc(query) + '"<br>' +
                '<span style="font-size:11px;color:#718096;margin-top:6px;display:inline-block;">' +
                'Either update the Master Database to add this security,<br>or enter the full security symbol to search on the broker website.' +
                '</span></div>';
        }

        resultsEl.innerHTML = html;

        // Attach click handlers — read from JS cache by index, not from data-attributes
        resultsEl.querySelectorAll('.wl-add-result-item:not(.added)').forEach(function(el) {
            el.addEventListener('click', function() {
                var idx = parseInt(el.dataset.idx);
                var cached = trWlSearchCache[idx];
                if (!cached) return;
                trWlAddItem(cached);
            });
        });

        // Show dropdown with results
        if (html.indexOf('wl-add-result-item') !== -1 && trWlSearchDdCtrl) {
            trWlSearchDdCtrl.show();
        }

    } catch (err) {
        resultsEl.innerHTML = '<div class="wl-add-no-results">Search failed: ' + err.message + '</div>';
    }
}

async function trWlAddItem(security) {
    if (!trWlAddTargetId) return;

    // Validate security_id — accept any truthy value (integer or UUID string)
    if (!security.security_id && security.security_id !== 0) {
        console.error('Watchlist: Missing security_id — full object:', JSON.stringify(security));
        showAlert('Failed to add — missing security ID. Check console for details.', 'error');
        return;
    }

    var wl = trWlWatchlists.find(function(w) { return w.id === trWlAddTargetId; });
    if (!wl) return;

    // Check duplicate
    var exists = wl.items.some(function(item) {
        return item.security_id === security.security_id && item.security_source === security.security_source;
    });
    if (exists) {
        showAlert('Already in this watchlist', 'info', 2000);
        return;
    }

    // Derive Fyers symbol BEFORE insert — options_dynamic uses security_id directly
    var fyersSymbol;
    if (security.security_source === 'options_dynamic') {
        fyersSymbol = security.security_id; // Fyers symbol IS the security_id
        console.log('Watchlist: Adding options_dynamic — fyersSymbol:', fyersSymbol, 'search price:', security._lp);
        // Pre-populate price from search results so it shows immediately
        if (security._lp) {
            trWlPrices[fyersSymbol] = {
                lp: security._lp,
                ch: security._ch || 0,
                chp: security._chp || 0,
                high: null,
                low: null
            };
        }
    } else {
        fyersSymbol = trWlDeriveFyersSymbol(security);

        // If no broker_tokens.fyers and we have a symbol to try, validate via Fyers and update DB
        if (!fyersSymbol && security.security_source === 'securities_db') {
            fyersSymbol = await trWlResolveFyersSymbol(security);
        }
    }

    var sortOrder = wl.items.length;
    var body = {
        watchlist_id: trWlAddTargetId,
        security_id: security.security_id,
        security_source: security.security_source,
        short_symbol: security.short_symbol,
        company_name: security.company_name,
        sort_order: sortOrder
    };

    var resp = await fetch(SUPABASE_URL + '/rest/v1/watchlist_items', {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        },
        body: JSON.stringify(body)
    });

    if (resp.ok) {
        var newItem = (await resp.json())[0];
        newItem._fyersSymbol = fyersSymbol;
        if (security.security_source === 'securities_nfo') {
            newItem._displaySymbol = security.short_symbol;
            newItem._expiryDate = security._expiryDate || null;
            newItem._nfoExchange = security.exchange || '';
            newItem._instrumentName = security._instrumentName || '';
        }
        if (security.security_source === 'options_dynamic') {
            newItem._displaySymbol = security.short_symbol;
        }

        wl.items.push(newItem);

        // Fetch price for new item if we have Fyers symbol
        if (newItem._fyersSymbol && window.fyersToken) {
            try {
                console.log('Watchlist: Post-add price fetch for:', newItem._fyersSymbol);
                var data = await window.fyersCall({ action: 'quotes', symbols: [newItem._fyersSymbol] });
                if (data && data.d && data.d.length > 0 && data.d[0].v) {
                    var v = data.d[0].v;
                    console.log('Watchlist: Post-add Fyers returned symbol:', v.symbol, 'lp:', v.lp, '(requested:', newItem._fyersSymbol + ')');
                    var priceData = {
                        lp: v.lp || 0,
                        ch: v.ch || 0,
                        chp: v.chp || 0,
                        high: v.high_price || null,
                        low: v.low_price || null
                    };
                    trWlPrices[v.symbol] = priceData;
                    // Also store under the requested symbol in case Fyers returns a different canonical form
                    if (v.symbol !== newItem._fyersSymbol) {
                        console.warn('Watchlist: Fyers returned different symbol! Stored:', v.symbol, 'Requested:', newItem._fyersSymbol);
                        trWlPrices[newItem._fyersSymbol] = priceData;
                    }
                }
            } catch (err) {
                console.warn('Watchlist: Price fetch for new item failed:', err.message);
            }
        }

        showAlert(security.short_symbol + ' added to watchlist', 'success', 1500);

        // Mark the search result as added (don't close modal — let user add more)
        var addedRow = document.querySelector('.wl-add-result-item[data-idx="' + trWlSearchCache.indexOf(security) + '"]');
        if (!addedRow) {
            // Find by security_id match
            trWlSearchCache.forEach(function(c, i) {
                if (c.security_id === security.security_id && c.security_source === security.security_source) {
                    addedRow = document.querySelector('.wl-add-result-item[data-idx="' + i + '"]');
                }
            });
        }
        if (addedRow) {
            addedRow.classList.add('added');
            // Add checkmark and remove click handler
            var tagsEl = addedRow.querySelector('.wl-res-tags');
            if (tagsEl && !tagsEl.querySelector('.wl-added-check')) {
                tagsEl.insertAdjacentHTML('beforeend', '<span class="wl-added-check" style="font-size:10px;color:#059669;">✓</span>');
            }
            // Clone to remove event listeners
            var newRow = addedRow.cloneNode(true);
            addedRow.parentNode.replaceChild(newRow, addedRow);
        }

        // Update the card in background (re-render the specific watchlist card)
        trWlRender();
    } else {
        var errText = await resp.text();
        if (errText.indexOf('unique') >= 0 || errText.indexOf('duplicate') >= 0) {
            showAlert('Already in this watchlist', 'info', 2000);
        } else {
            showAlert('Failed to add: ' + errText, 'error');
        }
    }
}

// Derive Fyers symbol from security data (sync — no API calls)
function trWlDeriveFyersSymbol(security) {
    // Options dynamic: the Fyers symbol IS the security_id
    if (security.security_source === 'options_dynamic') {
        return security.security_id;
    }
    if (security.security_source === 'securities_nfo') {
        if (security.broker_tokens && security.broker_tokens.fyers) {
            return security.broker_tokens.fyers.symbol || security.broker_tokens.fyers.nse_symbol || null;
        }
        return null;
    }
    // securities_db
    var bt = security.broker_tokens;
    if (bt && bt.fyers) {
        // Try all known key patterns
        return bt.fyers.nse_symbol || bt.fyers.bse_symbol || bt.fyers.symbol || null;
    }
    // Fallback: derive from nse_symbol / bse_symbol columns
    if (security.nse_symbol) return 'NSE:' + security.nse_symbol + '-EQ';
    if (security.bse_symbol) return 'BSE:' + security.bse_symbol;  // No suffix — resolution will find correct series
    // Last resort: try short_symbol
    if (security.short_symbol) return 'NSE:' + security.short_symbol + '-EQ';
    return null;
}

// Resolve Fyers symbol by calling Fyers quotes API and updating securities_db broker_tokens
async function trWlResolveFyersSymbol(security) {
    if (!window.fyersToken) return null;

    // Build candidate symbols to try — all BSE series comprehensively
    var bseSuffixes = ['', '-A', '-B', '-D', '-E', '-G', '-M', '-P', '-R', '-T', '-W', '-X', '-Z'];
    var candidates = [];
    if (security.nse_symbol) {
        candidates.push('NSE:' + security.nse_symbol + '-EQ');
        candidates.push('NSE:' + security.nse_symbol + '-SM');
    }
    if (security.bse_symbol) {
        bseSuffixes.forEach(function(sfx) {
            candidates.push('BSE:' + security.bse_symbol + sfx);
        });
    }
    if (security.short_symbol) {
        var nseCandidate = 'NSE:' + security.short_symbol + '-EQ';
        var smeCandidate = 'NSE:' + security.short_symbol + '-SM';
        if (candidates.indexOf(nseCandidate) < 0) candidates.push(nseCandidate);
        if (candidates.indexOf(smeCandidate) < 0) candidates.push(smeCandidate);
    }

    if (candidates.length === 0) return null;

    console.log('Watchlist: Resolving Fyers symbol for', security.short_symbol, '— trying:', candidates);

    try {
        var data = await window.fyersCall({ action: 'quotes', symbols: candidates });
        if (data && data.d && data.d.length > 0) {
            // Find the first successful quote
            var validQuote = null;
            for (var i = 0; i < data.d.length; i++) {
                if (data.d[i].v && data.d[i].v.lp > 0) {
                    validQuote = data.d[i].v;
                    break;
                }
            }

            if (validQuote) {
                var resolvedSymbol = validQuote.symbol;
                console.log('Watchlist: Resolved Fyers symbol:', resolvedSymbol);

                // Store the price we just got
                trWlPrices[resolvedSymbol] = {
                    lp: validQuote.lp || 0,
                    ch: validQuote.ch || 0,
                    chp: validQuote.chp || 0,
                    high: validQuote.high_price || null,
                    low: validQuote.low_price || null
                };

                // Update securities_db broker_tokens in background
                trWlUpdateSecurityBrokerTokens(security.security_id, resolvedSymbol);

                return resolvedSymbol;
            }
        }
    } catch (err) {
        console.warn('Watchlist: Fyers symbol resolution failed:', err.message);
    }
    return null;
}

// Update securities_db broker_tokens with the resolved Fyers symbol
async function trWlUpdateSecurityBrokerTokens(securityId, fyersSymbol) {
    try {
        // First fetch current record to preserve existing broker_tokens
        var getResp = await fetch(SUPABASE_URL + '/rest/v1/securities_db?id=eq.' + securityId + '&select=broker_tokens,nse_symbol,bse_symbol', {
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
        });
        if (!getResp.ok) return;
        var rows = await getResp.json();
        if (rows.length === 0) return;

        var existing = rows[0];
        var bt = existing.broker_tokens || {};
        if (!bt.fyers) bt.fyers = {};

        // Parse the Fyers symbol to determine exchange (NSE:SYMBOL-EQ or BSE:SYMBOL-A)
        if (fyersSymbol.indexOf('NSE:') === 0) {
            bt.fyers.nse_symbol = fyersSymbol;
        } else if (fyersSymbol.indexOf('BSE:') === 0) {
            bt.fyers.bse_symbol = fyersSymbol;
        }

        // Update DB — use return=representation to verify the update actually took effect
        // (Supabase returns 200 with empty array if RLS blocks the update)
        var patchResp = await fetch(SUPABASE_URL + '/rest/v1/securities_db?id=eq.' + securityId, {
            method: 'PATCH',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation'
            },
            body: JSON.stringify({ broker_tokens: bt })
        });

        if (patchResp.ok) {
            var updatedRows = await patchResp.json();
            if (updatedRows && updatedRows.length > 0) {
                console.log('Watchlist: Updated broker_tokens for security', securityId, 'with', fyersSymbol);
            } else {
                console.error('Watchlist: broker_tokens PATCH returned OK but 0 rows updated — likely RLS blocking. Security:', securityId, 'Symbol:', fyersSymbol);
            }
        } else {
            console.warn('Watchlist: Failed to update broker_tokens:', patchResp.status, await patchResp.text());
        }
    } catch (err) {
        console.warn('Watchlist: broker_tokens update error:', err.message);
    }
}

async function trWlDeleteItem(itemId, wlId) {
    var resp = await fetch(SUPABASE_URL + '/rest/v1/watchlist_items?id=eq.' + itemId, {
        method: 'DELETE',
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
            'Prefer': 'return=minimal'
        }
    });

    if (resp.ok) {
        var wl = trWlWatchlists.find(function(w) { return w.id === wlId; });
        if (wl) {
            wl.items = wl.items.filter(function(item) { return item.id !== itemId; });
        }
        trWlRender();
    } else {
        showAlert('Failed to remove security', 'error');
    }
}

// ============================================================================
// SORT ITEMS WITHIN WATCHLIST
// ============================================================================

function trWlGetSortedItems(wl) {
    var ss = trWlSortState[wl.id];
    if (!ss) return wl.items; // natural DB order

    var sorted = wl.items.slice(); // copy
    if (ss.field === 'name') {
        sorted.sort(function(a, b) {
            var aName = (a._displaySymbol || a.short_symbol || '').toLowerCase();
            var bName = (b._displaySymbol || b.short_symbol || '').toLowerCase();
            return aName < bName ? -1 : (aName > bName ? 1 : 0);
        });
    } else if (ss.field === 'chp') {
        sorted.sort(function(a, b) {
            var aPrice = trWlPrices[a._fyersSymbol];
            var bPrice = trWlPrices[b._fyersSymbol];
            var aChp = aPrice ? aPrice.chp : -9999;
            var bChp = bPrice ? bPrice.chp : -9999;
            return aChp - bChp;
        });
    }
    if (ss.dir === 'desc') sorted.reverse();
    return sorted;
}

function trWlToggleSort(wlId, field) {
    var ss = trWlSortState[wlId];
    if (ss && ss.field === field) {
        if (ss.dir === 'asc') {
            trWlSortState[wlId] = { field: field, dir: 'desc' };
        } else {
            // Third click: clear sort
            delete trWlSortState[wlId];
        }
    } else {
        trWlSortState[wlId] = { field: field, dir: 'asc' };
    }
    trWlRender();
}

// ============================================================================
// DRAG REORDER ITEMS WITHIN WATCHLIST CARD
// ============================================================================

function trWlSetupItemDrag() {
    document.querySelectorAll('.wl-security-row').forEach(function(row) {
        row.addEventListener('dragstart', function(e) {
            // Only allow drag from the drag handle
            if (!e.target.closest('.wl-sec-drag') && e.target !== row) {
                e.preventDefault();
                return;
            }
            var wlId = row.dataset.wlId;
            var itemId = row.dataset.itemId;
            var wl = trWlWatchlists.find(function(w) { return w.id === wlId; });
            if (!wl) return;
            var fromIdx = wl.items.findIndex(function(it) { return it.id === itemId; });
            trWlDragItemState = { wlId: wlId, itemId: itemId, fromIdx: fromIdx };
            row.classList.add('wl-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', itemId);
        });

        row.addEventListener('dragend', function() {
            row.classList.remove('wl-dragging');
            trWlDragItemState = null;
            document.querySelectorAll('.wl-security-row').forEach(function(r) {
                r.classList.remove('wl-drag-over-top', 'wl-drag-over-bottom');
            });
        });

        row.addEventListener('dragover', function(e) {
            if (!trWlDragItemState) return;
            if (row.dataset.wlId !== trWlDragItemState.wlId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            // Show drop indicator
            var rect = row.getBoundingClientRect();
            var midY = rect.top + rect.height / 2;
            document.querySelectorAll('.wl-security-row').forEach(function(r) {
                r.classList.remove('wl-drag-over-top', 'wl-drag-over-bottom');
            });
            if (e.clientY < midY) {
                row.classList.add('wl-drag-over-top');
            } else {
                row.classList.add('wl-drag-over-bottom');
            }
        });

        row.addEventListener('dragleave', function() {
            row.classList.remove('wl-drag-over-top', 'wl-drag-over-bottom');
        });

        row.addEventListener('drop', function(e) {
            e.preventDefault();
            if (!trWlDragItemState) return;
            var wlId = trWlDragItemState.wlId;
            if (row.dataset.wlId !== wlId) return;

            var wl = trWlWatchlists.find(function(w) { return w.id === wlId; });
            if (!wl) return;

            var fromIdx = trWlDragItemState.fromIdx;
            var toItemId = row.dataset.itemId;
            var toIdx = wl.items.findIndex(function(it) { return it.id === toItemId; });
            if (fromIdx === toIdx) return;

            // Determine drop position (above or below)
            var rect = row.getBoundingClientRect();
            var midY = rect.top + rect.height / 2;
            if (e.clientY >= midY && toIdx > fromIdx) {
                // dropping below, and target is already after source — keep toIdx
            } else if (e.clientY < midY && toIdx < fromIdx) {
                // dropping above, and target is already before source — keep toIdx
            } else if (e.clientY >= midY) {
                toIdx = toIdx; // after target
            } else {
                toIdx = toIdx; // before target
            }

            // Move in array
            var moved = wl.items.splice(fromIdx, 1)[0];
            wl.items.splice(toIdx, 0, moved);

            // Clear any sort — user manual ordering takes precedence
            delete trWlSortState[wlId];

            // Update sort_order in DB
            trWlSaveItemOrder(wl);
            trWlRender();
        });
    });
}

async function trWlSaveItemOrder(wl) {
    // Batch update sort_order for all items in the watchlist
    var promises = wl.items.map(function(item, idx) {
        item.sort_order = idx;
        return fetch(SUPABASE_URL + '/rest/v1/watchlist_items?id=eq.' + item.id, {
            method: 'PATCH',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ sort_order: idx })
        });
    });
    try {
        await Promise.all(promises);
    } catch (err) {
        console.warn('Watchlist: Failed to save item order:', err.message);
    }
}

// ============================================================================
// REORDER MODAL
// ============================================================================

var trWlReorderList = [];  // Temp copy of watchlists for reordering

function trWlOpenReorderModal() {
    if (trWlWatchlists.length < 2) {
        showAlert('Need at least 2 watchlists to reorder', 'info', 2000);
        return;
    }
    // Copy current order
    trWlReorderList = trWlWatchlists.map(function(wl) {
        return { id: wl.id, name: wl.name, itemCount: wl.items.length };
    });
    trWlRenderReorderList();
    if (trWlReorderModal) trWlReorderModal.open();
}

function trWlCloseReorderModal() {
    // Use modal controller to close (handles cleanup via onClose callback)
    if (trWlReorderModal) trWlReorderModal.close();
}

function trWlRenderReorderList() {
    var body = document.getElementById('trWlReorderBody');
    if (!body) return;
    body.innerHTML = trWlReorderList.map(function(wl, idx) {
        return '<div class="wl-reorder-item" data-idx="' + idx + '">' +
            '<span class="wl-reorder-handle">☰</span>' +
            '<span class="wl-reorder-name" data-wl-id="' + wl.id + '" title="Click to rename">' + wmsEsc(wl.name) +
                '<span class="wl-reorder-count">(' + wl.itemCount + ')</span>' +
            '</span>' +
            '<div class="wl-reorder-arrows">' +
                '<button class="btn-reorder-arrow" data-dir="up" data-idx="' + idx + '"' +
                    (idx === 0 ? ' disabled' : '') + ' title="Move up">▲</button>' +
                '<button class="btn-reorder-arrow" data-dir="down" data-idx="' + idx + '"' +
                    (idx === trWlReorderList.length - 1 ? ' disabled' : '') + ' title="Move down">▼</button>' +
            '</div>' +
        '</div>';
    }).join('');

    // Attach arrow click handlers
    body.querySelectorAll('.btn-reorder-arrow').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var idx = parseInt(btn.dataset.idx);
            var dir = btn.dataset.dir;
            trWlReorderMove(idx, dir);
        });
    });

    // Attach name click handlers for inline rename
    body.querySelectorAll('.wl-reorder-name').forEach(function(nameEl) {
        nameEl.addEventListener('click', function(e) {
            e.stopPropagation();
            trWlStartReorderRename(nameEl);
        });
    });

    // Attach drag handlers for mouse-based reorder
    trWlSetupDragReorder(body);
}

function trWlStartReorderRename(nameEl) {
    var wlId = nameEl.dataset.wlId;
    var wlReorder = trWlReorderList.find(function(w) { return w.id === wlId; });
    if (!wlReorder) return;

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'wl-reorder-name-input';
    input.value = wlReorder.name;
    input.maxLength = 40;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    function finishRename() {
        var newName = input.value.trim();
        if (newName && newName !== wlReorder.name) {
            // Update in reorder list
            wlReorder.name = newName;
            // Update in main watchlists array
            var mainWl = trWlWatchlists.find(function(w) { return w.id === wlId; });
            if (mainWl) mainWl.name = newName;
            // Persist to DB
            trWlRenameWatchlist(wlId, newName);
        }
        trWlRenderReorderList();
    }

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { input.blur(); }
        if (e.key === 'Escape') { trWlRenderReorderList(); }
    });
}

function trWlReorderMove(idx, direction) {
    var targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= trWlReorderList.length) return;

    // Swap
    var temp = trWlReorderList[idx];
    trWlReorderList[idx] = trWlReorderList[targetIdx];
    trWlReorderList[targetIdx] = temp;

    trWlRenderReorderList();

    // Briefly highlight the moved item
    var items = document.querySelectorAll('.wl-reorder-item');
    if (items[targetIdx]) {
        items[targetIdx].style.background = '#ebf4ff';
        setTimeout(function() { items[targetIdx].style.background = ''; }, 300);
    }
}

async function trWlSaveReorder() {
    // Update sort_order for each watchlist
    var promises = trWlReorderList.map(function(wl, idx) {
        return fetch(SUPABASE_URL + '/rest/v1/watchlists?id=eq.' + wl.id, {
            method: 'PATCH',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ sort_order: idx })
        });
    });

    try {
        await Promise.all(promises);

        // Reorder the in-memory array to match
        var idOrder = trWlReorderList.map(function(wl) { return wl.id; });
        trWlWatchlists.sort(function(a, b) {
            return idOrder.indexOf(a.id) - idOrder.indexOf(b.id);
        });
        // Update sort_order in memory too
        trWlWatchlists.forEach(function(wl, idx) { wl.sort_order = idx; });

        trWlCloseReorderModal();
        trWlRender();
        showAlert('Watchlist order saved', 'success', 2000);
    } catch (err) {
        showAlert('Failed to save order: ' + err.message, 'error');
    }
}

// Drag-to-reorder within the modal
function trWlSetupDragReorder(container) {
    var dragIdx = null;

    container.querySelectorAll('.wl-reorder-handle').forEach(function(handle) {
        var item = handle.closest('.wl-reorder-item');
        item.setAttribute('draggable', 'true');

        item.addEventListener('dragstart', function(e) {
            dragIdx = parseInt(item.dataset.idx);
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', dragIdx);
        });

        item.addEventListener('dragend', function() {
            item.classList.remove('dragging');
            dragIdx = null;
            // Remove all drag-over highlights
            container.querySelectorAll('.wl-reorder-item').forEach(function(el) {
                el.style.borderTop = '';
                el.style.borderBottom = '';
            });
        });
    });

    container.querySelectorAll('.wl-reorder-item').forEach(function(dropTarget) {
        dropTarget.addEventListener('dragover', function(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            var targetIdx = parseInt(dropTarget.dataset.idx);
            // Visual indicator
            container.querySelectorAll('.wl-reorder-item').forEach(function(el) {
                el.style.borderTop = '';
                el.style.borderBottom = '';
            });
            if (targetIdx < dragIdx) {
                dropTarget.style.borderTop = '2px solid #667eea';
            } else if (targetIdx > dragIdx) {
                dropTarget.style.borderBottom = '2px solid #667eea';
            }
        });

        dropTarget.addEventListener('drop', function(e) {
            e.preventDefault();
            var fromIdx = dragIdx;
            var toIdx = parseInt(dropTarget.dataset.idx);
            if (fromIdx === null || fromIdx === toIdx) return;

            // Move item in array
            var moved = trWlReorderList.splice(fromIdx, 1)[0];
            trWlReorderList.splice(toIdx, 0, moved);

            trWlRenderReorderList();
        });
    });
}

// ============================================================================
// PRICE ALERTS  (dual: alert_above + alert_below per item)
// ============================================================================

// Track which alerts have already shown a toast (avoid repeat toasts)
var trWlAlertToasted = {};  // "itemId:above" or "itemId:below" → true

// Compute alert visual state for a given item + CMP
// Returns: { dotClass, aboveState, belowState }
// Single dot: 'dot-set' (yellow, alert exists), 'dot-near' (amber, within 2%),
//             'dot-triggered-above' (green), 'dot-triggered-below' (red)
function trWlGetAlertState(item, cmp) {
    var result = {
        dotClass: 'dot-set',       // default: yellow (alert exists)
        aboveState: 'far',         // 'far', 'near', 'triggered'
        belowState: 'far'
    };

    var hasAbove = item.alert_above != null;
    var hasBelow = item.alert_below != null;
    if (!hasAbove && !hasBelow) return result;
    if (cmp == null || cmp <= 0) return result;

    if (hasAbove) {
        var abovePrice = Number(item.alert_above);
        if (cmp >= abovePrice) {
            result.aboveState = 'triggered';
        } else if (Math.abs(cmp - abovePrice) / abovePrice <= 0.02) {
            result.aboveState = 'near';
        }
    }

    if (hasBelow) {
        var belowPrice = Number(item.alert_below);
        if (cmp <= belowPrice) {
            result.belowState = 'triggered';
        } else if (Math.abs(cmp - belowPrice) / belowPrice <= 0.02) {
            result.belowState = 'near';
        }
    }

    // Pick most urgent state for the single dot
    if (result.aboveState === 'triggered') {
        result.dotClass = 'dot-triggered-above';
    } else if (result.belowState === 'triggered') {
        result.dotClass = 'dot-triggered-below';
    } else if (result.aboveState === 'near' || result.belowState === 'near') {
        result.dotClass = 'dot-near';
    }
    // else stays 'dot-set' (yellow)

    return result;
}

// Update alert visuals in-place during price refresh
function trWlUpdateAlertsInPlace() {
    var rows = document.querySelectorAll('.wl-security-row');
    rows.forEach(function(row) {
        var itemId = row.dataset.itemId;
        var wlId = row.dataset.wlId;

        // Find the item
        var item = null;
        for (var w = 0; w < trWlWatchlists.length; w++) {
            var wl = trWlWatchlists[w];
            if (wl.id !== wlId) continue;
            for (var i = 0; i < wl.items.length; i++) {
                if (wl.items[i].id === itemId) { item = wl.items[i]; break; }
            }
            if (item) break;
        }
        if (!item) return;

        var hasAbove = item.alert_above != null;
        var hasBelow = item.alert_below != null;

        var price = trWlPrices[item._fyersSymbol];
        var cmp = price ? price.lp : null;
        var state = trWlGetAlertState(item, cmp);

        // Update single dot inside .wl-sec-price
        var priceCell = row.querySelector('.wl-sec-price');
        if (!priceCell) return;

        // Remove existing dot
        var existingDot = priceCell.querySelector('.wl-alert-dot');
        if (existingDot) existingDot.remove();

        if (hasAbove || hasBelow) {
            var dotTitle = '';
            if (hasBelow) dotTitle += '▼ ₹' + Number(item.alert_below).toLocaleString('en-IN');
            if (hasAbove && hasBelow) dotTitle += '  ';
            if (hasAbove) dotTitle += '▲ ₹' + Number(item.alert_above).toLocaleString('en-IN');

            var dot = document.createElement('span');
            dot.className = 'wl-alert-dot ' + state.dotClass;
            dot.title = dotTitle;

            var priceMain = priceCell.querySelector('.wl-price-main');
            if (priceMain) priceCell.insertBefore(dot, priceMain);
        }

        // Toast notifications on first trigger (per direction)
        var sym = item._displaySymbol || item.short_symbol;
        if (state.aboveState === 'triggered' && !trWlAlertToasted[item.id + ':above']) {
            trWlAlertToasted[item.id + ':above'] = true;
            showAlert(sym + ' crossed ▲ ₹' + Number(item.alert_above).toLocaleString('en-IN'), 'info', 4000);
        }
        if (state.belowState === 'triggered' && !trWlAlertToasted[item.id + ':below']) {
            trWlAlertToasted[item.id + ':below'] = true;
            showAlert(sym + ' dropped ▼ ₹' + Number(item.alert_below).toLocaleString('en-IN'), 'info', 4000);
        }
    });
}

// Open alert popover on a security row
// editDir: optional 'above' or 'below' to pre-focus that field
var trWlAlertPopoverRow = null;

function trWlOpenAlertPopover(row, editDir) {
    trWlCloseAlertPopover();

    var itemId = row.dataset.itemId;
    var wlId = row.dataset.wlId;

    // Find item
    var item = null;
    for (var w = 0; w < trWlWatchlists.length; w++) {
        var wl = trWlWatchlists[w];
        if (wl.id !== wlId) continue;
        for (var i = 0; i < wl.items.length; i++) {
            if (wl.items[i].id === itemId) { item = wl.items[i]; break; }
        }
        if (item) break;
    }
    if (!item) return;

    var price = trWlPrices[item._fyersSymbol];
    var cmp = price ? price.lp : null;

    // Prefill values
    var aboveVal = item.alert_above != null ? Number(item.alert_above) : '';
    var belowVal = item.alert_below != null ? Number(item.alert_below) : '';

    var popoverHtml = '<div class="wl-alert-popover">' +
        '<span class="wl-alert-dir" style="color:#dc2626;">▼</span>' +
        '<input type="number" class="alert-input-below" value="' + belowVal + '" placeholder="Below" step="any">' +
        (belowVal ? '<button class="btn-alert-clear" data-dir="below" title="Clear">✕</button>' : '') +
        '<span style="color:#e2e8f0;font-size:10px;">│</span>' +
        '<span class="wl-alert-dir" style="color:#059669;">▲</span>' +
        '<input type="number" class="alert-input-above" value="' + aboveVal + '" placeholder="Above" step="any">' +
        (aboveVal ? '<button class="btn-alert-clear" data-dir="above" title="Clear">✕</button>' : '') +
        '<button class="btn-alert-save">Set</button>' +
    '</div>';

    row.insertAdjacentHTML('beforeend', popoverHtml);
    trWlAlertPopoverRow = row;

    var popover = row.querySelector('.wl-alert-popover');
    var inputAbove = popover.querySelector('.alert-input-above');
    var inputBelow = popover.querySelector('.alert-input-below');

    // Save button — saves both fields at once
    popover.querySelector('.btn-alert-save').addEventListener('click', function() {
        var aboveV = parseFloat(inputAbove.value) || null;
        var belowV = parseFloat(inputBelow.value) || null;

        // Validate: above should be >= CMP, below should be <= CMP (warn but allow)
        if (aboveV && aboveV <= 0) aboveV = null;
        if (belowV && belowV <= 0) belowV = null;

        trWlSaveAlert(item, aboveV, belowV);
        trWlCloseAlertPopover();
    });

    // Clear buttons — clear individual direction
    popover.querySelectorAll('.btn-alert-clear').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var dir = btn.dataset.dir;
            if (dir === 'above') {
                inputAbove.value = '';
            } else {
                inputBelow.value = '';
            }
            // Also save immediately
            var aboveV = parseFloat(inputAbove.value) || null;
            var belowV = parseFloat(inputBelow.value) || null;
            trWlSaveAlert(item, aboveV, belowV);
            trWlCloseAlertPopover();
        });
    });

    // Keyboard: Enter to save, Escape to close
    [inputAbove, inputBelow].forEach(function(input) {
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                popover.querySelector('.btn-alert-save').click();
            }
            if (e.key === 'Escape') {
                trWlCloseAlertPopover();
            }
            e.stopPropagation();
        });
    });

    // Focus the relevant input
    var focusTarget = editDir === 'below' ? inputBelow : inputAbove;
    setTimeout(function() { focusTarget.focus(); focusTarget.select(); }, 50);
}

function trWlCloseAlertPopover() {
    if (trWlAlertPopoverRow) {
        var popover = trWlAlertPopoverRow.querySelector('.wl-alert-popover');
        if (popover) popover.remove();
        trWlAlertPopoverRow = null;
    }
}

// Save both alert fields to Supabase and update in-memory
async function trWlSaveAlert(item, alertAbove, alertBelow) {
    var resp = await fetch(SUPABASE_URL + '/rest/v1/watchlist_items?id=eq.' + item.id, {
        method: 'PATCH',
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ alert_above: alertAbove, alert_below: alertBelow })
    });

    if (resp.ok) {
        item.alert_above = alertAbove;
        item.alert_below = alertBelow;
        // Reset toast tracking (new values = new trigger cycle)
        delete trWlAlertToasted[item.id + ':above'];
        delete trWlAlertToasted[item.id + ':below'];
        trWlRender();
        var sym = item._displaySymbol || item.short_symbol;
        var parts = [];
        if (alertAbove) parts.push('▲ ₹' + Number(alertAbove).toLocaleString('en-IN'));
        if (alertBelow) parts.push('▼ ₹' + Number(alertBelow).toLocaleString('en-IN'));
        if (parts.length > 0) {
            showAlert('Alert set: ' + sym + ' ' + parts.join(', '), 'success', 2000);
        } else {
            showAlert('Alerts cleared for ' + sym, 'success', 1500);
        }
    } else {
        showAlert('Failed to save alert', 'error');
    }
}

// ============================================================================
// UTILITY
// ============================================================================

// wmsEsc is provided by wms-shared.js

// ============================================================================
// WINDOW EXPORTS
// ============================================================================

window.trWlInit = trWlInit;
window.trWlDestroy = trWlDestroy;
