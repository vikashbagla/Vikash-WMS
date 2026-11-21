// ============================================================================
// m-home.js — PHONE LAYER: Home screen (owner request 2026-11-03)
// ----------------------------------------------------------------------------
// Loaded ONLY on phones (app.html WMS_PHONE gate); desktop never downloads it.
// • The phone opens on HOME: the header, index ticker and Day's-P&L banner as
//   today, then one block per module (desktop icons). Trading opens today's
//   Portfolio screen unchanged; Auto Trading opens its module; Reports and
//   Accounting show "Coming soon".
// • Tapping the 💼 icon (top left) returns to Home from anywhere.
// • The bottom bar (Portfolio · F&O · Watchlist · Intl · Txns) shows only inside Trading.
// Hooks into the shell only through public globals (loadModule, currentModule,
// trSwitchTab, wmsHasModule) — no desktop file is edited for this.
// ============================================================================
(function () {
    var MH_MODULES = [
        { mod: 'trading',    icon: '<img class="mh-ico-img" src="icons/WMS-trading-icon-12c-v1.svg" alt="">',   // finalised icon 12c (20-Nov)
          name: 'Trading',      desc: 'Portfolio · F&amp;O · Watchlist · Txns' },
        { mod: 'automation', icon: '<img class="mh-ico-img" src="icons/WMS-algo-icon-6b-v1.svg" alt="">',   // finalised icon 6b (20-Nov)
          name: 'Auto Trading', desc: 'Strategies · live and paper' },
        { mod: 'statements', icon: '🧾', name: 'Statements', desc: 'Statements · read only' },   // m-stmt.js (11-Nov-2026)
        { mod: 'reports',    icon: '📊', name: 'Reports',      soon: true },
        { mod: 'accounting', icon: '📒', name: 'Accounting',   soon: true }
    ];

    function mhPane() {
        var c = document.getElementById('content-container');
        if (!c) return null;
        var p = c.querySelector('.module-pane[data-pane="phone-home"]');
        if (!p) {
            p = document.createElement('div');
            p.className = 'module-pane mh-pane';
            p.setAttribute('data-pane', 'phone-home');
            c.appendChild(p);
        }
        return p;
    }

    function mhRender(p) {
        var tiles = MH_MODULES.filter(function (m) {
            return typeof wmsHasModule !== 'function' || wmsHasModule(m.mod);
        }).map(function (m) {
            if (m.soon) {
                return '<div class="mh-tile mh-soon" aria-disabled="true">' +
                    '<span class="mh-ico">' + m.icon + '</span>' +
                    '<span class="mh-name">' + m.name + '</span>' +
                    '<span class="mh-badge">Coming soon</span>' +
                '</div>';
            }
            return '<button type="button" class="mh-tile" data-mh-mod="' + m.mod + '">' +
                '<span class="mh-ico">' + m.icon + '</span>' +
                '<span class="mh-name">' + m.name + '</span>' +
                '<span class="mh-desc">' + m.desc + '</span>' +
            '</button>';
        }).join('');
        p.innerHTML = '<div class="mh-wrap"><div class="mh-label">Modules</div><div class="mh-grid">' + tiles + '</div></div>';
        p.querySelectorAll('[data-mh-mod]').forEach(function (b) {
            b.addEventListener('click', function () { wmsPhoneOpen(b.getAttribute('data-mh-mod')); });
        });
    }

    function mhSetBottomNav(show) {
        document.body.classList.toggle('wms-ph-nobnav', !show);
    }

    // Show Home: hide every module pane (they stay mounted), clear the current module.
    window.wmsPhoneShowHome = function () {
        var p = mhPane();
        if (!p) return;
        if (!p.getAttribute('data-mh-ready')) { mhRender(p); p.setAttribute('data-mh-ready', '1'); }
        document.querySelectorAll('#content-container .module-pane').forEach(function (x) { if (x !== p) x.style.display = 'none'; });
        p.style.display = '';
        currentModule = null;   // so the next loadModule() of any module (even the last one) really switches
        if (typeof wmsPhoneCloseStatements === 'function') wmsPhoneCloseStatements();
        mhSetBottomNav(false);
        document.querySelectorAll('#wmsBottomNav .bnav-item').forEach(function (b) { b.classList.remove('active'); });
        window.scrollTo(0, 0);
    };

    // Open a module from Home. Trading opens on Portfolio, exactly as the phone did before Home existed.
    window.wmsPhoneOpen = async function (mod) {
        if (document.body.classList.contains('mh-early')) return;   // data still loading (early Home) — tiles wait
        if (mod === 'statements') {   // own Home block; opens the desktop Statements tab under the phone layout (m-stmt.js)
            if (typeof wmsPhoneOpenStatements === 'function') await wmsPhoneOpenStatements();
            return;
        }
        if (typeof wmsPhoneCloseStatements === 'function') wmsPhoneCloseStatements();
        await loadModule(mod);
        if (mod === 'trading') {
            if (typeof trSwitchTab === 'function') trSwitchTab('tr-portfolio');
            document.querySelectorAll('#wmsBottomNav .bnav-item').forEach(function (b) { b.classList.remove('active'); });
            var pBtn = document.querySelector('#wmsBottomNav .bnav-item[data-subtab="tr-portfolio"]');
            if (pBtn) pBtn.classList.add('active');
        }
    };

    // Bottom bar only inside Trading: wrap the shell's loadModule (every module switch goes through it).
    var _origLoadModule = window.loadModule;
    if (typeof _origLoadModule === 'function') {
        window.loadModule = function (moduleName, opts) {
            mhSetBottomNav(moduleName === 'trading');
            return _origLoadModule.apply(this, arguments);
        };
    }

    // Live switch between the phone layout and the full web app (Phase 4, m-mode.js), with no reload.
    // The phone styles switch by themselves; here only the screen you are on is kept sensible:
    //   • to the full web app: Home is a phone-only screen, so open Trading (or Statements for a
    //     statements-only login) instead; anything else stays where it is.
    //   • back to the phone layout: Trading and Auto Trading stay (bottom bar as usual); Statements
    //     stays; a module the phone does not show (Reports, Accounting, …) goes back to Home.
    window.addEventListener('wms-mode-change', function (e) {
        var phone = !!(e.detail && e.detail.phone);
        var onHome = (typeof currentModule === 'undefined' || !currentModule) && !document.body.classList.contains('mst-on');
        if (!phone) {
            if (onHome && !document.body.classList.contains('mh-early')) {
                if (typeof wmsHasModule === 'function' && wmsHasModule('trading') && window.wmsAccess && window.wmsAccess.isOwner) loadModule('trading');
                else if (typeof wmsPhoneOpenStatements === 'function' && typeof wmsHasModule === 'function' && wmsHasModule('statements')) wmsPhoneOpenStatements();
                else if (typeof wmsHasModule === 'function' && wmsHasModule('trading')) loadModule('trading');
            }
            return;
        }
        if (document.body.classList.contains('mst-on') || onHome) return;
        if (currentModule === 'trading') { mhSetBottomNav(true); return; }
        if (currentModule === 'automation') { mhSetBottomNav(false); return; }
        window.wmsPhoneShowHome();
    });

    // 💼 (top-left) → Home.
    var logo = document.querySelector('.logo-section h1');
    if (logo) {
        logo.setAttribute('role', 'button');
        logo.setAttribute('aria-label', 'Home');
        logo.setAttribute('tabindex', '0');
        logo.addEventListener('click', function () { window.wmsPhoneShowHome(); });
        logo.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.wmsPhoneShowHome(); } });
    }
})();

// Phone landing (D.13.5, moved here from m-trading.js 2026-11-03): in portrait (≤480px) the phone
// opens on Home. Returns true when it handled the landing; app.html falls back to the last module otherwise.
function wmsPhoneLanding() {
    if (!(typeof wmsPhoneMode === 'function' ? wmsPhoneMode() : window.matchMedia('(max-width:480px)').matches)) return false;   // phone layout only (Phase 4: m-mode.js)
    if (typeof wmsPhoneShowHome !== 'function') return false;
    document.body.classList.remove('mh-early');   // data loaded → tiles live
    wmsPhoneShowHome();
    return true;
}

// Early Home (owner request 11-Nov-2026: opening the phone app was a 5-10 s wait). As soon as the
// sign-in and the user's access are known, show Home (tiles greyed, "loading…") instead of the
// full-screen startup loader; the app keeps loading its data exactly as before, and the tiles come
// alive when it finishes (wmsPhoneLanding above, called by the app at the end of its start-up).
// Display only — nothing is loaded, calculated or skipped differently.
(function () {
    if (!(typeof wmsPhoneMode === 'function' ? wmsPhoneMode() : window.matchMedia('(max-width:480px)').matches)) return;   // phone layout only (Phase 4: m-mode.js)
    var OWNER = 'vikash.bagla@gmail.com';
    var started = Date.now();
    function accessKnown() {
        var u = window.currentUser, a = window.wmsAccess;
        if (!u || !u.email || !a) return false;
        return u.email === OWNER || !!a.caps;   // non-owners: their grants have been read
    }
    var timer = setInterval(function () {
        if (Date.now() - started > 30000) { clearInterval(timer); return; }
        if (document.getElementById('wmsNoAccess')) { clearInterval(timer); return; }
        if (!document.getElementById('startupLoader')) { clearInterval(timer); return; }   // start-up already finished
        if (!accessKnown() || typeof wmsPhoneShowHome !== 'function') return;
        clearInterval(timer);
        document.body.classList.add('mh-early');
        wmsPhoneShowHome();
    }, 50);
})();

// ============================================================================
// Phone app RESUME (owner request 07-Nov-2026): on the iPhone the app is the Safari page saved to
// the home screen, which iOS keeps in memory and RESUMES (no reload). The desktop reads the broker
// login status once, when the app loads — so a phone app resumed hours later still showed the old
// status, and if it was first opened before the morning login, live prices stayed off until a full
// reload. On resume (after a minute or more away) re-run the desktop's own login check
// (checkFyersAuth: re-reads wms_login_status, repaints the two dots, sets the price flag); if that
// turns prices on, start the desktop's own price refresh. Nothing new: the same functions the app
// runs on load. Owner only — other users never use the login status (the app sets their flag on load).
// ============================================================================
(function () {
    var lastCheck = Date.now();
    function onResume() {
        if (document.hidden) return;
        if (Date.now() - lastCheck < 60000) return;
        lastCheck = Date.now();
        if (!(window.wmsAccess && window.wmsAccess.isOwner)) return;
        if (typeof checkFyersAuth !== 'function') return;
        var pricesWereOff = !window.fyersToken;
        checkFyersAuth().then(function () {
            // The desktop's own resume handler restarts prices only if they were already on;
            // this covers the one case it skips: prices off before, on now.
            if (!pricesWereOff || !window.fyersToken) return;
            if (typeof wmsIsRefreshWindow !== 'function' || !wmsIsRefreshWindow()) return;
            if (typeof wmsStandardRefresh === 'function') wmsStandardRefresh(true);
            if (typeof wmsStartRefreshTimer === 'function') wmsStartRefreshTimer();
        }).catch(function (e) { console.warn('Phone resume: login status re-check failed', e); });
    }
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('pageshow', onResume);
})();

// ============================================================================
// International on the phone (owner request 20-Nov-2026): a bottom-bar item next to Watchlist that
// opens the desktop's own International tab (tr-international) — same page, same prices. Added here
// (not in app.html) so desktop and tablet are untouched. This file runs before the app wires up its
// bottom-bar buttons, so the new button gets the same click handling as the others.
// ============================================================================
(function () {
    var nav = document.getElementById('wmsBottomNav');
    var wl = nav && nav.querySelector('.bnav-item[data-subtab="tr-watchlist"]');
    if (!wl || nav.querySelector('.bnav-item[data-subtab="tr-international"]')) return;
    var b = document.createElement('button');
    b.className = 'bnav-item';
    b.setAttribute('data-module', 'trading');
    b.setAttribute('data-subtab', 'tr-international');
    b.innerHTML = '<span class="bnav-icon">🌐</span><span class="bnav-label">Intl</span>';
    wl.parentNode.insertBefore(b, wl.nextSibling);
})();

// ============================================================================
// ₹ '000 tap toggle on the phone (WMS iPhone App Plan step 2.5, owner comment 20-Nov-2026): tapping the
// unit badge in the phone header flips between the display unit (₹ '000 / Lakhs …) and full rupees —
// exactly the desktop's F4 switch (same flag, same re-render, choice remembered the same way). The badge
// always shows what is on screen. Phone layer only; desktop untouched.
// ============================================================================
(function () {
    var badge = document.querySelector('.mobile-unit-badge');
    if (!badge || badge._wmsUnitToggle) return;
    badge._wmsUnitToggle = true;
    function paint() {
        try { badge.textContent = (typeof getUnitDescription === 'function') ? getUnitDescription() : "₹ '000"; } catch (e) {}
        badge.setAttribute('aria-pressed', (typeof wmsIsFullAmount === 'function' && wmsIsFullAmount()) ? 'true' : 'false');
    }
    badge.setAttribute('role', 'button');
    badge.setAttribute('title', 'Tap to switch between ₹ \'000 and full amounts');
    badge.style.cursor = 'pointer';
    badge.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        if (typeof wmsSetFullAmount !== 'function' || typeof wmsIsFullAmount !== 'function') return;
        wmsSetFullAmount(!wmsIsFullAmount());                 // the desktop's own flag (also what F4 flips)
        if (typeof wmsRerenderAmounts === 'function') wmsRerenderAmounts();
        paint();
        if (typeof showAlert === 'function') showAlert(wmsIsFullAmount() ? 'Showing full amounts' : ('Showing ' + getUnitDescription()), 'info', 1500);
    });
    paint();
    // The display unit comes from the user's preferences, which can arrive after this file runs.
    // Keep repainting for the first 30 s (the unit arrives with the preferences, after sign-in — the old
    // stop-at-sign-in check left "₹ Lakhs" showing over '000 figures, owner 21-Nov-2026), and after prefs load.
    var tries = 0, t = setInterval(function () { paint(); if (++tries >= 60) clearInterval(t); }, 500);
    if (window._wmsPrefsReady && typeof window._wmsPrefsReady.then === 'function') window._wmsPrefsReady.then(function () { setTimeout(paint, 50); });
    window.addEventListener('focus', paint);
})();

// ============================================================================
// No full-screen "Loading…" on the phone while you are on Home (owner OK 21-Nov-2026, "ok prices").
// At start-up the Trading screen is prepared in the background and its first live-price fetch puts the
// desktop's grey "Loading…" cover over everything — 15-20 s on the phone, even though you are on Home.
// On the phone, while Home is showing, that cover is replaced by a small "Loading prices…" mark and Home
// stays usable. Open a module before it finishes and the normal cover shows there, exactly as today.
// Nothing about the loading itself changes (same calls, same order, same numbers). Phone layer only.
// ============================================================================
(function () {
    var ind = document.getElementById('loading-indicator');
    if (!ind) return;
    var st = document.createElement('style');
    st.textContent = 'body.wms-ph-bgload #loading-indicator{display:none !important}' +
        '#wmsPhBgMark{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 14px);z-index:100000;' +
        'background:rgba(30,41,59,.88);color:#fff;font:600 11.5px/1 system-ui,-apple-system,sans-serif;padding:7px 12px 7px 10px;border-radius:14px;' +
        'display:flex;align-items:center;gap:7px;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.18)}' +
        '#wmsPhBgMark i{width:8px;height:8px;border-radius:50%;border:2px solid #fff;border-top-color:transparent;animation:wmsPhBgSpin .8s linear infinite}' +
        '@keyframes wmsPhBgSpin{to{transform:rotate(360deg)}}';
    document.head.appendChild(st);

    function onHome() {
        var p = document.querySelector('#content-container .module-pane[data-pane="phone-home"]');
        return !!(p && p.style.display !== 'none' && (typeof wmsPhoneMode !== 'function' || wmsPhoneMode()));
    }
    function loadingShown() { return ind.style.display && ind.style.display !== 'none'; }
    function mark(on) {
        var m = document.getElementById('wmsPhBgMark');
        if (on && !m) { m = document.createElement('div'); m.id = 'wmsPhBgMark'; m.setAttribute('role', 'status'); m.innerHTML = '<i></i>Loading prices…'; document.body.appendChild(m); }
        if (!on && m) m.remove();
    }
    function sync() {
        var bg = loadingShown() && onHome();
        document.body.classList.toggle('wms-ph-bgload', bg);
        mark(bg);
    }
    new MutationObserver(sync).observe(ind, { attributes: true, attributeFilter: ['style'] });
    var cc = document.getElementById('content-container');
    if (cc) new MutationObserver(sync).observe(cc, { attributes: true, subtree: true, attributeFilter: ['style'], childList: true });
    window.addEventListener('wms-mode-change', sync);
    sync();
})();
