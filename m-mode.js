// ============================================================================
// m-mode.js — PHONE LAYER: which layout a phone-sized device shows, live
// (WMS iPhone App Plan, Phase 4 steps 4.1 / 4.2, 21-Nov-2026)
// ----------------------------------------------------------------------------
// Loaded ONLY on phones (app.html WMS_PHONE gate), FIRST of the phone files; desktop and iPad never
// download it. The layout is decided by the space the app actually has (not the phone's name), checked
// again on every fold, unfold or turn — no reload, nothing re-fetched, you stay where you are:
//   • 600 points wide or less                         → phone layout   (any phone upright; Duo folded,
//                                                                        upright or sideways)
//   • taller than wide and under 700 wide             → phone layout   (Duo opened upright; rearranged
//                                                                        for the wider screen in Phase 5)
//   • wider than tall, 450+ tall and 760 or less wide → phone layout   (Duo folded, turned sideways — 22-Nov)
//   • anything wider                                  → the full web app, laid out at 1,280 points and
//                                                        zoomed out to fit (as Chrome on the iPad)
// The phone styles (m-styles.css) use the SAME rule as a CSS media query, so they switch on and off by
// themselves; this file sets the zoom for the full web app and tells the phone screens about a switch
// ('wms-mode-change' event on window, detail = { phone: true|false }).
// Test switch (unchanged): sessionStorage 'wms_force_phone'='1' still loads the phone layer on a Mac.
// ============================================================================
(function () {
    var WIDE_LAYOUT_WIDTH = 1280;            // decision 3 (20-Nov): full web app laid out at ~1,280 points
    var meta = document.querySelector('meta[name="viewport"]');
    var PHONE_VIEWPORT = meta ? meta.getAttribute('content') : 'width=device-width, initial-scale=1.0, viewport-fit=cover';
    // Phone layout: no automatic zoom-in when tapping into a text box (iOS zooms any box whose text is
    // smaller than 16 points). maximum-scale=1 stops that zoom only (owner, 21-Nov-2026).
    if (PHONE_VIEWPORT.indexOf('maximum-scale') < 0) PHONE_VIEWPORT += ', maximum-scale=1';   // screen-geometry
    var WIDE_VIEWPORT = 'width=' + WIDE_LAYOUT_WIDTH + ', viewport-fit=cover';

    // The space the app has, in points, whatever the current zoom. Width: the visible area times its zoom.
    // Height: the page height scaled the same way — NOT the visible height, which shrinks while the
    // keyboard is up and would otherwise flip the opened Duo to the full web app mid-typing.
    function usableSize() {
        var vv = window.visualViewport;
        var w = (vv && vv.width && vv.scale) ? vv.width * vv.scale : window.innerWidth;   // screen-geometry
        var r = window.innerWidth ? w / window.innerWidth : 1;   // screen-geometry
        return { w: Math.round(w), h: Math.round(window.innerHeight * r) };   // screen-geometry
    }
    // Third rule (owner, 22-Nov-2026): the Duo FOLDED and turned sideways (about 678 × 466) keeps the phone
    // layout — wider than 600 but taller than any regular phone held sideways (those are 440 or less, and
    // stay on the full web app, decision 2). The Duo opened sideways (867 wide) stays on the full web app.
    function phoneFor(s) { return s.w <= 600 || (s.h > s.w && s.w < 700) || (s.w > s.h && s.h >= 450 && s.w <= 760); }

    var current = null;
    function apply(force) {
        var s = usableSize();
        if (!s.w || !s.h) return;
        var phone = phoneFor(s);
        if (phone === current && !force) return;
        var changed = current !== null && phone !== current;
        current = phone;
        if (meta) meta.setAttribute('content', phone ? PHONE_VIEWPORT : WIDE_VIEWPORT);
        document.documentElement.classList.toggle('wms-wide-mode', !phone);
        document.documentElement.classList.toggle('wms-phone-mode', phone);
        if (changed) {
            try { window.dispatchEvent(new CustomEvent('wms-mode-change', { detail: { phone: phone, width: s.w, height: s.h } })); }
            catch (e) { console.warn('wms-mode-change listener failed', e); }
        }
    }

    // Public: is the phone layout showing right now? (replaces the old matchMedia('(max-width:480px)') checks)
    window.wmsPhoneMode = function () { if (current === null) apply(); return current !== false; };

    var t = null;
    function onResize() { clearTimeout(t); t = setTimeout(function () { apply(false); }, 150); }
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', function () { setTimeout(function () { apply(false); }, 300); });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);

    apply(true);
})();
