// ============================================================================
// m-stmt.js — PHONE LAYER: Statements, read only (owner request 11-Nov-2026,
// "Phone Statements Plan" v2 approved the same day).
// ----------------------------------------------------------------------------
// Loaded ONLY on phones (app.html WMS_PHONE gate); desktop never downloads it.
//
// HOW IT STAYS IDENTICAL TO DESKTOP
// • Statements is its own block on the phone Home. Opening it loads the
//   desktop Trading module and its Statements tab exactly as the desktop does
//   (same data, same views, same calculations) — on the phone that page is
//   hidden and #mst-root shows what it has drawn, laid out for a small screen.
// • This file works out NO number. Cards, totals and rows are copied from the
//   desktop page; colours are the desktop's own.
// • View tabs, the period picker, the two display switches (Hide pre-recon,
//   Show F&O) and the expand rows (split groups, reconciled periods, starting
//   booked P&L) are the desktop's own controls: the phone forwards the tap.
// • Read only: no add / edit / delete / post interest / reconciliation review /
//   export. Trade rows are not tappable (on desktop a tap opens the edit window).
// • If a desktop table changes shape, the phone shows the desktop table with a
//   note — it never guesses (F.13).
// ============================================================================
(function () {
    var MST = { timer: null, sheet: null, showAll: false, open: { tx: true, bk: false, op: true } };

    function q(sel, root) { return (root || document).querySelector(sel); }
    function qa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
    function byId(id) { return document.getElementById(id); }
    function txt(el) { return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
    function inner(el) { return el ? el.innerHTML : ''; }
    function esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function shown(el) { return !!el && el.style.display !== 'none' && !el.hidden; }
    // A desktop cell without its action links / buttons (read only on the phone).
    function clean(td) {
        if (!td) return null;
        var c = td.cloneNode(true);
        qa('a, button, input, select, .lg-recon-trigger, .lg-recon-cancel', c).forEach(function (e) { e.remove(); });
        // Read only: no desktop click actions survive (e.g. the pending-interest amount opens the post window on desktop).
        [c].concat(qa('[onclick]', c)).forEach(function (e) { e.removeAttribute('onclick'); });
        qa('[style*="underline"], [style*="cursor"]', c).forEach(function (e) { e.style.textDecoration = 'none'; e.style.cursor = 'default'; });
        return c;
    }
    function cleanTxt(td) { return txt(clean(td)).replace(/🗑️?/g, '').trim(); }
    // The desktop value's own colour (red / green), so the phone colours exactly as desktop does.
    function colour(el) {
        try { return el ? window.getComputedStyle(el).color : ''; } catch (e) { return ''; }
    }
    function val(el) { return '<span style="color:' + colour(el) + '">' + inner(clean(el)) + '</span>'; }
    function fallback(el) {
        return '<div class="mau-note">Phone view could not read this table, so the desktop table is shown as is.</div>'
            + '<div class="mau-scrollx">' + inner(el) + '</div>';
    }

    // ── View tabs (first two in desktop order + the active one) ────────────
    function viewTabs() {
        var tabs = qa('#lgViewTabs .tr-view-tab');
        if (!tabs.length) return '';
        var html = tabs.map(function (t, i) {
            var on = t.classList.contains('active');
            if (i > 1 && !on) return '';
            var name = txt(t).replace(/✕/g, '').trim();
            return '<button type="button" class="mst-tab' + (on ? ' on' : '') + '" data-mst-view="' + i + '">' + esc(name) + '</button>';
        }).join('');
        var more = tabs.length > 2 ? '<button type="button" class="mau-chip mst-more" data-mst-act="views">▾ More</button>' : '';
        return '<div class="mst-tabs">' + html + more + '</div>';
    }

    function periodRow() {
        var df = byId('lgDateFilter');
        // The desktop picker has a range list (Today … All), an FY list and Custom: show what is set.
        var picked = df ? qa('select', df).filter(function (sl) { return sl.value && sl.value !== 'all'; })
            .map(function (sl) { return txt(sl.options[sl.selectedIndex]); }) : [];
        var custom = df && q('.wms-df-btn.active, .wms-df-btn.on', df);
        if (custom) picked.push(txt(custom));
        var label = picked.length ? picked.join(' · ') : 'All dates';
        var typeBtn = q('#lgStmtTypeToggle .active, #lgStmtTypeToggle .on', document);
        var type = typeBtn ? txt(typeBtn) + ' statement' : '';
        return '<div class="mst-per"><button type="button" class="mst-pchip" data-mst-act="period">' + esc(label) + ' ▾</button>'
            + '<span class="mst-type">' + esc(type) + '</span></div>';
    }

    // ── Summary cards ───────────────────────────────────────────────────────
    function card(label, valueEl, subHtml, cls) {
        return '<div class="mst-cd' + (cls ? ' ' + cls : '') + '"><div class="mst-cl">' + esc(label) + '</div>'
            + '<div class="mst-cv">' + (valueEl ? val(valueEl) : '—') + '</div>'
            + (subHtml ? '<div class="mst-cs">' + subHtml + '</div>' : '') + '</div>';
    }
    function cards() {
        var taxWrap = byId('lgCardPotentialTaxWrap');
        var parts = [
            card('Value of holdings', byId('lgCardHoldingsValue'), ''),
            card('Outstanding', byId('lgCardOutstanding'), inner(byId('lgCardOutstandingBreakdown')))
        ];
        if (shown(taxWrap)) parts.push(card(txt(byId('lgCardPotentialTaxLabel')) || 'Potential tax', byId('lgCardPotentialTax'), ''));
        parts.push(card(txt(byId('lgCardNetReceivableLabel')) || 'Net receivable', byId('lgCardNetReceivable'),
            inner(byId('lgCardBalNoMtmWrap')), 'net'));
        return '<div class="mst-cards">' + parts.join('') + '</div>';
    }

    function reconNote() {
        var b = byId('lgReconBanner');
        if (!b || b.classList.contains('lg-recon-banner-hidden') || !shown(b)) return '';
        return '<div class="mst-warn">⚠ ' + esc(txt(byId('lgReconBannerMsg'))) + '</div>';
    }

    // ── Blocks ──────────────────────────────────────────────────────────────
    function blockHead(key, title, right) {
        return '<button type="button" class="mst-bh" data-mst-blk="' + key + '"><span class="mst-car">' + (MST.open[key] ? '▾' : '▸') + '</span>'
            + '<span class="mst-bt">' + title + '</span><span class="mst-br">' + right + '</span></button>';
    }

    function txRows() {
        var table = byId('lgTable');
        if (!table) return '<div class="mau-empty">' + inner(byId('lgUnifiedScroll')) + '</div>';
        var heads = qa('#lgHead tr:last-child th', table).map(txt);
        if (heads.length !== 8 || heads[0].indexOf('Date') !== 0 || heads[7].indexOf('Balance') !== 0) return fallback(table.parentNode);
        var rows = qa('#lgBody > tr').filter(function (tr) {
            return tr.id !== 'lgNewEntryRow' && tr.id !== 'lgOpeningBalRow' && shown(tr);
        });
        var list = (MST.showAll || rows.length <= 5) ? rows : rows.slice(-5);
        var ob = byId('lgOpeningBalRow');
        var obHtml = '';
        if (shown(ob) && (MST.showAll || rows.length <= 5)) {
            obHtml = '<div class="mst-row mst-anchor"><div class="mst-r1"><span>' + esc(txt(byId('lgObSymbol')) || 'Opening balance') + '</span>'
                + '<span>' + val(byId('lgObBalance')) + '</span></div>'
                + '<div class="mst-r2"><span>' + esc(txt(byId('lgObDate'))) + ' ' + esc(txt(byId('lgObDescription'))) + '</span></div></div>';
        }
        var body = list.map(function (tr) {
            var td = qa(':scope > td', tr);
            if (td.length !== 8) return '<div class="mst-row"><div class="mst-r2"><span>' + esc(cleanTxt(tr)) + '</span></div></div>';
            var cls = tr.className || '';
            var tapIdx = (/lg-row-agg(?!-member)|lg-row-recon/.test(cls)) ? ' data-mst-tx="' + rows.indexOf(tr) + '"' : '';
            var rowCls = 'mst-row' + (/lg-row-nfo\b/.test(cls) ? ' mst-muted' : '') + (/lg-row-recon/.test(cls) ? ' mst-recon' : '')
                + (/lg-row-pending/.test(cls) ? ' mst-pending' : '') + (/lg-row-agg-member/.test(cls) ? ' mst-member' : '') + (tapIdx ? ' mst-tap' : '');
            var qty = cleanTxt(td[3]), px = cleanTxt(td[5]) || cleanTxt(td[4]);
            var line2 = [cleanTxt(td[0])];
            if (qty) line2.push(px ? qty + ' @ ' + px : qty);
            var typeCell = clean(td[2]);
            return '<div class="' + rowCls + '"' + tapIdx + '>'
                + '<div class="mst-r1"><span class="mst-sym">' + esc(cleanTxt(td[1])) + ' <span class="mst-type-b">' + (typeCell ? typeCell.innerHTML : '') + '</span></span>'
                + '<span class="mst-amt">' + val(td[6]) + '</span></div>'
                + '<div class="mst-r2"><span>' + esc(line2.join(' · ')) + '</span><span>Bal ' + val(td[7]) + '</span></div></div>';
        }).join('');
        var more = rows.length > 5 ? '<button type="button" class="mau-more" data-mst-act="all">'
            + (MST.showAll ? 'Show latest 5 only ▴' : 'Show all ' + rows.length + ' rows ▾') + '</button>' : '';
        var total = '<div class="mst-total"><span>' + esc(txt(byId('lgTotalsLabel'))) + '</span><span>' + val(byId('lgTotalBalance')) + '</span></div>';
        return '<div class="mau-list">' + obHtml + (body || '<div class="mst-row"><div class="mst-r2"><span>No transactions in this period.</span></div></div>') + total + '</div>' + more;
    }
    function switches() {
        var hp = byId('lgHidePreReconToggle'), fo = byId('lgFuturesToggle');
        var chip = function (el, id, label) {
            if (!el || !shown(el.closest('label') || el)) return '';
            return '<button type="button" class="mst-sw' + (el.checked ? ' on' : '') + '" data-mst-sw="' + id + '">' + (el.checked ? '✓ ' : '') + label + '</button>';
        };
        return '<div class="mst-sws">' + chip(hp, 'lgHidePreReconToggle', 'Hide pre-recon') + chip(fo, 'lgFuturesToggle', 'Show F&amp;O') + '</div>';
    }
    function txBlock() {
        var bal = txt(byId('lgTransactionsBalance'));
        return '<div class="mst-blk">' + blockHead('tx', 'Transactions', '')
            + (bal ? '<div class="mst-bsub">' + esc(bal) + '</div>' : '')
            + (MST.open.tx ? switches() + txRows() : '') + '</div>';
    }

    function bookedBlock() {
        var head = blockHead('bk', 'Booked P&amp;L <span class="mst-fy">' + esc(txt(byId('lgBookedFyLabel'))) + '</span>', val(byId('lgBookedTotal')));
        if (!MST.open.bk) return '<div class="mst-blk">' + head + '</div>';
        var rows = qa('#lgBookedBodyRows > tr').filter(shown);
        var body = rows.map(function (tr, i) {
            var td = qa(':scope > td', tr);
            var t = txt(tr);
            var tap = /^[▶▼▸▾]/.test(t) ? ' data-mst-bk="' + i + '"' : '';
            if (td.length < 4) {
                var last = td[td.length - 1];
                return '<div class="mst-row' + (tap ? ' mst-tap' : '') + '"' + tap + '><div class="mst-r1"><span>' + esc(cleanTxt(td[0])) + '</span>'
                    + '<span>' + (td.length > 1 ? val(last) : '') + '</span></div></div>';
            }
            return '<div class="mst-row' + (tap ? ' mst-tap' : '') + '"' + tap + '><div class="mst-r1"><span class="mst-sym">' + esc(cleanTxt(td[0]))
                + ' <span class="mst-type-b">' + esc(cleanTxt(td[1])) + '</span></span><span>' + val(td[3]) + '</span></div>'
                + '<div class="mst-r2"><span>Qty closed ' + esc(cleanTxt(td[2])) + '</span></div></div>';
        }).join('');
        return '<div class="mst-blk">' + head + '<div class="mau-list">' + (body || '<div class="mst-row"><div class="mst-r2"><span>Nothing booked in this period.</span></div></div>') + '</div></div>';
    }

    function openBlock() {
        var right = 'MTM ' + val(byId('lgSummaryMtmTotal')) + ' · Value ' + val(byId('lgSummaryValueTotal'));
        var head = blockHead('op', 'Open positions', right);
        if (!MST.open.op) return '<div class="mst-blk">' + head + '</div>';
        var rows = qa('#lgSummaryBody > tr').filter(shown);
        var body = rows.map(function (tr) {
            var td = qa(':scope > td', tr);
            if (td.length < 7) return '<div class="mst-row"><div class="mst-r2"><span>' + esc(cleanTxt(tr)) + '</span></div></div>';
            return '<div class="mst-row"><div class="mst-r1"><span class="mst-sym">' + esc(cleanTxt(td[0])) + ' <span class="mst-type-b">' + esc(cleanTxt(td[1])) + '</span></span>'
                + '<span>' + val(td[6]) + '</span></div>'
                + '<div class="mst-r2"><span>' + esc(cleanTxt(td[2])) + ' @ ' + esc(cleanTxt(td[3])) + ' · CMP ' + esc(cleanTxt(td[4])) + '</span>'
                + '<span>MTM ' + val(td[5]) + '</span></div></div>';
        }).join('');
        return '<div class="mst-blk">' + head + '<div class="mau-list">' + body + '</div></div>';
    }

    // ── Sheets: all views (More), period ───────────────────────────────────
    function closeSheet() {
        var s = MST.sheet;
        if (!s) return;
        MST.sheet = null;
        if (s.node && s.origin && s.origin.parent && s.origin.parent.isConnected) {
            var next = (s.origin.next && s.origin.next.parentNode === s.origin.parent) ? s.origin.next : null;
            s.origin.parent.insertBefore(s.node, next);
        }
        s.el.remove();
        schedule();
    }
    function openSheet(title, bodyHtml, node) {
        if (MST.sheet) return;
        var sh = document.createElement('div');
        sh.className = 'mau-sheet mst-sheet';
        sh.innerHTML = '<div class="mau-sheet-head"><button type="button" class="mau-back" aria-label="Back">‹</button>'
            + '<div class="mau-sheet-title">' + title + '</div><button type="button" class="mau-btn mst-done">Done</button></div>'
            + '<div class="mau-sheet-body">' + (bodyHtml || '') + '</div>';
        document.body.appendChild(sh);
        var origin = node ? { parent: node.parentNode, next: node.nextSibling } : null;
        if (node) q('.mau-sheet-body', sh).appendChild(node);
        MST.sheet = { el: sh, node: node, origin: origin };
        q('.mau-back', sh).addEventListener('click', closeSheet);
        q('.mst-done', sh).addEventListener('click', closeSheet);
        sh.addEventListener('click', function (e) {
            var b = e.target.closest('[data-mst-view]');
            if (!b) return;
            pickView(Number(b.getAttribute('data-mst-view')));
            closeSheet();
        });
    }
    function pickView(i) {
        var t = qa('#lgViewTabs .tr-view-tab')[i];
        if (t && !t.classList.contains('active')) { MST.showAll = false; t.click(); }   // the desktop's own view switch
    }

    // ── Render + wiring ─────────────────────────────────────────────────────
    function render() {
        var root = byId('mst-root');
        if (!root || !document.body.classList.contains('mst-on')) return;
        if (!byId('lgContainer')) { root.innerHTML = '<div class="mau-body"><div class="mau-empty">Loading statements…</div></div>'; return; }
        root.innerHTML = viewTabs() + periodRow()
            + '<div class="mau-body">' + cards() + reconNote() + txBlock() + bookedBlock() + openBlock() + '</div>';
    }
    function schedule() {
        if (MST.timer) return;
        MST.timer = setTimeout(function () { MST.timer = null; render(); }, 40);
    }
    function onClick(e) {
        var t = e.target.closest('[data-mst-view],[data-mst-act],[data-mst-blk],[data-mst-sw],[data-mst-tx],[data-mst-bk]');
        if (!t) return;
        if (t.hasAttribute('data-mst-view')) { pickView(Number(t.getAttribute('data-mst-view'))); return; }
        if (t.hasAttribute('data-mst-blk')) { var k = t.getAttribute('data-mst-blk'); MST.open[k] = !MST.open[k]; render(); return; }
        if (t.hasAttribute('data-mst-sw')) { var cb = byId(t.getAttribute('data-mst-sw')); if (cb) cb.click(); return; }   // desktop display switch
        if (t.hasAttribute('data-mst-tx')) {
            var rows = qa('#lgBody > tr').filter(function (tr) { return tr.id !== 'lgNewEntryRow' && tr.id !== 'lgOpeningBalRow' && shown(tr); });
            var r = rows[Number(t.getAttribute('data-mst-tx'))];
            if (r) r.click();   // expand / collapse a split group or reconciled period (desktop's own)
            return;
        }
        if (t.hasAttribute('data-mst-bk')) {
            var br = qa('#lgBookedBodyRows > tr').filter(shown)[Number(t.getAttribute('data-mst-bk'))];
            if (br) br.click();
            return;
        }
        var act = t.getAttribute('data-mst-act');
        if (act === 'all') { MST.showAll = !MST.showAll; render(); }
        else if (act === 'views') {
            var list = qa('#lgViewTabs .tr-view-tab').map(function (v, i) {
                return '<button type="button" class="mst-vrow' + (v.classList.contains('active') ? ' on' : '') + '" data-mst-view="' + i + '">'
                    + esc(txt(v).replace(/✕/g, '').trim()) + '</button>';
            }).join('');
            openSheet('Statements · views', '<div class="mau-list">' + list + '</div>');
        } else if (act === 'period') {
            openSheet('Period', '', byId('lgDateFilter'));
        }
    }

    function attach() {
        var host = byId('tr-ledger');
        if (!host) return false;
        var root = byId('mst-root');
        if (!root || root.parentNode !== host) {
            root = document.createElement('div');
            root.id = 'mst-root';
            host.appendChild(root);
            root.addEventListener('click', onClick);
        }
        var lc = byId('lgContainer');
        if (lc && !lc._mst) {
            lc._mst = true;
            new MutationObserver(schedule).observe(lc, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });
        }
        schedule();
        return !!lc;
    }

    // Open Statements from the phone Home (m-home.js hands over here).
    window.wmsPhoneOpenStatements = async function () {
        document.body.classList.add('mst-on');
        MST.showAll = false;
        await loadModule('trading');
        if (typeof trSwitchTab === 'function') trSwitchTab('tr-ledger');
        window.scrollTo(0, 0);
        var tries = 0;
        (function wait() {
            if (attach() || tries > 60) return;
            tries++;
            setTimeout(wait, 250);
        })();
    };
    window.wmsPhoneCloseStatements = function () {
        document.body.classList.remove('mst-on');
        closeSheet();
    };
})();
