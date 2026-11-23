// ============================================================================
// wms-app-push.js — iPhone alerts: register this phone (iOS Alerts Plan v1, step 2, 23-Nov-2026)
// ----------------------------------------------------------------------------
// WMS iPhone app only (does nothing on the desktop, in Safari, or in an older app build without the
// notifications plugin). For the owner (v1: alerts go to your phone only):
//   1. asks iOS once "Allow notifications?" (iOS remembers the answer; change it in iPhone Settings › WMS);
//   2. once allowed, saves this phone's notification address (device token) in wms_push_devices,
//      so EF wms-push can send alerts (first: the morning broker login);
//   3. tapping an alert opens WMS on Home.
// No numbers, no screens and no other data are touched.
// ============================================================================
(function () {
    function inApp() {
        try { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); } catch (e) { return false; }
    }
    if (!inApp()) return;

    function plugin() {
        var C = window.Capacitor;
        try { if (typeof C.isPluginAvailable === 'function' && !C.isPluginAvailable('PushNotifications')) return null; } catch (e) {}
        return (C.Plugins && C.Plugins.PushNotifications) || null;
    }

    async function saveToken(t) {
        var token = t && t.value;
        if (!token || !window.currentUser || !window.currentUser.email) return;
        try {
            var r = await fetch(SUPABASE_URL + '/rest/v1/wms_push_devices?on_conflict=device_token', {
                method: 'POST',
                headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
                body: JSON.stringify({
                    user_email: String(window.currentUser.email).toLowerCase(),
                    device_token: token, platform: 'ios', app_bundle: 'com.veins.wms',
                    enabled: true, last_error: null, last_seen_at: new Date().toISOString()
                })
            });
            if (!r.ok) console.warn('iPhone alerts: could not save this phone', r.status);
        } catch (e) { console.warn('iPhone alerts: could not save this phone', e); }
    }

    var started = false, tries = 0;
    async function start() {
        if (started) return;
        if (!window.currentUser || !window.wmsAccess) { if (++tries < 120) setTimeout(start, 1000); return; }
        if (!window.wmsAccess.isOwner) return;          // v1: alerts for the owner's phone only
        var P = plugin();
        if (!P) return;                                   // older app build: nothing to do
        started = true;
        try {
            P.addListener('registration', saveToken);
            P.addListener('registrationError', function (e) { console.warn('iPhone alerts: registration failed', e); });
            P.addListener('pushNotificationActionPerformed', function () {
                try { if (typeof window.wmsPhoneShowHome === 'function') window.wmsPhoneShowHome(); } catch (e) {}
            });
            var st = await P.checkPermissions();
            if (st.receive === 'prompt' || st.receive === 'prompt-with-rationale') st = await P.requestPermissions();
            if (st.receive === 'granted') await P.register();   // also refreshes the address on every open
        } catch (e) { console.warn('iPhone alerts: not available', e); }
    }
    if (document.readyState === 'complete') setTimeout(start, 1500);
    else window.addEventListener('load', function () { setTimeout(start, 1500); });
})();
