// WMS iPhone app — switches on "screens kept on the phone" (WMS iPhone App Plan, step 2.3, 21-Nov-2026).
// Runs ONLY inside the WMS iPhone app (Capacitor native platform). On desktop, in Safari and in the Safari
// Home Screen app it returns immediately and changes nothing. See wms-app-sw.js for what the worker does.
(function () {
    var inApp = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
    if (!inApp || !('serviceWorker' in navigator) || !window.caches) return;

    // Kill switch (per phone): localStorage.wms_app_sw = 'off' removes the worker and its file copies.
    var off = false;
    try { off = localStorage.getItem('wms_app_sw') === 'off'; } catch (e) { /* storage blocked */ }
    if (off) {
        navigator.serviceWorker.getRegistrations().then(function (rs) { rs.forEach(function (r) { r.unregister(); }); });
        caches.keys().then(function (ks) { ks.forEach(function (k) { if (k.indexOf('wms-screens-') === 0) caches.delete(k); }); });
        return;
    }

    navigator.serviceWorker.register('wms-app-sw.js', { scope: './', updateViaCache: 'none' })
        .then(function () { return navigator.serviceWorker.ready; })
        .then(function (reg) {
            // Ask for an update check a few seconds after the page has finished opening, so the check
            // never competes with the opening itself. New files are used from the next opening.
            function ask() { if (reg.active) reg.active.postMessage('wms-check-for-updates'); }
            if (document.readyState === 'complete') setTimeout(ask, 5000);
            else window.addEventListener('load', function () { setTimeout(ask, 5000); });
        })
        .catch(function (err) { console.warn('WMS app: screen copies not switched on', err); });

    navigator.serviceWorker.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'wms-screens-updated') console.log('WMS app: ' + e.data.changed + ' newer screen file(s) downloaded; used from the next opening');
    });
})();
