// ============================================================================
// m-home.js — PHONE LAYER: Home screen (owner request 2026-11-03)
// ----------------------------------------------------------------------------
// Loaded ONLY on phones (app.html WMS_PHONE gate); desktop never downloads it.
// • The phone opens on HOME: the header, index ticker and Day's-P&L banner as
//   today, then one block per module (desktop icons). Trading opens today's
//   Portfolio screen unchanged; Auto Trading opens its module; Reports and
//   Accounting show "Coming soon".
// • Tapping the 💼 icon (top left) returns to Home from anywhere.
// • The bottom bar (Portfolio · F&O · Watchlist · Txns) shows only inside Trading.
// Hooks into the shell only through public globals (loadModule, currentModule,
// trSwitchTab, wmsHasModule) — no desktop file is edited for this.
// ============================================================================
(function () {
    var MH_MODULES = [
        { mod: 'trading',    icon: '📈', name: 'Trading',      desc: 'Portfolio · F&amp;O · Watchlist · Txns' },
        { mod: 'automation', icon: '🤖', name: 'Auto Trading', desc: 'Strategies · live and paper' },
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
    if (!window.matchMedia('(max-width:480px)').matches) return false;
    if (typeof wmsPhoneShowHome !== 'function') return false;
    wmsPhoneShowHome();
    return true;
}

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
