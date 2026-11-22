// ============================================================================
// m-nav.js — PHONE LAYER: Back button + Live order placeholder
// (Duo Control Center Plan v1, owner decisions 22-Nov-2026)
// ----------------------------------------------------------------------------
// Back ← (at the top of the Control Center on the folded Duo; at the left of the header elsewhere):
//   1. closes an open panel or pop-up first (sheets, the New Entry form, the More / Sort box);
//   2. otherwise goes ONE STEP UP the ladder of screens towards Home — not back through the screens you
//      happened to visit (owner, 22-Nov-2026: "follows the ladder of pages to home"):
//        Portfolio › one holding "By investor"  →  Portfolio list
//        MS007 (Live / Paper / Controls)         →  Auto Trading
//        Auto Trading · Trading (any tab) · Statements · any other module  →  Home
//   3. on Home it is greyed out.
// Live order: a placeholder in the layout (red ₹ icon, above New Entry). Greyed; a tap only says
//   "Coming soon" — it does NOT open the order window (that window is not phone-ready yet; Phone
//   Broker Order Plan). Nothing else here changes what any screen shows or does.
// ============================================================================
(function () {
    function $(s, r) { return (r || document).querySelector(s); }
    function visible(el) {   // works for fixed-position sheets too (their offsetParent is null)
        if (!el || !el.isConnected) return false;
        var cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
    }

    // ---- where are we? ----
    function homeShown() { var p = $('#content-container .module-pane[data-pane="phone-home"]'); return !!(p && p.style.display !== 'none'); }
    function state() {
        if (document.body.classList.contains('mst-on')) return 'statements';
        if (homeShown()) return 'home';
        var mod = (typeof currentModule !== 'undefined') ? currentModule : null;
        if (mod === 'trading') {
            var a = $('#wmsBottomNav .bnav-item.active');
            return 'trading:' + ((a && a.getAttribute('data-subtab')) || 'tr-portfolio');
        }
        if (mod === 'automation') {
            var land = $('.mau-landing');
            return (land && visible(land)) ? 'auto:landing' : 'auto:ms007';
        }
        return mod ? ('mod:' + mod) : 'home';
    }

    function track() { paint(); }

    // ---- open overlays, closed first ----
    function closeOverlay() {
        var sheets = Array.prototype.slice.call(document.querySelectorAll('.mau-sheet')).filter(visible);
        if (sheets.length) {
            var sh = sheets[sheets.length - 1];
            var b = $('.mau-back', sh) || $('.mst-done', sh) || $('.mau-done', sh);
            if (b) { b.click(); return true; }
        }
        var add = document.getElementById('addTxnOverlay');
        if (add && add.classList.contains('show')) { if (typeof closeAddTxnModal === 'function') closeAddTxnModal(); else add.classList.remove('show'); return true; }
        var menus = Array.prototype.slice.call(document.querySelectorAll('.wms-ph-menu')).filter(function (m) { return m.style.display === 'block'; });
        if (menus.length) { menus.forEach(function (m) { m.style.display = 'none'; }); return true; }
        var pop = Array.prototype.slice.call(document.querySelectorAll('.modal-overlay.show, .modal.show, [role="dialog"]')).filter(visible);
        if (pop.length) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; }
        return false;
    }
    function anyOverlay() {
        if (Array.prototype.slice.call(document.querySelectorAll('.mau-sheet')).filter(visible).length) return true;
        var add = document.getElementById('addTxnOverlay'); if (add && add.classList.contains('show')) return true;
        return Array.prototype.slice.call(document.querySelectorAll('.wms-ph-menu')).some(function (m) { return m.style.display === 'block'; });
    }

    // ---- one step up the ladder ----
    function up() {
        var bb = document.getElementById('trmBreakupBack');          // Portfolio › By investor → the list
        if (bb && visible(bb)) { bb.click(); return true; }
        var s = state();
        if (s === 'home') return false;
        if (s === 'auto:ms007') {                                     // MS007 → Auto Trading
            var leave = $('[data-mau-act="leave"]');
            if (leave && visible(leave)) { leave.click(); return true; }
        }
        if (window.wmsPhoneShowHome) { wmsPhoneShowHome(); return true; }   // everything else → Home
        return false;
    }
    function back() {
        if (closeOverlay()) { setTimeout(paint, 100); return; }
        try { up(); } catch (e) { console.warn('Back failed', e); }
        setTimeout(paint, 120);
    }

    // ---- buttons ----
    var btn = null;
    function paint() {
        if (!btn) return;
        var can = anyOverlay() || state() !== 'home';
        btn.disabled = !can;
    }
    function makeBack() {
        var logo = $('.logo-section');
        if (!logo || document.getElementById('wmsBackBtn')) return !!logo;
        btn = document.createElement('button');
        btn.type = 'button'; btn.id = 'wmsBackBtn'; btn.className = 'wms-back-btn';
        btn.setAttribute('aria-label', 'Back'); btn.title = 'Back'; btn.textContent = '←';
        btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); back(); });
        logo.insertBefore(btn, logo.firstChild);
        paint();
        return true;
    }
    function makeLive() {
        var trade = document.getElementById('trAddTxnBtn');
        if (!trade || document.getElementById('wmsLiveOrderBtn')) return !!trade;
        var b = document.createElement('button');
        b.type = 'button'; b.id = 'wmsLiveOrderBtn';
        b.setAttribute('aria-label', 'Live order (coming soon)'); b.title = 'Live order — coming soon';
        b.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            if (typeof showAlert === 'function') showAlert('Live order on the phone — coming soon', 'info', 2000);
        });
        trade.parentNode.insertBefore(b, trade);          // beside New Entry (or above it, in the Control Center)
        return true;
    }

    var tries = 0;
    (function start() {
        var a = makeBack(), b = makeLive();
        if ((!a || !b) && ++tries < 120) setTimeout(start, 250);
    })();

    // Track screens after every tap and every switch the app makes by itself.
    document.addEventListener('click', function () { setTimeout(track, 80); setTimeout(track, 600); }, true);
    window.addEventListener('wms-mode-change', function () { setTimeout(track, 100); });
    setInterval(track, 1500);
})();
