// ============================================================================
// TRADING › INTERNATIONAL (sixth Trading tab) — International Watchlist plan v3, 16-Nov-2026
// A copy of the Watchlist tab (trading-watchlist.js) for international items priced by Yahoo:
//   • lists = watchlists.market = 'international' (mig 169); items = security_source 'yahoo',
//     security_id = the Yahoo symbol (e.g. GC=F, ^FTSE, AAPL)
//   • prices: yahoo-finance mode "quotes", MANUAL refresh only (on opening the tab + ↻ Refresh)
//   • price shown with its own currency symbol (US$, £, ¥ …); alerts in that currency, checked on each load
//   • Add box: yahoo-finance mode "search" only; no Buy / Sell / Rollover; no Debug
// All globals use the trIw prefix so the shared refresh (wmsRefreshRender / trWl*) never touches it.
// ============================================================================
// ============================================================================
// WMS TRADING MODULE — WATCHLIST SUB-MODULE
// ============================================================================
// Loaded on-demand when user switches to the Watchlist tab.
// All functions/state use 'trIw' prefix to avoid conflicts.
// All module-level state uses var (project convention — avoids TDZ on reload).

var trIwWatchlists = [];       // Array of { id, name, sort_order, is_collapsed, items: [] }
var trIwPrices = {};           // Yahoo symbol → { lp, ch, chp, high, low, w52h, w52l, currency }
var trIwInitialized = false;   // Prevent double-init
var trIwAddTargetId = null;    // Which watchlist we're adding to
var trIwSearchCache = [];      // Cached search results from DB
var trIwOpenMenuId = null;     // Currently open card menu
var trIwRenamingId = null;     // Currently renaming watchlist
var trIwSortState = {};        // watchlist_id → { field: 'name'|'chp', dir: 'asc'|'desc' }
var trIwDragItemState = null;  // { wlId, itemId, fromIdx } for drag-reorder within card
var trIwSearchDdCtrl = null;   // wmsDropdown controller for search autocomplete
var trIwAddModal = null;       // wmsModal controller for add-security dialog
var trIwReorderModal = null;   // wmsModal controller for reorder dialog
var trIwSliderMode = 'day';    // 'day' (day H/L) or '52wk' (52-week H/L) — both from Yahoo

// ============================================================================
// INITIALIZATION
// ============================================================================

async function trIwInit() {
    if (trIwInitialized) {
        // Already initialized — re-render from the last prices (no auto-refresh: owner, 16-Nov)
        trIwRender();
        return;
    }
    trIwInitialized = true;
    trIwSetupEventHandlers();
    var refreshBtn = document.getElementById('trIwRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', function() { trIwRefresh(); });
    await trIwLoad();
    trIwRender();
    await trIwRefresh();   // prices load once when the tab first opens
}

// ---------------------------------------------------------------------------
// Helpers (International only)
// ---------------------------------------------------------------------------
var trIwLastFetch = null;   // Date of the last successful Yahoo fetch
var trIwFetching = false;

function trIwRoot() {
    return document.getElementById('tr-international') || document;
}

function trIwPriceOf(item) {
    return item ? (trIwPrices[item.security_id] || trIwPrices[item.short_symbol] || null) : null;
}

var TR_IW_CCY = { USD: 'US$', GBP: '£', EUR: '€', JPY: '¥', HKD: 'HK$', CNY: 'CN¥', INR: '₹', CAD: 'C$',
    AUD: 'A$', SGD: 'S$', CHF: 'CHF', KRW: '₩', TWD: 'NT$', BRL: 'R$', ZAR: 'R', ILS: '₪', SEK: 'kr', NOK: 'kr', DKK: 'kr' };

function trIwCcySymbol(code) {
    if (!code) return '';
    return TR_IW_CCY[code] || code;
}

// Amount with its currency symbol, e.g. "US$ 4,052.30" (number format = the app's formatPrice)
function trIwMoney(item, value) {
    var p = trIwPriceOf(item);
    var sym = trIwCcySymbol(p && p.currency);
    var n = Number(value);
    var txt = (value === null || value === undefined || isNaN(n)) ? '—' : formatPrice(n, false);
    return (sym ? sym + ' ' : '') + txt;
}

// Fetch quotes for every international item (one call). Manual only: tab open + ↻ Refresh.
async function trIwRefresh() {
    if (trIwFetching) return;
    var symbols = [];
    trIwWatchlists.forEach(function(wl) {
        wl.items.forEach(function(it) { if (symbols.indexOf(it.security_id) === -1) symbols.push(it.security_id); });
    });
    if (!symbols.length) { trIwUpdatePriceStatus('empty'); return; }
    trIwFetching = true;
    trIwUpdatePriceStatus('loading');
    try {
        var resp = await fetch(SUPABASE_URL + '/functions/v1/yahoo-finance', {
            method: 'POST',
            headers: wmsEdgeHeaders({'Content-Type': 'application/json'}),
            body: JSON.stringify({ mode: 'quotes', symbols: symbols })
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var data = await resp.json();
        var res = (data && data.results) || {};
        var got = 0;
        Object.keys(res).forEach(function(sym) {
            var q = res[sym];
            if (!q || q.price === null || q.price === undefined) return;
            trIwPrices[sym] = {
                lp: q.price, ch: q.change, chp: q.changePct,
                high: q.dayHigh, low: q.dayLow, w52h: q.week52High, w52l: q.week52Low,
                currency: q.currency, name: q.name, exchange: q.exchange
            };
            got++;
        });
        if (!got) throw new Error('no prices returned');
        trIwLastFetch = new Date();
        trIwUpdatePricesInPlace();
        trIwUpdatePriceStatus('live');
    } catch (err) {
        console.warn('International: Yahoo quotes failed:', err.message);
        trIwUpdatePriceStatus('error');
    } finally {
        trIwFetching = false;
    }
}

function trIwDestroy() {
    // Nothing to stop: the International tab has no timers (manual refresh only)
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

function trIwSetupEventHandlers() {
    // New watchlist button
    document.getElementById('trIwNewBtn').addEventListener('click', function() {
        document.getElementById('trIwNewWrap').classList.add('show');
        document.getElementById('trIwNewBtn').style.display = 'none';
        var input = document.getElementById('trIwNewName');
        input.value = '';
        input.focus();
    });

    document.getElementById('trIwNewSave').addEventListener('click', trIwCreateWatchlist);
    document.getElementById('trIwNewCancel').addEventListener('click', trIwCancelNewWatchlist);
    document.getElementById('trIwNewName').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') trIwCreateWatchlist();
        if (e.key === 'Escape') trIwCancelNewWatchlist();
    });

    // H/L slider toggle (Day vs 52wk)
    var hlToggle = document.getElementById('trIwHlToggle');
    if (hlToggle) {
        hlToggle.addEventListener('click', function(e) {
            var btn = e.target.closest('.wl-hl-btn');
            if (!btn || btn.classList.contains('active')) return;
            hlToggle.querySelectorAll('.wl-hl-btn').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            trIwSliderMode = btn.dataset.mode;
            trIwRender();
        });
    }

    // Add dialog — initialize modal and dropdown with wms-shared.js
    var searchInput = document.getElementById('trIwAddSearch');
    var addResultsEl = document.getElementById('trIwAddResults');
    var addOverlayEl = document.getElementById('trIwAddOverlay');
    var searchTimer = null;

    // Create wmsModal for add dialog (handles ESC and click-outside)
    trIwAddModal = wmsModal(addOverlayEl, {
        onClose: function() {
            trIwAddTargetId = null;
            trIwRender(); // Re-render to show any newly added items
            if (trIwSearchDdCtrl) trIwSearchDdCtrl.close();
        }
    });

    // Setup close buttons (buttons now call modal.close instead of classList manipulation)
    document.getElementById('trIwAddClose').addEventListener('click', function() {
        trIwAddModal.close();
    });
    document.getElementById('trIwAddCancelBtn').addEventListener('click', function() {
        trIwAddModal.close();
    });

    // Create wmsDropdown for search autocomplete
    trIwSearchDdCtrl = wmsDropdown(searchInput, addResultsEl, {
        itemSelector: '.wl-add-result-item:not(.added)',
        closeOnSelect: false,  // Dialog stays open for adding more items
        blurDelay: 0,           // Modal dialog, not standard input
        escClearsInput: false,  // ESC handled by wmsModal
        onSelect: function(itemEl) {
            var idx = parseInt(itemEl.dataset.idx);
            var cached = trIwSearchCache[idx];
            if (!cached) return;
            trIwAddItem(cached);
            // Reset dropdown highlight since items list changed
            if (trIwSearchDdCtrl) trIwSearchDdCtrl.resetIdx();
        }
    });

    // Mouse click support on search results
    addResultsEl.addEventListener('mousedown', function(e) {
        var item = e.target.closest('.wl-add-result-item:not(.added)');
        if (!item) return;
        e.preventDefault();
        var idx = parseInt(item.dataset.idx);
        var cached = trIwSearchCache[idx];
        if (!cached) return;
        trIwAddItem(cached);
        if (trIwSearchDdCtrl) trIwSearchDdCtrl.resetIdx();
    });

    // Add dialog — search input with debounced search
    searchInput.addEventListener('input', function() {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function() {
            trIwSearchSecurities(searchInput.value.trim());
        }, 300);
    });

    // Reorder button
    document.getElementById('trIwReorderBtn').addEventListener('click', trIwOpenReorderModal);

    // Reorder modal — initialize with wms-shared.js (handles ESC and click-outside)
    var reorderOverlayEl = document.getElementById('trIwReorderOverlay');
    trIwReorderModal = wmsModal(reorderOverlayEl, {
        onClose: function() {
            trIwReorderList = [];
        }
    });

    // Reorder modal — close/save buttons
    document.getElementById('trIwReorderClose').addEventListener('click', function() {
        trIwReorderModal.close();
    });
    document.getElementById('trIwReorderCancelBtn').addEventListener('click', function() {
        trIwReorderModal.close();
    });
    document.getElementById('trIwReorderSaveBtn').addEventListener('click', trIwSaveReorder);

    // Close card menus and alert popover on outside click
    document.addEventListener('click', function(e) {
        if (trIwOpenMenuId && !e.target.closest('.wl-card-actions')) {
            trIwCloseAllMenus();
        }
        // Close alert popover if click is outside it
        if (trIwAlertPopoverRow && !e.target.closest('.wl-alert-popover') && !e.target.closest('.wl-sec-price') && !e.target.closest('.wl-alert-dot')) {
            trIwCloseAlertPopover();
        }
    });

    // ESC handling is now provided by wmsModal (applied to both add and reorder dialogs)
}

// ============================================================================
// DATA LOADING
// ============================================================================

async function trIwLoad() {
    var userId = window.currentUser ? window.currentUser.id : null;
    if (!userId) return;

    // International lists only (watchlists.market, mig 169)
    var wlResp = await fetch(SUPABASE_URL + '/rest/v1/watchlists?user_id=eq.' + userId + '&market=eq.international&order=sort_order,created_at', {
        headers: wmsHeaders()
    });
    var watchlists = wlResp.ok ? await wlResp.json() : [];

    var wlIds = watchlists.map(function(w) { return w.id; });
    var items = [];
    if (wlIds.length > 0) {
        var itemResp = await fetch(SUPABASE_URL + '/rest/v1/watchlist_items?watchlist_id=in.(' + wlIds.join(',') + ')&order=sort_order,created_at', {
            headers: wmsHeaders()
        });
        items = itemResp.ok ? await itemResp.json() : [];
    }

    var itemMap = {};
    items.forEach(function(item) {
        if (!itemMap[item.watchlist_id]) itemMap[item.watchlist_id] = [];
        itemMap[item.watchlist_id].push(item);
    });

    trIwWatchlists = watchlists.map(function(w) {
        w.items = itemMap[w.id] || [];
        return w;
    });
}


// ============================================================================
// PRICE STATUS (header, left)
// ============================================================================

function trIwUpdatePriceStatus(status) {
    var el = document.getElementById('trIwPriceStatus');
    if (!el) return;
    var fmt = function(d) { return d ? d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : ''; };
    if (status === 'live') {
        el.innerHTML = '🟢 Yahoo · as of ' + fmt(trIwLastFetch);
        el.style.color = '#059669';
    } else if (status === 'loading') {
        el.innerHTML = '⏳ Fetching prices...';
        el.style.color = '#667eea';
    } else if (status === 'empty') {
        el.innerHTML = '';
    } else {
        el.innerHTML = '🟡 Yahoo not reachable' + (trIwLastFetch ? ' · showing ' + fmt(trIwLastFetch) + ' prices' : '');
        el.style.color = '#b45309';
    }
}

// ============================================================================
// IN-PLACE PRICE UPDATE (no DOM rebuild — preserves scroll position)
// ============================================================================

function trIwUpdatePricesInPlace() {
    // Rows are cheap to rebuild here (no live ticks): re-render keeps every column consistent
    trIwRender();
    trIwUpdateAlertsInPlace();
}

// ============================================================================
// RENDERING
// ============================================================================

function trIwRender() {
    var grid = document.getElementById('trIwGrid');
    var collapsedBar = document.getElementById('trIwCollapsedBar');
    if (!grid) return;

    // Update count
    var countEl = document.getElementById('trIwCount');
    var totalItems = trIwWatchlists.reduce(function(sum, wl) { return sum + wl.items.length; }, 0);
    if (countEl) {
        countEl.textContent = trIwWatchlists.length + ' watchlist' + (trIwWatchlists.length !== 1 ? 's' : '') +
            ' · ' + totalItems + ' securit' + (totalItems !== 1 ? 'ies' : 'y');
    }

    if (trIwWatchlists.length === 0) {
        if (collapsedBar) { collapsedBar.style.display = 'none'; collapsedBar.innerHTML = ''; }
        grid.innerHTML = '<div class="wl-page-empty">' +
            '<div class="wl-empty-icon">📋</div>' +
            '<div class="wl-empty-text">No watchlists yet</div>' +
            '<button class="btn-new-watchlist" onclick="document.getElementById(\'trIwNewBtn\').click()">+ Create Your First Watchlist</button>' +
            '</div>';
        return;
    }

    // Separate collapsed and expanded watchlists
    var collapsed = [];
    var expanded = [];
    trIwWatchlists.forEach(function(wl) {
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
                    trIwToggleCollapse(chip.dataset.wlId);
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
                var sortedItems = trIwGetSortedItems(wl);
                itemsHtml = sortedItems.map(function(item) {
                    return trIwRenderSecurityRow(item);
                }).join('');
            }

            // Sort indicator
            var ss = trIwSortState[wl.id];
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

    trIwAttachCardListeners();
}

// Resolve H/L range for slider based on current mode (day vs 52wk)
// NFO/options items always use day H/L (no 52wk data exists for derivatives)
function trIwGetSliderRange(item, price) {
    if (!price) return { high: null, low: null };
    if (trIwSliderMode === '52wk') return { high: price.w52h, low: price.w52l };
    return { high: price.high, low: price.low };
}

function trIwRenderSecurityRow(item) {
    var price = trIwPriceOf(item);
    var cmp = price ? price.lp : null;
    var ch = price ? price.ch : null;
    var chp = price ? price.chp : null;
    var hlRange = trIwGetSliderRange(item, price);
    var high = hlRange.high;
    var low = hlRange.low;

    var displaySym = item.short_symbol || item.security_id;
    var subRowText = item.company_name || '';

    var priceHtml = cmp !== null ? wmsEsc(trIwMoney(item, cmp)) : '<span style="color:#a0aec0;">—</span>';

    var changeHtml = '';
    if (ch !== null && ch !== undefined) {
        var changeClass = ch >= 0 ? 'positive' : 'negative';
        var sign = ch >= 0 ? '+' : '';
        changeHtml = '<div class="wl-change-main ' + changeClass + '">' + sign + formatPrice(ch, false) + '</div>' +
            '<div class="wl-change-sub ' + changeClass + '">(' + (chp >= 0 ? '+' : '') + (chp !== null && chp !== undefined ? chp.toFixed(2) : '0.00') + '%)</div>';
    } else {
        changeHtml = '<div class="wl-change-main" style="color:#a0aec0;">—</div>';
    }

    var sliderHtml = '';
    if (cmp !== null && high && low && high > low) {
        var pct = Math.min(100, Math.max(0, ((cmp - low) / (high - low)) * 100));
        var dotColor = pct >= 50 ? '#059669' : '#dc2626';
        sliderHtml = '<div class="price-slider">' +
            '<div class="price-slider-track">' +
                '<div class="price-slider-dot" style="left:' + pct.toFixed(1) + '%;background:' + dotColor + ';"></div>' +
            '</div>' +
            '<div class="slider-tooltip">' +
                '<span>' + wmsEsc(trIwMoney(item, low)) + '</span>' +
                '<span>' + wmsEsc(trIwMoney(item, high)) + '</span>' +
            '</div>' +
        '</div>';
    }

    var alertDotHtml = '';
    var hasAbove = item.alert_above != null;
    var hasBelow = item.alert_below != null;
    if (hasAbove || hasBelow) {
        var alertState = trIwGetAlertState(item, cmp);
        var dotTitle = '';
        if (hasBelow) dotTitle += '▼ ' + trIwMoney(item, item.alert_below);
        if (hasAbove && hasBelow) dotTitle += '  ';
        if (hasAbove) dotTitle += '▲ ' + trIwMoney(item, item.alert_above);
        alertDotHtml = '<span class="wl-alert-dot ' + alertState.dotClass + '" title="' + wmsEsc(dotTitle) + '"></span>';
    }

    var tooltipText = displaySym + (subRowText ? ' — ' + subRowText : '');

    return '<div class="wl-security-row" data-item-id="' + item.id + '" data-wl-id="' + item.watchlist_id + '" draggable="true" title="' + wmsEsc(tooltipText) + '" style="position:relative;">' +
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

function trIwAttachCardListeners() {
    // Card header click → toggle collapse
    document.querySelectorAll('.wl-card-header').forEach(function(header) {
        header.addEventListener('click', function(e) {
            // Don't collapse if clicking buttons inside actions
            if (e.target.closest('.wl-card-actions')) return;
            trIwToggleCollapse(header.dataset.wlId);
        });
    });

    // Add button
    document.querySelectorAll('.btn-wl-add').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            trIwOpenAddDialog(btn.dataset.wlId);
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
            trIwCloseAllMenus();
            if (!wasOpen) {
                menu.classList.add('show');
                trIwOpenMenuId = menuId;
            }
        });
    });

    // Menu items (rename, delete)
    document.querySelectorAll('.wl-card-menu-item').forEach(function(item) {
        item.addEventListener('click', function(e) {
            e.stopPropagation();
            trIwCloseAllMenus();
            var action = item.dataset.action;
            var wlId = item.dataset.wlId;
            if (action === 'rename') trIwStartRename(wlId);
            else if (action === 'delete') trIwDeleteWatchlist(wlId);
        });
    });

    // Delete security buttons
    document.querySelectorAll('.btn-wl-delete').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            trIwDeleteItem(btn.dataset.itemId, btn.dataset.wlId);
        });
    });

    // Sort buttons
    trIwRoot().querySelectorAll('.btn-wl-sort').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            trIwToggleSort(btn.dataset.wlId, btn.dataset.sort);
        });
    });

    // Double-click on price → open alert popover
    document.querySelectorAll('.wl-sec-price').forEach(function(priceEl) {
        priceEl.addEventListener('dblclick', function(e) {
            e.stopPropagation();
            var row = priceEl.closest('.wl-security-row');
            if (row) trIwOpenAlertPopover(row);
        });
    });

    // Click on alert dot → open alert popover
    document.querySelectorAll('.wl-alert-dot').forEach(function(dot) {
        dot.addEventListener('click', function(e) {
            e.stopPropagation();
            var row = dot.closest('.wl-security-row');
            if (row) trIwOpenAlertPopover(row);
        });
    });

    // Item drag-reorder within cards
    trIwSetupItemDrag();
}

function trIwCloseAllMenus() {
    document.querySelectorAll('.wl-card-menu.show').forEach(function(m) { m.classList.remove('show'); });
    trIwOpenMenuId = null;
}

// ============================================================================
// WATCHLIST CRUD
// ============================================================================

async function trIwCreateWatchlist() {
    var input = document.getElementById('trIwNewName');
    var name = input.value.trim();
    if (!name) {
        showAlert('Please enter a watchlist name', 'error', 2000);
        return;
    }

    var userId = window.currentUser ? window.currentUser.id : null;
    if (!userId) return;

    var sortOrder = trIwWatchlists.length;

    var resp = await fetch(SUPABASE_URL + '/rest/v1/watchlists', {
        method: 'POST',
        headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
        body: JSON.stringify({ user_id: userId, name: name, sort_order: sortOrder, market: 'international' })
    });

    if (resp.ok) {
        var newWl = (await resp.json())[0];
        newWl.items = [];
        trIwWatchlists.push(newWl);
        trIwCancelNewWatchlist();
        trIwRender();
        showAlert('Watchlist "' + name + '" created', 'success', 2000);
    } else {
        showAlert('Failed to create watchlist', 'error');
    }
}

function trIwCancelNewWatchlist() {
    document.getElementById('trIwNewWrap').classList.remove('show');
    document.getElementById('trIwNewBtn').style.display = '';
    document.getElementById('trIwNewName').value = '';
}

async function trIwDeleteWatchlist(wlId) {
    var wl = trIwWatchlists.find(function(w) { return w.id === wlId; });
    if (!wl) return;
    if (!confirm('Delete watchlist "' + wl.name + '" and all its items?\n\nThis cannot be undone.')) return;

    var resp = await fetch(SUPABASE_URL + '/rest/v1/watchlists?id=eq.' + wlId, {
        method: 'DELETE',
        headers: wmsHeaders({'Prefer': 'return=minimal'})
    });

    if (resp.ok) {
        trIwWatchlists = trIwWatchlists.filter(function(w) { return w.id !== wlId; });
        trIwRender();
        showAlert('Watchlist deleted', 'success', 2000);
    } else {
        showAlert('Failed to delete watchlist', 'error');
    }
}

function trIwStartRename(wlId) {
    var nameEl = document.querySelector('.wl-name[data-wl-id="' + wlId + '"]');
    if (!nameEl) return;
    var wl = trIwWatchlists.find(function(w) { return w.id === wlId; });
    if (!wl) return;

    trIwRenamingId = wlId;
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
            trIwRenameWatchlist(wlId, newName);
        } else {
            trIwRender(); // revert
        }
        trIwRenamingId = null;
    }

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { input.blur(); }
        if (e.key === 'Escape') { trIwRenamingId = null; trIwRender(); }
    });
}

async function trIwRenameWatchlist(wlId, newName) {
    var resp = await fetch(SUPABASE_URL + '/rest/v1/watchlists?id=eq.' + wlId, {
        method: 'PATCH',
        headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'}),
        body: JSON.stringify({ name: newName })
    });

    if (resp.ok) {
        var wl = trIwWatchlists.find(function(w) { return w.id === wlId; });
        if (wl) wl.name = newName;
        trIwRender();
    } else {
        showAlert('Failed to rename', 'error');
        trIwRender();
    }
}

async function trIwToggleCollapse(wlId) {
    var wl = trIwWatchlists.find(function(w) { return w.id === wlId; });
    if (!wl) return;
    wl.is_collapsed = !wl.is_collapsed;
    trIwRender();

    // Persist collapse state
    fetch(SUPABASE_URL + '/rest/v1/watchlists?id=eq.' + wlId, {
        method: 'PATCH',
        headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'}),
        body: JSON.stringify({ is_collapsed: wl.is_collapsed })
    });
}

// ============================================================================
// ADD SECURITY DIALOG
// ============================================================================

function trIwOpenAddDialog(wlId) {
    trIwAddTargetId = wlId;
    var wl = trIwWatchlists.find(function(w) { return w.id === wlId; });
    document.getElementById('trIwAddTitle').textContent = 'Add to ' + (wl ? wl.name : 'Watchlist');
    document.getElementById('trIwAddSearch').value = '';
    document.getElementById('trIwAddResults').innerHTML = '<div class="wl-add-no-results">Type a name or Yahoo symbol (e.g. Gold, S&amp;P 500, AAPL)...</div>';
    if (trIwAddModal) trIwAddModal.open();
    if (trIwSearchDdCtrl) trIwSearchDdCtrl.close(); // Close dropdown on open
    setTimeout(function() { document.getElementById('trIwAddSearch').focus(); }, 100);
}

function trIwHighlightSearchResult(items, idx) {
    // Stub: highlighting now handled by wmsDropdown using '.wms-dd-highlight' class
    // Kept for backward compatibility if referenced elsewhere
}

function trIwCloseAddDialog() {
    // Use modal controller to close (handles cleanup via onClose callback)
    if (trIwAddModal) trIwAddModal.close();
}

// ============================================================================
// OPTIONS ON-DEMAND SEARCH
// ============================================================================

// Options constants — aliases for wms-shared.js (used by other functions in this file)

/**
 * Delegated to wms-shared.js (wmsParseOptionsQuery)
 */

async function trIwSearchSecurities(query) {
    var resultsEl = document.getElementById('trIwAddResults');
    if (!query || query.length < 1) {
        trIwSearchCache = [];
        resultsEl.innerHTML = '<div class="wl-add-no-results">Type a name or Yahoo symbol (e.g. Gold, S&amp;P 500, AAPL)...</div>';
        return;
    }
    resultsEl.innerHTML = '<div class="wl-add-no-results">Searching Yahoo...</div>';
    try {
        var resp = await fetch(SUPABASE_URL + '/functions/v1/yahoo-finance', {
            method: 'POST',
            headers: wmsEdgeHeaders({'Content-Type': 'application/json'}),
            body: JSON.stringify({ mode: 'search', query: query })
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var data = await resp.json();
        var wl = trIwWatchlists.find(function(w) { return w.id === trIwAddTargetId; });
        var existing = {};
        if (wl) wl.items.forEach(function(i) { existing[i.security_id] = true; });

        trIwSearchCache = ((data && data.results) || []).map(function(r) {
            return {
                security_id: r.symbol,
                security_source: 'yahoo',
                short_symbol: r.symbol,
                company_name: [r.name, r.exchange].filter(Boolean).join(' · '),
                display_name: r.name || r.symbol,
                security_type: r.type || '',
                exchange: r.exchange || '',
                isAdded: !!existing[r.symbol]
            };
        });

        var html = '';
        trIwSearchCache.forEach(function(item, idx) {
            var tagsHtml = '<span class="wl-res-tags">' +
                (item.security_type ? '<span class="wl-res-type">' + wmsEsc(item.security_type) + '</span>' : '') +
                (item.exchange ? '<span class="wl-res-exchange">' + wmsEsc(item.exchange) + '</span>' : '') +
                (item.isAdded ? '<span style="font-size:10px;color:#059669;">✓</span>' : '') +
                '</span>';
            html += '<div class="wl-add-result-item' + (item.isAdded ? ' added' : '') + '" data-idx="' + idx + '" title="' + wmsEsc(item.company_name) + '">' +
                '<span class="wl-res-symbol">' + wmsEsc(item.short_symbol) + '</span>' +
                '<span class="wl-res-name">' + wmsEsc(item.display_name) + '</span>' +
                tagsHtml +
                '</div>';
        });
        if (!html) {
            html = '<div class="wl-add-no-results">No Yahoo results for "' + wmsEsc(query) + '"</div>';
        }
        resultsEl.innerHTML = html;
        if (html.indexOf('wl-add-result-item') !== -1 && trIwSearchDdCtrl) trIwSearchDdCtrl.show();
    } catch (err) {
        resultsEl.innerHTML = '<div class="wl-add-no-results">Yahoo search failed: ' + wmsEsc(err.message) + '</div>';
    }
}

async function trIwAddItem(security) {
    if (!trIwAddTargetId || !security || !security.security_id) return;
    var wl = trIwWatchlists.find(function(w) { return w.id === trIwAddTargetId; });
    if (!wl) return;
    if (wl.items.some(function(i) { return i.security_id === security.security_id; })) {
        showAlert('Already in this watchlist', 'info', 2000);
        return;
    }
    var resp = await fetch(SUPABASE_URL + '/rest/v1/watchlist_items', {
        method: 'POST',
        headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
        body: JSON.stringify({
            watchlist_id: wl.id,
            security_id: security.security_id,
            security_source: 'yahoo',
            short_symbol: security.short_symbol,
            company_name: security.company_name || null,
            sort_order: wl.items.length
        })
    });
    if (resp.ok) {
        var newItem = (await resp.json())[0];
        wl.items.push(newItem);
        security.isAdded = true;
        showAlert(security.short_symbol + ' added', 'success', 1500);
        var idx = trIwSearchCache.indexOf(security);
        var addedRow = idx >= 0 ? trIwRoot().querySelector('.wl-add-result-item[data-idx="' + idx + '"]') : null;
        if (addedRow) {
            addedRow.classList.add('added');
            var tagsEl = addedRow.querySelector('.wl-res-tags');
            if (tagsEl && !tagsEl.querySelector('.wl-added-check')) {
                tagsEl.insertAdjacentHTML('beforeend', '<span class="wl-added-check" style="font-size:10px;color:#059669;">✓</span>');
            }
        }
        trIwRender();
        trIwRefresh();   // price the new item straight away
    } else {
        var errText = await resp.text();
        if (errText.indexOf('unique') >= 0 || errText.indexOf('duplicate') >= 0) {
            showAlert('Already in this watchlist', 'info', 2000);
        } else {
            showAlert('Failed to add: ' + errText, 'error');
        }
    }
}

async function trIwDeleteItem(itemId, wlId) {
    var resp = await fetch(SUPABASE_URL + '/rest/v1/watchlist_items?id=eq.' + itemId, {
        method: 'DELETE',
        headers: wmsHeaders({'Prefer': 'return=minimal'})
    });

    if (resp.ok) {
        var wl = trIwWatchlists.find(function(w) { return w.id === wlId; });
        if (wl) {
            wl.items = wl.items.filter(function(item) { return item.id !== itemId; });
        }
        trIwRender();
    } else {
        showAlert('Failed to remove security', 'error');
    }
}

// ============================================================================
// SORT ITEMS WITHIN WATCHLIST
// ============================================================================

function trIwGetSortedItems(wl) {
    var ss = trIwSortState[wl.id];
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
            var aPrice = trIwPriceOf(a);
            var bPrice = trIwPriceOf(b);
            var aChp = aPrice ? aPrice.chp : -9999;
            var bChp = bPrice ? bPrice.chp : -9999;
            return aChp - bChp;
        });
    }
    if (ss.dir === 'desc') sorted.reverse();
    return sorted;
}

function trIwToggleSort(wlId, field) {
    var ss = trIwSortState[wlId];
    if (ss && ss.field === field) {
        if (ss.dir === 'asc') {
            trIwSortState[wlId] = { field: field, dir: 'desc' };
        } else {
            // Third click: clear sort
            delete trIwSortState[wlId];
        }
    } else {
        trIwSortState[wlId] = { field: field, dir: 'asc' };
    }
    trIwRender();
}

// ============================================================================
// DRAG REORDER ITEMS WITHIN WATCHLIST CARD
// ============================================================================

function trIwSetupItemDrag() {
    trIwRoot().querySelectorAll('.wl-security-row').forEach(function(row) {
        row.addEventListener('dragstart', function(e) {
            // Only allow drag from the drag handle
            if (!e.target.closest('.wl-sec-drag') && e.target !== row) {
                e.preventDefault();
                return;
            }
            var wlId = row.dataset.wlId;
            var itemId = row.dataset.itemId;
            var wl = trIwWatchlists.find(function(w) { return w.id === wlId; });
            if (!wl) return;
            var fromIdx = wl.items.findIndex(function(it) { return it.id === itemId; });
            trIwDragItemState = { wlId: wlId, itemId: itemId, fromIdx: fromIdx };
            row.classList.add('wl-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', itemId);
        });

        row.addEventListener('dragend', function() {
            row.classList.remove('wl-dragging');
            trIwDragItemState = null;
            trIwRoot().querySelectorAll('.wl-security-row').forEach(function(r) {
                r.classList.remove('wl-drag-over-top', 'wl-drag-over-bottom');
            });
        });

        row.addEventListener('dragover', function(e) {
            if (!trIwDragItemState) return;
            if (row.dataset.wlId !== trIwDragItemState.wlId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            // Show drop indicator
            var rect = row.getBoundingClientRect();
            var midY = rect.top + rect.height / 2;
            trIwRoot().querySelectorAll('.wl-security-row').forEach(function(r) {
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
            if (!trIwDragItemState) return;
            var wlId = trIwDragItemState.wlId;
            if (row.dataset.wlId !== wlId) return;

            var wl = trIwWatchlists.find(function(w) { return w.id === wlId; });
            if (!wl) return;

            var fromIdx = trIwDragItemState.fromIdx;
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
            delete trIwSortState[wlId];

            // Update sort_order in DB
            trIwSaveItemOrder(wl);
            trIwRender();
        });
    });
}

async function trIwSaveItemOrder(wl) {
    // Batch update sort_order for all items in the watchlist
    var promises = wl.items.map(function(item, idx) {
        item.sort_order = idx;
        return fetch(SUPABASE_URL + '/rest/v1/watchlist_items?id=eq.' + item.id, {
            method: 'PATCH',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'}),
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

var trIwReorderList = [];  // Temp copy of watchlists for reordering

function trIwOpenReorderModal() {
    if (trIwWatchlists.length < 2) {
        showAlert('Need at least 2 watchlists to reorder', 'info', 2000);
        return;
    }
    // Copy current order
    trIwReorderList = trIwWatchlists.map(function(wl) {
        return { id: wl.id, name: wl.name, itemCount: wl.items.length };
    });
    trIwRenderReorderList();
    if (trIwReorderModal) trIwReorderModal.open();
}

function trIwCloseReorderModal() {
    // Use modal controller to close (handles cleanup via onClose callback)
    if (trIwReorderModal) trIwReorderModal.close();
}

function trIwRenderReorderList() {
    var body = document.getElementById('trIwReorderBody');
    if (!body) return;
    body.innerHTML = trIwReorderList.map(function(wl, idx) {
        return '<div class="wl-reorder-item" data-idx="' + idx + '">' +
            '<span class="wl-reorder-handle">☰</span>' +
            '<span class="wl-reorder-name" data-wl-id="' + wl.id + '" title="Click to rename">' + wmsEsc(wl.name) +
                '<span class="wl-reorder-count">(' + wl.itemCount + ')</span>' +
            '</span>' +
            '<div class="wl-reorder-arrows">' +
                '<button class="btn-reorder-arrow" data-dir="up" data-idx="' + idx + '"' +
                    (idx === 0 ? ' disabled' : '') + ' title="Move up">▲</button>' +
                '<button class="btn-reorder-arrow" data-dir="down" data-idx="' + idx + '"' +
                    (idx === trIwReorderList.length - 1 ? ' disabled' : '') + ' title="Move down">▼</button>' +
            '</div>' +
        '</div>';
    }).join('');

    // Attach arrow click handlers
    body.querySelectorAll('.btn-reorder-arrow').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var idx = parseInt(btn.dataset.idx);
            var dir = btn.dataset.dir;
            trIwReorderMove(idx, dir);
        });
    });

    // Attach name click handlers for inline rename
    body.querySelectorAll('.wl-reorder-name').forEach(function(nameEl) {
        nameEl.addEventListener('click', function(e) {
            e.stopPropagation();
            trIwStartReorderRename(nameEl);
        });
    });

    // Attach drag handlers for mouse-based reorder
    trIwSetupDragReorder(body);
}

function trIwStartReorderRename(nameEl) {
    var wlId = nameEl.dataset.wlId;
    var wlReorder = trIwReorderList.find(function(w) { return w.id === wlId; });
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
            var mainWl = trIwWatchlists.find(function(w) { return w.id === wlId; });
            if (mainWl) mainWl.name = newName;
            // Persist to DB
            trIwRenameWatchlist(wlId, newName);
        }
        trIwRenderReorderList();
    }

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { input.blur(); }
        if (e.key === 'Escape') { trIwRenderReorderList(); }
    });
}

function trIwReorderMove(idx, direction) {
    var targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= trIwReorderList.length) return;

    // Swap
    var temp = trIwReorderList[idx];
    trIwReorderList[idx] = trIwReorderList[targetIdx];
    trIwReorderList[targetIdx] = temp;

    trIwRenderReorderList();

    // Briefly highlight the moved item
    var items = document.querySelectorAll('.wl-reorder-item');
    if (items[targetIdx]) {
        items[targetIdx].style.background = '#ebf4ff';
        setTimeout(function() { items[targetIdx].style.background = ''; }, 300);
    }
}

async function trIwSaveReorder() {
    // Update sort_order for each watchlist
    var promises = trIwReorderList.map(function(wl, idx) {
        return fetch(SUPABASE_URL + '/rest/v1/watchlists?id=eq.' + wl.id, {
            method: 'PATCH',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'}),
            body: JSON.stringify({ sort_order: idx })
        });
    });

    try {
        await Promise.all(promises);

        // Reorder the in-memory array to match
        var idOrder = trIwReorderList.map(function(wl) { return wl.id; });
        trIwWatchlists.sort(function(a, b) {
            return idOrder.indexOf(a.id) - idOrder.indexOf(b.id);
        });
        // Update sort_order in memory too
        trIwWatchlists.forEach(function(wl, idx) { wl.sort_order = idx; });

        trIwCloseReorderModal();
        trIwRender();
        showAlert('Watchlist order saved', 'success', 2000);
    } catch (err) {
        showAlert('Failed to save order: ' + err.message, 'error');
    }
}

// Drag-to-reorder within the modal
function trIwSetupDragReorder(container) {
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
            var moved = trIwReorderList.splice(fromIdx, 1)[0];
            trIwReorderList.splice(toIdx, 0, moved);

            trIwRenderReorderList();
        });
    });
}

// ============================================================================
// PRICE ALERTS  (dual: alert_above + alert_below per item)
// ============================================================================

// Track which alerts have already shown a toast (avoid repeat toasts)
var trIwAlertToasted = {};  // "itemId:above" or "itemId:below" → true

// Compute alert visual state for a given item + CMP
// Returns: { dotClass, aboveState, belowState }
// Single dot: 'dot-set' (yellow, alert exists), 'dot-near' (amber, within 2%),
//             'dot-triggered-above' (green), 'dot-triggered-below' (red)
function trIwGetAlertState(item, cmp) {
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
function trIwUpdateAlertsInPlace() {
    var rows = trIwRoot().querySelectorAll('.wl-security-row');
    rows.forEach(function(row) {
        var itemId = row.dataset.itemId;
        var wlId = row.dataset.wlId;

        // Find the item
        var item = null;
        for (var w = 0; w < trIwWatchlists.length; w++) {
            var wl = trIwWatchlists[w];
            if (wl.id !== wlId) continue;
            for (var i = 0; i < wl.items.length; i++) {
                if (wl.items[i].id === itemId) { item = wl.items[i]; break; }
            }
            if (item) break;
        }
        if (!item) return;

        var hasAbove = item.alert_above != null;
        var hasBelow = item.alert_below != null;

        var price = trIwPriceOf(item);
        var cmp = price ? price.lp : null;
        var state = trIwGetAlertState(item, cmp);

        // Update single dot inside .wl-sec-price
        var priceCell = row.querySelector('.wl-sec-price');
        if (!priceCell) return;

        // Remove existing dot
        var existingDot = priceCell.querySelector('.wl-alert-dot');
        if (existingDot) existingDot.remove();

        if (hasAbove || hasBelow) {
            var dotTitle = '';
            if (hasBelow) dotTitle += '▼ ' + trIwMoney(item, item.alert_below);
            if (hasAbove && hasBelow) dotTitle += '  ';
            if (hasAbove) dotTitle += '▲ ' + trIwMoney(item, item.alert_above);

            var dot = document.createElement('span');
            dot.className = 'wl-alert-dot ' + state.dotClass;
            dot.title = dotTitle;

            var priceMain = priceCell.querySelector('.wl-price-main');
            if (priceMain) priceCell.insertBefore(dot, priceMain);
        }

        // Toast notifications on first trigger (per direction)
        var sym = item._displaySymbol || item.short_symbol;
        if (state.aboveState === 'triggered' && !trIwAlertToasted[item.id + ':above']) {
            trIwAlertToasted[item.id + ':above'] = true;
            showAlert(sym + ' crossed ▲ ' + trIwMoney(item, item.alert_above), 'info', 4000);
        }
        if (state.belowState === 'triggered' && !trIwAlertToasted[item.id + ':below']) {
            trIwAlertToasted[item.id + ':below'] = true;
            showAlert(sym + ' dropped ▼ ' + trIwMoney(item, item.alert_below), 'info', 4000);
        }
    });
}

// Open alert popover on a security row
// editDir: optional 'above' or 'below' to pre-focus that field
var trIwAlertPopoverRow = null;

function trIwOpenAlertPopover(row, editDir) {
    trIwCloseAlertPopover();

    var itemId = row.dataset.itemId;
    var wlId = row.dataset.wlId;

    // Find item
    var item = null;
    for (var w = 0; w < trIwWatchlists.length; w++) {
        var wl = trIwWatchlists[w];
        if (wl.id !== wlId) continue;
        for (var i = 0; i < wl.items.length; i++) {
            if (wl.items[i].id === itemId) { item = wl.items[i]; break; }
        }
        if (item) break;
    }
    if (!item) return;

    var price = trIwPriceOf(item);
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
    trIwAlertPopoverRow = row;

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

        trIwSaveAlert(item, aboveV, belowV);
        trIwCloseAlertPopover();
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
            trIwSaveAlert(item, aboveV, belowV);
            trIwCloseAlertPopover();
        });
    });

    // Keyboard: Enter to save, Escape to close
    [inputAbove, inputBelow].forEach(function(input) {
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                popover.querySelector('.btn-alert-save').click();
            }
            if (e.key === 'Escape') {
                trIwCloseAlertPopover();
            }
            e.stopPropagation();
        });
    });

    // Focus the relevant input
    var focusTarget = editDir === 'below' ? inputBelow : inputAbove;
    setTimeout(function() { focusTarget.focus(); focusTarget.select(); }, 50);
}

function trIwCloseAlertPopover() {
    if (trIwAlertPopoverRow) {
        var popover = trIwAlertPopoverRow.querySelector('.wl-alert-popover');
        if (popover) popover.remove();
        trIwAlertPopoverRow = null;
    }
}

// Save both alert fields to Supabase and update in-memory
async function trIwSaveAlert(item, alertAbove, alertBelow) {
    var resp = await fetch(SUPABASE_URL + '/rest/v1/watchlist_items?id=eq.' + item.id, {
        method: 'PATCH',
        headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'}),
        body: JSON.stringify({ alert_above: alertAbove, alert_below: alertBelow })
    });

    if (resp.ok) {
        item.alert_above = alertAbove;
        item.alert_below = alertBelow;
        // Reset toast tracking (new values = new trigger cycle)
        delete trIwAlertToasted[item.id + ':above'];
        delete trIwAlertToasted[item.id + ':below'];
        trIwRender();
        var sym = item._displaySymbol || item.short_symbol;
        var parts = [];
        if (alertAbove) parts.push('▲ ' + trIwMoney(item, alertAbove));
        if (alertBelow) parts.push('▼ ' + trIwMoney(item, alertBelow));
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

window.trIwInit = trIwInit;
window.trIwDestroy = trIwDestroy;

// Find an item by id (used by the alert popover)
function trIwFindItem(id) {
    for (var i = 0; i < (trIwWatchlists || []).length; i++) {
        var it = (trIwWatchlists[i].items || []).find(function(x) { return String(x.id) === String(id); });
        if (it) return it;
    }
    return null;
}
