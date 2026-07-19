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
function acctViewTitle() {
    if (acctIsConsolidated()) return 'Consolidated (' + acctBookIds.length + ' books)';
    var ids = acctViewBookIds();
    return ids.length ? acctInvName(ids[0]) : '—';
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
    var consol = acctIsConsolidated();
    ['acctNewVoucherBtn', 'acctRebuildBtn'].forEach(function (id) {
        var b = document.getElementById(id);
        if (b) b.disabled = consol;
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
        if (ids.length === 1) { acctBookId = ids[0]; var s = document.getElementById('acctBookSelect'); if (s) s.value = ids[0]; }
    } else {
        acctBookIds = ids;
    }
    acctLoading(true);
    try { await acctLoadBook(); acctRenderActiveTab(); acctSyncConsolChip(); acctSyncActionButtons(); }
    finally { acctLoading(false); }
}
async function acctClearConsolidate() {
    acctBookIds = null;
    if (acctConsolidateModalCtrl) acctConsolidateModalCtrl.close();
    acctLoading(true);
    try { await acctLoadBook(); acctRenderActiveTab(); acctSyncConsolChip(); acctSyncActionButtons(); }
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

        // Book selector
        var books = acctOwnBooks();
        var sel = document.getElementById('acctBookSelect');
        if (sel) {
            if (!books.length) {
                sel.innerHTML = '<option value="">— No books enabled —</option>';
                acctBookId = null;
            } else {
                if (!acctBookId || !books.some(function (b) { return b.id === acctBookId; })) {
                    acctBookId = books[0].id;
                }
                sel.innerHTML = books.map(function (b) {
                    return '<option value="' + b.id + '"' + (b.id === acctBookId ? ' selected' : '') + '>' +
                        wmsEsc(b.short_name || b.name) + '</option>';
                }).join('');
            }
        }

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
    // Book select
    var sel = document.getElementById('acctBookSelect');
    if (sel) sel.onchange = async function () {
        acctBookId = sel.value || null;
        acctBookIds = null;   // picking a single book clears consolidation
        acctLoading(true);
        try { await acctLoadBook(); acctRenderActiveTab(); acctSyncConsolChip(); acctSyncActionButtons(); }
        finally { acctLoading(false); }
    };
    var cb = document.getElementById('acctConsolidateBtn');
    if (cb) cb.onclick = acctOpenConsolidate;

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

    // Header actions
    var nv = document.getElementById('acctNewVoucherBtn');
    if (nv) nv.onclick = acctOpenVoucherModal;
    var rf = document.getElementById('acctRefreshBtn');
    if (rf) rf.onclick = async function () {
        acctLoading(true);
        try { await acctLoadCatalogue(); await acctLoadBook(); acctRenderActiveTab(); }
        finally { acctLoading(false); }
    };
    var rb = document.getElementById('acctRebuildBtn');
    if (rb) rb.onclick = acctRebuildBooks;
    var rba = document.getElementById('acctRebuildAllBtn');
    if (rba) rba.onclick = acctRebuildAll;

    // Ledger tab toolbar
    var al = document.getElementById('acctAddLedgerBtn');
    if (al) al.onclick = acctOpenAddLedger;
    var ag = document.getElementById('acctAddGroupBtn');
    if (ag) ag.onclick = acctOpenAddGroup;

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
var acctFinSearch = '';

function acctFinMatch(name) { return !acctFinSearch || String(name).toLowerCase().indexOf(acctFinSearch.toLowerCase()) >= 0; }
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
        if (!acctFinShowZero && Math.round(amt * 100) === 0) return null;
        return { key: 'l:' + lg.id, label: lg.name, amount: amt, isLedger: true, ledgerId: lg.id };
    }
    acctLedgers.filter(function (l) { return l.group_id === root.id; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); })
        .forEach(function (l) { if (acctFinMatch(l.name)) { var n = ledgerNode(l); if (n) nodes.push(n); } });
    acctGroups.filter(function (g) { return g.parent_group_id === root.id; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); })
        .forEach(function (cg) {
            var children = [];
            acctLedgers.filter(function (l) { return l.group_id === cg.id; })
                .sort(function (a, b) { return a.name.localeCompare(b.name); })
                .forEach(function (l) {
                    if (!acctFinMatch(l.name) && !acctFinMatch(cg.name)) return;
                    var n = ledgerNode(l); if (n) children.push(n);
                });
            if (!children.length && !acctFinShowZero) return;
            var total = children.reduce(function (a, n) { return a + n.amount; }, 0);
            nodes.push({ key: 'g:' + cg.id, label: cg.name, amount: total, children: children });
        });
    return { nodes: nodes, total: nodes.reduce(function (a, n) { return a + n.amount; }, 0) };
}
function acctFinNodeHtml(node, depth) {
    var pad = 12 + depth * 18;
    var isGroup = !node.isLedger && !node.isDiff;
    var collapsed = isGroup && acctFinCollapsed[node.key];
    var icon = isGroup
        ? '<span class="acct-fin-toggle">' + (collapsed ? '⊕' : '⊖') + '</span>'
        : '<span class="acct-fin-toggle-sp"></span>';
    var cls = node.isDiff ? 'acct-fin-row acct-fin-diff'
        : 'acct-fin-row ' + (isGroup ? 'acct-fin-group' : 'acct-fin-ledger acct-clickable');
    var attr = node.isDiff ? '' : (isGroup ? ('data-node="' + node.key + '"') : ('data-ledger="' + node.ledgerId + '"'));
    var h = '<div class="' + cls + '" ' + attr + ' style="padding-left:' + pad + 'px;">' +
        icon + '<span class="acct-fin-name">' + wmsEsc(node.label) + '</span>' +
        '<span class="acct-fin-amt">' + acctAmt(node.amount) + '</span></div>';
    if (isGroup && node.children && !collapsed) {
        node.children.forEach(function (c) { h += acctFinNodeHtml(c, depth + 1); });
    }
    return h;
}
function acctFinColumnHtml(title, asOn, nodes) {
    var h = '<div class="acct-fin-col"><div class="acct-fin-hdr"><span>' + wmsEsc(title) + '</span><span>Bal. as on ' + wmsEsc(asOn) + '</span></div>';
    nodes.forEach(function (n) { h += acctFinNodeHtml(n, 0); });
    return h + '</div>';
}
function acctFinAllGroupKeys(nodes, acc) {
    nodes.forEach(function (n) { if (!n.isLedger) { acc.push(n.key); if (n.children) acctFinAllGroupKeys(n.children, acc); } });
    return acc;
}
function acctFinAsOn() {
    var max = '';
    acctVoucherRows.forEach(function (r) { if (r.voucher_date > max) max = r.voucher_date; });
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
        '<input type="text" id="acctFinSearch" class="wms-input" placeholder="Search ledgers & groups" value="' + wmsEsc(acctFinSearch) + '">' +
        '</div>';
    html += '<div class="acct-fin-scope">' + wmsEsc(acctViewTitle()) + '</div>';
    html += '<div class="acct-fin-cols">' +
        acctFinColumnHtml('Liabilities', asOn, leftNodes) +
        acctFinColumnHtml('Assets', asOn, assets.nodes) + '</div>';
    html += '<div class="acct-fin-total"><span>Total' + (balanced ? '' : ' ⚠ out of balance') + '</span><span>' + acctAmt(assets.total) + '</span></div>';
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
    var srch = document.getElementById('acctFinSearch');
    if (srch) srch.oninput = function () {
        acctFinSearch = srch.value; acctRenderFinancials();
        var s2 = document.getElementById('acctFinSearch');
        if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); }
    };
}

// ── Profit & Loss — T-format (Expenses | Income), same style as the BS ───────
function acctRenderPL() {
    var el = document.getElementById('acctPLBody');
    if (!el) return;
    if (!acctViewBookIds().length) { el.innerHTML = '<div class="acct-empty">No book selected. Enable accounting on an investor first.</div>'; return; }
    if (!acctVoucherRows.length) { el.innerHTML = '<div class="acct-empty">No postings yet for ' + wmsEsc(acctViewTitle()) + '.</div>'; return; }
    var net = acctComputeBalances();
    var asOn = acctFinAsOn();
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
        '<input type="text" id="acctPLSearch" class="wms-input" placeholder="Search ledgers & groups" value="' + wmsEsc(acctFinSearch) + '"></div>';
    html += '<div class="acct-fin-scope">' + wmsEsc(acctViewTitle()) + ' · Profit &amp; Loss</div>';
    html += '<div class="acct-fin-cols">' +
        acctFinColumnHtml('Expenses', asOn, leftNodes) +
        acctFinColumnHtml('Income', asOn, rightNodes) + '</div>';
    html += '<div class="acct-fin-total"><span>Total</span><span>' + acctAmt(rightTotal) + '</span></div>';
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
    var srch = document.getElementById('acctPLSearch'); if (srch) srch.oninput = function () { acctFinSearch = srch.value; acctRenderPL(); var s2 = document.getElementById('acctPLSearch'); if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); } };
}

// ── Trial Balance — grouped collapsible tree with Debit/Credit columns ───────
function acctTbBuild(net) {
    var nodes = [];
    acctNatureOrder.forEach(function (nm) {
        var root = acctGroups.find(function (g) { return !g.parent_group_id && g.name === nm; });
        if (!root) return;
        var rootNode = { key: 'tg:' + root.id, label: root.name, dr: 0, cr: 0, children: [] };
        function ledNode(l) {
            var b = net[l.id] || 0;
            if (!acctFinShowZero && Math.round(b * 100) === 0) return null;
            return { key: 'l:' + l.id, label: l.name, dr: b > 0 ? b : 0, cr: b < 0 ? -b : 0, isLedger: true, ledgerId: l.id };
        }
        acctLedgers.filter(function (l) { return l.group_id === root.id; })
            .sort(function (a, b) { return a.name.localeCompare(b.name); })
            .forEach(function (l) { if (!acctFinMatch(l.name)) return; var n = ledNode(l); if (n) { rootNode.children.push(n); rootNode.dr += n.dr; rootNode.cr += n.cr; } });
        acctGroups.filter(function (g) { return g.parent_group_id === root.id; })
            .sort(function (a, b) { return a.name.localeCompare(b.name); })
            .forEach(function (cg) {
                var gnode = { key: 'tg:' + cg.id, label: cg.name, dr: 0, cr: 0, children: [] };
                acctLedgers.filter(function (l) { return l.group_id === cg.id; })
                    .sort(function (a, b) { return a.name.localeCompare(b.name); })
                    .forEach(function (l) { if (!acctFinMatch(l.name) && !acctFinMatch(cg.name)) return; var n = ledNode(l); if (n) { gnode.children.push(n); gnode.dr += n.dr; gnode.cr += n.cr; } });
                if (!gnode.children.length && !acctFinShowZero) return;
                rootNode.children.push(gnode); rootNode.dr += gnode.dr; rootNode.cr += gnode.cr;
            });
        if (rootNode.children.length || acctFinShowZero) nodes.push(rootNode);
    });
    return nodes;
}
function acctTbNodeHtml(node, depth) {
    var pad = 12 + depth * 18;
    var isGroup = !node.isLedger;
    var collapsed = isGroup && acctFinCollapsed[node.key];
    var icon = isGroup ? '<span class="acct-fin-toggle">' + (collapsed ? '⊕' : '⊖') + '</span>' : '<span class="acct-fin-toggle-sp"></span>';
    var cls = 'acct-fin-row ' + (isGroup ? 'acct-fin-group' : 'acct-fin-ledger acct-clickable');
    var attr = isGroup ? ('data-node="' + node.key + '"') : ('data-ledger="' + node.ledgerId + '"');
    var h = '<div class="' + cls + '" ' + attr + ' style="padding-left:' + pad + 'px;">' + icon +
        '<span class="acct-fin-name">' + wmsEsc(node.label) + '</span>' +
        '<span class="acct-tb-dr">' + (node.dr ? acctAmt(node.dr) : '') + '</span>' +
        '<span class="acct-tb-cr">' + (node.cr ? acctAmt(node.cr) : '') + '</span></div>';
    if (isGroup && node.children && !collapsed) { node.children.forEach(function (c) { h += acctTbNodeHtml(c, depth + 1); }); }
    return h;
}
function acctRenderTrialBalance() {
    var el = document.getElementById('acctTBBody');
    if (!el) return;
    if (!acctViewBookIds().length) { el.innerHTML = '<div class="acct-empty">No book selected. Enable accounting on an investor first.</div>'; return; }
    if (!acctVoucherRows.length) { el.innerHTML = '<div class="acct-empty">No postings yet for ' + wmsEsc(acctViewTitle()) + '.</div>'; return; }
    var net = acctComputeBalances();
    var nodes = acctTbBuild(net);
    var totDr = nodes.reduce(function (a, n) { return a + n.dr; }, 0);
    var totCr = nodes.reduce(function (a, n) { return a + n.cr; }, 0);

    var html = '<div class="acct-fin-controls">' +
        '<button class="wms-btn wms-btn-secondary" id="acctTbExpandAll">Expand all</button>' +
        '<button class="wms-btn wms-btn-secondary" id="acctTbCollapseAll">Collapse all</button>' +
        '<label class="acct-fin-zero"><input type="checkbox" id="acctTbShowZeroChk"' + (acctFinShowZero ? ' checked' : '') + '> Show zero values</label>' +
        '<input type="text" id="acctTbSearch" class="wms-input" placeholder="Search ledgers & groups" value="' + wmsEsc(acctFinSearch) + '"></div>';
    html += '<div class="acct-fin-scope">' + wmsEsc(acctViewTitle()) + ' · Trial Balance</div>';
    html += '<div class="acct-tb-wrap"><div class="acct-fin-hdr"><span class="acct-fin-toggle-sp"></span><span class="acct-fin-name">Ledger</span><span class="acct-tb-dr">Debit</span><span class="acct-tb-cr">Credit</span></div>';
    nodes.forEach(function (n) { html += acctTbNodeHtml(n, 0); });
    html += '</div>';
    var bal = Math.round(totDr * 100) === Math.round(totCr * 100);
    html += '<div class="acct-fin-total"><span class="acct-fin-name">Total' + (bal ? '' : ' ⚠ Dr ≠ Cr') + '</span><span class="acct-tb-dr">' + acctAmt(totDr) + '</span><span class="acct-tb-cr">' + acctAmt(totCr) + '</span></div>';
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
    var srch = document.getElementById('acctTbSearch'); if (srch) srch.oninput = function () { acctFinSearch = srch.value; acctRenderTrialBalance(); var s2 = document.getElementById('acctTbSearch'); if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); } };
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
    var roots = [];
    acctNatureOrder.forEach(function (nature) {
        var root = acctGroups.find(function (g) { return !g.parent_group_id && g.name === nature; });
        if (!root) return;
        var natureHit = acctLedMatch(nature);
        var node = { key: 'n:' + root.id, label: nature, ledgers: [], subs: [], count: 0 };

        acctLedgers.filter(function (l) { return l.group_id === root.id; })
            .sort(acctLedByName)
            .forEach(function (l) { if (natureHit || acctLedMatch(l.name)) node.ledgers.push(l); });

        acctGroups.filter(function (g) { return g.parent_group_id === root.id; })
            .sort(acctLedByName)
            .forEach(function (cg) {
                var groupHit = natureHit || acctLedMatch(cg.name);
                var kids = acctLedgers.filter(function (l) { return l.group_id === cg.id; })
                    .sort(acctLedByName)
                    .filter(function (l) { return groupHit || acctLedMatch(l.name); });
                if (!kids.length && !groupHit) return;          // no match anywhere in this sub-group
                node.subs.push({ key: 'g:' + cg.id, id: cg.id, label: cg.name, ledgers: kids });
            });

        node.count = node.ledgers.length + node.subs.reduce(function (a, sg) { return a + sg.ledgers.length; }, 0);
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
    roots.forEach(function (r) { allKeys.push(r.key); r.subs.forEach(function (sg) { allKeys.push(sg.key); }); });

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

    var html = '<div class="acct-led-controls">' +
        '<button class="wms-btn wms-btn-secondary" id="acctLedExpandAll">Expand all</button>' +
        '<button class="wms-btn wms-btn-secondary" id="acctLedCollapseAll">Collapse all</button>' +
        '<input type="text" id="acctLedSearchInput" class="wms-input" placeholder="Search ledgers &amp; groups" value="' + wmsEsc(acctLedSearch) + '"></div>';

    html += '<table class="acct-table"><thead><tr><th>Ledger / Group</th><th>Kind</th><th>Availability</th><th style="width:44px;"></th></tr></thead><tbody>';

    if (!roots.length) {
        html += '<tr><td colspan="4"><div class="acct-empty">Nothing matches &ldquo;' + wmsEsc(acctLedSearch) + '&rdquo;.</div></td></tr>';
    }

    roots.forEach(function (r) {
        var open = isOpen(r.key);
        html += '<tr class="acct-tb-group acct-led-grp" data-node="' + r.key + '"><td colspan="3">' +
            '<span class="acct-led-toggle">' + (open ? '\u2296' : '\u2295') + '</span>' + wmsEsc(r.label) +
            '<span class="acct-led-count">' + r.count + '</span></td><td></td></tr>';
        if (!open) return;

        // ledgers hanging directly off the nature root
        r.ledgers.forEach(function (lg) { html += acctLedgerRowHtml(lg); });

        r.subs.forEach(function (sg) {
            var sopen = isOpen(sg.key);
            html += '<tr class="acct-subgroup-row acct-led-grp" data-node="' + sg.key + '">' +
                '<td style="padding-left:20px;font-weight:600;color:#475569;">' +
                '<span class="acct-led-toggle">' + (sopen ? '\u2296' : '\u2295') + '</span>' + wmsEsc(sg.label) +
                '<span class="acct-led-count">' + sg.ledgers.length + '</span></td>' +
                '<td colspan="2"></td>' +
                '<td class="text-right"><button class="acct-edit-btn" data-edit-group="' + sg.id + '" title="Edit group">\u270F\uFE0F</button></td></tr>';
            if (sopen) sg.ledgers.forEach(function (lg) { html += acctLedgerRowHtml(lg); });
        });
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
// Voucher modal
// ============================================================================
function acctLedgerOptionsHtml(selectedId) {
    var avail = acctAvailableLedgers(acctBookId);
    var byNature = {};
    avail.forEach(function (l) {
        var nature = acctRootName(l.group_id);
        (byNature[nature] = byNature[nature] || []).push(l);
    });
    var html = '<option value="">— select ledger —</option>';
    acctNatureOrder.forEach(function (nature) {
        if (!byNature[nature]) return;
        html += '<optgroup label="' + wmsEsc(nature) + '">';
        byNature[nature].forEach(function (l) {
            html += '<option value="' + l.id + '"' + (l.id === selectedId ? ' selected' : '') + '>' + wmsEsc(l.name) + '</option>';
        });
        html += '</optgroup>';
    });
    return html;
}

function acctRenderVoucherLines() {
    var tb = document.getElementById('acctVoucherLines');
    if (!tb) return;
    tb.innerHTML = acctVoucherLines.map(function (ln, idx) {
        return '<tr data-idx="' + idx + '">' +
            '<td><select class="wms-input acct-line-ledger" data-idx="' + idx + '">' + acctLedgerOptionsHtml(ln.ledgerId) + '</select></td>' +
            '<td class="text-right"><input type="text" class="wms-input acct-line-amt" data-idx="' + idx + '" data-field="debit" value="' + (ln.debit || '') + '" inputmode="decimal"></td>' +
            '<td class="text-right"><input type="text" class="wms-input acct-line-amt" data-idx="' + idx + '" data-field="credit" value="' + (ln.credit || '') + '" inputmode="decimal"></td>' +
            '<td><button class="acct-line-del" data-idx="' + idx + '" title="Remove line">✕</button></td></tr>';
    }).join('');
    acctUpdateBalance();
}

function acctUpdateBalance() {
    var td = 0, tc = 0, nonEmpty = 0, valid = true;
    acctVoucherLines.forEach(function (l) {
        var d = acctParse(l.debit), c = acctParse(l.credit);
        if (d > 0 && c > 0) valid = false;          // a line can't be both
        td += d; tc += c;
        if (d > 0 || c > 0) { nonEmpty++; if (!l.ledgerId) valid = false; }
    });
    var balanced = valid && nonEmpty >= 2 && Math.round(td * 100) === Math.round(tc * 100) && td > 0;
    var bar = document.getElementById('acctBalanceBar');
    var msg = document.getElementById('acctBalanceMsg');
    document.getElementById('acctTotalDebit').textContent = acctNum(td);
    document.getElementById('acctTotalCredit').textContent = acctNum(tc);
    if (bar) bar.className = 'acct-balance-bar ' + (balanced ? 'ok' : 'bad');
    if (msg) msg.textContent = balanced ? 'Balanced' : (Math.round(td * 100) === Math.round(tc * 100) ? 'Add at least two lines' : 'Not balanced');
    var save = document.getElementById('acctVoucherSave');
    if (save) save.disabled = !balanced;
}

function acctOpenVoucherModal() {
    if (!acctBookId) { acctToast('Select a book first (enable accounting on an investor).', true); return; }
    acctVoucherType = 'JOURNAL';
    acctVoucherDateYmd = acctTodayYmd();
    acctVoucherLines = [{ ledgerId: '', debit: '', credit: '' }, { ledgerId: '', debit: '', credit: '' }];

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
    // Auto-balance ledger picker (default Capital Account) — used mainly for opening balances
    var balSel = document.getElementById('acctBalanceLedger');
    if (balSel) {
        var avail = acctAvailableLedgers(acctBookId);
        var cap = avail.find(function (l) { return l.name === 'Capital Account'; });
        balSel.innerHTML = avail.map(function (l) { return '<option value="' + l.id + '"' + (cap && l.id === cap.id ? ' selected' : '') + '>' + wmsEsc(l.name) + '</option>'; }).join('');
    }
    if (acctVoucherModalCtrl) acctVoucherModalCtrl.open();
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
            running += (Number(r.debit_amount) || 0) - (Number(r.credit_amount) || 0);
            var balLabel = acctNum(Math.abs(running)) + (running >= 0 ? ' Dr' : ' Cr');
            html += '<tr><td>' + wmsEsc(acctFmtDate(r.voucher_date)) + '</td>' +
                '<td>' + wmsEsc(r.voucher_number) + '</td>' +
                '<td>' + wmsEsc(r.line_narration || '') + '</td>' +
                '<td class="text-right">' + (Number(r.debit_amount) ? acctAmt(Number(r.debit_amount)) : '-') + '</td>' +
                '<td class="text-right">' + (Number(r.credit_amount) ? acctAmt(Number(r.credit_amount)) : '-') + '</td>' +
                '<td class="text-right">' + balLabel + '</td></tr>';
        });
        html += '</tbody></table>';
    }
    body.innerHTML = html;
    if (acctLedgerModalCtrl) acctLedgerModalCtrl.open();
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
        acctToast('Ledger "' + name + '" ' + (acctEditingLedgerId ? 'updated' : 'added') + '.');
        await acctLoadCatalogue();
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
    document.getElementById('acctAddLineBtn').onclick = function () {
        acctVoucherLines.push({ ledgerId: '', debit: '', credit: '' });
        acctRenderVoucherLines();
    };
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
