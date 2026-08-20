// ============================================================================
// WMS ACCOUNTING MODULE — Phase 1
// Namespace: acct (DB acct_*, JS acct*, CSS acct-*). See WMS-LESSONS §A.6.1.
// Rule A.1.2: use `var` for all module-level state (avoid TDZ on script reload).
// Loaded on demand by app.html loadModule('accounting') → initAccounting().
// ============================================================================

// ---- State ----
var acctGroups = [];          // all acct_groups rows
var acctLedgers = [];         // all acct_ledgers rows
var acctVoucherRows = [];     // acct_voucher_full rows for the selected book
var acctBookId = null;        // selected book (investor id, accounting_enabled)
var acctActiveTab = 'balance-sheet';
var acctBookIds = null;       // consolidation VIEW set (null/[] = follow the single book select)
var acctGroupById = {};       // id -> group

// Voucher modal working state
var acctVoucherType = 'JOURNAL';
var acctVoucherDateYmd = null;
var acctVoucherLines = [];     // [{ ledgerId, debit, credit }]
var acctNewLedgerScope = 'global';
var acctEditingLedgerId = null;
var acctEditingGroupId = null;

// Modal controllers (wmsModal instances; rebuilt each module load)
var acctVoucherModalCtrl = null;
var acctLedgerModalCtrl = null;
var acctAddLedgerModalCtrl = null;
var acctAddGroupModalCtrl = null;
var acctReportModalCtrl = null;
var acctConsolidateModalCtrl = null;
var acctOpeningModalCtrl = null;

var acctNatureOrder = ['Assets', 'Liabilities', 'Income', 'Expenses', 'Capital'];

// ============================================================================
// Helpers
// ============================================================================
function acctUrl(path) { return SUPABASE_URL + '/rest/v1/' + path; }

function acctToast(msg, isError) {
    if (isError && typeof wmsShowError === 'function') { wmsShowError(msg); return; }
    if (typeof showAlert === 'function') { showAlert(msg); return; }
    console[isError ? 'error' : 'log']('[accounting] ' + msg);
}
function acctLoading(on) { if (typeof showLoading === 'function') showLoading(on); }

function acctTodayYmd() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// Plain rupee formatter for live voucher entry (actual amounts, no unit scaling).
function acctNum(n) {
    n = Number(n) || 0;
    var s = Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return n < 0 ? '(' + s + ')' : s;
}
function acctParse(v) {
    if (v === null || v === undefined) return 0;
    var n = parseFloat(String(v).replace(/,/g, ''));
    return isNaN(n) ? 0 : n;
}
// Module-wide "show full rupees" toggle (persistent). When on, every accounting view
// shows full amounts; when off, the app's display unit (₹ '000) applies. One switch
// for the whole module (owner request 2026-08-18).
var ACCT_FULLAMT_KEY = 'wms_acct_full_amount';
var acctFullAmt = false;
try { acctFullAmt = localStorage.getItem(ACCT_FULLAMT_KEY) === '1'; } catch (e) {}
function acctSetFullAmt(v) { acctFullAmt = !!v; try { localStorage.setItem(ACCT_FULLAMT_KEY, v ? '1' : '0'); } catch (e) {} }

// Display amount (used across BS / P&L / Trial Balance / Day Book / ledger drill-down).
// Honours the module-wide full-amount toggle; otherwise scales by the app display unit.
function acctAmt(n) {
    if (acctFullAmt) return acctNum(n);
    if (typeof formatAmount === 'function') return formatAmount(n);
    return acctNum(n);
}

function acctRootName(groupId) {
    var g = acctGroupById[groupId];
    var guard = 0;
    while (g && g.parent_group_id && guard++ < 20) g = acctGroupById[g.parent_group_id];
    return g ? g.name : '—';
}
function acctGroupPath(g) {
    if (!g) return '—';
    if (!g.parent_group_id) return g.name;
    return acctRootName(g.id) + ' ▸ ' + g.name;
}
function acctOwnBooks() {
    return (wmsRefData.investors || []).filter(function (i) { return i.accounting_enabled; });
}
// Books currently being VIEWED (consolidation set, else the single selected book).
function acctViewBookIds() {
    if (acctBookIds && acctBookIds.length) return acctBookIds;
    return acctBookId ? [acctBookId] : [];
}
function acctIsConsolidated() { return !!(acctBookIds && acctBookIds.length > 1); }

/* A cancelled voucher keeps its number and stays visible for audit, but must not
   affect a single balance. `is_cancelled` is undefined until migration 50 has
   been run, and !undefined === true, so this reads as "everything is live" on an
   un-migrated database — correct either way. */
function acctIsLive(r) { return !r.is_cancelled; }
function acctLiveRows() { return acctVoucherRows.filter(acctIsLive); }
function acctViewTitle() {
    if (acctIsConsolidated()) return 'Consolidated (' + acctBookIds.length + ' books)';
    var ids = acctViewBookIds();
    return ids.length ? acctInvName(ids[0]) : '—';
}
// ---- Book-tab preferences: order, hidden set, active book (all browser-persistent) ----
var ACCT_BOOK_ORDER_KEY = 'wms_acct_book_order';
var ACCT_BOOK_HIDDEN_KEY = 'wms_acct_books_hidden';
var ACCT_ACTIVE_BOOK_KEY = 'wms_acct_active_book';
var acctBookOrder = [];      // full ordering of book ids (visible + hidden)
var acctBooksHidden = [];    // ids the user has closed off the tab bar
function acctLoadBookPrefs() {
    try { var o = JSON.parse(localStorage.getItem(ACCT_BOOK_ORDER_KEY) || '[]'); acctBookOrder = Array.isArray(o) ? o : []; } catch (e) { acctBookOrder = []; }
    try { var h = JSON.parse(localStorage.getItem(ACCT_BOOK_HIDDEN_KEY) || '[]'); acctBooksHidden = Array.isArray(h) ? h : []; } catch (e) { acctBooksHidden = []; }
}
function acctSaveBookOrder() { try { localStorage.setItem(ACCT_BOOK_ORDER_KEY, JSON.stringify(acctBookOrder)); } catch (e) {} }
function acctSaveBooksHidden() { try { localStorage.setItem(ACCT_BOOK_HIDDEN_KEY, JSON.stringify(acctBooksHidden)); } catch (e) {} }
function acctSaveActiveBook() { try { localStorage.setItem(ACCT_ACTIVE_BOOK_KEY, acctBookId || ''); } catch (e) {} }
/** All own books in the saved order; unknown/new books appended in natural order. */
function acctOrderedBooks() {
    var books = acctOwnBooks();
    var byId = {}; books.forEach(function (b) { byId[b.id] = b; });
    var out = [];
    (acctBookOrder || []).forEach(function (id) { if (byId[id]) { out.push(byId[id]); delete byId[id]; } });
    books.forEach(function (b) { if (byId[b.id]) out.push(b); });
    // Normalise the stored order to the full current set (drops deleted books).
    acctBookOrder = out.map(function (b) { return b.id; });
    return out;
}
function acctVisibleBooks() { return acctOrderedBooks().filter(function (b) { return acctBooksHidden.indexOf(b.id) < 0; }); }

async function acctSwitchBook(id) {
    if (acctBookId === id && !acctIsConsolidated()) return;
    acctBookId = id;
    acctBookIds = null;                 // picking a single book clears consolidation
    acctSaveActiveBook();
    acctLoading(true);
    try {
        await acctLoadBook();
        acctRenderBookTabs();
        acctRenderActiveTab();
        acctSyncActionButtons();
    } finally { acctLoading(false); }
}
function acctHideBook(id) {
    if (acctBooksHidden.indexOf(id) < 0) acctBooksHidden.push(id);
    acctSaveBooksHidden();
    // If we just closed the active book, move to the first still-visible one.
    if (acctBookId === id) {
        var vis = acctVisibleBooks();
        if (vis.length) { acctSwitchBook(vis[0].id); return; }
    }
    acctRenderBookTabs();
}
function acctShowBook(id) {
    var ix = acctBooksHidden.indexOf(id);
    if (ix >= 0) acctBooksHidden.splice(ix, 1);
    acctSaveBooksHidden();
    acctSwitchBook(id);                 // re-opening a book also selects it
}
/** Move dragged book id to just before targetId in the full order, then persist. */
function acctReorderBook(dragId, targetId) {
    if (dragId === targetId) return;
    acctOrderedBooks();                 // ensure acctBookOrder is the full normalised set
    var from = acctBookOrder.indexOf(dragId);
    if (from < 0) return;
    acctBookOrder.splice(from, 1);
    var to = acctBookOrder.indexOf(targetId);
    if (to < 0) to = acctBookOrder.length;
    acctBookOrder.splice(to, 0, dragId);
    acctSaveBookOrder();
    acctRenderBookTabs();
}
/** Nudge a book one step up/down in the full order (used by the ＋ manager). */
function acctMoveBook(id, dir) {
    acctOrderedBooks();
    var ix = acctBookOrder.indexOf(id), j = ix + dir;
    if (ix < 0 || j < 0 || j >= acctBookOrder.length) return;
    var t = acctBookOrder[ix]; acctBookOrder[ix] = acctBookOrder[j]; acctBookOrder[j] = t;
    acctSaveBookOrder();
    acctRenderBookTabs();
}
/** Flip a book between open (visible) and closed, without forcing a switch. */
function acctToggleBookHidden(id) {
    var ix = acctBooksHidden.indexOf(id);
    if (ix >= 0) { acctBooksHidden.splice(ix, 1); acctSaveBooksHidden(); acctRenderBookTabs(); }
    else { acctHideBook(id); }           // hiding handles the active-book fallback
}
var acctBookMgrOpen = false;             // keep the ＋ manager open across its own re-renders

function acctRenderBookTabs() {
    var el = document.getElementById('acctBookTabs');
    if (!el) return;
    var books = acctOwnBooks();
    if (!books.length) {
        el.innerHTML = '<span class="acct-books-empty">No books yet — enable accounting on an investor in Master Data.</span>';
        acctBookId = null;
        return;
    }
    var visible = acctVisibleBooks();
    var hidden = acctOrderedBooks().filter(function (b) { return acctBooksHidden.indexOf(b.id) >= 0; });
    // Keep the active book valid and, if hidden/removed, fall back to a visible one.
    if (!acctBookId || !books.some(function (b) { return b.id === acctBookId; }) ||
        (visible.length && acctBooksHidden.indexOf(acctBookId) >= 0)) {
        acctBookId = (visible[0] || books[0]).id;
        acctSaveActiveBook();
    }
    var consol = acctIsConsolidated();
    var tabsHtml = visible.map(function (b) {
        var on = !consol && b.id === acctBookId;
        return '<span class="acct-book-tab' + (on ? ' active' : '') + '" draggable="true" data-book="' + b.id + '">' +
            '<span class="acct-book-lbl">' + wmsEsc(b.short_name || b.name) + '</span>' +
            '<span class="acct-book-x" title="Close this book tab">✕</span></span>';
    }).join('');
    // "＋" opens a book manager: every book in order, with ▲▼ reorder and Open/Close.
    var allBooks = acctOrderedBooks();
    var mgrRows = allBooks.map(function (b) {
        var isHidden = acctBooksHidden.indexOf(b.id) >= 0;
        return '<div class="acct-book-mgr-row' + (isHidden ? ' is-hidden' : '') + '" draggable="true" data-book="' + b.id + '">' +
            '<span class="acct-book-mgr-grip" title="Drag to reorder">⠿</span>' +
            '<span class="acct-book-mgr-name" data-book="' + b.id + '" title="Go to this book">' + wmsEsc(b.short_name || b.name) + '</span>' +
            '<button class="acct-book-mgr-toggle" data-book="' + b.id + '">' + (isHidden ? 'Open' : 'Close') + '</button>' +
        '</div>';
    }).join('');
    var addHtml = '<span class="acct-book-add-wrap">' +
        '<button class="acct-book-add" id="acctBookAddBtn" title="Manage books — reorder, open, close">+</button>' +
        '<div class="acct-book-add-dd' + (acctBookMgrOpen ? ' show' : '') + '" id="acctBookAddDd">' +
            '<div class="acct-book-mgr-hd">Books — drag a row (or a tab) to reorder</div>' +
            mgrRows +
        '</div></span>';
    el.innerHTML = tabsHtml + addHtml +
        '<span id="acctConsolidateChip" class="acct-consol-chip" style="display:none;margin-left:8px;"></span>';

    el.querySelectorAll('.acct-book-tab').forEach(function (t) {
        t.onclick = function () { acctSwitchBook(t.dataset.book); };
        var x = t.querySelector('.acct-book-x');
        if (x) x.onclick = function (e) { e.stopPropagation(); acctHideBook(t.dataset.book); };
        // Drag-to-reorder.
        t.addEventListener('dragstart', function (e) { t.classList.add('acct-dragging'); e.dataTransfer.setData('text/plain', t.dataset.book); e.dataTransfer.effectAllowed = 'move'; });
        t.addEventListener('dragend', function () { t.classList.remove('acct-dragging'); el.querySelectorAll('.acct-book-tab').forEach(function (x2) { x2.classList.remove('acct-drag-over'); }); });
        t.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; t.classList.add('acct-drag-over'); });
        t.addEventListener('dragleave', function () { t.classList.remove('acct-drag-over'); });
        t.addEventListener('drop', function (e) {
            e.preventDefault(); t.classList.remove('acct-drag-over');
            var dragId = e.dataTransfer.getData('text/plain');
            if (dragId) acctReorderBook(dragId, t.dataset.book);
        });
    });
    var addBtn = document.getElementById('acctBookAddBtn');
    var addDd = document.getElementById('acctBookAddDd');
    if (addBtn && addDd) {
        addBtn.onclick = function (e) { e.stopPropagation(); acctBookMgrOpen = !acctBookMgrOpen; addDd.classList.toggle('show', acctBookMgrOpen); };
        addDd.onclick = function (e) { e.stopPropagation(); };   // clicks inside stay open
        // Drag-to-reorder the manager rows (same persistence path as the tab drag).
        addDd.querySelectorAll('.acct-book-mgr-row').forEach(function (row) {
            row.addEventListener('dragstart', function (e) { row.classList.add('acct-dragging'); e.dataTransfer.setData('text/plain', row.dataset.book); e.dataTransfer.effectAllowed = 'move'; });
            row.addEventListener('dragend', function () { row.classList.remove('acct-dragging'); addDd.querySelectorAll('.acct-book-mgr-row').forEach(function (r) { r.classList.remove('acct-drag-over'); }); });
            row.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('acct-drag-over'); });
            row.addEventListener('dragleave', function () { row.classList.remove('acct-drag-over'); });
            row.addEventListener('drop', function (e) {
                e.preventDefault(); row.classList.remove('acct-drag-over');
                var dragId = e.dataTransfer.getData('text/plain');
                if (dragId) acctReorderBook(dragId, row.dataset.book);
            });
        });
        addDd.querySelectorAll('.acct-book-mgr-toggle').forEach(function (b) { b.onclick = function () { acctToggleBookHidden(b.dataset.book); }; });
        addDd.querySelectorAll('.acct-book-mgr-name').forEach(function (n) {
            n.onclick = function () { acctBookMgrOpen = false; acctShowBook(n.dataset.book); };
        });
    }
    acctSyncConsolChip();
}
// Close the "open a closed book" menu on any outside click. Guard against
// duplicate registration when the module script is re-executed (A.1.2a).
if (!window.__acctBookAddDismissWired) {
    window.__acctBookAddDismissWired = true;
    document.addEventListener('click', function (e) {
        var dd = document.getElementById('acctBookAddDd');
        if (dd && dd.classList.contains('show') && !e.target.closest('.acct-book-add-wrap')) {
            dd.classList.remove('show'); acctBookMgrOpen = false;
        }
    });
}

async function acctRefreshAll() {
    acctLoading(true);
    try { await acctLoadCatalogue(); await acctLoadBook(); acctRenderActiveTab(); }
    finally { acctLoading(false); }
}

function acctSyncConsolChip() {
    var chip = document.getElementById('acctConsolidateChip');
    if (!chip) return;
    if (acctIsConsolidated()) {
        chip.style.display = '';
        chip.innerHTML = 'Consolidated (' + acctBookIds.length + ') <span class="acct-consol-x" title="Clear">✕</span>';
        var x = chip.querySelector('.acct-consol-x');
        if (x) x.onclick = acctClearConsolidate;
    } else { chip.style.display = 'none'; chip.innerHTML = ''; }
}
function acctSyncActionButtons() {
    // Book-specific actions are meaningless across a consolidated view.
    var consol = acctIsConsolidated();
    var nv = document.getElementById('acctNewVoucherBtn');
    if (nv) nv.disabled = consol;
    var rb = document.getElementById('acctRebuildBtn');
    if (rb) rb.disabled = consol;                    // rebuild is per single book
    var dd = document.getElementById('acctMenuDd');
    if (dd) ['opening'].forEach(function (a) {
        var it = dd.querySelector('[data-act="' + a + '"]');
        if (it) it.classList.toggle('disabled', consol);
    });
}
function acctOpenConsolidate() {
    var sel = acctViewBookIds();
    var books = acctOwnBooks();
    var list = document.getElementById('acctConsolidateList');
    if (list) {
        list.innerHTML = books.map(function (b) {
            var on = sel.indexOf(b.id) >= 0;
            return '<label class="acct-consol-item"><input type="checkbox" class="acct-consol-cb" value="' + b.id + '"' + (on ? ' checked' : '') + '> ' + wmsEsc(b.short_name || b.name) + '</label>';
        }).join('');
    }
    var all = document.getElementById('acctConsolAll');
    if (all) {
        all.checked = books.length > 0 && sel.length === books.length;
        all.onclick = function () { document.querySelectorAll('.acct-consol-cb').forEach(function (c) { c.checked = all.checked; }); };
    }
    if (acctConsolidateModalCtrl) acctConsolidateModalCtrl.open();
}
async function acctApplyConsolidate() {
    var ids = [].slice.call(document.querySelectorAll('.acct-consol-cb:checked')).map(function (c) { return c.value; });
    if (acctConsolidateModalCtrl) acctConsolidateModalCtrl.close();
    if (ids.length <= 1) {
        acctBookIds = null;
        if (ids.length === 1) acctBookId = ids[0];
    } else {
        acctBookIds = ids;
    }
    acctLoading(true);
    try { await acctLoadBook(); acctRenderBookTabs(); acctRenderActiveTab(); acctSyncActionButtons(); }
    finally { acctLoading(false); }
}
async function acctClearConsolidate() {
    acctBookIds = null;
    if (acctConsolidateModalCtrl) acctConsolidateModalCtrl.close();
    acctLoading(true);
    try { await acctLoadBook(); acctRenderBookTabs(); acctRenderActiveTab(); acctSyncActionButtons(); }
    finally { acctLoading(false); }
}
function acctInvName(id) {
    var i = (wmsRefData.investors || []).find(function (x) { return x.id === id; });
    return i ? (i.short_name || i.name) : '—';
}
// Ledgers usable in a given book: global, or restricted to a set of books that
// includes this one. scope_investor_ids (migration 85, uuid[]) is the multi-book
// list; scope_investor_id (legacy single) is honoured too so the filter works
// both before and after the migration is applied.
function acctLedgerScopeIds(l) {
    if (l && Array.isArray(l.scope_investor_ids) && l.scope_investor_ids.length) return l.scope_investor_ids.slice();
    if (l && l.scope_investor_id) return [l.scope_investor_id];
    return [];
}
function acctLedgerInBook(l, bookId) {
    if (l.is_global) return true;
    return acctLedgerScopeIds(l).indexOf(bookId) >= 0;
}
function acctAvailableLedgers(bookId) {
    return acctLedgers.filter(function (l) {
        return l.is_active && acctLedgerInBook(l, bookId);
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
}

// ============================================================================
// Data loading
// ============================================================================
async function acctLoadCatalogue() {
    var groups = await wmsFetchAllRaw(acctUrl('acct_groups?select=*&order=name.asc'));
    var ledgers = await wmsFetchAllRaw(acctUrl('acct_ledgers?select=*&order=name.asc'));
    acctGroups = groups || [];
    acctLedgers = ledgers || [];
    acctGroupById = {};
    acctGroups.forEach(function (g) { acctGroupById[g.id] = g; });
}
async function acctLoadBook() {
    var ids = acctViewBookIds();
    if (!ids.length) { acctVoucherRows = []; return; }
    var filter = ids.length === 1 ? ('investor_id=eq.' + ids[0]) : ('investor_id=in.(' + ids.join(',') + ')');
    acctVoucherRows = await wmsFetchAllRaw(acctUrl(
        'acct_voucher_full?' + filter +
        '&order=voucher_date.asc,voucher_number.asc,sort_order.asc')) || [];
}

// ============================================================================
// Init
// ============================================================================
async function initAccounting() {
    acctLoading(true);
    try {
        acctLoadCollapseState();          // restore expand/collapse layout from last session
        acctLoadBookPrefs();              // restore book order + which books are closed
        try { var ab = localStorage.getItem(ACCT_ACTIVE_BOOK_KEY); if (ab) acctBookId = ab; } catch (e) {}
        await acctLoadCatalogue();

        acctRenderBookTabs();

        await acctLoadBook();
        acctWireUI();
        acctRenderActiveTab();
        acctSyncConsolChip();
        acctSyncActionButtons();
    } catch (e) {
        console.error('[accounting] init error', e);
        acctToast('Failed to load Accounting: ' + e.message, true);
    } finally {
        acctLoading(false);
    }
}

function acctWireUI() {

    // Tabs
    document.querySelectorAll('.acct-tab').forEach(function (t) {
        t.onclick = function () {
            acctActiveTab = t.dataset.acctTab;
            document.querySelectorAll('.acct-tab').forEach(function (x) { x.classList.toggle('active', x === t); });
            document.querySelectorAll('.acct-tabpanel').forEach(function (p) {
                p.classList.toggle('active', p.id === 'acctPanel-' + acctActiveTab);
            });
            acctRenderActiveTab();
        };
    });

    // Module-wide full-amount toggle (header). Applies to every accounting view.
    var unitBtn = document.getElementById('acctUnitToggle');
    if (unitBtn) unitBtn.onclick = function () {
        acctSetFullAmt(!acctFullAmt);
        acctRenderActiveTab();
        acctSyncUnitToggle();
        if (acctLedgerModalCtrl && acctLedgerModalCtrl.isOpen()) acctRenderLedgerDetail();
    };

    // Primary actions stay inline; everything else lives behind the ⋮ menu.
    var nv = document.getElementById('acctNewVoucherBtn');
    if (nv) nv.onclick = acctOpenVoucherModal;
    var rb = document.getElementById('acctRebuildBtn');
    if (rb) rb.onclick = acctRebuildBooks;

    var mb = document.getElementById('acctMenuBtn');
    var mdd = document.getElementById('acctMenuDd');
    if (mb && mdd) {
        mb.onclick = function (e) {
            e.stopPropagation();
            var open = mdd.classList.contains('show');
            acctSyncActionButtons();
            mdd.classList.toggle('show', !open);
        };
        mdd.addEventListener('mousedown', function (e) {
            var it = e.target.closest ? e.target.closest('.wms-dd-item') : null;
            if (!it || it.classList.contains('disabled')) return;
            e.preventDefault();
            mdd.classList.remove('show');
            var act = it.dataset.act;
            if (act === 'opening') acctOpenOpeningModal();
            else if (act === 'consolidate') acctOpenConsolidate();
            else if (act === 'rebuildAll') acctRebuildAll();
            else if (act === 'refresh') acctRefreshAll();
        });
        document.addEventListener('mousedown', function (e) {
            if (mdd.classList.contains('show') && !mdd.contains(e.target) && e.target !== mb) mdd.classList.remove('show');
        });
    }

    acctWireModals();
}

// ============================================================================
// Rendering — tabs
// ============================================================================
function acctRenderActiveTab() {
    if (acctActiveTab === 'balance-sheet') acctRenderFinancials();
    else if (acctActiveTab === 'profit-loss') acctRenderPL();
    else if (acctActiveTab === 'trial-balance') acctRenderTrialBalance();
    else if (acctActiveTab === 'day-book') acctRenderDayBook();
    else if (acctActiveTab === 'ledgers') acctRenderLedgers();
    acctSyncUnitToggle();   // keep the header full-amount toggle visible + labelled on every tab
}

// ---- Financials: Balance Sheet + P&L ---------------------------------------
function acctComputeBalances() {
    var net = {};
    acctVoucherRows.forEach(function (r) {
        if (!acctIsLive(r)) return;
        net[r.ledger_id] = (net[r.ledger_id] || 0) + (Number(r.debit_amount) || 0) - (Number(r.credit_amount) || 0);
    });
    return net;
}
// ── MProfit-style two-column T-format Balance Sheet (Liabilities | Assets) ───
// Collapsible group->ledger tree; P&L embedded under Liabilities (Profit & Loss
// -> Income / Expenses); balanced Total. Models MProfit's accounting view.
var acctFinCollapsed = {};   // nodeKey -> true (default expanded)
// Ledgers catalogue keeps its OWN collapse state - deliberately NOT acctFinCollapsed.
// Both would key groups by the same ids, so sharing means collapsing a group in the
// catalogue silently collapses it on the Balance Sheet. null = not yet initialised;
// first render seeds every group collapsed per UI-STANDARDS D.2.2.
var acctLedCollapsed = null;
var acctLedSearch = '';
var ACCT_SHOWZERO_KEY = 'wms_acct_show_zero';
var acctFinShowZero = false;
try { acctFinShowZero = localStorage.getItem(ACCT_SHOWZERO_KEY) === '1'; } catch (e) {}
function acctSetShowZero(v) { acctFinShowZero = !!v; try { localStorage.setItem(ACCT_SHOWZERO_KEY, v ? '1' : '0'); } catch (e) {} }

// The single command line hosts the active tab's filters. Each render function
// calls acctSetCmdFilters(...) so the controls always match the tab on screen;
// Day Book (no filters) clears it.
function acctSetCmdFilters(html) {
    var el = document.getElementById('acctCmdFilters');
    if (el) el.innerHTML = html || '';
}

// ---- Day Book filters: full-amount + show-cancelled (persistent) + live search ----
var ACCT_DB_CANCELLED_KEY = 'wms_acct_daybook_show_cancelled';
var acctDayBookShowCancelled = false;
try { acctDayBookShowCancelled = localStorage.getItem(ACCT_DB_CANCELLED_KEY) === '1'; } catch (e) {}
function acctSetDayBookCancelled(v) { acctDayBookShowCancelled = !!v; try { localStorage.setItem(ACCT_DB_CANCELLED_KEY, v ? '1' : '0'); } catch (e) {} }
var acctDayBookSearch = '';       // live search (not persisted)

// Persist the expand/collapse state across sessions (localStorage — this is the
// real app, not a sandboxed artifact). Keyed by group id, which is stable, so the
// same layout restores next time. Corrupt/absent state falls back to the defaults.
var ACCT_FIN_COLLAPSE_KEY = 'wms_acct_fin_collapsed';
var ACCT_LED_COLLAPSE_KEY = 'wms_acct_led_collapsed';
function acctLoadCollapseState() {
    try {
        var f = localStorage.getItem(ACCT_FIN_COLLAPSE_KEY);
        if (f) { var pf = JSON.parse(f); if (pf && typeof pf === 'object') acctFinCollapsed = pf; }
        var l = localStorage.getItem(ACCT_LED_COLLAPSE_KEY);
        if (l) { var pl = JSON.parse(l); if (pl && typeof pl === 'object') acctLedCollapsed = pl; }
    } catch (e) { /* ignore corrupt persisted state */ }
}
function acctSaveFinCollapse() { try { localStorage.setItem(ACCT_FIN_COLLAPSE_KEY, JSON.stringify(acctFinCollapsed || {})); } catch (e) {} }
function acctSaveLedCollapse() { try { localStorage.setItem(ACCT_LED_COLLAPSE_KEY, JSON.stringify(acctLedCollapsed || {})); } catch (e) {} }
var acctFinActive = {};          // ledgerId -> true when it posted in the period

function acctLedgerDisp(net, lg, negate) {
    var nature = acctRootName(lg.group_id);
    var crNormal = (nature === 'Liabilities' || nature === 'Income' || nature === 'Capital');
    var base = crNormal ? -(net[lg.id] || 0) : (net[lg.id] || 0);
    return negate ? -base : base;
}
// Build a node tree (child groups -> ledgers) under a root nature.
function acctSideTree(net, rootName, negate) {
    var root = acctGroups.find(function (g) { return !g.parent_group_id && g.name === rootName; });
    if (!root) return { nodes: [], total: 0 };
    var nodes = [];
    function ledgerNode(lg) {
        var amt = acctLedgerDisp(net, lg, negate);
        if (Math.round(amt * 100) === 0) {
            // Zero balance: only surface it if it actually moved this period AND
            // the user asked to see zero values.
            if (!acctFinShowZero) return null;
            if (!acctFinActive[lg.id]) return null;
        }
        return { key: 'l:' + lg.id, label: lg.name, amount: amt, isLedger: true, ledgerId: lg.id };
    }
    // Recurse the group tree to arbitrary depth (chart now has 3 levels:
    // root → group → sub-group → ledger). Render (acctFinNodeHtml) already recurses.
    function buildGroup(groupId) {
        var out = [];
        acctLedgers.filter(function (l) { return l.group_id === groupId; })
            .sort(function (a, b) { return a.name.localeCompare(b.name); })
            .forEach(function (l) { var n = ledgerNode(l); if (n) out.push(n); });
        acctGroups.filter(function (g) { return g.parent_group_id === groupId; })
            .sort(function (a, b) { return a.name.localeCompare(b.name); })
            .forEach(function (cg) {
                var children = buildGroup(cg.id);
                if (!children.length && !acctFinShowZero) return;
                var total = children.reduce(function (a, n) { return a + n.amount; }, 0);
                out.push({ key: 'g:' + cg.id, label: cg.name, amount: total, children: children });
            });
        return out;
    }
    nodes = buildGroup(root.id);
    return { nodes: nodes, total: nodes.reduce(function (a, n) { return a + n.amount; }, 0) };
}
function acctFinNodeHtml(node, depth) {
    var pad = 12 + depth * 18;
    var isGroup = !node.isLedger && !node.isDiff;
    var collapsed = isGroup && acctFinCollapsed[node.key];
    var icon = isGroup
        ? '<span class="acct-fin-toggle' + (collapsed ? ' collapsed' : '') + '">▼</span>'
        : '<span class="acct-fin-toggle-sp"></span>';
    // Suspense/difference rows are an alert — always red (the BS plug is isDiff;
    // the "Difference in Opening Balance" ledger and any Suspense group match by name).
    var suspicious = /^\s*difference\b|suspense/i.test(node.label || '');
    var cls = node.isDiff ? 'acct-fin-row acct-fin-diff'
        : ('acct-fin-row ' + (isGroup ? 'acct-fin-group' : 'acct-fin-ledger acct-clickable') + (suspicious ? ' acct-fin-susp' : ''));
    var attr = node.isDiff ? '' : (isGroup ? ('data-node="' + node.key + '"') : ('data-ledger="' + node.ledgerId + '"'));
    // Which amount column the figure belongs in: ledger detail innermost,
    // intermediate group subtotals next, section (depth-0) totals outermost.
    var col = node.isLedger ? 1 : (depth === 0 || node.isDiff ? 3 : 2);
    var amt = acctAmt(node.amount);
    var h = '<div class="' + cls + '" ' + attr + ' style="padding-left:' + pad + 'px;">' +
        icon + '<span class="acct-fin-name">' + wmsEsc(node.label) + '</span>' +
        '<span class="acct-fin-amt">'  + (col === 1 ? amt : '') + '</span>' +
        '<span class="acct-fin-amt2">' + (col === 2 ? amt : '') + '</span>' +
        '<span class="acct-fin-amt3">' + (col === 3 ? amt : '') + '</span></div>';
    if (isGroup && node.children && !collapsed) {
        node.children.forEach(function (c) { h += acctFinNodeHtml(c, depth + 1); });
    }
    return h;
}
/* One context line for the whole module (top-right of the books strip): the
   period and the display unit apply to every view, so they are stated once. */
function acctRenderContext() {
    var el = document.getElementById('acctContextInfo');
    acctSyncUnitToggle();
    if (!el) return;
    if (!acctViewBookIds().length || !acctVoucherRows.length) { el.textContent = ''; return; }
    var unit = acctUnitLabel();
    // Statement period is the whole financial year (01-Apr to 31-Mar); the last posted
    // entry date is shown alongside it.
    el.textContent = acctFmtDate(acctTbPeriodStart()) + ' to ' + acctFmtDate(acctFyEnd()) +
        '  ·  Last entry ' + acctFinAsOn() + (unit ? '  ·  ' + unit : '');
}
// FY end (31-Mar of the next calendar year) for the active book, from the FY start.
function acctFyEnd() {
    var p = acctTbPeriodStart().split('-');
    var d = new Date(Number(p[0]) + 1, Number(p[1]) - 1, 1); d.setDate(d.getDate() - 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// Keep the header full-amount toggle in sync; only visible with a book loaded.
function acctSyncUnitToggle() {
    // Full rupees are much wider than ₹ '000; widen the fixed amount columns via a
    // container class so figures don't overflow their boxes and misalign.
    var cont = document.querySelector('.acct-container');
    if (cont) cont.classList.toggle('acct-fullamt', acctFullAmt);
    var btn = document.getElementById('acctUnitToggle');
    if (!btn) return;
    btn.style.display = (acctViewBookIds().length && acctVoucherRows.length) ? '' : 'none';
    var base = (typeof getUnitDescription === 'function' ? getUnitDescription() : "₹ '000");
    btn.textContent = acctFullAmt ? ('Show in ' + base) : 'Show full amount';
}

function acctUnitLabel() {
    if (acctFullAmt) return 'Full ₹';
    // The whole app scales amounts by the user's display-unit preference; say so,
    // otherwise a figure in '000 is indistinguishable from one in rupees.
    try { if (typeof getUnitDescription === 'function') return getUnitDescription(); } catch (e) {}
    try { if (typeof getUnitLabel === 'function') return '\u20B9 ' + getUnitLabel(); } catch (e) {}
    return '';
}
function acctFinColumnHtml(title, asOn, nodes, total, flag) {
    var h = '<div class="acct-fin-col"><div class="acct-fin-hdr"><span>' + wmsEsc(title) + '</span>' +
        '<span>Bal. as on ' + wmsEsc(asOn) + '</span></div>';
    nodes.forEach(function (n) { h += acctFinNodeHtml(n, 0); });
    h += '<div class="acct-fin-coltotal"><span class="acct-fin-name">Total' + (flag || '') + '</span>' +
        '<span class="acct-fin-amt"></span><span class="acct-fin-amt2"></span>' +
        '<span class="acct-fin-amt3">' + acctAmt(total) + '</span></div>';
    return h + '</div>';
}
function acctFinAllGroupKeys(nodes, acc) {
    nodes.forEach(function (n) { if (!n.isLedger) { acc.push(n.key); if (n.children) acctFinAllGroupKeys(n.children, acc); } });
    return acc;
}
// ── Sticky, aligned two-column statement (BS + P&L) ──────────────────────────
// A pinned header bar, ONE scroll region holding both columns, and a pinned total
// bar so the two totals sit on the SAME row and never scroll out of view. The
// scroll area flexes to the panel height, so it adapts to the screen size.
function acctFinHeadCell(title, asOn) {
    return '<div class="acct-fin-headcell"><span>' + wmsEsc(title) + '</span>' +
        '<span>Bal. as on ' + wmsEsc(asOn) + '</span></div>';
}
function acctFinColRows(nodes) {
    var h = '<div class="acct-fin-col">';
    nodes.forEach(function (n) { h += acctFinNodeHtml(n, 0); });
    return h + '</div>';
}
function acctFinTotalCell(total, flag) {
    return '<div class="acct-fin-totalcell"><span class="acct-fin-name">Total' + (flag || '') + '</span>' +
        '<span class="acct-fin-amt"></span><span class="acct-fin-amt2"></span>' +
        '<span class="acct-fin-amt3">' + acctAmt(total) + '</span></div>';
}
function acctFinStatementHtml(leftTitle, rightTitle, asOn, leftNodes, leftTotal, rightNodes, rightTotal, flag) {
    return '<div class="acct-fin-statement">' +
        '<div class="acct-fin-headbar">' + acctFinHeadCell(leftTitle, asOn) + acctFinHeadCell(rightTitle, asOn) + '</div>' +
        '<div class="acct-fin-scrollarea"><div class="acct-fin-cols">' +
            acctFinColRows(leftNodes) + acctFinColRows(rightNodes) + '</div></div>' +
        '<div class="acct-fin-totalbar">' + acctFinTotalCell(leftTotal, flag) + acctFinTotalCell(rightTotal, flag) + '</div>' +
        '</div>';
}
function acctFinAsOn() {
    var max = '';
    acctVoucherRows.forEach(function (r) { if (acctIsLive(r) && r.voucher_date > max) max = r.voucher_date; });
    return acctFmtDate(max || acctTodayYmd());
}
function acctRenderFinancials() {
    var el = document.getElementById('acctFinancialsBody');
    if (!el) return;
    acctSetCmdFilters('');
    if (!acctViewBookIds().length) { el.innerHTML = '<div class="acct-empty">No book selected. Enable accounting on an investor first.</div>'; return; }
    if (!acctVoucherRows.length) {
        el.innerHTML = '<div class="acct-empty">No postings yet for ' + wmsEsc(acctViewTitle()) + '. Use ↻ Rebuild from trades or ➕ New Voucher.</div>';
        return;
    }
    var net = acctComputeBalances();
    var asOn = acctFinAsOn();
    acctFinActive = acctActiveLedgerIds(acctTbPeriodStart());
    acctRenderContext();

    // Liabilities side = Capital + Profit & Loss (embedded) + Liabilities
    var cap = acctSideTree(net, 'Capital', false);
    var inc = acctSideTree(net, 'Income', false);
    var exp = acctSideTree(net, 'Expenses', true);   // negated so expenses reduce P&L
    var plNet = inc.total + exp.total;
    var plNode = { key: 'pl', label: 'Profit & Loss', amount: plNet, children: [
        { key: 'pl-inc', label: 'Income', amount: inc.total, children: inc.nodes },
        { key: 'pl-exp', label: 'Expenses', amount: exp.total, children: exp.nodes }
    ] };
    var liab = acctSideTree(net, 'Liabilities', false);
    // Wrap the Capital root's contents under a synthetic "Capital" header so the
    // Liabilities column mirrors the Assets side (root name shows as a group row,
    // its ledgers nest one level in). Hidden when empty unless Show-zero is on.
    var capNode = { key: 'cap', label: 'Capital', amount: cap.total, children: cap.nodes };
    var leftNodes = ((cap.nodes.length || acctFinShowZero) ? [capNode] : [])
        .concat([plNode]).concat(liab.nodes);
    var leftTotal = cap.total + plNet + liab.total;

    var assets = acctSideTree(net, 'Assets', false);

    // A balance sheet must always present matched — surface any residual as a
    // "Difference in Balance Sheet" row on the short side (standard Tally/MProfit
    // suspense line). With a clean double-entry trial balance this is 0.
    var diff = Math.round((assets.total - leftTotal) * 100) / 100;
    if (Math.abs(diff) >= 0.005) {
        var dnode = { label: 'Difference in Balance Sheet', amount: Math.abs(diff), isDiff: true };
        if (diff > 0) { leftNodes.unshift(dnode); leftTotal = Math.round((leftTotal + diff) * 100) / 100; }
        else { assets.nodes.unshift(dnode); assets.total = Math.round((assets.total - diff) * 100) / 100; }
    }
    var balanced = Math.round(leftTotal * 100) === Math.round(assets.total * 100);

    acctSetCmdFilters(
        acctExpandCtrlHtml('acctFin') +
        '<label class="acct-fin-zero"><input type="checkbox" id="acctFinShowZeroChk"' + (acctFinShowZero ? ' checked' : '') + '> Show zero</label>');
    var flag = balanced ? '' : ' ⚠ out of balance';
    el.innerHTML = acctFinStatementHtml('Liabilities', 'Assets', asOn, leftNodes, leftTotal, assets.nodes, assets.total, flag);

    el.querySelectorAll('.acct-fin-group[data-node]').forEach(function (r) {
        r.onclick = function () { acctFinCollapsed[r.dataset.node] = !acctFinCollapsed[r.dataset.node]; acctRenderFinancials(); };
    });
    el.querySelectorAll('.acct-fin-ledger[data-ledger]').forEach(function (r) {
        r.onclick = function () { acctOpenLedgerDetail(r.dataset.ledger); };
    });
    acctWireExpandCtrl('acctFin', function () { return acctFinAllGroupKeys(leftNodes.concat(assets.nodes), []); }, 'fin', acctRenderFinancials);
    var sz = document.getElementById('acctFinShowZeroChk');
    if (sz) sz.onchange = function () { acctSetShowZero(sz.checked); acctRenderFinancials(); };
    acctSaveFinCollapse();
}

// ── Profit & Loss — T-format (Expenses | Income), same style as the BS ───────
function acctRenderPL() {
    var el = document.getElementById('acctPLBody');
    if (!el) return;
    acctSetCmdFilters('');
    if (!acctViewBookIds().length) { el.innerHTML = '<div class="acct-empty">No book selected. Enable accounting on an investor first.</div>'; return; }
    if (!acctVoucherRows.length) { el.innerHTML = '<div class="acct-empty">No postings yet for ' + wmsEsc(acctViewTitle()) + '.</div>'; return; }
    var net = acctComputeBalances();
    var asOn = acctFinAsOn();
    acctFinActive = acctActiveLedgerIds(acctTbPeriodStart());
    acctRenderContext();
    var inc = acctSideTree(net, 'Income', false);     // income positive
    var exp = acctSideTree(net, 'Expenses', false);   // expense positive
    var netProfit = inc.total - exp.total;
    var leftNodes = exp.nodes.slice(), leftTotal = exp.total;
    var rightNodes = inc.nodes.slice(), rightTotal = inc.total;
    if (netProfit >= 0) { leftNodes.push({ label: 'Net Profit', amount: netProfit, isDiff: true }); leftTotal += netProfit; }
    else { rightNodes.push({ label: 'Net Loss', amount: -netProfit, isDiff: true }); rightTotal += -netProfit; }

    acctSetCmdFilters(
        acctExpandCtrlHtml('acctPL') +
        '<label class="acct-fin-zero"><input type="checkbox" id="acctPLShowZeroChk"' + (acctFinShowZero ? ' checked' : '') + '> Show zero</label>');
    el.innerHTML = acctFinStatementHtml('Expenses', 'Income', asOn, leftNodes, leftTotal, rightNodes, rightTotal, '');

    el.querySelectorAll('.acct-fin-group[data-node]').forEach(function (r) {
        r.onclick = function () { acctFinCollapsed[r.dataset.node] = !acctFinCollapsed[r.dataset.node]; acctRenderPL(); };
    });
    el.querySelectorAll('.acct-fin-ledger[data-ledger]').forEach(function (r) {
        r.onclick = function () { acctOpenLedgerDetail(r.dataset.ledger); };
    });
    acctWireExpandCtrl('acctPL', function () { return acctFinAllGroupKeys(leftNodes.concat(rightNodes), []); }, 'fin', acctRenderPL);
    var sz = document.getElementById('acctPLShowZeroChk'); if (sz) sz.onchange = function () { acctSetShowZero(sz.checked); acctRenderPL(); };
    acctSaveFinCollapse();
}

// ── Trial Balance — grouped collapsible tree with Debit/Credit columns ───────
/* ── Trial Balance — conventional format ───────────────────────────────────────
   Opening balance | period Debit | period Credit | Closing balance.

   Opening = the OPENING_BALANCE voucher plus anything dated before the period
   start; movements = everything else in the period. Closing = opening + Dr - Cr.
   Opening and closing are shown signed (debit positive, credit in brackets) so
   each is one column rather than two; the period Dr/Cr stay separate because
   that is the pair that must agree. */

function acctTbPeriodStart() {
    // FY containing the latest posting, per the book's financial_year_start month.
    var ids = acctViewBookIds();
    var inv = (wmsRefData.investors || []).find(function (i) { return i.id === ids[0]; }) || {};
    var m = Number(inv.financial_year_start) || 4;
    var maxD = '';
    acctVoucherRows.forEach(function (r) { if (acctIsLive(r) && r.voucher_date > maxD) maxD = r.voucher_date; });
    var ref = maxD ? new Date(maxD + 'T00:00:00') : new Date();
    var y = (ref.getMonth() + 1) >= m ? ref.getFullYear() : ref.getFullYear() - 1;
    return y + '-' + String(m).padStart(2, '0') + '-01';
}

/* "Show zero values" must mean "ledgers that MOVED in the period but net to
   zero" — not "every ledger in the catalogue". A ledger with no postings at all
   has no place on a statement, checkbox or not. */
function acctActiveLedgerIds(sinceYmd) {
    var set = {};
    acctVoucherRows.forEach(function (r) {
        if (!r.ledger_id || !acctIsLive(r)) return;
        if (sinceYmd && r.voucher_type !== 'OPENING_BALANCE' && r.voucher_date < sinceYmd) return;
        set[r.ledger_id] = true;
    });
    return set;
}

function acctTbAggregate(fyStart) {
    var agg = {};
    acctVoucherRows.forEach(function (r) {
        if (!r.ledger_id || !acctIsLive(r)) return;
        var a = agg[r.ledger_id] || (agg[r.ledger_id] = { open: 0, dr: 0, cr: 0 });
        var d = Number(r.debit_amount) || 0, c = Number(r.credit_amount) || 0;
        if (r.voucher_type === 'OPENING_BALANCE' || r.voucher_date < fyStart) a.open += d - c;
        else { a.dr += d; a.cr += c; }
    });
    return agg;
}

/* Balances are split into Dr/Cr at LEDGER level and the split is what
   aggregates upward. Splitting a group's net instead would make the Dr and Cr
   totals collapse toward zero and stop being the pair that proves the books
   balance. */
function acctTbSplit(net) {
    return { dr: net > 0 ? net : 0, cr: net < 0 ? -net : 0 };
}

function acctTbBuild(agg, active) {
    var nodes = [];
    function zero() { return { oDr: 0, oCr: 0, pDr: 0, pCr: 0, cDr: 0, cCr: 0 }; }
    function add(t, n) {
        t.oDr += n.oDr; t.oCr += n.oCr; t.pDr += n.pDr; t.pCr += n.pCr; t.cDr += n.cDr; t.cCr += n.cCr;
    }
    function ledNode(l) {
        var a = agg[l.id] || { open: 0, dr: 0, cr: 0 };
        var o = acctTbSplit(a.open);
        var closeNet = a.open + a.dr - a.cr;
        var c = acctTbSplit(closeNet);
        var moved = Math.round(a.dr * 100) || Math.round(a.cr * 100);
        var anything = moved || Math.round(a.open * 100) || Math.round(closeNet * 100);
        if (!anything) {
            // Nothing at all — only show if it genuinely posted this period and
            // the user asked for zero values.
            if (!acctFinShowZero || !active[l.id]) return null;
        }
        return {
            key: 'l:' + l.id, label: l.name, isLedger: true, ledgerId: l.id,
            oDr: o.dr, oCr: o.cr, pDr: a.dr, pCr: a.cr, cDr: c.dr, cCr: c.cr
        };
    }
    // Recurse the group tree to arbitrary depth (chart now has 3 levels).
    // acctTbNodeHtml already renders nested children recursively.
    function buildGroup(groupId, label) {
        var node = zero(); node.key = 'tg:' + groupId; node.label = label; node.children = [];
        acctLedgers.filter(function (l) { return l.group_id === groupId; })
            .sort(function (a, b) { return a.name.localeCompare(b.name); })
            .forEach(function (l) { var n = ledNode(l); if (n) { node.children.push(n); add(node, n); } });
        acctGroups.filter(function (g) { return g.parent_group_id === groupId; })
            .sort(function (a, b) { return a.name.localeCompare(b.name); })
            .forEach(function (cg) {
                var g = buildGroup(cg.id, cg.name);
                if (!g.children.length) return;
                node.children.push(g); add(node, g);
            });
        return node;
    }
    acctNatureOrder.forEach(function (nm) {
        var root = acctGroups.find(function (g) { return !g.parent_group_id && g.name === nm; });
        if (!root) return;
        var rootNode = buildGroup(root.id, root.name);
        if (rootNode.children.length) nodes.push(rootNode);
    });
    return nodes;
}

function acctTbCell(v, extraCls) {
    return '<span class="acct-tb-c' + (extraCls || '') + '">' + (Math.round(v * 100) ? acctAmt(v) : '') + '</span>';
}

function acctTbNodeHtml(node, depth) {
    var pad = 12 + depth * 18;
    var isGroup = !node.isLedger;
    var collapsed = isGroup && acctFinCollapsed[node.key];
    var icon = isGroup
        ? '<span class="acct-fin-toggle' + (collapsed ? ' collapsed' : '') + '">▼</span>'
        : '<span class="acct-fin-toggle-sp"></span>';
    var cls = 'acct-fin-row ' + (isGroup ? 'acct-fin-group' : 'acct-fin-ledger acct-clickable');
    var attr = isGroup ? ('data-node="' + node.key + '"') : ('data-ledger="' + node.ledgerId + '"');
    var h = '<div class="' + cls + '" ' + attr + ' style="padding-left:' + pad + 'px;">' + icon +
        '<span class="acct-fin-name">' + wmsEsc(node.label) + '</span>' +
        acctTbCell(node.oDr, ' acct-tb-blockstart') + acctTbCell(node.oCr) +
        acctTbCell(node.pDr, ' acct-tb-blockstart') + acctTbCell(node.pCr) +
        acctTbCell(node.cDr, ' acct-tb-blockstart acct-tb-close-c') + acctTbCell(node.cCr, ' acct-tb-close-c') +
        '</div>';
    if (isGroup && node.children && !collapsed) {
        node.children.forEach(function (c) { h += acctTbNodeHtml(c, depth + 1); });
    }
    return h;
}

function acctRenderTrialBalance() {
    var el = document.getElementById('acctTBBody');
    if (!el) return;
    acctSetCmdFilters('');
    if (!acctViewBookIds().length) { el.innerHTML = '<div class="acct-empty">No book selected. Enable accounting on an investor first.</div>'; return; }
    if (!acctVoucherRows.length) { el.innerHTML = '<div class="acct-empty">No postings yet for ' + wmsEsc(acctViewTitle()) + '.</div>'; return; }

    var fyStart = acctTbPeriodStart();
    acctRenderContext();
    var nodes = acctTbBuild(acctTbAggregate(fyStart), acctActiveLedgerIds(fyStart));

    function acctZ(x) { var v = Math.round(x * 100) / 100; return Math.abs(v) < 0.005 ? 0 : v; }
    var T = { oDr: 0, oCr: 0, pDr: 0, pCr: 0, cDr: 0, cCr: 0 };
    nodes.forEach(function (n) { Object.keys(T).forEach(function (k) { T[k] += n[k]; }); });
    Object.keys(T).forEach(function (k) { T[k] = acctZ(T[k]); });

    acctSetCmdFilters(
        acctExpandCtrlHtml('acctTb') +
        '<label class="acct-fin-zero"><input type="checkbox" id="acctTbShowZeroChk"' + (acctFinShowZero ? ' checked' : '') + '> Show zero</label>');

    var W = 'width:' + (acctFullAmt ? 248 : 184) + 'px;';   // header block spans its two Dr/Cr cols
    var html = '<div class="acct-tb-wrap">' +
        '<div class="acct-tb-hdr2"><span class="acct-fin-toggle-sp"></span><span class="acct-fin-name"></span>' +
            '<span class="acct-tb-grp acct-tb-blockstart" style="' + W + '">Opening Balance</span>' +
            '<span class="acct-tb-grp acct-tb-blockstart" style="' + W + '">During the Period</span>' +
            '<span class="acct-tb-grp acct-tb-blockstart" style="' + W + '">Closing Balance</span></div>' +
        '<div class="acct-fin-hdr"><span class="acct-fin-toggle-sp"></span><span class="acct-fin-name">Ledger</span>' +
            '<span class="acct-tb-c acct-tb-blockstart acct-tb-sub">Dr</span><span class="acct-tb-c acct-tb-sub">Cr</span>' +
            '<span class="acct-tb-c acct-tb-blockstart acct-tb-sub">Dr</span><span class="acct-tb-c acct-tb-sub">Cr</span>' +
            '<span class="acct-tb-c acct-tb-blockstart acct-tb-sub">Dr</span><span class="acct-tb-c acct-tb-sub">Cr</span></div>';
    nodes.forEach(function (n) { html += acctTbNodeHtml(n, 0); });
    html += '</div>';

    var bal = Math.round(T.pDr * 100) === Math.round(T.pCr * 100) &&
              Math.round(T.oDr * 100) === Math.round(T.oCr * 100) &&
              Math.round(T.cDr * 100) === Math.round(T.cCr * 100);
    html += '<div class="acct-fin-total"><span class="acct-fin-name">Total' + (bal ? '' : ' ⚠ Dr ≠ Cr') + '</span>' +
        '<span class="acct-tb-c acct-tb-blockstart">' + acctAmt(T.oDr) + '</span><span class="acct-tb-c">' + acctAmt(T.oCr) + '</span>' +
        '<span class="acct-tb-c acct-tb-blockstart">' + acctAmt(T.pDr) + '</span><span class="acct-tb-c">' + acctAmt(T.pCr) + '</span>' +
        '<span class="acct-tb-c acct-tb-blockstart">' + acctAmt(T.cDr) + '</span><span class="acct-tb-c">' + acctAmt(T.cCr) + '</span></div>';
    el.innerHTML = html;

    el.querySelectorAll('.acct-fin-group[data-node]').forEach(function (r) {
        r.onclick = function () { acctFinCollapsed[r.dataset.node] = !acctFinCollapsed[r.dataset.node]; acctRenderTrialBalance(); };
    });
    el.querySelectorAll('.acct-fin-ledger[data-ledger]').forEach(function (r) {
        r.onclick = function () { acctOpenLedgerDetail(r.dataset.ledger); };
    });
    acctWireExpandCtrl('acctTb', function () { return acctFinAllGroupKeys(nodes, []); }, 'fin', acctRenderTrialBalance);
    var sz = document.getElementById('acctTbShowZeroChk'); if (sz) sz.onchange = function () { acctSetShowZero(sz.checked); acctRenderTrialBalance(); };
    acctSaveFinCollapse();
}

function acctRenderDayBook() {
    var el = document.getElementById('acctDayBookBody');
    if (!el) return;
    if (!acctViewBookIds().length) { acctSetCmdFilters(''); el.innerHTML = '<div class="acct-empty">No book selected.</div>'; return; }

    // Command line: show-cancelled icon · search (search sits just before New Voucher).
    // The full-amount toggle is module-wide (header), not here. Rebuilt on toggle clicks;
    // the search re-renders ONLY the table body so its input keeps focus + caret.
    acctSetCmdFilters(
        '<button id="acctDbCancelledBtn" class="acct-ld-icon-btn' + (acctDayBookShowCancelled ? ' on' : '') + '" title="' +
            (acctDayBookShowCancelled ? 'Hide cancelled vouchers' : 'Show cancelled vouchers') + '">⊘</button>' +
        '<input type="text" id="acctDbSearch" class="wms-input acct-db-search" placeholder="Search vouchers…" value="' + wmsEsc(acctDayBookSearch) + '">');
    var cb = document.getElementById('acctDbCancelledBtn');
    if (cb) cb.onclick = function () { acctSetDayBookCancelled(!acctDayBookShowCancelled); acctRenderDayBook(); };
    var sr = document.getElementById('acctDbSearch');
    if (sr) sr.oninput = function () { acctDayBookSearch = sr.value; acctRenderDayBookBody(); };

    acctRenderDayBookBody();
}

function acctRenderDayBookBody() {
    var el = document.getElementById('acctDayBookBody');
    if (!el) return;
    var fmt = acctAmt;   // honours the module-wide full-amount toggle

    // Group lines by voucher.
    var vmap = {};
    acctVoucherRows.forEach(function (r) {
        if (!vmap[r.voucher_id]) {
            vmap[r.voucher_id] = {
                id: r.voucher_id, number: r.voucher_number, type: r.voucher_type,
                date: r.voucher_date, narration: r.voucher_narration, cancelled: !acctIsLive(r),
                debit: Number(r.total_debit) || 0, credit: Number(r.total_credit) || 0, lines: []
            };
        }
        vmap[r.voucher_id].lines.push(r);
    });
    var vouchers = Object.keys(vmap).map(function (k) { return vmap[k]; }).sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return (a.number || '').localeCompare(b.number || '');
    });
    var total = vouchers.length;

    var q = (acctDayBookSearch || '').trim().toLowerCase();
    var shown = vouchers.filter(function (v) {
        if (v.cancelled && !acctDayBookShowCancelled) return false;
        if (!q) return true;
        var hay = (v.number + ' ' + v.type + ' ' + (v.narration || '') + ' ' + acctFmtDate(v.date) + ' ' + (v.date || '') + ' ' +
            v.lines.map(function (l) { return l.ledger_name || ''; }).join(' ')).toLowerCase();
        return hay.indexOf(q) >= 0;
    });

    var cancelledCount = vouchers.filter(function (v) { return v.cancelled; }).length;
    var count = '<div class="acct-db-count">Day Book — ' + shown.length + ' of ' + total + ' voucher' + (total === 1 ? '' : 's') +
        ((cancelledCount && !acctDayBookShowCancelled) ? ' <span class="acct-db-count-note">(' + cancelledCount + ' cancelled hidden)</span>' : '') + '</div>';

    if (!total) { el.innerHTML = count + '<div class="acct-empty">No vouchers yet. Use ➕ New Voucher to begin.</div>'; return; }

    var html = count + '<table class="acct-table"><thead><tr><th class="c-date">Date</th><th>Voucher #</th><th>Type</th><th>Narration</th><th class="text-right">Debit</th><th class="text-right">Credit</th></tr></thead><tbody>';
    if (!shown.length) {
        html += '<tr><td colspan="6" class="acct-empty" style="padding:16px;">No vouchers match &ldquo;' + wmsEsc(acctDayBookSearch) + '&rdquo;.</td></tr>';
    }
    shown.forEach(function (v) {
        // Clicking a row OPENS the voucher (view/edit), rather than expanding inline.
        html += '<tr class="acct-clickable' + (v.cancelled ? ' acct-vch-cancelled' : '') + '" data-voucher="' + v.id + '" title="Open this voucher">' +
            '<td class="c-date">' + wmsEsc(acctFmtDate(v.date)) + '</td>' +
            '<td>' + wmsEsc(v.number) + (v.cancelled ? ' <span class="acct-scope-badge">cancelled</span>' : '') + '</td>' +
            '<td><span class="acct-kind-badge">' + wmsEsc(v.type) + '</span></td>' +
            '<td>' + wmsEsc(v.narration || '') + '</td>' +
            '<td class="text-right">' + fmt(v.debit) + '</td>' +
            '<td class="text-right">' + fmt(v.credit) + '</td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;

    el.querySelectorAll('tr[data-voucher]').forEach(function (tr) {
        tr.onclick = function () { acctOpenEditVoucher(tr.dataset.voucher); };
    });
}

function acctFmtDate(ymd) {
    if (!ymd) return '';
    var parts = String(ymd).split('-');
    if (parts.length !== 3) return ymd;
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return parts[2] + '-' + months[parseInt(parts[1], 10) - 1] + '-' + parts[0].slice(2);
}

var ACCT_GRP_PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#06b6d4', '#a855f7', '#eab308', '#3b82f6'];
function acctGrpColor(name) {
    var h = 0; var nm = name || ''; for (var i = 0; i < nm.length; i++) { h = (h * 31 + nm.charCodeAt(i)) >>> 0; }
    return ACCT_GRP_PALETTE[h % ACCT_GRP_PALETTE.length];
}
function acctLedgerRowHtml(lg, accent, indent) {
    var avail = lg.is_global ? '<span class="acct-kind-badge">Global</span>'
        : '<span class="acct-scope-badge">' + wmsEsc(acctInvName(lg.scope_investor_id)) + ' only</span>';
    var pad = (indent || 34);
    var bl = accent ? ('border-left:4px solid ' + accent + ';') : '';
    return '<tr><td class="acct-ledger-name" style="padding-left:' + pad + 'px;' + bl + '">' + wmsEsc(lg.name) + (lg.is_system ? ' <span class="acct-kind-badge">system</span>' : '') + '</td>' +
        '<td><span class="acct-kind-badge">' + wmsEsc(lg.ledger_kind) + '</span></td>' +
        '<td>' + avail + '</td>' +
        '<td class="text-right"><button class="acct-edit-btn" data-edit-ledger="' + lg.id + '" title="Edit ledger">✏️</button></td></tr>';
}
function acctLedMatch(name) {
    return !acctLedSearch || String(name).toLowerCase().indexOf(acctLedSearch.toLowerCase()) >= 0;
}
function acctLedByName(a, b) { return a.name.localeCompare(b.name); }

// Build the nature -> sub-group -> ledger model once, so the row renderer, the
// counts and Collapse-all all read off the same shape (and stay in agreement).
function acctLedBuild() {
    // Recurse the group tree (chart now has 3 levels: root → group → sub-group → ledger).
    function groupNode(groupId, label, key, parentHit) {
        var groupHit = parentHit || acctLedMatch(label);
        var ledgers = acctLedgers.filter(function (l) { return l.group_id === groupId; })
            .sort(acctLedByName)
            .filter(function (l) { return groupHit || acctLedMatch(l.name); });
        var subs = [];
        acctGroups.filter(function (g) { return g.parent_group_id === groupId; })
            .sort(acctLedByName)
            .forEach(function (cg) {
                var sub = groupNode(cg.id, cg.name, 'g:' + cg.id, groupHit);
                if (sub) subs.push(sub);
            });
        var count = ledgers.length + subs.reduce(function (a, s) { return a + s.count; }, 0);
        if (!count && !groupHit) return null;          // no match anywhere in this branch
        return { key: key, id: groupId, label: label, ledgers: ledgers, subs: subs, count: count };
    }
    var roots = [];
    acctNatureOrder.forEach(function (nature) {
        var root = acctGroups.find(function (g) { return !g.parent_group_id && g.name === nature; });
        if (!root) return;
        var natureHit = acctLedMatch(nature);
        var node = groupNode(root.id, nature, 'n:' + root.id, natureHit);
        if (!node) node = { key: 'n:' + root.id, id: root.id, label: nature, ledgers: [], subs: [], count: 0 };
        // Unsearched: always show the nature header (empty or not). Searching: only if it matched.
        if (!acctLedSearch || node.count || node.subs.length) roots.push(node);
    });
    return roots;
}

// ── Ledgers catalogue — two-column, Balance-Sheet-style tree ─────────────────
// Left column mirrors the BS liabilities side (Liabilities, Capital, Income,
// Expenses); the right column is Assets. Double-clicking a ledger edits it.
var _acctLedSearching = false;
function acctLedIsOpen(key) { return _acctLedSearching || !(acctLedCollapsed && acctLedCollapsed[key]); }
function acctScopeBadge(lg) {
    var ids = acctLedgerScopeIds(lg);
    if (!ids.length) return '<span class="acct-scope-badge">no book</span>';
    var names = ids.map(acctInvName);
    var txt = names.length <= 2 ? names.join(', ') : (names.slice(0, 2).join(', ') + ' +' + (names.length - 2));
    return '<span class="acct-scope-badge" title="' + wmsEsc(names.join(', ')) + '">' + wmsEsc(txt) + '</span>';
}
// Colour by ROOT FAMILY: each of the five roots owns a hue; sub-groups get shades
// of that hue that lighten with depth, with a small per-sibling hue nudge so
// siblings at the same level stay visually distinct while reading as one family.
var ACCT_ROOT_HUE = { 'Assets': 214, 'Liabilities': 268, 'Capital': 330, 'Income': 150, 'Expenses': 28 };
function acctRootOfGroup(groupId) {
    var g = acctGroupById[groupId], guard = 0;
    while (g && g.parent_group_id && guard < 30) { g = acctGroupById[g.parent_group_id]; guard++; }
    return g ? g.name : null;
}
function acctLedGroupColor(groupId, depth) {
    var base = ACCT_ROOT_HUE[acctRootOfGroup(groupId)];
    if (base == null) base = 220;
    var g = acctGroupById[groupId];
    var parentId = g ? g.parent_group_id : null;
    var sibs = acctGroups.filter(function (x) { return x.parent_group_id === parentId; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
    var idx = sibs.findIndex(function (x) { return x.id === groupId; }); if (idx < 0) idx = 0;
    var n = sibs.length || 1;
    var frac = n > 1 ? idx / (n - 1) : 0.5;               // 0..1 position across the siblings
    // Root: the strong family anchor (saturated border + tinted bg + coloured text).
    if (depth === 0) return { border: 'hsl(' + base + ',56%,40%)', bg: 'hsl(' + base + ',50%,87%)' };
    // Sub-groups: same family hue (gentle ±8° fan), stepped in lightness by depth AND
    // spread across siblings so same-level groups read as distinct shades of one family.
    var hue = base + (frac - 0.5) * 16;
    var bL = Math.min(70, 44 + (depth - 1) * 8 + frac * 16);
    var gL = Math.min(96, 86 + (depth - 1) * 3 + frac * 7);
    return { border: 'hsl(' + hue + ',48%,' + bL + '%)', bg: 'hsl(' + hue + ',42%,' + gL + '%)' };
}
function acctLedLedgerHtml(lg, depth) {
    var pad = 12 + depth * 16 + 4;
    var avail = lg.is_global ? '<span class="acct-kind-badge">Global</span>' : acctScopeBadge(lg);
    // thin left accent in the parent group's family colour ties the ledger to its group
    var c = acctLedGroupColor(lg.group_id, Math.max(0, depth - 1));
    return '<div class="acct-fin-row acct-fin-ledger acct-led-ledrow" data-ledger="' + lg.id + '" style="padding-left:' + pad + 'px;border-left:3px solid ' + c.border + ';" title="Double-click to edit">' +
        '<span class="acct-fin-toggle-sp"></span>' +
        '<span class="acct-fin-name">' + wmsEsc(lg.name) + (lg.is_system ? ' <span class="acct-kind-badge">system</span>' : '') + '</span>' +
        '<span class="acct-led-avail">' + avail + '</span>' +
        '<button class="acct-edit-btn acct-led-edit" data-edit-ledger="' + lg.id + '" tabindex="-1" title="Edit ledger">✏️</button></div>';
}
function acctLedGroupHtml(node, depth) {
    var open = acctLedIsOpen(node.key);
    var pad = 10 + depth * 16;
    var c = acctLedGroupColor(node.id, depth);
    var isRoot = depth === 0;
    var h = '<div class="acct-fin-row acct-fin-group acct-led-grp" data-node="' + node.key + '" style="padding-left:' + pad + 'px;border-left:' + (isRoot ? 6 : 4) + 'px solid ' + c.border + ';background:' + c.bg + ';' + (isRoot ? 'color:' + c.border + ';' : '') + '">' +
        '<span class="acct-fin-toggle' + (open ? '' : ' collapsed') + '">▼</span>' +
        '<span class="acct-fin-name">' + wmsEsc(node.label) + '</span>' +
        '<span class="acct-led-count">' + node.count + '</span>' +
        (isRoot ? '<span class="acct-led-editsp"></span>'
            : '<button class="acct-edit-btn acct-led-edit" data-edit-group="' + node.id + '" tabindex="-1" title="Edit group">✏️</button>') +
        '</div>';
    if (open) {
        (node.ledgers || []).forEach(function (lg) { h += acctLedLedgerHtml(lg, depth + 1); });
        (node.subs || []).forEach(function (sg) { h += acctLedGroupHtml(sg, depth + 1); });
    }
    return h;
}
function acctLedColHtml(roots, title) {
    var h = '<div class="acct-fin-col acct-led-col"><div class="acct-fin-hdr"><span>' + wmsEsc(title) + '</span><span></span></div>';
    if (!roots.length) h += '<div class="acct-empty" style="padding:16px;">—</div>';
    roots.forEach(function (r) { h += acctLedGroupHtml(r, 0); });
    return h + '</div>';
}
// Renders ONLY the catalogue body (the two columns) + wires its rows. The command
// line (with the search input) is left untouched, so live search keeps focus + caret
// — the same pattern the Day Book search uses. Called by search/typing and group
// toggles; the full acctRenderLedgers() rebuilds the command line too.
function acctRenderLedgerBody() {
    var el = document.getElementById('acctLedgersBody');
    if (!el) return;
    _acctLedSearching = !!acctLedSearch;
    var roots = acctLedBuild();
    // Split the natures across two columns, mirroring the Balance Sheet.
    var rightNames = ['Assets'];
    var leftRoots = [], rightRoots = [];
    roots.forEach(function (r) { (rightNames.indexOf(r.label) >= 0 ? rightRoots : leftRoots).push(r); });
    if (!roots.length) {
        el.innerHTML = '<div class="acct-empty">Nothing matches &ldquo;' + wmsEsc(acctLedSearch) + '&rdquo;.</div>';
    } else {
        el.innerHTML = '<div class="acct-fin-cols acct-led-cols">' +
            acctLedColHtml(leftRoots, 'Liabilities · Capital · Income · Expenses') +
            acctLedColHtml(rightRoots, 'Assets') + '</div>';
    }
    // Group rows toggle collapse; the edit pencil inside must not also toggle.
    el.querySelectorAll('.acct-led-grp[data-node]').forEach(function (row) {
        row.onclick = function () {
            acctLedCollapsed[row.dataset.node] = !acctLedCollapsed[row.dataset.node];
            acctRenderLedgerBody();               // body-only: keeps the search input alive
            if (acctLedCollapsed) acctSaveLedCollapse();
        };
    });
    // Double-click a ledger row to edit it.
    el.querySelectorAll('.acct-led-ledrow[data-ledger]').forEach(function (row) {
        row.ondblclick = function () { acctOpenEditLedger(row.dataset.ledger); };
    });
    el.querySelectorAll('[data-edit-ledger]').forEach(function (b) {
        b.onclick = function (e) { e.stopPropagation(); acctOpenEditLedger(b.dataset.editLedger); };
    });
    el.querySelectorAll('[data-edit-group]').forEach(function (b) {
        b.onclick = function (e) { e.stopPropagation(); acctOpenEditGroup(b.dataset.editGroup); };
    });
}

function acctRenderLedgers() {
    var el = document.getElementById('acctLedgersBody');
    if (!el) return;
    if (!acctLedgers.length) { acctSetCmdFilters(''); el.innerHTML = '<div class="acct-empty">No ledgers in the catalogue.</div>'; return; }

    var roots = acctLedBuild();
    var allKeys = [];
    (function collect(list) { list.forEach(function (n) { allKeys.push(n.key); collect(n.subs || []); }); })(roots);

    // UI-STANDARDS D.2.2 — collapsible groups start collapsed. Seed once per session.
    if (acctLedCollapsed === null) {
        acctLedCollapsed = {};
        allKeys.forEach(function (k) { acctLedCollapsed[k] = true; });
    }

    // One command line: ➕ New (bulk add), expand/collapse toggle + Summary, search.
    acctSetCmdFilters(
        '<button class="wms-btn wms-btn-secondary" id="acctLedNew">➕ New</button>' +
        acctExpandCtrlHtml('acctLed') +
        '<input type="text" id="acctLedSearchInput" class="wms-input" placeholder="Search ledgers &amp; groups" value="' + wmsEsc(acctLedSearch) + '">');

    acctRenderLedgerBody();

    var nb = document.getElementById('acctLedNew');
    if (nb) nb.onclick = acctOpenBulkAdd;
    acctWireExpandCtrl('acctLed', function () { return allKeys; }, 'led', acctRenderLedgerBody);
    var srch = document.getElementById('acctLedSearchInput');
    if (srch) srch.oninput = function () {
        acctLedSearch = srch.value;
        acctRenderLedgerBody();                   // body-only render → the input persists, focus + caret stay
    };
    if (acctLedCollapsed) acctSaveLedCollapse();
}

// ============================================================================
// Opening balances — search-and-add entry for the book's single OPENING_BALANCE
// voucher. PLAN §7.2: one per book, dated at the book's start. Saving REPLACES
// the existing one, so the modal must prefill from it or reopening would wipe it.
// ============================================================================

var acctOpeningLines = [];        // [{ ledgerId, ledgerName, debit, credit }]
var acctOpeningDateYmd = null;
var acctOpeningDdCtrls = {};      // row idx -> wmsDropdown controller (per-row ledger picker)
var acctOpeningExisting = {};     // ledgerId -> { debit, credit } already saved for this book

var ACCT_OB_SUSPENSE = 'Difference in Opening Balance';

/** FY start for the book, per investors.financial_year_start (month, default 4 = April). */
function acctOpeningDefaultYmd() {
    var inv = (wmsRefData && wmsRefData.investors || []).find(function (i) { return i.id === acctBookId; });
    var m = (inv && Number(inv.financial_year_start)) || 4;
    var today = new Date();
    // The FY containing today starts in month m of this year, or last year if we
    // haven't reached month m yet.
    var y = (today.getMonth() + 1) >= m ? today.getFullYear() : today.getFullYear() - 1;
    return y + '-' + String(m).padStart(2, '0') + '-01';
}

function acctOpeningExistingRows() {
    return acctVoucherRows.filter(function (r) { return r.voucher_type === 'OPENING_BALANCE'; });
}

// A ledger tied to a security (auto/investment ledger) — resolved by FK, not name.
function acctIsSecurityLedger(id) {
    var l = acctLedgers.find(function (x) { return x.id === id; });
    return !!(l && (l.security_id || l.ledger_kind === 'SECURITY'));
}
// Ledgers the Opening Balances modal AUTO-manages on a closed book (investments +
// the STT charge) — excluded from the editable prefill so they're never entered twice.
function acctIsAutoOpeningLedger(id) {
    var l = acctLedgers.find(function (x) { return x.id === id; });
    if (!l) return false;
    return !!(l.security_id || l.ledger_kind === 'SECURITY' ||
        l.posting_role === 'STT_STOCKS' || l.posting_role === 'STT_MF');
}

// Opening INVESTMENTS, drawn from the trade book — NOT typed by hand. For a book
// closed to a date (books_closed_upto), this is the cost of the holdings carried
// in as of that date. It runs the SAME frozen engine the poster uses
// (acctEngineProcess) over the closed-period trades and sums each security's net
// SECURITY-ledger movement, so the figure equals exactly what the engine will use
// as cost basis for a later sale — including this book's STT treatment (STT-as-
// expense books exclude STT from cost). Returns [{ security_id, cost, name }].
// Opening-balance held-lot buy STT. FIFO on (qty, stt), independent of the shared
// cost engine (which we deliberately do NOT touch — opening balance only). Returns
// the TOTAL buy-STT of the lots still held at close. Sell-STT and the STT of
// already-sold lots are excluded: they were expensed in their own period and are
// not an opening balance. Mirrors the engine's grouping (short_symbol / NFO symbol)
// and BUY/SELL/SPLIT/BONUS/RIGHTS_ENTITLEMENT/DEMERGER qty mechanics so the held
// lots match the cost side exactly.
function acctOpeningHeldBuyStt(txns) {
    function ekey(t) {
        var st = t.security_type || 'EQUITY';
        if (st === 'NFO') return String(t.symbol || t.short_symbol || '').replace(/^[A-Z]+:/, '');
        return (t.short_symbol != null && t.short_symbol !== '' ? t.short_symbol : '') || t.symbol || '';
    }
    function ktime(t) { return String(t.transaction_date || '') + ' ' + String(t.transaction_time || '') + ' ' + String(t.created_at || ''); }
    var bySec = {};
    (txns || []).forEach(function (t) { var k = ekey(t); if (!k) return; (bySec[k] = bySec[k] || []).push(t); });
    var total = 0;
    Object.keys(bySec).forEach(function (k) {
        var list = bySec[k].slice().sort(function (a, b) { var ka = ktime(a), kb = ktime(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
        var lots = [];   // { qty, stt } — stt = rupee amount remaining on the lot
        list.forEach(function (t) {
            var ty = t.transaction_type || '';
            var qty = Math.abs(Number(t.quantity) || 0);
            var stt = Math.abs(Number(t.stt) || 0);
            if (ty === 'BUY') lots.push({ qty: qty, stt: stt });
            else if (ty === 'BONUS' || ty === 'RIGHTS_ENTITLEMENT') lots.push({ qty: qty, stt: 0 });
            else if (ty === 'DEMERGER') { if ((Number(t.quantity) || 0) > 0) lots.push({ qty: qty, stt: 0 }); }
            else if (ty === 'SPLIT') { var ex = 0; lots.forEach(function (l) { ex += l.qty; }); if (ex > 0 && qty > 0) { var ra = (ex + qty) / ex; lots.forEach(function (l) { l.qty = l.qty * ra; }); } }
            else if (ty === 'SELL') { var rem = qty; while (rem > 1e-9 && lots.length > 0) { var lot = lots[0], m = Math.min(rem, lot.qty), before = lot.qty; if (before > 0) lot.stt = lot.stt * ((before - m) / before); lot.qty -= m; rem -= m; if (lot.qty <= 1e-9) lots.shift(); } }
        });
        lots.forEach(function (l) { total += l.stt; });
    });
    return Math.round(total * 100) / 100;
}

async function acctOpeningComputeInvestments() {
    var inv = (wmsRefData.investors || []).find(function (i) { return i.id === acctBookId; }) || {};
    var closeDate = inv.books_closed_upto;
    if (!closeDate) return [];                                  // no closed period → nothing carried in
    if (typeof acctEngineProcess !== 'function' || typeof wmsCalcFifoCost !== 'function') return [];
    var fields = 'id,investor_id,trader_id,broker_id,security_id,symbol,short_symbol,company_name,' +
        'security_type,transaction_type,transaction_date,transaction_time,quantity,price,' +
        'gross_amount,total_charges,trader_charges,stt,tds,net_amount,notes,created_at';
    var txns;
    try {
        txns = await wmsFetchAllRaw(acctUrl('transactions?select=' + fields +
            '&investor_id=eq.' + acctBookId + '&transaction_date=lte.' + closeDate)) || [];
    } catch (e) { console.error('[accounting] opening-investments fetch failed', e); return []; }
    if (!txns.length) return [];
    // Demerger is an EVENT posted in its own period (reduce parent, create children),
    // never an opening-balance item — even when a child's inherited acquisition date
    // (kept for cap-gains holding period) falls before the close. Drop DEMERGER rows
    // from the opening draw so the parent stays at full cost and the children appear
    // only when the demerger posts (this also silences the demerger_incomplete
    // exception when the parent-reduction leg is dated after the close). Owner 2026-08-18.
    txns = txns.filter(function (t) { return (t.transaction_type || t.type || '') !== 'DEMERGER'; });
    var invById = {}; (wmsRefData.investors || []).forEach(function (i) { invById[i.id] = i; });
    var ctx = { securityById: wmsRefData.securitiesCmMap || {}, investorById: invById, brokerById: {},
                fifo: function (t) { return wmsCalcFifoCost(t); } };
    var res;
    try { res = acctEngineProcess({ id: acctBookId, post_fno: inv.post_fno !== false }, txns, ctx); }
    catch (e) { console.error('[accounting] opening-investments engine failed', e); return []; }
    // Sum the engine's opening-asset legs carried in from the closed period:
    //  • SECURITY legs (Dr−Cr) per security  → investments at cost (net-of-STT on
    //    an STT-as-expense book);
    //  • STT_STOCKS / STT_MF role legs        → STT paid on those holdings, which
    //    an STT-as-expense book books separately (never in the security cost).
    // The BROKER (funding) leg is deliberately ignored — at opening the funding is
    // the capital / bank balances the owner enters, not a per-trade broker credit.
    var bySec = {};
    (res.vouchers || []).forEach(function (v) {
        (v.lines || []).forEach(function (l) {
            if (l.ref && l.ref.security_id) {
                var b = bySec[l.ref.security_id] || (bySec[l.ref.security_id] = { d: 0, c: 0 });
                b.d += (l.debit || 0); b.c += (l.credit || 0);
            }
        });
    });
    var securities = [];
    Object.keys(bySec).forEach(function (sid) {
        var net = Math.round((bySec[sid].d - bySec[sid].c) * 100) / 100;
        if (net > 0.005) {
            var sec = (wmsRefData.securitiesCmMap || {})[sid] || {};
            securities.push({ security_id: sid, cost: net, name: sec.company_name || sec.symbol || ('Security ' + String(sid).slice(0, 8)) });
        }
    });

    // MUTUAL FUNDS carried in from the closed period. MF trades live in their own
    // table (`mf_trades`, fractional units), so they don't come through the equity
    // engine above. Sells were FIFO-removed when the data was loaded, so the pre-close
    // lots ARE the held units and their `amount` IS the cost — a straight sum per
    // scheme (matches the FY26 financials to the rupee). No STT-in-cost adjustment
    // applies to MF, so this equals what the engine would compute for a later sale.
    try {
        var mf = await wmsFetchAllRaw(acctUrl('mf_trades?select=security_id,amount,securities_db(company_name,symbol)' +
            '&investor_id=eq.' + acctBookId + '&txn_date=lte.' + closeDate)) || [];
        var mfBySec = {};
        mf.forEach(function (r) {
            var s = mfBySec[r.security_id] || (mfBySec[r.security_id] = { cost: 0, sec: r.securities_db || {} });
            s.cost += (Number(r.amount) || 0);
        });
        Object.keys(mfBySec).forEach(function (sid) {
            var cost = Math.round(mfBySec[sid].cost * 100) / 100;
            if (cost > 0.005) {
                var sec = mfBySec[sid].sec || {};
                securities.push({ security_id: sid, cost: cost, name: sec.company_name || sec.symbol || ('MF ' + String(sid).slice(0, 8)) });
            }
        });
    } catch (e) { console.error('[accounting] opening MF fetch failed', e); }

    securities.sort(function (a, b) { return b.cost - a.cost; });
    // OPENING STT (opening balance only): carry ONLY the buy-STT of the lots STILL
    // HELD at close. The running ledger debits STT on every BUY and SELL; replaying
    // the whole history and summing those legs (the old approach) wrongly pulled in
    // sell-STT and the STT of already-sold lots — those were expensed in their own
    // period and are not an opening balance. Dedicated held-lot FIFO below; the shared
    // cost engine is deliberately left unchanged.
    var heldStt = acctOpeningHeldBuyStt(txns);
    var sttLines = [];
    if (heldStt > 0.005) {
        var sttLg = acctLedgers.find(function (x) { return x.posting_role === 'STT_STOCKS'; });
        sttLines.push({ role: 'STT_STOCKS', cost: heldStt, name: (sttLg && sttLg.name) || 'STT Charges - Stocks' });
    }
    return { securities: securities, sttLines: sttLines };
}

var acctOpeningSuppressAutoDd = false;   // suppress the ledger dropdown on the initial modal-open focus
async function acctOpenOpeningModal() {
    if (!acctBookId) { acctToast('Select a book first (enable accounting on an investor).', true); return; }
    if (acctViewBookIds().length > 1) { acctToast('Opening balances are per book — exit the consolidated view first.', true); return; }

    // Prefill from the existing voucher; saving replaces it, so anything not shown
    // here would be silently dropped.
    var rows = acctOpeningExistingRows();

    // Only auto-manage investments when the book is CLOSED to a date.
    var bookInv = (wmsRefData.investors || []).find(function (i) { return i.id === acctBookId; }) || {};
    var autoInvest = !!bookInv.books_closed_upto;

    // Compute the trade-draw FIRST, so we know exactly which ledgers will be re-derived
    // from THIS book's trades. Only those may be hidden from the editable prefill.
    acctLoading(true);
    var computed;
    try { computed = await acctOpeningComputeInvestments(); }
    finally { acctLoading(false); }
    computed = computed || { securities: [], sttLines: [] };
    var autoSecIds = {}; (computed.securities || []).forEach(function (s) { if (s.security_id) autoSecIds[s.security_id] = true; });
    var autoRoles = {}; (computed.sttLines || []).forEach(function (r) { if (r.role) autoRoles[r.role] = true; });

    // A saved ledger is "auto-drawn" (re-derived below) ONLY if it maps to a security in
    // THIS book's trade-draw, or is an auto STT role. A manually-entered security ledger
    // with no trades in this book — e.g. a PE holding carried purely as an opening balance —
    // is NOT re-drawn, so it must stay editable; otherwise it vanishes on reopen and is lost
    // on the next save (§A.6d.14: PE-JMS / PE-KTPL disappeared from Vikash's opening).
    function acctIsAutoDrawnLedger(id) {
        var lg = acctLedgers.find(function (x) { return x.id === id; });
        if (!lg) return false;
        if (lg.security_id && autoSecIds[lg.security_id]) return true;
        if (lg.posting_role && autoRoles[lg.posting_role]) return true;
        return false;
    }
    function acctOpeningHideSaved(id) {
        return acctLedgerName(id) === ACCT_OB_SUSPENSE || (autoInvest && acctIsAutoDrawnLedger(id));
    }

    // Map every already-saved opening balance by ledger (minus the derived suspense
    // plug and any auto-drawn investment ledgers). Used to (a) prefill an amount
    // when that ledger is picked again, and (b) flag the row with an alert icon.
    acctOpeningExisting = {};
    rows.forEach(function (r) {
        if (!r.ledger_id || acctOpeningHideSaved(r.ledger_id)) return;
        acctOpeningExisting[r.ledger_id] = {
            debit: Number(r.debit_amount) || 0, credit: Number(r.credit_amount) || 0
        };
    });

    acctOpeningLines = rows.map(function (r) {
        var dr = Number(r.debit_amount) || 0, cr = Number(r.credit_amount) || 0;
        return { ledgerId: r.ledger_id, ledgerName: acctLedgerName(r.ledger_id), debit: dr ? String(dr) : '', credit: cr ? String(cr) : '' };
    }).filter(function (l) {
        // Drop the DERIVED suspense plug (recomputed on save) and — only on a closed
        // book — the ledgers actually re-derived below from the trade book.
        return l.ledgerId && !acctOpeningHideSaved(l.ledgerId);
    });

    // Prepend the auto lines (locked) drawn from the trade book: ONE consolidated
    // Investments line (double-click for the per-security breakdown) + any STT line.
    var locked = [];
    var secs = computed.securities || [];
    if (secs.length) {
        var totalInvest = 0; secs.forEach(function (s) { totalInvest += s.cost; });
        totalInvest = Math.round(totalInvest * 100) / 100;
        locked.push({ locked: true, kind: 'invest', ledgerName: 'Investments',
            debit: String(totalInvest), credit: '', breakdown: secs, expanded: false });
    }
    (computed.sttLines || []).forEach(function (r) {
        // Prefer the STT amount SAVED on the existing opening voucher (if any) over the
        // freshly-computed held-lot STT, so a manual override (e.g. keeping only the
        // auditor-capitalised STT) survives a reopen instead of being recalculated.
        var savedStt = null;
        rows.forEach(function (rw) {
            var lg = acctLedgers.find(function (x) { return x.id === rw.ledger_id; });
            if (lg && lg.posting_role === r.role) savedStt = Number(rw.debit_amount) || 0;
        });
        var sttAmt = (savedStt != null) ? savedStt : r.cost;
        locked.push({ locked: true, kind: 'role', role: r.role, ledgerName: r.name, debit: String(sttAmt), credit: '' });
    });
    acctOpeningLines = locked.concat(acctOpeningLines);

    // Always leave one empty row to type into (like the New Voucher modal).
    if (!acctOpeningLines.some(function (l) { return !l.locked; })) acctOpeningLines.push({ ledgerId: '', ledgerName: '', debit: '', credit: '' });

    acctOpeningDateYmd = rows.length ? rows[0].voucher_date : acctOpeningDefaultYmd();

    document.getElementById('acctOpeningTitle').textContent =
        (rows.length ? 'Opening Balances (editing) — ' : 'Opening Balances — ') + acctInvName(acctBookId);

    // wmsDateInput self-initialises to today with a silent render, so an explicit
    // setValue is required to land on the FY start / the saved voucher's date.
    var dc = document.getElementById('acctOpeningDate');
    if (dc && typeof wmsDateInput === 'function') {
        var ctrl = wmsDateInput(dc, { compact: true, onChange: function (ymd) { acctOpeningDateYmd = ymd; } });
        if (ctrl && ctrl.setValue) ctrl.setValue(acctOpeningDateYmd);
    }
    acctRenderOpeningLines();
    if (acctOpeningModalCtrl) acctOpeningModalCtrl.open();
    // Land on the first empty ledger cell — the modal is typed top-down.
    setTimeout(function () {
        var first = document.querySelector('#acctOpeningLines .acct-line-ledger');
        if (first) { acctOpeningSuppressAutoDd = true; first.focus(); }   // focus the field but don't pop the dropdown
    }, 60);
}

// Ledgers offered in a row's picker: available in this book, minus any already
// chosen in OTHER rows (a ledger can hold only one opening balance).
function acctOpeningLedgerMatches(idx, q) {
    var usedElsewhere = {}, lockedSecs = {}, lockedRoles = {};
    acctOpeningLines.forEach(function (l, i) {
        if (i !== idx && l.ledgerId) usedElsewhere[l.ledgerId] = true;
        if (l.locked && l.kind === 'invest') (l.breakdown || []).forEach(function (s) { lockedSecs[s.security_id] = true; });
        if (l.locked && l.kind === 'role' && l.role) lockedRoles[l.role] = true;
    });
    var needle = String(q || '').trim().toLowerCase();
    return acctAvailableLedgers(acctBookId).filter(function (l) {
        if (usedElsewhere[l.id]) return false;
        if (l.security_id && lockedSecs[l.security_id]) return false;      // already in the locked Investments total
        if (l.posting_role && lockedRoles[l.posting_role]) return false;   // already shown as the locked STT line
        return !needle || l.name.toLowerCase().indexOf(needle) >= 0;
    }).slice(0, 50);
}

function acctOpeningAddLine(focusIt) {
    acctOpeningLines.push({ ledgerId: '', ledgerName: '', debit: '', credit: '' });
    acctRenderOpeningLines();
    if (focusIt) {
        var el = document.querySelector('#acctOpeningLines tr:last-child .acct-line-ledger');
        if (el) el.focus();
    }
}

/* Per-row ledger cell — the app's standard search-suggest field (wmsDropdown,
   H.3.2), same shape as the New Voucher modal. Picking a ledger that already
   carries a saved opening balance prefills that amount (when the row is still
   empty) so the ⚠ flag and the number stay in step. */
function acctOpeningWireLedgerCell(input) {
    var idx = Number(input.dataset.idx);
    var dd = input.parentElement.querySelector('.acct-line-dd');

    function render() {
        var list = acctOpeningLedgerMatches(idx, input.value);
        dd._acctResults = list;
        var html = list.map(function (l, i) {
            var flag = acctOpeningExisting[l.id] ? ' <span class="acct-dd-grp" style="color:#b45309;">• has opening bal</span>' : '';
            return '<div class="wms-dd-item" data-i="' + i + '">' + wmsEsc(l.name) +
                '<span class="acct-dd-grp">' + wmsEsc(acctRootName(l.group_id)) + '</span>' + flag + '</div>';
        }).join('');
        dd.innerHTML = html || '<div class="wms-dd-no-results">No ledgers — add one in the Ledgers tab</div>';
        ctrl.show();
    }

    function pick(itemEl) {
        if (!itemEl) return;
        var l = (dd._acctResults || [])[Number(itemEl.dataset.i)];
        if (!l) return;
        var line = acctOpeningLines[idx];
        line.ledgerId = l.id;
        line.ledgerName = l.name;
        input.value = l.name;
        var ex = acctOpeningExisting[l.id];
        // Prefill a saved opening balance when this row has no amount yet.
        if (ex && !acctParse(line.debit) && !acctParse(line.credit)) {
            line.debit = ex.debit ? String(ex.debit) : '';
            line.credit = ex.credit ? String(ex.credit) : '';
            var dEl = document.querySelector('#acctOpeningLines .acct-line-amt[data-idx="' + idx + '"][data-field="debit"]');
            var cEl = document.querySelector('#acctOpeningLines .acct-line-amt[data-idx="' + idx + '"][data-field="credit"]');
            if (dEl) dEl.value = line.debit;
            if (cEl) cEl.value = line.credit;
        }
        // Show / refresh the ⚠ existing-balance marker on this row, in place.
        var wrap = input.parentElement;
        var mark = wrap.querySelector('.acct-ob-existing');
        if (ex) {
            var exTxt = ex.debit ? ('Dr ' + acctNum(ex.debit)) : ('Cr ' + acctNum(ex.credit));
            if (!mark) { mark = document.createElement('span'); mark.className = 'acct-ob-existing'; mark.textContent = '⚠'; wrap.insertBefore(mark, dd); }
            mark.title = 'This ledger already has a saved opening balance (' + exTxt + '). Saving will overwrite it.';
        } else if (mark) { mark.remove(); }
        ctrl.close();
        var amt = document.querySelector('#acctOpeningLines .acct-line-amt[data-idx="' + idx + '"][data-field="debit"]');
        if (amt) { amt.focus(); amt.select(); }
        acctOpeningUpdateBalance();
    }

    var ctrl = wmsDropdown(input, dd, {
        itemSelector: '.wms-dd-item', closeOnSelect: true, blurDelay: 180,
        escClearsInput: false, onSelect: pick
    });
    acctOpeningDdCtrls[idx] = ctrl;

    input.addEventListener('input', function () {
        acctOpeningLines[idx].ledgerId = '';       // typing invalidates the pick
        acctOpeningLines[idx].ledgerName = input.value;
        var mark = input.parentElement.querySelector('.acct-ob-existing');
        if (mark) mark.remove();                   // pick no longer confirmed
        render();
    });
    input.addEventListener('focus', function () {
        // On the initial modal-open focus, keep the caret on the field but DON'T pop the
        // suggestion dropdown. It still opens when the user clicks or types.
        if (acctOpeningSuppressAutoDd) { acctOpeningSuppressAutoDd = false; return; }
        render();
    });
    input.addEventListener('click', render);
    dd.addEventListener('mousedown', function (e) {
        var it = e.target.closest ? e.target.closest('.wms-dd-item') : null;
        if (!it) return;
        e.preventDefault();
        pick(it);
    });
}

function acctOpeningWireAmountCell(inp) {
    var idx = Number(inp.dataset.idx), field = inp.dataset.field;
    var ctrl = (typeof wmsAttachAmountInput === 'function') ? wmsAttachAmountInput(inp, { allowNegative: false }) : null;
    // Prefilled amounts (editing a saved book) are set programmatically and never
    // blur, so format them now — otherwise they show raw, un-grouped numbers.
    if (ctrl && inp.value && document.activeElement !== inp) {
        var n0 = parseFloat(String(inp.value).replace(/,/g, ''));
        if (!isNaN(n0)) ctrl.setValue(n0);
    }
    inp.addEventListener('input', function () {
        acctOpeningLines[idx][field] = inp.value;
        // A line is Dr or Cr, never both — clear the opposite as you type.
        if (acctParse(inp.value) > 0) {
            var other = field === 'debit' ? 'credit' : 'debit';
            acctOpeningLines[idx][other] = '';
            var oEl = document.querySelector('#acctOpeningLines .acct-line-amt[data-idx="' + idx + '"][data-field="' + other + '"]');
            if (oEl) oEl.value = '';
        }
        acctOpeningUpdateBalance();
    });
    // Enter on an amount opens the next line; Tab off the last row's Credit field also
    // adds a new row (same as the New Voucher modal).
    inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); acctOpeningAddLine(true); return; }
        if (e.key === 'Tab' && !e.shiftKey && field === 'credit' && idx === acctOpeningLines.length - 1) {
            e.preventDefault(); acctOpeningAddLine(true);
        }
    });
}

function acctLedgerName(id) {
    var l = acctLedgers.find(function (x) { return x.id === id; });
    return l ? l.name : '(unknown ledger)';
}

function acctRenderOpeningLines() {
    var tb = document.getElementById('acctOpeningLines');
    if (!tb) return;
    acctOpeningDdCtrls = {};

    tb.innerHTML = acctOpeningLines.map(function (ln, idx) {
        // Locked AUTO lines — drawn from the trade book, read-only.
        if (ln.locked) {
            // Consolidated Investments line: one row for the total, double-click to
            // expand the per-security breakdown beneath it.
            if (ln.kind === 'invest') {
                var bd = ln.breakdown || [];
                var caret = ln.expanded ? '▾' : '▸';
                var html = '<tr data-idx="' + idx + '" class="acct-ob-locked acct-ob-invest" title="Investments carried in from the trade book (cost, net of STT). Double-click for the securities.">' +
                    '<td><span class="acct-ob-lock">🔒</span> <b>Investments</b> ' +
                    '<span class="acct-ob-expand" data-idx="' + idx + '">' + caret + ' ' + bd.length + ' securities</span></td>' +
                    '<td class="text-right acct-ob-lockamt">' + acctNum(acctParse(ln.debit)) + '</td>' +
                    '<td class="text-right"></td><td></td></tr>';
                if (ln.expanded) {
                    bd.forEach(function (s) {
                        html += '<tr class="acct-ob-locked acct-ob-breakdown">' +
                            '<td style="padding-left:30px;color:#64748b;">' + wmsEsc(s.name) + '</td>' +
                            '<td class="text-right acct-ob-lockamt" style="color:#64748b;">' + acctNum(s.cost) + '</td>' +
                            '<td></td><td></td></tr>';
                    });
                }
                return html;
            }
            // STT charge line: the LEDGER is fixed (drawn from the trade book by role),
            // but the AMOUNT is EDITABLE — e.g. keep only the STT the auditor capitalised
            // into cost and expense the rest. acctSaveOpening reads this edited debit for
            // the role line, so typing here overrides the auto-drawn held-lot STT.
            return '<tr data-idx="' + idx + '" class="acct-ob-locked acct-ob-roleedit">' +
                '<td><span class="acct-ob-lock" title="Ledger is fixed (drawn from the trade book); the amount is editable.">🔒</span> ' +
                    wmsEsc(ln.ledgerName || '') +
                    '<span class="acct-dd-grp">Charge · editable</span></td>' +
                '<td class="text-right"><input type="text" class="acct-line-amt" data-idx="' + idx + '" data-field="debit" value="' + wmsEsc(ln.debit || '') + '"></td>' +
                '<td class="text-right"></td>' +
                '<td></td></tr>';
        }
        var nm = ln.ledgerId ? acctLedgerName(ln.ledgerId) : (ln.ledgerName || '');
        // ⚠ flag: this ledger already carries a SAVED opening balance — re-saving
        // overwrites it. Tooltip shows the amount currently on record.
        var ex = ln.ledgerId ? acctOpeningExisting[ln.ledgerId] : null;
        var flag = '';
        if (ex) {
            var exTxt = ex.debit ? ('Dr ' + acctNum(ex.debit)) : ('Cr ' + acctNum(ex.credit));
            flag = '<span class="acct-ob-existing" title="This ledger already has a saved opening balance (' + wmsEsc(exTxt) + '). Saving will overwrite it.">⚠</span>';
        }
        return '<tr data-idx="' + idx + '">' +
            '<td><div class="acct-line-pick">' +
                '<input type="text" class="acct-line-ledger" data-idx="' + idx + '" value="' + wmsEsc(nm) + '" placeholder="Search ledger…" autocomplete="off">' +
                flag +
                '<div class="wms-dd acct-line-dd" data-idx="' + idx + '"></div>' +
            '</div></td>' +
            '<td class="text-right"><input type="text" class="acct-line-amt" data-idx="' + idx + '" data-field="debit" value="' + wmsEsc(ln.debit || '') + '"></td>' +
            '<td class="text-right"><input type="text" class="acct-line-amt" data-idx="' + idx + '" data-field="credit" value="' + wmsEsc(ln.credit || '') + '"></td>' +
            '<td><button class="acct-line-del" data-idx="' + idx + '" title="Remove line">✕</button></td></tr>';
    }).join('');

    // Expand / collapse the consolidated Investments breakdown (double-click the
    // row, or click the "N securities" caret).
    function acctOpeningToggleExpand(i) {
        if (acctOpeningLines[i]) { acctOpeningLines[i].expanded = !acctOpeningLines[i].expanded; acctRenderOpeningLines(); }
    }
    tb.querySelectorAll('.acct-ob-invest').forEach(function (row) {
        row.ondblclick = function () { acctOpeningToggleExpand(Number(row.dataset.idx)); };
    });
    tb.querySelectorAll('.acct-ob-expand').forEach(function (el) {
        el.onclick = function (e) { e.stopPropagation(); acctOpeningToggleExpand(Number(el.dataset.idx)); };
    });

    tb.querySelectorAll('.acct-line-ledger').forEach(acctOpeningWireLedgerCell);
    tb.querySelectorAll('.acct-line-amt').forEach(acctOpeningWireAmountCell);
    tb.querySelectorAll('.acct-line-del').forEach(function (b) {
        b.onclick = function () {
            if (acctOpeningLines.length <= 1) {                 // keep one empty row to type into
                acctOpeningLines[0] = { ledgerId: '', ledgerName: '', debit: '', credit: '' };
            } else {
                acctOpeningLines.splice(Number(b.dataset.idx), 1);
                // Always leave at least one editable row (locked rows can't be typed in).
                if (!acctOpeningLines.some(function (l) { return !l.locked; })) {
                    acctOpeningLines.push({ ledgerId: '', ledgerName: '', debit: '', credit: '' });
                }
            }
            acctRenderOpeningLines();
        };
    });
    acctOpeningUpdateBalance();
}

function acctOpeningTotals() {
    var dr = 0, cr = 0;
    acctOpeningLines.forEach(function (l) { dr += acctParse(l.debit); cr += acctParse(l.credit); });
    return { dr: dr, cr: cr, diff: Math.round((dr - cr) * 100) / 100 };
}

function acctOpeningUpdateBalance() {
    var t = acctOpeningTotals();
    var nonEmpty = acctOpeningLines.filter(function (l) { return acctParse(l.debit) > 0 || acctParse(l.credit) > 0; }).length;
    // Totals aligned under Dr/Cr (full rupees), difference on its own line — same
    // presentation as the voucher modal.
    document.getElementById('acctOpeningTotalDr').textContent = acctNum(t.dr);
    document.getElementById('acctOpeningTotalCr').textContent = acctNum(t.cr);

    var balanced = Math.abs(t.diff) < 0.005;
    var diffEl = document.getElementById('acctOpeningDiff');
    if (diffEl) diffEl.textContent = (nonEmpty && !balanced) ? (acctNum(Math.abs(t.diff)) + ' ' + (t.diff > 0 ? 'Dr' : 'Cr')) : '';
    var grid = document.getElementById('acctOpeningGrid');
    if (grid) {
        grid.classList.toggle('acct-vch-balanced', nonEmpty && balanced);
        grid.classList.toggle('acct-vch-unbalanced', nonEmpty && !balanced);
    }
    var msg = document.getElementById('acctOpeningMsg');
    var note = document.getElementById('acctOpeningNote');
    if (msg) msg.textContent = !nonEmpty ? 'Nothing entered' : (balanced ? 'Balanced' : 'Difference');
    if (note) {
        note.textContent = (nonEmpty && !balanced)
            ? 'On save the ' + acctNum(Math.abs(t.diff)) + ' difference is posted to “' + ACCT_OB_SUSPENSE + '” (' +
              (t.diff > 0 ? 'credit' : 'debit') + ') so the voucher ties. It stays on the Balance Sheet until you clear it.'
            : '';
    }
    var save = document.getElementById('acctOpeningSave');
    if (save) save.disabled = !nonEmpty;   // unbalanced is allowed — it gets plugged
}

async function acctSaveOpening() {
    var t = acctOpeningTotals();
    var withAmt = acctOpeningLines.filter(function (l) { return acctParse(l.debit) > 0 || acctParse(l.credit) > 0; });
    // Editable rows need a ledger; locked auto-investment rows resolve by security_id.
    if (withAmt.some(function (l) { return !l.locked && !l.ledgerId; })) {
        acctToast('Pick a ledger for every row that has an amount.', true); return;
    }
    if (!withAmt.length) { acctToast('Enter at least one amount.', true); return; }

    var btn = document.getElementById('acctOpeningSave');
    if (btn) btn.disabled = true;
    try {
        // Resolve every row to ledger id(s). The consolidated Investments line posts
        // ONE Dr per security (creating the Investment ledger if missing); the STT
        // line resolves by role; editable rows use their picked ledger.
        var lines = [];
        for (var wi = 0; wi < withAmt.length; wi++) {
            var wl = withAmt[wi];
            if (wl.locked && wl.kind === 'invest') {
                var bd = wl.breakdown || [];
                for (var bi = 0; bi < bd.length; bi++) {
                    var slid = await acctFindOrCreateAuto('security_id', bd[bi].security_id);
                    lines.push({ ledger_id: slid, debit_amount: bd[bi].cost, credit_amount: 0 });
                }
            } else if (wl.locked && wl.kind === 'role') {
                var rlid = await acctResolveRef({ role: wl.role });
                lines.push({ ledger_id: rlid, debit_amount: acctParse(wl.debit), credit_amount: 0 });
            } else {
                lines.push({ ledger_id: wl.ledgerId, debit_amount: acctParse(wl.debit), credit_amount: acctParse(wl.credit) });
            }
        }
        // Plug any difference to the suspense ledger so the voucher always ties.
        if (Math.abs(t.diff) >= 0.005) {
            var map = {};
            await acctResolveLedgers([{
                key: 'susp', name: ACCT_OB_SUSPENSE, group: 'Current Assets', kind: 'GENERAL', isGlobal: true
            }], map);
            lines.push({
                ledger_id: map.susp,
                debit_amount: t.diff < 0 ? Math.abs(t.diff) : 0,
                credit_amount: t.diff > 0 ? t.diff : 0
            });
        }

        var header = {
            investor_id: acctBookId,
            voucher_type: 'OPENING_BALANCE',
            voucher_date: acctOpeningDateYmd || acctOpeningDefaultYmd(),
            narration: 'Opening balances'
        };
        // One OPENING_BALANCE voucher per book — drop the old one first (PLAN §7.2).
        await fetch(acctUrl('acct_vouchers?investor_id=eq.' + acctBookId + '&voucher_type=eq.OPENING_BALANCE'),
            { method: 'DELETE', headers: wmsHeaders({ 'Prefer': 'return=minimal' }) });

        var resp = await fetch(acctUrl('rpc/acct_post_voucher'), {
            method: 'POST',
            headers: wmsHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ p_header: header, p_lines: lines })
        });
        if (!resp.ok) throw new Error((await resp.text()) || ('HTTP ' + resp.status));

        if (acctOpeningModalCtrl) acctOpeningModalCtrl.close();
        acctToast('Opening balances saved (' + lines.length + ' lines).');
        await acctLoadBook();
        acctRenderActiveTab();
    } catch (e) {
        acctToast('Save failed: ' + (e && e.message ? e.message : e), true);
        if (btn) btn.disabled = false;
    }
}

// ============================================================================
// Voucher modal
// ============================================================================

var acctVoucherDdCtrls = {};        // row idx -> wmsDropdown controller
var acctLedgerPickTarget = null;    // {idx} when Add Ledger was launched from a row
var acctEditingVoucherId = null;    // set when the voucher modal is editing, not creating
var acctVoucherReadOnly = false;    // auto (PMS-trade) vouchers open view-only
var acctVoucherShowLegNarr = false; // per-leg narration fields toggled on

/* Current (closing) balance of a ledger from the in-memory voucher rows — Dr positive.
   Excludes the voucher being edited so its own lines don't inflate the "before" figure. */
function acctLedgerCurrentBalance(ledgerId) {
    if (!ledgerId) return 0;
    var net = 0;
    acctVoucherRows.forEach(function (r) {
        if (r.ledger_id !== ledgerId || !acctIsLive(r)) return;
        if (acctEditingVoucherId && r.voucher_id === acctEditingVoucherId) return;
        net += (Number(r.debit_amount) || 0) - (Number(r.credit_amount) || 0);
    });
    return net;
}
function acctBalLabel(net) { return acctNum(Math.abs(net)) + ' ' + (net >= 0 ? 'Dr' : 'Cr'); }

/* Fill each line's balance sub-line: current balance, and (once an amount is typed)
   the projected balance after this line posts. Called on pick + on every amount edit. */
function acctPaintLineBalances() {
    acctVoucherLines.forEach(function (ln, idx) {
        var el = document.querySelector('#acctVoucherLines .acct-line-bal[data-idx="' + idx + '"]');
        if (!el) return;
        if (!ln.ledgerId) { el.innerHTML = ''; return; }
        var base = acctLedgerCurrentBalance(ln.ledgerId);
        var eff = (acctParse(ln.debit) || 0) - (acctParse(ln.credit) || 0);
        var html = 'Bal: ' + acctBalLabel(base);
        if (Math.abs(eff) > 0.005) html += ' <span class="acct-line-bal-proj">→ ' + acctBalLabel(base + eff) + '</span>';
        el.innerHTML = html;
    });
}

function acctVoucherIsBalanced() {
    var d = 0, c = 0, nonEmpty = 0, valid = true;
    acctVoucherLines.forEach(function (l) {
        var dd = acctParse(l.debit), cc = acctParse(l.credit);
        if (dd > 0 && cc > 0) valid = false;                    // a line is Dr or Cr, never both
        d += dd; c += cc;
        if (dd > 0 || cc > 0) { nonEmpty++; if (!l.ledgerId) valid = false; }
    });
    return valid && nonEmpty >= 2 && Math.round(d * 100) === Math.round(c * 100) && d > 0;
}

/* Keep the trailing auto-filled line at whatever balances the voucher, until the
   user types over it. This is what makes line 2+ open pre-populated and stay
   correct when an earlier line is edited. */
function acctSyncAutoLine() {
    if (acctVoucherLines.length < 2) return;
    var last = acctVoucherLines[acctVoucherLines.length - 1];
    if (!last._auto) return;
    var d = 0, c = 0;
    acctVoucherLines.slice(0, -1).forEach(function (l) { d += acctParse(l.debit); c += acctParse(l.credit); });
    var diff = Math.round((d - c) * 100) / 100;
    last.debit = ''; last.credit = '';
    if (diff > 0) last.credit = String(diff);
    else if (diff < 0) last.debit = String(-diff);
}

function acctAddVoucherLine(focusIt) {
    // Every line after the first opens pre-filled with the balancing amount.
    acctVoucherLines.push({ ledgerId: '', ledgerName: '', debit: '', credit: '', narration: '', _auto: acctVoucherLines.length >= 1 });
    acctRenderVoucherLines();
    if (focusIt) {
        var el = document.querySelector('#acctVoucherLines tr:last-child .acct-line-ledger');
        if (el) el.focus();
    }
}

function acctVoucherLedgerMatches(q) {
    var needle = String(q || '').trim().toLowerCase();
    var list = acctAvailableLedgers(acctBookId);
    if (needle) list = list.filter(function (l) { return l.name.toLowerCase().indexOf(needle) >= 0; });
    return list.slice(0, 50);
}

/* Ledger cell = the app's standard search-suggest field (wmsDropdown, H.3.2),
   same shape as the symbol pickers — NOT a fixed <select>. Includes an inline
   "Create ledger" escape hatch so you never have to leave the voucher. */
function acctWireLedgerCell(input) {
    var idx = Number(input.dataset.idx);
    var dd = input.parentElement.querySelector('.acct-line-dd');

    function render() {
        var list = acctVoucherLedgerMatches(input.value);
        dd._acctResults = list;
        var html = list.map(function (l, i) {
            return '<div class="wms-dd-item" data-i="' + i + '">' + wmsEsc(l.name) +
                '<span class="acct-dd-grp">' + wmsEsc(acctRootName(l.group_id)) + '</span></div>';
        }).join('');
        var typed = String(input.value || '').trim();
        if (typed && !list.some(function (l) { return l.name.toLowerCase() === typed.toLowerCase(); })) {
            html += '<div class="wms-dd-item acct-dd-create" data-create="1">➕ Create ledger “' + wmsEsc(typed) + '”…</div>';
        }
        dd.innerHTML = html || '<div class="wms-dd-no-results">No ledgers</div>';
        ctrl.show();
    }

    function pick(itemEl) {
        if (!itemEl) return;
        if (itemEl.dataset.create) {
            acctLedgerPickTarget = { idx: idx };
            ctrl.close();
            acctOpenAddLedger();
            var nameEl = document.getElementById('acctNewLedgerName');
            if (nameEl) nameEl.value = String(input.value || '').trim();
            return;
        }
        var l = (dd._acctResults || [])[Number(itemEl.dataset.i)];
        if (!l) return;
        acctVoucherLines[idx].ledgerId = l.id;
        acctVoucherLines[idx].ledgerName = l.name;
        input.value = l.name;
        ctrl.close();
        var amt = document.querySelector('#acctVoucherLines .acct-line-amt[data-idx="' + idx + '"][data-field="debit"]');
        if (amt) { amt.focus(); amt.select(); }
        acctUpdateBalance();
    }

    var ctrl = wmsDropdown(input, dd, {
        itemSelector: '.wms-dd-item', closeOnSelect: true, blurDelay: 180,
        escClearsInput: false, onSelect: pick
    });
    acctVoucherDdCtrls[idx] = ctrl;

    input.addEventListener('input', function () {
        // Typing invalidates the chosen ledger until something is re-picked.
        acctVoucherLines[idx].ledgerId = '';
        acctVoucherLines[idx].ledgerName = input.value;
        render();
        acctUpdateBalance();
    });
    // NO focus→open: the field opens with the cursor ready but the dropdown closed;
    // the suggestion list appears only once the user starts typing (owner request).
    // wmsDropdown owns the keyboard; clicks are the module's own responsibility.
    dd.addEventListener('mousedown', function (e) {
        var it = e.target.closest ? e.target.closest('.wms-dd-item') : null;
        if (!it) return;
        e.preventDefault();
        pick(it);
    });
}

/* Amounts use the global amount widget (wmsAttachAmountInput) so grouping and
   parsing match the rest of the app instead of being hand-rolled here. */
function acctWireAmountCell(inp) {
    var idx = Number(inp.dataset.idx), field = inp.dataset.field;
    if (typeof wmsAttachAmountInput === 'function') wmsAttachAmountInput(inp, { allowNegative: false });

    inp.addEventListener('input', function () {
        acctVoucherLines[idx]._auto = false;                    // user took ownership of this line
        inp.classList.remove('acct-auto');
        acctVoucherLines[idx][field] = inp.value;
        if (acctParse(inp.value) > 0) {
            var other = field === 'debit' ? 'credit' : 'debit';
            acctVoucherLines[idx][other] = '';
            var oEl = document.querySelector('#acctVoucherLines .acct-line-amt[data-idx="' + idx + '"][data-field="' + other + '"]');
            if (oEl) oEl.value = '';
        }
        acctUpdateBalance();
    });

    // Keyboard flow (owner spec). Native Tab walks Ledger → Debit → Credit → next row
    // (the ✕ delete buttons are tabindex=-1 so they're skipped). The ONLY special key
    // is on the LAST number field (the last row's Credit): Tab/Enter there adds a new
    // line while UNBALANCED, or jumps to Narration once the voucher ties. There is no
    // "Add line" button. Enter elsewhere is a convenience "advance".
    function focusNarr() { var n = document.getElementById('acctVoucherNarration'); if (n) n.focus(); }
    inp.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== 'Tab') return;
        if (e.key === 'Tab' && e.shiftKey) return;                  // shift-tab = native back
        var isLastCredit = (field === 'credit' && idx === acctVoucherLines.length - 1);
        if (e.key === 'Tab') {
            if (!isLastCredit) return;                              // native tab everywhere else
            e.preventDefault();
            if (acctVoucherIsBalanced()) focusNarr(); else acctAddVoucherLine(true);
            return;
        }
        // Enter
        e.preventDefault();
        if (acctVoucherIsBalanced()) { focusNarr(); return; }
        if (field === 'debit') {
            var cr = document.querySelector('#acctVoucherLines .acct-line-amt[data-idx="' + idx + '"][data-field="credit"]');
            if (cr) { cr.focus(); cr.select(); }
            return;
        }
        if (idx === acctVoucherLines.length - 1) { acctAddVoucherLine(true); return; }
        var nextLed = document.querySelector('#acctVoucherLines tr[data-idx="' + (idx + 1) + '"] .acct-line-ledger');
        if (nextLed) nextLed.focus();
    });
}

function acctRenderVoucherLines() {
    var tb = document.getElementById('acctVoucherLines');
    if (!tb) return;
    acctVoucherDdCtrls = {};

    // Read-only (auto / PMS-trade voucher): static rows, no pickers, no delete.
    if (acctVoucherReadOnly) {
        tb.innerHTML = acctVoucherLines.map(function (ln) {
            var nm = ln.ledgerId ? acctLedgerName(ln.ledgerId) : (ln.ledgerName || '');
            var note = ln.narration ? '<div class="acct-line-bal">' + wmsEsc(ln.narration) + '</div>' : '';
            return '<tr class="acct-line-ro">' +
                '<td>' + wmsEsc(nm) + note + '</td>' +
                '<td class="text-right">' + (acctParse(ln.debit) ? acctNum(acctParse(ln.debit)) : '') + '</td>' +
                '<td class="text-right">' + (acctParse(ln.credit) ? acctNum(acctParse(ln.credit)) : '') + '</td>' +
                '<td></td></tr>';
        }).join('');
        acctUpdateBalance();
        return;
    }

    acctSyncAutoLine();

    tb.innerHTML = acctVoucherLines.map(function (ln, idx) {
        var nm = ln.ledgerId ? acctLedgerName(ln.ledgerId) : (ln.ledgerName || '');
        var autoCls = ln._auto ? ' acct-auto' : '';
        var legNarr = acctVoucherShowLegNarr
            ? '<div class="acct-line-narr"><input type="text" class="acct-line-narr-inp wms-input" data-idx="' + idx + '" placeholder="Line note…" value="' + wmsEsc(ln.narration || '') + '"></div>'
            : '';
        return '<tr data-idx="' + idx + '">' +
            '<td><div class="acct-line-pick">' +
                '<input type="text" class="acct-line-ledger" data-idx="' + idx + '" value="' + wmsEsc(nm) + '" placeholder="Search ledger…" autocomplete="off">' +
                '<div class="wms-dd acct-line-dd" data-idx="' + idx + '"></div>' +
            '</div>' +
            '<div class="acct-line-bal" data-idx="' + idx + '"></div>' + legNarr + '</td>' +
            '<td class="text-right"><input type="text" class="acct-line-amt' + autoCls + '" data-idx="' + idx + '" data-field="debit" value="' + wmsEsc(ln.debit || '') + '"></td>' +
            '<td class="text-right"><input type="text" class="acct-line-amt' + autoCls + '" data-idx="' + idx + '" data-field="credit" value="' + wmsEsc(ln.credit || '') + '"></td>' +
            '<td><button class="acct-line-del" data-idx="' + idx + '" title="Remove line" tabindex="-1">✕</button></td></tr>';
    }).join('');

    tb.querySelectorAll('.acct-line-ledger').forEach(acctWireLedgerCell);
    tb.querySelectorAll('.acct-line-amt').forEach(acctWireAmountCell);
    tb.querySelectorAll('.acct-line-narr-inp').forEach(function (inp) {
        inp.addEventListener('input', function () { acctVoucherLines[Number(inp.dataset.idx)].narration = inp.value; });
    });
    tb.querySelectorAll('.acct-line-del').forEach(function (b) {
        b.onclick = function () {
            if (acctVoucherLines.length <= 2) { acctToast('A voucher needs at least two lines.', true); return; }
            acctVoucherLines.splice(Number(b.dataset.idx), 1);
            acctRenderVoucherLines();
        };
    });
    acctUpdateBalance();
}

/* Push the recomputed auto-balance amount into the DOM. acctSyncAutoLine only
   updates the model; without this the pre-filled line stays blank until the next
   full re-render. Never touches the field the user is currently typing in. */
function acctPaintAutoLine() {
    if (acctVoucherLines.length < 2) return;
    var idx = acctVoucherLines.length - 1;
    var last = acctVoucherLines[idx];
    if (!last._auto) return;
    ['debit', 'credit'].forEach(function (f) {
        var el = document.querySelector('#acctVoucherLines .acct-line-amt[data-idx="' + idx + '"][data-field="' + f + '"]');
        if (!el || el === document.activeElement) return;
        el.value = last[f] ? acctNum(acctParse(last[f])) : '';
        el.classList.add('acct-auto');
    });
}

function acctUpdateBalance() {
    acctSyncAutoLine();
    acctPaintAutoLine();
    acctPaintLineBalances();
    var td = 0, tc = 0;
    acctVoucherLines.forEach(function (l) { td += acctParse(l.debit); tc += acctParse(l.credit); });
    var balanced = acctVoucherIsBalanced();
    var diff = Math.round((td - tc) * 100) / 100;

    // Totals sit under the Debit/Credit columns (aligned), full rupees.
    var dEl = document.getElementById('acctTotalDebit'); if (dEl) dEl.textContent = acctNum(td);
    var cEl = document.getElementById('acctTotalCredit'); if (cEl) cEl.textContent = acctNum(tc);
    var msg = document.getElementById('acctBalanceMsg');
    var diffEl = document.getElementById('acctVchDiff');
    if (msg) msg.textContent = balanced ? 'Balanced'
        : (Math.abs(diff) >= 0.005 ? 'Difference' : 'Enter at least two lines with a ledger');
    if (diffEl) diffEl.textContent = (!balanced && Math.abs(diff) >= 0.005)
        ? (acctNum(Math.abs(diff)) + ' ' + (diff > 0 ? 'Dr' : 'Cr')) : '';

    var grid = document.querySelector('#acctVoucherModal .acct-voucher-grid');
    if (grid) {
        grid.classList.toggle('acct-vch-balanced', balanced);
        grid.classList.toggle('acct-vch-unbalanced', !balanced && Math.abs(diff) >= 0.005);
    }
    var save = document.getElementById('acctVoucherSave');
    if (save) save.disabled = !balanced;
}

function acctOpenVoucherModal() {
    if (!acctBookId) { acctToast('Select a book first (enable accounting on an investor).', true); return; }
    acctEditingVoucherId = null;          // creating, not editing
    acctVoucherReadOnly = false;
    acctVoucherType = 'JOURNAL';          // all manual vouchers are journals now (no type picker)
    acctVoucherShowLegNarr = false;
    acctVoucherDateYmd = acctTodayYmd();
    acctVoucherLines = [
        { ledgerId: '', ledgerName: '', debit: '', credit: '', narration: '', _auto: false },
        { ledgerId: '', ledgerName: '', debit: '', credit: '', narration: '', _auto: true }
    ];
    acctLedgerPickTarget = null;

    document.getElementById('acctVoucherTitle').textContent = 'New Voucher — ' + acctInvName(acctBookId);
    document.getElementById('acctVoucherNarration').value = '';
    var lnt = document.getElementById('acctLegNarrToggle'); if (lnt) lnt.classList.remove('on');

    // Date widget (now in the modal header).
    var dc = document.getElementById('acctVoucherDate');
    if (dc && typeof wmsDateInput === 'function') {
        wmsDateInput(dc, { compact: true, onChange: function (ymd) { acctVoucherDateYmd = ymd; } });
    }

    acctRenderVoucherLines();
    acctApplyVoucherReadOnly(false);      // fresh voucher is always editable
    if (acctVoucherModalCtrl) acctVoucherModalCtrl.open();
    // Land the caret on the first ledger field (dropdown stays closed until typing).
    setTimeout(function () {
        var first = document.querySelector('#acctVoucherLines .acct-line-ledger');
        if (first) first.focus();
    }, 60);
}

// Add a balancing line to the chosen ledger so the voucher ties (opening balances).
function acctAutoBalance() {
    var td = 0, tc = 0;
    acctVoucherLines.forEach(function (l) { td += acctParse(l.debit); tc += acctParse(l.credit); });
    var diff = Math.round((td - tc) * 100) / 100;
    if (Math.abs(diff) < 0.005) { acctToast('Already balanced.'); return; }
    var balSel = document.getElementById('acctBalanceLedger');
    var ledgerId = balSel ? balSel.value : '';
    if (!ledgerId) { acctToast('Pick a ledger to balance to.', true); return; }
    acctVoucherLines.push({ ledgerId: ledgerId, debit: diff < 0 ? String(Math.abs(diff)) : '', credit: diff > 0 ? String(diff) : '' });
    acctRenderVoucherLines();
}

/* Delete the voucher being edited. Uses acct_cancel_voucher (soft withdrawal): the
   row is kept for the audit trail and its number is not reused — a hard delete would
   collide the next post (voucher numbering is gap-sensitive). */
async function acctDeleteVoucher() {
    if (!acctEditingVoucherId || acctVoucherReadOnly) return;
    if (!confirm('Delete this voucher? It is withdrawn (cancelled) and kept in the audit trail.')) return;
    var vid = acctEditingVoucherId;
    try {
        var resp = await fetch(acctUrl('rpc/acct_cancel_voucher'), {
            method: 'POST',
            headers: wmsHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ p_voucher_id: vid, p_reason: 'Deleted from the voucher modal' })
        });
        if (!resp.ok) throw new Error((await resp.text()) || ('HTTP ' + resp.status));
        acctEditingVoucherId = null;
        if (acctVoucherModalCtrl) acctVoucherModalCtrl.close();
        acctToast('Voucher deleted.');
        await acctLoadBook();
        acctRenderActiveTab();
        if (acctLedgerModalCtrl && acctLedgerModalCtrl.isOpen()) acctRenderLedgerDetail();
    } catch (e) {
        console.error('[accounting] delete voucher failed', e);
        acctToast('Could not delete voucher: ' + e.message, true);
    }
}

async function acctSaveVoucher() {
    if (!acctBookId || acctVoucherReadOnly) return;   // auto vouchers are view-only
    var lines = acctVoucherLines.filter(function (l) { return acctParse(l.debit) > 0 || acctParse(l.credit) > 0; })
        .map(function (l, i) {
            return {
                ledger_id: l.ledgerId,
                debit_amount: wmsRoundMoney(acctParse(l.debit)),
                credit_amount: wmsRoundMoney(acctParse(l.credit)),
                narration: (l.narration || '').trim() || null,
                sort_order: i
            };
        });
    if (lines.some(function (l) { return !l.ledger_id; })) { acctToast('Every line needs a ledger.', true); return; }

    var header = {
        investor_id: acctBookId,
        voucher_type: acctVoucherType,
        voucher_date: acctVoucherDateYmd || acctTodayYmd(),
        narration: document.getElementById('acctVoucherNarration').value.trim()
    };

    var saveBtn = document.getElementById('acctVoucherSave');
    if (saveBtn) saveBtn.disabled = true;
    try {
        if (acctEditingVoucherId) {
            /* No update RPC exists, and delete+repost is NOT an option:
               acct_post_voucher numbers vouchers COUNT(*)+1 within (book, family,
               FY) and there is a unique index on (investor_id, voucher_number),
               so removing a mid-sequence voucher makes the next post collide.
               Editing therefore keeps the voucher row (and its number) and
               replaces its lines. Lines are deleted before insert: the failure
               mode is a visibly empty voucher that can be re-saved, rather than
               duplicated lines which would silently corrupt every balance. */
            var vid = acctEditingVoucherId;

            // Prefer the atomic RPC (migration 50). Fall back to the three-call
            // path only while that migration has not been run — PostgREST answers
            // 404 for an unknown function.
            var rpc = await fetch(acctUrl('rpc/acct_update_voucher'), {
                method: 'POST',
                headers: wmsHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ p_voucher_id: vid, p_header: header, p_lines: lines })
            });
            if (rpc.ok) {
                acctEditingVoucherId = null;
                if (acctVoucherModalCtrl) acctVoucherModalCtrl.close();
                acctToast('Voucher updated.');
                await acctLoadBook();
                acctRenderActiveTab();
                return;
            }
            if (rpc.status !== 404) throw new Error((await rpc.text()) || ('HTTP ' + rpc.status));

            var delR = await fetch(acctUrl('acct_voucher_lines?voucher_id=eq.' + vid),
                { method: 'DELETE', headers: wmsHeaders({ 'Prefer': 'return=minimal' }) });
            if (!delR.ok) throw new Error('Could not clear old lines: ' + (await delR.text()));

            var insR = await fetch(acctUrl('acct_voucher_lines'), {
                method: 'POST',
                headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
                body: JSON.stringify(lines.map(function (l) {
                    return { voucher_id: vid, ledger_id: l.ledger_id,
                             debit_amount: l.debit_amount, credit_amount: l.credit_amount,
                             narration: l.narration, sort_order: l.sort_order };
                }))
            });
            if (!insR.ok) throw new Error('Lines not saved — this voucher now has none; re-open and save again. ' + (await insR.text()));

            var totD = lines.reduce(function (a, l) { return a + l.debit_amount; }, 0);
            var totC = lines.reduce(function (a, l) { return a + l.credit_amount; }, 0);
            var patchR = await fetch(acctUrl('acct_vouchers?id=eq.' + vid), {
                method: 'PATCH',
                headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
                body: JSON.stringify({
                    voucher_type: header.voucher_type, voucher_date: header.voucher_date,
                    narration: header.narration,
                    total_debit: wmsRoundMoney(totD), total_credit: wmsRoundMoney(totC)
                })
            });
            if (!patchR.ok) throw new Error('Header not updated: ' + (await patchR.text()));

            acctEditingVoucherId = null;
            if (acctVoucherModalCtrl) acctVoucherModalCtrl.close();
            acctToast('Voucher updated.');
            await acctLoadBook();
            acctRenderActiveTab();
            if (acctLedgerModalCtrl && acctLedgerModalCtrl.isOpen()) acctRenderLedgerDetail();
            return;
        }

        // Opening balance is ONE voucher per book — replace any existing one.
        if (acctVoucherType === 'OPENING_BALANCE') {
            await fetch(acctUrl('acct_vouchers?investor_id=eq.' + acctBookId + '&voucher_type=eq.OPENING_BALANCE'),
                { method: 'DELETE', headers: wmsHeaders({ 'Prefer': 'return=minimal' }) });
        }
        var resp = await fetch(acctUrl('rpc/acct_post_voucher'), {
            method: 'POST',
            headers: wmsHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ p_header: header, p_lines: lines })
        });
        if (!resp.ok) {
            var errTxt = await resp.text();
            throw new Error(errTxt || ('HTTP ' + resp.status));
        }
        var result = await resp.json();
        if (acctVoucherModalCtrl) acctVoucherModalCtrl.close();
        acctToast('Voucher ' + (result && result.voucher_number ? result.voucher_number : '') + ' posted.');
        await acctLoadBook();
        acctRenderActiveTab();
        if (acctLedgerModalCtrl && acctLedgerModalCtrl.isOpen()) acctRenderLedgerDetail();
    } catch (e) {
        console.error('[accounting] post voucher failed', e);
        acctToast('Could not post voucher: ' + e.message, true);
        if (saveBtn) saveBtn.disabled = false;
    }
}

// ============================================================================
// Ledger-detail modal
// ============================================================================
var acctLedgerDetailId = null;
// Date filter for the ledger-detail modal only (per owner 2026-08-17). Persisted so
// the choice survives across sessions.  mode: 'all' | 'fy' | 'custom'.  For 'fy',
// fyStart = the FY's starting calendar year (null ⇒ the CURRENT FY, resolved live so
// it stays "current" as years roll); qtr = 0 (full year) or 1..4. DEFAULT = current FY.
var acctLedgerDateFilter = { mode: 'fy', fyStart: null, qtr: 0, from: '', to: '' };
var ACCT_LD_FILTER_KEY = 'wms_acct_ledger_datefilter_v2';
try { var _ldf = JSON.parse(localStorage.getItem(ACCT_LD_FILTER_KEY) || 'null'); if (_ldf && typeof _ldf === 'object') acctLedgerDateFilter = Object.assign(acctLedgerDateFilter, _ldf); } catch (e) {}
function acctSaveLedgerDateFilter() { try { localStorage.setItem(ACCT_LD_FILTER_KEY, JSON.stringify(acctLedgerDateFilter)); } catch (e) {} }
// Show/hide cancelled vouchers in the drill-down (persistent). Default: hidden.
var ACCT_LD_CANCELLED_KEY = 'wms_acct_ledger_show_cancelled';
var acctLedgerShowCancelled = false;
try { acctLedgerShowCancelled = localStorage.getItem(ACCT_LD_CANCELLED_KEY) === '1'; } catch (e) {}
function acctSetShowCancelled(v) { acctLedgerShowCancelled = !!v; try { localStorage.setItem(ACCT_LD_CANCELLED_KEY, v ? '1' : '0'); } catch (e) {} }
// Live search within the ledger drill-down (not persisted — resets per open).
var acctLedgerSearchText = '';
var acctLedgerRangePopOpen = false;   // custom From–To popover open state

/** FY start month for the active book (financial_year_start, default 4 = April). */
function acctLedgerFyStartMonth() {
    var inv = (wmsRefData && wmsRefData.investors || []).find(function (i) { return i.id === acctBookId; });
    return (inv && Number(inv.financial_year_start)) || 4;
}
/** The starting calendar year of the FY that contains today. */
function acctCurrentFyStartYear() {
    var m = acctLedgerFyStartMonth(), t = new Date();
    return (t.getMonth() + 1) >= m ? t.getFullYear() : t.getFullYear() - 1;
}
function acctFyLabel(y) { return y + '-' + String((y + 1) % 100).padStart(2, '0'); }
function _acctYmd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
/** Returns {start, end} inclusive ymd strings (or null for unbounded) for the current filter. */
function acctLedgerDateWindow() {
    var f = acctLedgerDateFilter;
    if (f.mode === 'custom') return { start: f.from || null, end: f.to || null };
    if (f.mode === 'fy') {
        var m = acctLedgerFyStartMonth(), y = f.fyStart || acctCurrentFyStartYear();
        if (f.qtr >= 1 && f.qtr <= 4) {
            var qs = new Date(y, (m - 1) + (f.qtr - 1) * 3, 1);
            var qe = new Date(y, (m - 1) + f.qtr * 3, 1); qe.setDate(qe.getDate() - 1);
            return { start: _acctYmd(qs), end: _acctYmd(qe) };
        }
        var fs = new Date(y, m - 1, 1);
        var fe = new Date(y + 1, m - 1, 1); fe.setDate(fe.getDate() - 1);
        return { start: _acctYmd(fs), end: _acctYmd(fe) };
    }
    return { start: null, end: null };
}

function acctOpenLedgerDetail(ledgerId) {
    acctLedgerDetailId = ledgerId;
    acctLedgerSearchText = '';          // search must NOT carry over to another ledger
    acctLedgerRangePopOpen = false;
    acctRenderLedgerDetail();
    if (acctLedgerModalCtrl) acctLedgerModalCtrl.open();
}

/** All voucher lines grouped by voucher_id — used to name the contra (other-side) ledger. */
function acctLinesByVoucher() {
    var byV = {};
    acctVoucherRows.forEach(function (r) { (byV[r.voucher_id] = byV[r.voucher_id] || []).push(r); });
    return byV;
}
/** The other-side ledger label for one line: the opposite ledger if 2-leg, else "Multi-leg". */
function acctContraLabel(row, byV) {
    var legs = byV[row.voucher_id] || [];
    var others = legs.filter(function (l) { return l.ledger_id !== row.ledger_id; });
    // Distinct other ledgers (a voucher can post two lines to the same contra).
    var ids = {}; others.forEach(function (l) { ids[l.ledger_id] = true; });
    var keys = Object.keys(ids);
    if (keys.length === 0) return '—';
    if (keys.length === 1) return acctLedgerName(keys[0]);
    return 'Multi-leg (' + keys.length + ')';
}

// Rendering is split in two so that live search (rapid typing) only re-renders the
// TABLE, never the filter bar — the search <input> is built once and keeps its focus
// and caret. The head + filter bar are rebuilt only on structural changes (period,
// quarter, cancelled toggle, unit toggle).
function acctRenderLedgerDetail() {
    var lg = acctLedgers.find(function (x) { return x.id === acctLedgerDetailId; });
    if (!lg) return;
    var body = document.getElementById('acctLedgerDetailBody');
    var g = acctGroupById[lg.group_id];
    var baseUnit = (typeof getUnitDescription === 'function' ? getUnitDescription() : "₹ '000");

    // The ledger name, group path and the unit control now live in the modal HEADER
    // row (before the ✕) so the body is all real content. The unit toggle drives the
    // MODULE-WIDE full-amount setting, so switching here also switches the tabs behind.
    var titleEl = document.getElementById('acctLedgerTitle');
    if (titleEl) titleEl.textContent = lg.name;
    var subEl = document.getElementById('acctLedgerSub');
    if (subEl) subEl.textContent = acctGroupPath(g) + ' · ' + acctViewTitle();
    var unitEl = document.getElementById('acctLedgerUnit');
    if (unitEl) unitEl.textContent = acctUnitLabel();
    var tgl = document.getElementById('acctLdUnitToggle');
    if (tgl) {
        tgl.textContent = acctFullAmt ? ('Show in ' + baseUnit) : 'Show full amount';
        tgl.onclick = function () { acctSetFullAmt(!acctFullAmt); acctRenderLedgerDetail(); acctRenderActiveTab(); acctSyncUnitToggle(); };
    }

    body.innerHTML = acctLedgerDateFilterBar() + '<div id="acctLdTableWrap"></div>';
    acctWireLedgerDateFilter();
    acctRenderLedgerTable();
}

/** Builds just the ledger lines table into #acctLdTableWrap (called on every search keystroke). */
function acctRenderLedgerTable() {
    var wrap = document.getElementById('acctLdTableWrap');
    if (!wrap) return;
    var allRows = acctVoucherRows.filter(function (r) { return r.ledger_id === acctLedgerDetailId; })
        .slice().sort(function (a, b) {
            if (a.voucher_date !== b.voucher_date) return a.voucher_date < b.voucher_date ? -1 : 1;
            return String(a.voucher_number).localeCompare(String(b.voucher_number));
        });
    var byV = acctLinesByVoucher();
    var fmt = acctAmt;   // honours the module-wide full-amount toggle

    var win = acctLedgerDateWindow();
    var opening = 0, rows = [];
    allRows.forEach(function (r) {
        if (win.start && r.voucher_date < win.start) {
            if (acctIsLive(r)) opening += (Number(r.debit_amount) || 0) - (Number(r.credit_amount) || 0);
            return;
        }
        if (win.end && r.voucher_date > win.end) return;
        rows.push(r);
    });

    var q = (acctLedgerSearchText || '').trim().toLowerCase();
    function rowMatches(r, contra) {
        if (!q) return true;
        var hay = (contra + ' ' + (r.line_narration || r.voucher_narration || '') + ' ' +
            acctFmtDate(r.voucher_date) + ' ' + (r.voucher_date || '') + ' ' + (r.voucher_number || '')).toLowerCase();
        return hay.indexOf(q) >= 0;
    }

    var html;
    if (!allRows.length) {
        html = '<div class="acct-empty">No postings in this book.</div>';
    } else {
        var running = win.start ? opening : 0;
        var shown = 0;
        html = '<table class="acct-table acct-ld-table"><thead><tr>' +
            '<th class="c-date">Date</th><th class="c-vch">Vch #</th><th class="c-contra">Contra ledger</th>' +
            '<th>Narration</th><th class="text-right c-amt">Debit</th><th class="text-right c-amt">Credit</th>' +
            '<th class="text-right c-amt">Balance</th></tr></thead><tbody>';
        // Only show the "brought forward" opening row when it is actually non-zero.
        // For the current FY nothing predates the period start, so the carry-forward
        // is 0 and would just duplicate the real Opening-Balance voucher below it.
        if (win.start && !q && Math.round(opening * 100) !== 0) {
            html += '<tr class="acct-ld-opening"><td class="c-date">' + wmsEsc(acctFmtDate(win.start)) + '</td><td class="c-vch">—</td>' +
                '<td colspan="2"><em>Opening balance</em></td><td class="text-right">-</td><td class="text-right">-</td>' +
                '<td class="text-right">' + fmt(Math.abs(opening)) + (opening >= 0 ? ' Dr' : ' Cr') + '</td></tr>';
        }
        rows.forEach(function (r) {
            var live = acctIsLive(r);
            if (live) running += (Number(r.debit_amount) || 0) - (Number(r.credit_amount) || 0);
            // Display filters (running balance already accounts for every live row above):
            if (!live && !acctLedgerShowCancelled) return;   // cancelled hidden unless toggled on
            var contra = acctContraLabel(r, byV);
            if (!rowMatches(r, contra)) return;
            shown++;
            var balLabel = live ? fmt(Math.abs(running)) + (running >= 0 ? ' Dr' : ' Cr') : '—';
            var auto = !!r.is_auto;
            var tip = !live ? 'Cancelled' + (r.cancel_reason ? ' — ' + r.cancel_reason : '') + ' · excluded from balances'
                    : auto ? 'Auto-posted from a PMS trade — opens view-only; edit the trade, then Rebuild'
                           : 'Click to edit this voucher';
            html += '<tr class="acct-vch-row' + (auto ? ' acct-vch-auto' : '') + (live ? '' : ' acct-vch-cancelled') +
                '" data-voucher="' + r.voucher_id + '" title="' + wmsEsc(tip) + '">' +
                '<td class="c-date">' + wmsEsc(acctFmtDate(r.voucher_date)) + '</td>' +
                '<td class="c-vch">' + wmsEsc(r.voucher_number) +
                    (auto ? ' <span class="acct-kind-badge">auto</span>' : '') +
                    (live ? '' : ' <span class="acct-scope-badge">cancelled</span>') + '</td>' +
                '<td class="c-contra">' + wmsEsc(contra) + '</td>' +
                '<td>' + wmsEsc(r.line_narration || r.voucher_narration || '') + '</td>' +
                '<td class="text-right">' + (Number(r.debit_amount) ? fmt(Number(r.debit_amount)) : '-') + '</td>' +
                '<td class="text-right">' + (Number(r.credit_amount) ? fmt(Number(r.credit_amount)) : '-') + '</td>' +
                '<td class="text-right">' + balLabel + '</td></tr>';
        });
        if (!shown) {
            html += '<tr><td colspan="7" class="acct-empty" style="padding:16px;">' +
                (q ? 'No lines match &ldquo;' + wmsEsc(acctLedgerSearchText) + '&rdquo;.' : 'No postings in the selected period.') + '</td></tr>';
        }
        html += '</tbody></table>';
    }
    wrap.innerHTML = html;
    wrap.querySelectorAll('.acct-vch-row[data-voucher]').forEach(function (tr) {
        tr.onclick = function () { acctOpenEditVoucher(tr.dataset.voucher); };
    });
}

/** The date-filter + search control strip inside the ledger modal. From/To live in a
 *  compact popover (like the Transactions page) so they don't eat a whole row. */
function acctLedgerDateFilterBar() {
    var f = acctLedgerDateFilter;
    var cur = acctCurrentFyStartYear();
    var effFy = (f.mode === 'fy') ? (f.fyStart || cur) : null;   // null fyStart ⇒ current FY
    var fyOpts = '';
    for (var i = 0; i < 4; i++) {
        var y = cur - i;
        var sel = (effFy === y) ? ' selected' : '';
        fyOpts += '<option value="fy:' + y + '"' + sel + '>FY ' + acctFyLabel(y) + (i === 0 ? ' (current)' : i === 1 ? ' (previous)' : '') + '</option>';
    }
    var allSel = f.mode === 'all' ? ' selected' : '';
    var customSel = f.mode === 'custom' ? ' selected' : '';
    var qDisabled = f.mode === 'fy' ? '' : ' disabled';
    function qSel(v) { return (f.mode === 'fy' && f.qtr === v) ? ' selected' : ''; }

    // Custom From–To: a single button that opens a popover; only shown in custom mode.
    // Uses the shared segmented wmsDateInput widgets (D.5.4), not native date inputs.
    var rangeHtml = '';
    if (f.mode === 'custom') {
        var rlabel = (f.from || f.to) ? ((f.from ? acctFmtDate(f.from) : '…') + ' → ' + (f.to ? acctFmtDate(f.to) : '…')) : 'Pick dates';
        rangeHtml = '<span class="acct-ld-range-wrap">' +
            '<button id="acctLdRangeBtn" class="wms-btn wms-btn-secondary" title="Set a custom date range">📅 ' + wmsEsc(rlabel) + ' ▾</button>' +
            '<div id="acctLdRangePop" class="acct-ld-range-pop' + (acctLedgerRangePopOpen ? ' show' : '') + '">' +
                '<label>From</label><div id="acctLdFromWrap"></div>' +
                '<label>To</label><div id="acctLdToWrap"></div>' +
            '</div></span>';
    }

    // Cancelled toggle as a compact icon (⊘), highlighted when cancelled are shown.
    var cancelBtn = '<button id="acctLdCancelledBtn" class="acct-ld-icon-btn' + (acctLedgerShowCancelled ? ' on' : '') + '" ' +
        'title="' + (acctLedgerShowCancelled ? 'Hide cancelled vouchers' : 'Show cancelled vouchers') + '">⊘</button>';

    return '<div class="acct-ld-filter">' +
        '<label>Period</label>' +
        '<select id="acctLdPeriod" class="wms-input">' +
            '<option value="all"' + allSel + '>All dates</option>' +
            fyOpts +
            '<option value="custom"' + customSel + '>Custom…</option>' +
        '</select>' +
        '<label>Quarter</label>' +
        '<select id="acctLdQtr" class="wms-input"' + qDisabled + '>' +
            '<option value="0"' + qSel(0) + '>Full year</option>' +
            '<option value="1"' + qSel(1) + '>Q1</option>' +
            '<option value="2"' + qSel(2) + '>Q2</option>' +
            '<option value="3"' + qSel(3) + '>Q3</option>' +
            '<option value="4"' + qSel(4) + '>Q4</option>' +
        '</select>' +
        rangeHtml +
        cancelBtn +
        '<input type="text" id="acctLdSearch" class="wms-input acct-ld-search" placeholder="Search ledger, narration, date…" value="' + wmsEsc(acctLedgerSearchText) + '">' +
    '</div>';
}

function acctWireLedgerDateFilter() {
    var p = document.getElementById('acctLdPeriod');
    if (p) p.onchange = function () {
        var v = p.value;
        if (v === 'all') { acctLedgerDateFilter.mode = 'all'; }
        else if (v === 'custom') {
            acctLedgerDateFilter.mode = 'custom'; acctLedgerRangePopOpen = true;
            // Seed an empty custom range with the current FY so the segmented widgets
            // open on meaningful dates instead of an arbitrary default.
            if (!acctLedgerDateFilter.from && !acctLedgerDateFilter.to) {
                var mm = acctLedgerFyStartMonth(), yy = acctCurrentFyStartYear();
                var fs = new Date(yy, mm - 1, 1), fe = new Date(yy + 1, mm - 1, 1); fe.setDate(fe.getDate() - 1);
                acctLedgerDateFilter.from = _acctYmd(fs); acctLedgerDateFilter.to = _acctYmd(fe);
            }
        }
        else if (v.indexOf('fy:') === 0) { acctLedgerDateFilter.mode = 'fy'; acctLedgerDateFilter.fyStart = Number(v.slice(3)); }
        acctSaveLedgerDateFilter(); acctRenderLedgerDetail();
    };
    var q = document.getElementById('acctLdQtr');
    if (q) q.onchange = function () { acctLedgerDateFilter.qtr = Number(q.value); acctSaveLedgerDateFilter(); acctRenderLedgerDetail(); };
    // From/To popover — toggle on the button, apply on change (table-only re-render so the popover stays put).
    var rbtn = document.getElementById('acctLdRangeBtn');
    var rpop = document.getElementById('acctLdRangePop');
    if (rbtn && rpop) {
        rbtn.onclick = function (e) { e.stopPropagation(); acctLedgerRangePopOpen = !acctLedgerRangePopOpen; rpop.classList.toggle('show', acctLedgerRangePopOpen); };
        rpop.onclick = function (e) { e.stopPropagation(); };
    }
    // Segmented dd-mmm-yyyy widgets (shared wmsDateInput, per UI-STANDARDS D.5.4).
    var frWrap = document.getElementById('acctLdFromWrap');
    var toWrap = document.getElementById('acctLdToWrap');
    if (frWrap && toWrap && typeof wmsDateInput === 'function') {
        var rangeReady = false;   // suppress the onChange that setValue() fires during seeding
        var frCtrl = wmsDateInput(frWrap, { compact: true, onChange: function (ymd) {
            if (!rangeReady) return;
            acctLedgerDateFilter.from = ymd || ''; acctSaveLedgerDateFilter(); acctRenderLedgerTable(); acctLedgerUpdateRangeLabel();
        } });
        var toCtrl = wmsDateInput(toWrap, { compact: true, onChange: function (ymd) {
            if (!rangeReady) return;
            acctLedgerDateFilter.to = ymd || ''; acctSaveLedgerDateFilter(); acctRenderLedgerTable(); acctLedgerUpdateRangeLabel();
        } });
        if (acctLedgerDateFilter.from && frCtrl.setValue) frCtrl.setValue(acctLedgerDateFilter.from);
        if (acctLedgerDateFilter.to && toCtrl.setValue) toCtrl.setValue(acctLedgerDateFilter.to);
        rangeReady = true;
    }
    var cb = document.getElementById('acctLdCancelledBtn');
    if (cb) cb.onclick = function () { acctSetShowCancelled(!acctLedgerShowCancelled); acctRenderLedgerDetail(); };
    var sr = document.getElementById('acctLdSearch');
    // Live search: only the TABLE re-renders, so this input keeps its focus + caret.
    if (sr) sr.oninput = function () { acctLedgerSearchText = sr.value; acctRenderLedgerTable(); };
}

/** Refresh the custom-range button label after a date change (table-only re-render). */
function acctLedgerUpdateRangeLabel() {
    var btn = document.getElementById('acctLdRangeBtn');
    if (!btn) return;
    var f = acctLedgerDateFilter;
    var rlabel = (f.from || f.to) ? ((f.from ? acctFmtDate(f.from) : '…') + ' → ' + (f.to ? acctFmtDate(f.to) : '…')) : 'Pick dates';
    btn.innerHTML = '📅 ' + wmsEsc(rlabel) + ' ▾';
}

// Close the custom-range popover on an outside click.
if (!window.__acctLdRangeDismissWired) {
    window.__acctLdRangeDismissWired = true;
    document.addEventListener('click', function (e) {
        var pop = document.getElementById('acctLdRangePop');
        if (pop && pop.classList.contains('show') && !e.target.closest('.acct-ld-range-wrap')) {
            pop.classList.remove('show'); acctLedgerRangePopOpen = false;
        }
    });
}

/* Edit an existing manual voucher. Auto vouchers are refused: they belong to the
   posting engine and Rebuild would silently overwrite any change made here. */
function acctOpenEditVoucher(voucherId) {
    var rows = acctVoucherRows.filter(function (r) { return r.voucher_id === voucherId; });
    if (!rows.length) return;
    if (!acctIsLive(rows[0])) {
        acctToast('“' + rows[0].voucher_number + '” is cancelled. It is kept for the audit trail and cannot be edited.', true);
        return;
    }
    // Opening balances are edited only through the ⚖ Opening Balances tool, which
    // owns the single-voucher-per-book rule AND auto-plugs any gap to the
    // "Difference in Opening Balance" line. Editing them in the generic voucher
    // modal is a foot-gun: deleting the plug line unbalances the voucher and Save
    // (which requires Dr = Cr) then refuses it. Redirect instead.
    if (rows[0].voucher_type === 'OPENING_BALANCE') {
        acctToast('Opening balances are edited from “⚖ Opening Balances” — it fills any gap for you. Opening it now…', false);
        if (acctLedgerModalCtrl) acctLedgerModalCtrl.close();
        acctOpenOpeningModal();
        return;
    }
    // Auto (PMS-trade) vouchers open VIEW-ONLY — shown greyed with a note that they
    // can only be changed by editing the underlying trade and rebuilding. Manual
    // vouchers stay fully editable.
    var readOnly = !!rows[0].is_auto;
    // Leave the ledger-detail modal OPEN underneath: the voucher modal layers on
    // top (wmsModal stack raises its z-index) so closing it steps back to the
    // ledger, not to the main screen.

    acctVoucherReadOnly = readOnly;
    acctEditingVoucherId = readOnly ? null : voucherId;   // never Save-path an auto voucher
    acctVoucherType = rows[0].voucher_type;               // preserve the existing type on edit
    acctVoucherDateYmd = rows[0].voucher_date;
    acctLedgerPickTarget = null;
    var vNarr = rows[0].voucher_narration || '';
    acctVoucherLines = rows
        .slice()
        .sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); })
        .map(function (r) {
            var d = Number(r.debit_amount) || 0, c = Number(r.credit_amount) || 0;
            // acct_voucher_full.line_narration COALESCEs to the voucher narration when a
            // line has no note of its own — so only treat it as a real per-leg note when
            // it differs from the voucher narration. Otherwise it's the header narration
            // bleeding through and must NOT be shown on every line.
            var ln = (r.line_narration && r.line_narration !== vNarr) ? r.line_narration : '';
            return { ledgerId: r.ledger_id, ledgerName: acctLedgerName(r.ledger_id),
                     debit: d ? String(d) : '', credit: c ? String(c) : '',
                     narration: ln, _auto: false };
        });
    // Reveal the per-leg narration fields only if a line has a genuine, distinct note.
    acctVoucherShowLegNarr = acctVoucherLines.some(function (l) { return l.narration; });

    document.getElementById('acctVoucherTitle').textContent = (readOnly ? 'View Voucher ' : 'Edit Voucher ') + rows[0].voucher_number + ' — ' + acctInvName(acctBookId);
    var lnt = document.getElementById('acctLegNarrToggle'); if (lnt) lnt.classList.toggle('on', acctVoucherShowLegNarr);
    document.getElementById('acctVoucherNarration').value = rows[0].voucher_narration || '';
    var dc = document.getElementById('acctVoucherDate');
    if (dc && typeof wmsDateInput === 'function') {
        var ctrl = wmsDateInput(dc, { compact: true, onChange: function (ymd) { acctVoucherDateYmd = ymd; } });
        if (ctrl && ctrl.setValue) ctrl.setValue(acctVoucherDateYmd);
    }
    acctRenderVoucherLines();
    acctApplyVoucherReadOnly(readOnly);
    if (acctVoucherModalCtrl) acctVoucherModalCtrl.open();
}

/* Toggle the voucher modal between edit and VIEW-ONLY. In view-only every control
   is disabled and a banner explains the voucher is driven by a PMS trade. */
function acctApplyVoucherReadOnly(ro) {
    var modal = document.getElementById('acctVoucherModal');
    if (modal) modal.classList.toggle('acct-voucher-ro', ro);
    var banner = document.getElementById('acctVoucherRoBanner');
    if (banner) banner.style.display = ro ? '' : 'none';
    var save = document.getElementById('acctVoucherSave');
    if (save) { save.style.display = ro ? 'none' : ''; save.disabled = ro; }
    // Delete only makes sense on an existing, editable (non-auto) voucher.
    var del = document.getElementById('acctVoucherDelete');
    if (del) del.style.display = (ro || !acctEditingVoucherId) ? 'none' : '';
    var nar = document.getElementById('acctVoucherNarration');
    if (nar) nar.disabled = ro;
    var lnt = document.getElementById('acctLegNarrToggle');
    if (lnt) lnt.style.display = ro ? 'none' : '';
    // Freeze the date widget in view-only.
    var dc = document.getElementById('acctVoucherDate');
    if (dc) dc.style.pointerEvents = ro ? 'none' : '';
}

// ============================================================================
// Shared expand / collapse controls (Balance Sheet, P&L, Trial Balance, Ledgers)
// ONE toggle (expand-all <-> collapse-all) + a Summary button (roots + 2 levels).
// ============================================================================
// Group's depth from its nature root: a nature root = 0, its child = 1, etc.
function acctGroupLevel(groupId) {
    var lvl = 0, g = acctGroupById[groupId], guard = 0;
    while (g && g.parent_group_id && guard < 30) { lvl++; g = acctGroupById[g.parent_group_id]; guard++; }
    return lvl;
}
// A collapse-map key -> group level. Synthetic wrapper keys (pl, cap, pl-inc…)
// carry no uuid and are treated as top-level (kept expanded by Summary).
function acctKeyLevel(key) {
    if (!key) return 0;
    var m = /:([0-9a-fA-F-]{36})$/.exec(key);
    return m ? acctGroupLevel(m[1]) : 0;
}
// The two shared control buttons. pfx namespaces the element ids per view.
function acctExpandCtrlHtml(pfx) {
    return '<button class="wms-btn wms-btn-secondary" id="' + pfx + 'Toggle" title="Expand or collapse everything">⇵ Collapse all</button>' +
        '<button class="wms-btn wms-btn-secondary" id="' + pfx + 'Summary" title="Show the roots and two levels, collapse the rest">▤ Summary</button>';
}
// Wire the toggle + summary. mapName: "fin" (BS/P&L/TB share acctFinCollapsed) or
// "led" (Ledgers catalogue = acctLedCollapsed). getKeys() returns the view's group
// keys; rerender() re-draws the view.
function acctWireExpandCtrl(pfx, getKeys, mapName, rerender) {
    function map() {
        if (mapName === 'led') { if (!acctLedCollapsed) acctLedCollapsed = {}; return acctLedCollapsed; }
        return acctFinCollapsed;
    }
    var t = document.getElementById(pfx + 'Toggle');
    if (t) {
        var keysNow = getKeys();
        var anyOpen = keysNow.some(function (k) { return !map()[k]; });
        t.innerHTML = anyOpen ? '⇵ Collapse all' : '⇵ Expand all';
        t.onclick = function () {
            var keys = getKeys(), m = map();
            var open = keys.some(function (k) { return !m[k]; });
            if (open) { keys.forEach(function (k) { m[k] = true; }); }      // collapse all
            else { keys.forEach(function (k) { delete m[k]; }); }           // expand all
            rerender();
        };
    }
    var s = document.getElementById(pfx + 'Summary');
    if (s) s.onclick = function () {
        var keys = getKeys(), m = map();
        keys.forEach(function (k) { if (acctKeyLevel(k) >= 2) m[k] = true; else delete m[k]; });
        rerender();
    };
}

// ============================================================================
// Reusable book-scope control — a compact "pills dropdown" (Global + own books),
// mirroring the Trading > Portfolio filter pills. Used by the bulk-add rows and
// the edit-ledger modal. value = { global:bool, bookIds:[uuid] }.
// ============================================================================
function acctBookScopeControl(host, initial, onChange) {
    var books = acctOwnBooks();
    var state = { global: true, bookIds: [] };
    if (initial) {
        state.bookIds = (initial.bookIds || []).slice();
        state.global = (initial.global !== false) && !state.bookIds.length;
        if (state.bookIds.length) state.global = false;
    }
    host.classList.add('acct-scope-ctrl');
    host.innerHTML = '<button type="button" class="acct-scope-btn"></button>' +
        '<div class="acct-scope-dd wms-pill-dropdown"></div>';
    var btn = host.querySelector('.acct-scope-btn');
    var dd = host.querySelector('.acct-scope-dd');
    function label() {
        if (state.global) return 'Global (all books)';
        if (!state.bookIds.length) return 'Select book(s)…';
        var names = state.bookIds.map(function (id) { var b = books.find(function (x) { return x.id === id; }); return b ? (b.short_name || b.name) : '?'; });
        return names.length <= 2 ? names.join(', ') : (names.slice(0, 2).join(', ') + ' +' + (names.length - 2));
    }
    function renderPills() {
        var h = '<span class="wms-pill acct-scope-pill' + (state.global ? ' on' : '') + '" data-g="1">Global</span>';
        books.forEach(function (b) {
            var on = !state.global && state.bookIds.indexOf(b.id) >= 0;
            h += '<span class="wms-pill acct-scope-pill' + (on ? ' on' : '') + '" data-book="' + b.id + '">' + wmsEsc(b.short_name || b.name) + '</span>';
        });
        dd.innerHTML = h;
    }
    function sync() { btn.textContent = label(); renderPills(); }
    btn.onclick = function (e) { e.stopPropagation(); dd.classList.toggle('show'); };
    dd.onclick = function (e) {
        var p = e.target.closest ? e.target.closest('.acct-scope-pill') : null;
        if (!p) return;
        if (p.dataset.g) { state.global = true; state.bookIds = []; }
        else {
            state.global = false;
            var id = p.dataset.book, i = state.bookIds.indexOf(id);
            if (i >= 0) state.bookIds.splice(i, 1); else state.bookIds.push(id);
            if (!state.bookIds.length) state.global = true;
        }
        sync();
        if (onChange) onChange();
    };
    if (!host._acctScopeDocClose) {
        host._acctScopeDocClose = function (e) { if (!host.contains(e.target)) dd.classList.remove('show'); };
        document.addEventListener('mousedown', host._acctScopeDocClose);
    }
    sync();
    return {
        getValue: function () { return { global: state.global, bookIds: state.bookIds.slice() }; },
        setValue: function (v) { state.global = !!(v && v.global); state.bookIds = (v && v.bookIds || []).slice(); if (state.bookIds.length) state.global = false; sync(); }
    };
}

// Books (own-books) that have LIVE postings referencing a ledger — used to block a
// coverage change that would orphan those vouchers.
async function acctLedgerPostedBooks(ledgerId) {
    var rows = await wmsFetchAllRaw(acctUrl('acct_voucher_full?ledger_id=eq.' + ledgerId +
        '&is_cancelled=eq.false&select=investor_id')) || [];
    var set = {};
    rows.forEach(function (r) { if (r.investor_id) set[r.investor_id] = true; });
    return Object.keys(set);
}

// ============================================================================
// Combined bulk-add modal — one modal adds MANY ledgers OR groups under one
// chosen parent group. Radio picks ledgers (default) or groups. Tab off the last
// row's last field adds another row. Ledger rows carry a book-scope pills control.
// ============================================================================
var acctBulkModalCtrl = null;
var acctBulkKind = 'ledger';                // 'ledger' | 'group'
var acctBulkRows = [];                       // [{ name, scope:{global,bookIds} }]
var acctBulkScopeCtrls = {};                 // idx -> scope controller

function acctOpenBulkAdd() {
    acctBulkKind = 'ledger';
    acctBulkRows = [{ name: '', scope: { global: true, bookIds: [] } }];
    var parentSel = document.getElementById('acctBulkParent');
    if (parentSel) parentSel.innerHTML = acctGroupSelectOptions(null);
    document.querySelectorAll('#acctBulkKindToggle .acct-type-btn').forEach(function (b) {
        b.classList.toggle('active', b.dataset.kind === 'ledger');
    });
    acctBulkRenderRows();
    if (acctBulkModalCtrl) acctBulkModalCtrl.open();
    setTimeout(function () { var f = document.querySelector('#acctBulkRows .acct-bulk-name'); if (f) f.focus(); }, 40);
}

function acctBulkRenderRows() {
    var body = document.getElementById('acctBulkRows');
    if (!body) return;
    var isLed = acctBulkKind === 'ledger';
    var scopeHead = document.getElementById('acctBulkScopeHead');
    if (scopeHead) scopeHead.style.display = isLed ? '' : 'none';
    acctBulkScopeCtrls = {};
    var h = '';
    acctBulkRows.forEach(function (r, idx) {
        h += '<tr data-idx="' + idx + '">' +
            '<td><input type="text" class="acct-bulk-name" data-idx="' + idx + '" value="' + wmsEsc(r.name || '') + '" placeholder="' + (isLed ? 'Ledger name' : 'Group name') + '"></td>' +
            (isLed ? '<td class="acct-bulk-scope-cell"><div class="acct-bulk-scope" data-idx="' + idx + '"></div></td>' : '') +
            '<td class="text-right"><button class="acct-line-del acct-bulk-del" data-idx="' + idx + '" tabindex="-1" title="Remove row">✕</button></td></tr>';
    });
    body.innerHTML = h;
    body.querySelectorAll('.acct-bulk-name').forEach(function (inp) {
        inp.oninput = function () { acctBulkRows[+inp.dataset.idx].name = inp.value; acctBulkUpdateFoot(); };
        inp.onkeydown = function (e) {
            if (e.key === 'Enter') { e.preventDefault(); acctBulkFocusNextOrAdd(+inp.dataset.idx); }
        };
    });
    if (isLed) {
        body.querySelectorAll('.acct-bulk-scope').forEach(function (hostEl) {
            var idx = +hostEl.dataset.idx;
            acctBulkScopeCtrls[idx] = acctBookScopeControl(hostEl, acctBulkRows[idx].scope, function () {
                acctBulkRows[idx].scope = acctBulkScopeCtrls[idx].getValue();
            });
        });
    }
    body.querySelectorAll('.acct-bulk-del').forEach(function (b) {
        b.onclick = function () {
            if (acctBulkRows.length <= 1) { acctBulkRows[0] = { name: '', scope: { global: true, bookIds: [] } }; }
            else { acctBulkRows.splice(+b.dataset.idx, 1); }
            acctBulkRenderRows(); acctBulkUpdateFoot();
        };
    });
    // Tab off the last row's last field adds a new row.
    var lastIdx = acctBulkRows.length - 1;
    var lastRow = body.querySelector('tr[data-idx="' + lastIdx + '"]');
    if (lastRow) {
        var target = isLed ? lastRow.querySelector('.acct-scope-btn') : lastRow.querySelector('.acct-bulk-name');
        if (target) target.addEventListener('keydown', function (e) {
            if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); acctBulkAddRow(); }
        });
    }
    acctBulkUpdateFoot();
}
function acctBulkAddRow() {
    acctBulkRows.push({ name: '', scope: { global: true, bookIds: [] } });
    acctBulkRenderRows();
    var body = document.getElementById('acctBulkRows');
    var inp = body && body.querySelector('tr[data-idx="' + (acctBulkRows.length - 1) + '"] .acct-bulk-name');
    if (inp) inp.focus();
}
function acctBulkFocusNextOrAdd(idx) {
    if (idx >= acctBulkRows.length - 1) { acctBulkAddRow(); return; }
    var body = document.getElementById('acctBulkRows');
    var inp = body && body.querySelector('tr[data-idx="' + (idx + 1) + '"] .acct-bulk-name');
    if (inp) inp.focus();
}
function acctBulkDupeCheck(named, parentId) {
    var lowered = named.map(function (r) { return r.name.trim().toLowerCase(); });
    for (var i = 0; i < lowered.length; i++)
        for (var j = i + 1; j < lowered.length; j++)
            if (lowered[i] === lowered[j]) return { msg: 'Duplicate name in the list: "' + named[i].name.trim() + '"' };
    if (acctBulkKind === 'ledger') {
        for (var k = 0; k < named.length; k++) {
            var nm = named[k].name.trim().toLowerCase();
            if (acctLedgers.some(function (l) { return (l.name || '').toLowerCase() === nm; }))
                return { msg: 'Ledger "' + named[k].name.trim() + '" already exists' };
        }
    } else {
        for (var k2 = 0; k2 < named.length; k2++) {
            var nm2 = named[k2].name.trim().toLowerCase();
            if (acctGroups.some(function (g) { return g.parent_group_id === parentId && (g.name || '').toLowerCase() === nm2; }))
                return { msg: 'Group "' + named[k2].name.trim() + '" already exists under this parent' };
        }
    }
    return { msg: '' };
}
function acctBulkUpdateFoot() {
    var named = acctBulkRows.filter(function (r) { return (r.name || '').trim(); });
    var parentSel = document.getElementById('acctBulkParent');
    var parentId = parentSel ? parentSel.value : '';
    var dupe = acctBulkDupeCheck(named, parentId);
    var msg = document.getElementById('acctBulkMsg');
    var save = document.getElementById('acctBulkSave');
    var noun = acctBulkKind === 'ledger' ? 'ledger' : 'group';
    if (msg) {
        msg.textContent = dupe.msg || (named.length ? (named.length + ' ' + noun + (named.length === 1 ? '' : 's') + ' to add') : 'Enter at least one name');
        msg.classList.toggle('acct-bulk-err', !!dupe.msg);
    }
    if (save) save.disabled = !named.length || !!dupe.msg || !parentId;
}
async function acctBulkSave() {
    var parentSel = document.getElementById('acctBulkParent');
    var parentId = parentSel ? parentSel.value : '';
    if (!parentId) { acctToast('Pick a parent group.', true); return; }
    var named = acctBulkRows.filter(function (r) { return (r.name || '').trim(); });
    if (!named.length) { acctToast('Enter at least one name.', true); return; }
    var dupe = acctBulkDupeCheck(named, parentId);
    if (dupe.msg) { acctToast(dupe.msg, true); return; }
    try {
        var url, payload;
        if (acctBulkKind === 'ledger') {
            url = acctUrl('acct_ledgers');
            payload = named.map(function (r) {
                var v = r.scope || { global: true, bookIds: [] };
                return {
                    name: r.name.trim(), group_id: parentId, ledger_kind: 'GENERAL',
                    is_global: !!v.global,
                    scope_investor_ids: v.global ? [] : (v.bookIds || []),
                    scope_investor_id: (!v.global && v.bookIds && v.bookIds.length) ? v.bookIds[0] : null
                };
            });
        } else {
            url = acctUrl('acct_groups');
            payload = named.map(function (r) { return { name: r.name.trim(), parent_group_id: parentId }; });
        }
        var resp = await fetch(url, {
            method: 'POST',
            headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
            body: JSON.stringify(payload)
        });
        if (!resp.ok) throw new Error(await resp.text() || ('HTTP ' + resp.status));
        if (acctBulkModalCtrl) acctBulkModalCtrl.close();
        acctToast(named.length + ' ' + (acctBulkKind === 'ledger' ? 'ledger' : 'group') + (named.length === 1 ? '' : 's') + ' added.');
        await acctLoadCatalogue();
        acctRenderActiveTab();
    } catch (e) {
        console.error('[accounting] bulk add failed', e);
        acctToast('Could not save: ' + e.message, true);
    }
}

// ============================================================================
// Add ledger / add group modals
// ============================================================================
function acctGroupSelectOptions(selectedId, rootsOnlyAllowed) {
    // Roots first (in nature order), then their descendants to ANY depth, indented
    // by level. The chart nests 3 deep (e.g. Assets ▸ Investments ▸ Listed
    // Securities), so a two-level walk hid every depth-2 group — the reason
    // "Listed Securities", "Brokers", "Traders", the Capital-Gains / Yield-Income
    // groups, etc. never appeared in the picker.
    var html = '';
    function walk(parentId, depth) {
        acctGroups.filter(function (g) { return g.parent_group_id === parentId; })
            .sort(function (a, b) { return a.name.localeCompare(b.name); })
            .forEach(function (g) {
                var pad = '';
                for (var i = 0; i < depth; i++) pad += '&nbsp;&nbsp;&nbsp;';
                html += '<option value="' + g.id + '"' + (g.id === selectedId ? ' selected' : '') + '>' + pad + wmsEsc(g.name) + '</option>';
                walk(g.id, depth + 1);
            });
    }
    acctNatureOrder.forEach(function (rootName) {
        var root = acctGroups.find(function (g) { return !g.parent_group_id && g.name === rootName; });
        if (!root) return;
        html += '<option value="' + root.id + '"' + (root.id === selectedId ? ' selected' : '') + '>' + wmsEsc(root.name) + '</option>';
        walk(root.id, 1);
    });
    return html;
}

var acctEditScopeCtrl = null;
function acctSetLedgerModal(lg) {
    var t = document.getElementById('acctAddLedgerTitle'); if (t) t.textContent = lg ? 'Edit Ledger' : 'Add Ledger';
    document.getElementById('acctNewLedgerName').value = lg ? lg.name : '';
    document.getElementById('acctNewLedgerGroup').innerHTML = acctGroupSelectOptions(lg ? lg.group_id : null);
    var initial = lg
        ? { global: !!lg.is_global, bookIds: lg.is_global ? [] : acctLedgerScopeIds(lg) }
        : { global: true, bookIds: [] };
    var host = document.getElementById('acctEditLedgerScope');
    if (host) acctEditScopeCtrl = acctBookScopeControl(host, initial, null);
    // Delete is offered only when editing a NON-system, non-role ledger (system /
    // role ledgers are structural). The click still hard-guards against FK use.
    var delBtn = document.getElementById('acctAddLedgerDelete');
    if (delBtn) delBtn.style.display = (lg && !lg.is_system && !lg.posting_role) ? '' : 'none';
    if (acctAddLedgerModalCtrl) acctAddLedgerModalCtrl.open();
}
function acctOpenAddLedger() { acctEditingLedgerId = null; acctSetLedgerModal(null); }
function acctOpenEditLedger(id) {
    var lg = acctLedgers.find(function (x) { return x.id === id; });
    if (!lg) return;
    acctEditingLedgerId = id;
    acctSetLedgerModal(lg);
}

async function acctSaveLedger() {
    var name = document.getElementById('acctNewLedgerName').value.trim();
    var groupId = document.getElementById('acctNewLedgerGroup').value;
    if (!name) { acctToast('Ledger name is required.', true); return; }
    if (!groupId) { acctToast('Pick a group.', true); return; }
    // Uniqueness (name is globally UNIQUE) — catch it in-app before the DB does.
    var clash = acctLedgers.find(function (l) {
        return l.id !== acctEditingLedgerId && (l.name || '').toLowerCase() === name.toLowerCase();
    });
    if (clash) { acctToast('A ledger named "' + name + '" already exists.', true); return; }
    var v = acctEditScopeCtrl ? acctEditScopeCtrl.getValue() : { global: true, bookIds: [] };
    if (!v.global && !v.bookIds.length) { acctToast('Pick at least one book, or choose Global.', true); return; }
    // Orphan guard: never drop a book that already has postings on this ledger.
    if (acctEditingLedgerId && !v.global) {
        var posted = await acctLedgerPostedBooks(acctEditingLedgerId);
        var missing = posted.filter(function (bid) { return v.bookIds.indexOf(bid) < 0; });
        if (missing.length) {
            acctToast('Can’t remove coverage: this ledger has postings in ' +
                missing.map(acctInvName).join(', ') + '. Keep those books selected (or make it Global).', true);
            return;
        }
    }
    var body = {
        name: name, group_id: groupId, is_global: !!v.global,
        scope_investor_ids: v.global ? [] : (v.bookIds || []),
        scope_investor_id: (!v.global && v.bookIds.length) ? v.bookIds[0] : null
    };
    try {
        var resp;
        if (acctEditingLedgerId) {
            resp = await fetch(acctUrl('acct_ledgers?id=eq.' + acctEditingLedgerId), {
                method: 'PATCH', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
                body: JSON.stringify(body)
            });
        } else {
            body.ledger_kind = 'GENERAL';
            resp = await fetch(acctUrl('acct_ledgers'), {
                method: 'POST', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
                body: JSON.stringify(body)
            });
        }
        if (!resp.ok) throw new Error(await resp.text() || ('HTTP ' + resp.status));
        if (acctAddLedgerModalCtrl) acctAddLedgerModalCtrl.close();
        var wasCreate = !acctEditingLedgerId;
        acctToast('Ledger "' + name + '" ' + (acctEditingLedgerId ? 'updated' : 'added') + '.');
        await acctLoadCatalogue();
        // Created from a voucher row's "Create ledger…" — drop it straight into that row.
        if (wasCreate && acctLedgerPickTarget) {
            var made = acctLedgers.find(function (l) { return l.name === name; });
            var tgt = acctVoucherLines[acctLedgerPickTarget.idx];
            if (made && tgt) {
                tgt.ledgerId = made.id;
                tgt.ledgerName = made.name;
                acctRenderVoucherLines();
                var amt = document.querySelector('#acctVoucherLines .acct-line-amt[data-idx="' + acctLedgerPickTarget.idx + '"][data-field="debit"]');
                if (amt) amt.focus();
            }
            acctLedgerPickTarget = null;
        }
        acctRenderActiveTab();
    } catch (e) {
        console.error('[accounting] save ledger failed', e);
        acctToast('Could not save ledger: ' + e.message, true);
    }
}

function acctSetGroupModal(g) {
    var t = document.getElementById('acctAddGroupTitle'); if (t) t.textContent = g ? 'Edit Group' : 'Add Group';
    document.getElementById('acctNewGroupName').value = g ? g.name : '';
    document.getElementById('acctNewGroupParent').innerHTML = acctGroupSelectOptions(g ? g.parent_group_id : null);
    // Delete offered only for a non-root, non-system group being edited. The click
    // hard-guards against child groups / ledgers still in it.
    var gDel = document.getElementById('acctAddGroupDelete');
    if (gDel) gDel.style.display = (g && g.parent_group_id && !g.is_system) ? '' : 'none';
    if (acctAddGroupModalCtrl) acctAddGroupModalCtrl.open();
}
function acctOpenAddGroup() { acctEditingGroupId = null; acctSetGroupModal(null); }
function acctOpenEditGroup(id) {
    var g = acctGroupById[id];
    if (!g) return;
    if (!g.parent_group_id) { acctToast('The five root groups (Assets/Liabilities/Income/Expenses/Capital) are fixed.', true); return; }
    acctEditingGroupId = id;
    acctSetGroupModal(g);
}

async function acctSaveGroup() {
    var name = document.getElementById('acctNewGroupName').value.trim();
    var parentId = document.getElementById('acctNewGroupParent').value;
    if (!name) { acctToast('Group name is required.', true); return; }
    if (!parentId) { acctToast('Pick a parent group.', true); return; }
    if (acctEditingGroupId && parentId === acctEditingGroupId) { acctToast('A group cannot be its own parent.', true); return; }
    try {
        var resp;
        if (acctEditingGroupId) {
            resp = await fetch(acctUrl('acct_groups?id=eq.' + acctEditingGroupId), {
                method: 'PATCH', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
                body: JSON.stringify({ name: name, parent_group_id: parentId })
            });
        } else {
            resp = await fetch(acctUrl('acct_groups'), {
                method: 'POST', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
                body: JSON.stringify({ name: name, parent_group_id: parentId })
            });
        }
        if (!resp.ok) throw new Error(await resp.text() || ('HTTP ' + resp.status));
        if (acctAddGroupModalCtrl) acctAddGroupModalCtrl.close();
        acctToast('Group "' + name + '" ' + (acctEditingGroupId ? 'updated' : 'added') + '.');
        await acctLoadCatalogue();
        acctRenderActiveTab();
    } catch (e) {
        console.error('[accounting] save group failed', e);
        acctToast('Could not save group: ' + e.message, true);
    }
}

// ---- Delete ledger / group (only when NOT referenced by an FK — esp. vouchers) ----
// FK map (all NO ACTION): acct_voucher_lines.ledger_id → acct_ledgers;
// acct_ledgers.group_id → acct_groups; acct_groups.parent_group_id → acct_groups.
// We pre-check for a friendly message; the DB FK is the ultimate hard stop.
async function acctDeleteLedger() {
    var id = acctEditingLedgerId;
    var lg = acctLedgers.find(function (x) { return x.id === id; });
    if (!id || !lg) return;
    if (lg.is_system || lg.posting_role) {
        acctToast('“' + lg.name + '” is a system/role ledger and cannot be deleted.', true); return;
    }
    // Any voucher line (incl. cancelled — the FK still holds) blocks the delete.
    var used;
    try {
        used = await wmsFetchAllRaw(acctUrl('acct_voucher_full?ledger_id=eq.' + id + '&select=voucher_id&limit=1')) || [];
    } catch (e) { acctToast('Could not check voucher usage: ' + e.message, true); return; }
    if (used.length) {
        acctToast('“' + lg.name + '” is used in vouchers and cannot be deleted. Cancel/reassign those entries first.', true); return;
    }
    if (!confirm('Delete ledger “' + lg.name + '”? This cannot be undone.')) return;
    try {
        var resp = await fetch(acctUrl('acct_ledgers?id=eq.' + id), {
            method: 'DELETE', headers: wmsHeaders({ 'Prefer': 'return=minimal' })
        });
        if (!resp.ok) throw new Error((await resp.text()) || ('HTTP ' + resp.status));
        acctEditingLedgerId = null;
        if (acctAddLedgerModalCtrl) acctAddLedgerModalCtrl.close();
        acctToast('Ledger “' + lg.name + '” deleted.');
        await acctLoadCatalogue();
        acctRenderActiveTab();
    } catch (e) {
        console.error('[accounting] delete ledger failed', e);
        acctToast('Could not delete ledger: ' + e.message, true);
    }
}

async function acctDeleteGroup() {
    var id = acctEditingGroupId;
    var g = acctGroupById[id];
    if (!id || !g) return;
    if (!g.parent_group_id) { acctToast('The five root groups are fixed and cannot be deleted.', true); return; }
    if (g.is_system) { acctToast('“' + g.name + '” is a system group and cannot be deleted.', true); return; }
    var kids = acctGroups.filter(function (x) { return x.parent_group_id === id; });
    if (kids.length) {
        acctToast('“' + g.name + '” has sub-group(s): ' + kids.map(function (k) { return k.name; }).join(', ') + '. Move or delete them first.', true); return;
    }
    var leds = acctLedgers.filter(function (x) { return x.group_id === id; });
    if (leds.length) {
        acctToast('“' + g.name + '” still has ' + leds.length + ' ledger(s). Move or delete them first.', true); return;
    }
    if (!confirm('Delete group “' + g.name + '”? This cannot be undone.')) return;
    try {
        var resp = await fetch(acctUrl('acct_groups?id=eq.' + id), {
            method: 'DELETE', headers: wmsHeaders({ 'Prefer': 'return=minimal' })
        });
        if (!resp.ok) throw new Error((await resp.text()) || ('HTTP ' + resp.status));
        acctEditingGroupId = null;
        if (acctAddGroupModalCtrl) acctAddGroupModalCtrl.close();
        acctToast('Group “' + g.name + '” deleted.');
        await acctLoadCatalogue();
        acctRenderActiveTab();
    } catch (e) {
        console.error('[accounting] delete group failed', e);
        acctToast('Could not delete group: ' + e.message, true);
    }
}

// ============================================================================
// Modal wiring (rebuilt each module load — fresh DOM)
// ============================================================================
function acctWireModals() {
    // Voucher modal
    var vOverlay = document.getElementById('acctVoucherModal');
    if (vOverlay && typeof wmsModal === 'function') acctVoucherModalCtrl = wmsModal(vOverlay, { backdropClose: false });
    document.getElementById('acctVoucherClose').onclick = function () { acctVoucherModalCtrl && acctVoucherModalCtrl.close(); };
    document.getElementById('acctVoucherCancel').onclick = function () { acctVoucherModalCtrl && acctVoucherModalCtrl.close(); };
    document.getElementById('acctVoucherSave').onclick = acctSaveVoucher;
    var delBtn = document.getElementById('acctVoucherDelete');
    if (delBtn) delBtn.onclick = acctDeleteVoucher;
    // F2 anywhere in the voucher modal jumps the caret to the date field.
    if (vOverlay) vOverlay.addEventListener('keydown', function (e) {
        if (e.key === 'F2') {
            e.preventDefault();
            var w = document.querySelector('#acctVoucherDate .wms-di-wrap');
            if (w) w.focus();
        }
    });

    // Opening-balances modal
    var obOverlay = document.getElementById('acctOpeningModal');
    if (obOverlay && typeof wmsModal === 'function') acctOpeningModalCtrl = wmsModal(obOverlay, { backdropClose: false });
    var obClose = document.getElementById('acctOpeningClose');
    if (obClose) obClose.onclick = function () { acctOpeningModalCtrl && acctOpeningModalCtrl.close(); };
    var obCancel = document.getElementById('acctOpeningCancel');
    if (obCancel) obCancel.onclick = function () { acctOpeningModalCtrl && acctOpeningModalCtrl.close(); };
    var obSave = document.getElementById('acctOpeningSave');
    if (obSave) obSave.onclick = acctSaveOpening;
    var obBtn = document.getElementById('acctOpeningBtn');
    if (obBtn) obBtn.onclick = acctOpenOpeningModal;
    var obAdd = document.getElementById('acctOpeningAddLineBtn');
    if (obAdd) obAdd.onclick = function () { acctOpeningAddLine(true); };

    // Narration is a multi-line textarea: Enter inserts a newline; only Tab (no shift)
    // commits to Save. (Per-cell wiring in acctRenderVoucherLines owns the lines table.)
    var narEl = document.getElementById('acctVoucherNarration');
    if (narEl) narEl.addEventListener('keydown', function (e) {
        if (e.key === 'Tab' && !e.shiftKey) {
            var save = document.getElementById('acctVoucherSave');
            if (save && !save.disabled) { e.preventDefault(); save.focus(); }
        }
    });
    // Toggle the per-leg narration fields (the DB stores narration on each line).
    var legBtn = document.getElementById('acctLegNarrToggle');
    if (legBtn) legBtn.onclick = function () {
        acctVoucherShowLegNarr = !acctVoucherShowLegNarr;
        legBtn.classList.toggle('on', acctVoucherShowLegNarr);
        acctRenderVoucherLines();
    };

    // Ledger-detail modal
    var lOverlay = document.getElementById('acctLedgerModal');
    if (lOverlay && typeof wmsModal === 'function') acctLedgerModalCtrl = wmsModal(lOverlay, { backdropClose: false });
    document.getElementById('acctLedgerClose').onclick = function () { acctLedgerModalCtrl && acctLedgerModalCtrl.close(); };
    document.getElementById('acctLedgerDone').onclick = function () { acctLedgerModalCtrl && acctLedgerModalCtrl.close(); };

    // Add-ledger modal
    var alOverlay = document.getElementById('acctAddLedgerModal');
    if (alOverlay && typeof wmsModal === 'function') acctAddLedgerModalCtrl = wmsModal(alOverlay, { backdropClose: false });
    document.getElementById('acctAddLedgerClose').onclick = function () { acctAddLedgerModalCtrl && acctAddLedgerModalCtrl.close(); };
    document.getElementById('acctAddLedgerCancel').onclick = function () { acctAddLedgerModalCtrl && acctAddLedgerModalCtrl.close(); };
    document.getElementById('acctAddLedgerSave').onclick = acctSaveLedger;
    var acctLedDelBtn = document.getElementById('acctAddLedgerDelete');
    if (acctLedDelBtn) acctLedDelBtn.onclick = acctDeleteLedger;

    // Bulk add ledgers/groups modal
    var buOverlay = document.getElementById('acctBulkModal');
    if (buOverlay && typeof wmsModal === 'function') acctBulkModalCtrl = wmsModal(buOverlay, { backdropClose: false });
    var buClose = document.getElementById('acctBulkClose');
    if (buClose) buClose.onclick = function () { acctBulkModalCtrl && acctBulkModalCtrl.close(); };
    var buCancel = document.getElementById('acctBulkCancel');
    if (buCancel) buCancel.onclick = function () { acctBulkModalCtrl && acctBulkModalCtrl.close(); };
    var buSave = document.getElementById('acctBulkSave');
    if (buSave) buSave.onclick = acctBulkSave;
    var buParent = document.getElementById('acctBulkParent');
    if (buParent) buParent.onchange = acctBulkUpdateFoot;
    var buAdd = document.getElementById('acctBulkAddRowBtn');
    if (buAdd) buAdd.onclick = acctBulkAddRow;
    document.querySelectorAll('#acctBulkKindToggle .acct-type-btn').forEach(function (b) {
        b.onclick = function () {
            acctBulkKind = b.dataset.kind;
            document.querySelectorAll('#acctBulkKindToggle .acct-type-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
            acctBulkRenderRows();
        };
    });

    // Add-group modal
    var agOverlay = document.getElementById('acctAddGroupModal');
    if (agOverlay && typeof wmsModal === 'function') acctAddGroupModalCtrl = wmsModal(agOverlay, { backdropClose: false });
    document.getElementById('acctAddGroupClose').onclick = function () { acctAddGroupModalCtrl && acctAddGroupModalCtrl.close(); };
    document.getElementById('acctAddGroupCancel').onclick = function () { acctAddGroupModalCtrl && acctAddGroupModalCtrl.close(); };
    document.getElementById('acctAddGroupSave').onclick = acctSaveGroup;
    var acctGrpDelBtn = document.getElementById('acctAddGroupDelete');
    if (acctGrpDelBtn) acctGrpDelBtn.onclick = acctDeleteGroup;

    // Rebuild report modal
    var rpOverlay = document.getElementById('acctReportModal');
    if (rpOverlay && typeof wmsModal === 'function') acctReportModalCtrl = wmsModal(rpOverlay, { backdropClose: false });
    var rpClose = document.getElementById('acctReportClose');
    if (rpClose) rpClose.onclick = function () { acctReportModalCtrl && acctReportModalCtrl.close(); };
    var rpDone = document.getElementById('acctReportDone');
    if (rpDone) rpDone.onclick = function () { acctReportModalCtrl && acctReportModalCtrl.close(); };

    // Consolidate modal
    var coOverlay = document.getElementById('acctConsolidateModal');
    if (coOverlay && typeof wmsModal === 'function') acctConsolidateModalCtrl = wmsModal(coOverlay, { backdropClose: false });
    var coClose = document.getElementById('acctConsolidateClose');
    if (coClose) coClose.onclick = function () { acctConsolidateModalCtrl && acctConsolidateModalCtrl.close(); };
    var coApply = document.getElementById('acctConsolidateApply');
    if (coApply) coApply.onclick = acctApplyConsolidate;
    var coClear = document.getElementById('acctConsolidateClear');
    if (coClear) coClear.onclick = acctClearConsolidate;
}

// ============================================================================
// Phase 2 — Rebuild a book's auto-vouchers from its transactions
// ============================================================================
// Find-or-create each ledger key the engine emitted; fill outMap[key.key]=id.
async function acctResolveLedgers(keys, outMap) {
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var existing = acctLedgers.find(function (l) { return l.name === key.name; });
        if (existing) { outMap[key.key] = existing.id; continue; }
        var grp = acctGroups.find(function (g) { return g.name === key.group; });
        if (!grp) throw new Error('Group "' + key.group + '" not found for ledger "' + key.name + '"');
        var body = {
            name: key.name, group_id: grp.id, ledger_kind: key.kind || 'GENERAL',
            is_global: key.isGlobal !== false,
            scope_investor_id: (key.isGlobal === false) ? (key.scopeInvestorId || acctBookId) : null
        };
        var resp = await fetch(acctUrl('acct_ledgers'), {
            method: 'POST',
            headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
            body: JSON.stringify(body)
        });
        if (!resp.ok) throw new Error('Create ledger "' + key.name + '" failed: ' + (await resp.text()));
        var row = (await resp.json())[0];
        acctLedgers.push(row);
        outMap[key.key] = row.id;
    }
}

// Core: rebuild ONE book's auto-vouchers from its transactions. Returns a report
// object; does NOT show UI (no confirm/loading/render). NOTE: on the dev site the
// fetch interceptor routes "transactions" -> "transactions_dev" automatically.
// Resolve a voucher-line ref -> ledger id (find-or-create auto ledgers).
async function acctFindOrCreateAuto(fkCol, id) {
    var found = acctLedgers.find(function (x) { return x[fkCol] === id; });
    if (found) return found.id;
    var name, groupName, kind, extra = {};
    if (fkCol === 'security_id') {
        var sec = (wmsRefData.securitiesCmMap || {})[id] || {};
        name = sec.symbol || sec.company_name || ('SEC ' + String(id).slice(0, 8));
        groupName = 'Listed Securities'; kind = 'SECURITY'; extra.security_id = id;
    } else if (fkCol === 'broker_id') {
        var b = (wmsRefData.brokers || []).find(function (x) { return x.id === id; }) || {};
        name = 'Broker — ' + (b.name || b.broker_code || String(id).slice(0, 8));
        groupName = 'Brokers'; kind = 'BROKER'; extra.broker_id = id;
    } else {
        var inv = (wmsRefData.investors || []).find(function (x) { return x.id === id; }) || {};
        name = 'Trader — ' + (inv.name || inv.short_name || String(id).slice(0, 8));
        groupName = 'Traders'; kind = 'TRADER'; extra.investor_id = id;
    }
    var grp = acctGroups.find(function (g) { return g.name === groupName; });
    if (!grp) throw new Error('Group "' + groupName + '" not found (run migration 74/75)');
    var body = Object.assign({ name: name, group_id: grp.id, ledger_kind: kind, is_global: true, is_system: false }, extra);
    var resp = await fetch(acctUrl('acct_ledgers'), {
        method: 'POST', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
        body: JSON.stringify(body)
    });
    if (!resp.ok) throw new Error('Create auto ledger "' + name + '" failed: ' + (await resp.text()));
    var row = (await resp.json())[0];
    acctLedgers.push(row);
    return row.id;
}

async function acctResolveRef(ref) {
    if (ref.role) {
        var l = acctLedgers.find(function (x) { return x.posting_role === ref.role; });
        if (l) return l.id;
        throw new Error('No ledger for role "' + ref.role + '" (run migration 74)');
    }
    if (ref.security_id) return await acctFindOrCreateAuto('security_id', ref.security_id);
    if (ref.broker_id) return await acctFindOrCreateAuto('broker_id', ref.broker_id);
    if (ref.investor_id) return await acctFindOrCreateAuto('investor_id', ref.investor_id);
    throw new Error('Unresolvable ledger ref: ' + JSON.stringify(ref));
}

// Core: rebuild ONE book's auto-vouchers by invoking the SERVER-SIDE engine (the
// accounting-post Edge Function). This is the SAME engine the nightly cron runs
// (frozen + byte-stamped), so the button and the nightly can never diverge (D15).
// It posts INCREMENTALLY (worklist: new→post, changed-open→cancel+repost,
// changed-closed→alert, unchanged→skip, orphan→alert) and also does the
// statement→books postings — not the old browser wipe-and-repost.
// Auth: the owner's logged-in session (x-user-token via wmsEdgeHeaders); the EF
// verifies it. Returns a report object shaped for acctShowRebuildReport.
async function acctRebuildOne(bookId) {
    var resp = await fetch(SUPABASE_URL + '/functions/v1/accounting-post', {
        method: 'POST',
        headers: wmsEdgeHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ bookId: bookId })
    });
    var j = await resp.json().catch(function () { return {}; });
    if (resp.status === 401) throw new Error('Session expired — refresh the page and sign in again.');
    if (!resp.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + resp.status));
    var rep = (j.reports && j.reports[0]) || {};
    // Fold the EF's trade + statement counters into the report-card fields.
    return {
        bookId: bookId, book: rep.book || acctInvName(bookId),
        posted: (rep.posted || 0) + (rep.stmtPosted || 0),
        replaced: (rep.replaced || 0) + (rep.stmtReplaced || 0),
        unchanged: (rep.unchanged || 0) + (rep.stmtUnchanged || 0),
        skipped: (rep.skipped || 0) + (rep.stmtSkipped || 0),
        closedPeriod: rep.skippedClosed || 0,
        failed: rep.failed || 0,
        warnings: (rep.engineExceptions || 0) + (rep.closedBlocked || 0) + (rep.orphans || 0),
        firstErr: rep.firstErr || null, skipReasons: {}, warningsList: []
    };
}

async function acctRebuildBooks() {
    if (!acctBookId) { acctToast('Select a book first.', true); return; }
    if (!window.confirm('Rebuild auto-vouchers for ' + acctInvName(acctBookId) + ' from its trades?\n\n' +
        'This runs the accounting engine on the server: new trades are posted, changed ones are re-posted, ' +
        'and unchanged ones are left alone. Your manual vouchers are never touched.')) return;
    acctLoading(true);
    try {
        var r = await acctRebuildOne(acctBookId);
        await acctLoadCatalogue(); await acctLoadBook(); acctRenderActiveTab();
        acctShowRebuildReport([r]);
    } catch (e) {
        console.error('[accounting] rebuild failed', e);
        acctToast('Rebuild failed: ' + e.message, true);
    } finally { acctLoading(false); }
}

async function acctRebuildAll() {
    var books = acctOwnBooks();
    if (!books.length) { acctToast('No own-books to rebuild.', true); return; }
    if (!window.confirm('Rebuild auto-vouchers for ALL ' + books.length + ' books from their trades?\n\n' +
        'Runs the server accounting engine per book (new posted, changed re-posted, unchanged left alone; ' +
        'manual vouchers never touched). May take a minute for large books.')) return;
    acctLoading(true);
    try {
        var reports = [];
        for (var i = 0; i < books.length; i++) { reports.push(await acctRebuildOne(books[i].id)); }
        await acctLoadCatalogue(); await acctLoadBook(); acctRenderActiveTab();
        acctShowRebuildReport(reports);
    } catch (e) {
        console.error('[accounting] rebuild-all failed', e);
        acctToast('Rebuild all failed: ' + e.message, true);
    } finally { acctLoading(false); }
}

function acctShowRebuildReport(reports) {
    var body = document.getElementById('acctReportBody');
    if (!body) {
        var tot = reports.reduce(function (a, r) { return a + r.posted; }, 0);
        acctToast('Rebuilt ' + reports.length + ' book(s): ' + tot + ' vouchers posted.');
        return;
    }
    var html = '<table class="acct-table"><thead><tr><th>Book</th><th class="text-right">Posted</th><th class="text-right">Replaced</th><th class="text-right">Unchanged</th><th class="text-right" title="Trades in a closed period — carried by the opening balance, not posted">Closed</th><th class="text-right">Skipped</th><th class="text-right">Failed</th><th class="text-right">Warn</th></tr></thead><tbody>';
    reports.forEach(function (r) {
        html += '<tr><td>' + wmsEsc(r.book) + '</td>' +
            '<td class="text-right">' + (r.posted || '-') + '</td>' +
            '<td class="text-right">' + (r.replaced || '-') + '</td>' +
            '<td class="text-right">' + (r.unchanged || '-') + '</td>' +
            '<td class="text-right">' + (r.closedPeriod || '-') + '</td>' +
            '<td class="text-right">' + (r.skipped || '-') + '</td>' +
            '<td class="text-right"' + (r.failed ? ' style="color:#dc2626;font-weight:600;"' : '') + '>' + (r.failed || '-') + '</td>' +
            '<td class="text-right">' + (r.warnings || '-') + '</td></tr>';
    });
    html += '</tbody></table>';
    var allSkip = {}, allWarn = [];
    reports.forEach(function (r) {
        Object.keys(r.skipReasons || {}).forEach(function (k) { allSkip[k] = (allSkip[k] || 0) + r.skipReasons[k]; });
        (r.warningsList || []).forEach(function (w) { allWarn.push(r.book + ': ' + w.warn); });
    });
    if (Object.keys(allSkip).length) {
        html += '<div style="margin-top:14px;"><div class="acct-report-h">Skipped (no voucher — expected for opens / non-cash events)</div><ul class="acct-report-ul">';
        Object.keys(allSkip).sort(function (a, b) { return allSkip[b] - allSkip[a]; }).forEach(function (k) {
            html += '<li>' + wmsEsc(k) + ' — <b>' + allSkip[k] + '</b></li>';
        });
        html += '</ul></div>';
    }
    if (allWarn.length) {
        html += '<div style="margin-top:14px;"><div class="acct-report-h" style="color:#b45309;">Warnings (' + allWarn.length + ')</div><ul class="acct-report-ul" style="color:#92400e;max-height:160px;overflow:auto;">';
        allWarn.slice(0, 50).forEach(function (w) { html += '<li>' + wmsEsc(w) + '</li>'; });
        if (allWarn.length > 50) html += '<li>… and ' + (allWarn.length - 50) + ' more</li>';
        html += '</ul></div>';
    }
    if (reports.some(function (r) { return r.failed; })) {
        html = '<div style="color:#dc2626;font-weight:600;margin-bottom:8px;">Some vouchers failed to post — see the browser console for the first error.</div>' + html;
    }
    body.innerHTML = html;
    if (acctReportModalCtrl) acctReportModalCtrl.open();
}

// Expose entry point for app.html loadModule
window.initAccounting = initAccounting;
