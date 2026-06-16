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
var acctActiveTab = 'financials';
var acctGroupById = {};       // id -> group

// Voucher modal working state
var acctVoucherType = 'JOURNAL';
var acctVoucherDateYmd = null;
var acctVoucherLines = [];     // [{ ledgerId, debit, credit }]
var acctNewLedgerScope = 'global';

// Modal controllers (wmsModal instances; rebuilt each module load)
var acctVoucherModalCtrl = null;
var acctLedgerModalCtrl = null;
var acctAddLedgerModalCtrl = null;
var acctAddGroupModalCtrl = null;
var acctReportModalCtrl = null;

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
    if (!acctBookId) { acctVoucherRows = []; return; }
    acctVoucherRows = await wmsFetchAllRaw(acctUrl(
        'acct_voucher_full?investor_id=eq.' + acctBookId +
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
        acctLoading(true);
        try { await acctLoadBook(); acctRenderActiveTab(); }
        finally { acctLoading(false); }
    };

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
    if (acctActiveTab === 'financials') acctRenderFinancials();
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
// Group nonzero-balance ledgers by nature -> group, with nature-natural display sign.
function acctBuildStatementModel() {
    var net = acctComputeBalances();
    var model = {};
    acctNatureOrder.forEach(function (n) { model[n] = { groups: {}, total: 0 }; });
    Object.keys(net).forEach(function (id) {
        var bal = net[id];
        if (Math.round(bal * 100) === 0) return;
        var lg = acctLedgers.find(function (x) { return x.id === id; });
        if (!lg) return;
        var nature = acctRootName(lg.group_id);
        if (!model[nature]) return;
        var grp = acctGroupById[lg.group_id];
        var grpName = grp ? grp.name : nature;
        var crNormal = (nature === 'Liabilities' || nature === 'Income' || nature === 'Capital');
        var disp = crNormal ? -bal : bal;   // nature-natural positive value
        var g = model[nature].groups[grpName] || (model[nature].groups[grpName] = { ledgers: [], total: 0 });
        g.ledgers.push({ lg: lg, disp: disp });
        g.total += disp;
        model[nature].total += disp;
    });
    var incomeTotal = model.Income.total, expenseTotal = model.Expenses.total;
    return { model: model, incomeTotal: incomeTotal, expenseTotal: expenseTotal, netProfit: incomeTotal - expenseTotal };
}
function acctStmtNatureRows(label, nm) {
    var h = '<tr class="acct-stmt-nature"><td>' + wmsEsc(label) + '</td><td class="text-right">' + acctAmt(nm.total) + '</td></tr>';
    Object.keys(nm.groups).sort().forEach(function (gname) {
        var g = nm.groups[gname];
        h += '<tr class="acct-stmt-group"><td>' + wmsEsc(gname) + '</td><td class="text-right">' + acctAmt(g.total) + '</td></tr>';
        g.ledgers.sort(function (a, b) { return a.lg.name.localeCompare(b.lg.name); }).forEach(function (e) {
            h += '<tr class="acct-stmt-ledger acct-clickable" data-ledger="' + e.lg.id + '">' +
                '<td class="acct-ledger-name">' + wmsEsc(e.lg.name) + '</td>' +
                '<td class="text-right">' + acctAmt(e.disp) + '</td></tr>';
        });
    });
    return h;
}
function acctRenderFinancials() {
    var el = document.getElementById('acctFinancialsBody');
    if (!el) return;
    if (!acctBookId) { el.innerHTML = '<div class="acct-empty">No book selected. Enable accounting on an investor first.</div>'; return; }
    if (!acctVoucherRows.length) {
        el.innerHTML = '<div class="acct-empty">No postings yet for ' + wmsEsc(acctInvName(acctBookId)) + '. Use ↻ Rebuild from trades or ➕ New Voucher.</div>';
        return;
    }
    var m = acctBuildStatementModel();

    // Balance Sheet
    var bs = '<table class="acct-stmt"><tbody>';
    bs += '<tr class="acct-stmt-section"><td colspan="2">Liabilities &amp; Capital</td></tr>';
    bs += acctStmtNatureRows('Capital', m.model.Capital);
    bs += '<tr class="acct-stmt-ledger acct-clickable" id="acctBsNetProfit"><td class="acct-ledger-name">Current Year P&amp;L (see P&amp;L below)</td><td class="text-right">' + acctAmt(m.netProfit) + '</td></tr>';
    bs += acctStmtNatureRows('Liabilities', m.model.Liabilities);
    var lcTotal = m.model.Capital.total + m.netProfit + m.model.Liabilities.total;
    bs += '<tr class="acct-tb-total"><td>Total Liabilities &amp; Capital</td><td class="text-right">' + acctAmt(lcTotal) + '</td></tr>';
    bs += '<tr class="acct-stmt-section"><td colspan="2">Assets</td></tr>';
    bs += acctStmtNatureRows('Assets', m.model.Assets);
    bs += '<tr class="acct-tb-total"><td>Total Assets</td><td class="text-right">' + acctAmt(m.model.Assets.total) + '</td></tr>';
    bs += '</tbody></table>';

    // P&L
    var pl = '<table class="acct-stmt"><tbody>';
    pl += acctStmtNatureRows('Income', m.model.Income);
    pl += acctStmtNatureRows('Expenses', m.model.Expenses);
    pl += '<tr class="acct-tb-total"><td>Net Profit</td><td class="text-right">' + acctAmt(m.netProfit) + '</td></tr>';
    pl += '</tbody></table>';

    var balanced = Math.round(lcTotal * 100) === Math.round(m.model.Assets.total * 100);
    var balNote = balanced ? '' : '<div style="color:#dc2626;font-size:11px;text-align:center;margin-bottom:8px;">⚠ Balance Sheet does not balance — check postings.</div>';

    el.innerHTML = balNote +
        '<div class="acct-stmt-wrap"><div class="acct-stmt-title">Balance Sheet — ' + wmsEsc(acctInvName(acctBookId)) + '</div>' + bs + '</div>' +
        '<div class="acct-stmt-wrap" id="acctPLSection"><div class="acct-stmt-title">Profit &amp; Loss</div>' + pl + '</div>';

    el.querySelectorAll('tr[data-ledger]').forEach(function (tr) {
        tr.onclick = function () { acctOpenLedgerDetail(tr.dataset.ledger); };
    });
    var np = document.getElementById('acctBsNetProfit');
    if (np) np.onclick = function () { var s = document.getElementById('acctPLSection'); if (s) s.scrollIntoView({ behavior: 'smooth' }); };
}

function acctRenderTrialBalance() {
    var el = document.getElementById('acctTBBody');
    if (!el) return;
    if (!acctBookId) { el.innerHTML = '<div class="acct-empty">No book selected. Enable accounting on an investor first.</div>'; return; }

    // Net balance per ledger (debit - credit)
    var net = {};   // ledgerId -> net
    acctVoucherRows.forEach(function (r) {
        net[r.ledger_id] = (net[r.ledger_id] || 0) + (Number(r.debit_amount) || 0) - (Number(r.credit_amount) || 0);
    });
    var ledgerIds = Object.keys(net).filter(function (id) { return Math.round(net[id] * 100) !== 0; });
    if (!ledgerIds.length) {
        el.innerHTML = '<div class="acct-empty">No postings yet for ' + wmsEsc(acctInvName(acctBookId)) + '. Use ➕ New Voucher to begin.</div>';
        return;
    }

    // Build nature -> rows
    var byNature = {};
    ledgerIds.forEach(function (id) {
        var lg = acctLedgers.find(function (x) { return x.id === id; });
        if (!lg) return;
        var nature = acctRootName(lg.group_id);
        (byNature[nature] = byNature[nature] || []).push({ lg: lg, net: net[id] });
    });

    var totDr = 0, totCr = 0;
    var html = '<table class="acct-table"><thead><tr><th>Ledger</th><th class="text-right">Debit</th><th class="text-right">Credit</th></tr></thead><tbody>';
    var natures = Object.keys(byNature).sort(function (a, b) {
        return acctNatureOrder.indexOf(a) - acctNatureOrder.indexOf(b);
    });
    natures.forEach(function (nature) {
        html += '<tr class="acct-tb-group"><td colspan="3">' + wmsEsc(nature) + '</td></tr>';
        byNature[nature].sort(function (a, b) { return a.lg.name.localeCompare(b.lg.name); });
        byNature[nature].forEach(function (row) {
            var dr = row.net > 0 ? row.net : 0;
            var cr = row.net < 0 ? -row.net : 0;
            totDr += dr; totCr += cr;
            html += '<tr class="acct-tb-ledger acct-clickable" data-ledger="' + row.lg.id + '">' +
                '<td class="acct-ledger-name">' + wmsEsc(row.lg.name) + '</td>' +
                '<td class="text-right">' + (dr ? acctAmt(dr) : '-') + '</td>' +
                '<td class="text-right">' + (cr ? acctAmt(cr) : '-') + '</td></tr>';
        });
    });
    html += '<tr class="acct-tb-total"><td>Total</td>' +
        '<td class="text-right">' + acctAmt(totDr) + '</td>' +
        '<td class="text-right">' + acctAmt(totCr) + '</td></tr>';
    html += '</tbody></table>';
    el.innerHTML = html;

    el.querySelectorAll('tr[data-ledger]').forEach(function (tr) {
        tr.onclick = function () { acctOpenLedgerDetail(tr.dataset.ledger); };
    });
}

function acctRenderDayBook() {
    var el = document.getElementById('acctDayBookBody');
    if (!el) return;
    if (!acctBookId) { el.innerHTML = '<div class="acct-empty">No book selected.</div>'; return; }

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

function acctRenderLedgers() {
    var el = document.getElementById('acctLedgersBody');
    if (!el) return;
    if (!acctLedgers.length) { el.innerHTML = '<div class="acct-empty">No ledgers in the catalogue.</div>'; return; }

    var byNature = {};
    acctLedgers.forEach(function (lg) {
        var nature = acctRootName(lg.group_id);
        (byNature[nature] = byNature[nature] || []).push(lg);
    });
    var html = '<table class="acct-table"><thead><tr><th>Ledger</th><th>Group</th><th>Kind</th><th>Availability</th></tr></thead><tbody>';
    var natures = Object.keys(byNature).sort(function (a, b) { return acctNatureOrder.indexOf(a) - acctNatureOrder.indexOf(b); });
    natures.forEach(function (nature) {
        html += '<tr class="acct-tb-group"><td colspan="4">' + wmsEsc(nature) + '</td></tr>';
        byNature[nature].sort(function (a, b) { return a.name.localeCompare(b.name); });
        byNature[nature].forEach(function (lg) {
            var g = acctGroupById[lg.group_id];
            var avail = lg.is_global ? '<span class="acct-kind-badge">Global</span>'
                : '<span class="acct-scope-badge">' + wmsEsc(acctInvName(lg.scope_investor_id)) + ' only</span>';
            html += '<tr><td class="acct-ledger-name">' + wmsEsc(lg.name) + (lg.is_system ? ' <span class="acct-kind-badge">system</span>' : '') + '</td>' +
                '<td>' + wmsEsc(g ? g.name : '—') + '</td>' +
                '<td><span class="acct-kind-badge">' + wmsEsc(lg.ledger_kind) + '</span></td>' +
                '<td>' + avail + '</td></tr>';
        });
    });
    html += '</tbody></table>';
    el.innerHTML = html;
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
    if (acctVoucherModalCtrl) acctVoucherModalCtrl.open();
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
        '<div class="acct-ld-sub">' + wmsEsc(acctGroupPath(g)) + ' · ' + wmsEsc(acctInvName(acctBookId)) + '</div></div>';
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

function acctOpenAddLedger() {
    document.getElementById('acctNewLedgerName').value = '';
    document.getElementById('acctNewLedgerGroup').innerHTML = acctGroupSelectOptions(null);
    acctNewLedgerScope = 'global';
    document.querySelectorAll('#acctNewLedgerScopeToggle .acct-type-btn').forEach(function (b) {
        b.classList.toggle('active', b.dataset.scope === 'global');
    });
    document.getElementById('acctNewLedgerScopeBookWrap').style.display = 'none';
    var bookSel = document.getElementById('acctNewLedgerScopeBook');
    bookSel.innerHTML = acctOwnBooks().map(function (b) {
        return '<option value="' + b.id + '"' + (b.id === acctBookId ? ' selected' : '') + '>' + wmsEsc(b.short_name || b.name) + '</option>';
    }).join('');
    if (acctAddLedgerModalCtrl) acctAddLedgerModalCtrl.open();
}

async function acctSaveLedger() {
    var name = document.getElementById('acctNewLedgerName').value.trim();
    var groupId = document.getElementById('acctNewLedgerGroup').value;
    if (!name) { acctToast('Ledger name is required.', true); return; }
    if (!groupId) { acctToast('Pick a group.', true); return; }
    var isGlobal = acctNewLedgerScope === 'global';
    var body = {
        name: name, group_id: groupId, ledger_kind: 'GENERAL',
        is_global: isGlobal,
        scope_investor_id: isGlobal ? null : (document.getElementById('acctNewLedgerScopeBook').value || null)
    };
    try {
        var resp = await fetch(acctUrl('acct_ledgers'), {
            method: 'POST',
            headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
            body: JSON.stringify(body)
        });
        if (!resp.ok) throw new Error(await resp.text() || ('HTTP ' + resp.status));
        if (acctAddLedgerModalCtrl) acctAddLedgerModalCtrl.close();
        acctToast('Ledger "' + name + '" added.');
        await acctLoadCatalogue();
        acctRenderActiveTab();
    } catch (e) {
        console.error('[accounting] add ledger failed', e);
        acctToast('Could not add ledger: ' + e.message, true);
    }
}

function acctOpenAddGroup() {
    document.getElementById('acctNewGroupName').value = '';
    document.getElementById('acctNewGroupParent').innerHTML = acctGroupSelectOptions(null);
    if (acctAddGroupModalCtrl) acctAddGroupModalCtrl.open();
}

async function acctSaveGroup() {
    var name = document.getElementById('acctNewGroupName').value.trim();
    var parentId = document.getElementById('acctNewGroupParent').value;
    if (!name) { acctToast('Group name is required.', true); return; }
    if (!parentId) { acctToast('Pick a parent group.', true); return; }
    try {
        var resp = await fetch(acctUrl('acct_groups'), {
            method: 'POST',
            headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
            body: JSON.stringify({ name: name, parent_group_id: parentId })
        });
        if (!resp.ok) throw new Error(await resp.text() || ('HTTP ' + resp.status));
        if (acctAddGroupModalCtrl) acctAddGroupModalCtrl.close();
        acctToast('Group "' + name + '" added.');
        await acctLoadCatalogue();
        acctRenderActiveTab();
    } catch (e) {
        console.error('[accounting] add group failed', e);
        acctToast('Could not add group: ' + e.message, true);
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
