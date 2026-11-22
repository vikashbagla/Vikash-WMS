// ============================================================================
// m-ticker.js — PHONE LAYER: moving index ticker (owner, 22-Nov-2026)
// ----------------------------------------------------------------------------
// On the phone the index ticker becomes one moving line:
//   • always first, locked: NIFTY · BANKNIFTY · SENSEX · GOLD (the same four as the desktop);
//   • then every symbol in your watchlist named "Current" (Trading › Watchlist), in its order.
//   • each item is two lines: the symbol on top; below it the last price with ▲/▼ and the % change
//     (no ₹ change). Up = green, down = red. Greyed while it is the last-known value, not yet fresh.
//   • tapping it does nothing.
//   • folded Duo: the line runs the full width, behind the camera, into the Control Center area.
// Prices come from the app's own index ticker call (app.html fetchIndexPrices): this file only tells it
// which extra symbols to ask for (window.wmsTickerExtra) in that SAME call every 30 s — no extra calls
// to Fyers. The desktop never loads this file, so its ticker is unchanged.
// ============================================================================
(function () {
    var LIST_KEY = 'wms_mt_list_v1';          // last "Current" list, so a cold start shows it at once
    var LOCKED = [
        { id: 'NSE:NIFTY50-INDEX', label: 'NIFTY' },
        { id: 'NSE:NIFTYBANK-INDEX', label: 'BANKNIFTY' },
        { id: 'BSE:SENSEX-INDEX', label: 'SENSEX' },
        { id: '@GOLD', label: 'GOLD' }         // the gold contract changes month to month (app.html resolves it)
    ];
    var extra = [];
    try { extra = JSON.parse(localStorage.getItem(LIST_KEY) || '[]') || []; } catch (e) { extra = []; }
    window.wmsTickerExtra = extra;

    function phone() { return typeof wmsPhoneMode === 'function' ? wmsPhoneMode() : true; }
    function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

    var box = null, track = null, builtFor = '';
    function items() { return LOCKED.concat(extra.map(function (x) { return { id: x.sym, label: x.label }; })); }

    function cell(it) {
        return '<div class="wms-mt-cell" data-id="' + esc(it.id) + '"><div class="wms-mt-sym">' + esc(it.label) + '</div>' +
            '<div class="wms-mt-val"><span class="wms-mt-lp">—</span> <span class="wms-mt-ch"></span></div></div>';
    }
    function build() {
        var tk = document.getElementById('indexTicker');
        if (!tk) return false;
        if (!box) {
            box = document.createElement('div'); box.className = 'wms-mt'; box.id = 'wmsMT'; box.setAttribute('aria-hidden', 'true');
            track = document.createElement('div'); track.className = 'wms-mt-track';
            box.appendChild(track); tk.appendChild(box);
        }
        var list = items(), sig = list.map(function (i) { return i.id; }).join('|');
        if (sig !== builtFor) {
            var one = list.map(cell).join('');
            track.innerHTML = one + one;             // two copies: the line loops without a gap
            builtFor = sig;
            requestAnimationFrame(speed);
        }
        paint(window.wmsTickerQuotes);
        return true;
    }
    function speed() {
        if (!track) return;
        var half = track.scrollWidth / 2;
        track.style.animationDuration = Math.max(20, Math.round(half / 32)) + 's';   // about 32 points a second
    }

    function fmt(lp) {
        var dp = lp >= 10000 ? 0 : 2;
        return Number(lp).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    }
    function paint(d) {
        if (!track || !d || !d.q) return;
        Array.prototype.forEach.call(track.querySelectorAll('.wms-mt-cell'), function (c) {
            var id = c.getAttribute('data-id');
            var v = d.q[id === '@GOLD' ? d.gold : id];
            var lpEl = c.querySelector('.wms-mt-lp'), chEl = c.querySelector('.wms-mt-ch');
            if (!v || !(v.lp > 0)) { lpEl.textContent = '—'; chEl.textContent = ''; c.className = 'wms-mt-cell'; return; }
            lpEl.textContent = fmt(v.lp);
            var p = Number(v.chp);
            if (isNaN(p)) { chEl.textContent = ''; c.className = 'wms-mt-cell'; }
            else {
                chEl.textContent = (p > 0 ? '▲ ' : p < 0 ? '▼ ' : '') + Math.abs(p).toFixed(2) + '%';
                c.className = 'wms-mt-cell ' + (p > 0 ? 'up' : p < 0 ? 'down' : 'flat');
            }
            if (d.stale) c.classList.add('stale');
        });
    }

    function onMode() { document.documentElement.classList.toggle('wms-mt-on', phone()); }

    // ---- the "Current" watchlist → Fyers symbols (same rules as the Watchlist tab, trWlLoadBrokerTokens) ----
    function hdr() { return typeof wmsHeaders === 'function' ? wmsHeaders() : {}; }
    async function getJson(path) {
        var r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { headers: hdr() });
        return r.ok ? r.json() : [];
    }
    function nfoSym(rec, item) {
        if (rec && rec.broker_tokens && rec.broker_tokens.fyers) return rec.broker_tokens.fyers.symbol || rec.broker_tokens.fyers.nse_symbol || null;
        if (rec && rec.symbol) { var s = rec.symbol; return s.indexOf(':') >= 0 ? s : (String(rec.exchange || 'NSE').toUpperCase() + ':' + s); }
        return item.short_symbol && item.short_symbol.indexOf(':') >= 0 ? item.short_symbol : null;
    }
    function cmSym(rec, item) {
        var bt = rec && rec.broker_tokens && rec.broker_tokens.fyers;
        if (bt && (bt.nse_symbol || bt.bse_symbol || bt.symbol)) return bt.nse_symbol || bt.bse_symbol || bt.symbol;
        if (rec && rec.nse_symbol) return 'NSE:' + rec.nse_symbol + '-EQ';
        if (rec && rec.bse_symbol) return 'BSE:' + rec.bse_symbol;
        return item.short_symbol ? 'NSE:' + item.short_symbol + '-EQ' : null;
    }
    function label(item) { var s = String(item.short_symbol || ''); var i = s.indexOf(':'); return i >= 0 ? s.slice(i + 1) : s; }

    async function loadCurrent() {
        var uid = window.currentUser && window.currentUser.id;
        var wl = await getJson('watchlists?select=id&user_id=eq.' + uid + '&market=eq.india&name=eq.Current&limit=1');
        if (!wl.length) return [];
        var its = await getJson('watchlist_items?select=security_id,security_source,short_symbol,sort_order&watchlist_id=eq.' + wl[0].id + '&order=sort_order,created_at');
        var cm = [], nfo = [];
        its.forEach(function (i) { if (i.security_source === 'securities_nfo') nfo.push(i.security_id); else if (i.security_source !== 'options_dynamic') cm.push(i.security_id); });
        var cmRows = cm.length ? await getJson('securities_db?select=id,nse_symbol,bse_symbol,broker_tokens&id=in.(' + cm.join(',') + ')') : [];
        var nfoRows = nfo.length ? await getJson('securities_nfo?select=id,symbol,exchange,broker_tokens&id=in.(' + nfo.join(',') + ')') : [];
        var cmMap = {}, nfoMap = {};
        cmRows.forEach(function (r) { cmMap[r.id] = r; }); nfoRows.forEach(function (r) { nfoMap[r.id] = r; });
        var out = [], seen = {};
        its.forEach(function (i) {
            var sym = i.security_source === 'options_dynamic' ? i.security_id
                : i.security_source === 'securities_nfo' ? nfoSym(nfoMap[i.security_id], i) : cmSym(cmMap[i.security_id], i);
            if (sym && !seen[sym]) { seen[sym] = 1; out.push({ sym: sym, label: label(i) || sym }); }
        });
        return out;
    }
    var loading = false;
    async function refreshList() {
        if (loading || !window.currentUser || typeof SUPABASE_URL === 'undefined') return;
        loading = true;
        try {
            var list = await loadCurrent();
            var changed = JSON.stringify(list) !== JSON.stringify(extra);
            extra = list; window.wmsTickerExtra = list;
            try { localStorage.setItem(LIST_KEY, JSON.stringify(list)); } catch (e) {}
            if (changed) { build(); if (window.wmsIndexRefreshNow) window.wmsIndexRefreshNow(); }
        } catch (e) { console.warn('Ticker: could not read the "Current" watchlist', e); }
        loading = false;
    }

    window.addEventListener('wms-ticker-quotes', function (e) { paint(e.detail); });
    window.addEventListener('wms-mode-change', function () { onMode(); setTimeout(speed, 100); });
    window.addEventListener('resize', function () { setTimeout(speed, 200); });
    onMode();
    var tries = 0;
    (function start() { if (!build() && ++tries < 80) setTimeout(start, 250); })();
    // The list is read once you are signed in, then every 5 minutes (so a symbol you add to "Current" appears).
    var t2 = 0;
    (function waitUser() {
        if (window.currentUser) { refreshList(); setInterval(refreshList, 5 * 60 * 1000); return; }
        if (++t2 < 240) setTimeout(waitUser, 500);
    })();
})();
