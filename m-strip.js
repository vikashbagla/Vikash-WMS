// ============================================================================
// m-strip.js — PHONE LAYER: iPhone Duo folded — header buttons in the right-hand strip
// (WMS iPhone App Plan, mock-up G, step 4.3, 21-Nov-2026)
// ----------------------------------------------------------------------------
// On the folded Duo iOS keeps a strip down the right edge (camera, time, battery at its top; 84 points
// wide, measured 20-Nov). Inside the WMS app the page may draw there, so — mock-up G — the header
// buttons move into that strip and the header row disappears, giving the screen its full height:
//   • stacked from the bottom up, in the same two groups as the header:
//       upper group:  app icon (Home) · full refresh ⟳ · ₹ '000
//       lower group:  refresh 🔄 · show/hide 👁 · banner ▲ · broker login dots · sign out ⏻
//       at the very bottom: new trade ±
//   • the index ticker and the Day's P&L banner stay at the top; the bottom bar stays at the bottom.
// The buttons are MOVED (not copied), so every button keeps exactly what it does; they go back to the
// header the moment the strip is gone (Duo opened, or any other phone). Decided only by whether iOS
// reserves a side strip AND the phone layout is showing — no phone names.
// If the strip turns out too cluttered on the real screen, plan decision 6 falls back to mock-up F.
// Test switch: localStorage 'wms_test_strip' = a width in points (e.g. '84') pretends there is a strip.
// ============================================================================
(function () {
    var MIN_STRIP = 50;                       // a side inset this wide or more = the Duo's strip
    var probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;right:0;width:env(safe-area-inset-right,0px);height:0;visibility:hidden;pointer-events:none;';
    document.documentElement.appendChild(probe);

    function stripWidth() {
        try { var t = parseInt(localStorage.getItem('wms_test_strip'), 10); if (t > 0) return t; } catch (e) {}
        return Math.round(probe.getBoundingClientRect().width) || 0;
    }

    var strip = null, moved = [];
    function remember(el) { if (el) moved.push({ el: el, parent: el.parentNode, next: el.nextSibling }); return el; }

    function build(w) {
        strip = document.createElement('div');
        strip.id = 'wms-strip';
        strip.setAttribute('aria-label', 'App buttons');
        var upper = document.createElement('div'); upper.className = 'wms-strip-group';
        var lower = document.createElement('div'); lower.className = 'wms-strip-group';
        var bottom = document.createElement('div'); bottom.className = 'wms-strip-trade';
        var logo = remember(document.querySelector('.app-header .logo-section'));
        if (logo) upper.appendChild(logo);
        var user = remember(document.querySelector('.app-header .user-section'));
        if (user) lower.appendChild(user);
        var trade = remember(document.getElementById('trAddTxnBtn'));
        if (trade) bottom.appendChild(trade);
        strip.appendChild(upper); strip.appendChild(lower); strip.appendChild(bottom);
        document.body.appendChild(strip);
    }
    function teardown() {
        for (var i = moved.length - 1; i >= 0; i--) {
            var m = moved[i];
            if (!m.parent || !m.parent.isConnected) continue;
            var next = (m.next && m.next.parentNode === m.parent) ? m.next : null;
            m.parent.insertBefore(m.el, next);
        }
        moved = [];
        if (strip) strip.remove();
        strip = null;
    }

    function update() {
        var w = stripWidth();
        var phone = typeof wmsPhoneMode === 'function' ? wmsPhoneMode() : true;
        var on = phone && w >= MIN_STRIP;
        document.documentElement.style.setProperty('--wms-strip', on ? (w + 'px') : '0px');
        document.documentElement.classList.toggle('wms-side-strip', on);
        if (on && !strip) build(w);
        else if (!on && strip) teardown();
    }

    var t = null;
    function later() { clearTimeout(t); t = setTimeout(update, 200); }
    window.addEventListener('resize', later);
    window.addEventListener('orientationchange', function () { setTimeout(update, 350); });
    window.addEventListener('wms-mode-change', function () { setTimeout(update, 50); });
    // The ± button lives in the banner the app fills in during start-up: wait until it exists.
    var tries = 0;
    (function first() {
        if (document.getElementById('trAddTxnBtn') || ++tries > 40) { update(); return; }
        setTimeout(first, 250);
    })();
})();
