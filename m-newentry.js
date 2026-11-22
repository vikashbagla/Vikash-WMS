// ============================================================================
// m-newentry.js — PHONE LAYER: New Entry (Add Transaction) as entry cards
// (Phone New Entry Plan v1, final 20-Nov-2026; WMS iPhone App Plan step 4.5)
// ----------------------------------------------------------------------------
// Loaded ONLY on phones (app.html WMS_PHONE gate). The desktop form, its maths, its checks and its
// save are untouched: this file only ADDS small things to each entry card that m-styles.css lays out:
//   • the card header side — "· BUY" (green) / "· SELL" (red) — read from the quantity's sign, exactly
//     as the desktop saves it (minus quantity = Sell). No Buy/Sell switch.
//   • ⧉ copy button next to 🗑 — copies the entry, same as Tab out of Tags on the desktop
//     (it calls the desktop's own addAddTxnRow(copyFrom)).
//   • grey details after the Symbol: company name for shares, expiry for F&O (display only).
//   • ⓘ on Charges — opens the same charges breakdown the desktop opens on double-click.
//   • "+ Add another entry" under the cards — a blank entry (the desktop's addAddTxnRow()).
// Everything is skipped while the full web app is showing (wide mode), so the desktop look never changes.
// ============================================================================
(function () {
    function phone() { return typeof wmsPhoneMode === 'function' ? wmsPhoneMode() : true; }
    function rowOf(rid) { return (typeof atRows !== 'undefined' && atRows) ? atRows.find(function (r) { return r.rowId === rid; }) : null; }
    function num(v) { var n = parseFloat(String(v || '').replace(/,/g, '')); return isNaN(n) ? 0 : n; }

    function fmtExpiry(d) {
        if (!d) return '';
        var p = String(d).slice(0, 10).split('-');
        if (p.length !== 3) return String(d);
        var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(p[1], 10) - 1] || p[1];
        return 'Exp ' + parseInt(p[2], 10) + '-' + m + '-' + p[0].slice(2);
    }

    function detailsFor(row, sec) {
        if (!row || !row.security_id) return '';
        if (row.lot_size > 1 || row.security_type === 'NFO') {
            var exp = sec && sec._displayExpiry;
            if (!exp) {
                var m = window.wmsRefData && wmsRefData.securitiesNfoMap;
                var rec = m && m[row.security_id];
                exp = rec && rec.expiry_date;
            }
            return fmtExpiry(exp);
        }
        var name = (sec && sec.company_name) || row.company_name || '';
        return name && name !== row.symbol ? name : '';
    }

    function setSide(tr) {
        var q = tr.querySelector('.addTxn-qty-input');
        var v = q ? num(q.value) : 0;
        if (v > 0) tr.setAttribute('data-m-side', 'BUY');
        else if (v < 0) tr.setAttribute('data-m-side', 'SELL');
        else tr.removeAttribute('data-m-side');
    }

    function setDetails(tr, sec) {
        var rid = Number(tr.dataset.rowId);
        var td = tr.querySelector('.addTxn-sym-input');
        td = td && td.closest('td');
        if (!td) return;
        var el = td.querySelector('.addTxn-m-symdet');
        if (!el) { el = document.createElement('span'); el.className = 'addTxn-m-symdet'; td.appendChild(el); }
        el.textContent = detailsFor(rowOf(rid), sec);
    }

    function enhance(tr) {
        if (tr.dataset.mDone) return;
        tr.dataset.mDone = '1';
        var rid = Number(tr.dataset.rowId);

        // ⧉ copy, placed before 🗑
        var delTd = tr.querySelector('.addTxn-del-cell');
        if (delTd && !delTd.querySelector('.addTxn-m-copy')) {
            var cp = document.createElement('button');
            cp.type = 'button'; cp.className = 'addTxn-m-copy'; cp.title = 'Copy this entry'; cp.textContent = '⧉';
            cp.addEventListener('click', function () {
                if (typeof addAddTxnRow !== 'function') return;
                var newId = addAddTxnRow(rid);
                setTimeout(function () {
                    var t = document.querySelector('#addTxnTbody tr[data-row-id="' + newId + '"]');
                    if (t && t.scrollIntoView) t.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                }, 60);
            });
            delTd.insertBefore(cp, delTd.firstChild);
        }

        // ⓘ on Charges → the desktop's own double-click breakdown
        var chg = tr.querySelector('.addTxn-totchg-input');
        if (chg && !chg.parentNode.querySelector('.addTxn-m-info')) {
            var info = document.createElement('button');
            info.type = 'button'; info.className = 'addTxn-m-info'; info.title = 'Charges breakdown'; info.textContent = 'ⓘ';
            info.addEventListener('click', function (e) {
                e.preventDefault(); e.stopPropagation();
                chg.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            });
            chg.parentNode.appendChild(info);
        }

        // BUY / SELL in the header follows the quantity
        var q = tr.querySelector('.addTxn-qty-input');
        if (q) { q.addEventListener('input', function () { setSide(tr); }); q.addEventListener('blur', function () { setSide(tr); }); }
        var lots = tr.querySelector('.addTxn-lots-input');
        if (lots) lots.addEventListener('input', function () { setTimeout(function () { setSide(tr); }, 0); });
        setSide(tr);
        setDetails(tr, null);
    }

    function ensureAddButton() {
        var tb = document.getElementById('addTxnTbody');
        if (!tb) return;
        var table = tb.closest('table');
        if (!table || document.getElementById('addTxnMAddRow')) return;
        var b = document.createElement('button');
        b.type = 'button'; b.id = 'addTxnMAddRow'; b.className = 'addTxn-m-addrow'; b.textContent = '+ Add another entry';
        b.addEventListener('click', function () {
            if (typeof addAddTxnRow !== 'function') return;
            var newId = addAddTxnRow();
            setTimeout(function () {
                var t = document.querySelector('#addTxnTbody tr[data-row-id="' + newId + '"]');
                if (t && t.scrollIntoView) t.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }, 60);
        });
        table.parentNode.insertBefore(b, table.nextSibling);
    }

    function refreshAll() {
        var tb = document.getElementById('addTxnTbody');
        if (!tb) return;
        var add = document.getElementById('addTxnMAddRow');
        if (!phone()) { if (add) add.style.display = 'none'; return; }
        ensureAddButton();
        add = document.getElementById('addTxnMAddRow');
        if (add) add.style.display = '';
        Array.prototype.forEach.call(tb.querySelectorAll('tr[data-row-id]'), enhance);
    }

    // Grey details refresh when a symbol is picked (wraps the desktop function; it still runs unchanged).
    function wrapSelect() {
        if (typeof window.selectAddTxnSecurity !== 'function' || window.selectAddTxnSecurity._mWrapped) return false;
        var orig = window.selectAddTxnSecurity;
        var wrapped = function (rowId, sec) {
            var r = orig.apply(this, arguments);
            try {
                var tr = document.querySelector('#addTxnTbody tr[data-row-id="' + rowId + '"]');
                if (tr) setDetails(tr, sec);
            } catch (e) {}
            return r;
        };
        wrapped._mWrapped = true;
        window.selectAddTxnSecurity = wrapped;
        return true;
    }

    // The New Entry form is loaded only when first opened, so wait for it (however late) without polling.
    var hooked = false;
    function hook() {
        var tb = document.getElementById('addTxnTbody');
        if (!tb || hooked) return !!tb;
        hooked = true;
        new MutationObserver(function () { wrapSelect(); refreshAll(); }).observe(tb, { childList: true });
        window.addEventListener('wms-mode-change', refreshAll);
        wrapSelect(); refreshAll();
        return true;
    }
    if (!hook()) {
        var bodyObs = new MutationObserver(function () { if (hook()) bodyObs.disconnect(); });
        bodyObs.observe(document.documentElement, { childList: true, subtree: true });
    }
})();
