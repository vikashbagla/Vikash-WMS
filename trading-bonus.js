// ============================================================================
// trading-bonus.js — Bonus Issue Corporate Action
// Rule A.1.2: All module-level state uses var
// ============================================================================

// Module state
var bonusSelectedSecurity = null;   // {id, symbol, company_name, ...} from wmsRefData
var bonusHoldings = [];             // [{investor_id, trader_id, broker_id, netQuantity, ...}]
var bonusDdCtrl = null;             // wmsDropdown controller for symbol search
var bonusDateState = { day: 1, month: 0, year: 2026 };
var bonusDateActiveSeg = null;
var bonusDateTypeBuf = '';

// ============================================================================
// INIT — called once; uses clone trick to guarantee no duplicate listeners
// ============================================================================

function initBonusModule() {
    window._bonusModuleInitDone = false;

    function freshClone(id) {
        var el = document.getElementById(id);
        if (!el) return null;
        var clone = el.cloneNode(true);
        el.parentNode.replaceChild(clone, el);
        return clone;
    }

    var closeBtn  = freshClone('bonusCloseBtn');
    var cancelBtn = freshClone('bonusCancelBtn');
    var saveBtn   = freshClone('bonusSaveBtn');
    var applyBtn  = freshClone('bonusApplyRatioBtn');
    var overlay   = document.getElementById('bonusOverlay');

    closeBtn.addEventListener('click', closeBonusModal);
    cancelBtn.addEventListener('click', closeBonusModal);
    saveBtn.addEventListener('click', bonusSaveTransactions);
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) closeBonusModal();
    });

    // Apply ratio button
    applyBtn.addEventListener('click', bonusApplyRatio);

    // Date widget — reuses the shared rhInitDateWidget (trading-rights.js must be loaded,
    // or we provide a standalone version)
    freshClone('bonusDateWrap');
    bonusInitDateWidget();

    // Symbol search with wmsDropdown
    var symInput = document.getElementById('bonusSymbolInput');
    var symDd = document.getElementById('bonusSymbolDd');
    bonusDdCtrl = wmsDropdown(symInput, symDd, {
        itemSelector: '.wms-dd-item',
        closeOnSelect: true,
        blurDelay: 200,
        escClearsInput: false,
        onSelect: function(itemEl) {
            var idx = parseInt(itemEl.dataset.idx);
            var results = symDd._bonusResults || [];
            if (results[idx]) bonusSelectSymbol(results[idx]);
        }
    });
    symInput.addEventListener('input', function() {
        bonusSearchSymbol(symInput, symDd);
    });

    // ESC handler
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            if (document.getElementById('bonusOverlay').classList.contains('show')) {
                closeBonusModal();
            }
        }
    });

    window._bonusModuleInitDone = true;
}

// ============================================================================
// DATE WIDGET — standalone version (same as rhInitDateWidget but for 'bonus' prefix)
// ============================================================================

var BONUS_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function bonusInitDateWidget() {
    var prefix = 'bonus';
    var wrap = document.getElementById(prefix + 'DateWrap');
    var calBtn = document.getElementById(prefix + 'DateCalBtn');
    var calPicker = document.getElementById(prefix + 'DateCalPicker');
    var segs = wrap.querySelectorAll('.rhDate-seg');

    segs.forEach(function(seg) {
        seg.addEventListener('mousedown', function(e) {
            e.preventDefault();
            bonusDateSetActive(seg.dataset.seg);
            wrap.focus();
        });
    });

    calBtn.addEventListener('click', function(e) {
        e.preventDefault();
        calPicker.showPicker ? calPicker.showPicker() : calPicker.click();
    });
    calPicker.addEventListener('change', function() {
        if (!calPicker.value) return;
        var d = new Date(calPicker.value + 'T00:00:00');
        bonusDateSetFromDate(d);
        bonusDateOnChange();
    });

    wrap.addEventListener('keydown', function(e) {
        if (!bonusDateActiveSeg) bonusDateSetActive('dd');

        if (e.key === 'ArrowLeft') {
            e.preventDefault(); bonusDateMoveSeg(-1);
        } else if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) {
            if (bonusDateActiveSeg !== 'yyyy') { e.preventDefault(); bonusDateMoveSeg(1); }
            else bonusDateClearActive();
        } else if (e.key === 'Tab' && e.shiftKey) {
            if (bonusDateActiveSeg !== 'dd') { e.preventDefault(); bonusDateMoveSeg(-1); }
            else bonusDateClearActive();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault(); bonusDateAdjust(1);
        } else if (e.key === 'ArrowDown') {
            e.preventDefault(); bonusDateAdjust(-1);
        } else if (/^[0-9]$/.test(e.key)) {
            e.preventDefault(); bonusDateTypeDigit(e.key);
        } else if (/^[a-zA-Z]$/.test(e.key)) {
            e.preventDefault(); bonusDateTypeLetter(e.key);
        }
    });
}

function bonusDateSetActive(seg) {
    bonusDateActiveSeg = seg; bonusDateTypeBuf = '';
    var wrap = document.getElementById('bonusDateWrap');
    wrap.querySelectorAll('.rhDate-seg').forEach(function(el) {
        el.classList.toggle('active', el.dataset.seg === seg);
    });
}

function bonusDateClearActive() {
    bonusDateActiveSeg = null;
    var wrap = document.getElementById('bonusDateWrap');
    wrap.querySelectorAll('.rhDate-seg').forEach(function(el) { el.classList.remove('active'); });
}

function bonusDateMoveSeg(dir) {
    var order = ['dd', 'mmm', 'yyyy'];
    var idx = order.indexOf(bonusDateActiveSeg);
    var next = idx + dir;
    if (next >= 0 && next < order.length) bonusDateSetActive(order[next]);
}

function bonusDateAdjust(delta) {
    var st = bonusDateState;
    if (bonusDateActiveSeg === 'dd') {
        st.day += delta;
        var maxDay = new Date(st.year, st.month + 1, 0).getDate();
        if (st.day > maxDay) st.day = 1;
        if (st.day < 1) st.day = maxDay;
    } else if (bonusDateActiveSeg === 'mmm') {
        st.month += delta;
        if (st.month > 11) st.month = 0;
        if (st.month < 0) st.month = 11;
        var maxD = new Date(st.year, st.month + 1, 0).getDate();
        if (st.day > maxD) st.day = maxD;
    } else if (bonusDateActiveSeg === 'yyyy') {
        st.year += delta;
    }
    bonusDateRender();
    bonusDateOnChange();
}

function bonusDateTypeDigit(ch) {
    bonusDateTypeBuf += ch;
    var st = bonusDateState;
    if (bonusDateActiveSeg === 'dd') {
        var d = parseInt(bonusDateTypeBuf);
        if (bonusDateTypeBuf.length >= 2 || d > 3) {
            st.day = Math.min(Math.max(d, 1), new Date(st.year, st.month + 1, 0).getDate());
            bonusDateRender(); bonusDateMoveSeg(1); bonusDateOnChange();
        }
    } else if (bonusDateActiveSeg === 'yyyy') {
        if (bonusDateTypeBuf.length >= 4) {
            st.year = parseInt(bonusDateTypeBuf) || st.year;
            bonusDateRender(); bonusDateOnChange();
            bonusDateTypeBuf = '';
        }
    }
}

function bonusDateTypeLetter(ch) {
    if (bonusDateActiveSeg !== 'mmm') return;
    bonusDateTypeBuf += ch.toLowerCase();
    var st = bonusDateState;
    for (var i = 0; i < 12; i++) {
        if (BONUS_MONTHS[i].toLowerCase().indexOf(bonusDateTypeBuf) === 0) {
            st.month = i;
            var maxD = new Date(st.year, st.month + 1, 0).getDate();
            if (st.day > maxD) st.day = maxD;
            bonusDateRender();
            if (bonusDateTypeBuf.length >= 3) { bonusDateMoveSeg(1); bonusDateOnChange(); }
            return;
        }
    }
    bonusDateTypeBuf = '';
}

function bonusDateRender() {
    var st = bonusDateState;
    document.getElementById('bonusDateDd').textContent = st.day < 10 ? '0' + st.day : '' + st.day;
    document.getElementById('bonusDateMmm').textContent = BONUS_MONTHS[st.month];
    document.getElementById('bonusDateYyyy').textContent = '' + st.year;
}

function bonusDateSetFromDate(d) {
    bonusDateState.day = d.getDate();
    bonusDateState.month = d.getMonth();
    bonusDateState.year = d.getFullYear();
    bonusDateRender();
}

function bonusDateGetIsoStr() {
    var st = bonusDateState;
    var m = st.month + 1;
    return st.year + '-' + (m < 10 ? '0' + m : '' + m) + '-' + (st.day < 10 ? '0' + st.day : '' + st.day);
}

function bonusDateOnChange() {
    if (bonusSelectedSecurity) bonusPopulateHoldings();
}

// ============================================================================
// SYMBOL SEARCH
// ============================================================================

function bonusSearchSymbol(input, dd) {
    var query = input.value.trim();
    if (query.length < 1) { if (bonusDdCtrl) bonusDdCtrl.close(); return; }
    if (!wmsRefData.securitiesCmReady) return;

    var results = wmsRefData.securitiesCm.filter(function(s) {
        // Exclude non-equity types (no bonus on NFO, RIGHTS, etc.)
        if (s.security_type === 'RIGHTS' || s.security_type === 'NFO') return false;
        var text = ((s.nse_symbol || '') + ' ' + (s.company_name || '') + ' ' + (s.bse_symbol || '')).toLowerCase();
        return text.indexOf(query.toLowerCase()) >= 0;
    }).slice(0, 15);

    dd._bonusResults = results;

    if (results.length === 0) {
        dd.innerHTML = '<div class="wms-dd-item" style="color:#a0aec0;cursor:default;">No matches</div>';
    } else {
        dd.innerHTML = results.map(function(r, i) {
            return '<div class="wms-dd-item" data-idx="' + i + '">' +
                '<strong>' + (r.nse_symbol || r.bse_symbol || r.symbol) + '</strong>' +
                '<span style="color:#718096;margin-left:6px;font-size:10px;">' + (r.company_name || '') + '</span>' +
                '</div>';
        }).join('');
    }
    bonusDdCtrl.open();
}

// ============================================================================
// OPEN / CLOSE
// ============================================================================

function openBonusModal() {
    bonusSelectedSecurity = null;
    bonusHoldings = [];
    bonusDateSetFromDate(new Date());
    document.getElementById('bonusSymbolInput').value = '';
    document.getElementById('bonusSymbolBadge').innerHTML = '';
    document.getElementById('bonusRatioRow').style.display = 'none';
    document.getElementById('bonusRatioNew').value = '1';
    document.getElementById('bonusRatioExisting').value = '1';
    document.getElementById('bonusTableWrap').innerHTML = '<div class="rights-empty">Select a date and symbol to view holdings</div>';
    document.getElementById('bonusSaveBtn').disabled = true;
    document.getElementById('bonusOverlay').classList.add('show');
    setTimeout(function() { document.getElementById('bonusSymbolInput').focus(); }, 100);
}

function closeBonusModal() {
    document.getElementById('bonusOverlay').classList.remove('show');
}

// ============================================================================
// SYMBOL SELECTION + POPULATE HOLDINGS
// ============================================================================

function bonusSelectSymbol(security) {
    bonusSelectedSecurity = security;
    var shortSym = security.nse_symbol || security.symbol;
    document.getElementById('bonusSymbolInput').value = '';
    document.getElementById('bonusSymbolBadge').innerHTML =
        '<span class="rights-selected-badge">' + shortSym + ' — ' + security.company_name + '</span>';
    document.getElementById('bonusRatioRow').style.display = 'flex';
    bonusPopulateHoldings();
}

function bonusPopulateHoldings() {
    var dateStr = bonusDateGetIsoStr();
    if (!bonusSelectedSecurity) {
        document.getElementById('bonusTableWrap').innerHTML = '<div class="rights-empty">Select a date and symbol to view holdings</div>';
        document.getElementById('bonusSaveBtn').disabled = true;
        return;
    }

    var shortSym = bonusSelectedSecurity.nse_symbol || bonusSelectedSecurity.symbol;
    var holdings = wmsCalcHoldingsAsOfDate(shortSym, dateStr, trTransactions);
    bonusHoldings = holdings;

    if (holdings.length === 0) {
        document.getElementById('bonusTableWrap').innerHTML =
            '<div class="rights-empty">No holdings found for ' + shortSym + ' as of ' + dateStr + '</div>';
        document.getElementById('bonusSaveBtn').disabled = true;
        return;
    }

    var html = '<table class="rights-table"><thead><tr>' +
        '<th style="width:35%">Inv &gt; Trd &gt; Brk</th>' +
        '<th class="r" style="width:20%">Cur Qty</th>' +
        '<th class="r" style="width:25%">Bonus Qty</th>' +
        '</tr></thead><tbody>';
    holdings.forEach(function(h, idx) {
        html += '<tr>' +
            '<td title="' + h.combinedLabel + '">' + h.combinedLabel + '</td>' +
            '<td class="r">' + h.netQuantity.toLocaleString() + '</td>' +
            '<td class="r"><input type="number" min="0" step="1" data-idx="' + idx + '" class="bonus-qty-input"></td>' +
            '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('bonusTableWrap').innerHTML = html;
    document.getElementById('bonusSaveBtn').disabled = false;
}

// ============================================================================
// APPLY RATIO — auto-fills bonus qty for all holdings based on ratio
// ============================================================================

function bonusApplyRatio() {
    var ratioNew = parseInt(document.getElementById('bonusRatioNew').value) || 0;
    var ratioExisting = parseInt(document.getElementById('bonusRatioExisting').value) || 0;

    if (ratioNew <= 0 || ratioExisting <= 0) {
        showAlert('Please enter valid bonus ratio (both values must be > 0).', 'error', 3000);
        return;
    }

    var inputs = document.querySelectorAll('.bonus-qty-input');
    inputs.forEach(function(inp) {
        var idx = parseInt(inp.dataset.idx);
        if (bonusHoldings[idx]) {
            var bonusQty = Math.floor(bonusHoldings[idx].netQuantity * ratioNew / ratioExisting);
            inp.value = bonusQty;
        }
    });
}

// ============================================================================
// SAVE — create BONUS transactions
// ============================================================================

async function bonusSaveTransactions() {
    // Collect bonus quantities from inputs
    var inputs = document.querySelectorAll('.bonus-qty-input');
    var hasAny = false;
    inputs.forEach(function(inp) {
        var idx = parseInt(inp.dataset.idx);
        var qty = parseInt(inp.value) || 0;
        if (bonusHoldings[idx]) {
            bonusHoldings[idx].bonusQty = qty;
            if (qty > 0) hasAny = true;
        }
    });

    if (!hasAny) {
        showAlert('Please enter at least one bonus quantity (or use Apply to calculate from ratio).', 'error', 3000);
        return;
    }

    var saveBtn = document.getElementById('bonusSaveBtn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
        var sec = bonusSelectedSecurity;
        var shortSym = sec.nse_symbol || sec.bse_symbol || sec.symbol;
        var dateStr = bonusDateGetIsoStr();
        var ratioNew = parseInt(document.getElementById('bonusRatioNew').value) || 0;
        var ratioExisting = parseInt(document.getElementById('bonusRatioExisting').value) || 0;
        var ratioStr = (ratioNew > 0 && ratioExisting > 0) ? ratioNew + ':' + ratioExisting : '';

        var txns = [];
        bonusHoldings.forEach(function(h) {
            if (!h.bonusQty || h.bonusQty <= 0) return;
            txns.push({
                investor_id: h.investor_id,
                trader_id: h.trader_id || null,
                broker_id: h.broker_id,
                security_id: sec.id,
                security_type: sec.security_type || 'EQUITY',
                symbol: shortSym,
                short_symbol: shortSym,
                company_name: sec.company_name,
                exchange: sec.nse_symbol ? 'NSE' : 'BSE',
                product: null,
                transaction_type: 'BONUS',
                transaction_date: dateStr,
                quantity: h.bonusQty,
                lots: 0,
                price: 0,
                gross_amount: 0,
                brokerage: 0,
                stt: 0,
                other_charges: 0,
                gst: 0,
                tds: 0,
                total_charges: 0,
                trader_charges: 0,
                net_amount: 0,
                margin_blocked: 0,
                broker_contract_note_no: null,
                broker_trade_id: null,
                tags: ['blank'],
                notes: '[Bonus' + (ratioStr ? ' ' + ratioStr : '') + ' for ' + shortSym + ' on ' + dateStr + ']',
                is_locked: false,
                ignore_for_avg_cost: false,
                dont_display: false
            });
        });

        if (txns.length > 0) {
            await wmsBatchCreateTransactions(txns);
        }

        closeBonusModal();
        if (typeof trRefresh === 'function') await trRefresh();
        showAlert('Bonus transactions created: ' + txns.length + ' entries.', 'success', 4000);

    } catch (err) {
        console.error('Bonus save error:', err);
        showAlert('Error saving bonus transactions: ' + err.message, 'error', 5000);
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Bonus Transactions';
    }
}

// Export for module loader
window.openBonusModal = openBonusModal;
window.initBonusModule = initBonusModule;
