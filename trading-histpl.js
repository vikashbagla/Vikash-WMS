// ============================================================================
// trading-histpl.js — Historical P&L Transaction Entry
// Rule A.1.2: All module-level state uses var
// ============================================================================

// Module state
var hplSelectedInvestor = null;    // {id, name, short_name}
var hplSelectedTrader = null;      // optional {id, name, short_name}
var hplSelectedBroker = null;      // optional {id, name, broker_code}
var hplSelectedSecurity = null;    // {id, symbol, company_name, ...} from wmsRefData

var hplDdCtrlInvestor = null;
var hplDdCtrlTrader = null;
var hplDdCtrlBroker = null;
var hplDdCtrlSecurity = null;

// Date state (used by rhInitDateWidget('hpl'))
var hplDateState = { day: 1, month: 0, year: 2026 };
var hplDateActiveSeg = null;
var hplDateTypeBuf = '';

// ============================================================================
// INIT — called once after HTML + script injected
// ============================================================================

function initHistPlModule() {
    // Helper: clone element to strip old listeners
    function freshClone(id) {
        var el = document.getElementById(id);
        if (!el) return null;
        var clone = el.cloneNode(true);
        el.parentNode.replaceChild(clone, el);
        return clone;
    }

    // Close / Cancel / Save buttons
    var closeBtn = freshClone('hplCloseBtn');
    var cancelBtn = freshClone('hplCancelBtn');
    var saveBtn = freshClone('hplSaveBtn');

    if (closeBtn) closeBtn.addEventListener('click', closeHistPlModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeHistPlModal);
    if (saveBtn) saveBtn.addEventListener('click', hplSaveTransaction);

    // Date widget
    freshClone('hplDateWrap');
    rhInitDateWidget('hpl');

    // ── Security search ──
    var secInput = document.getElementById('hplSecurityInput');
    var secDd = document.getElementById('hplSecurityDd');
    hplDdCtrlSecurity = wmsDropdown(secInput, secDd, {
        itemSelector: '.wms-dd-item', closeOnSelect: true, blurDelay: 200, escClearsInput: false,
        onSelect: function(itemEl) {
            var idx = parseInt(itemEl.dataset.idx);
            var results = secDd._hplResults || [];
            if (results[idx]) hplSelectSecurity(results[idx]);
        }
    });
    secInput.addEventListener('input', function() { hplSearchSecurity(); });
    secDd.addEventListener('mousedown', function(e) {
        var item = e.target.closest('.wms-dd-item');
        if (!item) return;
        e.preventDefault();
        var idx = parseInt(item.dataset.idx);
        var results = secDd._hplResults || [];
        if (results[idx]) hplSelectSecurity(results[idx]);
        hplDdCtrlSecurity.close();
    });

    // ── Investor search ──
    var invInput = document.getElementById('hplInvestorInput');
    var invDd = document.getElementById('hplInvestorDd');
    hplDdCtrlInvestor = wmsDropdown(invInput, invDd, {
        itemSelector: '.wms-dd-item', closeOnSelect: true, blurDelay: 200, escClearsInput: false,
        onSelect: function(itemEl) {
            var idx = parseInt(itemEl.dataset.idx);
            var results = invDd._hplResults || [];
            if (results[idx]) hplSelectInvestor(results[idx]);
        }
    });
    invInput.addEventListener('input', function() { hplSearchInvestor(); });
    invDd.addEventListener('mousedown', function(e) {
        var item = e.target.closest('.wms-dd-item');
        if (!item) return;
        e.preventDefault();
        var idx = parseInt(item.dataset.idx);
        var results = invDd._hplResults || [];
        if (results[idx]) hplSelectInvestor(results[idx]);
        hplDdCtrlInvestor.close();
    });

    // ── Trader search ──
    var trdInput = document.getElementById('hplTraderInput');
    var trdDd = document.getElementById('hplTraderDd');
    hplDdCtrlTrader = wmsDropdown(trdInput, trdDd, {
        itemSelector: '.wms-dd-item', closeOnSelect: true, blurDelay: 200, escClearsInput: false,
        onSelect: function(itemEl) {
            var idx = parseInt(itemEl.dataset.idx);
            var results = trdDd._hplResults || [];
            if (results[idx]) hplSelectTrader(results[idx]);
        }
    });
    trdInput.addEventListener('input', function() { hplSearchTrader(); });
    trdDd.addEventListener('mousedown', function(e) {
        var item = e.target.closest('.wms-dd-item');
        if (!item) return;
        e.preventDefault();
        var idx = parseInt(item.dataset.idx);
        var results = trdDd._hplResults || [];
        if (results[idx]) hplSelectTrader(results[idx]);
        hplDdCtrlTrader.close();
    });

    // ── Broker search ──
    var brkInput = document.getElementById('hplBrokerInput');
    var brkDd = document.getElementById('hplBrokerDd');
    hplDdCtrlBroker = wmsDropdown(brkInput, brkDd, {
        itemSelector: '.wms-dd-item', closeOnSelect: true, blurDelay: 200, escClearsInput: false,
        onSelect: function(itemEl) {
            var idx = parseInt(itemEl.dataset.idx);
            var results = brkDd._hplResults || [];
            if (results[idx]) hplSelectBroker(results[idx]);
        }
    });
    brkInput.addEventListener('input', function() { hplSearchBroker(); });
    brkDd.addEventListener('mousedown', function(e) {
        var item = e.target.closest('.wms-dd-item');
        if (!item) return;
        e.preventDefault();
        var idx = parseInt(item.dataset.idx);
        var results = brkDd._hplResults || [];
        if (results[idx]) hplSelectBroker(results[idx]);
        hplDdCtrlBroker.close();
    });

    // ── Amount input: focus/blur formatting ──
    var amtInput = document.getElementById('hplAmountInput');
    amtInput.addEventListener('focus', function() {
        var raw = amtInput.dataset.rawValue || '';
        amtInput.value = (raw && parseFloat(raw) !== 0) ? raw : '';
    });
    amtInput.addEventListener('blur', function() {
        var v = parseFloat(amtInput.value.replace(/,/g, '')) || 0;
        amtInput.dataset.rawValue = v ? v.toString() : '';
        amtInput.value = v ? wmsFmtAmt(v) : '';
        hplCheckSaveEnabled();
    });

    // ESC handler
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            if (document.getElementById('hplOverlay').classList.contains('show')) {
                closeHistPlModal();
            }
        }
    });
}

// ============================================================================
// OPEN / CLOSE
// ============================================================================

function openHistPlModal() {
    hplSelectedInvestor = null;
    hplSelectedTrader = null;
    hplSelectedBroker = null;
    hplSelectedSecurity = null;

    document.getElementById('hplSecurityInput').value = '';
    document.getElementById('hplSecurityBadge').innerHTML = '';
    document.getElementById('hplSecurityDd').innerHTML = '';
    document.getElementById('hplInvestorInput').value = '';
    document.getElementById('hplInvestorBadge').innerHTML = '';
    document.getElementById('hplInvestorDd').innerHTML = '';
    document.getElementById('hplTraderInput').value = '';
    document.getElementById('hplTraderBadge').innerHTML = '';
    document.getElementById('hplTraderDd').innerHTML = '';
    document.getElementById('hplBrokerInput').value = '';
    document.getElementById('hplBrokerBadge').innerHTML = '';
    document.getElementById('hplBrokerDd').innerHTML = '';
    document.getElementById('hplAmountInput').value = '';
    document.getElementById('hplAmountInput').dataset.rawValue = '';
    document.getElementById('hplSaveBtn').disabled = true;

    if (hplDdCtrlSecurity) hplDdCtrlSecurity.close();
    if (hplDdCtrlInvestor) hplDdCtrlInvestor.close();
    if (hplDdCtrlTrader) hplDdCtrlTrader.close();
    if (hplDdCtrlBroker) hplDdCtrlBroker.close();

    rhDateSetFromDate('hpl', new Date());

    document.getElementById('hplOverlay').classList.add('show');
    setTimeout(function() { document.getElementById('hplInvestorInput').focus(); }, 100);
}

function closeHistPlModal() {
    document.getElementById('hplOverlay').classList.remove('show');
}

// ============================================================================
// SEARCH HELPERS
// ============================================================================

function hplSearchInvestor() {
    var input = document.getElementById('hplInvestorInput');
    var dd = document.getElementById('hplInvestorDd');
    var q = input.value.trim().toLowerCase();
    if (q.length < 1) { hplDdCtrlInvestor.close(); return; }

    var investors = wmsRefData.investors || [];
    var results = investors.filter(function(inv) {
        var name = (inv.name || '').toLowerCase();
        var sname = (inv.short_name || '').toLowerCase();
        return name.indexOf(q) >= 0 || sname.indexOf(q) >= 0;
    });

    dd._hplResults = results;
    dd.innerHTML = '';
    if (results.length === 0) {
        dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No investors found</div>';
        hplDdCtrlInvestor.show();
        return;
    }
    results.forEach(function(inv, idx) {
        var div = document.createElement('div');
        div.className = 'wms-dd-item';
        div.dataset.idx = idx;
        div.innerHTML = '<strong>' + (inv.short_name || inv.name) + '</strong>' +
            (inv.short_name && inv.name !== inv.short_name ? ' — ' + inv.name : '');
        dd.appendChild(div);
    });
    hplDdCtrlInvestor.show();
    hplDdCtrlInvestor.resetIdx();
}

function hplSelectInvestor(inv) {
    hplSelectedInvestor = inv;
    document.getElementById('hplInvestorInput').value = '';
    document.getElementById('hplInvestorBadge').innerHTML =
        '<span class="hpl-badge" onclick="hplClearInvestor()">' +
        (inv.short_name || inv.name) + '<span class="hpl-badge-x">&times;</span></span>';
    hplDdCtrlInvestor.close();
    hplCheckSaveEnabled();
}

function hplClearInvestor() {
    hplSelectedInvestor = null;
    document.getElementById('hplInvestorBadge').innerHTML = '';
    document.getElementById('hplInvestorInput').value = '';
    hplCheckSaveEnabled();
}

function hplSearchTrader() {
    var input = document.getElementById('hplTraderInput');
    var dd = document.getElementById('hplTraderDd');
    var q = input.value.trim().toLowerCase();
    if (q.length < 1) { hplDdCtrlTrader.close(); return; }

    var investors = wmsRefData.investors || [];
    var results = investors.filter(function(inv) {
        var name = (inv.name || '').toLowerCase();
        var sname = (inv.short_name || '').toLowerCase();
        return name.indexOf(q) >= 0 || sname.indexOf(q) >= 0;
    });

    dd._hplResults = results;
    dd.innerHTML = '';
    if (results.length === 0) {
        dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No investors found</div>';
        hplDdCtrlTrader.show();
        return;
    }
    results.forEach(function(inv, idx) {
        var div = document.createElement('div');
        div.className = 'wms-dd-item';
        div.dataset.idx = idx;
        div.innerHTML = '<strong>' + (inv.short_name || inv.name) + '</strong>' +
            (inv.short_name && inv.name !== inv.short_name ? ' — ' + inv.name : '');
        dd.appendChild(div);
    });
    hplDdCtrlTrader.show();
    hplDdCtrlTrader.resetIdx();
}

function hplSelectTrader(inv) {
    hplSelectedTrader = inv;
    document.getElementById('hplTraderInput').value = '';
    document.getElementById('hplTraderBadge').innerHTML =
        '<span class="hpl-badge" onclick="hplClearTrader()">' +
        (inv.short_name || inv.name) + '<span class="hpl-badge-x">&times;</span></span>';
    hplDdCtrlTrader.close();
}

function hplClearTrader() {
    hplSelectedTrader = null;
    document.getElementById('hplTraderBadge').innerHTML = '';
    document.getElementById('hplTraderInput').value = '';
}

function hplSearchBroker() {
    var input = document.getElementById('hplBrokerInput');
    var dd = document.getElementById('hplBrokerDd');
    var q = input.value.trim().toLowerCase();
    if (q.length < 1) { hplDdCtrlBroker.close(); return; }

    var brokers = wmsRefData.brokers || [];
    var results = brokers.filter(function(brk) {
        var name = (brk.name || '').toLowerCase();
        var code = (brk.broker_code || '').toLowerCase();
        return name.indexOf(q) >= 0 || code.indexOf(q) >= 0;
    });

    dd._hplResults = results;
    dd.innerHTML = '';
    if (results.length === 0) {
        dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No brokers found</div>';
        hplDdCtrlBroker.show();
        return;
    }
    results.forEach(function(brk, idx) {
        var div = document.createElement('div');
        div.className = 'wms-dd-item';
        div.dataset.idx = idx;
        div.innerHTML = '<strong>' + (brk.broker_code || brk.name) + '</strong>' +
            (brk.broker_code && brk.name !== brk.broker_code ? ' — ' + brk.name : '');
        dd.appendChild(div);
    });
    hplDdCtrlBroker.show();
    hplDdCtrlBroker.resetIdx();
}

function hplSelectBroker(brk) {
    hplSelectedBroker = brk;
    document.getElementById('hplBrokerInput').value = '';
    document.getElementById('hplBrokerBadge').innerHTML =
        '<span class="hpl-badge" onclick="hplClearBroker()">' +
        (brk.broker_code || brk.name) + '<span class="hpl-badge-x">&times;</span></span>';
    hplDdCtrlBroker.close();
}

function hplClearBroker() {
    hplSelectedBroker = null;
    document.getElementById('hplBrokerBadge').innerHTML = '';
    document.getElementById('hplBrokerInput').value = '';
}

function hplSearchSecurity() {
    var input = document.getElementById('hplSecurityInput');
    var dd = document.getElementById('hplSecurityDd');
    var q = input.value.trim();
    if (q.length < 1) { hplDdCtrlSecurity.close(); dd._hplResults = []; return; }

    var results = wmsSearchSecurities(q);
    // CM securities only — filter out NFO (same as income)
    results = results.filter(function(s) { return s.isin; });

    dd._hplResults = results;
    dd.innerHTML = '';
    if (results.length === 0) {
        dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No securities found</div>';
        hplDdCtrlSecurity.show();
        return;
    }
    results.forEach(function(sec, idx) {
        var div = document.createElement('div');
        div.className = 'wms-dd-item';
        div.dataset.idx = idx;
        div.innerHTML = '<strong>' + (sec.nse_symbol || sec.symbol) + '</strong> — ' + sec.company_name;
        dd.appendChild(div);
    });
    hplDdCtrlSecurity.show();
    hplDdCtrlSecurity.resetIdx();
}

function hplSelectSecurity(sec) {
    hplSelectedSecurity = sec;
    var shortSym = sec.nse_symbol || sec.symbol;
    document.getElementById('hplSecurityInput').value = '';
    document.getElementById('hplSecurityBadge').innerHTML =
        '<span class="hpl-badge" onclick="hplClearSecurity()">' +
        shortSym + ' — ' + sec.company_name + '<span class="hpl-badge-x">&times;</span></span>';
    hplDdCtrlSecurity.close();
    hplCheckSaveEnabled();
}

function hplClearSecurity() {
    hplSelectedSecurity = null;
    document.getElementById('hplSecurityBadge').innerHTML = '';
    document.getElementById('hplSecurityInput').value = '';
    hplCheckSaveEnabled();
}

// ============================================================================
// VALIDATION + SAVE
// ============================================================================

function hplCheckSaveEnabled() {
    var amtRaw = document.getElementById('hplAmountInput').dataset.rawValue || '';
    var amt = parseFloat(amtRaw) || 0;
    var ok = hplSelectedInvestor && hplSelectedSecurity && amt !== 0;
    document.getElementById('hplSaveBtn').disabled = !ok;
}

async function hplSaveTransaction() {
    var dateStr = rhDateGetIsoStr('hpl');
    if (!hplSelectedInvestor) { showAlert('Select an investor.', 'error', 3000); return; }
    if (!hplSelectedSecurity) { showAlert('Select a security.', 'error', 3000); return; }

    var amtRaw = document.getElementById('hplAmountInput').dataset.rawValue || '';
    var amount = parseFloat(amtRaw) || 0;
    if (amount === 0) { showAlert('Enter a non-zero amount.', 'error', 3000); return; }

    var sec = hplSelectedSecurity;
    var shortSym = sec.nse_symbol || sec.bse_symbol || sec.symbol;

    var txn = {
        investor_id: hplSelectedInvestor.id,
        trader_id: hplSelectedTrader ? hplSelectedTrader.id : null,
        broker_id: hplSelectedBroker ? hplSelectedBroker.id : null,
        security_id: sec.id,
        security_type: sec.security_type || 'EQUITY',
        symbol: shortSym,
        short_symbol: shortSym,
        company_name: sec.company_name || shortSym,
        exchange: sec.exchange || 'NSE',
        product: null,
        transaction_type: 'HISTORICAL_PL',
        transaction_date: dateStr,
        quantity: 1,
        lots: 0,
        price: Math.round(amount * 100) / 100,
        gross_amount: Math.round(amount * 100) / 100,
        brokerage: 0,
        stt: 0,
        other_charges: 0,
        gst: 0,
        tds: 0,
        total_charges: 0,
        trader_charges: 0,
        net_amount: Math.round(amount * 100) / 100,
        margin_blocked: 0,
        broker_contract_note_no: null,
        broker_trade_id: null,
        tags: ['blank'],
        notes: '[Historical P&L: ' + (amount >= 0 ? 'Profit' : 'Loss') + ' ' + wmsFmtAmt(amount) + ' for ' + shortSym + ']',
        is_locked: false,
        ignore_for_avg_cost: false,
        dont_display: false
    };

    try {
        document.getElementById('hplSaveBtn').disabled = true;
        await wmsBatchCreateTransactions([txn]);
        closeHistPlModal();
        if (typeof trRefresh === 'function') await trRefresh();
        showAlert('Historical P&L: ' + (amount >= 0 ? 'Profit' : 'Loss') + ' ' + wmsFmtAmt(amount) + ' saved for ' + shortSym + '.', 'success', 4000);
    } catch (e) {
        wmsShowError('Historical P&L save failed', e);
        document.getElementById('hplSaveBtn').disabled = false;
    }
}

// ============================================================================
// GLOBAL EXPORTS (for onclick handlers in HTML)
// ============================================================================

window.openHistPlModal = openHistPlModal;
window.closeHistPlModal = closeHistPlModal;
window.hplClearInvestor = hplClearInvestor;
window.hplClearTrader = hplClearTrader;
window.hplClearBroker = hplClearBroker;
window.hplClearSecurity = hplClearSecurity;
