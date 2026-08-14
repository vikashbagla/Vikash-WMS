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
// Display-unit aware amount (used in Trial Balance / Day Book), returns HTML.
function acctAmt(n) {
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
function acctRenderBookTabs() {
    var el = document.getElementById('acctBookTabs');
    if (!el) return;
    var books = acctOwnBooks();
    if (!books.length) {
        el.innerHTML = '<span class="acct-books-empty">No books yet — enable accounting on an investor in Master Data.</span>';
        acctBookId = null;
        return;
    }
    if (!acctBookId || !books.some(function (b) { return b.id === acctBookId; })) acctBookId = books[0].id;
    var consol = acctIsConsolidated();
    el.innerHTML = books.map(function (b) {
        var on = !consol && b.id === acctBookId;
        return '<button class="acct-book-tab' + (on ? ' active' : '') + '" data-book="' + b.id + '">' +
            wmsEsc(b.short_name || b.name) + '</button>';
    }).join('') + '<span id="acctConsolidateChip" class="acct-consol-chip" style="display:none;margin-left:8px;"></span>';

    el.querySelectorAll('.acct-book-tab').forEach(function (t) {
        t.onclick = async function () {
            if (acctBookId === t.dataset.book && !acctIsConsolidated()) return;
            acctBookId = t.dataset.book;
            acctBookIds = null;                 // picking a single book clears consolidation
            acctLoading(true);
            try {
                await acctLoadBook();
                acctRenderBookTabs();
                acctRenderActiveTab();
                acctSyncActionButtons();
            } finally { acctLoading(false); }
        };
    });
    acctSyncConsolChip();
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
    var dd = document.getElementById('acctMenuDd');
    if (dd) ['opening', 'rebuild'].forEach(function (a) {
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
// Ledgers usable in a given book: global, or restricted to that book.
function acctAvailableLedgers(bookId) {
    return acctLedgers.filter(function (l) {
        return l.is_active && (l.is_global || l.scope_investor_id === bookId);
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

    // Primary action stays inline; everything else lives behind the ⋮ menu.
    var nv = document.getElementById('acctNewVoucherBtn');
    if (nv) nv.onclick = acctOpenVoucherModal;

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
            else if (act === 'rebuild') acctRebuildBooks();
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
var acctFinShowZero = false;
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
    var cls = node.isDiff ? 'acct-fin-row acct-fin-diff'
        : 'acct-fin-row ' + (isGroup ? 'acct-fin-group' : 'acct-fin-ledger acct-clickable');
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
    if (!el) return;
    if (!acctViewBookIds().length || !acctVoucherRows.length) { el.textContent = ''; return; }
    var unit = acctUnitLabel();
    el.textContent = acctFmtDate(acctTbPeriodStart()) + ' to ' + acctFinAsOn() + (unit ? '  ·  ' + unit : '');
}

function acctUnitLabel() {
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
function acctFinAsOn() {
    var max = '';
    acctVoucherRows.forEach(function (r) { if (acctIsLive(r) && r.voucher_date > max) max = r.voucher_date; });
    return acctFmtDate(max || acctTodayYmd());
}
function acctRenderFinancials() {
    var el = document.getElementById('acctFinancialsBody');
    if (!el) return;
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
    var leftNodes = cap.nodes.concat([plNode]).concat(liab.nodes);
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

    var html = '<div class="acct-fin-controls">' +
        '<button class="wms-btn wms-btn-secondary" id="acctFinExpandAll">Expand all</button>' +
        '<button class="wms-btn wms-btn-secondary" id="acctFinCollapseAll">Collapse all</button>' +
        '<label class="acct-fin-zero"><input type="checkbox" id="acctFinShowZeroChk"' + (acctFinShowZero ? ' checked' : '') + '> Show zero values</label>' +
        '</div>';
    var flag = balanced ? '' : ' ⚠ out of balance';
    html += '<div class="acct-fin-cols">' +
        acctFinColumnHtml('Liabilities', asOn, leftNodes, leftTotal, flag) +
        acctFinColumnHtml('Assets', asOn, assets.nodes, assets.total, flag) + '</div>';
    el.innerHTML = html;

    el.querySelectorAll('.acct-fin-group[data-node]').forEach(function (r) {
        r.onclick = function () { acctFinCollapsed[r.dataset.node] = !acctFinCollapsed[r.dataset.node]; acctRenderFinancials(); };
    });
    el.querySelectorAll('.acct-fin-ledger[data-ledger]').forEach(function (r) {
        r.onclick = function () { acctOpenLedgerDetail(r.dataset.ledger); };
    });
    var ea = document.getElementById('acctFinExpandAll');
    if (ea) ea.onclick = function () { acctFinCollapsed = {}; acctRenderFinancials(); };
    var ca = document.getElementById('acctFinCollapseAll');
    if (ca) ca.onclick = function () {
        var keys = acctFinAllGroupKeys(leftNodes.concat(assets.nodes), []);
        acctFinCollapsed = {}; keys.forEach(function (k) { acctFinCollapsed[k] = true; });
        acctRenderFinancials();
    };
    var sz = document.getElementById('acctFinShowZeroChk');
    if (sz) sz.onchange = function () { acctFinShowZero = sz.checked; acctRenderFinancials(); };
}

// ── Profit & Loss — T-format (Expenses | Income), same style as the BS ───────
function acctRenderPL() {
    var el = document.getElementById('acctPLBody');
    if (!el) return;
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

    var html = '<div class="acct-fin-controls">' +
        '<button class="wms-btn wms-btn-secondary" id="acctPLExpandAll">Expand all</button>' +
        '<button class="wms-btn wms-btn-secondary" id="acctPLCollapseAll">Collapse all</button>' +
        '<label class="acct-fin-zero"><input type="checkbox" id="acctPLShowZeroChk"' + (acctFinShowZero ? ' checked' : '') + '> Show zero values</label>' +
        '</div>';
    html += '<div class="acct-fin-cols">' +
        acctFinColumnHtml('Expenses', asOn, leftNodes, leftTotal) +
        acctFinColumnHtml('Income', asOn, rightNodes, rightTotal) + '</div>';
    el.innerHTML = html;

    el.querySelectorAll('.acct-fin-group[data-node]').forEach(function (r) {
        r.onclick = function () { acctFinCollapsed[r.dataset.node] = !acctFinCollapsed[r.dataset.node]; acctRenderPL(); };
    });
    el.querySelectorAll('.acct-fin-ledger[data-ledger]').forEach(function (r) {
        r.onclick = function () { acctOpenLedgerDetail(r.dataset.ledger); };
    });
    var ea = document.getElementById('acctPLExpandAll'); if (ea) ea.onclick = function () { acctFinCollapsed = {}; acctRenderPL(); };
    var ca = document.getElementById('acctPLCollapseAll'); if (ca) ca.onclick = function () { var keys = acctFinAllGroupKeys(leftNodes.concat(rightNodes), []); acctFinCollapsed = {}; keys.forEach(function (k) { acctFinCollapsed[k] = true; }); acctRenderPL(); };
    var sz = document.getElementById('acctPLShowZeroChk'); if (sz) sz.onchange = function () { acctFinShowZero = sz.checked; acctRenderPL(); };
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
    if (!acctViewBookIds().length) { el.innerHTML = '<div class="acct-empty">No book selected. Enable accounting on an investor first.</div>'; return; }
    if (!acctVoucherRows.length) { el.innerHTML = '<div class="acct-empty">No postings yet for ' + wmsEsc(acctViewTitle()) + '.</div>'; return; }

    var fyStart = acctTbPeriodStart();
    acctRenderContext();
    var nodes = acctTbBuild(acctTbAggregate(fyStart), acctActiveLedgerIds(fyStart));

    function acctZ(x) { var v = Math.round(x * 100) / 100; return Math.abs(v) < 0.005 ? 0 : v; }
    var T = { oDr: 0, oCr: 0, pDr: 0, pCr: 0, cDr: 0, cCr: 0 };
    nodes.forEach(function (n) { Object.keys(T).forEach(function (k) { T[k] += n[k]; }); });
    Object.keys(T).forEach(function (k) { T[k] = acctZ(T[k]); });

    var html = '<div class="acct-fin-controls">' +
        '<button class="wms-btn wms-btn-secondary" id="acctTbExpandAll">Expand all</button>' +
        '<button class="wms-btn wms-btn-secondary" id="acctTbCollapseAll">Collapse all</button>' +
        '<label class="acct-fin-zero"><input type="checkbox" id="acctTbShowZeroChk"' + (acctFinShowZero ? ' checked' : '') + '> Show zero values</label>' +
        '</div>';

    var W = 'width:184px;';
    html += '<div class="acct-tb-wrap">' +
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
    var ea = document.getElementById('acctTbExpandAll'); if (ea) ea.onclick = function () { acctFinCollapsed = {}; acctRenderTrialBalance(); };
    var ca = document.getElementById('acctTbCollapseAll'); if (ca) ca.onclick = function () { var keys = acctFinAllGroupKeys(nodes, []); acctFinCollapsed = {}; keys.forEach(function (k) { acctFinCollapsed[k] = true; }); acctRenderTrialBalance(); };
    var sz = document.getElementById('acctTbShowZeroChk'); if (sz) sz.onchange = function () { acctFinShowZero = sz.checked; acctRenderTrialBalance(); };
}

function acctRenderDayBook() {
    var el = document.getElementById('acctDayBookBody');
    if (!el) return;
    if (!acctViewBookIds().length) { el.innerHTML = '<div class="acct-empty">No book selected.</div>'; return; }

    // Group lines by voucher
    var vmap = {};
    acctVoucherRows.forEach(function (r) {
        if (!vmap[r.voucher_id]) {
            vmap[r.voucher_id] = {
                id: r.voucher_id, number: r.voucher_number, type: r.voucher_type,
                date: r.voucher_date, narration: r.voucher_narration,
                debit: Number(r.total_debit) || 0, credit: Number(r.total_credit) || 0, lines: []
            };
        }
        vmap[r.voucher_id].lines.push(r);
    });
    var vouchers = Object.keys(vmap).map(function (k) { return vmap[k]; }).sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return (a.number || '').localeCompare(b.number || '');
    });
    if (!vouchers.length) { el.innerHTML = '<div class="acct-empty">No vouchers yet. Use ➕ New Voucher to begin.</div>'; return; }

    var html = '<table class="acct-table"><thead><tr><th>Date</th><th>Voucher #</th><th>Type</th><th>Narration</th><th class="text-right">Debit</th><th class="text-right">Credit</th></tr></thead><tbody>';
    vouchers.forEach(function (v) {
        html += '<tr class="acct-clickable" data-voucher="' + v.id + '">' +
            '<td>' + wmsEsc(acctFmtDate(v.date)) + '</td>' +
            '<td>' + wmsEsc(v.number) + '</td>' +
            '<td><span class="acct-kind-badge">' + wmsEsc(v.type) + '</span></td>' +
            '<td>' + wmsEsc(v.narration || '') + '</td>' +
            '<td class="text-right">' + acctAmt(v.debit) + '</td>' +
            '<td class="text-right">' + acctAmt(v.credit) + '</td></tr>';
        // detail row (hidden until clicked)
        var det = '<tr class="acct-voucher-detail" data-detail="' + v.id + '" style="display:none;"><td colspan="6" style="background:#fcfcfd;">';
        det += '<table class="acct-table" style="margin:4px 0;"><tbody>';
        v.lines.forEach(function (ln) {
            det += '<tr><td class="acct-ledger-name" style="padding-left:24px;">' + wmsEsc(ln.ledger_name) + '</td>' +
                '<td class="text-right">' + (Number(ln.debit_amount) ? acctAmt(Number(ln.debit_amount)) : '-') + '</td>' +
                '<td class="text-right">' + (Number(ln.credit_amount) ? acctAmt(Number(ln.credit_amount)) : '-') + '</td></tr>';
        });
        det += '</tbody></table></td></tr>';
        html += det;
    });
    html += '</tbody></table>';
    el.innerHTML = html;

    el.querySelectorAll('tr[data-voucher]').forEach(function (tr) {
        tr.onclick = function () {
            var d = el.querySelector('tr[data-detail="' + tr.dataset.voucher + '"]');
            if (d) d.style.display = (d.style.display === 'none') ? '' : 'none';
        };
    });
}

function acctFmtDate(ymd) {
    if (!ymd) return '';
    var parts = String(ymd).split('-');
    if (parts.length !== 3) return ymd;
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return parts[2] + '-' + months[parseInt(parts[1], 10) - 1] + '-' + parts[0].slice(2);
}

function acctLedgerRowHtml(lg) {
    var avail = lg.is_global ? '<span class="acct-kind-badge">Global</span>'
        : '<span class="acct-scope-badge">' + wmsEsc(acctInvName(lg.scope_investor_id)) + ' only</span>';
    return '<tr><td class="acct-ledger-name" style="padding-left:34px;">' + wmsEsc(lg.name) + (lg.is_system ? ' <span class="acct-kind-badge">system</span>' : '') + '</td>' +
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

function acctRenderLedgers() {
    var el = document.getElementById('acctLedgersBody');
    if (!el) return;
    if (!acctLedgers.length) { el.innerHTML = '<div class="acct-empty">No ledgers in the catalogue.</div>'; return; }

    var roots = acctLedBuild();
    var allKeys = [];
    (function collect(list) { list.forEach(function (n) { allKeys.push(n.key); collect(n.subs || []); }); })(roots);

    // UI-STANDARDS D.2.2 - collapsible groups start collapsed. Seed once per session.
    if (acctLedCollapsed === null) {
        acctLedCollapsed = {};
        allKeys.forEach(function (k) { acctLedCollapsed[k] = true; });
    }
    // While a search is active, force everything open - otherwise a default-collapsed
    // tree shows nothing for a hit. The user's collapse state is untouched underneath
    // and comes back the moment the box is cleared.
    var searching = !!acctLedSearch;
    function isOpen(k) { return searching || !acctLedCollapsed[k]; }

    // Single controls row — the standalone Add Ledger / Add Group toolbar was folded
    // in here so the Ledgers tab spends one row on chrome instead of two.
    var html = '<div class="acct-led-controls">' +
        '<button class="wms-btn wms-btn-secondary" id="acctLedAddLedger">➕ Ledger</button>' +
        '<button class="wms-btn wms-btn-secondary" id="acctLedAddGroup">➕ Group</button>' +
        '<span style="width:10px;"></span>' +
        '<button class="wms-btn wms-btn-secondary" id="acctLedExpandAll">Expand all</button>' +
        '<button class="wms-btn wms-btn-secondary" id="acctLedCollapseAll">Collapse all</button>' +
        '<input type="text" id="acctLedSearchInput" class="wms-input" placeholder="Search ledgers &amp; groups" value="' + wmsEsc(acctLedSearch) + '"></div>';

    html += '<table class="acct-table"><thead><tr><th>Ledger / Group</th><th>Kind</th><th>Availability</th><th style="width:44px;"></th></tr></thead><tbody>';

    if (!roots.length) {
        html += '<tr><td colspan="4"><div class="acct-empty">Nothing matches &ldquo;' + wmsEsc(acctLedSearch) + '&rdquo;.</div></td></tr>';
    }

    // Render a sub-group and (recursively) its own sub-groups — the chart nests
    // 3 levels deep (Income → Investment Income → Capital Gains → ledger).
    function renderSub(sg, depth) {
        var sopen = isOpen(sg.key);
        var pad = 20 + (depth - 1) * 16;
        var h = '<tr class="acct-subgroup-row acct-led-grp" data-node="' + sg.key + '">' +
            '<td style="padding-left:' + pad + 'px;font-weight:600;color:#475569;">' +
            '<span class="acct-led-toggle' + (sopen ? '' : ' collapsed') + '">▼</span>' + wmsEsc(sg.label) +
            '<span class="acct-led-count">' + sg.count + '</span></td>' +
            '<td colspan="2"></td>' +
            '<td class="text-right"><button class="acct-edit-btn" data-edit-group="' + sg.id + '" title="Edit group">\u270F\uFE0F</button></td></tr>';
        if (sopen) {
            sg.ledgers.forEach(function (lg) { h += acctLedgerRowHtml(lg); });
            (sg.subs || []).forEach(function (sub) { h += renderSub(sub, depth + 1); });
        }
        return h;
    }
    roots.forEach(function (r) {
        var open = isOpen(r.key);
        html += '<tr class="acct-tb-group acct-led-grp" data-node="' + r.key + '"><td colspan="3">' +
            '<span class="acct-led-toggle' + (open ? '' : ' collapsed') + '">▼</span>' + wmsEsc(r.label) +
            '<span class="acct-led-count">' + r.count + '</span></td><td></td></tr>';
        if (!open) return;

        // ledgers hanging directly off the nature root
        r.ledgers.forEach(function (lg) { html += acctLedgerRowHtml(lg); });

        r.subs.forEach(function (sg) { html += renderSub(sg, 1); });
    });
    html += '</tbody></table>';
    el.innerHTML = html;

    el.querySelectorAll('.acct-led-grp[data-node]').forEach(function (row) {
        row.onclick = function () {
            acctLedCollapsed[row.dataset.node] = !acctLedCollapsed[row.dataset.node];
            acctRenderLedgers();
        };
    });
    // The edit pencils now sit INSIDE a clickable group row - without stopPropagation
    // opening the edit modal would also toggle the group underneath it.
    el.querySelectorAll('[data-edit-ledger]').forEach(function (b) {
        b.onclick = function (e) { e.stopPropagation(); acctOpenEditLedger(b.dataset.editLedger); };
    });
    el.querySelectorAll('[data-edit-group]').forEach(function (b) {
        b.onclick = function (e) { e.stopPropagation(); acctOpenEditGroup(b.dataset.editGroup); };
    });

    var alBtn = document.getElementById('acctLedAddLedger');
    if (alBtn) alBtn.onclick = acctOpenAddLedger;
    var agBtn = document.getElementById('acctLedAddGroup');
    if (agBtn) agBtn.onclick = acctOpenAddGroup;
    var ea = document.getElementById('acctLedExpandAll');
    if (ea) ea.onclick = function () { acctLedCollapsed = {}; acctRenderLedgers(); };
    var ca = document.getElementById('acctLedCollapseAll');
    if (ca) ca.onclick = function () { acctLedCollapsed = {}; allKeys.forEach(function (k) { acctLedCollapsed[k] = true; }); acctRenderLedgers(); };
    var srch = document.getElementById('acctLedSearchInput');
    if (srch) srch.oninput = function () {
        acctLedSearch = srch.value;
        acctRenderLedgers();
        var s2 = document.getElementById('acctLedSearchInput');
        if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); }
    };
}

// ============================================================================
// Opening balances — search-and-add entry for the book's single OPENING_BALANCE
// voucher. PLAN §7.2: one per book, dated at the book's start. Saving REPLACES
// the existing one, so the modal must prefill from it or reopening would wipe it.
// ============================================================================

var acctOpeningLines = [];        // [{ ledgerId, debit, credit }]
var acctOpeningDateYmd = null;
var acctOpeningActiveIdx = -1;    // highlighted row in the search results

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

function acctOpenOpeningModal() {
    if (!acctBookId) { acctToast('Select a book first (enable accounting on an investor).', true); return; }
    if (acctViewBookIds().length > 1) { acctToast('Opening balances are per book — exit the consolidated view first.', true); return; }

    // Prefill from the existing voucher; saving replaces it, so anything not shown
    // here would be silently dropped.
    var rows = acctOpeningExistingRows();
    acctOpeningLines = rows.map(function (r) {
        var dr = Number(r.debit_amount) || 0, cr = Number(r.credit_amount) || 0;
        return { ledgerId: r.ledger_id, debit: dr ? String(dr) : '', credit: cr ? String(cr) : '' };
    }).filter(function (l) {
        // The suspense plug is DERIVED, never user input. Restoring it as an editable
        // row would double-count it the moment a real line is corrected and re-saved,
        // so drop it and let the difference recompute from the real lines.
        return l.ledgerId && acctLedgerName(l.ledgerId) !== ACCT_OB_SUSPENSE;
    });

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
    var sb = document.getElementById('acctOpeningSearch');
    if (sb) sb.value = '';
    acctOpeningHideResults();
    acctRenderOpeningLines();
    if (acctOpeningModalCtrl) acctOpeningModalCtrl.open();
    if (sb) setTimeout(function () { sb.focus(); }, 50);
}

function acctOpeningCandidates(q) {
    var used = {};
    acctOpeningLines.forEach(function (l) { used[l.ledgerId] = true; });
    var needle = String(q || '').toLowerCase();
    return acctAvailableLedgers(acctBookId)
        .filter(function (l) { return !used[l.id] && (!needle || l.name.toLowerCase().indexOf(needle) >= 0); })
        .slice(0, 12);
}

function acctOpeningHideResults() {
    var box = document.getElementById('acctOpeningResults');
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
    acctOpeningActiveIdx = -1;
}

function acctOpeningRenderResults() {
    var box = document.getElementById('acctOpeningResults');
    var sb = document.getElementById('acctOpeningSearch');
    if (!box || !sb) return;
    var list = acctOpeningCandidates(sb.value);
    if (!sb.value && !list.length) { acctOpeningHideResults(); return; }
    if (!list.length) {
        box.innerHTML = '<div class="acct-ob-empty">No matching ledger. Use Ledgers → Add Ledger to create one.</div>';
        box.style.display = 'block';
        return;
    }
    box.innerHTML = list.map(function (l, i) {
        return '<div class="acct-ob-result' + (i === acctOpeningActiveIdx ? ' active' : '') + '" data-lid="' + l.id + '">' +
            '<span class="acct-ob-name">' + wmsEsc(l.name) + '</span>' +
            '<span class="acct-ob-grp">' + wmsEsc(acctRootName(l.group_id)) + '</span></div>';
    }).join('');
    box.style.display = 'block';
    box.querySelectorAll('.acct-ob-result').forEach(function (el) {
        el.onmousedown = function (e) { e.preventDefault(); acctOpeningAdd(el.dataset.lid); };
    });
}

function acctOpeningAdd(ledgerId) {
    if (!ledgerId) return;
    if (acctOpeningLines.some(function (l) { return l.ledgerId === ledgerId; })) return;
    acctOpeningLines.push({ ledgerId: ledgerId, debit: '', credit: '' });
    var sb = document.getElementById('acctOpeningSearch');
    if (sb) { sb.value = ''; sb.focus(); }
    acctOpeningHideResults();
    acctRenderOpeningLines();
    // focus the debit cell of the row just added
    var inp = document.querySelector('#acctOpeningLines tr:last-child .acct-ob-amt[data-field="debit"]');
    if (inp) inp.focus();
}

function acctLedgerName(id) {
    var l = acctLedgers.find(function (x) { return x.id === id; });
    return l ? l.name : '(unknown ledger)';
}

function acctRenderOpeningLines() {
    var tb = document.getElementById('acctOpeningLines');
    if (!tb) return;
    if (!acctOpeningLines.length) {
        tb.innerHTML = '<tr><td colspan="4" style="padding:14px;color:#a0aec0;font-size:12px;">' +
            'No ledgers yet — search above to add the accounts this book opens with ' +
            '(bank/broker balances, investments at cost, capital, client accounts).</td></tr>';
    } else {
        tb.innerHTML = acctOpeningLines.map(function (ln, idx) {
            return '<tr data-idx="' + idx + '">' +
                '<td><span class="acct-ob-name">' + wmsEsc(acctLedgerName(ln.ledgerId)) + '</span>' +
                '<span class="acct-ob-grp" style="margin-left:8px;">' + wmsEsc(acctRootName((acctLedgers.find(function (x) { return x.id === ln.ledgerId; }) || {}).group_id)) + '</span></td>' +
                '<td class="text-right"><input type="text" class="wms-input acct-ob-amt" data-idx="' + idx + '" data-field="debit" value="' + wmsEsc(ln.debit || '') + '" inputmode="decimal" style="text-align:right;"></td>' +
                '<td class="text-right"><input type="text" class="wms-input acct-ob-amt" data-idx="' + idx + '" data-field="credit" value="' + wmsEsc(ln.credit || '') + '" inputmode="decimal" style="text-align:right;"></td>' +
                '<td><button class="acct-line-del" data-del="' + idx + '" title="Remove">✕</button></td></tr>';
        }).join('');
    }

    tb.querySelectorAll('.acct-ob-amt').forEach(function (inp) {
        if (typeof wmsAttachAmountInput === 'function') wmsAttachAmountInput(inp, { allowNegative: false });
        inp.oninput = function () {
            var i = Number(inp.dataset.idx);
            acctOpeningLines[i][inp.dataset.field] = inp.value;
            // A line is Dr or Cr, never both — clear the opposite as you type.
            if (acctParse(inp.value) > 0) {
                var other = inp.dataset.field === 'debit' ? 'credit' : 'debit';
                acctOpeningLines[i][other] = '';
                var otherEl = tb.querySelector('.acct-ob-amt[data-idx="' + i + '"][data-field="' + other + '"]');
                if (otherEl) otherEl.value = '';
            }
            acctOpeningUpdateBalance();
        };
    });
    tb.querySelectorAll('[data-del]').forEach(function (b) {
        b.onclick = function () { acctOpeningLines.splice(Number(b.dataset.del), 1); acctRenderOpeningLines(); };
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
    document.getElementById('acctOpeningTotalDr').textContent = acctNum(t.dr);
    document.getElementById('acctOpeningTotalCr').textContent = acctNum(t.cr);
    document.getElementById('acctOpeningDiff').textContent = acctNum(Math.abs(t.diff));

    var balanced = Math.abs(t.diff) < 0.005;
    var bar = document.getElementById('acctOpeningBar');
    var msg = document.getElementById('acctOpeningMsg');
    var note = document.getElementById('acctOpeningNote');
    if (bar) bar.className = 'acct-balance-bar ' + (nonEmpty && balanced ? 'ok' : 'bad');
    if (msg) msg.textContent = !nonEmpty ? 'Nothing entered' : (balanced ? 'Balanced' : 'Out by ' + acctNum(Math.abs(t.diff)));
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
    var lines = acctOpeningLines
        .filter(function (l) { return acctParse(l.debit) > 0 || acctParse(l.credit) > 0; })
        .map(function (l) {
            return { ledger_id: l.ledgerId, debit_amount: acctParse(l.debit), credit_amount: acctParse(l.credit) };
        });
    if (!lines.length) { acctToast('Enter at least one amount.', true); return; }

    var btn = document.getElementById('acctOpeningSave');
    if (btn) btn.disabled = true;
    try {
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
    acctVoucherLines.push({ ledgerId: '', ledgerName: '', debit: '', credit: '', _auto: acctVoucherLines.length >= 1 });
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
    input.addEventListener('focus', render);
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

    // Enter/Tab on an amount: if the voucher ties, jump to narration (which then
    // tabs to Save). If it doesn't, Enter opens the next line pre-filled.
    inp.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== 'Tab') return;
        if (e.key === 'Tab' && e.shiftKey) return;
        if (acctVoucherIsBalanced()) {
            e.preventDefault();
            var n = document.getElementById('acctVoucherNarration');
            if (n) { n.focus(); n.select(); }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            acctAddVoucherLine(true);
        }
    });
}

function acctRenderVoucherLines() {
    var tb = document.getElementById('acctVoucherLines');
    if (!tb) return;
    acctSyncAutoLine();
    acctVoucherDdCtrls = {};

    tb.innerHTML = acctVoucherLines.map(function (ln, idx) {
        var nm = ln.ledgerId ? acctLedgerName(ln.ledgerId) : (ln.ledgerName || '');
        var autoCls = ln._auto ? ' acct-auto' : '';
        return '<tr data-idx="' + idx + '">' +
            '<td><div class="acct-line-pick">' +
                '<input type="text" class="acct-line-ledger" data-idx="' + idx + '" value="' + wmsEsc(nm) + '" placeholder="Search ledger…" autocomplete="off">' +
                '<div class="wms-dd acct-line-dd" data-idx="' + idx + '"></div>' +
            '</div></td>' +
            '<td class="text-right"><input type="text" class="acct-line-amt' + autoCls + '" data-idx="' + idx + '" data-field="debit" value="' + wmsEsc(ln.debit || '') + '"></td>' +
            '<td class="text-right"><input type="text" class="acct-line-amt' + autoCls + '" data-idx="' + idx + '" data-field="credit" value="' + wmsEsc(ln.credit || '') + '"></td>' +
            '<td><button class="acct-line-del" data-idx="' + idx + '" title="Remove line">✕</button></td></tr>';
    }).join('');

    tb.querySelectorAll('.acct-line-ledger').forEach(acctWireLedgerCell);
    tb.querySelectorAll('.acct-line-amt').forEach(acctWireAmountCell);
    tb.querySelectorAll('.acct-line-del').forEach(function (b) {
        b.onclick = function () {
            if (acctVoucherLines.length <= 1) return;
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
    var td = 0, tc = 0;
    acctVoucherLines.forEach(function (l) { td += acctParse(l.debit); tc += acctParse(l.credit); });
    var balanced = acctVoucherIsBalanced();
    var bar = document.getElementById('acctBalanceBar');
    var msg = document.getElementById('acctBalanceMsg');
    var dEl = document.getElementById('acctTotalDebit'); if (dEl) dEl.textContent = acctNum(td);
    var cEl = document.getElementById('acctTotalCredit'); if (cEl) cEl.textContent = acctNum(tc);
    if (bar) bar.className = 'acct-balance-bar ' + (balanced ? 'ok' : 'bad');
    if (msg) {
        var diff = Math.round((td - tc) * 100) / 100;
        msg.textContent = balanced ? 'Balanced'
            : (Math.abs(diff) >= 0.005 ? 'Out by ' + acctNum(Math.abs(diff))
                                       : 'Add at least two lines with a ledger');
    }
    var save = document.getElementById('acctVoucherSave');
    if (save) save.disabled = !balanced;
}

function acctOpenVoucherModal() {
    if (!acctBookId) { acctToast('Select a book first (enable accounting on an investor).', true); return; }
    acctEditingVoucherId = null;          // creating, not editing
    acctVoucherType = 'JOURNAL';
    acctVoucherDateYmd = acctTodayYmd();
    acctVoucherLines = [
        { ledgerId: '', ledgerName: '', debit: '', credit: '', _auto: false },
        { ledgerId: '', ledgerName: '', debit: '', credit: '', _auto: true }
    ];
    acctLedgerPickTarget = null;

    document.getElementById('acctVoucherTitle').textContent = 'New Voucher — ' + acctInvName(acctBookId);
    document.querySelectorAll('#acctVoucherTypeToggle .acct-type-btn').forEach(function (b) {
        b.classList.toggle('active', b.dataset.vtype === acctVoucherType);
    });
    document.getElementById('acctVoucherNarration').value = '';

    // Date widget
    var dc = document.getElementById('acctVoucherDate');
    if (dc && typeof wmsDateInput === 'function') {
        wmsDateInput(dc, { compact: true, onChange: function (ymd) { acctVoucherDateYmd = ymd; } });
    }

    acctRenderVoucherLines();
    if (acctVoucherModalCtrl) acctVoucherModalCtrl.open();
    // Land the caret on the first ledger field — the voucher is typed top-down.
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

async function acctSaveVoucher() {
    if (!acctBookId) return;
    var lines = acctVoucherLines.filter(function (l) { return acctParse(l.debit) > 0 || acctParse(l.credit) > 0; })
        .map(function (l, i) {
            return {
                ledger_id: l.ledgerId,
                debit_amount: wmsRoundMoney(acctParse(l.debit)),
                credit_amount: wmsRoundMoney(acctParse(l.credit)),
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
                             sort_order: l.sort_order };
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
    } catch (e) {
        console.error('[accounting] post voucher failed', e);
        acctToast('Could not post voucher: ' + e.message, true);
        if (saveBtn) saveBtn.disabled = false;
    }
}

// ============================================================================
// Ledger-detail modal
// ============================================================================
function acctOpenLedgerDetail(ledgerId) {
    var lg = acctLedgers.find(function (x) { return x.id === ledgerId; });
    if (!lg) return;
    var rows = acctVoucherRows.filter(function (r) { return r.ledger_id === ledgerId; });
    var body = document.getElementById('acctLedgerDetailBody');
    var g = acctGroupById[lg.group_id];

    var running = 0;
    var html = '<div class="acct-ledger-detail-head"><div class="acct-ld-name">' + wmsEsc(lg.name) + '</div>' +
        '<div class="acct-ld-sub">' + wmsEsc(acctGroupPath(g)) + ' · ' + wmsEsc(acctViewTitle()) + '</div></div>';
    if (!rows.length) {
        html += '<div class="acct-empty">No postings in this book.</div>';
    } else {
        html += '<table class="acct-table"><thead><tr><th>Date</th><th>Voucher #</th><th>Narration</th><th class="text-right">Debit</th><th class="text-right">Credit</th><th class="text-right">Balance</th></tr></thead><tbody>';
        rows.forEach(function (r) {
            var live = acctIsLive(r);
            if (live) running += (Number(r.debit_amount) || 0) - (Number(r.credit_amount) || 0);
            var balLabel = live ? acctNum(Math.abs(running)) + (running >= 0 ? ' Dr' : ' Cr') : '—';
            // Auto (PMS / rebuild-from-trades) vouchers are owned by the posting
            // engine — editing them here would be overwritten on the next rebuild.
            var auto = !!r.is_auto;
            var tip = !live ? 'Cancelled' + (r.cancel_reason ? ' — ' + r.cancel_reason : '') + ' · excluded from balances'
                    : auto ? 'Auto-posted from trades — edit the trade, not the voucher'
                           : 'Click to edit this voucher';
            html += '<tr class="acct-vch-row' + (auto ? ' acct-vch-auto' : '') + (live ? '' : ' acct-vch-cancelled') +
                '" data-voucher="' + r.voucher_id + '" title="' + wmsEsc(tip) + '">' +
                '<td>' + wmsEsc(acctFmtDate(r.voucher_date)) + '</td>' +
                '<td>' + wmsEsc(r.voucher_number) +
                    (auto ? ' <span class="acct-kind-badge">auto</span>' : '') +
                    (live ? '' : ' <span class="acct-scope-badge">cancelled</span>') + '</td>' +
                '<td>' + wmsEsc(r.line_narration || r.voucher_narration || '') + '</td>' +
                '<td class="text-right">' + (Number(r.debit_amount) ? acctAmt(Number(r.debit_amount)) : '-') + '</td>' +
                '<td class="text-right">' + (Number(r.credit_amount) ? acctAmt(Number(r.credit_amount)) : '-') + '</td>' +
                '<td class="text-right">' + balLabel + '</td></tr>';
        });
        html += '</tbody></table>';
    }
    body.innerHTML = html;
    body.querySelectorAll('.acct-vch-row[data-voucher]').forEach(function (tr) {
        tr.onclick = function () { acctOpenEditVoucher(tr.dataset.voucher); };
    });
    if (acctLedgerModalCtrl) acctLedgerModalCtrl.open();
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
    if (rows[0].is_auto) {
        acctToast('“' + rows[0].voucher_number + '” was auto-posted from trades. Edit the underlying trade, then Rebuild.', true);
        return;
    }
    if (acctLedgerModalCtrl) acctLedgerModalCtrl.close();

    acctEditingVoucherId = voucherId;
    acctVoucherType = rows[0].voucher_type;
    acctVoucherDateYmd = rows[0].voucher_date;
    acctLedgerPickTarget = null;
    acctVoucherLines = rows
        .slice()
        .sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); })
        .map(function (r) {
            var d = Number(r.debit_amount) || 0, c = Number(r.credit_amount) || 0;
            return { ledgerId: r.ledger_id, ledgerName: acctLedgerName(r.ledger_id),
                     debit: d ? String(d) : '', credit: c ? String(c) : '', _auto: false };
        });

    document.getElementById('acctVoucherTitle').textContent = 'Edit Voucher ' + rows[0].voucher_number + ' — ' + acctInvName(acctBookId);
    document.querySelectorAll('#acctVoucherTypeToggle .acct-type-btn').forEach(function (b) {
        b.classList.toggle('active', b.dataset.vtype === acctVoucherType);
    });
    document.getElementById('acctVoucherNarration').value = rows[0].voucher_narration || '';
    var dc = document.getElementById('acctVoucherDate');
    if (dc && typeof wmsDateInput === 'function') {
        var ctrl = wmsDateInput(dc, { compact: true, onChange: function (ymd) { acctVoucherDateYmd = ymd; } });
        if (ctrl && ctrl.setValue) ctrl.setValue(acctVoucherDateYmd);
    }
    acctRenderVoucherLines();
    if (acctVoucherModalCtrl) acctVoucherModalCtrl.open();
}

// ============================================================================
// Add ledger / add group modals
// ============================================================================
function acctGroupSelectOptions(selectedId, rootsOnlyAllowed) {
    // Order: roots then their children, indented
    var html = '';
    acctNatureOrder.forEach(function (rootName) {
        var root = acctGroups.find(function (g) { return !g.parent_group_id && g.name === rootName; });
        if (!root) return;
        html += '<option value="' + root.id + '"' + (root.id === selectedId ? ' selected' : '') + '>' + wmsEsc(root.name) + '</option>';
        acctGroups.filter(function (g) { return g.parent_group_id === root.id; })
            .sort(function (a, b) { return a.name.localeCompare(b.name); })
            .forEach(function (g) {
                html += '<option value="' + g.id + '"' + (g.id === selectedId ? ' selected' : '') + '>&nbsp;&nbsp;&nbsp;' + wmsEsc(g.name) + '</option>';
            });
    });
    return html;
}

function acctSetLedgerModal(lg) {
    var t = document.getElementById('acctAddLedgerTitle'); if (t) t.textContent = lg ? 'Edit Ledger' : 'Add Ledger';
    document.getElementById('acctNewLedgerName').value = lg ? lg.name : '';
    document.getElementById('acctNewLedgerGroup').innerHTML = acctGroupSelectOptions(lg ? lg.group_id : null);
    acctNewLedgerScope = (lg && !lg.is_global) ? 'restricted' : 'global';
    document.querySelectorAll('#acctNewLedgerScopeToggle .acct-type-btn').forEach(function (b) {
        b.classList.toggle('active', b.dataset.scope === acctNewLedgerScope);
    });
    document.getElementById('acctNewLedgerScopeBookWrap').style.display = (acctNewLedgerScope === 'restricted') ? '' : 'none';
    var scopeId = (lg && lg.scope_investor_id) ? lg.scope_investor_id : acctBookId;
    document.getElementById('acctNewLedgerScopeBook').innerHTML = acctOwnBooks().map(function (b) {
        return '<option value="' + b.id + '"' + (b.id === scopeId ? ' selected' : '') + '>' + wmsEsc(b.short_name || b.name) + '</option>';
    }).join('');
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
    var isGlobal = acctNewLedgerScope === 'global';
    var body = {
        name: name, group_id: groupId, is_global: isGlobal,
        scope_investor_id: isGlobal ? null : (document.getElementById('acctNewLedgerScopeBook').value || null)
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

// ============================================================================
// Modal wiring (rebuilt each module load — fresh DOM)
// ============================================================================
function acctWireModals() {
    // Voucher modal
    var vOverlay = document.getElementById('acctVoucherModal');
    if (vOverlay && typeof wmsModal === 'function') acctVoucherModalCtrl = wmsModal(vOverlay, {});
    document.getElementById('acctVoucherClose').onclick = function () { acctVoucherModalCtrl && acctVoucherModalCtrl.close(); };
    document.getElementById('acctVoucherCancel').onclick = function () { acctVoucherModalCtrl && acctVoucherModalCtrl.close(); };
    document.getElementById('acctVoucherSave').onclick = acctSaveVoucher;

    // Opening-balances modal
    var obOverlay = document.getElementById('acctOpeningModal');
    if (obOverlay && typeof wmsModal === 'function') acctOpeningModalCtrl = wmsModal(obOverlay, {});
    var obClose = document.getElementById('acctOpeningClose');
    if (obClose) obClose.onclick = function () { acctOpeningModalCtrl && acctOpeningModalCtrl.close(); };
    var obCancel = document.getElementById('acctOpeningCancel');
    if (obCancel) obCancel.onclick = function () { acctOpeningModalCtrl && acctOpeningModalCtrl.close(); };
    var obSave = document.getElementById('acctOpeningSave');
    if (obSave) obSave.onclick = acctSaveOpening;
    var obBtn = document.getElementById('acctOpeningBtn');
    if (obBtn) obBtn.onclick = acctOpenOpeningModal;
    var obSearch = document.getElementById('acctOpeningSearch');
    if (obSearch) {
        obSearch.oninput = function () { acctOpeningActiveIdx = -1; acctOpeningRenderResults(); };
        obSearch.onfocus = acctOpeningRenderResults;
        // mousedown on a result fires before blur, so the click still lands.
        obSearch.onblur = function () { setTimeout(acctOpeningHideResults, 120); };
        obSearch.onkeydown = function (e) {
            var list = acctOpeningCandidates(obSearch.value);
            if (e.key === 'ArrowDown') { e.preventDefault(); acctOpeningActiveIdx = Math.min(acctOpeningActiveIdx + 1, list.length - 1); acctOpeningRenderResults(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); acctOpeningActiveIdx = Math.max(acctOpeningActiveIdx - 1, 0); acctOpeningRenderResults(); }
            else if (e.key === 'Enter') {
                e.preventDefault();
                var pick = list[acctOpeningActiveIdx >= 0 ? acctOpeningActiveIdx : 0];
                if (pick) acctOpeningAdd(pick.id);
            } else if (e.key === 'Escape') { acctOpeningHideResults(); }
        };
    }
    document.getElementById('acctAddLineBtn').onclick = function () { acctAddVoucherLine(true); };

    // Narration is the last field typed: Tab or Enter from here goes to Save.
    var narEl = document.getElementById('acctVoucherNarration');
    if (narEl) narEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
            var save = document.getElementById('acctVoucherSave');
            if (save && !save.disabled) { e.preventDefault(); save.focus(); }
        }
    });
    var abBtn = document.getElementById('acctAutoBalanceBtn');
    if (abBtn) abBtn.onclick = acctAutoBalance;
    document.querySelectorAll('#acctVoucherTypeToggle .acct-type-btn').forEach(function (b) {
        b.onclick = function () {
            acctVoucherType = b.dataset.vtype;
            document.querySelectorAll('#acctVoucherTypeToggle .acct-type-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
        };
    });
    // Line edits via delegation
    var linesTb = document.getElementById('acctVoucherLines');
    linesTb.addEventListener('change', function (e) {
        if (e.target.classList.contains('acct-line-ledger')) {
            acctVoucherLines[+e.target.dataset.idx].ledgerId = e.target.value;
            acctUpdateBalance();
        }
    });
    linesTb.addEventListener('input', function (e) {
        if (e.target.classList.contains('acct-line-amt')) {
            var idx = +e.target.dataset.idx, field = e.target.dataset.field;
            acctVoucherLines[idx][field] = e.target.value;
            // a line is debit OR credit — clear the other side
            var other = field === 'debit' ? 'credit' : 'debit';
            if (acctParse(e.target.value) > 0) {
                acctVoucherLines[idx][other] = '';
                var otherInput = linesTb.querySelector('input[data-idx="' + idx + '"][data-field="' + other + '"]');
                if (otherInput) otherInput.value = '';
            }
            acctUpdateBalance();
        }
    });
    linesTb.addEventListener('click', function (e) {
        if (e.target.classList.contains('acct-line-del')) {
            var idx = +e.target.dataset.idx;
            if (acctVoucherLines.length <= 2) { acctToast('A voucher needs at least two lines.', true); return; }
            acctVoucherLines.splice(idx, 1);
            acctRenderVoucherLines();
        }
    });

    // Ledger-detail modal
    var lOverlay = document.getElementById('acctLedgerModal');
    if (lOverlay && typeof wmsModal === 'function') acctLedgerModalCtrl = wmsModal(lOverlay, {});
    document.getElementById('acctLedgerClose').onclick = function () { acctLedgerModalCtrl && acctLedgerModalCtrl.close(); };
    document.getElementById('acctLedgerDone').onclick = function () { acctLedgerModalCtrl && acctLedgerModalCtrl.close(); };

    // Add-ledger modal
    var alOverlay = document.getElementById('acctAddLedgerModal');
    if (alOverlay && typeof wmsModal === 'function') acctAddLedgerModalCtrl = wmsModal(alOverlay, {});
    document.getElementById('acctAddLedgerClose').onclick = function () { acctAddLedgerModalCtrl && acctAddLedgerModalCtrl.close(); };
    document.getElementById('acctAddLedgerCancel').onclick = function () { acctAddLedgerModalCtrl && acctAddLedgerModalCtrl.close(); };
    document.getElementById('acctAddLedgerSave').onclick = acctSaveLedger;
    document.querySelectorAll('#acctNewLedgerScopeToggle .acct-type-btn').forEach(function (b) {
        b.onclick = function () {
            acctNewLedgerScope = b.dataset.scope;
            document.querySelectorAll('#acctNewLedgerScopeToggle .acct-type-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
            document.getElementById('acctNewLedgerScopeBookWrap').style.display = (acctNewLedgerScope === 'restricted') ? '' : 'none';
        };
    });

    // Add-group modal
    var agOverlay = document.getElementById('acctAddGroupModal');
    if (agOverlay && typeof wmsModal === 'function') acctAddGroupModalCtrl = wmsModal(agOverlay, {});
    document.getElementById('acctAddGroupClose').onclick = function () { acctAddGroupModalCtrl && acctAddGroupModalCtrl.close(); };
    document.getElementById('acctAddGroupCancel').onclick = function () { acctAddGroupModalCtrl && acctAddGroupModalCtrl.close(); };
    document.getElementById('acctAddGroupSave').onclick = acctSaveGroup;

    // Rebuild report modal
    var rpOverlay = document.getElementById('acctReportModal');
    if (rpOverlay && typeof wmsModal === 'function') acctReportModalCtrl = wmsModal(rpOverlay, {});
    var rpClose = document.getElementById('acctReportClose');
    if (rpClose) rpClose.onclick = function () { acctReportModalCtrl && acctReportModalCtrl.close(); };
    var rpDone = document.getElementById('acctReportDone');
    if (rpDone) rpDone.onclick = function () { acctReportModalCtrl && acctReportModalCtrl.close(); };

    // Consolidate modal
    var coOverlay = document.getElementById('acctConsolidateModal');
    if (coOverlay && typeof wmsModal === 'function') acctConsolidateModalCtrl = wmsModal(coOverlay, {});
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
async function acctRebuildOne(bookId) {
    var fields = 'id,investor_id,trader_id,broker_id,security_id,symbol,short_symbol,company_name,' +
        'security_type,transaction_type,transaction_date,transaction_time,quantity,price,' +
        'gross_amount,total_charges,stt,tds,net_amount,created_at';
    var txns = await wmsFetchAllRaw(acctUrl('transactions?select=' + fields + '&investor_id=eq.' + bookId)) || [];
    var bookInv = (wmsRefData.investors || []).find(function (i) { return i.id === bookId; }) || {};
    var ctx = {
        investor: function (id) { return (wmsRefData.investors || []).find(function (i) { return i.id === id; }); },
        brokerName: function (id) { var b = (wmsRefData.brokers || []).find(function (x) { return x.id === id; }); return b ? (b.name || b.broker_code) : 'Broker'; },
        sttSeparate: !!bookInv.stt_accounting_method,
        postFno: bookInv.post_fno !== false
    };
    var result = acctProcessBook(bookId, txns, ctx);

    // group skip reasons (collapse digit runs so similar reasons aggregate)
    var skipReasons = {};
    result.skipped.forEach(function (s) {
        var key = String(s.reason).replace(/\d[\d,.]*/g, 'N');
        skipReasons[key] = (skipReasons[key] || 0) + 1;
    });

    var keyMap = {};
    if (result.vouchers.length) {
        var uniqueKeys = {};
        result.vouchers.forEach(function (v) { v.lines.forEach(function (l) { uniqueKeys[l.ledger.key] = l.ledger; }); });
        await acctResolveLedgers(Object.keys(uniqueKeys).map(function (k) { return uniqueKeys[k]; }), keyMap);
    }

    // clear existing autos for this book (lines cascade)
    await fetch(acctUrl('acct_vouchers?investor_id=eq.' + bookId + '&is_auto=eq.true'),
        { method: 'DELETE', headers: wmsHeaders({ 'Prefer': 'return=minimal' }) });

    var posted = 0, failed = 0, firstErr = null;
    for (var j = 0; j < result.vouchers.length; j++) {
        var v = result.vouchers[j];
        var header = { investor_id: bookId, voucher_type: v.voucherType, voucher_date: v.date,
            narration: v.narration, is_auto: true, source_transaction_id: v.txnId };
        var lines = v.lines.map(function (l) {
            return { ledger_id: keyMap[l.ledger.key], debit_amount: l.debit, credit_amount: l.credit,
                narration: l.narration, sort_order: l.sort_order };
        });
        if (lines.some(function (l) { return !l.ledger_id; })) { failed++; continue; }
        var resp = await fetch(acctUrl('rpc/acct_post_voucher'), {
            method: 'POST', headers: wmsHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ p_header: header, p_lines: lines })
        });
        if (resp.ok) posted++; else { failed++; if (!firstErr) firstErr = await resp.text(); }
    }
    if (result.warnings.length) console.warn('[accounting] rebuild warnings for ' + acctInvName(bookId), result.warnings);
    if (firstErr) console.error('[accounting] rebuild first error (' + acctInvName(bookId) + '):', firstErr);

    return { bookId: bookId, book: acctInvName(bookId), posted: posted, skipped: result.skipped.length,
        failed: failed, warnings: result.warnings.length, skipReasons: skipReasons,
        warningsList: result.warnings, firstErr: firstErr };
}

async function acctRebuildBooks() {
    if (!acctBookId) { acctToast('Select a book first.', true); return; }
    if (typeof acctProcessBook !== 'function') { acctToast('Posting engine not loaded.', true); return; }
    if (!window.confirm('Rebuild auto-vouchers for ' + acctInvName(acctBookId) + ' from its transactions?\n\n' +
        'This deletes existing AUTO-generated vouchers for this book and regenerates them. Manual vouchers are kept.')) return;
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
    if (typeof acctProcessBook !== 'function') { acctToast('Posting engine not loaded.', true); return; }
    var books = acctOwnBooks();
    if (!books.length) { acctToast('No own-books to rebuild.', true); return; }
    if (!window.confirm('Rebuild auto-vouchers for ALL ' + books.length + ' books from their transactions?\n\n' +
        'Deletes and regenerates auto-vouchers for every book (manual vouchers kept). May take a minute for large books.')) return;
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
    var html = '<table class="acct-table"><thead><tr><th>Book</th><th class="text-right">Posted</th><th class="text-right">Skipped</th><th class="text-right">Failed</th><th class="text-right">Warn</th></tr></thead><tbody>';
    reports.forEach(function (r) {
        html += '<tr><td>' + wmsEsc(r.book) + '</td>' +
            '<td class="text-right">' + r.posted + '</td>' +
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
