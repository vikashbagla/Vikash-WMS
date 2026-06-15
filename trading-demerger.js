// ============================================================================
// trading-demerger.js — Demerger Corporate Action  (LESSONS §K.1)
// Rule A.1.2: all module-level state uses var.
//
// Model: per holding (investor|trader|broker), per OPEN buy-lot (FIFO after
// sells), using each lot's ACTUAL original cost:
//   • Parent: cost scaled down by Σ(allocation %), qty + original date kept.
//   • Each resulting company: a lot, same qty as the parent lot, cost =
//     (its %) × that lot's original cost, dated to the lot's ORIGINAL buy date
//     (holding period carries over).
// Recorded as dedicated DEMERGER transactions (no cash impact). The cost engine
// (_wmsCostEngine / wmsCalcAvgCost) understands the type — see wms-shared.js.
// ============================================================================

var demergerSelectedParent = null;     // parent security {id, symbol, company_name, ...}
var demergerCompanies = [];            // [{ security|null, pct(number 0-100) }]
var demergerDdCtrl = null;             // parent symbol dropdown controller
var demergerSlices = [];               // computed open-lot slices (cache for save)
var demergerDateState = { day: 1, month: 0, year: 2026 };
var demergerLastSavedDate = null;
var demergerDateActiveSeg = null;
var demergerDateTypeBuf = '';
var DEMERGER_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ============================================================================
// INIT
// ============================================================================
function initDemergerModule() {
    window._demergerModuleInitDone = false;

    function freshClone(id) {
        var el = document.getElementById(id);
        if (!el) return null;
        var clone = el.cloneNode(true);
        el.parentNode.replaceChild(clone, el);
        return clone;
    }

    var closeBtn  = freshClone('demergerCloseBtn');
    var cancelBtn = freshClone('demergerCancelBtn');
    var saveBtn   = freshClone('demergerSaveBtn');
    var addCoBtn  = freshClone('demergerAddCoBtn');
    var overlay   = document.getElementById('demergerOverlay');

    closeBtn.addEventListener('click', closeDemergerModal);
    cancelBtn.addEventListener('click', closeDemergerModal);
    saveBtn.addEventListener('click', demergerSave);
    addCoBtn.addEventListener('click', function() { demergerAddCompany(); });
    overlay.addEventListener('click', function(e) { if (e.target === overlay) closeDemergerModal(); });

    freshClone('demergerDateWrap');
    demergerInitDateWidget();

    var symInput = document.getElementById('demergerSymbolInput');
    var symDd = document.getElementById('demergerSymbolDd');
    demergerDdCtrl = wmsDropdown(symInput, symDd, {
        itemSelector: '.wms-dd-item', closeOnSelect: true, blurDelay: 200, escClearsInput: false,
        onSelect: function(itemEl) {
            var idx = parseInt(itemEl.dataset.idx);
            var results = symDd._demergerResults || [];
            if (results[idx]) demergerSelectParent(results[idx]);
        }
    });
    symInput.addEventListener('input', function() { demergerSearchParent(symInput, symDd); });
    symDd.addEventListener('mousedown', function(e) {
        var item = e.target.closest('.wms-dd-item');
        if (!item) return;
        e.preventDefault();
        var idx = parseInt(item.dataset.idx);
        var results = symDd._demergerResults || [];
        if (results[idx]) demergerSelectParent(results[idx]);
        demergerDdCtrl.close();
    });

    // Delegated handlers for the dynamic resulting-company rows.
    var coWrap = document.getElementById('demergerCompaniesWrap');
    coWrap.addEventListener('input', function(e) {
        var row = e.target.closest('.dmg-co-row');
        if (!row) return;
        var idx = parseInt(row.dataset.idx);
        if (e.target.classList.contains('dmg-pct-input')) {
            demergerCompanies[idx].pct = parseFloat(e.target.value) || 0;
            demergerRenderPreview();
        } else if (e.target.classList.contains('dmg-co-input')) {
            demergerSearchCompany(idx, e.target);
        }
    });
    coWrap.addEventListener('mousedown', function(e) {
        var item = e.target.closest('.wms-dd-item');
        if (!item) return;
        e.preventDefault();
        var row = e.target.closest('.dmg-co-row');
        var idx = parseInt(row.dataset.idx);
        var resIdx = parseInt(item.dataset.idx);
        var results = item.closest('.rights-search-dd')._results || [];
        if (results[resIdx]) demergerSelectCompany(idx, results[resIdx]);
    });
    coWrap.addEventListener('click', function(e) {
        var rm = e.target.closest('.dmg-co-remove');
        if (!rm) return;
        var idx = parseInt(rm.closest('.dmg-co-row').dataset.idx);
        demergerCompanies.splice(idx, 1);
        demergerRenderCompanies();
        demergerRenderPreview();
    });

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && document.getElementById('demergerOverlay').classList.contains('show')) {
            closeDemergerModal();
        }
    });

    window._demergerModuleInitDone = true;
}

// ============================================================================
// DATE WIDGET (standalone, 'demerger' prefix — same behaviour as bonus)
// ============================================================================
function demergerInitDateWidget() {
    var wrap = document.getElementById('demergerDateWrap');
    var calBtn = document.getElementById('demergerDateCalBtn');
    var calPicker = document.getElementById('demergerDateCalPicker');
    wrap.querySelectorAll('.rhDate-seg').forEach(function(seg) {
        seg.addEventListener('mousedown', function(e) { e.preventDefault(); demergerDateSetActive(seg.dataset.seg); wrap.focus(); });
    });
    calBtn.addEventListener('click', function(e) { e.preventDefault(); calPicker.showPicker ? calPicker.showPicker() : calPicker.click(); });
    calPicker.addEventListener('change', function() {
        if (!calPicker.value) return;
        demergerDateSetFromDate(new Date(calPicker.value + 'T00:00:00'));
        demergerRenderPreview();
    });
    wrap.addEventListener('keydown', function(e) {
        if (!demergerDateActiveSeg) demergerDateSetActive('dd');
        if (e.key === 'ArrowLeft') { e.preventDefault(); demergerDateMoveSeg(-1); }
        else if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) {
            if (demergerDateActiveSeg !== 'yyyy') { e.preventDefault(); demergerDateMoveSeg(1); } else demergerDateClearActive();
        } else if (e.key === 'Tab' && e.shiftKey) {
            if (demergerDateActiveSeg !== 'dd') { e.preventDefault(); demergerDateMoveSeg(-1); } else demergerDateClearActive();
        } else if (e.key === 'ArrowUp') { e.preventDefault(); demergerDateAdjust(1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); demergerDateAdjust(-1); }
        else if (/^[0-9]$/.test(e.key)) { e.preventDefault(); demergerDateTypeDigit(e.key); }
        else if (/^[a-zA-Z]$/.test(e.key)) { e.preventDefault(); demergerDateTypeLetter(e.key); }
    });
}
function demergerDateSetActive(seg) {
    demergerDateActiveSeg = seg; demergerDateTypeBuf = '';
    document.getElementById('demergerDateWrap').querySelectorAll('.rhDate-seg').forEach(function(el) {
        el.classList.toggle('active', el.dataset.seg === seg);
    });
}
function demergerDateClearActive() {
    demergerDateActiveSeg = null;
    document.getElementById('demergerDateWrap').querySelectorAll('.rhDate-seg').forEach(function(el) { el.classList.remove('active'); });
}
function demergerDateMoveSeg(dir) {
    var order = ['dd','mmm','yyyy']; var idx = order.indexOf(demergerDateActiveSeg); var n = idx + dir;
    if (n >= 0 && n < order.length) demergerDateSetActive(order[n]);
}
function demergerDateAdjust(delta) {
    var st = demergerDateState;
    if (demergerDateActiveSeg === 'dd') {
        st.day += delta; var maxDay = new Date(st.year, st.month + 1, 0).getDate();
        if (st.day > maxDay) st.day = 1; if (st.day < 1) st.day = maxDay;
    } else if (demergerDateActiveSeg === 'mmm') {
        st.month += delta; if (st.month > 11) st.month = 0; if (st.month < 0) st.month = 11;
        var maxD = new Date(st.year, st.month + 1, 0).getDate(); if (st.day > maxD) st.day = maxD;
    } else if (demergerDateActiveSeg === 'yyyy') { st.year += delta; }
    demergerDateRender(); demergerRenderPreview();
}
function demergerDateTypeDigit(ch) {
    demergerDateTypeBuf += ch; var st = demergerDateState;
    if (demergerDateActiveSeg === 'dd') {
        var d = parseInt(demergerDateTypeBuf);
        if (demergerDateTypeBuf.length >= 2 || d > 3) {
            st.day = Math.min(Math.max(d, 1), new Date(st.year, st.month + 1, 0).getDate());
            demergerDateRender(); demergerDateMoveSeg(1); demergerRenderPreview();
        }
    } else if (demergerDateActiveSeg === 'yyyy') {
        if (demergerDateTypeBuf.length >= 4) { st.year = parseInt(demergerDateTypeBuf) || st.year; demergerDateRender(); demergerRenderPreview(); demergerDateTypeBuf = ''; }
    }
}
function demergerDateTypeLetter(ch) {
    if (demergerDateActiveSeg !== 'mmm') return;
    demergerDateTypeBuf += ch.toLowerCase(); var st = demergerDateState;
    for (var i = 0; i < 12; i++) {
        if (DEMERGER_MONTHS[i].toLowerCase().indexOf(demergerDateTypeBuf) === 0) {
            st.month = i; var maxD = new Date(st.year, st.month + 1, 0).getDate(); if (st.day > maxD) st.day = maxD;
            demergerDateRender();
            if (demergerDateTypeBuf.length >= 3) { demergerDateMoveSeg(1); demergerRenderPreview(); }
            return;
        }
    }
    demergerDateTypeBuf = '';
}
function demergerDateRender() {
    var st = demergerDateState;
    document.getElementById('demergerDateDd').textContent = st.day < 10 ? '0' + st.day : '' + st.day;
    document.getElementById('demergerDateMmm').textContent = DEMERGER_MONTHS[st.month];
    document.getElementById('demergerDateYyyy').textContent = '' + st.year;
}
function demergerDateSetFromDate(d) {
    demergerDateState.day = d.getDate(); demergerDateState.month = d.getMonth(); demergerDateState.year = d.getFullYear();
    demergerDateRender();
}
function demergerDateGetIsoStr() {
    var st = demergerDateState; var m = st.month + 1;
    return st.year + '-' + (m < 10 ? '0' + m : '' + m) + '-' + (st.day < 10 ? '0' + st.day : '' + st.day);
}

// ============================================================================
// OPEN / CLOSE
// ============================================================================
function openDemergerModal() {
    demergerSelectedParent = null;
    demergerCompanies = [{ security: null, pct: 0 }];
    demergerSlices = [];
    demergerDateSetFromDate(demergerLastSavedDate || new Date());
    document.getElementById('demergerSymbolInput').value = '';
    document.getElementById('demergerSymbolBadge').innerHTML = '';
    document.getElementById('demergerAllocWrap').style.display = 'none';
    document.getElementById('demergerTableWrap').innerHTML = '<div class="rights-empty">Select a date and parent company to view holdings</div>';
    document.getElementById('demergerSaveBtn').disabled = true;
    document.getElementById('demergerOverlay').classList.add('show');
    setTimeout(function() { document.getElementById('demergerSymbolInput').focus(); }, 100);
}
function closeDemergerModal() { document.getElementById('demergerOverlay').classList.remove('show'); }

// ============================================================================
// PARENT SEARCH
// ============================================================================
function demergerSearchParent(input, dd) {
    var q = input.value.trim();
    if (q.length < 1) { demergerDdCtrl.close(); dd._demergerResults = []; return; }
    var results = wmsSearchSecurities(q).filter(function(s) {
        return s.security_type !== 'RIGHTS' && s.security_type !== 'NFO';
    });
    dd._demergerResults = results;
    dd.innerHTML = '';
    if (results.length === 0) { dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No securities found</div>'; demergerDdCtrl.show(); return; }
    results.forEach(function(sec, idx) {
        var div = document.createElement('div');
        div.className = 'wms-dd-item'; div.dataset.idx = idx;
        div.innerHTML = '<strong>' + (sec.nse_symbol || sec.symbol) + '</strong> — ' + sec.company_name;
        dd.appendChild(div);
    });
    demergerDdCtrl.show(); demergerDdCtrl.resetIdx();
}
function demergerSelectParent(security) {
    demergerSelectedParent = security;
    var shortSym = security.nse_symbol || security.symbol;
    document.getElementById('demergerSymbolInput').value = '';
    document.getElementById('demergerSymbolBadge').innerHTML =
        '<span class="rights-selected-badge">' + shortSym + ' — ' + security.company_name + '</span>';
    document.getElementById('demergerAllocWrap').style.display = '';
    if (demergerCompanies.length === 0) demergerCompanies = [{ security: null, pct: 0 }];
    demergerRenderCompanies();
    demergerRenderPreview();
}

// ============================================================================
// RESULTING COMPANIES (dynamic rows)
// ============================================================================
function demergerAddCompany() {
    demergerCompanies.push({ security: null, pct: 0 });
    demergerRenderCompanies();
}
function demergerRenderCompanies() {
    var wrap = document.getElementById('demergerCompaniesWrap');
    var html = '';
    demergerCompanies.forEach(function(c, idx) {
        var badge = c.security
            ? '<span class="rights-selected-badge" style="margin-top:0;">' + (c.security.nse_symbol || c.security.symbol) + ' — ' + c.security.company_name + '</span>'
            : '<input type="text" class="dmg-co-input" placeholder="Search resulting company..." autocomplete="off">';
        html += '<div class="dmg-co-row" data-idx="' + idx + '">' +
            '<div class="dmg-co-search">' + badge + '<div class="rights-search-dd"></div></div>' +
            '<input type="number" class="dmg-pct-input" min="0" max="100" step="0.01" placeholder="%" value="' + (c.pct || '') + '">' +
            '<span style="font-size:11px;color:#718096;">%</span>' +
            '<button type="button" class="dmg-co-remove" title="Remove">&#10005;</button>' +
            '</div>';
    });
    wrap.innerHTML = html;
}
function demergerSearchCompany(idx, input) {
    var dd = input.closest('.dmg-co-search').querySelector('.rights-search-dd');
    var q = input.value.trim();
    if (q.length < 1) { dd.classList.remove('show'); dd._results = []; return; }
    var results = wmsSearchSecurities(q).filter(function(s) {
        return s.security_type !== 'RIGHTS' && s.security_type !== 'NFO';
    });
    dd._results = results;
    dd.innerHTML = '';
    if (results.length === 0) { dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No securities found</div>'; dd.classList.add('show'); return; }
    results.slice(0, 30).forEach(function(sec, ri) {
        var div = document.createElement('div');
        div.className = 'wms-dd-item'; div.dataset.idx = ri;
        div.innerHTML = '<strong>' + (sec.nse_symbol || sec.symbol) + '</strong> — ' + sec.company_name;
        dd.appendChild(div);
    });
    dd.classList.add('show');
}
function demergerSelectCompany(idx, security) {
    demergerCompanies[idx].security = security;
    demergerRenderCompanies();
    demergerRenderPreview();
}

// ============================================================================
// COMPUTE OPEN-LOT SLICES (FIFO open lots per investor|trader|broker)
// ============================================================================
function demergerComputeSlices() {
    var parent = demergerSelectedParent;
    if (!parent) return [];
    var shortSym = parent.nse_symbol || parent.symbol;
    var dateStr = demergerDateGetIsoStr();
    var txns = (typeof trTransactions !== 'undefined' ? trTransactions : []).filter(function(t) {
        var sym = (t.short_symbol || t.symbol || '');
        return !t.dont_display && sym === shortSym && t.transaction_date <= dateStr;
    });
    // FIFO engine processes in input order — sort by date (then time, then id)
    // per E.16 so open-lot matching is correct regardless of trTransactions order.
    txns = txns.slice().sort(function(a, b) {
        var da = a.transaction_date || '', db = b.transaction_date || '';
        if (da !== db) return da < db ? -1 : 1;
        var ta = a.transaction_time || '', tb = b.transaction_time || '';
        if (ta !== tb) return ta < tb ? -1 : 1;
        return (a.id || 0) > (b.id || 0) ? 1 : -1;
    });
    var groups = {};
    txns.forEach(function(t) {
        var key = (t.investor_id || '') + '|' + (t.trader_id || t.investor_id || '') + '|' + (t.broker_id || '');
        (groups[key] = groups[key] || { investor_id: t.investor_id, trader_id: t.trader_id, broker_id: t.broker_id, txns: [] }).txns.push(t);
    });
    var invMap = wmsRefData.investorObjMap || {}, brkMap = wmsRefData.brokerObjMap || {};
    var slices = [];
    Object.keys(groups).forEach(function(key) {
        var g = groups[key];
        var res = wmsCalcFifoCost(g.txns);
        var hk = Object.keys(res.holdings || {})[0];
        if (!hk) return;
        var openLots = (res.holdings[hk].lots || []).filter(function(l) { return l.qty > 0; });
        if (openLots.length === 0) return;
        var inv = invMap[g.investor_id], trd = g.trader_id ? invMap[g.trader_id] : null, brk = brkMap[g.broker_id];
        var invL = inv ? (inv.short_name || inv.name) : '—', trdL = trd ? (trd.short_name || trd.name) : '', brkL = brk ? (brk.broker_code || brk.name) : '—';
        var combined = invL; if (trdL && trdL !== invL) combined += ' > ' + trdL; if (brkL) combined += ' > ' + brkL;
        var lots = openLots.map(function(l) { return { date: l.date, qty: l.qty, costPerUnit: l.costPerUnit, cost: wmsRoundMoney(l.qty * l.costPerUnit) }; });
        var totalQty = 0, totalCost = 0;
        lots.forEach(function(l) { totalQty += l.qty; totalCost += l.cost; });
        slices.push({ key: key, investor_id: g.investor_id, trader_id: g.trader_id, broker_id: g.broker_id,
            combinedLabel: combined, lots: lots, totalQty: totalQty, totalCost: wmsRoundMoney(totalCost) });
    });
    return slices;
}

// ============================================================================
// PREVIEW (live — shows original + new values even though user only enters %)
// ============================================================================
function demergerSumPct() {
    return demergerCompanies.reduce(function(s, c) { return s + (parseFloat(c.pct) || 0); }, 0);
}
function demergerFmt(v) { return (typeof wmsFmtAmt === 'function') ? wmsFmtAmt(v) : (Math.round(v)).toLocaleString('en-IN'); }

function demergerRenderPreview() {
    if (!demergerSelectedParent) return;
    var sumPct = demergerSumPct();
    var retain = 100 - sumPct;
    var named = demergerCompanies.filter(function(c) { return c.security; });

    // Allocation summary line
    var sumEl = document.getElementById('demergerAllocSummary');
    var bad = sumPct <= 0 || sumPct > 100;
    sumEl.innerHTML = 'Allocated to resulting companies: <b>' + sumPct.toFixed(2) + '%</b> &middot; ' +
        'Parent retains: <b>' + retain.toFixed(2) + '%</b>' +
        (bad ? ' <span class="dmg-alloc-bad">(must be &gt;0 and &le;100)</span>' : '');

    demergerSlices = demergerComputeSlices();
    var wrap = document.getElementById('demergerTableWrap');
    var saveBtn = document.getElementById('demergerSaveBtn');

    if (demergerSlices.length === 0) {
        wrap.innerHTML = '<div class="rights-empty">No open holdings for ' +
            (demergerSelectedParent.nse_symbol || demergerSelectedParent.symbol) + ' as of ' + demergerDateGetIsoStr() + '</div>';
        saveBtn.disabled = true;
        return;
    }

    var coCols = named.map(function(c) {
        return { label: (c.security.nse_symbol || c.security.symbol), pct: (parseFloat(c.pct) || 0) / 100 };
    });

    var html = '<table class="dmg-table"><thead><tr>' +
        '<th class="l">Holding / Lot</th><th>Qty</th><th>Orig Cost</th>' +
        '<th>Parent (' + retain.toFixed(1) + '%)</th>';
    coCols.forEach(function(col) {
        html += '<th class="dmg-newco">' + wmsEsc(col.label) + ' (' + (col.pct * 100).toFixed(1) + '%)</th>';
    });
    html += '</tr></thead><tbody>';

    var fParent = retain / 100;
    var grand = { qty: 0, cost: 0, parent: 0, co: coCols.map(function() { return 0; }) };

    demergerSlices.forEach(function(s) {
        var sParentCost = wmsRoundMoney(s.totalCost * fParent);
        html += '<tr class="dmg-slice-row"><td class="l">' + wmsEsc(s.combinedLabel) + '</td>' +
            '<td>' + formatQuantity(s.totalQty) + '</td><td>' + demergerFmt(s.totalCost) + '</td>' +
            '<td>' + demergerFmt(sParentCost) + '</td>';
        coCols.forEach(function(col, ci) {
            var cc = wmsRoundMoney(s.totalCost * col.pct);
            grand.co[ci] += cc;
            html += '<td class="dmg-newco">' + demergerFmt(cc) + '</td>';
        });
        html += '</tr>';
        grand.qty += s.totalQty; grand.cost += s.totalCost; grand.parent += sParentCost;
        // per-lot rows
        s.lots.forEach(function(l) {
            html += '<tr class="dmg-lot-row"><td class="l">&bull; ' + lgFmtOrDate(l.date) + '</td>' +
                '<td>' + formatQuantity(l.qty) + '</td><td>' + demergerFmt(l.cost) + '</td>' +
                '<td>' + demergerFmt(wmsRoundMoney(l.cost * fParent)) + '</td>';
            coCols.forEach(function(col) {
                html += '<td class="dmg-newco">' + demergerFmt(wmsRoundMoney(l.cost * col.pct)) + '</td>';
            });
            html += '</tr>';
        });
    });

    html += '</tbody><tfoot><tr><td class="l">Total</td><td>' + formatQuantity(grand.qty) + '</td>' +
        '<td>' + demergerFmt(grand.cost) + '</td><td>' + demergerFmt(grand.parent) + '</td>';
    coCols.forEach(function(col, ci) { html += '<td class="dmg-newco">' + demergerFmt(grand.co[ci]) + '</td>'; });
    html += '</tr></tfoot></table>';

    // amounts unit hint
    var unit = (typeof getUnitDescription === 'function') ? getUnitDescription() : '';
    if (unit) html += '<div style="font-size:10px;color:#a0aec0;margin-top:4px;">All cost values in ' + unit + '. Quantity unchanged — each resulting company carries the same shares as the parent.</div>';

    wrap.innerHTML = html;

    // Enable save only when allocation valid + every company chosen + has %
    var allChosen = demergerCompanies.length > 0 && demergerCompanies.every(function(c) { return c.security && (parseFloat(c.pct) || 0) > 0; });
    saveBtn.disabled = !(allChosen && sumPct > 0 && sumPct <= 100);
}

function lgFmtOrDate(d) {
    // dd-mmm-yy from an ISO date string
    if (!d) return '';
    var parts = String(d).split('-');
    if (parts.length < 3) return d;
    var mon = DEMERGER_MONTHS[parseInt(parts[1], 10) - 1] || parts[1];
    return parts[2] + '-' + mon + '-' + parts[0].slice(2);
}

// ============================================================================
// SAVE — create dedicated DEMERGER transactions
// ============================================================================
async function demergerSave() {
    var sumPct = demergerSumPct();
    if (!(sumPct > 0 && sumPct <= 100)) { showAlert('Total allocation must be > 0 and ≤ 100%.', 'error', 3500); return; }
    var named = demergerCompanies.filter(function(c) { return c.security && (parseFloat(c.pct) || 0) > 0; });
    if (named.length === 0) { showAlert('Add at least one resulting company with a %.', 'error', 3500); return; }

    var saveBtn = document.getElementById('demergerSaveBtn');
    saveBtn.disabled = true; saveBtn.textContent = 'Saving...';

    try {
        var parent = demergerSelectedParent;
        var parentSym = parent.nse_symbol || parent.bse_symbol || parent.symbol;
        var parentExch = parent.nse_symbol ? 'NSE' : 'BSE';
        var dateStr = demergerDateGetIsoStr();
        var fracAwayTotal = sumPct / 100;                 // Σ allocation fraction
        var coList = named.map(function(c) { return (c.security.nse_symbol || c.security.symbol); }).join(', ');

        var slices = demergerComputeSlices();
        var txns = [];

        slices.forEach(function(s) {
            // --- Parent leg: one DEMERGER, qty 0, price = fraction away, net_amount = cost removed
            var removedCost = wmsRoundMoney(s.totalCost * fracAwayTotal);
            txns.push(_dmgTxn({
                investor_id: s.investor_id, trader_id: s.trader_id, broker_id: s.broker_id,
                sec: parent, symbol: parentSym, exchange: parentExch,
                quantity: 0, price: fracAwayTotal, net_amount: removedCost, date: dateStr,
                notes: '[Demerger of ' + parentSym + ' on ' + dateStr + ': ' + sumPct.toFixed(2) + '% of cost allocated to ' + coList + ']'
            }));

            // --- Resulting company legs: per open lot, per company (original date + cost)
            s.lots.forEach(function(l) {
                named.forEach(function(c) {
                    var f = (parseFloat(c.pct) || 0) / 100;
                    var allocCost = wmsRoundMoney(l.cost * f);
                    if (allocCost <= 0 || l.qty <= 0) return;
                    var cSym = c.security.nse_symbol || c.security.bse_symbol || c.security.symbol;
                    var cExch = c.security.nse_symbol ? 'NSE' : 'BSE';
                    txns.push(_dmgTxn({
                        investor_id: s.investor_id, trader_id: s.trader_id, broker_id: s.broker_id,
                        sec: c.security, symbol: cSym, exchange: cExch,
                        quantity: l.qty, price: wmsRoundMoney(allocCost / l.qty), net_amount: allocCost,
                        date: l.date,   // ORIGINAL lot date → holding period carries over
                        notes: '[Demerger from ' + parentSym + ' on ' + dateStr + ': ' + (f * 100).toFixed(2) + '% of original cost; parent lot ' + l.date + ']'
                    }));
                });
            });
        });

        if (txns.length === 0) { showAlert('Nothing to record — no open holdings.', 'warning', 3500); return; }
        await wmsBatchCreateTransactions(txns);

        demergerLastSavedDate = new Date(demergerDateState.year, demergerDateState.month, demergerDateState.day);
        closeDemergerModal();
        if (typeof trRefresh === 'function') await trRefresh();
        showAlert('Demerger recorded: ' + txns.length + ' entries across ' + slices.length + ' holding(s).', 'success', 4500);
    } catch (err) {
        console.error('Demerger save error:', err);
        showAlert('Error saving demerger: ' + err.message, 'error', 5000);
    } finally {
        saveBtn.disabled = false; saveBtn.textContent = 'Save Demerger';
    }
}

// Build a DEMERGER transaction record (no cash/charges — pure cost shift).
function _dmgTxn(o) {
    return {
        investor_id: o.investor_id,
        trader_id: o.trader_id || o.investor_id || null,
        broker_id: o.broker_id,
        security_id: o.sec.id,
        security_type: o.sec.security_type || 'EQUITY',
        symbol: o.symbol,
        short_symbol: o.symbol,
        company_name: o.sec.company_name,
        exchange: o.exchange,
        product: null,
        transaction_type: 'DEMERGER',
        transaction_date: o.date,
        quantity: o.quantity,
        lots: 0,
        price: o.price,
        gross_amount: 0,
        brokerage: 0, stt: 0, other_charges: 0, gst: 0, tds: 0,
        total_charges: 0, trader_charges: 0,
        net_amount: o.net_amount,
        margin_blocked: 0,
        broker_contract_note_no: null, broker_trade_id: null,
        tags: ['blank'],
        notes: o.notes,
        is_locked: false, ignore_for_avg_cost: false, dont_display: false
    };
}

// Export for module loader
window.openDemergerModal = openDemergerModal;
window.initDemergerModule = initDemergerModule;
