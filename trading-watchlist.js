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

// ============================================================================
// INITIALIZATION
// ============================================================================

async function trWlInit() {
    if (trWlInitialized) {
        // Already initialized — just refresh prices and re-render
        await trWlFetchPrices();
        trWlRender();
        trWlStartAutoRefresh();
        return;
    }
    trWlInitialized = true;
    trWlSetupEventHandlers();
    await trWlLoad();
    await trWlFetchPrices();
    trWlRender();
    trWlStartAutoRefresh();
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

    // Refresh button
    document.getElementById('trWlRefreshBtn').addEventListener('click', async function() {
        trWlUpdatePriceStatus('loading');
        await trWlFetchPrices();
        trWlRender();
        showAlert('Prices refreshed', 'success', 1500);
    });

    // Add dialog — close
    document.getElementById('trWlAddClose').addEventListener('click', trWlCloseAddDialog);
    document.getElementById('trWlAddCancelBtn').addEventListener('click', trWlCloseAddDialog);
    document.getElementById('trWlAddOverlay').addEventListener('click', function(e) {
        if (e.target === this) trWlCloseAddDialog();
    });

    // Add dialog — search input
    var searchInput = document.getElementById('trWlAddSearch');
    var searchTimer = null;
    searchInput.addEventListener('input', function() {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function() {
            trWlSearchSecurities(searchInput.value.trim());
        }, 300);
    });

    // Close card menus on outside click
    document.addEventListener('click', function(e) {
        if (trWlOpenMenuId && !e.target.closest('.wl-card-actions')) {
            trWlCloseAllMenus();
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
                trWlFetchPrices().then(function() { trWlRender(); });
                trWlStartAutoRefresh();
            }
        }
    });

    // ESC closes add dialog
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            var overlay = document.getElementById('trWlAddOverlay');
            if (overlay && overlay.classList.contains('show')) {
                trWlCloseAddDialog();
            }
        }
    });
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
    // Collect all security IDs by source
    var dbIds = [];
    var nfoIds = [];
    trWlWatchlists.forEach(function(wl) {
        wl.items.forEach(function(item) {
            if (item.security_source === 'securities_nfo') {
                nfoIds.push(item.security_id);
            } else {
                dbIds.push(item.security_id);
            }
        });
    });

    // Deduplicate
    dbIds = dbIds.filter(function(v, i, a) { return a.indexOf(v) === i; });
    nfoIds = nfoIds.filter(function(v, i, a) { return a.indexOf(v) === i; });

    // Fetch broker_tokens from securities_db
    var dbTokenMap = {};
    if (dbIds.length > 0) {
        var dbResp = await fetch(SUPABASE_URL + '/rest/v1/securities_db?id=in.(' + dbIds.join(',') + ')&select=id,broker_tokens,nse_symbol,bse_symbol', {
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
        });
        var dbRows = dbResp.ok ? await dbResp.json() : [];
        dbRows.forEach(function(r) { dbTokenMap[r.id] = r; });
    }

    // Fetch broker_tokens from securities_nfo
    var nfoTokenMap = {};
    if (nfoIds.length > 0) {
        var nfoResp = await fetch(SUPABASE_URL + '/rest/v1/securities_nfo?id=in.(' + nfoIds.join(',') + ')&select=id,broker_tokens,symbol', {
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
        });
        var nfoRows = nfoResp.ok ? await nfoResp.json() : [];
        nfoRows.forEach(function(r) { nfoTokenMap[r.id] = r; });
    }

    // Attach Fyers symbol to each item
    trWlWatchlists.forEach(function(wl) {
        wl.items.forEach(function(item) {
            if (item.security_source === 'securities_nfo') {
                var nfoRec = nfoTokenMap[item.security_id];
                if (nfoRec && nfoRec.broker_tokens && nfoRec.broker_tokens.fyers) {
                    item._fyersSymbol = nfoRec.broker_tokens.fyers.symbol;
                } else if (nfoRec) {
                    item._fyersSymbol = nfoRec.symbol;
                }
            } else {
                var dbRec = dbTokenMap[item.security_id];
                if (dbRec && dbRec.broker_tokens && dbRec.broker_tokens.fyers) {
                    // Prefer NSE symbol
                    item._fyersSymbol = dbRec.broker_tokens.fyers.nse_symbol || dbRec.broker_tokens.fyers.bse_symbol;
                } else if (dbRec) {
                    // Fallback: derive from nse_symbol/bse_symbol columns
                    if (dbRec.nse_symbol) {
                        item._fyersSymbol = 'NSE:' + dbRec.nse_symbol + '-EQ';
                    } else if (dbRec.bse_symbol) {
                        item._fyersSymbol = 'BSE:' + dbRec.bse_symbol + '-A';
                    }
                }
            }
            if (!item._fyersSymbol) {
                item._fyersSymbol = null;
            }
        });
    });
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

        // Batch into chunks of 50
        var batchSize = 50;
        for (var i = 0; i < allSymbols.length; i += batchSize) {
            var chunk = allSymbols.slice(i, i + batchSize);
            try {
                var data = await window.fyersCall({ action: 'quotes', symbols: chunk });
                if (data && data.d && data.d.length > 0) {
                    data.d.forEach(function(item) {
                        if (item.v && item.v.symbol) {
                            trWlPrices[item.v.symbol] = {
                                lp: item.v.lp || 0,
                                ch: item.v.ch || 0,
                                chp: item.v.chp || 0,
                                high: item.v.high_price || null,
                                low: item.v.low_price || null
                            };
                        }
                    });
                }
            } catch (err) {
                console.warn('Watchlist: Fyers batch error:', err.message);
            }
            // Small delay between batches
            if (i + batchSize < allSymbols.length) {
                await new Promise(function(resolve) { setTimeout(resolve, 200); });
            }
        }

        trWlUpdatePriceStatus('live');
    } catch (err) {
        console.warn('Watchlist: Price fetch failed:', err.message || err);
        trWlUpdatePriceStatus('error');
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
        await trWlFetchPrices();
        trWlRender();
    }, trWlRefreshInterval);
}

function trWlStopAutoRefresh() {
    if (trWlRefreshTimer) {
        clearInterval(trWlRefreshTimer);
        trWlRefreshTimer = null;
    }
}

// ============================================================================
// RENDERING
// ============================================================================

function trWlRender() {
    var grid = document.getElementById('trWlGrid');
    if (!grid) return;

    // Update count
    var countEl = document.getElementById('trWlCount');
    var totalItems = trWlWatchlists.reduce(function(sum, wl) { return sum + wl.items.length; }, 0);
    if (countEl) {
        countEl.textContent = trWlWatchlists.length + ' watchlist' + (trWlWatchlists.length !== 1 ? 's' : '') +
            ' · ' + totalItems + ' securit' + (totalItems !== 1 ? 'ies' : 'y');
    }

    if (trWlWatchlists.length === 0) {
        grid.innerHTML = '<div class="wl-page-empty">' +
            '<div class="wl-empty-icon">📋</div>' +
            '<div class="wl-empty-text">No watchlists yet</div>' +
            '<button class="btn-new-watchlist" onclick="document.getElementById(\'trWlNewBtn\').click()">+ Create Your First Watchlist</button>' +
            '</div>';
        return;
    }

    grid.innerHTML = trWlWatchlists.map(function(wl) {
        var isCollapsed = wl.is_collapsed;
        var cardClass = 'wl-card' + (isCollapsed ? ' collapsed' : '');
        var menuId = 'wlm-' + wl.id.substring(0, 8);

        var itemsHtml = '';
        if (!isCollapsed) {
            if (wl.items.length === 0) {
                itemsHtml = '<div class="wl-empty-card">No securities added yet. Click + to add.</div>';
            } else {
                itemsHtml = wl.items.map(function(item) {
                    return trWlRenderSecurityRow(item);
                }).join('');
            }
        }

        return '<div class="' + cardClass + '" data-wl-id="' + wl.id + '">' +
            '<div class="wl-card-header" data-wl-id="' + wl.id + '">' +
                '<div class="wl-card-title">' +
                    '<span class="wl-arrow">▼</span>' +
                    '<span class="wl-name" data-wl-id="' + wl.id + '">' + trWlEsc(wl.name) + '</span>' +
                    '<span class="wl-item-count">(' + wl.items.length + ')</span>' +
                '</div>' +
                '<div class="wl-card-actions" style="position:relative;">' +
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

    trWlAttachCardListeners();
}

function trWlRenderSecurityRow(item) {
    var price = trWlPrices[item._fyersSymbol];
    var cmp = price ? price.lp : null;
    var ch = price ? price.ch : null;
    var chp = price ? price.chp : null;
    var high = price ? price.high : null;
    var low = price ? price.low : null;

    // Price display
    var priceHtml = cmp !== null
        ? formatPrice(cmp, false)
        : '<span style="color:#a0aec0;">—</span>';

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

    // Slider
    var sliderHtml = '';
    if (cmp !== null && high && low && high > low) {
        var pct = Math.min(100, Math.max(0, ((cmp - low) / (high - low)) * 100));
        var dotColor = pct >= 50 ? '#059669' : '#dc2626';
        sliderHtml = '<div class="wl-slider-track">' +
            '<div class="wl-slider-dot" style="left:' + pct.toFixed(1) + '%;background:' + dotColor + ';"></div>' +
            '</div>' +
            '<div class="wl-slider-labels"><span>' + formatPrice(low, false) + '</span><span>' + formatPrice(high, false) + '</span></div>';
    }

    return '<div class="wl-security-row" data-item-id="' + item.id + '">' +
        '<div class="wl-sec-symbol">' +
            '<div class="wl-sym-main">' + trWlEsc(item.short_symbol) + '</div>' +
            '<div class="wl-sym-sub">' + trWlEsc(item.company_name || '') + '</div>' +
        '</div>' +
        '<div class="wl-sec-price"><div class="wl-price-main">' + priceHtml + '</div></div>' +
        '<div class="wl-sec-change">' + changeHtml + '</div>' +
        '<div class="wl-sec-slider">' + sliderHtml + '</div>' +
        '<div class="wl-sec-delete">' +
            '<button class="btn-wl-delete" data-item-id="' + item.id + '" data-wl-id="' + item.watchlist_id + '" title="Remove">✕</button>' +
        '</div>' +
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
    document.getElementById('trWlAddOverlay').classList.add('show');
    setTimeout(function() { document.getElementById('trWlAddSearch').focus(); }, 100);
}

function trWlCloseAddDialog() {
    document.getElementById('trWlAddOverlay').classList.remove('show');
    trWlAddTargetId = null;
}

async function trWlSearchSecurities(query) {
    var resultsEl = document.getElementById('trWlAddResults');
    if (!query || query.length < 2) {
        resultsEl.innerHTML = '<div class="wl-add-no-results">Type at least 2 characters to search...</div>';
        return;
    }

    // Search securities_db (symbol, nse_symbol, company_name) — use ilike
    var searchQ = encodeURIComponent('%' + query + '%');
    var dbUrl = SUPABASE_URL + '/rest/v1/securities_db?or=(symbol.ilike.' + searchQ +
        ',nse_symbol.ilike.' + searchQ +
        ',bse_symbol.ilike.' + searchQ +
        ',company_name.ilike.' + searchQ +
        ')&is_active=eq.true&limit=30&select=id,symbol,nse_symbol,bse_symbol,company_name,security_type,asset_class,broker_tokens&order=symbol';

    // Search securities_nfo (symbol, underlying_symbol, instrument_name)
    var nfoUrl = SUPABASE_URL + '/rest/v1/securities_nfo?or=(symbol.ilike.' + searchQ +
        ',underlying_symbol.ilike.' + searchQ +
        ',instrument_name.ilike.' + searchQ +
        ')&is_active=eq.true&limit=15&select=id,symbol,underlying_symbol,instrument_name,exchange,instrument_type,broker_tokens&order=symbol';

    resultsEl.innerHTML = '<div class="wl-add-no-results">Searching...</div>';

    try {
        var headers = { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY };
        var responses = await Promise.all([
            fetch(dbUrl, { headers: headers }),
            fetch(nfoUrl, { headers: headers })
        ]);

        var dbResults = responses[0].ok ? await responses[0].json() : [];
        var nfoResults = responses[1].ok ? await responses[1].json() : [];

        // Check which securities are already in the target watchlist
        var wl = trWlWatchlists.find(function(w) { return w.id === trWlAddTargetId; });
        var existingKeys = {};
        if (wl) {
            wl.items.forEach(function(item) {
                existingKeys[item.security_source + ':' + item.security_id] = true;
            });
        }

        var html = '';

        // CM results
        dbResults.forEach(function(r) {
            var isAdded = existingKeys['securities_db:' + r.id];
            var displaySymbol = r.nse_symbol || r.bse_symbol || r.symbol;
            var exchange = r.nse_symbol ? 'NSE' : (r.bse_symbol ? 'BSE' : '');
            html += '<div class="wl-add-result-item' + (isAdded ? ' added' : '') + '" ' +
                'data-source="securities_db" data-id="' + r.id + '" ' +
                'data-symbol="' + trWlEsc(displaySymbol) + '" ' +
                'data-company="' + trWlEsc(r.company_name || '') + '" ' +
                'data-broker-tokens=\'' + JSON.stringify(r.broker_tokens || {}) + '\' ' +
                'data-nse="' + trWlEsc(r.nse_symbol || '') + '" ' +
                'data-bse="' + trWlEsc(r.bse_symbol || '') + '">' +
                '<span class="wl-res-symbol">' + trWlEsc(displaySymbol) + '</span>' +
                '<span class="wl-res-name">' + trWlEsc(r.company_name || '') + '</span>' +
                '<span class="wl-res-type">' + trWlEsc(r.security_type || 'EQ') + '</span>' +
                (exchange ? '<span class="wl-res-exchange">' + exchange + '</span>' : '') +
                (isAdded ? '<span style="margin-left:8px;font-size:10px;color:#059669;">✓ Added</span>' : '') +
                '</div>';
        });

        // NFO results
        nfoResults.forEach(function(r) {
            var isAdded = existingKeys['securities_nfo:' + r.id];
            html += '<div class="wl-add-result-item' + (isAdded ? ' added' : '') + '" ' +
                'data-source="securities_nfo" data-id="' + r.id + '" ' +
                'data-symbol="' + trWlEsc(r.underlying_symbol || r.symbol) + '" ' +
                'data-company="' + trWlEsc(r.instrument_name || r.symbol) + '" ' +
                'data-broker-tokens=\'' + JSON.stringify(r.broker_tokens || {}) + '\' ' +
                'data-nse="" data-bse="">' +
                '<span class="wl-res-symbol">' + trWlEsc(r.underlying_symbol || r.symbol) + '</span>' +
                '<span class="wl-res-name">' + trWlEsc(r.instrument_name || '') + '</span>' +
                '<span class="wl-res-type">' + trWlEsc(r.instrument_type || 'F&O') + '</span>' +
                '<span class="wl-res-exchange">' + trWlEsc(r.exchange || '') + '</span>' +
                (isAdded ? '<span style="margin-left:8px;font-size:10px;color:#059669;">✓ Added</span>' : '') +
                '</div>';
        });

        if (!html) {
            html = '<div class="wl-add-no-results">' +
                'No results found for "' + trWlEsc(query) + '"<br>' +
                '<span style="font-size:11px;color:#718096;margin-top:6px;display:inline-block;">' +
                'Either update the Master Database to add this security,<br>or enter the full security symbol to search on the broker website.' +
                '</span></div>';
        }

        resultsEl.innerHTML = html;

        // Attach click handlers to results
        resultsEl.querySelectorAll('.wl-add-result-item:not(.added)').forEach(function(el) {
            el.addEventListener('click', function() {
                trWlAddItem({
                    security_id: parseInt(el.dataset.id),
                    security_source: el.dataset.source,
                    short_symbol: el.dataset.symbol,
                    company_name: el.dataset.company,
                    broker_tokens: JSON.parse(el.dataset.brokerTokens || '{}'),
                    nse_symbol: el.dataset.nse,
                    bse_symbol: el.dataset.bse
                });
            });
        });

    } catch (err) {
        resultsEl.innerHTML = '<div class="wl-add-no-results">Search failed: ' + err.message + '</div>';
    }
}

async function trWlAddItem(security) {
    if (!trWlAddTargetId) return;

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

        // Derive Fyers symbol
        if (security.security_source === 'securities_nfo') {
            if (security.broker_tokens && security.broker_tokens.fyers) {
                newItem._fyersSymbol = security.broker_tokens.fyers.symbol;
            }
        } else {
            if (security.broker_tokens && security.broker_tokens.fyers) {
                newItem._fyersSymbol = security.broker_tokens.fyers.nse_symbol || security.broker_tokens.fyers.bse_symbol;
            } else if (security.nse_symbol) {
                newItem._fyersSymbol = 'NSE:' + security.nse_symbol + '-EQ';
            } else if (security.bse_symbol) {
                newItem._fyersSymbol = 'BSE:' + security.bse_symbol + '-A';
            }
        }

        wl.items.push(newItem);

        // Fetch price for new item if we have Fyers symbol
        if (newItem._fyersSymbol && window.fyersToken) {
            try {
                var data = await window.fyersCall({ action: 'quotes', symbols: [newItem._fyersSymbol] });
                if (data && data.d && data.d.length > 0 && data.d[0].v) {
                    var v = data.d[0].v;
                    trWlPrices[v.symbol] = {
                        lp: v.lp || 0,
                        ch: v.ch || 0,
                        chp: v.chp || 0,
                        high: v.high_price || null,
                        low: v.low_price || null
                    };
                }
            } catch (err) {
                console.warn('Watchlist: Price fetch for new item failed:', err.message);
            }
        }

        showAlert(security.short_symbol + ' added to watchlist', 'success', 1500);
        trWlCloseAddDialog();
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
// UTILITY
// ============================================================================

function trWlEsc(text) {
    if (!text) return '';
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================================================
// WINDOW EXPORTS
// ============================================================================

window.trWlInit = trWlInit;
window.trWlDestroy = trWlDestroy;
