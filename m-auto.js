// ============================================================================
// m-auto.js — PHONE LAYER: Auto Trading › MS007 (owner request 2026-11-03,
// mock-up "MS007 Phone Screens" approved the same day).
// ----------------------------------------------------------------------------
// Loaded ONLY on phones (app.html WMS_PHONE gate); desktop never downloads it.
//
// HOW IT STAYS IDENTICAL TO DESKTOP
// • The desktop MS007 page still loads and renders exactly as before (same
//   data, same refresh, same price ticks) — on the phone it is just not shown.
// • This file READS what the desktop page has already drawn (the summary
//   boxes, the open / closed trade tables, the Controls cards) and lays the
//   same values out for a small screen. It works out NO number of its own.
// • Editing a book and viewing a strategy use the desktop's OWN card (moved
//   into a full-screen sheet), so the fields, the checks and the Save that
//   writes to the database are the desktop's, unchanged.
// • Filters use the desktop's own filter bar (moved into a sheet).
// • Close uses the desktop's own Close button → "Close position by hand".
// • If a desktop table ever changes shape, the phone shows the desktop table
//   itself with a note — it never guesses (F.13).
// Hooks into the shell only through public globals (loadModule,
// autoAt2Refresh) — no desktop file is edited for this.
// ============================================================================
(function () {
    var MAU = { tab: 'live', sheet: null, timer: null, allClosed: {} };

    function q(sel, root) { return (root || document).querySelector(sel); }
    function qa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
    function txt(el) { return el ? (el.textContent || '').trim() : ''; }
    function inner(el) { return el ? el.innerHTML : ''; }
    function esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    // '03 Nov 26 15:29' → '03 Nov 15:29' (owner: "dd mmm" to save space). Text only.
    function shortTs(s) { return String(s || '').replace(/(\d{2} [A-Za-z]{3}) \d{2}(?=\s|$)/g, '$1'); }
    // A desktop table cell split into its main line and the small lines under it.
    function parts(td) {
        if (!td) return { main: '', subs: [] };
        var c = td.cloneNode(true);
        var subs = qa(':scope > div', c).map(function (d) { var h = d.outerHTML; d.remove(); return h; });
        return { main: c.innerHTML.trim(), subs: subs };
    }
    function byId(id) { return document.getElementById(id); }

    // ── Header: name, alerts badge, live/paper pill + last activity, refresh ──
    function header() {
        var last = shortTs(txt(byId('au-at2-lastact')).replace(/^Last activity:\s*/, ''));
        return ['<div class="mau-head">',
            '<button type="button" class="mau-back mau-back-inline" data-mau-act="leave" aria-label="Back to Auto Trading">‹</button>',
            '<span class="mau-title">MS007</span>',
            '<span class="mau-alert">', inner(byId('au-at2-alertbadge')), '</span>',
            '<span class="mau-flex"></span>',
            '<span class="mau-status">', esc(txt(byId('au-at2-mode'))), ' · ', esc(last), '</span>',
            '<button type="button" class="mau-iconbtn" data-mau-act="refresh" aria-label="Refresh">↻</button>',
            '</div>'].join('');
    }

    // ── Summary boxes (the desktop's own figures, copied) ──────────────────
    function kpi(label, small, valueHtml, subHtml) {
        return ['<div class="mau-kpi"><div class="mau-kpi-l">', label,
            small ? ' <span class="mau-kpi-small">' + small + '</span>' : '',
            '</div><div class="mau-kpi-v">', valueHtml || '—', '</div>',
            '<div class="mau-kpi-s">', subHtml || '', '</div></div>'].join('');
    }
    function m(mode, k) { return byId('au-at2-' + mode + '-m-' + k); }
    // Desktop sub-line "1.23% of peak exp · 3W/2L" → ['1.23% of peak', '3W/2L']. Text only.
    function splitSub(el) {
        var s = txt(el);
        var i = s.indexOf(' · ');
        if (i < 0) return [esc(s), ''];
        return [esc(s.slice(0, i).replace(/ of peak exp$/, ' of peak')), esc(s.slice(i).replace(/^ · /, ''))];
    }

    // ── Trade cards, read from the desktop tables ──────────────────────────
    function headCells(table) { return qa('thead tr:last-child th', table).map(txt); }
    function fallback(el) {
        return ['<div class="mau-note">Phone view could not read this table, so the desktop table is shown as is.</div>',
            '<div class="mau-scrollx">', inner(el), '</div>'].join('');
    }
    function openTrades(mode) {
        var el = byId('au-at2-' + mode + '-open-content');
        if (!el) return '';
        var table = q('table', el);
        if (!table) return '<div class="mau-empty">' + inner(el) + '</div>';
        var h = headCells(table);
        if (h.length !== 12 || h[0] !== 'Status' || h[10].indexOf('Live P') !== 0 || h[11] !== 'Action') return fallback(el);
        var warn = qa(':scope > .au-error-list', el).map(function (x) { return x.outerHTML; }).join('');
        var cards = qa('tbody tr', table).map(function (tr) {
            var td = qa(':scope > td', tr);
            var ent = parts(td[3]), qty = parts(td[5]), px = parts(td[6]), mg = parts(td[9]), pl = parts(td[10]);
            var btn = q('button', td[11]);
            return ['<div class="mau-card">',
                '<div class="mau-r1"><span class="mau-book">', inner(td[1]), ' ', inner(td[2]), ' ', inner(td[0]), '</span>',
                '<span class="mau-big">', pl.main, '</span></div>',
                '<div class="mau-r"><span>', inner(td[4]), ' · ', qty.main, ' <span class="mau-inl">', qty.subs.join(''), '</span></span>',
                '<span class="mau-inl">', pl.subs.join(''), '</span></div>',
                '<div class="mau-r"><span>Entered ', shortTs(ent.main), '</span><span class="mau-inl">', ent.subs.join(''), ' held</span></div>',
                '<div class="mau-r"><span class="mau-inl">Entry ', px.main, ' · ', px.subs.join(' '), '</span>',
                '<span>LTP ', inner(td[7]), '</span></div>',
                '<div class="mau-r mau-rlast"><span class="mau-inl">Exp ', inner(td[8]), ' · Margin ', mg.main, ' ', mg.subs.join(''), '</span>',
                btn ? btn.outerHTML : '', '</div>',
                '</div>'].join('');
        });
        return warn + cards.join('');
    }
    function closedTrades(mode) {
        var el = byId('au-at2-' + mode + '-closed-content');
        if (!el) return '';
        var table = q('table', el);
        if (!table) return '<div class="mau-empty">' + inner(el) + '</div>';
        var h = headCells(table);
        if (h.length !== 11 || h[0] !== 'Status' || h[10].indexOf('Realised') !== 0) return fallback(el);
        var trs = qa('tbody tr', table);
        var all = !!MAU.allClosed[mode];
        var shown = (all || trs.length <= 5) ? trs : trs.slice(0, 5);   // owner: last five, the rest on request
        var rows = shown.map(function (tr) {
            var td = qa(':scope > td', tr);
            var ex = parts(td[4]), qty = parts(td[6]), pl = parts(td[10]);
            var status = txt(td[0]) === 'Closed' ? '' : ' ' + inner(td[0]);
            return ['<div class="mau-row">',
                '<div class="mau-r1"><span class="mau-book">', inner(td[1]), ' ', inner(td[2]), status, '</span>',
                '<span class="mau-big">', pl.main, '</span></div>',
                '<div class="mau-r"><span>In ', shortTs(inner(td[3])), ' @ ', inner(td[7]), '</span>',
                '<span>Out ', shortTs(ex.main), ' @ ', inner(td[8]), '</span></div>',
                '<div class="mau-r"><span class="mau-inl">', inner(td[9]), ' · ', qty.main, ' · ', ex.subs.join(''), '</span>',
                '<span class="mau-inl">', pl.subs.join(''), '</span></div>',
                '</div>'].join('');
        });
        var more = trs.length <= 5 ? '' : '<button type="button" class="mau-more" data-mau-act="more">'
            + (all ? 'Show last 5 only ▴' : 'Show all ' + trs.length + ' closed trades ▾') + '</button>';
        return '<div class="mau-list">' + rows.join('') + '</div>' + more;
    }

    function dashboard(mode) {
        var gross = splitSub(m(mode, 'realised-sub'));
        var net = splitSub(m(mode, 'net-sub'));
        return ['<div class="mau-body">',
            '<div class="mau-sec"><span>OPEN TRADES</span><span class="mau-flex"></span>',
            '<span class="mau-count">', esc(txt(byId('au-at2-' + mode + '-open-badge'))), '</span></div>',
            '<div class="mau-kpis mau-kpis2">',
            kpi('OPEN POSITIONS', '', inner(m(mode, 'open')), inner(m(mode, 'open-sub'))),
            kpi('OPEN EXPOSURE', '', inner(m(mode, 'exposure')), inner(m(mode, 'exposure-sub'))),
            '</div>',
            openTrades(mode),
            '<div class="mau-sec mau-sec2"><span>CLOSED TRADES</span>',
            '<span class="mau-count">', esc(txt(byId('au-at2-' + mode + '-closed-badge'))), '</span>',
            '<span class="mau-flex"></span>',
            '<button type="button" class="mau-chip" data-mau-act="filters">▾ Filters</button></div>',
            '<div class="mau-kpis mau-kpis3">',
            kpi('PEAK EXPOSURE', '', inner(m(mode, 'maxexp')), inner(m(mode, 'maxexp-sub'))),
            kpi('GROSS P&amp;L', gross[1], inner(m(mode, 'realised')), gross[0]),
            kpi('NET P&amp;L', net[1] ? 'after charges' : '', inner(m(mode, 'net')), net[0]),
            '</div>',
            closedTrades(mode),
            '</div>'].join('');
    }

    // ── Controls: books and strategies, read from the desktop Controls cards ──
    function badges(card) { return qa(':scope > .au-at2-strat-head .au-badge', card).map(txt); }
    function controls() {
        var c = byId('au-at2-controls-content');
        var cardsBlocks = c ? qa(':scope > .au-card', c) : [];
        if (cardsBlocks.length < 2) return '<div class="mau-body"><div class="mau-empty">' + inner(c) + '</div></div>';
        var books = qa('.au-at2-strat[data-bid]', c).map(function (b) {
            var bs = badges(b);
            var live = bs.indexOf('LIVE') >= 0, paper = bs.indexOf('paper') >= 0;
            var on = bs.indexOf('enabled') >= 0;
            var ident = (q('input.au-at2-locked', b) || {}).value || '';
            var strat = ident.split(' · ')[0];
            var ef = (q('input[data-col="exposure_factor"]', b) || {}).value;
            var lc = (q('input[data-col="lot_cap"]', b) || {}).value;
            return ['<div class="mau-card">',
                '<div class="mau-r1"><span class="mau-name">', esc(txt(q('.au-at2-name', b))),
                bs.indexOf('retired') >= 0 ? ' <span class="au-badge idle">retired</span>' : '', '</span>',
                '<span class="mau-pill ', on ? 'mau-on' : 'mau-off', '">', on ? 'ENABLED' : 'DISABLED', '</span></div>',
                '<div class="mau-r mau-rleft">',
                live ? '<span class="mau-tag-live">LIVE</span>' : (paper ? '<span class="mau-tag-paper">PAPER</span>' : '<span class="au-badge error">⛔ MODE?</span>'),
                '<span>', esc(strat), '</span></div>',
                '<div class="mau-r mau-rlast"><span class="mau-dark">Exposure × <b>', esc(ef), '</b> · Lot cap <b>', esc(lc), '</b></span>',
                '<button type="button" class="mau-btn" data-mau-book="', esc(b.getAttribute('data-bid')), '">Edit</button></div>',
                '</div>'].join('');
        });
        var strats = qa('.au-at2-strat[data-sid]', c).map(function (s) {
            var bs = badges(s);
            var on = bs.indexOf('enabled') >= 0;
            return ['<div class="mau-row mau-rowflex"><span><b>', esc(txt(q('.au-at2-name', s))), '</b> · ',
                '<span class="', on ? 'mau-ok' : 'mau-muted', '">', on ? 'ENABLED' : 'DISABLED', '</span></span>',
                '<button type="button" class="mau-btn" data-mau-strat="', esc(s.getAttribute('data-sid')), '">View</button></div>'].join('');
        });
        var hiddenBooks = txt(q('.au-at2-hiddenbar span', cardsBlocks[1]));
        return ['<div class="mau-body">',
            '<div class="mau-sec"><span>BOOKS</span></div>',
            books.join('') || '<div class="mau-empty">No books to show.</div>',
            hiddenBooks ? '<div class="mau-note">' + esc(hiddenBooks.replace(/hidden$/, 'hidden books')) + ' are not shown, same as desktop.</div>' : '',
            '<div class="mau-sec mau-sec2"><span>STRATEGIES</span></div>',
            '<div class="mau-list">', strats.join('') || '<div class="mau-empty">No strategies.</div>', '</div>',
            '</div>'].join('');
    }

    function bnav() {
        var tabs = [['live', '🟢', 'Live'], ['paper', '📝', 'Paper'], ['controls', '⚙️', 'Controls']];
        return '<nav class="mau-bnav">' + tabs.map(function (t) {
            return '<button type="button" class="mau-bitem' + (MAU.tab === t[0] ? ' active' : '') + '" data-mau-tab="' + t[0] + '">'
                + '<span class="mau-bico">' + t[1] + '</span><span>' + t[2] + '</span></button>';
        }).join('') + '</nav>';
    }

    // Strategy settings, view only (mock-up): one "label · value" line per desktop field, grouped
    // as on desktop. Values are read from the desktop's own strategy card; nothing is editable.
    function stratView(card) {
        var box = document.createElement('div');
        box.className = 'mau-sv';
        box.innerHTML = qa('.au-at2-group', card).map(function (g) {
            var rows = qa('.au-at2-field', g).map(function (f) {
                var lab = q('label', f);
                var name = lab ? lab.textContent.replace('🔒', '').trim() : '';
                var inp = q('input', f), pill = q('.au-at2-pill.on', f);
                var val = inp ? inp.value : (pill ? txt(pill) : '');
                return '<div class="mau-sv-row"><span>' + esc(name) + '</span><b>' + (val === '' ? '—' : esc(val)) + '</b></div>';
            }).join('');
            return '<div class="mau-sec mau-sv-sec">' + esc(txt(q('.au-at2-group-label', g))) + '</div><div class="mau-list">' + rows + '</div>';
        }).join('') + qa('.au-at2-unknown', card).map(function (u) { return u.outerHTML; }).join('');
        return box;
    }

    // ── Sheets (book edit, strategy view, filters) ─────────────────────────
    function openSheet(kind, node, id, title) {
        if (MAU.sheet || !node) return;
        var origin = { parent: node.parentNode, next: node.nextSibling };
        var sh = document.createElement('div');
        sh.className = 'mau-sheet mau-sheet-' + kind;
        sh.innerHTML = '<div class="mau-sheet-head"><button type="button" class="mau-back" aria-label="Back">‹</button>'
            + '<div class="mau-sheet-title">' + title + '</div>'
            + (kind === 'filter' ? '<button type="button" class="mau-btn mau-done">Done</button>' : '')
            + '</div><div class="mau-sheet-body"></div>';
        document.body.appendChild(sh);
        q('.mau-sheet-body', sh).appendChild(node);
        MAU.sheet = { kind: kind, node: node, id: id, origin: origin, el: sh };
        q('.mau-back', sh).addEventListener('click', backSheet);
        var done = q('.mau-done', sh);
        if (done) done.addEventListener('click', backSheet);
        if (kind === 'book') {
            var edit = q('.au-at2-bedit', node);
            if (edit) edit.click();                 // the desktop's own Edit: unlocks the same fields
            if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
            bookLayout(node);
        }
    }
    // Phone layout of the desktop book card (mock-up): Enabled as its own block with a switch,
    // the two sizing numbers side by side. Only the desktop's own fields are re-arranged inside the
    // card, so the desktop Save reads exactly what it always reads.
    function bookLayout(card) {
        var pills = q('.au-at2-pills[data-col="enabled"]', card);
        var field = pills && pills.closest('.au-at2-field');
        var idGroup = field && field.closest('.au-at2-group');
        if (field && idGroup) {
            var g = document.createElement('div');
            g.className = 'au-at2-group mau-group-enabled';
            g.innerHTML = '<div class="au-at2-group-label">Enabled</div>'
                + '<div class="mau-switchrow"><span class="mau-sw-label"></span>'
                + '<button type="button" class="mau-switch" role="switch" aria-label="Enabled switch"><span></span></button></div>';
            g.appendChild(field);
            idGroup.parentNode.insertBefore(g, idGroup.nextSibling);
            var sw = q('.mau-switchrow', g);
            var sync = function () {
                var on = !!q('.au-at2-pill.on[data-val="true"]', pills);
                sw.classList.toggle('on', on);
                q('.mau-sw-label', sw).textContent = on ? 'Enabled' : 'Disabled (paused)';
                q('.mau-switch', sw).setAttribute('aria-checked', on ? 'true' : 'false');
            };
            q('.mau-switch', sw).addEventListener('click', function () {
                var other = q('.au-at2-pill:not(.on)', pills);
                if (other) other.click();            // the desktop's own enabled / disabled control
                sync();
            });
            sync();
        }
        var ef = q('input[data-col="exposure_factor"]', card);
        var grid = ef && ef.closest('.au-at2-grid');
        if (grid) {
            grid.classList.add('mau-grid2');
            var note = document.createElement('div');
            note.className = 'mau-sizenote';
            note.textContent = '0.5 = half size. Lot cap = hard ceiling per signal.';
            grid.parentNode.appendChild(note);
        }
    }
    function closeSheet(restore) {
        var s = MAU.sheet;
        if (!s) return;
        MAU.sheet = null;
        if (restore && s.origin.parent && s.origin.parent.isConnected) {
            var next = (s.origin.next && s.origin.next.parentNode === s.origin.parent) ? s.origin.next : null;
            s.origin.parent.insertBefore(s.node, next);
        }
        s.el.remove();
        schedule();
    }
    function backSheet() {
        var s = MAU.sheet;
        if (!s) return;
        if (s.kind === 'book' && s.node.dataset.editing === 'yes') {
            var cancel = q('.au-at2-bcancel', s.node);
            if (cancel) { cancel.click(); return; }   // desktop Cancel re-draws from the saved values; the sheet then closes
        }
        closeSheet(true);
    }
    // After the desktop's Save (or Cancel, or a refresh) re-draws Controls, the card in the
    // sheet is stale: close the sheet and show the fresh list.
    function sheetDone() {
        var s = MAU.sheet;
        if (!s || s.kind !== 'book') return;
        var c = byId('au-at2-controls-content');
        if (c && q('.au-at2-strat[data-bid="' + s.id + '"]', c)) closeSheet(false);
    }

    // ── Render + wiring ────────────────────────────────────────────────────
    function render() {
        var panel = byId('au-fam-at2'), root = byId('mau-root');
        if (!panel || !root) return;
        sheetDone();
        if (!panel.classList.contains('active')) return;
        root.innerHTML = header() + (MAU.tab === 'controls' ? controls() : dashboard(MAU.tab)) + bnav();
    }
    function schedule() {
        if (MAU.timer) return;
        MAU.timer = setTimeout(function () { MAU.timer = null; render(); }, 40);
    }
    function onClick(e) {
        var t = e.target.closest('[data-mau-tab],[data-mau-act],[data-mau-book],[data-mau-strat]');
        if (!t) return;
        var c = byId('au-at2-controls-content');
        if (t.hasAttribute('data-mau-tab')) {
            MAU.tab = t.getAttribute('data-mau-tab');
            render();
            var root = byId('mau-root');
            if (root) root.scrollTop = 0;
        } else if (t.getAttribute('data-mau-act') === 'more') {
            MAU.allClosed[MAU.tab] = !MAU.allClosed[MAU.tab];
            render();
        } else if (t.getAttribute('data-mau-act') === 'leave') {
            document.body.classList.remove('mau-ms007');
        } else if (t.getAttribute('data-mau-act') === 'refresh') {
            if (typeof autoAt2Refresh === 'function') autoAt2Refresh();
        } else if (t.getAttribute('data-mau-act') === 'filters') {
            openSheet('filter', byId('au-at2-' + MAU.tab + '-filterbar'), null, 'Filters · closed trades');
        } else if (t.hasAttribute('data-mau-book')) {
            var bid = t.getAttribute('data-mau-book');
            var b = c && q('.au-at2-strat[data-bid="' + bid + '"]', c);
            if (b) openSheet('book', b, bid, 'Edit book · ' + esc(txt(q('.au-at2-name', b))));
        } else if (t.hasAttribute('data-mau-strat')) {
            var sid = t.getAttribute('data-mau-strat');
            var s = c && q('.au-at2-strat[data-sid="' + sid + '"]', c);
            if (s) {
                var warn = qa(':scope > .au-at2-strat-head .au-badge.warning', s).map(function (x) { return x.outerHTML; }).join(' ');
                var on = badges(s).indexOf('enabled') >= 0;
                openSheet('strat', stratView(s), sid, esc(txt(q('.au-at2-name', s)))
                    + ' <span class="mau-pill ' + (on ? 'mau-on' : 'mau-off') + '">' + (on ? 'ENABLED' : 'DISABLED') + '</span> '
                    + warn + '<div class="mau-sheet-sub">view only</div>');
            }
        }
    }

    // Auto Trading on the phone opens on a landing with one block per strategy that has a
    // phone design (MS007 only, for now). The desktop's strategy tabs are not shown on the phone.
    function landing() {
        var cont = q('.automation-container');
        if (!cont || q(':scope > .mau-landing', cont)) return;
        var l = document.createElement('div');
        l.className = 'mau-landing';
        l.innerHTML = '<div class="mh-wrap"><div class="mh-label">Auto Trading · strategies</div><div class="mh-grid">'
            + '<button type="button" class="mh-tile" data-mau-open="ms007"><span class="mh-ico">🧪</span>'
            + '<span class="mh-name">MS007</span><span class="mh-desc">Gold · Silver · live and paper</span></button>'
            + '</div></div>';
        var bar = q(':scope > .automation-header-bar', cont);
        cont.insertBefore(l, bar ? bar.nextSibling : cont.firstChild);
        l.addEventListener('click', function (e) {
            if (!e.target.closest('[data-mau-open="ms007"]')) return;
            document.body.classList.add('mau-ms007');
            if (typeof autoSwitchFamily === 'function') autoSwitchFamily('at2');
            schedule();
        });
    }

    // Attach to the MS007 panel once per mount (a forced module reload re-creates it).
    function attach() {
        landing();
        var panel = byId('au-fam-at2');
        var scroll = panel && q(':scope > .fam-scroll', panel);
        if (!panel || !scroll) return;
        if (!panel._mau) {
            panel._mau = true;
            var root = document.createElement('div');
            root.id = 'mau-root';
            root.className = 'mau-root';
            panel.appendChild(root);
            root.addEventListener('click', onClick);
            new MutationObserver(schedule).observe(scroll, { subtree: true, childList: true, characterData: true });
            new MutationObserver(schedule).observe(panel, { attributes: true, attributeFilter: ['class'] });
        }
        schedule();
    }

    var _origLoadModule = window.loadModule;
    if (typeof _origLoadModule === 'function') {
        window.loadModule = async function (moduleName) {
            if (moduleName === 'automation') document.body.classList.remove('mau-ms007');   // always open on the landing
            var r = await _origLoadModule.apply(this, arguments);
            attach();
            return r;
        };
    }
    attach();
})();
