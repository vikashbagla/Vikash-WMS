// help.js — Help module (07-Nov-2026, owner request). Owner only (no access cap → hidden for others).
// Pages come from the database table help_pages (owner-only RLS) — NOT from this public repo.
// Left: pages grouped by section (sort order); right: the chosen page (HTML with <details>
// collapsible sections). The last page viewed is remembered per browser.

var _helpPages = [];

function _helpEsc(t) {
    return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}

// "07-Nov-2026" (house date style)
function _helpDate(iso) {
    try {
        var d = new Date(iso); if (isNaN(d.getTime())) return '';
        var p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).formatToParts(d);
        var g = function (t) { return (p.find(function (x) { return x.type === t; }) || {}).value || ''; };
        return g('day') + '-' + g('month') + '-' + g('year');
    } catch (_e) { return ''; }
}

function _helpRenderNav(activeSlug) {
    var nav = document.getElementById('helpNav');
    if (!nav) return;
    if (!_helpPages.length) { nav.innerHTML = '<div class="help-empty">No help pages yet.</div>'; return; }
    var html = '', lastSection = null;
    _helpPages.forEach(function (p) {
        if (p.section !== lastSection) { html += '<div class="hn-section">' + _helpEsc(p.section) + '</div>'; lastSection = p.section; }
        html += '<button type="button" class="hn-page' + (p.slug === activeSlug ? ' active' : '') + '" onclick="helpShow(\'' + _helpEsc(p.slug) + '\')">' + _helpEsc(p.title) + '</button>';
    });
    nav.innerHTML = html;
}

window.helpShow = function (slug) {
    var page = _helpPages.find(function (p) { return p.slug === slug; }) || _helpPages[0];
    var body = document.getElementById('helpBody');
    if (!body) return;
    if (!page) { body.innerHTML = '<div class="help-empty">No help pages yet.</div>'; return; }
    // body_html is written only by sessions/migrations into an owner-only table (the browser cannot write it).
    body.innerHTML = '<h1>' + _helpEsc(page.title) + '</h1>' +
        '<div class="hp-updated">' + _helpEsc(page.section) + (page.updated_at ? ' · updated ' + _helpDate(page.updated_at) : '') + '</div>' +
        page.body_html;
    body.scrollTop = 0;
    _helpRenderNav(page.slug);
    try { localStorage.setItem('wms_help_page', page.slug); } catch (_e) { /* per-browser convenience only */ }
};

window.initHelp = async function () {
    var nav = document.getElementById('helpNav');
    try {
        var res = await fetch(SUPABASE_URL + '/rest/v1/help_pages?select=slug,section,title,sort,body_html,updated_at&order=section.asc,sort.asc,title.asc', { headers: wmsHeaders() });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        _helpPages = await res.json();
    } catch (e) {
        console.error('[help] could not load help pages:', e);
        if (nav) nav.innerHTML = '<div class="help-empty">Could not load help pages — reload the app.</div>';
        return;
    }
    var last = null;
    try { last = localStorage.getItem('wms_help_page'); } catch (_e) { /* ignore */ }
    helpShow(last);
};
