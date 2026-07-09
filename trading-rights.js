// ============================================================================
// trading-rights.js — Rights Corporate Action (Entitlement + Payment)
// Rule A.1.2: All module-level state uses var
// ============================================================================

// Entitlement state
var rhEntSelectedSecurity = null;   // {id, symbol, company_name, ...} from wmsRefData
var rhEntHoldings = [];             // [{investor_id, trader_id, broker_id, netQuantity, ...}]
var rhEntDdCtrl = null;             // wmsDropdown controller for entitlement symbol search
var rhEntTags = [];                 // current tag list for entitlement form
var rhEntTagCtrl = null;            // wmsTagInput controller for entitlement
var rhEntDateState = { day: 1, month: 0, year: 2026 };
// Persist last saved date across modal open/close (null = first open, use today)
var rhEntLastSavedDate = null;
var rhEntDateActiveSeg = null;
var rhEntDateTypeBuf = '';
var rhEntCurrentStep = 1;           // 1 = holdings table, 2 = review RE security

// Payment state
var rhPaySelectedSecurity = null;   // RE- security object
var rhPayHoldings = [];
var rhPayDdCtrl = null;             // wmsDropdown controller for payment security search
var rhPayTags = [];                 // current tag list for payment form
var rhPayTagCtrl = null;            // wmsTagInput controller for payment
var rhPayDateState = { day: 1, month: 0, year: 2026 };
// Persist last saved date across modal open/close (null = first open, use today)
var rhPayLastSavedDate = null;
var rhPayDateActiveSeg = null;
var rhPayDateTypeBuf = '';

// Month names for segmented date widget
var RH_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ============================================================================
// INIT — called once; uses clone trick to guarantee no duplicate listeners
// ============================================================================

function initRightsModule() {
    // Guard moved to END of function so that if init throws partway,
    // a re-load can retry. Also resets dropdown controllers in case
    // the script was loaded twice (second load re-declares vars to null).
    window._rhModuleInitDone = false;

    // ------------------------------------------------------------------
    // Helper: clone an element in-place to strip ALL existing listeners
    // ------------------------------------------------------------------
    function freshClone(id) {
        var el = document.getElementById(id);
        if (!el) return null;
        var clone = el.cloneNode(true);
        el.parentNode.replaceChild(clone, el);
        return clone;
    }

    // --- Entitlement modal ---
    var entCloseBtn   = freshClone('rhEntCloseBtn');
    var entCancelBtn  = freshClone('rhEntCancelBtn');
    var entConfirmBtn = freshClone('rhEntConfirmBtn');
    var entOverlay    = document.getElementById('rightsEntitlementOverlay');

    // Single delegating handler — checks rhEntCurrentStep
    entConfirmBtn.addEventListener('click', function() {
        if (rhEntCurrentStep === 1) rhEntConfirmAndReview();
        else rhEntSave();
    });
    entCancelBtn.addEventListener('click', function() {
        if (rhEntCurrentStep === 1) closeRightsEntitlementModal();
        else rhEntBackToStep1();
    });
    entCloseBtn.addEventListener('click', closeRightsEntitlementModal);
    entOverlay.addEventListener('click', function(e) {
        if (e.target === entOverlay) closeRightsEntitlementModal();
    });

    // Entitlement date widget (clone the wrap to strip any old listeners)
    freshClone('rhEntDateWrap');
    rhInitDateWidget('rhEnt');

    // Entitlement symbol search with wmsDropdown
    var entInput = document.getElementById('rhEntSymbolInput');
    var entDd = document.getElementById('rhEntSymbolDd');
    rhEntDdCtrl = wmsDropdown(entInput, entDd, {
        itemSelector: '.wms-dd-item',
        closeOnSelect: true,
        blurDelay: 200,
        escClearsInput: false,
        onSelect: function(itemEl) {
            var idx = parseInt(itemEl.dataset.idx);
            var results = entDd._rhResults || [];
            if (results[idx]) rhEntSelectSymbol(results[idx]);
        }
    });
    entInput.addEventListener('input', function() {
        rhSearchSymbol(entInput, entDd, rhEntDdCtrl, false);
    });
    // Mouse click support on entitlement symbol dropdown
    entDd.addEventListener('mousedown', function(e) {
        var item = e.target.closest('.wms-dd-item');
        if (!item) return;
        e.preventDefault();
        var idx = parseInt(item.dataset.idx);
        var results = entDd._rhResults || [];
        if (results[idx]) rhEntSelectSymbol(results[idx]);
        rhEntDdCtrl.close();
    });

    // --- Payment modal ---
    var payCloseBtn  = freshClone('rhPayCloseBtn');
    var payCancelBtn = freshClone('rhPayCancelBtn');
    var paySaveBtn   = freshClone('rhPaySaveBtn');
    var payOverlay   = document.getElementById('rightsPaymentOverlay');

    payCloseBtn.addEventListener('click', closeRightsPaymentModal);
    payCancelBtn.addEventListener('click', closeRightsPaymentModal);
    paySaveBtn.addEventListener('click', rhPaySaveTransactions);
    payOverlay.addEventListener('click', function(e) {
        if (e.target === payOverlay) closeRightsPaymentModal();
    });

    // Payment date widget (clone wrap to strip old listeners)
    freshClone('rhPayDateWrap');
    rhInitDateWidget('rhPay');

    // Payment security search (unrestricted — any security)
    var payInput = document.getElementById('rhPaySecurityInput');
    var payDd = document.getElementById('rhPaySecurityDd');
    rhPayDdCtrl = wmsDropdown(payInput, payDd, {
        itemSelector: '.wms-dd-item',
        closeOnSelect: true,
        blurDelay: 200,
        escClearsInput: false,
        onSelect: function(itemEl) {
            var idx = parseInt(itemEl.dataset.idx);
            var results = payDd._rhResults || [];
            if (results[idx]) rhPaySelectSecurity(results[idx]);
        }
    });
    payInput.addEventListener('input', function() {
        rhSearchSymbol(payInput, payDd, rhPayDdCtrl, false);
    });
    // Mouse click support on payment security dropdown
    payDd.addEventListener('mousedown', function(e) {
        var item = e.target.closest('.wms-dd-item');
        if (!item) return;
        e.preventDefault();
        var idx = parseInt(item.dataset.idx);
        var results = payDd._rhResults || [];
        if (results[idx]) rhPaySelectSecurity(results[idx]);
        rhPayDdCtrl.close();
    });

    // ESC handler (only one needed — checks which modal is visible)
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            if (document.getElementById('rightsEntitlementOverlay').classList.contains('show')) {
                closeRightsEntitlementModal();
            } else if (document.getElementById('rightsPaymentOverlay').classList.contains('show')) {
                closeRightsPaymentModal();
            }
        }
    });

    // Mark init complete AFTER all setup succeeds (not before)
    window._rhModuleInitDone = true;
}

// ============================================================================
// SEGMENTED DATE WIDGET (reusable for both modals)
// prefix = 'rhEnt' or 'rhPay'
// ============================================================================

function rhInitDateWidget(prefix) {
    var wrap = document.getElementById(prefix + 'DateWrap');
    var calBtn = document.getElementById(prefix + 'DateCalBtn');
    var calPicker = document.getElementById(prefix + 'DateCalPicker');
    var segs = wrap.querySelectorAll('.rhDate-seg');

    // Click on segment to activate
    segs.forEach(function(seg) {
        seg.addEventListener('mousedown', function(e) {
            e.preventDefault();
            rhDateSetActive(prefix, seg.dataset.seg);
            wrap.focus();
        });
    });

    // Calendar button
    calBtn.addEventListener('click', function(e) {
        e.preventDefault();
        calPicker.showPicker ? calPicker.showPicker() : calPicker.click();
    });
    calPicker.addEventListener('change', function() {
        if (!calPicker.value) return;
        var d = new Date(calPicker.value + 'T00:00:00');
        rhDateSetFromDate(prefix, d);
        rhDateOnChange(prefix);
    });

    // Keyboard navigation
    wrap.addEventListener('keydown', function(e) {
        var activeSeg = rhDateGetActiveSeg(prefix);
        if (!activeSeg) rhDateSetActive(prefix, 'dd');

        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            rhDateMoveSeg(prefix, -1);
        } else if (e.key === 'ArrowRight' || e.key === 'Tab' && !e.shiftKey) {
            var seg = rhDateGetActiveSeg(prefix);
            if (seg !== 'yyyy') {
                e.preventDefault();
                rhDateMoveSeg(prefix, 1);
            } else {
                rhDateClearActive(prefix);
            }
        } else if (e.key === 'Tab' && e.shiftKey) {
            var seg2 = rhDateGetActiveSeg(prefix);
            if (seg2 !== 'dd') {
                e.preventDefault();
                rhDateMoveSeg(prefix, -1);
            } else {
                rhDateClearActive(prefix);
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            rhDateAdjust(prefix, 1);
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            rhDateAdjust(prefix, -1);
        } else if (/^[0-9]$/.test(e.key)) {
            e.preventDefault();
            rhDateTypeDigit(prefix, e.key);
        } else if (/^[a-zA-Z]$/.test(e.key)) {
            e.preventDefault();
            rhDateTypeLetter(prefix, e.key);
        }
    });
}

function rhDateGetState(prefix) {
    if (prefix === 'rhEnt') return rhEntDateState;
    if (prefix === 'inc' && typeof incDateState !== 'undefined') return incDateState;
    return rhPayDateState;
}

function rhDateDaysInMonth(month, year) {
    return new Date(year, month + 1, 0).getDate();
}

function rhDateSetActive(prefix, seg) {
    if (prefix === 'rhEnt') { rhEntDateActiveSeg = seg; rhEntDateTypeBuf = ''; }
    else if (prefix === 'inc' && typeof incDateActiveSeg !== 'undefined') { incDateActiveSeg = seg; incDateTypeBuf = ''; }
    else { rhPayDateActiveSeg = seg; rhPayDateTypeBuf = ''; }
    var wrap = document.getElementById(prefix + 'DateWrap');
    wrap.querySelectorAll('.rhDate-seg').forEach(function(el) {
        el.classList.toggle('active', el.dataset.seg === seg);
    });
}

function rhDateClearActive(prefix) {
    if (prefix === 'rhEnt') { rhEntDateActiveSeg = null; }
    else if (prefix === 'inc' && typeof incDateActiveSeg !== 'undefined') { incDateActiveSeg = null; }
    else { rhPayDateActiveSeg = null; }
    var wrap = document.getElementById(prefix + 'DateWrap');
    wrap.querySelectorAll('.rhDate-seg').forEach(function(el) { el.classList.remove('active'); });
}

function rhDateGetActiveSeg(prefix) {
    if (prefix === 'rhEnt') return rhEntDateActiveSeg;
    if (prefix === 'inc' && typeof incDateActiveSeg !== 'undefined') return incDateActiveSeg;
    return rhPayDateActiveSeg;
}

function rhDateGetTypeBuf(prefix) {
    if (prefix === 'rhEnt') return rhEntDateTypeBuf;
    if (prefix === 'inc' && typeof incDateTypeBuf !== 'undefined') return incDateTypeBuf;
    return rhPayDateTypeBuf;
}

function rhDateSetTypeBuf(prefix, val) {
    if (prefix === 'rhEnt') rhEntDateTypeBuf = val;
    else if (prefix === 'inc' && typeof incDateTypeBuf !== 'undefined') incDateTypeBuf = val;
    else rhPayDateTypeBuf = val;
}

function rhDateMoveSeg(prefix, dir) {
    var order = ['dd', 'mmm', 'yyyy'];
    var active = rhDateGetActiveSeg(prefix);
    var idx = order.indexOf(active);
    var next = idx + dir;
    if (next >= 0 && next < order.length) rhDateSetActive(prefix, order[next]);
}

function rhDateAdjust(prefix, delta) {
    var st = rhDateGetState(prefix);
    var active = rhDateGetActiveSeg(prefix);
    if (active === 'dd') {
        st.day += delta;
        var maxDay = rhDateDaysInMonth(st.month, st.year);
        if (st.day > maxDay) st.day = 1;
        if (st.day < 1) st.day = maxDay;
    } else if (active === 'mmm') {
        st.month += delta;
        if (st.month > 11) st.month = 0;
        if (st.month < 0) st.month = 11;
        var maxD = rhDateDaysInMonth(st.month, st.year);
        if (st.day > maxD) st.day = maxD;
    } else if (active === 'yyyy') {
        st.year += delta;
    }
    rhDateRender(prefix);
    rhDateOnChange(prefix);
}

function rhDateTypeDigit(prefix, ch) {
    var st = rhDateGetState(prefix);
    var active = rhDateGetActiveSeg(prefix);
    var buf = rhDateGetTypeBuf(prefix);
    buf += ch;
    rhDateSetTypeBuf(prefix, buf);

    if (active === 'dd') {
        var d = parseInt(buf);
        if (buf.length >= 2 || d > 3) {
            st.day = Math.min(Math.max(d, 1), rhDateDaysInMonth(st.month, st.year));
            rhDateRender(prefix);
            rhDateMoveSeg(prefix, 1);
            rhDateOnChange(prefix);
        }
    } else if (active === 'yyyy') {
        if (buf.length >= 4) {
            st.year = parseInt(buf) || st.year;
            rhDateRender(prefix);
            rhDateOnChange(prefix);
            rhDateSetTypeBuf(prefix, '');
        }
    }
}

function rhDateTypeLetter(prefix, ch) {
    var active = rhDateGetActiveSeg(prefix);
    if (active !== 'mmm') return;
    var buf = rhDateGetTypeBuf(prefix);
    buf += ch.toLowerCase();
    rhDateSetTypeBuf(prefix, buf);

    var st = rhDateGetState(prefix);
    for (var i = 0; i < 12; i++) {
        if (RH_MONTHS[i].toLowerCase().indexOf(buf) === 0) {
            st.month = i;
            var maxD = rhDateDaysInMonth(st.month, st.year);
            if (st.day > maxD) st.day = maxD;
            rhDateRender(prefix);
            if (buf.length >= 3) {
                rhDateMoveSeg(prefix, 1);
                rhDateOnChange(prefix);
            }
            return;
        }
    }
}

function rhDateRender(prefix) {
    var st = rhDateGetState(prefix);
    document.getElementById(prefix + 'DateDd').textContent = (st.day < 10 ? '0' : '') + st.day;
    document.getElementById(prefix + 'DateMmm').textContent = RH_MONTHS[st.month];
    document.getElementById(prefix + 'DateYyyy').textContent = st.year;
}

function rhDateSetFromDate(prefix, d) {
    var st = rhDateGetState(prefix);
    st.day = d.getDate();
    st.month = d.getMonth();
    st.year = d.getFullYear();
    rhDateRender(prefix);
}

function rhDateGetIsoStr(prefix) {
    var st = rhDateGetState(prefix);
    var m = st.month + 1;
    return st.year + '-' + (m < 10 ? '0' : '') + m + '-' + (st.day < 10 ? '0' : '') + st.day;
}

function rhDateOnChange(prefix) {
    if (prefix === 'rhEnt') rhEntPopulateHoldings();
    else if (prefix === 'rhPay') rhPayPopulateHoldings();
    else if (prefix === 'inc' && typeof incDateOnChange === 'function') incDateOnChange();
}

// ============================================================================
// SHARED: Symbol search (populates dropdown, uses wmsDropdown for keyboard nav)
// ============================================================================

function rhSearchSymbol(input, dd, ddCtrl, reOnly) {
    var q = input.value.trim();
    if (q.length < 1) { ddCtrl.close(); dd._rhResults = []; return; }

    var results = wmsSearchSecurities(q);
    if (reOnly) {
        // Filter to securities that have RIGHTS_ENTITLEMENT transactions
        var reSecIds = {};
        trTransactions.forEach(function(t) {
            if (t.transaction_type === 'RIGHTS_ENTITLEMENT') reSecIds[t.security_id] = true;
        });
        results = results.filter(function(s) {
            return reSecIds[s.id];
        });
    }

    dd._rhResults = results;
    dd.innerHTML = '';
    if (results.length === 0) {
        dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No securities found</div>';
        ddCtrl.show();
        return;
    }
    results.forEach(function(sec, idx) {
        var div = document.createElement('div');
        div.className = 'wms-dd-item';
        div.dataset.idx = idx;
        div.innerHTML = '<strong>' + (sec.nse_symbol || sec.symbol) + '</strong> — ' + sec.company_name;
        dd.appendChild(div);
    });
    ddCtrl.show();
    ddCtrl.resetIdx();
}

// ============================================================================
// SHARED: Holdings as-of-date — thin wrapper calling wmsCalcHoldingsAsOfDate
// (canonical implementation is in wms-shared.js)
// ============================================================================

function rhCalcHoldingsAsOfDate(shortSymbol, targetDate) {
    return wmsCalcHoldingsAsOfDate(shortSymbol, targetDate, trTransactions);
}

// ============================================================================
// ENTITLEMENT: Open / Close
// ============================================================================

function openRightsEntitlementModal() {
    rhEntSelectedSecurity = null;
    rhEntHoldings = [];
    rhEntCurrentStep = 1;
    rhDateSetFromDate('rhEnt', rhEntLastSavedDate || new Date());
    document.getElementById('rhEntSymbolInput').value = '';
    document.getElementById('rhEntSymbolBadge').innerHTML = '';
    document.getElementById('rhEntTableWrap').innerHTML = '<div class="rights-empty">Select a date and symbol to view holdings</div>';
    document.getElementById('rhEntConfirmBtn').disabled = true;
    // Reset UI to step 1
    document.getElementById('rhEntStep1').style.display = '';
    document.getElementById('rhEntStep2').classList.remove('show');
    document.getElementById('rhEntConfirmBtn').textContent = 'Confirm & Review';
    document.getElementById('rhEntCancelBtn').textContent = 'Cancel';
    // Reset tags
    if (rhEntTagCtrl) { rhEntTagCtrl.destroy(); rhEntTagCtrl = null; }
    rhEntTags = [];
    document.getElementById('rhEntTagWrap').style.display = 'none';
    document.getElementById('rhEntTagInput').value = '';
    document.getElementById('rhEntTagPills').innerHTML = '';
    document.getElementById('rhEntTagDd').innerHTML = '';

    document.getElementById('rightsEntitlementOverlay').classList.add('show');
    setTimeout(function() { document.getElementById('rhEntSymbolInput').focus(); }, 100);
}

function closeRightsEntitlementModal() {
    document.getElementById('rightsEntitlementOverlay').classList.remove('show');
}

// ============================================================================
// ENTITLEMENT: Symbol selection + populate holdings
// ============================================================================

function rhEntSelectSymbol(security) {
    rhEntSelectedSecurity = security;
    var shortSym = security.nse_symbol || security.symbol;
    document.getElementById('rhEntSymbolInput').value = '';
    document.getElementById('rhEntSymbolBadge').innerHTML =
        '<span class="rights-selected-badge">' + shortSym + ' — ' + security.company_name + '</span>';
    rhEntPopulateHoldings();
}

function rhEntPopulateHoldings() {
    var dateStr = rhDateGetIsoStr('rhEnt');
    if (!rhEntSelectedSecurity) {
        document.getElementById('rhEntTableWrap').innerHTML = '<div class="rights-empty">Select a date and symbol to view holdings</div>';
        document.getElementById('rhEntConfirmBtn').disabled = true;
        return;
    }

    var shortSym = rhEntSelectedSecurity.nse_symbol || rhEntSelectedSecurity.symbol;
    var holdings = rhCalcHoldingsAsOfDate(shortSym, dateStr);
    rhEntHoldings = holdings;

    if (holdings.length === 0) {
        document.getElementById('rhEntTableWrap').innerHTML = '<div class="rights-empty">No holdings found for ' + shortSym + ' as of ' + dateStr + '</div>';
        document.getElementById('rhEntConfirmBtn').disabled = true;
        return;
    }

    var html = '<table class="rights-table"><thead><tr>' +
        '<th style="width:40%">Inv &gt; Trd &gt; Brk</th>' +
        '<th class="r" style="width:30%">Cur Qty</th>' +
        '<th class="r" style="width:30%">Rights Recd</th>' +
        '</tr></thead><tbody>';
    var totalCurQty = 0;
    holdings.forEach(function(h, idx) {
        totalCurQty += (h.netQuantity || 0);
        html += '<tr>' +
            '<td>' + h.combinedLabel + '</td>' +
            '<td class="r">' + h.netQuantity.toLocaleString() + '</td>' +
            '<td class="r"><input type="text" inputmode="numeric" data-idx="' + idx + '" class="rh-ent-qty" placeholder="0"></td>' +
            '</tr>';
    });
    html += '</tbody>' +
        '<tfoot><tr style="background:#f1f5f9; font-weight:600; border-top:2px solid #cbd5e0;">' +
        '<td>Total</td>' +
        '<td class="r">' + totalCurQty.toLocaleString() + '</td>' +
        '<td class="r" id="rhEnt-total-recd">0</td>' +
        '</tr></tfoot></table>';
    document.getElementById('rhEntTableWrap').innerHTML = html;
    document.getElementById('rhEntConfirmBtn').disabled = false;

    // Live total of Rights Received — updates on every input/blur.
    function rhEntUpdateTotal() {
        var sum = 0;
        document.querySelectorAll('.rh-ent-qty').forEach(function(el) {
            sum += parseInt((el.value || '').replace(/,/g, '')) || 0;
        });
        var totalEl = document.getElementById('rhEnt-total-recd');
        if (totalEl) totalEl.textContent = sum.toLocaleString();
    }

    // Add focus/blur formatting for rights qty inputs + update total
    document.querySelectorAll('.rh-ent-qty').forEach(function(el) {
        el.addEventListener('focus', function() {
            var raw = parseInt(el.value.replace(/,/g, '')) || 0;
            el.value = raw || '';
        });
        el.addEventListener('blur', function() {
            var raw = parseInt(el.value.replace(/,/g, '')) || 0;
            el.value = raw ? raw.toLocaleString('en-IN') : '';
            rhEntUpdateTotal();
        });
        el.addEventListener('input', rhEntUpdateTotal);
    });

    // Initialize tag input with auto-populated tags
    rhEntInitTags();
}

// ============================================================================
// ENTITLEMENT: Step 1 → Step 2 (Review RE security details)
// Uses rhEntCurrentStep state — NO listener swapping
// ============================================================================

function rhEntConfirmAndReview() {
    var inputs = document.querySelectorAll('.rh-ent-qty');
    var hasAny = false;
    inputs.forEach(function(inp) {
        var idx = parseInt(inp.dataset.idx);
        var qty = parseInt((inp.value || '').replace(/,/g, '')) || 0;
        if (rhEntHoldings[idx]) {
            rhEntHoldings[idx].rightsReceived = qty;
            if (qty > 0) hasAny = true;
        }
    });
    if (!hasAny) { showAlert('Please enter at least one rights quantity.', 'error', 3000); return; }

    var sec = rhEntSelectedSecurity;
    var shortSym = sec.nse_symbol || sec.symbol;

    // Pre-fill review fields — symbol defaults to RE-{parent} (same as ISIN)
    var reSymInput = document.getElementById('rhEntReSymbol');
    var reIsinInput = document.getElementById('rhEntReIsin');
    var reSymbol = 'RE-' + shortSym;
    reSymInput.value = reSymbol;
    document.getElementById('rhEntReCompany').value = sec.company_name || shortSym;
    reIsinInput.value = reSymbol;
    document.getElementById('rhEntReType').value = 'RIGHTS';

    // Keep ISIN in sync with symbol (they are the same for RE securities)
    reSymInput.oninput = function() {
        reIsinInput.value = reSymInput.value.trim().toUpperCase();
    };

    // Build summary
    var lines = [];
    rhEntHoldings.forEach(function(h) {
        if (h.rightsReceived > 0) {
            lines.push(h.combinedLabel + ': ' + h.rightsReceived.toLocaleString() + ' rights');
        }
    });
    document.getElementById('rhEntReviewSummary').innerHTML =
        '<strong>Entitlements to create:</strong><br>' + lines.join('<br>');

    // Show step 2, hide step 1
    document.getElementById('rhEntStep1').style.display = 'none';
    document.getElementById('rhEntStep2').classList.add('show');

    // Update button labels (handlers stay the same — they check rhEntCurrentStep)
    document.getElementById('rhEntConfirmBtn').textContent = 'Save';
    document.getElementById('rhEntCancelBtn').textContent = 'Back';
    rhEntCurrentStep = 2;
}

function rhEntBackToStep1() {
    document.getElementById('rhEntStep1').style.display = '';
    document.getElementById('rhEntStep2').classList.remove('show');
    document.getElementById('rhEntConfirmBtn').textContent = 'Confirm & Review';
    document.getElementById('rhEntCancelBtn').textContent = 'Cancel';
    rhEntCurrentStep = 1;
}

// ============================================================================
// TAG INPUT — auto-populate from existing transactions for same symbol
// ============================================================================

function rhEntInitTags() {
    if (rhEntTagCtrl) { rhEntTagCtrl.destroy(); rhEntTagCtrl = null; }
    rhEntTags = [];

    if (rhEntSelectedSecurity) {
        var shortSym = rhEntSelectedSecurity.nse_symbol || rhEntSelectedSecurity.symbol;
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
        Object.values(matchingTags).forEach(function(t) { rhEntTags.push(t); });
    }

    var tagInput = document.getElementById('rhEntTagInput');
    var tagPills = document.getElementById('rhEntTagPills');
    var tagDd = document.getElementById('rhEntTagDd');
    tagInput.value = '';
    tagPills.innerHTML = '';
    tagDd.innerHTML = '';

    rhEntTagCtrl = wmsTagInput(tagInput, tagPills, tagDd, {
        tags: rhEntTags,
        existingTags: (wmsRefData && wmsRefData.tags) || [],
        onChange: function() {}
    });

    document.getElementById('rhEntTagWrap').style.display = '';
}

function rhPayInitTags() {
    if (rhPayTagCtrl) { rhPayTagCtrl.destroy(); rhPayTagCtrl = null; }
    rhPayTags = [];

    if (rhPaySelectedSecurity) {
        var shortSym = rhPaySelectedSecurity.nse_symbol || rhPaySelectedSecurity.symbol;
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
        Object.values(matchingTags).forEach(function(t) { rhPayTags.push(t); });
    }

    var tagInput = document.getElementById('rhPayTagInput');
    var tagPills = document.getElementById('rhPayTagPills');
    var tagDd = document.getElementById('rhPayTagDd');
    tagInput.value = '';
    tagPills.innerHTML = '';
    tagDd.innerHTML = '';

    rhPayTagCtrl = wmsTagInput(tagInput, tagPills, tagDd, {
        tags: rhPayTags,
        existingTags: (wmsRefData && wmsRefData.tags) || [],
        onChange: function() {}
    });

    document.getElementById('rhPayTagWrap').style.display = '';
}

// ============================================================================
// ENTITLEMENT: Save RE security + create entitlement transactions
// ============================================================================

async function rhEntSave() {
    var sec = rhEntSelectedSecurity;
    var shortSym = document.getElementById('rhEntReSymbol').value.trim().toUpperCase();
    var companyName = document.getElementById('rhEntReCompany').value.trim();
    var isin = document.getElementById('rhEntReIsin').value.trim();

    if (!shortSym || !companyName) { showAlert('Symbol and company name are required.', 'error', 3000); return; }

    document.getElementById('rhEntConfirmBtn').disabled = true;
    document.getElementById('rhEntConfirmBtn').textContent = 'Saving...';

    try {
        var headers = wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'});

        // Check if RE security already exists
        var checkResp = await fetch(SUPABASE_URL + '/rest/v1/securities_db?isin=eq.' + encodeURIComponent(isin) + '&select=id', {
            headers: wmsHeaders()
        });
        var existing = await checkResp.json();
        var newSecId;

        if (existing && existing.length > 0) {
            newSecId = existing[0].id;
        } else {
            var secData = {
                symbol: shortSym,
                company_name: companyName,
                isin: isin,
                security_type: 'RIGHTS',
                asset_class: sec.asset_class || null,
                sector: sec.sector || null,
                lot_size: 1,
                is_active: true
            };
            var resp = await fetch(SUPABASE_URL + '/rest/v1/securities_db', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(secData)
            });
            if (!resp.ok) {
                var errBody = await resp.text();
                throw new Error('Insert failed: ' + errBody);
            }
            var created = await resp.json();
            newSecId = Array.isArray(created) ? created[0].id : created.id;
        }

        // Create entitlement transactions
        var dateStr = rhDateGetIsoStr('rhEnt');
        var txns = [];
        rhEntHoldings.forEach(function(h) {
            if (!h.rightsReceived || h.rightsReceived <= 0) return;
            txns.push({
                investor_id: h.investor_id,
                trader_id: h.trader_id || h.investor_id,   // A.2.2 — never NULL
                broker_id: h.broker_id,
                security_id: newSecId,
                security_type: 'RIGHTS',
                symbol: shortSym,
                short_symbol: shortSym,
                company_name: companyName,
                exchange: 'NSE',
                product: null,
                transaction_type: 'RIGHTS_ENTITLEMENT',
                transaction_date: dateStr,
                quantity: h.rightsReceived,
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
                tags: (rhEntTags && rhEntTags.length > 0) ? rhEntTags.slice() : ['blank'],
                notes: '[Rights Entitlement from ' + (sec.nse_symbol || sec.symbol) + ' on ' + dateStr + ']',
                is_locked: false,
                ignore_for_avg_cost: false,
                dont_display: false
            });
        });

        if (txns.length > 0) {
            await rhBatchCreateTransactions(txns);
        }

        // Remember the date so the next open defaults to the same day.
        rhEntLastSavedDate = new Date(rhEntDateState.year, rhEntDateState.month, rhEntDateState.day);

        closeRightsEntitlementModal();
        await wmsLoadSecuritiesCm(0, {all: true});
        if (typeof trRefresh === 'function') await trRefresh();

        showAlert('Rights entitlement created: ' + txns.length + ' transaction(s) for ' + isin, 'success', 4000);

    } catch (e) {
        wmsShowError('Rights entitlement save failed', e);
        document.getElementById('rhEntConfirmBtn').disabled = false;
        document.getElementById('rhEntConfirmBtn').textContent = 'Save';
    }
}

// ============================================================================
// PAYMENT: Open / Close
// ============================================================================

function openRightsPaymentModal() {
    rhPaySelectedSecurity = null;
    rhPayHoldings = [];
    rhDateSetFromDate('rhPay', rhPayLastSavedDate || new Date());
    document.getElementById('rhPaySecurityInput').value = '';
    document.getElementById('rhPaySecurityBadge').innerHTML = '';
    document.getElementById('rhPayTableWrap').innerHTML = '<div class="rights-empty">Select a date and security to view holdings</div>';
    document.getElementById('rhPaySaveBtn').disabled = true;
    // Reset tags
    if (rhPayTagCtrl) { rhPayTagCtrl.destroy(); rhPayTagCtrl = null; }
    rhPayTags = [];
    document.getElementById('rhPayTagWrap').style.display = 'none';
    document.getElementById('rhPayTagInput').value = '';
    document.getElementById('rhPayTagPills').innerHTML = '';
    document.getElementById('rhPayTagDd').innerHTML = '';

    document.getElementById('rightsPaymentOverlay').classList.add('show');
    setTimeout(function() { document.getElementById('rhPaySecurityInput').focus(); }, 100);
}

function closeRightsPaymentModal() {
    document.getElementById('rightsPaymentOverlay').classList.remove('show');
}

// ============================================================================
// PAYMENT: Security selection + populate holdings
// ============================================================================

function rhPaySelectSecurity(security) {
    rhPaySelectedSecurity = security;
    var sym = security.nse_symbol || security.symbol;
    document.getElementById('rhPaySecurityInput').value = '';
    document.getElementById('rhPaySecurityBadge').innerHTML =
        '<span class="rights-selected-badge">' + sym + ' — ' + security.company_name + '</span>';
    rhPayPopulateHoldings();
}

function rhPayPopulateHoldings() {
    var dateStr = rhDateGetIsoStr('rhPay');
    if (!rhPaySelectedSecurity) {
        document.getElementById('rhPayTableWrap').innerHTML = '<div class="rights-empty">Select a date and security to view holdings</div>';
        document.getElementById('rhPaySaveBtn').disabled = true;
        return;
    }

    var shortSym = rhPaySelectedSecurity.nse_symbol || rhPaySelectedSecurity.symbol;
    var holdings = rhCalcHoldingsAsOfDate(shortSym, dateStr);
    rhPayHoldings = holdings;

    if (holdings.length === 0) {
        document.getElementById('rhPayTableWrap').innerHTML = '<div class="rights-empty">No holdings found for ' + shortSym + ' as of ' + dateStr + '</div>';
        document.getElementById('rhPaySaveBtn').disabled = true;
        return;
    }

    var html = '<table class="rights-table"><thead><tr>' +
        '<th style="width:30%">Inv &gt; Trd &gt; Brk</th>' +
        '<th class="r" style="width:14%">RE Qty</th>' +
        '<th class="r" style="width:19%">Price</th>' +
        '<th class="r" style="width:19%">Charges</th>' +
        '<th class="r" style="width:18%">Total</th>' +
        '</tr></thead><tbody>';
    var totalReQty = 0;
    holdings.forEach(function(h, idx) {
        totalReQty += (h.netQuantity || 0);
        html += '<tr>' +
            '<td>' + h.combinedLabel + '</td>' +
            '<td class="r">' + h.netQuantity.toLocaleString() + '</td>' +
            '<td class="r"><input type="text" data-idx="' + idx + '" id="rh-pay-price-' + idx + '" class="rh-pay-price" placeholder="0.00"></td>' +
            '<td class="r"><input type="text" data-idx="' + idx + '" id="rh-pay-charges-' + idx + '" class="rh-pay-charges" placeholder="0.00"></td>' +
            '<td class="r"><span id="rh-pay-total-' + idx + '">0.00</span></td>' +
            '</tr>';
    });
    html += '</tbody>' +
        '<tfoot><tr style="background:#f1f5f9; font-weight:600; border-top:2px solid #cbd5e0;">' +
        '<td>Total</td>' +
        '<td class="r">' + totalReQty.toLocaleString() + '</td>' +
        '<td class="r">—</td>' +
        '<td class="r" id="rh-pay-total-charges">0.00</td>' +
        '<td class="r" id="rh-pay-total-grand">0.00</td>' +
        '</tr></tfoot></table>';
    document.getElementById('rhPayTableWrap').innerHTML = html;
    document.getElementById('rhPaySaveBtn').disabled = false;

    // Bind focus/blur formatting handlers (parity with Add Transaction modal)
    holdings.forEach(function(h, idx) {
        var priceEl = document.getElementById('rh-pay-price-' + idx);
        var chargesEl = document.getElementById('rh-pay-charges-' + idx);
        [priceEl, chargesEl].forEach(function(el) {
            if (!el) return;
            el.addEventListener('focus', function() {
                var raw = el.dataset.rawValue || '';
                el.value = (raw && parseFloat(raw) !== 0) ? raw : '';
            });
            el.addEventListener('blur', function() {
                var v = parseFloat(el.value.replace(/,/g, '')) || 0;
                el.dataset.rawValue = v ? v.toString() : '';
                el.value = v ? wmsFmtAmt(v) : '';
            });
            el.addEventListener('input', function() { rhPayUpdateTotal(idx); });
        });
    });

    // Initialize tag input with auto-populated tags
    rhPayInitTags();
}

function rhPayUpdateTotal(idx) {
    if (idx < 0 || idx >= rhPayHoldings.length) return;
    var h = rhPayHoldings[idx];
    var priceInput = document.getElementById('rh-pay-price-' + idx);
    var chargesInput = document.getElementById('rh-pay-charges-' + idx);
    var totalSpan = document.getElementById('rh-pay-total-' + idx);
    if (!priceInput || !totalSpan) return;

    var price = parseFloat((priceInput.dataset.rawValue || priceInput.value || '').replace(/,/g, '')) || 0;
    var charges = parseFloat((chargesInput ? (chargesInput.dataset.rawValue || chargesInput.value || '') : '0').replace(/,/g, '')) || 0;
    var total = (h.netQuantity * price) + charges;
    totalSpan.textContent = total > 0 ? wmsFmtAmt(total) : '0.00';
    rhPayUpdateGrandTotal();
}

// Sum the per-row Charges and Totals into the footer row.
function rhPayUpdateGrandTotal() {
    var sumCharges = 0, sumGrand = 0;
    for (var i = 0; i < rhPayHoldings.length; i++) {
        var chargesEl = document.getElementById('rh-pay-charges-' + i);
        var totalEl = document.getElementById('rh-pay-total-' + i);
        if (chargesEl) sumCharges += parseFloat((chargesEl.dataset.rawValue || chargesEl.value || '').replace(/,/g, '')) || 0;
        if (totalEl) sumGrand += parseFloat((totalEl.textContent || '').replace(/,/g, '')) || 0;
    }
    var chTot = document.getElementById('rh-pay-total-charges');
    var grTot = document.getElementById('rh-pay-total-grand');
    if (chTot) chTot.textContent = sumCharges > 0 ? wmsFmtAmt(sumCharges) : '0.00';
    if (grTot) grTot.textContent = sumGrand > 0 ? wmsFmtAmt(sumGrand) : '0.00';
}

// ============================================================================
// PAYMENT: Save transactions
// ============================================================================

async function rhPaySaveTransactions() {
    var dateStr = rhDateGetIsoStr('rhPay');
    if (!rhPaySelectedSecurity) { showAlert('Select date and security first.', 'error', 3000); return; }

    var sec = rhPaySelectedSecurity;
    var sym = sec.nse_symbol || sec.symbol;
    var txns = [];

    rhPayHoldings.forEach(function(h, idx) {
        if (h.netQuantity <= 0) return;
        var priceInput = document.getElementById('rh-pay-price-' + idx);
        var chargesInput = document.getElementById('rh-pay-charges-' + idx);
        var price = parseFloat((priceInput ? (priceInput.dataset.rawValue || priceInput.value || '') : '0').replace(/,/g, '')) || 0;
        var charges = parseFloat((chargesInput ? (chargesInput.dataset.rawValue || chargesInput.value || '') : '0').replace(/,/g, '')) || 0;
        if (price <= 0) return;

        var grossAmount = h.netQuantity * price;
        txns.push({
            investor_id: h.investor_id,
            trader_id: h.trader_id || h.investor_id,   // A.2.2 — never NULL
            broker_id: h.broker_id,
            security_id: sec.id,
            security_type: sec.security_type || 'RIGHTS',
            symbol: sym,
            short_symbol: sym,
            company_name: sec.company_name || sym,
            exchange: 'NSE',
            product: null,
            transaction_type: 'RIGHTS_PAYMENT',
            transaction_date: dateStr,
            quantity: h.netQuantity,
            lots: 0,
            price: Math.round(price * 100) / 100,
            gross_amount: Math.round(grossAmount * 100) / 100,
            brokerage: 0,
            stt: 0,
            other_charges: Math.round(charges * 100) / 100,
            gst: 0,
            tds: 0,
            total_charges: Math.round(charges * 100) / 100,
            trader_charges: 0,
            net_amount: Math.round((grossAmount + charges) * 100) / 100,
            margin_blocked: 0,
            broker_contract_note_no: null,
            broker_trade_id: null,
            tags: (rhPayTags && rhPayTags.length > 0) ? rhPayTags.slice() : ['blank'],
            notes: '[Rights Payment for ' + h.netQuantity + ' units of ' + sym + ' @ ' + price + ']',
            is_locked: false,
            ignore_for_avg_cost: false,
            dont_display: false
        });
    });

    if (txns.length === 0) { showAlert('No valid rows to save. Enter a price for at least one row.', 'error', 3000); return; }

    try {
        document.getElementById('rhPaySaveBtn').disabled = true;
        await rhBatchCreateTransactions(txns);
        // Remember the date so the next open defaults to the same day.
        rhPayLastSavedDate = new Date(rhPayDateState.year, rhPayDateState.month, rhPayDateState.day);
        closeRightsPaymentModal();
        if (typeof trRefresh === 'function') await trRefresh();
        showAlert('Rights payment: ' + txns.length + ' transaction(s) saved.', 'success', 4000);
    } catch (e) {
        wmsShowError('Rights payment save failed', e);
        document.getElementById('rhPaySaveBtn').disabled = false;
    }
}

// ============================================================================
// SHARED: Batch create transactions — thin wrapper calling wmsBatchCreateTransactions
// (canonical implementation is in wms-shared.js)
// ============================================================================

async function rhBatchCreateTransactions(txns) {
    return wmsBatchCreateTransactions(txns);
}

// ============================================================================
// GLOBAL EXPORTS
// ============================================================================

window.openRightsEntitlementModal = openRightsEntitlementModal;
window.openRightsPaymentModal = openRightsPaymentModal;
window.rhPayUpdateTotal = rhPayUpdateTotal;
