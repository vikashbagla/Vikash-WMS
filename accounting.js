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
var acctActiveTab = 'trial-balance';
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
    if (acctActiveTab === 'trial-balance') acctRenderTrialBalance();
    else if (acctActiveTab === 'day-book') acctRenderDayBook();
    else if (acctActiveTab === 'ledgers') acctRenderLedgers();
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
}

// Expose entry point for app.html loadModule
window.initAccounting = initAccounting;
