// ============================================================================
// m-upright.js — PHONE LAYER: Duo opened upright (601–699 points wide, taller than wide)
// (WMS iPhone App Plan, Phase 5, mock-ups B–D, 21-Nov-2026)
// ----------------------------------------------------------------------------
// The rearranged layout itself is CSS (m-styles.css "PHASE 5" block). This file only adds the
// column header above the one-line Portfolio rows (mock-up C). The header's 4th column names the
// amount the rows show, which follows the Sort choice exactly as today's rows do.
// Nothing here runs on regular phones (≤600 wide) or in the full web app.
// ============================================================================
(function () {
    var MQ = window.matchMedia('screen and (orientation: portrait) and (min-width: 601px) and (max-width: 699px)');
    function upright() { return MQ.matches && (typeof wmsPhoneMode !== 'function' || wmsPhoneMode()); }

    function metricLabel() {
        var c = (typeof trSortColumn !== 'undefined') ? trSortColumn : '';
        if (c === 'daypl') return "Day's P&L";
        if (c === 'invested') return 'Invested';
        if (c === 'value') return 'Value';
        return 'Total P&L';
    }

    function addHeader() {
        var box = document.getElementById('tr-portfolio-cards');
        if (!box) return;
        var old = box.querySelector(':scope > .trm-uhead');
        if (!upright() || !box.querySelector(':scope > .trm-row')) { if (old) old.remove(); return; }
        var html = '<span>Holding</span><span>Qty @ Avg</span><span>Price · Day</span><span>' + metricLabel() + '</span><span>%</span>';
        if (old) { if (old.innerHTML !== html) old.innerHTML = html; return; }
        var h = document.createElement('div');
        h.className = 'trm-uhead';
        h.innerHTML = html;
        var firstRow = box.querySelector(':scope > .trm-row');
        box.insertBefore(h, firstRow);
    }

    var obs = null;
    function hook() {
        var box = document.getElementById('tr-portfolio-cards');
        if (!box) return false;
        if (!obs) {
            obs = new MutationObserver(function () { obs.disconnect(); addHeader(); obs.observe(box, { childList: true }); });
            obs.observe(box, { childList: true });
        }
        addHeader();
        return true;
    }
    if (!hook()) {
        var bodyObs = new MutationObserver(function () { if (hook()) bodyObs.disconnect(); });
        bodyObs.observe(document.documentElement, { childList: true, subtree: true });
    }
    if (MQ.addEventListener) MQ.addEventListener('change', addHeader); else if (MQ.addListener) MQ.addListener(addHeader);
    window.addEventListener('wms-mode-change', function () { setTimeout(addHeader, 50); });
})();
