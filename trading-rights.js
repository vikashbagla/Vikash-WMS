// ============================================================================
// trading-rights.js — Rights Corporate Action (Entitlement + Payment)
// Rule A.1.2: All module-level state uses var
// ============================================================================

// Entitlement state
var rhEntSelectedSecurity = null;   // {id, symbol, company_name, ...} from wmsRefData
var rhEntHoldings = [];             // [{investor_id, trader_id, broker_id, netQuantity, ...}]
var rhEntDdCtrl = null;             // wmsDropdown controller for entitlement symbol search
var rhEntDateState = { day: 1, month: 0, year: 2026 };
var rhEntDateActiveSeg = null;
var rhEntDateTypeBuf = '';
var rhEntCurrentStep = 1;           // 1 = holdings table, 2 = review RE security

// Payment state
var rhPaySelectedSecurity = null;   // RE- security object
var rhPayHoldings = [];
var rhPayDdCtrl = null;             // wmsDropdown controller for payment security search
var rhPayDateState = { day: 1, month: 0, year: 2026 };
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
        var activeSeg = prefix === 'rhEnt' ? rhEntDateActiveSeg : rhPayDateActiveSeg;
        if (!activeSeg) rhDateSetActive(prefix, 'dd');

        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            rhDateMoveSeg(prefix, -1);
        } else if (e.key === 'ArrowRight' || e.key === 'Tab' && !e.shiftKey) {
            var seg = prefix === 'rhEnt' ? rhEntDateActiveSeg : rhPayDateActiveSeg;
            if (seg !== 'yyyy') {
                e.preventDefault();
                rhDateMoveSeg(prefix, 1);
            } else {
                rhDateClearActive(prefix);
            }
        } else if (e.key === 'Tab' && e.shiftKey) {
            var seg2 = prefix === 'rhEnt' ? rhEntDateActiveSeg : rhPayDateActiveSeg;
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
    return prefix === 'rhEnt' ? rhEntDateState : rhPayDateState;
}

function rhDateDaysInMonth(month, year) {
    return new Date(year, month + 1, 0).getDate();
}

function rhDateSetActive(prefix, seg) {
    if (prefix === 'rhEnt') { rhEntDateActiveSeg = seg; rhEntDateTypeBuf = ''; }
    else { rhPayDateActiveSeg = seg; rhPayDateTypeBuf = ''; }
    var wrap = document.getElementById(prefix + 'DateWrap');
    wrap.querySelectorAll('.rhDate-seg').forEach(function(el) {
        el.classList.toggle('active', el.dataset.seg === seg);
    });
}

function rhDateClearActive(prefix) {
    if (prefix === 'rhEnt') { rhEntDateActiveSeg = null; }
    else { rhPayDateActiveSeg = null; }
    var wrap = document.getElementById(prefix + 'DateWrap');
    wrap.querySelectorAll('.rhDate-seg').forEach(function(el) { el.classList.remove('active'); });
}

function rhDateMoveSeg(prefix, dir) {
    var order = ['dd', 'mmm', 'yyyy'];
    var active = prefix === 'rhEnt' ? rhEntDateActiveSeg : rhPayDateActiveSeg;
    var idx = order.indexOf(active);
    var next = idx + dir;
    if (next >= 0 && next < order.length) rhDateSetActive(prefix, order[next]);
}

function rhDateAdjust(prefix, delta) {
    var st = rhDateGetState(prefix);
    var active = prefix === 'rhEnt' ? rhEntDateActiveSeg : rhPayDateActiveSeg;
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
    var active = prefix === 'rhEnt' ? rhEntDateActiveSeg : rhPayDateActiveSeg;
    var buf = prefix === 'rhEnt' ? rhEntDateTypeBuf : rhPayDateTypeBuf;
    buf += ch;
    if (prefix === 'rhEnt') rhEntDateTypeBuf = buf; else rhPayDateTypeBuf = buf;

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
            if (prefix === 'rhEnt') rhEntDateTypeBuf = ''; else rhPayDateTypeBuf = '';
        }
    }
}

function rhDateTypeLetter(prefix, ch) {
    var active = prefix === 'rhEnt' ? rhEntDateActiveSeg : rhPayDateActiveSeg;
    if (active !== 'mmm') return;
    var buf = prefix === 'rhEnt' ? rhEntDateTypeBuf : rhPayDateTypeBuf;
    buf += ch.toLowerCase();
    if (prefix === 'rhEnt') rhEntDateTypeBuf = buf; else rhPayDateTypeBuf = buf;

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
    else rhPayPopulateHoldings();
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
// SHARED: Holdings as-of-date calculation
// ============================================================================

function rhCalcHoldingsAsOfDate(shortSymbol, targetDate) {
    var filtered = trTransactions.filter(function(t) {
        var sym = t.short_symbol || t.symbol;
        return !t.dont_display && sym === shortSymbol && t.transaction_date <= targetDate;
    });

    var groups = {};
    filtered.forEach(function(t) {
        var key = (t.investor_id || '') + '|' + (t.trader_id || '') + '|' + (t.broker_id || '');
        if (!groups[key]) {
            groups[key] = {
                investor_id: t.investor_id,
                trader_id: t.trader_id,
                broker_id: t.broker_id,
                txns: []
            };
        }
        groups[key].txns.push(t);
    });

    var invMap = wmsRefData.investorObjMap || {};
    var brkMap = wmsRefData.brokerObjMap || {};
    var results = [];

    Object.keys(groups).forEach(function(key) {
        var g = groups[key];
        var calc = wmsCalcAvgCost(g.txns);
        if (calc.netQuantity <= 0) return;

        var inv = invMap[g.investor_id];
        var trader = g.trader_id ? invMap[g.trader_id] : null;
        var brk = brkMap[g.broker_id];

        // Build combined "Inv > Trader > Broker" label
        var invLabel = inv ? (inv.short_name || inv.name) : '—';
        var trdLabel = trader ? (trader.short_name || trader.name) : '';
        var brkLabel = brk ? (brk.broker_code || brk.name) : '—';
        var combined = invLabel;
        if (trdLabel && trdLabel !== invLabel) combined += ' > ' + trdLabel;
        if (brkLabel) combined += ' > ' + brkLabel;

        results.push({
            investor_id: g.investor_id,
            trader_id: g.trader_id,
            broker_id: g.broker_id,
            invName: invLabel,
            traderName: trdLabel,
            brkName: brkLabel,
            combinedLabel: combined,
            netQuantity: calc.netQuantity,
            avgCost: calc.avgCost
        });
    });

    return results;
}

// ============================================================================
// ENTITLEMENT: Open / Close
// ============================================================================

function openRightsEntitlementModal() {
    rhEntSelectedSecurity = null;
    rhEntHoldings = [];
    rhEntCurrentStep = 1;
    rhDateSetFromDate('rhEnt', new Date());
    document.getElementById('rhEntSymbolInput').value = '';
    document.getElementById('rhEntSymbolBadge').innerHTML = '';
    document.getElementById('rhEntTableWrap').innerHTML = '<div class="rights-empty">Select a date and symbol to view holdings</div>';
    document.getElementById('rhEntConfirmBtn').disabled = true;
    // Reset UI to step 1
    document.getElementById('rhEntStep1').style.display = '';
    document.getElementById('rhEntStep2').classList.remove('show');
    document.getElementById('rhEntConfirmBtn').textContent = 'Confirm & Review';
    document.getElementById('rhEntCancelBtn').textContent = 'Cancel';
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
    holdings.forEach(function(h, idx) {
        html += '<tr>' +
            '<td>' + h.combinedLabel + '</td>' +
            '<td class="r">' + h.netQuantity.toLocaleString() + '</td>' +
            '<td class="r"><input type="number" min="0" step="1" data-idx="' + idx + '" class="rh-ent-qty"></td>' +
            '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('rhEntTableWrap').innerHTML = html;
    document.getElementById('rhEntConfirmBtn').disabled = false;
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
        var qty = parseInt(inp.value) || 0;
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
        var headers = {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        };

        // Check if RE security already exists
        var checkResp = await fetch(SUPABASE_URL + '/rest/v1/securities_db?isin=eq.' + encodeURIComponent(isin) + '&select=id', {
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
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
                trader_id: h.trader_id || null,
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
                tags: ['blank'],
                notes: '[Rights Entitlement from ' + (sec.nse_symbol || sec.symbol) + ' on ' + dateStr + ']',
                is_locked: false,
                ignore_for_avg_cost: false,
                dont_display: false
            });
        });

        if (txns.length > 0) {
            await rhBatchCreateTransactions(txns);
        }

        closeRightsEntitlementModal();
        await wmsLoadSecuritiesCm();
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
    rhDateSetFromDate('rhPay', new Date());
    document.getElementById('rhPaySecurityInput').value = '';
    document.getElementById('rhPaySecurityBadge').innerHTML = '';
    document.getElementById('rhPayTableWrap').innerHTML = '<div class="rights-empty">Select a date and security to view holdings</div>';
    document.getElementById('rhPaySaveBtn').disabled = true;
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
    holdings.forEach(function(h, idx) {
        html += '<tr>' +
            '<td>' + h.combinedLabel + '</td>' +
            '<td class="r">' + h.netQuantity.toLocaleString() + '</td>' +
            '<td class="r"><input type="number" min="0" step="0.01" data-idx="' + idx + '" class="rh-pay-price" oninput="rhPayUpdateTotal(' + idx + ')"></td>' +
            '<td class="r"><input type="number" min="0" step="0.01" data-idx="' + idx + '" class="rh-pay-charges" value="0" oninput="rhPayUpdateTotal(' + idx + ')"></td>' +
            '<td class="r"><span id="rh-pay-total-' + idx + '">0</span></td>' +
            '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('rhPayTableWrap').innerHTML = html;
    document.getElementById('rhPaySaveBtn').disabled = false;
}

function rhPayUpdateTotal(idx) {
    if (idx < 0 || idx >= rhPayHoldings.length) return;
    var h = rhPayHoldings[idx];
    var priceInput = document.querySelector('.rh-pay-price[data-idx="' + idx + '"]');
    var chargesInput = document.querySelector('.rh-pay-charges[data-idx="' + idx + '"]');
    var totalSpan = document.getElementById('rh-pay-total-' + idx);
    if (!priceInput || !totalSpan) return;

    var price = parseFloat(priceInput.value) || 0;
    var charges = parseFloat(chargesInput ? chargesInput.value : 0) || 0;
    var total = (h.netQuantity * price) + charges;
    totalSpan.textContent = total > 0 ? total.toFixed(2) : '0';
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
        var priceInput = document.querySelector('.rh-pay-price[data-idx="' + idx + '"]');
        var chargesInput = document.querySelector('.rh-pay-charges[data-idx="' + idx + '"]');
        var price = parseFloat(priceInput ? priceInput.value : 0) || 0;
        var charges = parseFloat(chargesInput ? chargesInput.value : 0) || 0;
        if (price <= 0) return;

        var grossAmount = h.netQuantity * price;
        txns.push({
            investor_id: h.investor_id,
            trader_id: h.trader_id || null,
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
            tags: ['blank'],
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
        closeRightsPaymentModal();
        if (typeof trRefresh === 'function') await trRefresh();
        showAlert('Rights payment: ' + txns.length + ' transaction(s) saved.', 'success', 4000);
    } catch (e) {
        wmsShowError('Rights payment save failed', e);
        document.getElementById('rhPaySaveBtn').disabled = false;
    }
}

// ============================================================================
// SHARED: Batch create transactions
// ============================================================================

async function rhBatchCreateTransactions(txns) {
    var headers = {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
    };
    for (var i = 0; i < txns.length; i += 10) {
        var batch = txns.slice(i, i + 10);
        var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(batch)
        });
        if (!resp.ok) {
            var errText = await resp.text();
            throw new Error('DB error: ' + resp.status + ' — ' + errText);
        }
    }
}

// ============================================================================
// GLOBAL EXPORTS
// ============================================================================

window.openRightsEntitlementModal = openRightsEntitlementModal;
window.openRightsPaymentModal = openRightsPaymentModal;
window.rhPayUpdateTotal = rhPayUpdateTotal;
