// ============================================================================
// trading-split.js — Stock Split Corporate Action
// Rule A.1.2: All module-level state uses var
// Cloned from trading-bonus.js — key difference: ratio calculates additional
// shares as holdings × (splitTo - 1) instead of holdings × (new / existing).
// Transaction type = 'SPLIT' (treated same as BONUS in avg-cost engine).
// ============================================================================

// Module state
var splitSelectedSecurity = null;   // {id, symbol, company_name, ...} from wmsRefData
var splitHoldings = [];             // [{investor_id, trader_id, broker_id, netQuantity, ...}]
var splitDdCtrl = null;             // wmsDropdown controller for symbol search
var splitTags = [];                 // current tag list for this form
var splitTagCtrl = null;            // wmsTagInput controller
var splitDateState = { day: 1, month: 0, year: 2026 };
// Persist last saved date across modal open/close (null = first open, use today)
var splitLastSavedDate = null;
var splitDateActiveSeg = null;
var splitDateTypeBuf = '';

// ============================================================================
// INIT — called once; uses clone trick to guarantee no duplicate listeners
// ============================================================================

function initSplitModule() {
    window._splitModuleInitDone = false;

    function freshClone(id) {
        var el = document.getElementById(id);
        if (!el) return null;
        var clone = el.cloneNode(true);
        el.parentNode.replaceChild(clone, el);
        return clone;
    }

    var closeBtn  = freshClone('splitCloseBtn');
    var cancelBtn = freshClone('splitCancelBtn');
    var saveBtn   = freshClone('splitSaveBtn');
    var applyBtn  = freshClone('splitApplyRatioBtn');
    var overlay   = document.getElementById('splitOverlay');

    closeBtn.addEventListener('click', closeSplitModal);
    cancelBtn.addEventListener('click', closeSplitModal);
    saveBtn.addEventListener('click', splitSaveTransactions);
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) closeSplitModal();
    });

    // Apply ratio button
    applyBtn.addEventListener('click', splitApplyRatio);

    // Date widget
    freshClone('splitDateWrap');
    splitInitDateWidget();

    // Symbol search with wmsDropdown
    var symInput = document.getElementById('splitSymbolInput');
    var symDd = document.getElementById('splitSymbolDd');
    splitDdCtrl = wmsDropdown(symInput, symDd, {
        itemSelector: '.wms-dd-item',
        closeOnSelect: true,
        blurDelay: 200,
        escClearsInput: false,
        onSelect: function(itemEl) {
            var idx = parseInt(itemEl.dataset.idx);
            var results = symDd._splitResults || [];
            if (results[idx]) splitSelectSymbol(results[idx]);
        }
    });
    symInput.addEventListener('input', function() {
        splitSearchSymbol(symInput, symDd);
    });
    // Mouse click support on symbol dropdown
    symDd.addEventListener('mousedown', function(e) {
        var item = e.target.closest('.wms-dd-item');
        if (!item) return;
        e.preventDefault();
        var idx = parseInt(item.dataset.idx);
        var results = symDd._splitResults || [];
        if (results[idx]) splitSelectSymbol(results[idx]);
        splitDdCtrl.close();
    });

    // ESC handler
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            if (document.getElementById('splitOverlay').classList.contains('show')) {
                closeSplitModal();
            }
        }
    });

    window._splitModuleInitDone = true;
}

// ============================================================================
// DATE WIDGET — standalone version (same pattern as bonus)
// ============================================================================

var SPLIT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function splitInitDateWidget() {
    var prefix = 'split';
    var wrap = document.getElementById(prefix + 'DateWrap');
    var calBtn = document.getElementById(prefix + 'DateCalBtn');
    var calPicker = document.getElementById(prefix + 'DateCalPicker');
    var segs = wrap.querySelectorAll('.rhDate-seg');

    segs.forEach(function(seg) {
        seg.addEventListener('mousedown', function(e) {
            e.preventDefault();
            splitDateSetActive(seg.dataset.seg);
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
        splitDateSetFromDate(d);
        splitDateOnChange();
    });

    wrap.addEventListener('keydown', function(e) {
        if (!splitDateActiveSeg) splitDateSetActive('dd');

        if (e.key === 'ArrowLeft') {
            e.preventDefault(); splitDateMoveSeg(-1);
        } else if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) {
            if (splitDateActiveSeg !== 'yyyy') { e.preventDefault(); splitDateMoveSeg(1); }
            else splitDateClearActive();
        } else if (e.key === 'Tab' && e.shiftKey) {
            if (splitDateActiveSeg !== 'dd') { e.preventDefault(); splitDateMoveSeg(-1); }
            else splitDateClearActive();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault(); splitDateAdjust(1);
        } else if (e.key === 'ArrowDown') {
            e.preventDefault(); splitDateAdjust(-1);
        } else if (/^[0-9]$/.test(e.key)) {
            e.preventDefault(); splitDateTypeDigit(e.key);
        } else if (/^[a-zA-Z]$/.test(e.key)) {
            e.preventDefault(); splitDateTypeLetter(e.key);
        }
    });
}

function splitDateSetActive(seg) {
    splitDateActiveSeg = seg; splitDateTypeBuf = '';
    var wrap = document.getElementById('splitDateWrap');
    wrap.querySelectorAll('.rhDate-seg').forEach(function(el) {
        el.classList.toggle('active', el.dataset.seg === seg);
    });
}

function splitDateClearActive() {
    splitDateActiveSeg = null;
    var wrap = document.getElementById('splitDateWrap');
    wrap.querySelectorAll('.rhDate-seg').forEach(function(el) { el.classList.remove('active'); });
}

function splitDateMoveSeg(dir) {
    var order = ['dd', 'mmm', 'yyyy'];
    var idx = order.indexOf(splitDateActiveSeg);
    var next = idx + dir;
    if (next >= 0 && next < order.length) splitDateSetActive(order[next]);
}

function splitDateAdjust(delta) {
    var st = splitDateState;
    if (splitDateActiveSeg === 'dd') {
        st.day += delta;
        var maxDay = new Date(st.year, st.month + 1, 0).getDate();
        if (st.day > maxDay) st.day = 1;
        if (st.day < 1) st.day = maxDay;
    } else if (splitDateActiveSeg === 'mmm') {
        st.month += delta;
        if (st.month > 11) st.month = 0;
        if (st.month < 0) st.month = 11;
        var maxD = new Date(st.year, st.month + 1, 0).getDate();
        if (st.day > maxD) st.day = maxD;
    } else if (splitDateActiveSeg === 'yyyy') {
        st.year += delta;
    }
    splitDateRender();
    splitDateOnChange();
}

function splitDateTypeDigit(ch) {
    splitDateTypeBuf += ch;
    var st = splitDateState;
    if (splitDateActiveSeg === 'dd') {
        var d = parseInt(splitDateTypeBuf);
        if (splitDateTypeBuf.length >= 2 || d > 3) {
            st.day = Math.min(Math.max(d, 1), new Date(st.year, st.month + 1, 0).getDate());
            splitDateRender(); splitDateMoveSeg(1); splitDateOnChange();
        }
    } else if (splitDateActiveSeg === 'yyyy') {
        if (splitDateTypeBuf.length >= 4) {
            st.year = parseInt(splitDateTypeBuf) || st.year;
            splitDateRender(); splitDateOnChange();
            splitDateTypeBuf = '';
        }
    }
}

function splitDateTypeLetter(ch) {
    if (splitDateActiveSeg !== 'mmm') return;
    splitDateTypeBuf += ch.toLowerCase();
    var st = splitDateState;
    for (var i = 0; i < 12; i++) {
        if (SPLIT_MONTHS[i].toLowerCase().indexOf(splitDateTypeBuf) === 0) {
            st.month = i;
            var maxD = new Date(st.year, st.month + 1, 0).getDate();
            if (st.day > maxD) st.day = maxD;
            splitDateRender();
            if (splitDateTypeBuf.length >= 3) { splitDateMoveSeg(1); splitDateOnChange(); }
            return;
        }
    }
    splitDateTypeBuf = '';
}

function splitDateRender() {
    var st = splitDateState;
    document.getElementById('splitDateDd').textContent = st.day < 10 ? '0' + st.day : '' + st.day;
    document.getElementById('splitDateMmm').textContent = SPLIT_MONTHS[st.month];
    document.getElementById('splitDateYyyy').textContent = '' + st.year;
}

function splitDateSetFromDate(d) {
    splitDateState.day = d.getDate();
    splitDateState.month = d.getMonth();
    splitDateState.year = d.getFullYear();
    splitDateRender();
}

function splitDateGetIsoStr() {
    var st = splitDateState;
    var m = st.month + 1;
    return st.year + '-' + (m < 10 ? '0' + m : '' + m) + '-' + (st.day < 10 ? '0' + st.day : '' + st.day);
}

function splitDateOnChange() {
    if (splitSelectedSecurity) splitPopulateHoldings();
}

// ============================================================================
// SYMBOL SEARCH
// ============================================================================

function splitSearchSymbol(input, dd) {
    var q = input.value.trim();
    if (q.length < 1) { splitDdCtrl.close(); dd._splitResults = []; return; }

    // Rule A.4.2: always use wmsSearchSecurities — never direct DB queries
    var results = wmsSearchSecurities(q);

    // Filter out RIGHTS and NFO — split only applies to equity-like securities
    results = results.filter(function(s) {
        return s.security_type !== 'RIGHTS' && s.security_type !== 'NFO';
    });

    dd._splitResults = results;
    dd.innerHTML = '';
    if (results.length === 0) {
        dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No securities found</div>';
        splitDdCtrl.show();
        return;
    }
    results.forEach(function(sec, idx) {
        var div = document.createElement('div');
        div.className = 'wms-dd-item';
        div.dataset.idx = idx;
        div.innerHTML = '<strong>' + (sec.nse_symbol || sec.symbol) + '</strong> — ' + sec.company_name;
        dd.appendChild(div);
    });
    splitDdCtrl.show();
    splitDdCtrl.resetIdx();
}

// ============================================================================
// OPEN / CLOSE
// ============================================================================

function openSplitModal() {
    splitSelectedSecurity = null;
    splitHoldings = [];
    splitDateSetFromDate(splitLastSavedDate || new Date());
    document.getElementById('splitSymbolInput').value = '';
    document.getElementById('splitSymbolBadge').innerHTML = '';
    document.getElementById('splitRatioRow').style.display = 'none';
    document.getElementById('splitRatioTo').value = '2';
    document.getElementById('splitTableWrap').innerHTML = '<div class="rights-empty">Select a date and symbol to view holdings</div>';
    document.getElementById('splitSaveBtn').disabled = true;

    // Reset tags
    if (splitTagCtrl) { splitTagCtrl.destroy(); splitTagCtrl = null; }
    splitTags = [];
    document.getElementById('splitTagWrap').style.display = 'none';
    document.getElementById('splitTagInput').value = '';
    document.getElementById('splitTagPills').innerHTML = '';
    document.getElementById('splitTagDd').innerHTML = '';

    document.getElementById('splitOverlay').classList.add('show');
    setTimeout(function() { document.getElementById('splitSymbolInput').focus(); }, 100);
}

function closeSplitModal() {
    document.getElementById('splitOverlay').classList.remove('show');
}

// ============================================================================
// SYMBOL SELECTION + POPULATE HOLDINGS
// ============================================================================

function splitSelectSymbol(security) {
    splitSelectedSecurity = security;
    var shortSym = security.nse_symbol || security.symbol;
    document.getElementById('splitSymbolInput').value = '';
    document.getElementById('splitSymbolBadge').innerHTML =
        '<span class="rights-selected-badge">' + shortSym + ' — ' + security.company_name + '</span>';
    document.getElementById('splitRatioRow').style.display = 'flex';
    splitPopulateHoldings();
}

function splitPopulateHoldings() {
    var dateStr = splitDateGetIsoStr();
    if (!splitSelectedSecurity) {
        document.getElementById('splitTableWrap').innerHTML = '<div class="rights-empty">Select a date and symbol to view holdings</div>';
        document.getElementById('splitSaveBtn').disabled = true;
        return;
    }

    var shortSym = splitSelectedSecurity.nse_symbol || splitSelectedSecurity.symbol;
    var holdings = wmsCalcHoldingsAsOfDate(shortSym, dateStr, trTransactions);
    splitHoldings = holdings;

    if (holdings.length === 0) {
        document.getElementById('splitTableWrap').innerHTML =
            '<div class="rights-empty">No holdings found for ' + shortSym + ' as of ' + dateStr + '</div>';
        document.getElementById('splitSaveBtn').disabled = true;
        return;
    }

    var html = '<table class="rights-table"><thead><tr>' +
        '<th style="width:35%">Inv &gt; Trd &gt; Brk</th>' +
        '<th class="r" style="width:20%">Cur Qty</th>' +
        '<th class="r" style="width:25%">Additional Qty</th>' +
        '</tr></thead><tbody>';
    var totalCurQty = 0;
    holdings.forEach(function(h, idx) {
        totalCurQty += (h.netQuantity || 0);
        html += '<tr>' +
            '<td title="' + h.combinedLabel + '">' + h.combinedLabel + '</td>' +
            '<td class="r">' + h.netQuantity.toLocaleString() + '</td>' +
            '<td class="r"><input type="text" inputmode="numeric" data-idx="' + idx + '" class="split-qty-input" placeholder="0"></td>' +
            '</tr>';
    });
    html += '</tbody>' +
        '<tfoot><tr style="background:#f1f5f9; font-weight:600; border-top:2px solid #cbd5e0;">' +
        '<td>Total</td>' +
        '<td class="r">' + totalCurQty.toLocaleString() + '</td>' +
        '<td class="r" id="split-total-additional">0</td>' +
        '</tr></tfoot></table>';
    document.getElementById('splitTableWrap').innerHTML = html;
    document.getElementById('splitSaveBtn').disabled = false;

    function splitUpdateTotal() {
        var sum = 0;
        document.querySelectorAll('.split-qty-input').forEach(function(el) {
            sum += parseInt((el.value || '').replace(/,/g, '')) || 0;
        });
        var totalEl = document.getElementById('split-total-additional');
        if (totalEl) totalEl.textContent = sum.toLocaleString();
    }

    // Add focus/blur formatting for split qty inputs + live total
    document.querySelectorAll('.split-qty-input').forEach(function(el) {
        el.addEventListener('focus', function() {
            var raw = parseInt(el.value.replace(/,/g, '')) || 0;
            el.value = raw || '';
        });
        el.addEventListener('blur', function() {
            var raw = parseInt(el.value.replace(/,/g, '')) || 0;
            el.value = raw ? raw.toLocaleString('en-IN') : '';
            splitUpdateTotal();
        });
        el.addEventListener('input', splitUpdateTotal);
    });

    // Initialize tag input with auto-populated tags
    splitInitTags();
}

// ============================================================================
// TAG INPUT — auto-populate from existing transactions for same symbol
// ============================================================================

function splitInitTags() {
    if (splitTagCtrl) { splitTagCtrl.destroy(); splitTagCtrl = null; }
    splitTags = [];

    if (splitSelectedSecurity) {
        var shortSym = splitSelectedSecurity.nse_symbol || splitSelectedSecurity.symbol;
        var txns = (typeof trTransactions !== 'undefined') ? trTransactions : [];
        var matchingTags = {};
        for (var i = 0; i < txns.length; i++) {
            var t = txns[i];
            var tSym = (t.short_symbol || t.symbol || '').replace(/^[A-Z]+:/, '');
            if (tSym === shortSym && Array.isArray(t.tags)) {
                t.tags.forEach(function(tag) {
                    var trimmed = (tag || '').trim();
                    if (trimmed && trimmed !== 'blank') matchingTags[trimmed.toLowerCase()] = trimmed;
                });
            }
        }
        Object.values(matchingTags).forEach(function(t) { splitTags.push(t); });
    }

    var tagInput = document.getElementById('splitTagInput');
    var tagPills = document.getElementById('splitTagPills');
    var tagDd = document.getElementById('splitTagDd');
    tagInput.value = '';
    tagPills.innerHTML = '';
    tagDd.innerHTML = '';

    splitTagCtrl = wmsTagInput(tagInput, tagPills, tagDd, {
        tags: splitTags,
        existingTags: (wmsRefData && wmsRefData.tags) || [],
        onChange: function() {}
    });

    document.getElementById('splitTagWrap').style.display = '';
}

// ============================================================================
// APPLY RATIO — auto-fills additional qty for all holdings based on split ratio
// Split: "Each 1 share becomes X shares" → additional = holdings × (X − 1)
// ============================================================================

function splitApplyRatio() {
    var splitTo = parseInt(document.getElementById('splitRatioTo').value) || 0;

    if (splitTo < 2) {
        showAlert('Split ratio must be at least 2 (each 1 share becomes 2 or more).', 'error', 3000);
        return;
    }

    var inputs = document.querySelectorAll('.split-qty-input');
    var totalAdditional = 0;
    inputs.forEach(function(inp) {
        var idx = parseInt(inp.dataset.idx);
        if (splitHoldings[idx]) {
            var additionalQty = splitHoldings[idx].netQuantity * (splitTo - 1);
            inp.value = additionalQty.toLocaleString('en-IN');
            totalAdditional += additionalQty;
        }
    });
    // Refresh the footer total directly (programmatic .value changes don't fire 'input').
    var totalEl = document.getElementById('split-total-additional');
    if (totalEl) totalEl.textContent = totalAdditional.toLocaleString();
}

// ============================================================================
// SAVE — create SPLIT transactions
// ============================================================================

async function splitSaveTransactions() {
    // Collect split quantities from inputs
    var inputs = document.querySelectorAll('.split-qty-input');
    var hasAny = false;
    inputs.forEach(function(inp) {
        var idx = parseInt(inp.dataset.idx);
        var qty = parseInt((inp.value || '').replace(/,/g, '')) || 0;
        if (splitHoldings[idx]) {
            splitHoldings[idx].splitQty = qty;
            if (qty > 0) hasAny = true;
        }
    });

    if (!hasAny) {
        showAlert('Please enter at least one split quantity (or use Apply to calculate from ratio).', 'error', 3000);
        return;
    }

    var saveBtn = document.getElementById('splitSaveBtn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
        var sec = splitSelectedSecurity;
        var shortSym = sec.nse_symbol || sec.bse_symbol || sec.symbol;
        var dateStr = splitDateGetIsoStr();
        var splitTo = parseInt(document.getElementById('splitRatioTo').value) || 0;
        var ratioStr = (splitTo >= 2) ? '1:' + splitTo : '';

        var txns = [];
        splitHoldings.forEach(function(h) {
            if (!h.splitQty || h.splitQty <= 0) return;
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
                transaction_type: 'SPLIT',
                transaction_date: dateStr,
                quantity: h.splitQty,
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
                tags: (splitTags && splitTags.length > 0) ? splitTags.slice() : ['blank'],
                notes: '[Split' + (ratioStr ? ' ' + ratioStr : '') + ' for ' + shortSym + ' on ' + dateStr + ']',
                is_locked: false,
                ignore_for_avg_cost: false,
                dont_display: false
            });
        });

        if (txns.length > 0) {
            await wmsBatchCreateTransactions(txns);
        }

        // Remember the date so the next open defaults to the same day.
        splitLastSavedDate = new Date(splitDateState.year, splitDateState.month, splitDateState.day);

        closeSplitModal();
        if (typeof trRefresh === 'function') await trRefresh();
        showAlert('Split transactions created: ' + txns.length + ' entries.', 'success', 4000);

    } catch (err) {
        console.error('Split save error:', err);
        showAlert('Error saving split transactions: ' + err.message, 'error', 5000);
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Split Transactions';
    }
}

// Export for module loader
window.openSplitModal = openSplitModal;
window.initSplitModule = initSplitModule;
