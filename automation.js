// ============================================================================
// Automated Trading Module — controllers
// ============================================================================
//
// V1 scope: Admin sub-tab only.
//   • Trigger eod-prices-ingest Edge Function (5-day smoke test or 252-day backfill)
//   • Show last run summary from auto_runs (strategy_name='_eod_ingest')
//   • market_prices snapshot (count, date range, distinct securities)
//   • auto_strategies list
//
// Open Trades / Recent Events / Run History tabs are stubs — populated in Phase 6
// after the automation-runner Edge Function lands.

'use strict';

// ----------------------------------------------------------------------------
// Tab switching
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Family tab switching (Phase A of UI reimagining, 2026-07-09)
//
// Strategy-family-first workspace: [Health] [GS] [KH] [Pairs]. (Legacy deleted E.3.)
// Legacy panel wraps the existing sub-tabs unchanged. Family pages ship in
// Phases B–D. See Documentation/automation/UI-REIMAGINE-PLAN.md.
// ----------------------------------------------------------------------------

function autoSwitchFamily(fam) {
    if (!fam) return;
    document.querySelectorAll('.au-fam-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.automation-family-panel').forEach(p => p.classList.remove('active'));
    var btn = document.querySelector('.au-fam-tab-btn[data-fam="' + fam + '"]');
    var panel = document.getElementById('au-fam-' + fam);
    if (btn) btn.classList.add('active');
    if (panel) panel.classList.add('active');

    if (fam === 'health') {
        if (!window._auHealthLoaded) {
            autoHealthLoadAll();
            window._auHealthLoaded = true;
        }
    }

    if (fam === 'pairs') {
        if (!window._auPairsFamLoaded) {
            autoLoadPairsFamRefresh();
            window._auPairsFamLoaded = true;
        }
        autoEnsureSharedRefresh();
    }

    if (fam === 'kh') {
        if (!window._auKhFamLoaded) {
            autoLoadKhFamRefresh();
            window._auKhFamLoaded = true;
        } else {
            autoRenderKhFamMetrics();
        }
    }

    if (fam === 'at2') {
        // Always refresh: AT2 state changes from the EF and from manual closes,
        // and a cached page that looks flat is the worst thing this page can do.
        autoAt2Refresh();
    }

    if (fam === 'gs') {
        // Phase E.1a: no mirror setup — the GS renderers write straight into this
        // page's targets (autoTarget / autoBadgeTarget).
        if (!window._auGsFamLoaded) {
            autoLoadGsFamRefresh();
            window._auGsFamLoaded = true;
        } else {
            // Repaint both pages' cards from the last-known per-mode totals.
            autoRenderGsFamMetrics('live');
            autoRenderGsFamMetrics('paper');
        }
        // GS Open Trades live P&L uses the shared refresh timer; make sure it's armed.
        autoEnsureSharedRefresh();
    }

    if (fam === 'manual') {
        autoManualInit();
    }

}

// ============================================================================
// ✋ Manual — owner-only Fyers order entry (GOP-C4, 2026-07-14).
// POSTs to the wms-manual-order EF, which validates + enqueues ONE order and
// requires the server-side manual-order password (2nd factor over the shared
// Auto-Trading session). The Confirm dialog gates each order; the password is
// held in memory for this tab only (once per session). NEVER writes to
// wms_live_commands directly — that would bypass the vetted-writer rule A.1.9e-i.
// ============================================================================

var _auManualPw = null;            // in-memory only, this tab, this session
var _auManualPollTimer = null;
var _auManualPending = null;
var _AU_M_INP = 'width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;box-sizing:border-box';
var _auManualRowSeq = 0;           // leg-row id sequence
var _auManualLegsToPlace = null;   // legs staged by Review, placed by Confirm
var _auManualTraders = [];         // cached investors for the per-leg trader dropdown
var _auManualLegTagCtrls = {};     // rid -> wmsTagInput controller (per-leg tags)

function autoManualInit() {
    if (!document.getElementById('au-manual-root')) return;
    if (_auManualPw) autoManualRenderForm(); else autoManualRenderGate();
}

function autoManualRenderGate(msg) {
    var root = document.getElementById('au-manual-root');
    if (!root) return;
    root.innerHTML =
        '<div style="border:1px solid #e5e7eb;border-radius:10px;padding:20px;background:#fff">' +
        '<h3 style="margin:0 0 6px">✋ Manual order — unlock</h3>' +
        '<div style="font-size:13px;color:#6b7280;margin-bottom:12px">Enter the manual-order password. Held only in this browser tab for this session; sent with every order and verified server-side.</div>' +
        (msg ? '<div style="color:#cf222e;font-size:13px;margin-bottom:10px">' + autoEsc(msg) + '</div>' : '') +
        '<input id="au-manual-pw" type="password" autocomplete="off" placeholder="Manual-order password" style="width:100%;max-width:320px;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px" onkeydown="if(event.key===\'Enter\')autoManualUnlock()">' +
        '<div style="margin-top:12px"><button class="au-btn au-btn-primary" onclick="autoManualUnlock()">Unlock</button></div>' +
        '</div>';
    var el = document.getElementById('au-manual-pw'); if (el) el.focus();
}

function autoManualUnlock() {
    var el = document.getElementById('au-manual-pw');
    var v = el ? el.value : '';
    if (!v) { autoManualRenderGate('Password required.'); return; }
    _auManualPw = v;
    autoManualRenderForm();
}

function autoManualLock() {
    _auManualPw = null;
    if (_auManualPollTimer) { clearInterval(_auManualPollTimer); _auManualPollTimer = null; }
    autoManualRenderGate('Locked.');
}

// ============================================================================
// GOP-C4v2 (2026-07-14) — the Manual page is a faithful Add Transaction row
// clone + live-order extras + bracket-linked SL. Ported (NOT shared) from
// trading-add-transaction.js: symbol search (equity + F&O + Fyers options),
// calculator amount fields (no spinner arrows, dataset.rawValue), lots<->qty
// with signed side, live price via window.fyersCall. Live-order extras:
// Market/Limit radios (Market disables price), an Add-SL leg (bracket-linked,
// placed immediately with the entry — §2c), and a Cancel-SL button. NO product
// field — the EF derives it. Places ONLY via the wms-manual-order EF (A.1.9e-i);
// never writes wms_live_commands from the browser.
//
// Namespacing: the trading module owns `at*`/`addTxn-*`; this page uses `atm*`/
// `atm-*` so the two never collide (the Trading module is NOT touched).
// ============================================================================

var _atmRows = [];            // [{rowId, security_id, symbol, short_symbol, company_name, security_type, asset_class, exchange, lot_size, broker_tokens, lots, quantity, price, orderType, tags, sl:{on,orderType,stopPrice,limitPrice}}]
var _atmRowSeq = 0;
var _atmSymItems = {};        // rowId -> search result items
var _atmSymCtrls = {};        // rowId -> wmsDropdown controller
var _atmTagCtrls = {};        // rowId -> wmsTagInput controller

// ---- number helpers (ported from atFmt*, plus a safe calculator eval) -------
function atmFmtQty(v) {
    if (v === null || v === undefined || isNaN(v) || v === 0) return '';
    var abs = Math.abs(Math.round(v));
    var s = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return v < 0 ? '-' + s : s;
}
function atmFmtPrice(v) {
    if (v === null || v === undefined || isNaN(v) || v === 0) return '';
    var abs = Math.abs(v);
    return (v < 0 ? '-' : '') + abs.toFixed(2).replace(/\.?0+$/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
// Mini-calculator: evaluate a simple arithmetic expression (digits, . + - * / ()).
// Anything else -> NaN. Never eval arbitrary code (no letters allowed).
function atmEvalNum(str) {
    var s = String(str == null ? '' : str).replace(/,/g, '').trim();
    if (s === '') return 0;
    if (!/^[-+*/(). 0-9]+$/.test(s)) return NaN;
    try { var v = Function('"use strict";return (' + s + ')')(); return (typeof v === 'number' && isFinite(v)) ? v : NaN; }
    catch (e) { return NaN; }
}

function autoManualField(label, inner) {
    return '<div style="flex:1;margin-bottom:12px"><label style="display:block;font-size:12px;color:#374151;margin-bottom:4px">' + label + '</label>' + inner + '</div>';
}

function autoManualRenderForm() {
    var root = document.getElementById('au-manual-root');
    if (!root) return;
    // The order grid needs room — override the panel's narrow 760px cap (8 columns
    // don't fit in 760px; Symbol collapsed). Wide, like the Add Transaction table.
    root.style.maxWidth = '1180px';
    root.style.margin = '0 auto';
    _atmRows = []; _atmRowSeq = 0; _atmSymItems = {}; _atmSymCtrls = {}; _atmTagCtrls = {};
    root.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
          '<h3 style="margin:0">✋ Manual Fyers order <span style="font-size:12px;font-weight:400;color:#16a34a">● unlocked</span></h3>' +
          '<button class="wms-btn wms-btn-secondary" style="font-size:12px" onclick="autoManualLock()">Lock</button>' +
        '</div>' +
        '<div style="border:1px solid #fca5a5;background:#fef2f2;border-radius:8px;padding:8px 12px;font-size:12px;color:#991b1b;margin-bottom:14px">⚠️ <b>LIVE</b> orders on Veins/Fyers. No automated risk checks — the Confirm step is the only gate. One row per order; each is a separate Fyers order. <b>Qty/Lots is signed: + = BUY, − = SELL.</b> Product is derived automatically (F&O → MARGIN, equity → CNC).</div>' +
        // Flex rows (NOT a fixed-width <table>) so columns fit the container at
        // any width — no horizontal scroll (UI-STANDARDS §H.5.4). Symbol flexes;
        // every other column has a fixed width + flex-shrink:0.
        '<div class="atm-head">' +
            '<span class="atm-c-trader">Trader</span><span class="atm-c-sym">Symbol</span>' +
            '<span class="atm-c-lots">Lots</span><span class="atm-c-qty">Qty</span>' +
            '<span class="atm-c-price">Price / Type</span><span class="atm-c-tags">Tags</span>' +
            '<span class="atm-c-sl">SL</span><span class="atm-c-act"></span>' +
        '</div>' +
        '<div id="atm-rows"></div>' +
        '<div style="margin-top:10px"><button class="wms-btn wms-btn-secondary" style="font-size:12px" onclick="autoManualAddOrderFromLast()">＋ Add order</button></div>' +
        '<div style="margin-top:16px"><button class="wms-btn wms-btn-primary" onclick="autoManualReview()">Review order →</button></div>' +
        '<div id="au-manual-status" style="margin-top:16px"></div>' +
        '<style>' +
          '.atm-head,.atm-main{display:flex;gap:8px;width:100%;align-items:flex-start;box-sizing:border-box}' +
          '.atm-head{color:#6b7280;font-size:10px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;border-bottom:1px solid #e5e7eb;padding:0 0 6px;margin-bottom:4px}' +
          '.atm-order{padding:6px 0;border-bottom:1px solid #f1f5f9}' +
          '.atm-c-trader{flex:0 0 140px;width:140px}' +
          '.atm-c-sym{flex:1 1 auto;min-width:160px;position:relative}' +
          '.atm-c-lots{flex:0 0 66px;width:66px}' +
          '.atm-c-qty{flex:0 0 84px;width:84px}' +
          '.atm-c-price{flex:0 0 150px;width:150px}' +
          '.atm-c-tags{flex:0 0 190px;width:190px;position:relative}' +
          '.atm-c-sl{flex:0 0 74px;width:74px}' +
          '.atm-c-act{flex:0 0 34px;width:34px}' +
          '.atm-main .wms-input,.atm-main .wms-input-compact{width:100%;font-size:12px}' +
          '.atm-radios{display:flex;gap:8px;font-size:11px;color:#374151;margin-top:3px}' +
          '.atm-radios label{display:flex;align-items:center;gap:3px;cursor:pointer}' +
          '.atm-bal{font-size:10px;color:#2563eb;margin-top:2px}' +
          '.atm-sl-panel{background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;padding:8px;margin-top:6px}' +
        '</style>';
    autoManualLoadTraders();
    autoManualAddRow();
}

async function autoManualLoadTraders() {
    try {
        var r = await fetch(SUPABASE_URL + '/rest/v1/investors?select=id,short_name,name&order=short_name.asc', { headers: wmsHeaders() });
        var rows = r.ok ? await r.json() : [];
        _auManualTraders = Array.isArray(rows) ? rows : [];
    } catch (e) { _auManualTraders = []; }
    document.querySelectorAll('.atm-trader').forEach(function (sel) { var cur = sel.value; sel.innerHTML = autoManualTraderOptions(); sel.value = cur; });
}

function autoManualTraderOptions() {
    return '<option value="">(Same as Veins)</option>' + _auManualTraders.map(function (t) {
        return '<option value="' + t.id + '">' + autoEsc(t.short_name || t.name || t.id) + '</option>';
    }).join('');
}

// One order = one <tr>. Faithful to the Add Transaction row: trader, searchable
// symbol (equity + F&O + options), signed lots/qty, calculator price field, plus
// Market/Limit radios, a bracket-SL toggle, and per-row tags.
function autoManualAddRow(copyFromId) {
    if (!document.getElementById('atm-rows')) return;
    var copyFrom = (copyFromId !== undefined) ? _atmRows.find(function (r) { return r.rowId === copyFromId; }) : null;
    var rowId = ++_atmRowSeq;
    var row = {
        rowId: rowId,
        trader_id: copyFrom ? copyFrom.trader_id : null,
        security_id: copyFrom ? copyFrom.security_id : null,
        symbol: copyFrom ? copyFrom.symbol : '',
        short_symbol: copyFrom ? copyFrom.short_symbol : '',
        company_name: copyFrom ? copyFrom.company_name : '',
        security_type: copyFrom ? copyFrom.security_type : 'EQUITY',
        asset_class: copyFrom ? copyFrom.asset_class : null,
        exchange: copyFrom ? copyFrom.exchange : 'NSE',
        lot_size: copyFrom ? copyFrom.lot_size : 1,
        broker_tokens: copyFrom ? copyFrom.broker_tokens : null,
        lots: copyFrom ? copyFrom.lots : 0,
        quantity: copyFrom ? copyFrom.quantity : 0,
        price: copyFrom ? copyFrom.price : 0,
        orderType: copyFrom ? copyFrom.orderType : 'MARKET',
        tags: copyFrom ? copyFrom.tags.slice() : [],
        // SL is per-order and risk-bearing — never copied; add it deliberately per row.
        sl: { on: false, orderType: 'SL-MARKET', stopPrice: 0, limitPrice: 0 }
    };
    _atmRows.push(row);

    var lotsBased = autoManualIsLotsBased(row);
    var order = document.createElement('div');
    order.className = 'atm-order';
    order.dataset.rid = rowId;
    order.innerHTML =
        '<div class="atm-main">' +
            '<span class="atm-c-trader"><select class="wms-input wms-input-compact atm-trader" data-rid="' + rowId + '">' + autoManualTraderOptions() + '</select></span>' +
            '<span class="atm-c-sym">' +
                '<input type="text" class="wms-input wms-input-compact atm-sym" data-rid="' + rowId + '" placeholder="Search…" autocomplete="off" value="' + autoEsc(row.symbol || '') + '">' +
                '<div class="wms-dd atm-symdd" id="atmSymDd_' + rowId + '"></div>' +
            '</span>' +
            '<span class="atm-c-lots"><input type="text" inputmode="numeric" class="wms-input wms-input-compact wms-input-number atm-lots" data-rid="' + rowId + '" placeholder="±lots"' + (lotsBased ? '' : ' disabled') + '><div class="atm-bal" id="atmBalLots_' + rowId + '"></div></span>' +
            '<span class="atm-c-qty"><input type="text" inputmode="numeric" class="wms-input wms-input-compact wms-input-number atm-qty" data-rid="' + rowId + '" placeholder="±qty"><div class="atm-bal" id="atmBal_' + rowId + '"></div></span>' +
            '<span class="atm-c-price">' +
                '<input type="text" inputmode="decimal" class="wms-input wms-input-compact wms-input-number atm-price" data-rid="' + rowId + '" placeholder="price" disabled>' +
                '<div class="atm-radios">' +
                    '<label><input type="radio" name="atmOt_' + rowId + '" class="atm-ot" data-rid="' + rowId + '" value="MARKET" checked>Mkt</label>' +
                    '<label><input type="radio" name="atmOt_' + rowId + '" class="atm-ot" data-rid="' + rowId + '" value="LIMIT">Lmt</label>' +
                '</div>' +
            '</span>' +
            '<span class="atm-c-tags">' +
                '<input type="text" class="wms-input wms-input-compact atm-tags" data-rid="' + rowId + '" placeholder="Tags…" autocomplete="off">' +
                '<div class="wms-tag-pills atm-tagpills" id="atmTagPills_' + rowId + '" style="margin-top:3px"></div>' +
                '<div class="wms-tag-dd atm-tagdd" id="atmTagDd_' + rowId + '"></div>' +
            '</span>' +
            '<span class="atm-c-sl"><button type="button" class="wms-btn wms-btn-secondary atm-sl-toggle" data-rid="' + rowId + '" style="font-size:11px;padding:3px 6px" onclick="autoManualToggleSl(' + rowId + ')">＋ SL</button></span>' +
            '<span class="atm-c-act"><button type="button" class="wms-btn wms-btn-secondary" title="Remove" style="font-size:12px;padding:3px 7px" onclick="autoManualRemoveRow(' + rowId + ')">✕</button></span>' +
        '</div>' +
        '<div class="atm-sl-panel" id="atmSlPanel_' + rowId + '" style="display:none"></div>';
    document.getElementById('atm-rows').appendChild(order);
    autoManualWireRow(rowId);
    if (copyFrom) autoManualPopulateRowDom(rowId);   // mirror the copied order into the inputs
}

// Write a copied row's state into its DOM inputs (symbol, lots/qty, price, the
// Market/Limit radio + disabled state, balance). Tags render via wmsTagInput's
// initial `tags`. Ported spirit of the Add Transaction row-copy.
function autoManualPopulateRowDom(rowId) {
    var row = autoManualRow(rowId); if (!row) return;
    var symInput = document.querySelector('.atm-sym[data-rid="' + rowId + '"]');
    var lotsInput = document.querySelector('.atm-lots[data-rid="' + rowId + '"]');
    var qtyInput = document.querySelector('.atm-qty[data-rid="' + rowId + '"]');
    var priceInput = document.querySelector('.atm-price[data-rid="' + rowId + '"]');
    if (row.security_id && symInput) symInput.value = autoManualFyersSymbol(row);
    if (autoManualIsLotsBased(row)) { if (lotsInput) { lotsInput.disabled = false; lotsInput.value = row.lots || ''; } }
    else { if (lotsInput) { lotsInput.disabled = true; lotsInput.value = ''; } }
    if (qtyInput) qtyInput.readOnly = false;   // both Lots and Qty editable; each computes the other
    if (qtyInput) qtyInput.value = atmFmtQty(row.quantity);
    // Order type radio + price field state
    var otRadio = document.querySelector('.atm-ot[data-rid="' + rowId + '"][value="' + row.orderType + '"]');
    if (otRadio) otRadio.checked = true;
    if (priceInput) {
        priceInput.disabled = (row.orderType === 'MARKET');
        priceInput.value = row.price ? atmFmtPrice(row.price) : '';
        if (row.price) priceInput.dataset.rawValue = row.price;
    }
    autoManualShowBalance(rowId);
}

// "+ Add order" clones the previous order (like the Add Transaction row), so the
// common case — same symbol/qty, different trader — is one edit away. A blank
// first row copies nothing.
function autoManualAddOrderFromLast() {
    var last = _atmRows.length ? _atmRows[_atmRows.length - 1] : null;
    autoManualAddRow(last ? last.rowId : undefined);
}

function autoManualRemoveRow(rowId) {
    if (_atmRows.length <= 1) { autoManualRenderForm(); return; }   // last row → reset the whole form
    _atmRows = _atmRows.filter(function (r) { return r.rowId !== rowId; });
    var tr = document.querySelector('#atm-rows .atm-order[data-rid="' + rowId + '"]');
    if (tr) tr.remove();
    delete _atmSymItems[rowId]; delete _atmSymCtrls[rowId]; delete _atmTagCtrls[rowId];
}

function autoManualRow(rowId) { return _atmRows.find(function (r) { return r.rowId === rowId; }); }

// Lots-driven vs qty-driven entry. MCX orders are placed in LOTS regardless of
// the stored lot_size (Fyers reports lot_size=1 for most MCX; only SILVERM/GOLDM
// are overridden — §A.11.5), so MCX is ALWAYS lots-driven. NSE F&O is lots-driven
// when lot_size>1; equity cash is qty-driven.
function autoManualIsLotsBased(row) { return !!row && (row.lot_size > 1 || row.exchange === 'MCX'); }

function autoManualWireRow(rowId) {
    var row = autoManualRow(rowId); if (!row) return;
    var traderSel = document.querySelector('.atm-trader[data-rid="' + rowId + '"]');
    var symInput = document.querySelector('.atm-sym[data-rid="' + rowId + '"]');
    var lotsInput = document.querySelector('.atm-lots[data-rid="' + rowId + '"]');
    var qtyInput = document.querySelector('.atm-qty[data-rid="' + rowId + '"]');
    var priceInput = document.querySelector('.atm-price[data-rid="' + rowId + '"]');
    var dd = document.getElementById('atmSymDd_' + rowId);

    traderSel.addEventListener('change', function () { row.trader_id = traderSel.value || null; autoManualShowBalance(rowId); });

    // --- Symbol search (ported: equity + F&O + Fyers options, LIVE universe) ---
    _atmSymCtrls[rowId] = wmsDropdown(symInput, dd, {
        itemSelector: '.wms-dd-item', closeOnSelect: true, blurDelay: 200, escClearsInput: false,
        onSelect: function (itemEl) { autoManualPickSym(rowId, itemEl); }
    });
    var symTimer = null;
    symInput.addEventListener('input', function () {
        clearTimeout(symTimer);
        var q = symInput.value.trim();
        if (q.length < 2) { _atmSymCtrls[rowId].close(); return; }
        symTimer = setTimeout(function () { autoManualSearchSym(rowId, q); }, 300);
    });
    dd.addEventListener('mousedown', function (e) {
        var item = e.target.closest('.wms-dd-item'); if (!item || item.dataset.idx === undefined) return;
        e.preventDefault(); autoManualPickSym(rowId, item); _atmSymCtrls[rowId].close();
    });

    // --- Lots (F&O) -> qty ---
    lotsInput.addEventListener('input', function () {
        var lots = parseInt(lotsInput.value.replace(/,/g, '')) || 0;
        row.lots = lots;
        if (autoManualIsLotsBased(row)) { row.quantity = Math.round(lots * row.lot_size); qtyInput.value = atmFmtQty(row.quantity); }
        autoManualRecalc(rowId);
    });
    // --- Qty (equity, or manual override) ---
    qtyInput.addEventListener('focus', function () { var raw = parseInt(qtyInput.value.replace(/,/g, '')) || 0; qtyInput.value = raw || ''; });
    qtyInput.addEventListener('blur', function () { qtyInput.value = atmFmtQty(parseInt(qtyInput.value.replace(/,/g, '')) || 0); });
    qtyInput.addEventListener('input', function () {
        var qty = parseInt(qtyInput.value.replace(/,/g, '')) || 0;
        row.quantity = qty;
        if (autoManualIsLotsBased(row)) { row.lots = row.lot_size > 0 ? Math.round((qty / row.lot_size) * 100) / 100 : 0; lotsInput.value = row.lots || ''; }
        autoManualRecalc(rowId);
    });

    // --- Price (calculator field; disabled unless Limit) ---
    priceInput.addEventListener('focus', function () { var raw = parseFloat(priceInput.value.replace(/,/g, '')) || 0; priceInput.value = raw || ''; });
    priceInput.addEventListener('blur', function () {
        var v = atmEvalNum(priceInput.value);
        if (isNaN(v)) { priceInput.value = atmFmtPrice(row.price); return; }
        row.price = v; priceInput.dataset.rawValue = v; priceInput.value = atmFmtPrice(v);
    });
    priceInput.addEventListener('input', function () { var v = atmEvalNum(priceInput.value); if (!isNaN(v)) { row.price = v; priceInput.dataset.rawValue = v; } });

    // --- Market/Limit radios (Market disables the price field) ---
    document.querySelectorAll('.atm-ot[data-rid="' + rowId + '"]').forEach(function (rb) {
        rb.addEventListener('change', function () {
            if (!rb.checked) return;
            row.orderType = rb.value;
            priceInput.disabled = (rb.value === 'MARKET');
            if (rb.value === 'MARKET') { /* keep the fetched live price shown but unused */ }
            else { priceInput.focus(); }
        });
    });

    // --- Tags widget ---
    var ti = document.querySelector('.atm-tags[data-rid="' + rowId + '"]');
    var tp = document.getElementById('atmTagPills_' + rowId);
    var td = document.getElementById('atmTagDd_' + rowId);
    if (ti && tp && td && typeof wmsTagInput === 'function') {
        autoGetExistingTags().then(function (ex) {
            _atmTagCtrls[rowId] = wmsTagInput(ti, tp, td, { tags: row.tags, existingTags: (ex || []).slice(), onChange: function () {} });
        }).catch(function () {
            _atmTagCtrls[rowId] = wmsTagInput(ti, tp, td, { tags: row.tags, existingTags: [], onChange: function () {} });
        });
    }
}

// Ported from searchAddTxnSymbol — options query -> Fyers; else the global
// wmsRefData cache (equity + F&O). LIVE universe: F&O rows must be active +
// non-expired (an expired contract can never be traded). Equity always passes.
async function autoManualSearchSym(rowId, query) {
    var dd = document.getElementById('atmSymDd_' + rowId);
    var parsed = (typeof wmsParseOptionsQuery === 'function') ? wmsParseOptionsQuery(query) : null;
    if (parsed) { await autoManualSearchOptions(rowId, parsed, dd); return; }
    try {
        if (!wmsRefData.securitiesCmReady || !wmsRefData.securitiesNfoReady) {
            dd.innerHTML = '<div class="wms-dd-item" style="color:#9ca3af;cursor:default">Loading securities…</div>';
            dd.classList.add('show');
            if (!wmsRefData.securitiesCmReady) await wmsLoadSecuritiesCm(0, { all: true });
            if (!wmsRefData.securitiesNfoReady) await wmsLoadSecuritiesNfo();
        }
        var today = new Date().toISOString().slice(0, 10);
        var cached = wmsSearchSecurities(query) || [];
        var items = [];
        cached.forEach(function (sec) {
            if (sec._isNfo) {
                // LIVE universe filter
                if (sec.is_active === false) return;
                if (sec.expiry_date && sec.expiry_date < today) return;
                var isOpt = sec.symbol && (sec.symbol.match(/(CE|PE)$/) !== null);
                items.push({
                    security_id: sec.id, symbol: sec.symbol, short_symbol: sec.underlying_symbol || sec.symbol,
                    company_name: sec.instrument_name || sec.symbol, security_type: 'NFO',
                    asset_class: isOpt ? 'OPTIONS' : 'FUTURES', exchange: sec.exchange || 'NSE',
                    lot_size: sec.lot_size || 1, broker_tokens: sec.broker_tokens,
                    _label: sec.symbol, _sub: (sec.instrument_name || sec.underlying_symbol || '') + (sec.expiry_date ? ' · exp ' + sec.expiry_date : ''), _isNfo: true
                });
            } else {
                items.push({
                    security_id: sec.id, symbol: sec.nse_symbol || sec.bse_symbol || sec.symbol,
                    short_symbol: sec.nse_symbol || sec.bse_symbol || sec.symbol,
                    company_name: sec.company_name || sec.symbol, security_type: sec.security_type || 'EQUITY',
                    asset_class: sec.asset_class || null, exchange: sec.nse_symbol ? 'NSE' : 'BSE',
                    lot_size: sec.lot_size || 1, broker_tokens: sec.broker_tokens,
                    _label: sec.nse_symbol || sec.bse_symbol || sec.symbol, _sub: sec.company_name || '', _isNfo: false
                });
            }
        });
        _atmSymItems[rowId] = items;
        dd.innerHTML = items.length ? items.map(function (it, i) {
            return '<div class="wms-dd-item' + (it._isNfo ? ' nfo' : '') + '" data-idx="' + i + '"><span style="font-family:monospace">' + autoEsc(it._label) + '</span>' +
                (it._sub ? '<span style="color:#6b7280;font-size:11px;margin-left:8px">' + autoEsc(it._sub) + '</span>' : '') + '</div>';
        }).join('') : '<div class="wms-dd-item" style="color:#9ca3af;cursor:default">No matches</div>';
        dd.classList.add('show');
        _atmSymCtrls[rowId].resetIdx();
    } catch (e) { console.error('[manual] symbol search', e); }
}

// Options via Fyers quotes (ported from atSearchOptions).
async function autoManualSearchOptions(rowId, parsed, dd) {
    if (!window.fyersToken) {
        dd.innerHTML = '<div class="wms-dd-item" style="color:#9ca3af;cursor:default">Fyers not connected — options search needs a live Fyers connection.</div>';
        dd.classList.add('show'); return;
    }
    dd.innerHTML = '<div class="wms-dd-item" style="color:#9ca3af;cursor:default">Searching options…</div>';
    dd.classList.add('show');
    var candidates = wmsBuildOptionsCandidates(parsed.underlying, parsed.strike, parsed.optionType, parsed.expiryHint) || [];
    if (!candidates.length) { dd.innerHTML = '<div class="wms-dd-item" style="color:#9ca3af;cursor:default">Could not build option symbols</div>'; return; }
    try {
        var data = await window.fyersCall({ action: 'quotes', symbols: candidates });
        var results = [];
        if (data && data.d) data.d.forEach(function (item) { if (item.v && item.v.lp > 0) results.push({ symbol: item.v.symbol, lp: item.v.lp, chp: item.v.chp || 0 }); });
        if (!results.length) { dd.innerHTML = '<div class="wms-dd-item" style="color:#9ca3af;cursor:default">No active options found</div>'; return; }
        var items = [];
        dd.innerHTML = results.map(function (r, i) {
            var lbl = wmsFormatOptionsDisplay(r.symbol, parsed.underlying, parsed.strike, parsed.optionType);
            items.push({ _fyersSymbol: r.symbol, _displayLabel: lbl, _parsed: parsed });
            return '<div class="wms-dd-item nfo" data-idx="' + i + '"><span style="font-family:monospace">' + autoEsc(lbl) + '</span>' +
                ' <span style="color:#6b7280">₹' + r.lp.toFixed(2) + '</span> <span style="color:' + (r.chp >= 0 ? '#059669' : '#dc2626') + '">' + (r.chp >= 0 ? '+' : '') + r.chp.toFixed(2) + '%</span></div>';
        }).join('');
        _atmSymItems[rowId] = items;
        _atmSymCtrls[rowId].show(); _atmSymCtrls[rowId].resetIdx();
    } catch (err) { dd.innerHTML = '<div class="wms-dd-item" style="color:#dc2626;cursor:default">Options search failed: ' + autoEsc(err.message || String(err)) + '</div>'; }
}

function autoManualPickSym(rowId, itemEl) {
    var idx = parseInt(itemEl.dataset.idx);
    var it = _atmSymItems[rowId] && _atmSymItems[rowId][idx];
    if (!it) return;
    if (it._fyersSymbol) autoManualSelectOptionsContract(rowId, it._fyersSymbol, it._parsed, it._displayLabel);
    else autoManualSelectSecurity(rowId, it);
}

// Ported from atSelectOptionsContract — resolve/auto-create the NFO contract so
// booking has a row to reference, then select it.
async function autoManualSelectOptionsContract(rowId, fyersSymbol, parsed, displayLabel) {
    var row = autoManualRow(rowId); if (!row) return;
    var headers = wmsHeaders();
    var bareSym = fyersSymbol.split(':')[1] || fyersSymbol;
    var nfoCheck = SUPABASE_URL + '/rest/v1/securities_nfo?symbol=eq.' + encodeURIComponent(bareSym) +
        '&select=id,symbol,underlying_symbol,exchange,instrument_type,lot_size,broker_tokens,expiry_date&limit=1';
    var nfoResp = await fetch(nfoCheck, { headers: headers }).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
    var lotSize = 1, secId = null, brokerTokens = {};
    if (nfoResp.length > 0) { lotSize = nfoResp[0].lot_size || 1; secId = nfoResp[0].id; brokerTokens = nfoResp[0].broker_tokens || {}; }
    else {
        var lotResp = await fetch(SUPABASE_URL + '/rest/v1/securities_nfo?underlying_symbol=eq.' + encodeURIComponent(parsed.underlying) + '&select=lot_size&limit=1', { headers: headers }).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
        if (lotResp.length > 0) lotSize = lotResp[0].lot_size || 1;
        var MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
        var expiryDate = null, m = bareSym.match(/(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/);
        if (m) expiryDate = (2000 + parseInt(m[1])) + '-' + String(MONTHS.indexOf(m[2]) + 1).padStart(2, '0') + '-28';
        var nfoRecord = {
            symbol: bareSym, instrument_name: displayLabel || (parsed.underlying + ' ' + (parsed.strike ? parsed.strike + ' ' + parsed.optionType : 'FUT')),
            exchange: fyersSymbol.split(':')[0] || 'NSE', instrument_type: parsed.optionType ? 'OPTIONS' : 'FUTURES',
            underlying_symbol: parsed.underlying, expiry_date: expiryDate, strike_price: parsed.strike || null,
            option_type: parsed.optionType || null, lot_size: lotSize, is_active: true, broker_tokens: {}
        };
        try {
            var createResp = await fetch(SUPABASE_URL + '/rest/v1/securities_nfo', {
                method: 'POST', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }), body: JSON.stringify(nfoRecord)
            });
            if (createResp.ok) {
                var created = await createResp.json();
                if (created && created.length > 0) {
                    secId = created[0].id;
                    if (secId && fyersSymbol && typeof wmsUpdateNfoBrokerToken === 'function') wmsUpdateNfoBrokerToken(secId, fyersSymbol);
                    if (typeof wmsLoadSecuritiesNfo === 'function') wmsLoadSecuritiesNfo();
                }
            } else {
                var errBody = await createResp.json().catch(function () { return {}; });
                showAlert('Could not register NFO security: ' + (errBody.message || 'DB error'), 'error', 5000); return;
            }
        } catch (createErr) { showAlert('Could not register NFO security: ' + createErr.message, 'error', 5000); return; }
    }
    autoManualSelectSecurity(rowId, {
        security_id: secId, symbol: fyersSymbol, short_symbol: parsed.underlying,
        company_name: displayLabel || (parsed.underlying + ' Option'), security_type: 'NFO',
        asset_class: parsed.optionType ? 'OPTIONS' : 'FUTURES', exchange: fyersSymbol.split(':')[0] || 'NSE',
        lot_size: lotSize, broker_tokens: brokerTokens
    });
}

function autoManualSelectSecurity(rowId, sec) {
    var row = autoManualRow(rowId); if (!row) return;
    row.security_id = sec.security_id; row.symbol = sec.symbol; row.short_symbol = sec.short_symbol;
    row.company_name = sec.company_name; row.security_type = sec.security_type; row.asset_class = sec.asset_class;
    row.exchange = sec.exchange; row.lot_size = sec.lot_size || 1; row.broker_tokens = sec.broker_tokens || null;

    var symInput = document.querySelector('.atm-sym[data-rid="' + rowId + '"]');
    if (symInput) symInput.value = autoManualFyersSymbol(row);
    var lotsInput = document.querySelector('.atm-lots[data-rid="' + rowId + '"]');
    var qtyInput = document.querySelector('.atm-qty[data-rid="' + rowId + '"]');
    if (autoManualIsLotsBased(row)) { lotsInput.disabled = false; }
    else { lotsInput.disabled = true; lotsInput.value = ''; row.lots = 0; }
    if (qtyInput) qtyInput.readOnly = false;   // both Lots and Qty editable; each computes the other

    autoManualFetchLivePrice(rowId);
    autoManualShowBalance(rowId);
    setTimeout(function () { if (autoManualIsLotsBased(row)) lotsInput.focus(); else if (qtyInput) qtyInput.focus(); }, 50);
}

// Exchange-qualified Fyers symbol for BOTH the live price fetch and the order
// intent. NFO symbols may already carry a prefix; equity needs NSE:<sym>-EQ.
function autoManualFyersSymbol(row) {
    if (!row) return '';
    if (row.security_type === 'EQUITY') {
        var ft = row.broker_tokens && (row.broker_tokens.fyers || row.broker_tokens.fyers_nse);
        if (ft && String(ft).indexOf(':') >= 0) return String(ft);
        var ex = row.exchange === 'BSE' ? 'BSE' : 'NSE';
        return ex + ':' + (row.short_symbol || row.symbol) + '-EQ';
    }
    if (row.symbol && row.symbol.indexOf(':') >= 0) return row.symbol;
    return (row.exchange || 'NSE') + ':' + row.symbol;
}

// Live price on select -> fills the price field (per §2b). Uses the Fyers quotes
// action (NOT endpoint — see CONTEXT.md app.html note).
async function autoManualFetchLivePrice(rowId) {
    var row = autoManualRow(rowId); if (!row) return;
    var fy = autoManualFyersSymbol(row); if (!fy) return;
    var priceInput = document.querySelector('.atm-price[data-rid="' + rowId + '"]');
    try {
        var data = await window.fyersCall({ action: 'quotes', symbols: [fy] });
        var lp = 0;
        if (data && data.d && data.d[0] && data.d[0].v && data.d[0].v.lp > 0) lp = data.d[0].v.lp;
        if (lp > 0) { row.price = lp; if (priceInput) { priceInput.dataset.rawValue = lp; priceInput.value = atmFmtPrice(lp); } }
    } catch (e) { /* leave price blank; user can type */ }
}

function autoManualRecalc(rowId) {
    // Lots<->qty is handled inline in the input handlers; holdings + tags are
    // network-loaded on symbol/trader select (not per keystroke), so nothing to
    // do here. Kept as a stable hook the handlers call.
}

var _atmVeinsId = null;
function autoManualVeinsId() {
    if (_atmVeinsId) return _atmVeinsId;
    var v = (_auManualTraders || []).find(function (t) { return (t.short_name || '').toLowerCase() === 'veins'; });
    if (v) _atmVeinsId = v.id;
    return _atmVeinsId;
}
// Resolve Veins' investor id even if the trader dropdown list hasn't loaded yet
// (the "(Same as Veins)" default renders regardless, so the sync lookup can be
// null on a fresh form — which silently blanked the holding + tags).
async function autoManualResolveVeinsId() {
    var id = autoManualVeinsId();
    if (id) return id;
    try {
        var r = await fetch(SUPABASE_URL + '/rest/v1/investors?short_name=eq.Veins&select=id&limit=1', { headers: wmsHeaders() });
        var rows = r.ok ? await r.json() : [];
        if (rows[0] && rows[0].id) _atmVeinsId = rows[0].id;
    } catch (e) { /* leave null */ }
    return _atmVeinsId;
}

// On symbol/trader select, load (a) the current Veins holding for this
// (trader, symbol) as a balance label under Qty, and (b) the tags used on past
// trades of it, auto-populated + editable — mirroring the Add Transaction row.
// Reads the BOOKING book (`transactions`, where manual + KH + nightly fills
// land), NOT `trTransactions` (which isn't loaded on the automation page).
// Async, best-effort — never blocks or affects the order.
async function autoManualShowBalance(rowId) {
    // Gate on the SYMBOL (the match key), not security_id — a contract may be
    // selected without a resolved security_id, but the holding still matches by
    // symbol. (Both balance + tags were blank for MCX:SILVERMIC because the old
    // security_id guard aborted the whole load.)
    var row = autoManualRow(rowId); if (!row || !row.symbol) return;
    var bal = document.getElementById('atmBal_' + rowId);
    var veinsId = await autoManualResolveVeinsId();
    if (!veinsId) { if (bal) bal.textContent = ''; return; }
    var traderId = row.trader_id || veinsId;
    var bareSym = (row.symbol || '').replace(/^[A-Z]+:/, '');
    if (!bareSym) { if (bal) bal.textContent = ''; return; }
    try {
        // The booked symbol can be stored BARE ("SILVERMIC26AUGFUT") while
        // securities_nfo stores it EXCHANGE-PREFIXED ("MCX:SILVERMIC26AUGFUT").
        // Cast a wide net — bare/prefixed symbol, security_id, or underlying —
        // then narrow to the EXACT contract in JS. Prefix-proof.
        var norm = function (s) { return (s || '').replace(/^[A-Z]+:/, ''); };
        var fyFull = autoManualFyersSymbol(row);
        var conds = ['symbol.eq.' + encodeURIComponent(bareSym), 'symbol.eq.' + encodeURIComponent(fyFull)];
        if (row.security_id) conds.push('security_id.eq.' + encodeURIComponent(row.security_id));
        if (row.short_symbol) conds.push('short_symbol.eq.' + encodeURIComponent(row.short_symbol));
        var url = SUPABASE_URL + '/rest/v1/transactions?investor_id=eq.' + encodeURIComponent(veinsId) +
            '&or=(' + conds.join(',') + ')' +
            '&select=quantity,transaction_type,trader_id,investor_id,symbol,short_symbol,security_id,security_type,exchange,dont_display,ignore_for_avg_cost,tags&limit=2000';
        var r = await fetch(url, { headers: wmsHeaders() });
        var allRows = r.ok ? await r.json() : [];
        if (!Array.isArray(allRows)) allRows = [];
        // Narrow to the exact contract (same normalized symbol, or same security_id).
        var rows = allRows.filter(function (t) { return norm(t.symbol) === bareSym || (row.security_id && t.security_id === row.security_id); });
        // (a) balance: units under Qty, lots under Lots (lots-based rows only)
        var lotsBal = document.getElementById('atmBalLots_' + rowId);
        var forTrader = rows.filter(function (t) { return !t.dont_display && (t.trader_id || t.investor_id) === traderId; });
        var net = (forTrader.length && typeof wmsCalcAvgCost === 'function') ? (wmsCalcAvgCost(forTrader).netQuantity || 0) : 0;
        if (bal) bal.textContent = net ? ('Bal: ' + formatQuantity(net)) : '';
        if (lotsBal) {
            if (net && autoManualIsLotsBased(row) && row.lot_size > 0) {
                var nl = Math.round(net / row.lot_size);
                lotsBal.textContent = 'Bal: ' + nl + ' lot' + (Math.abs(nl) !== 1 ? 's' : '');
            } else { lotsBal.textContent = ''; }
        }
        // (b) auto-populate tags — only when the row has none yet (never clobber
        // what the user typed or a copied row already carries)
        if (row.tags.length === 0 && typeof wmsFindMatchingTags === 'function') {
            var matched = wmsFindMatchingTags(rows, veinsId, traderId, bareSym) || [];
            if (matched.length) {
                matched.forEach(function (t) { if (row.tags.indexOf(t) < 0) row.tags.push(t); });
                if (_atmTagCtrls[rowId] && typeof _atmTagCtrls[rowId].refresh === 'function') _atmTagCtrls[rowId].refresh();
            }
        }
    } catch (e) { if (bal) bal.textContent = ''; }
}

// ---- Bracket SL toggle + panel (§2c: opposite side, same qty, immediate) ----
function autoManualToggleSl(rowId) {
    var row = autoManualRow(rowId); if (!row) return;
    var panel = document.getElementById('atmSlPanel_' + rowId);
    var toggle = document.querySelector('.atm-sl-toggle[data-rid="' + rowId + '"]');
    row.sl.on = !row.sl.on;
    if (row.sl.on) {
        panel.style.display = '';
        toggle.textContent = '− SL';
        panel.innerHTML =
            '<div style="font-size:10px;color:#9a3412;text-transform:uppercase;margin-bottom:4px">Bracket stop-loss (opposite side, same qty)</div>' +
            '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
                '<input type="text" inputmode="decimal" class="wms-input wms-input-compact wms-input-number atm-sl-trigger" data-rid="' + rowId + '" placeholder="Trigger" style="width:80px">' +
                '<input type="text" inputmode="decimal" class="wms-input wms-input-compact wms-input-number atm-sl-limit" data-rid="' + rowId + '" placeholder="Limit" style="width:80px;display:none">' +
                '<div class="atm-radios" style="margin-top:0">' +
                    '<label><input type="radio" name="atmSlOt_' + rowId + '" class="atm-sl-ot" data-rid="' + rowId + '" value="SL-MARKET" checked>Mkt</label>' +
                    '<label><input type="radio" name="atmSlOt_' + rowId + '" class="atm-sl-ot" data-rid="' + rowId + '" value="SL-LIMIT">Lmt</label>' +
                '</div>' +
            '</div>';
        var trig = panel.querySelector('.atm-sl-trigger'), lim = panel.querySelector('.atm-sl-limit');
        trig.addEventListener('blur', function () { var v = atmEvalNum(trig.value); row.sl.stopPrice = isNaN(v) ? 0 : v; trig.value = row.sl.stopPrice ? atmFmtPrice(row.sl.stopPrice) : ''; });
        trig.addEventListener('input', function () { var v = atmEvalNum(trig.value); if (!isNaN(v)) row.sl.stopPrice = v; });
        lim.addEventListener('blur', function () { var v = atmEvalNum(lim.value); row.sl.limitPrice = isNaN(v) ? 0 : v; lim.value = row.sl.limitPrice ? atmFmtPrice(row.sl.limitPrice) : ''; });
        lim.addEventListener('input', function () { var v = atmEvalNum(lim.value); if (!isNaN(v)) row.sl.limitPrice = v; });
        panel.querySelectorAll('.atm-sl-ot[data-rid="' + rowId + '"]').forEach(function (rb) {
            rb.addEventListener('change', function () { if (!rb.checked) return; row.sl.orderType = rb.value; lim.style.display = (rb.value === 'SL-LIMIT') ? '' : 'none'; });
        });
    } else {
        panel.style.display = 'none'; panel.innerHTML = ''; toggle.textContent = '＋ SL';
        row.sl = { on: false, orderType: 'SL-MARKET', stopPrice: 0, limitPrice: 0 };
    }
}

// ---- Review -> Confirm dialog ----------------------------------------------
function autoManualReview() {
    if (!_atmRows.length) { autoManualStatus('Add at least one order.', true); return; }
    var legs = [];
    for (var i = 0; i < _atmRows.length; i++) {
        var row = _atmRows[i], n = i + 1;
        var fy = autoManualFyersSymbol(row);
        if (!row.security_id || !/^[A-Z]+:[A-Z0-9]+(-[A-Z0-9]+)?$/.test(fy)) { autoManualStatus('Order ' + n + ': pick a symbol from the search.', true); return; }
        // Order qty convention (§A.11.5 — the single biggest correctness trap):
        // MCX qty = LOTS (Fyers reports/accepts MCX in lots); NSE F&O + equity
        // qty = UNITS (lots × lot_size). The fill-writer books on this same basis,
        // so the two must agree. row.quantity holds units; row.lots holds lots.
        // Key off the EXACT symbol we send the broker (not row.exchange), so the
        // qty convention can never desync from the symbol prefix.
        var isMcx = (fy.split(':')[0] === 'MCX');
        var orderQty = isMcx ? row.lots : row.quantity;
        var unitName = isMcx ? 'lots' : 'qty';
        if (!Number.isFinite(orderQty) || orderQty === 0 || Math.floor(orderQty) !== orderQty) { autoManualStatus('Order ' + n + ': ' + unitName + ' must be a non-zero integer (+ buy / − sell).', true); return; }
        var side = orderQty > 0 ? 'BUY' : 'SELL', absQty = Math.abs(orderQty);
        var ot = row.orderType;
        if (ot === 'LIMIT' && !(row.price > 0)) { autoManualStatus('Order ' + n + ': LIMIT needs a positive price.', true); return; }
        var intent = { symbol: fy, side: side, qty: absQty, orderType: ot };
        if (ot === 'LIMIT') intent.limitPrice = row.price;
        // Bracket SL
        if (row.sl && row.sl.on) {
            if (!(row.sl.stopPrice > 0)) { autoManualStatus('Order ' + n + ': SL needs a positive trigger.', true); return; }
            if (row.sl.orderType === 'SL-LIMIT' && !(row.sl.limitPrice > 0)) { autoManualStatus('Order ' + n + ': SL-Limit needs a positive limit.', true); return; }
            intent.sl = { orderType: row.sl.orderType, stopPrice: row.sl.stopPrice };
            if (row.sl.orderType === 'SL-LIMIT') intent.sl.limitPrice = row.sl.limitPrice;
        }
        // Tags + trader
        var tags = (_atmTagCtrls[row.rowId] && typeof _atmTagCtrls[row.rowId].getTags === 'function') ? _atmTagCtrls[row.rowId].getTags() : (row.tags || []);
        if (tags && tags.length) intent.tags = tags;
        if (row.trader_id) intent.trader_id = row.trader_id;
        var traderSel = document.querySelector('.atm-trader[data-rid="' + row.rowId + '"]');
        var traderName = (row.trader_id && traderSel && traderSel.selectedOptions[0]) ? traderSel.selectedOptions[0].text : '';
        var priceStr = (ot === 'LIMIT') ? ('@ ' + row.price) : '@ market';
        var slStr = (row.sl && row.sl.on) ? ('  + SL ' + row.sl.orderType + ' trig ' + row.sl.stopPrice + (row.sl.orderType === 'SL-LIMIT' ? '/lim ' + row.sl.limitPrice : '')) : '';
        var extra = (tags && tags.length ? '  tags:' + tags.join('/') : '') + (traderName ? '  trader:' + traderName : '');
        var label = side + ' ' + absQty + (isMcx ? ' lot' + (absQty > 1 ? 's' : '') : 'u') + '  ' + fy + '  [' + ot + ']  ' + priceStr + slStr + extra;
        legs.push({ label: label, intent: intent });
    }
    _auManualLegsToPlace = legs;
    var el = document.getElementById('au-manual-status');
    el.innerHTML =
        '<div style="border:2px solid #f59e0b;border-radius:10px;padding:16px;background:#fffbeb">' +
        '<div style="font-size:13px;color:#92400e;margin-bottom:8px">Confirm ' + legs.length + ' <b>LIVE</b> order(s) — each is a separate Fyers order (an SL is placed with, and linked to, its entry):</div>' +
        legs.map(function (l) { return '<div style="font-family:monospace;font-size:13px;font-weight:600;margin:3px 0">' + autoEsc(l.label) + '</div>'; }).join('') +
        '<div style="margin-top:14px"><button class="wms-btn wms-btn-primary" style="background:#dc2626" onclick="autoManualPlaceAll()">Confirm &amp; Place ' + legs.length + ' order(s)</button> ' +
        '<button class="wms-btn wms-btn-secondary" onclick="autoManualStatus(\'\',false)">Cancel</button></div>' +
        '</div>';
}

async function autoManualPlaceAll() {
    var legs = _auManualLegsToPlace;
    if (!legs || !legs.length) return;
    if (!_auManualPw) { autoManualLock(); return; }
    autoManualStatus('Placing ' + legs.length + ' order(s)…', false);
    var results = [];
    for (var k = 0; k < legs.length; k++) {
        try {
            var body = Object.assign({}, legs[k].intent, { password: _auManualPw, confirm: true });
            var resp = await fetch(SUPABASE_URL + '/functions/v1/wms-manual-order', {
                method: 'POST', headers: wmsEdgeHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body)
            });
            var j = await resp.json().catch(function () { return {}; });
            if (resp.status === 401) { _auManualPw = null; autoManualRenderGate((j.error || 'Unauthorized') + ' — re-enter password.'); return; }
            results.push({ label: legs[k].label, ok: !!(resp.ok && j.ok), command_id: j.command_id || null, sl_command_id: j.sl_command_id || null, error: (resp.ok && j.ok) ? null : (j.error || ('HTTP ' + resp.status)) });
        } catch (e) {
            results.push({ label: legs[k].label, ok: false, command_id: null, sl_command_id: null, error: (e && e.message ? e.message : String(e)) });
        }
    }
    _auManualLegsToPlace = null;
    var ids = [];
    results.forEach(function (r) { if (r.command_id) ids.push(r.command_id); if (r.sl_command_id) ids.push(r.sl_command_id); });
    var el = document.getElementById('au-manual-status');
    if (el) {
        el.innerHTML = '<div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px;background:#fff">' +
            '<div style="font-weight:600;margin-bottom:8px">Placed ' + results.filter(function (r) { return r.ok; }).length + '/' + results.length + ' order(s)</div>' +
            results.map(function (r) {
                var slNote = r.sl_command_id ? '  (+SL ' + r.sl_command_id + ' <button class="wms-btn wms-btn-secondary" style="font-size:10px;padding:1px 6px" onclick="autoManualCancelSl(\'' + r.sl_command_id + '\',this)">Cancel SL</button>)' : '';
                return '<div style="font-family:monospace;font-size:12px;margin:2px 0;color:' + (r.ok ? '#166534' : '#991b1b') + '">' +
                    (r.ok ? '✅' : '✗') + ' ' + autoEsc(r.label) + (r.ok ? '  → cmd ' + r.command_id + slNote : '  → ' + autoEsc(r.error || '')) + '</div>';
            }).join('') +
            '<div id="au-m-track" style="margin-top:10px;font-size:12px;color:#374151"></div></div>';
    }
    if (ids.length) autoManualTrackMany(ids);
}

// Cancel a working bracket SL — via the EF (never a direct queue write). The EF
// enqueues a KH-style cancel; the Droplet cancels at Fyers and cmd-complete flips
// the SL row to CANCELLED.
async function autoManualCancelSl(slCommandId, btn) {
    if (!_auManualPw) { autoManualLock(); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }
    try {
        var resp = await fetch(SUPABASE_URL + '/functions/v1/wms-manual-order', {
            method: 'POST', headers: wmsEdgeHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ action: 'cancel_sl', sl_command_id: slCommandId, password: _auManualPw, confirm: true })
        });
        var j = await resp.json().catch(function () { return {}; });
        if (resp.status === 401) { _auManualPw = null; autoManualRenderGate((j.error || 'Unauthorized') + ' — re-enter password.'); return; }
        if (btn) { btn.textContent = (resp.ok && j.ok) ? 'SL cancel queued' : ('Cancel failed: ' + (j.error || resp.status)); }
    } catch (e) { if (btn) { btn.disabled = false; btn.textContent = 'Cancel SL'; } }
}

function autoManualTrackMany(ids) {
    if (_auManualPollTimer) clearInterval(_auManualPollTimer);
    var tries = 0;
    _auManualPollTimer = setInterval(async function () {
        tries++;
        try {
            var r = await fetch(SUPABASE_URL + '/rest/v1/wms_live_commands?id=in.(' + ids.map(encodeURIComponent).join(',') +
                ')&select=id,status,broker_status,broker_order_id,filled_qty,avg_fill_price,error_message,payload', { headers: wmsHeaders() });
            var rowsx = r.ok ? await r.json() : [];
            var box = document.getElementById('au-m-track');
            if (box && Array.isArray(rowsx)) {
                box.innerHTML = rowsx.map(function (c) {
                    var role = (c.payload && c.payload._manual_meta && c.payload._manual_meta.leg_role) ? c.payload._manual_meta.leg_role : '';
                    return '<div style="font-family:monospace">' + (role ? '[' + role + '] ' : '') + autoEsc(c.broker_status || c.status || '—') +
                        (c.broker_order_id ? ' · ' + c.broker_order_id : '') +
                        (c.filled_qty ? ' · filled ' + c.filled_qty + ' @ ' + c.avg_fill_price : '') +
                        (c.error_message ? ' · ' + autoEsc(c.error_message) : '') + '</div>';
                }).join('');
                var done = rowsx.length >= ids.length && rowsx.every(function (c) {
                    return ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'].indexOf(c.broker_status) >= 0 || ['rejected', 'error', 'cancelled'].indexOf(c.status) >= 0;
                });
                if (done) { clearInterval(_auManualPollTimer); _auManualPollTimer = null; }
            }
        } catch (e) { /* keep polling */ }
        if (tries > 40) { clearInterval(_auManualPollTimer); _auManualPollTimer = null; }
    }, 3000);
}

function autoManualStatus(msg, isErr) {
    var el = document.getElementById('au-manual-status');
    if (!el) return;
    if (!msg) { el.innerHTML = ''; return; }
    el.innerHTML = '<div style="border:1px solid ' + (isErr ? '#fca5a5' : '#e5e7eb') + ';border-radius:8px;padding:10px 12px;font-size:13px;color:' + (isErr ? '#991b1b' : '#374151') + ';background:' + (isErr ? '#fef2f2' : '#f9fafb') + '">' + autoEsc(msg) + '</div>';
}

// ----------------------------------------------------------------------------
// Multi-target render helpers (Phase E de-mirroring, 2026-07-10)
//
// Phases A–D let the family pages share the Legacy renderers by DOM-MIRRORING:
// the Legacy renderer wrote into the Legacy element and a MutationObserver
// copied the HTML across. That made every family page structurally dependent on
// Legacy markup existing — deleting Legacy blanked them (AUTOMATION-LESSONS F.9).
//
// Replacement: the renderer writes to EVERY target present in the DOM. These two
// helpers return a thin proxy over the element list exposing only the surface the
// renderers actually use. Writes fan out to all targets; reads come from the
// first PRESENT target (family page is listed first, so it wins).
//
// Consequence: deleting the Legacy markup in Phase E.3 requires ZERO renderer
// changes — the missing id simply drops out of the list and the proxy narrows to
// one element. Per LESSONS §B.4.9 the fix lives at the single layer every
// consumer already passes through, not at each call site.
//
// Returns null when no target is present — every caller already guards on that.
// ----------------------------------------------------------------------------

function autoTarget(ids) {
    var els = ids.map(function (id) { return document.getElementById(id); }).filter(Boolean);
    if (els.length === 0) return null;
    return {
        set innerHTML(html) { els.forEach(function (e) { e.innerHTML = html; }); },
        get innerHTML() { return els[0].innerHTML; },
        get firstElementChild() { return els[0].firstElementChild; },
        querySelector: function (sel) { return els[0].querySelector(sel); },
        // Response panels toggle display:block when shown — fan that out too.
        style: {
            set display(v) { els.forEach(function (e) { e.style.display = v; }); },
            get display() { return els[0].style.display; }
        }
    };
}

// Count / status pills: className + textContent only.
function autoBadgeTarget(ids) {
    var els = ids.map(function (id) { return document.getElementById(id); }).filter(Boolean);
    if (els.length === 0) return null;
    return {
        set className(v) { els.forEach(function (e) { e.className = v; }); },
        get className() { return els[0].className; },
        set textContent(v) { els.forEach(function (e) { e.textContent = v; }); },
        get textContent() { return els[0].textContent; }
    };
}

// ----------------------------------------------------------------------------
// GS closed-trades source filter (chassis / tv_webhook / all). Held in a module
// variable so the peak exposure + margin metrics recompute against the same scope
// as the table. Read by autoLoadGsClosedTrades via _srcFilter. (Pre-E.3 this also
// kept a second, Legacy-side dropdown in sync.)
// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
// GS closed-trades filters + sort — PER PAGE (Live / Paper split, 2026-07-23).
// Each page owns an independent filter object so the two pages never cross-drive
// each other's re-renders. All applied client-side over the already-fetched rows.
//   instr   : all | gold | silver           (radio)
//   result  : all | win  | loss             (radio)
//   versions: [] = all, else tokens to keep  (checkbox, multi-select)
//   exits   : [] = all, else event_types     (checkbox, multi-select)
//   source  : all | chassis | tv_webhook     (radio)
//   sort    : {key,dir} — click a header to toggle (entry|exit|contract|qty|pnl)
// Persisted to localStorage under a per-mode key so selections survive a reload.
// ----------------------------------------------------------------------------
function _auGsBlankFilters() {
    return { instr: 'all', result: 'all', versions: [], exits: [], source: 'all', trader: 'all', sort: { key: 'exit', dir: 'desc' } };
}
var _auGsFilters = { live: _auGsBlankFilters(), paper: _auGsBlankFilters() };
function _auGsFiltersKey(mode) { return 'wms.gsFilters.' + String(mode).toUpperCase() + '.v1'; }
function _auGsFiltersSave(mode) {
    try { localStorage.setItem(_auGsFiltersKey(mode), JSON.stringify(_auGsFilters[mode])); }
    catch (e) { /* private mode / storage disabled — filters just won't persist */ }
}
function _auGsFiltersRestore(mode) {
    try {
        var s = JSON.parse(localStorage.getItem(_auGsFiltersKey(mode)) || '{}');
        var f = _auGsFilters[mode];
        if (s.instr)  f.instr  = s.instr;
        if (s.result) f.result = s.result;
        if (Array.isArray(s.versions)) f.versions = s.versions;
        if (Array.isArray(s.exits))    f.exits    = s.exits;
        if (s.source) f.source = s.source;
        if (s.trader) f.trader = s.trader;
        if (s.sort && s.sort.key) f.sort = s.sort;
    } catch (e) { /* ignore malformed */ }
}
_auGsFiltersRestore('live');
_auGsFiltersRestore('paper');   // hydrate both pages from last session on load

function autoGsSetClosedSourceFilter(mode, value) {
    _auGsFilters[mode].source = value || 'all';
    _auGsFiltersSave(mode);
    // Peak recomputes inside autoLoadGsClosedTrades. Re-run + re-render metrics.
    if (typeof autoLoadGsClosedTrades === 'function') autoLoadGsClosedTrades(mode);
}

function autoGsClosedSetFilter(mode, kind, value) {
    if (kind === 'instr')       _auGsFilters[mode].instr = value;
    else if (kind === 'result') _auGsFilters[mode].result = value;
    else if (kind === 'trader') _auGsFilters[mode].trader = value;
    _auGsFiltersSave(mode);
    if (typeof autoLoadGsClosedTrades === 'function') autoLoadGsClosedTrades(mode);
}

function autoGsClosedToggleVersion(mode, token, on) {
    var arr = _auGsFilters[mode].versions, i = arr.indexOf(token);
    if (on && i < 0) arr.push(token);
    else if (!on && i >= 0) arr.splice(i, 1);
    _auGsFiltersSave(mode);
    if (typeof autoLoadGsClosedTrades === 'function') autoLoadGsClosedTrades(mode);
}

function autoGsClosedToggleExit(mode, evt, on) {
    var arr = _auGsFilters[mode].exits, i = arr.indexOf(evt);
    if (on && i < 0) arr.push(evt);
    else if (!on && i >= 0) arr.splice(i, 1);
    _auGsFiltersSave(mode);
    if (typeof autoLoadGsClosedTrades === 'function') autoLoadGsClosedTrades(mode);
}

function autoGsClosedSort(mode, key) {
    var srt = _auGsFilters[mode].sort;
    if (srt.key === key) {
        srt.dir = srt.dir === 'asc' ? 'desc' : 'asc';
    } else {
        srt.key = key;
        srt.dir = (key === 'contract') ? 'asc' : 'desc';   // dates/pnl newest/biggest first; contract A→Z
    }
    _auGsFiltersSave(mode);
    if (typeof autoLoadGsClosedTrades === 'function') autoLoadGsClosedTrades(mode);
}

// Normalizes an exit signal to a canonical reason category. event_type is coarse
// (STOP_HIT / TARGET_HIT / MANUAL_EXIT); the specific reason lives in
// metadata.exit_reason (Trail-Stop, SL-Long/Short, EMA-Exit). This maps both to
// one of: STOP (hard SL) · TRAIL (trailing SL) · EMA · TARGET · MANUAL · TIME.
function _auGsExitCategory(exit) {
    if (!exit) return '';
    var et = exit.event_type || '';
    var r = (exit.metadata && exit.metadata.exit_reason) ? String(exit.metadata.exit_reason) : '';
    if (et === 'MANUAL_EXIT') return 'MANUAL';
    if (et === 'TIME_STOP')   return 'TIME';
    if (/trail/i.test(r))     return 'TRAIL';
    if (/ema/i.test(r))       return 'EMA';
    if (et === 'STOP_HIT')    return 'STOP';    // SL-Long / SL-Short / unlabelled hard stop
    if (et === 'TARGET_HIT')  return 'TARGET';  // profitable exit, non-trail/non-EMA
    return et;
}
function _auGsExitLabel(cat) {
    return ({ STOP: 'Hard SL', TRAIL: 'Trail SL', EMA: 'EMA exit', TARGET: 'Target', MANUAL: 'Manual', TIME: 'Time stop' })[cat] || cat || '—';
}
function _auGsExitColor(cat) {
    return ({ STOP: '#dc2626', TRAIL: '#0891b2', EMA: '#7c3aed', TARGET: '#047857', MANUAL: '#92400e', TIME: '#b45309' })[cat] || '#6b7280';
}

// Renders a clickable, sortable <th> with an active-column direction arrow.
function _gsClosedTh(mode, label, key, align, sub) {
    var srt = _auGsFilters[mode].sort;
    var arrow = srt.key === key ? (srt.dir === 'asc' ? ' ▲' : ' ▼') : '';
    var alignStyle = align === 'right' ? 'text-align:right' : 'text-align:left';
    return '<th onclick="autoGsClosedSort(\'' + mode + '\',\'' + key + '\')" title="Sort by ' + label.replace(/&amp;/g, '&') + '"' +
           ' style="padding:6px 8px;' + alignStyle + ';cursor:pointer;user-select:none;white-space:nowrap">' +
           label + arrow +
           (sub ? '<br><span style="font-weight:400;color:#6b7280;font-size:10px">' + sub + '</span>' : '') +
           '</th>';
}

// ----------------------------------------------------------------------------
// GS family page (Phase B — 2026-07-09; de-mirrored Phase E.1a — 2026-07-10)
//
// The Open Trades + Closed Trades renderers (autoLoadGsOpenTrades /
// autoLoadGsClosedTrades) write DIRECTLY into this page's targets via
// autoTarget() / autoBadgeTarget(), which fan the same HTML out to the Legacy
// elements too while they still exist. No MutationObserver, no mirror setup —
// this page stands alone once Phase E.3 removes the Legacy markup.
// ----------------------------------------------------------------------------

function autoLoadGsFamRefresh() {
    // Live / Paper split (2026-07-23): drop the strategy-mode cache so a config
    // change (paper→live etc.) reflects on the next full refresh, then rebuild
    // both page shells and render each page's open + closed blocks independently.
    window._auStrategyModes = null;
    autoGsRenderPageShell('live');
    autoGsRenderPageShell('paper');
    if (typeof autoLoadGsOpenTrades === 'function')   { autoLoadGsOpenTrades('live');   autoLoadGsOpenTrades('paper'); }
    if (typeof autoLoadGsClosedTrades === 'function') { autoLoadGsClosedTrades('live'); autoLoadGsClosedTrades('paper'); }
    // Header metadata + Phase B.2 tabs
    autoLoadGsFamHeader();
    autoLoadGsFamEvents();
    autoLoadGsFamRuns();
    autoLoadGsFamAdmin();
}

// ── GS strategy execution-mode classifier (Live / Paper split, 2026-07-23) ──
// Map<strategy_name, 'LIVE'|'PAPER'> from auto_strategies. The Live page shows
// trades whose strategy is LIVE (the *_live clones); the Paper page shows PAPER
// (v2.2/v2.3/v3 base). A trade whose strategy is unknown → treated as PAPER
// (legacy TV-webhook rows). Cached on window; cleared by autoLoadGsFamRefresh.
async function autoGetStrategyModes() {
    if (window._auStrategyModes instanceof Map && window._auStrategyModes.size) return window._auStrategyModes;
    var map = new Map();
    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?select=name,execution_mode', { headers: wmsHeaders() });
        if (resp.ok) {
            (await resp.json() || []).forEach(function (r) { map.set(r.name, r.execution_mode); });
            window._auStrategyModes = map;
        }
    } catch (e) {
        // Do NOT cache a failure — an empty map would send every trade to Paper.
        console.error('[autoGetStrategyModes] failed:', e);
    }
    return map;
}
/** 'live' | 'paper' for a strategy name (unknown → 'paper'). */
function autoGsModeOf(modeMap, name) { return modeMap.get(name) === 'LIVE' ? 'live' : 'paper'; }

// Fetch real broker fills for a set of broker_order_ids → Map<id,{price,qty}>.
// Read-only, fail-soft (any error → empty map so the page falls back to modelled).
// transactions.quantity is already qty_lots × point_value (the traded "units").
// Reads the app-wide SHARED transaction cache (window._wmsTxnCache.rows, kept current by
// wmsLoadTransactions — the single entry point every module uses) rather than issuing its own
// transactions fetch. One source of truth ⇒ the GS Live P&L can never drift from what the
// Trading table shows, and there's no second query that can lag or miss rows. (2026-07-24 —
// replaced a standalone broker_trade_id fetch that returned stale/empty in some sessions.)
async function autoGsSharedTxnRows() {
    if (typeof wmsLoadTransactions === 'function') { try { return await wmsLoadTransactions() || []; } catch (_e) {} }
    return (window._wmsTxnCache && Array.isArray(window._wmsTxnCache.rows)) ? window._wmsTxnCache.rows : null;
}

async function autoGsFetchFillMap(brokerOrderIds) {
    var out = new Map();
    var ids = new Set((brokerOrderIds || []).filter(Boolean).map(String));
    if (!ids.size) return out;
    try {
        var rows = await autoGsSharedTxnRows();
        if (!rows) return out;   // no shared cache yet → fail-soft to ~modelled
        for (var i = 0; i < rows.length; i++) {
            var t = rows[i];
            var bid = (t && t.broker_trade_id != null) ? String(t.broker_trade_id) : null;
            if (bid && ids.has(bid)) out.set(bid, { price: Number(t.price), qty: Math.abs(Number(t.quantity)) });
        }
    } catch (e) { console.warn('[autoGsFetchFillMap] fail-soft:', e); }
    return out;
}

// LIVE-page fill-awareness (owner decision 2026-07-24). The dashboard's open/closed
// state comes from v_auto_open_trades, which is derived ONLY from engine signals
// (auto_signals legs) — so a live trade keeps showing "open" until the engine fires
// its bar-close CLOSE signal, which can lag the broker's intrabar SL fill by several
// candles (23-Jul: broker covered 21:09, engine booked 22:00). The broker's real fills
// ARE already in `transactions` by then. This returns the broker's true net signed
// position per core symbol (atGS-tagged) so the Live page can drop engine-open trades
// the broker has already closed. Closed round-trips net to zero, so the running sum ==
// the current open lot. Fail-soft: on any error return null → caller keeps engine truth
// (never hide a position because a query failed). PAPER is untouched (no broker fills).
async function autoGsFetchNetBySymbol(coreSymbols) {
    var syms = new Set((coreSymbols || []).filter(Boolean).map(String));
    if (!syms.size) return new Map();
    try {
        var rows = await autoGsSharedTxnRows();
        if (!rows) return null;   // no shared cache → fail-soft, caller keeps engine truth
        var net = new Map();
        for (var i = 0; i < rows.length; i++) {
            var t = rows[i];
            if (!t || !Array.isArray(t.tags) || t.tags.indexOf('atGS') < 0) continue;
            var k = String(t.symbol);
            if (!syms.has(k)) continue;
            net.set(k, (net.get(k) || 0) + Number(t.quantity || 0));
        }
        return net;
    } catch (e) { console.warn('[autoGsFetchNetBySymbol] fail-soft:', e); return null; }
}

// Build the 5 summary-card tiles for a page (ids namespaced by mode).
function autoGsCardTiles(mode) {
    var p = 'au-gs-' + mode + '-metric-';
    return '<div class="fam-metric-tile"><div class="metric-label">Open positions</div>' +
             '<div class="metric-value" id="' + p + 'open">—</div><div class="metric-sub" id="' + p + 'open-sub"></div></div>' +
           '<div class="fam-metric-tile"><div class="metric-label">Live P&amp;L (open)</div>' +
             '<div class="metric-value" id="' + p + 'livepnl">—</div><div class="metric-sub" id="' + p + 'livepnl-sub"></div></div>' +
           '<div class="fam-metric-tile"><div class="metric-label">Realised (all-time)</div>' +
             '<div class="metric-value" id="' + p + 'realised">—</div><div class="metric-sub" id="' + p + 'realised-sub"></div></div>' +
           '<div class="fam-metric-tile"><div class="metric-label">Peak exposure</div>' +
             '<div class="metric-value" id="' + p + 'peak">—</div><div class="metric-sub" id="' + p + 'peak-sub"></div></div>' +
           '<div class="fam-metric-tile"><div class="metric-label">Version</div>' +
             '<div class="metric-value" id="' + p + 'version">—</div><div class="metric-sub">from filtered closed trades</div></div>';
}

// Build the closed-trade filter bar for a page. Radios/checkboxes carry per-mode
// names + mode-baked handlers, and reflect the restored filter state via `checked`.
function autoGsFilterBar(mode, f) {
    var lbl = 'font-size:10px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.04em';
    function radio(name, val, cur, handler, text) {
        return '<label class="radio-label" style="font-size:12px"><input type="radio" name="' + name + '" value="' + val + '"' +
               (cur === val ? ' checked' : '') + ' onchange="' + handler + '"> ' + text + '</label>';
    }
    function check(name, val, on, handler, text) {
        return '<label class="radio-label" style="font-size:12px"><input type="checkbox" name="' + name + '" value="' + val + '"' +
               (on ? ' checked' : '') + ' onchange="' + handler + '"> ' + text + '</label>';
    }
    var m = mode, nm = '-' + mode;
    return '<div style="display:flex;align-items:flex-start;gap:22px;flex-wrap:wrap;margin-bottom:10px;padding:10px 12px;background:#fff;border:1px solid #e2e8f0;border-radius:6px">' +
        '<div style="display:flex;flex-direction:column;gap:4px"><span style="' + lbl + '">Instrument</span>' +
            radio('augsc-instr' + nm, 'all',    f.instr,  "autoGsClosedSetFilter('" + m + "','instr','all')",    'All') +
            radio('augsc-instr' + nm, 'gold',   f.instr,  "autoGsClosedSetFilter('" + m + "','instr','gold')",   'Gold') +
            radio('augsc-instr' + nm, 'silver', f.instr,  "autoGsClosedSetFilter('" + m + "','instr','silver')", 'Silver') +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:4px"><span style="' + lbl + '">Result</span>' +
            radio('augsc-result' + nm, 'all',  f.result, "autoGsClosedSetFilter('" + m + "','result','all')",  'All') +
            radio('augsc-result' + nm, 'win',  f.result, "autoGsClosedSetFilter('" + m + "','result','win')",  'Winning') +
            radio('augsc-result' + nm, 'loss', f.result, "autoGsClosedSetFilter('" + m + "','result','loss')", 'Losing') +
        '</div>' +
        (m === 'live' ? '<div style="display:flex;flex-direction:column;gap:4px"><span style="' + lbl + '">Trader</span>' +
            radio('augsc-trader' + nm, 'all',   f.trader, "autoGsClosedSetFilter('" + m + "','trader','all')",   'All') +
            radio('augsc-trader' + nm, 'Veins', f.trader, "autoGsClosedSetFilter('" + m + "','trader','Veins')", 'Veins') +
            radio('augsc-trader' + nm, 'T3a',   f.trader, "autoGsClosedSetFilter('" + m + "','trader','T3a')",   'T3a') +
        '</div>' : '') +
        '<div style="display:flex;flex-direction:column;gap:4px"><span style="' + lbl + '">Exit reason <span style="font-weight:400;color:#9ca3af;text-transform:none">(tick to filter)</span></span>' +
            check('augsc-exit' + nm, 'STOP',   f.exits.indexOf('STOP') >= 0,   "autoGsClosedToggleExit('" + m + "','STOP', this.checked)",   'Hard SL') +
            check('augsc-exit' + nm, 'TRAIL',  f.exits.indexOf('TRAIL') >= 0,  "autoGsClosedToggleExit('" + m + "','TRAIL', this.checked)",  'Trail SL') +
            check('augsc-exit' + nm, 'EMA',    f.exits.indexOf('EMA') >= 0,    "autoGsClosedToggleExit('" + m + "','EMA', this.checked)",    'EMA exit') +
            check('augsc-exit' + nm, 'TARGET', f.exits.indexOf('TARGET') >= 0, "autoGsClosedToggleExit('" + m + "','TARGET', this.checked)", 'Target') +
            check('augsc-exit' + nm, 'MANUAL', f.exits.indexOf('MANUAL') >= 0, "autoGsClosedToggleExit('" + m + "','MANUAL', this.checked)", 'Manual') +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:4px"><span style="' + lbl + '">Version <span style="font-weight:400;color:#9ca3af;text-transform:none">(tick to filter)</span></span>' +
            check('augsc-ver' + nm, 'v2.2', f.versions.indexOf('v2.2') >= 0, "autoGsClosedToggleVersion('" + m + "','v2.2', this.checked)", 'v2.2') +
            check('augsc-ver' + nm, 'v2.3', f.versions.indexOf('v2.3') >= 0, "autoGsClosedToggleVersion('" + m + "','v2.3', this.checked)", 'v2.3') +
            check('augsc-ver' + nm, 'v3',   f.versions.indexOf('v3') >= 0,   "autoGsClosedToggleVersion('" + m + "','v3', this.checked)",   'v3') +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:4px"><span style="' + lbl + '">Source</span>' +
            radio('augsc-source' + nm, 'all',        f.source, "autoGsSetClosedSourceFilter('" + m + "','all')",        'All') +
            radio('augsc-source' + nm, 'chassis',    f.source, "autoGsSetClosedSourceFilter('" + m + "','chassis')",    'Automation Runner') +
            radio('augsc-source' + nm, 'tv_webhook', f.source, "autoGsSetClosedSourceFilter('" + m + "','tv_webhook')", 'TV Webhook (legacy)') +
        '</div>' +
        '<div style="font-size:11px;color:#6b7280;max-width:190px;line-height:1.5">Version unticked = all. Click <b>Entry / Exit / Contract / Qty / P&amp;L</b> headers to sort. All cards on this page respect these filters (except Open positions &amp; Live P&amp;L, which always show this page\'s whole open book).</div>' +
    '</div>';
}

// Build a page's self-contained shell ONCE: card strip + filter bar + collapsible
// Open/Closed blocks. Guarded by dataset.built so re-renders don't reset filters.
function autoGsRenderPageShell(mode) {
    var panel = document.getElementById('au-gs-' + mode + '-panel');
    if (!panel || panel.dataset.built === '1') return;
    var m = mode;
    var note = mode === 'live'
        ? 'LIVE strategies (the <code>*_live</code> clones) · P&amp;L from <b>real broker fills</b> (joined via <code>transactions</code>).'
        : 'PAPER strategies (v2.2 / v2.3 / v3) · P&amp;L from <b>modelled signal prices</b>.';
    panel.innerHTML =
        '<div class="au-gs-page-note">' + note + '</div>' +
        '<div class="fam-metrics">' + autoGsCardTiles(mode) + '</div>' +
        autoGsFilterBar(mode, _auGsFilters[mode]) +
        '<details id="au-gs-' + m + '-open-block" class="au-gs-block" open>' +
            '<summary class="au-gs-block-summary">Open trades ' +
                '<span id="au-gs-' + m + '-open-badge" class="au-badge idle">…</span>' +
                '<span id="au-gs-' + m + '-open-summary" class="au-gs-block-sum"></span></summary>' +
            '<div id="au-gs-' + m + '-open-content" class="au-meta">Loading…</div>' +
        '</details>' +
        '<details id="au-gs-' + m + '-closed-block" class="au-gs-block">' +
            '<summary class="au-gs-block-summary">Closed trades ' +
                '<span id="au-gs-' + m + '-closed-badge" class="au-badge idle">…</span>' +
                '<span id="au-gs-' + m + '-closed-summary" class="au-gs-block-sum"></span></summary>' +
            '<div id="au-gs-' + m + '-closed-content" class="au-meta">Loading…</div>' +
        '</details>';
    panel.dataset.built = '1';
}

// ----------------------------------------------------------------------------
// GS Signals & Events tab (Phase B.2) — auto_signals scoped to GS strategies
// ----------------------------------------------------------------------------
// ── GS family membership — ONE source of truth ──────────────────────────────
// Base plugin names. Config variants carry a suffix (gold_mini_15m_v3), so name
// matching is by STEM, never by exact list. Adding an instrument to the family
// means editing the two arrays below and nothing else.
//
// Before 2026-07-21 this list was duplicated in SIX places (events tab, run
// history, admin last-run, family header ×2, health-page matcher). Worse, three
// of them used `name=in.(silver_mini_15m,gold_mini_15m)`, which silently
// EXCLUDED variant rows — so gold_mini_15m_v3 runs never appeared in Run
// History. Consolidated to a stem match, which fixes that.
//
// CoinDCX is deliberately NOT here: it has its own cdx_* tables, its own runner
// and its own family tab, because the app is INR-denominated end to end and
// mixing a USDT venue into these shared views is the quagmire we chose to
// avoid. See automation/CDX-PLAN.md.
var _AU_GS_STRATS = ['silver_mini_15m', 'gold_mini_15m'];
var _AU_GS_STEMS  = ['_mini_15m'];   // MCX minis. CoinDCX lives in its own cdx_* stack.

/** Does this strategy_name belong to the GS family (base row or any variant)? */
function auGsIsFamilyName(n) {
    if (!n) return false;
    for (var i = 0; i < _AU_GS_STEMS.length; i++) {
        if (n.indexOf(_AU_GS_STEMS[i]) !== -1) return true;
    }
    return false;
}

/** PostgREST `or=(…)` matching every family stem, variants included.
 *  Used instead of `name=in.(…)`, which silently omits variant rows. */
function auGsNameFilter(col) {
    col = col || 'strategy_name';
    var parts = _AU_GS_STEMS.map(function (s) { return col + '.like.*' + s + '*'; });
    return 'or=(' + parts.join(',') + ')';
}

async function autoLoadGsFamEvents(filterOverride) {
    var el = document.getElementById('au-gs-fam-events-content');
    var statusEl = document.getElementById('au-gs-fam-events-status');
    if (!el) return;
    var typeSel = document.getElementById('au-gs-fam-events-filter');
    var stratSel = document.getElementById('au-gs-fam-events-strat');
    var typeFilter = filterOverride && typeof filterOverride === 'string' && filterOverride !== '[object Event]'
        ? filterOverride
        : (typeSel ? typeSel.value : 'all');
    if (typeSel && typeFilter !== typeSel.value) typeSel.value = typeFilter;
    var stratFilter = stratSel ? stratSel.value : 'all';
    var verSel = document.getElementById('au-gs-fam-events-ver');
    var verFilter = verSel ? verSel.value : 'all';

    if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }

    // LIKE-pattern (not a fixed IN-list) so parallel config variants that share a
    // plugin — e.g. silver_mini_15m_v3, gold_mini_15m_v23 — are included alongside
    // the base v2.2 rows. 'all' uses auGsNameFilter(), which covers every family
    // stem — see _AU_GS_STEMS.
    var qs = stratFilter === 'all'
        ? '?' + auGsNameFilter()
        : '?strategy_name=like.' + encodeURIComponent(stratFilter + '*');
    qs += '&order=fired_at.desc&limit=200' +
             '&select=id,trade_id,strategy_name,fired_at,event_type,direction,legs,metadata,source,email_status';
    if (typeFilter === 'ENTRY')      qs += '&event_type=eq.ENTRY';
    else if (typeFilter === 'EXIT')  qs += '&event_type=neq.ENTRY';
    // Email-delivery failures are a Resend concern, not a strategy concern, but the
    // only global surface for them (Legacy's "Email Failed" chip) went away with the
    // Legacy Events tab. Each family page carries the filter now. (Phase E.2b)
    else if (typeFilter === 'email-failed') qs += '&email_status=eq.FAILED';

    try {
        var r = await fetch(SUPABASE_URL + '/rest/v1/auto_signals' + qs, { headers: wmsHeaders() });
        var rows = r.ok ? await r.json() : [];
        // Version filter applied client-side: version lives in metadata (key is
        // strategy_version, older rows used version), so a jsonb server filter would
        // miss the fallback key. The list is capped at 200, so this is cheap.
        if (verFilter !== 'all' && Array.isArray(rows)) {
            rows = rows.filter(function (s) {
                var m = s.metadata || {};
                return (m.strategy_version || m.version) === verFilter;
            });
        }
        if (!Array.isArray(rows) || rows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No events match this filter.</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 events'; }
            return;
        }

        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left;position:sticky;top:0;z-index:1">' +
                '<th style="padding:6px 8px;white-space:nowrap">Time (IST)</th>' +
                '<th style="padding:6px 8px">Strategy</th>' +
                '<th style="padding:6px 8px">Event</th>' +
                '<th style="padding:6px 8px">Side</th>' +
                '<th style="padding:6px 8px">Contract</th>' +
                '<th style="padding:6px 8px;text-align:right">Qty</th>' +
                '<th style="padding:6px 8px;text-align:right">Price</th>' +
                '<th style="padding:6px 8px">Source</th>' +
                '<th style="padding:6px 8px">Version</th>' +
                '<th style="padding:6px 8px">Email</th>' +
                '<th style="padding:6px 8px">Trade</th>' +
                '</tr></thead><tbody>';
        rows.forEach(function (s) {
            var m = s.metadata || {};
            var leg = (s.legs && s.legs[0]) || {};
            var typeColor = s.event_type === 'ENTRY' ? '#047857' :
                           /^EXIT_SL|STOP_HIT/.test(s.event_type) ? '#dc2626' :
                           /^EXIT/.test(s.event_type) ? '#0891b2' :
                           /MANUAL/.test(s.event_type) ? '#92400e' : '#6b7280';
            var side = s.direction || (leg.side === 'BUY' ? 'LONG' : leg.side === 'SELL' ? 'SHORT' : '—');
            var contract = leg.symbol ? autoFmtContract(leg.symbol, leg.expiry_date) : '—';
            var qty = m.qty_lots != null ? m.qty_lots + ' lot' + (m.qty_lots == 1 ? '' : 's') : (leg.qty || '—');
            var price = leg.price != null ? autoFmtPrice0(Number(leg.price)) : '—';
            var srcBadge = s.source === 'chassis' ? '<span class="au-badge success" style="font-size:9px">runner</span>'
                        : s.source === 'tv_webhook' ? '<span class="au-badge idle" style="font-size:9px">TV webhook</span>'
                        : '<span style="color:#9ca3af">' + autoEsc(s.source || '—') + '</span>';
            var ver = (m.strategy_version || m.version || '—');
            var emailBadge = s.email_status === 'SENT' ? '<span class="au-badge success" style="font-size:9px">sent</span>'
                          : s.email_status === 'FAILED' ? '<span class="au-badge error" style="font-size:9px">failed</span>'
                          : s.email_status === 'PENDING' ? '<span class="au-badge loading" style="font-size:9px">pending</span>'
                          : '<span class="au-badge idle" style="font-size:9px">—</span>';
            var tradeFrag = s.trade_id ? s.trade_id.slice(0, 20) : '—';
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px;white-space:nowrap;font-family:monospace;font-size:11px">' + autoEsc(autoFmtIST(s.fired_at)) + '</td>' +
                    '<td style="padding:6px 8px"><code style="font-size:11px">' + autoEsc(s.strategy_name.replace('_mini_15m', '')) + '</code></td>' +
                    '<td style="padding:6px 8px;color:' + typeColor + ';font-weight:600">' + autoEsc(s.event_type) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(side) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(contract) + '</td>' +
                    '<td style="padding:6px 8px;text-align:right">' + autoEsc(String(qty)) + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums">' + price + '</td>' +
                    '<td style="padding:6px 8px">' + srcBadge + '</td>' +
                    '<td style="padding:6px 8px;font-family:monospace;font-size:10px;color:#6b7280">' + autoEsc(ver) + '</td>' +
                    '<td style="padding:6px 8px">' + emailBadge + '</td>' +
                    '<td style="padding:6px 8px;font-family:monospace;font-size:10px;color:#6b7280" title="' + autoEsc(s.trade_id || '') + '">' + autoEsc(tradeFrag) + '</td>' +
                    '</tr>';
        });
        html += '</tbody></table></div>';
        el.innerHTML = html;
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = rows.length + ' events'; }
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
    }
}

// ----------------------------------------------------------------------------
// GS Run History tab (Phase B.2) — auto_runs scoped to GS strategies
// ----------------------------------------------------------------------------
async function autoLoadGsFamRuns(filterOverride) {
    var el = document.getElementById('au-gs-fam-runs-content');
    var statusEl = document.getElementById('au-gs-fam-runs-status');
    if (!el) return;
    var sel = document.getElementById('au-gs-fam-runs-filter');
    var filter = filterOverride && typeof filterOverride === 'string' && filterOverride !== '[object Event]'
        ? filterOverride
        : (sel ? sel.value : 'all');
    if (sel && filter !== sel.value) sel.value = filter;

    if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }

    var qs = '?' + auGsNameFilter() +
             '&order=started_at.desc&limit=100' +
             '&select=id,strategy_name,started_at,finished_at,duration_ms,status,signals_generated,emails_sent,emails_failed,error';
    if (filter === 'failed')            qs += '&status=eq.FAILED';
    else if (filter === 'with_signals') qs += '&signals_generated=gt.0';

    try {
        var r = await fetch(SUPABASE_URL + '/rest/v1/auto_runs' + qs, { headers: wmsHeaders() });
        var rows = r.ok ? await r.json() : [];
        if (!Array.isArray(rows) || rows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No runs match this filter.</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 runs'; }
            return;
        }
        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left;position:sticky;top:0;z-index:1">' +
                '<th style="padding:6px 8px">Started (IST)</th>' +
                '<th style="padding:6px 8px">Strategy</th>' +
                '<th style="padding:6px 8px">Status</th>' +
                '<th style="padding:6px 8px;text-align:right">Signals</th>' +
                '<th style="padding:6px 8px">Email</th>' +
                '<th style="padding:6px 8px;text-align:right">Duration</th>' +
                '<th style="padding:6px 8px">Error</th>' +
                '</tr></thead><tbody>';
        rows.forEach(function (rn) {
            var emailCell = '—';
            if (rn.emails_sent || rn.emails_failed) {
                var sent = rn.emails_sent || 0, failed = rn.emails_failed || 0;
                emailCell = (failed > 0 ? '<span style="color:#dc2626">' + failed + ' failed</span>' : '') +
                            (sent > 0 && failed > 0 ? ' / ' : '') +
                            (sent > 0 ? '<span style="color:#047857">' + sent + ' sent</span>' : '');
            }
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px;white-space:nowrap;font-family:monospace;font-size:11px">' + autoEsc(autoFmtIST(rn.started_at)) + '</td>' +
                    '<td style="padding:6px 8px"><code style="font-size:11px">' + autoEsc(rn.strategy_name.replace('_mini_15m', '')) + '</code></td>' +
                    '<td style="padding:6px 8px">' + autoStatusBadge(rn.status) + '</td>' +
                    '<td style="padding:6px 8px;text-align:right">' + (rn.signals_generated != null ? rn.signals_generated : '—') + '</td>' +
                    '<td style="padding:6px 8px;font-size:11px">' + emailCell + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums">' + autoFmtDuration(rn.duration_ms) + '</td>' +
                    '<td style="padding:6px 8px;color:#7f1d1d;font-size:11px;max-width:400px;overflow:hidden;text-overflow:ellipsis" title="' + autoEsc(rn.error || '') + '">' +
                        autoEsc((rn.error || '').slice(0, 100)) + (rn.error && rn.error.length > 100 ? '…' : '') +
                    '</td>' +
                    '</tr>';
        });
        html += '</tbody></table></div>';
        el.innerHTML = html;
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = rows.length + ' runs'; }
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
    }
}

// ----------------------------------------------------------------------------
// GS Controls & Admin tab (Phase B.2 — admin bits only; controls in B.3)
// Renders: strategy config, plugin version, gs_catalogue snapshot.
// ----------------------------------------------------------------------------
// name → display_name (cached), so the dashboard can show friendly labels while the engine keeps
// using the stable internal `name`. Cleared by autoLoadGsFamRefresh alongside the mode cache.
async function autoGetStrategyDisplayNames() {
    if (window._auStrategyDisp instanceof Map && window._auStrategyDisp.size) return window._auStrategyDisp;
    var map = new Map();
    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?select=name,display_name', { headers: wmsHeaders() });
        if (resp.ok) { (await resp.json() || []).forEach(function (r) { if (r.display_name) map.set(r.name, r.display_name); }); window._auStrategyDisp = map; }
    } catch (e) { /* fall back to raw names */ }
    return map;
}
function autoGsDispLabel(dispMap, name) { var d = dispMap && dispMap.get ? dispMap.get(name) : null; return d || name; }

// name → trader_id (cached), mirroring autoGetStrategyDisplayNames. Lets the live open dashboard
// show/filter by trader. A live row's beneficiary trader lives in metadata.trader_id; a row with
// none defaults to Veins (the executor/beneficiary default — see gs_sl_runner resolveVeinsFyersIba).
async function autoGetStrategyTraders() {
    if (window._auStrategyTrader instanceof Map && window._auStrategyTrader.size) return window._auStrategyTrader;
    var map = new Map();
    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?select=name,metadata', { headers: wmsHeaders() });
        if (resp.ok) { (await resp.json() || []).forEach(function (r) { var tid = r.metadata && r.metadata.trader_id; if (tid) map.set(r.name, tid); }); window._auStrategyTrader = map; }
    } catch (e) { /* fall back to default trader */ }
    return map;
}
// Resolve a live strategy's trader display name (short_name), defaulting to Veins.
function autoGsTraderOf(traderMap, name) {
    var tid = traderMap && traderMap.get ? traderMap.get(name) : null;
    return tid ? (_auGsTraderName(tid) || 'Veins') : 'Veins';
}

// Double-click a strategy label → rename its display_name only. The internal `name` (and every
// signal / run / live-command / cron keyed to it) is untouched. Prompt-based (robust against the
// table's 10s auto-refresh, which would interrupt an inline input).
async function autoGsEditDisplayName(elm) {
    var name = elm.getAttribute('data-name'); if (!name) return;
    var cur = elm.getAttribute('data-disp') || (elm.textContent || '').trim();
    var next = window.prompt('Rename display label (internal name "' + name + '" stays unchanged):', cur);
    if (next == null) return; next = next.trim();
    if (!next || next === cur) return;
    try {
        var r = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?name=eq.' + encodeURIComponent(name),
            { method: 'PATCH', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }), body: JSON.stringify({ display_name: next }) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        if (window._auStrategyDisp instanceof Map) window._auStrategyDisp.set(name, next);
        elm.textContent = next; elm.setAttribute('data-disp', next); elm.setAttribute('title', name + ' — double-click to rename');
    } catch (e) { alert('Rename failed: ' + (e.message || e)); }
}

// strategy → current resting-SL (the live trail stop, on the real broker scale). Latest OPEN
// sl/sl_rearm command's stopPrice. Fail-soft → empty map (SL falls back to stop_at_entry).
async function autoGsFetchSlMap(strategyNames) {
    var map = new Map();
    var names = (strategyNames || []).filter(Boolean);
    if (!names.length) return map;
    try {
        var inList = names.map(encodeURIComponent).join(',');
        var url = SUPABASE_URL + '/rest/v1/wms_live_commands?strategy_name=in.(' + inList + ')' +
            '&payload->_gs_meta->>leg_role=in.(sl,sl_rearm)&broker_status=eq.OPEN' +
            '&select=strategy_name,payload,created_at&order=created_at.desc';
        var r = await fetch(url, { headers: wmsHeaders() });
        if (r.ok) (await r.json() || []).forEach(function (row) {
            if (!map.has(row.strategy_name) && row.payload && row.payload.stopPrice != null) {
                map.set(row.strategy_name, Number(row.payload.stopPrice));   // first = latest (desc)
            }
        });
    } catch (e) { /* fail-soft */ }
    return map;
}

async function autoLoadGsFamAdmin() {
    // 1. auto_strategies rows for silver + gold — PAPER rows here; LIVE rows render
    //    into the separate Live Trading table (autoGsRenderLiveTable).
    var stratsEl = document.getElementById('au-gs-fam-strategies-paper');
    if (stratsEl) {
        try {
            if (!_auManualTraders || !_auManualTraders.length) { try { await autoManualLoadTraders(); } catch (e) {} }   // populate the Trader dropdowns (LIVE rows)
            // ALL GS-family rows (family=gs) — base v2.2 + every variant (v2.3/v3),
            // so new config rows appear automatically. Params edit inline, one row each.
            // In parallel, pull the latest auto_run per name for the per-row "Last run".
            var stratReq = fetch(SUPABASE_URL + '/rest/v1/auto_strategies?metadata->>family=eq.gs&select=*&order=enabled.desc,version.asc,name.asc',
                { headers: wmsHeaders() }).then(function (x) { return x.ok ? x.json() : []; });
            var runReq = fetch(SUPABASE_URL + '/rest/v1/auto_runs?' + auGsNameFilter() + '&order=finished_at.desc&limit=120&select=strategy_name,finished_at,status,metadata',
                { headers: wmsHeaders() }).then(function (x) { return x.ok ? x.json() : []; });
            var limReq = fetch(SUPABASE_URL + '/rest/v1/wms_live_risk_limits?signal_source=eq.gs&strategy_name=is.null&select=*', { headers: wmsHeaders() }).then(function (x) { return x.ok ? x.json() : []; });
            var _both = await Promise.all([stratReq, runReq, limReq]);
            var _allRows = _both[0] || [];
            var _liveRows = _allRows.filter(function (r) { return r.execution_mode === 'LIVE'; });
            var rows = _allRows.filter(function (r) { return r.execution_mode !== 'LIVE'; });   // paper only in this table
            var runList = _both[1] || [];
            var _gsLims = _both[2] || [];   // account-level ceilings (wms_live_risk_limits, signal_source='gs')
            var _findGsLim = function (t) { return _gsLims.find(function (r) { return r.limit_type === t; }); };
            var _llots = _findGsLim('max_total_open_lots'), _lrisk = _findGsLim('max_total_risk_inr');
            var _acct = {
                lots:    (_llots && _llots.limit_value && _llots.limit_value.value != null) ? _llots.limit_value.value : '',
                risk:    (_lrisk && _lrisk.limit_value && _lrisk.limit_value.value != null) ? _lrisk.limit_value.value : '',
                enforce: _llots ? _llots.enabled : (_lrisk ? _lrisk.enabled : true)
            };
            // Ordered desc → first sighting of each name is its latest run.
            var latestRun = {};
            runList.forEach(function (r2) { if (!latestRun[r2.strategy_name]) latestRun[r2.strategy_name] = r2; });
            _auCacheStrategies(rows);
            _auGsRowNames = rows.map(function (s) { return s.name; });   // for Save-all
            if (rows.length === 0) {
                stratsEl.innerHTML = '<div class="au-soon">No matching auto_strategies rows.</div>';
            } else {
                var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse;white-space:nowrap">';
                html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                        '<th style="padding:6px 8px">Strategy</th>' +
                        '<th style="padding:6px 8px">Enabled</th>' +
                        '<th style="padding:6px 8px">Last run</th>';
                _AU_GS_PARAM_SPEC.forEach(function (f) { html += '<th style="padding:6px 8px">' + autoEsc(f.col) + '</th>'; });
                html += '<th style="padding:6px 8px">Actions</th>' +
                        '</tr></thead><tbody>';
                var nowMs = Date.now();
                rows.forEach(function (s) {
                    var params = (s.metadata && s.metadata.params) ? s.metadata.params : {};
                    var idBase = 'au-gsp-' + s.name;
                    html += '<tr style="border-top:1px solid #e5e7eb">';
                    html += '<td style="padding:6px 8px">' +
                            '<div><code style="font-weight:600">' + autoEsc(s.name) + '</code></div>' +
                            '<div style="font-size:10px;color:#6b7280"><span style="font-family:monospace;color:#1e40af">' + autoEsc(s.version || '—') + '</span> · ' + autoEsc(s.execution_mode || '—') + '</div></td>';
                    html += '<td style="padding:6px 8px">' + (s.enabled ? '<span class="au-badge success">yes</span>' : '<span class="au-badge idle">paused</span>') + '</td>';
                    // Last run — latest auto_run for THIS row's name, with the version it stamped.
                    var lr = latestRun[s.name];
                    var lrCell;
                    if (!lr || !lr.finished_at) {
                        lrCell = '<span style="color:#9ca3af">never</span>';
                    } else {
                        var ageMin = Math.round((nowMs - new Date(lr.finished_at).getTime()) / 60000);
                        var ago = ageMin < 60 ? (ageMin + 'm ago') : ageMin < 1440 ? (Math.round(ageMin / 60) + 'h ago') : (Math.round(ageMin / 1440) + 'd ago');
                        var rv = (lr.metadata && (lr.metadata.strategy_version || lr.metadata.version)) || '';
                        var okStatus = /^(success|ok)$/i.test(lr.status || '');
                        lrCell = '<span title="' + autoEsc(autoFmtIST(lr.finished_at)) + (rv ? ' · ' + autoEsc(rv) : '') + '" style="font-size:11px;color:' + (okStatus ? '#16a34a' : '#dc2626') + '">' + ago + '</span>' +
                                 (rv ? '<div style="font-size:10px;color:#6b7280;font-family:monospace">' + autoEsc(rv) + '</div>' : '');
                    }
                    html += '<td style="padding:6px 8px">' + lrCell + '</td>';
                    _AU_GS_PARAM_SPEC.forEach(function (f) {
                        var dflt = f.defFor ? f.defFor(s) : f.def;
                        var cur = (params[f.key] !== undefined && params[f.key] !== null) ? params[f.key] : dflt;
                        var inputId = idBase + '-' + f.key;
                        html += '<td style="padding:6px 8px">';
                        if (f.type === 'select') {
                            html += '<select id="' + inputId + '" class="wms-df-select">';
                            f.opts.forEach(function (o) { html += '<option value="' + o + '"' + (String(cur) === o ? ' selected' : '') + '>' + o + '</option>'; });
                            html += '</select>';
                        } else if (f.fmt === 'comma') {
                            // Text input (number inputs can't show separators); reformats on blur.
                            html += '<input id="' + inputId + '" type="text" inputmode="numeric" value="' + autoEsc(_auFmtIntComma(cur)) +
                                    '" onblur="this.value=_auFmtIntComma(this.value)" class="wms-input-compact wms-input-number" style="width:90px">';
                        } else {
                            var w = f.key === 'stop_mult' ? '56px' : '52px';
                            html += '<input id="' + inputId + '" type="number" step="' + f.step + '" value="' + autoEsc(String(cur)) +
                                    '" class="wms-input-compact wms-input-number" style="width:' + w + '">';
                        }
                        html += '</td>';
                    });
                    html += '<td style="padding:6px 8px">' + autoStrategyActionCell(s) + '</td>';
                    html += '</tr>';
                });
                html += '</tbody></table></div>';
                html += '<div style="margin-top:10px;display:flex;align-items:center;gap:10px">' +
                        '<button class="au-btn au-btn-primary" style="font-size:12px;padding:6px 16px" onclick="autoSaveGsParamsAll()">Save all</button>' +
                        '<span id="au-gsp-allmsg" style="font-size:11px;color:#6b7280"></span></div>';
                stratsEl.innerHTML = html;
            }
            if (typeof autoGsRenderLiveTable === 'function') autoGsRenderLiveTable(_liveRows, latestRun, _acct);
        } catch (e) {
            stratsEl.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
        }
    }

    // 2. Scheduling — external cron-job.org cron topology. auto_strategies.cron_schedule
    //    is null for GS by design (strategies don't own their cadence); reads
    //    latest auto_runs row to display "last run" freshness per cron.
    var schedEl = document.getElementById('au-gs-fam-scheduling');
    if (schedEl) {
        // `runFilter` is a PostgREST predicate. The cron still hits ?strategy=<base>,
        // but the runner fans out and records auto_runs under the VARIANT names
        // (…_v23 / …_v3) — the disabled base rows no longer run — so freshness must
        // match the variants via a name pattern, not the exact base name.
        var schedJobs = [
            { runFilter: 'strategy_name=like.silver_mini_15m*', label: 'Silver signal scan', endpoint: 'automation-runner?strategy=silver_mini_15m', cadence: 'every 15 min · MCX hours (9:00–23:30 IST)', staleMinutes: 45 },
            { runFilter: 'strategy_name=like.gold_mini_15m*',   label: 'Gold signal scan',   endpoint: 'automation-runner?strategy=gold_mini_15m',   cadence: 'every 15 min · MCX hours (9:00–23:30 IST)', staleMinutes: 45 },

            { runFilter: 'strategy_name=eq._eod_ingest',        label: 'EOD prices ingest',  endpoint: 'eod-prices-ingest',                          cadence: 'daily · after MCX close (~23:35 IST)',      staleMinutes: 60 * 30 }
        ];
        try {
            var results = await Promise.all(schedJobs.map(function (j) {
                return fetch(SUPABASE_URL + '/rest/v1/auto_runs?' + j.runFilter + '&order=finished_at.desc&limit=1&select=finished_at,status',
                    { headers: wmsHeaders() }).then(function (r) { return r.ok ? r.json() : []; });
            }));
            var now = Date.now();
            var html = '<table style="width:100%;font-size:12px;border-collapse:collapse">';
            html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                    '<th style="padding:6px 8px">Job</th>' +
                    '<th style="padding:6px 8px">Endpoint (Edge Function)</th>' +
                    '<th style="padding:6px 8px">Cadence</th>' +
                    '<th style="padding:6px 8px">Last run</th>' +
                    '<th style="padding:6px 8px">Status</th>' +
                    '</tr></thead><tbody>';
            schedJobs.forEach(function (j, i) {
                var row = results[i][0];
                var lastCell, badgeCell;
                if (!row || !row.finished_at) {
                    lastCell = '<span style="color:#9ca3af">never</span>';
                    badgeCell = '<span class="au-badge idle" style="font-size:10px">no data</span>';
                } else {
                    var ageMin = Math.round((now - new Date(row.finished_at).getTime()) / 60000);
                    var stale = ageMin > j.staleMinutes;
                    var ago = ageMin < 60 ? (ageMin + 'm ago') : ageMin < 1440 ? (Math.round(ageMin/60) + 'h ago') : (Math.round(ageMin/1440) + 'd ago');
                    lastCell = '<span title="' + autoEsc(autoFmtIST(row.finished_at)) + '">' + ago + '</span>';
                    var okStatus = (row.status === 'success' || row.status === 'OK' || row.status === 'ok');
                    if (stale)         badgeCell = '<span class="au-badge error" style="font-size:10px">STALE</span>';
                    else if (okStatus) badgeCell = '<span class="au-badge success" style="font-size:10px">OK</span>';
                    else               badgeCell = '<span class="au-badge idle" style="font-size:10px">' + autoEsc(row.status || '—') + '</span>';
                }
                html += '<tr style="border-top:1px solid #e5e7eb">' +
                        '<td style="padding:6px 8px"><b>' + autoEsc(j.label) + '</b></td>' +
                        '<td style="padding:6px 8px;font-family:monospace;font-size:11px;color:#4b5563">' + autoEsc(j.endpoint) + '</td>' +
                        '<td style="padding:6px 8px;font-size:11px;color:#4b5563">' + autoEsc(j.cadence) + '</td>' +
                        '<td style="padding:6px 8px;font-size:11px">' + lastCell + '</td>' +
                        '<td style="padding:6px 8px">' + badgeCell + '</td>' +
                        '</tr>';
            });
            html += '</tbody></table>';
            html += '<div style="font-size:11px;color:#6b7280;margin-top:8px;line-height:1.5">' +
                    '• Triggers configured at <a href="https://cron-job.org" target="_blank" style="color:#2563eb">cron-job.org</a> — not editable from WMS.<br>' +
                    '• Silver &amp; gold have SEPARATE cron entries (EXPLICIT_ONLY_STRATEGIES guard in the runner blocks accidental invocation).<br>' +
                    '• A stalled cron here means cron-job.org didn\'t hit the EF; check its dashboard.' +
                    '</div>';
            schedEl.innerHTML = html;
        } catch (e) {
            schedEl.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
        }
    }

    // (Plugin Version card removed — the per-row version now lives in the
    //  Strategy Configuration table above.)

    // 3. gs_catalogue — hard-coded in the plugin, so we compute from helper fns
    var catEl = document.getElementById('au-gs-fam-catalogue');
    if (catEl && typeof autoGsPointValue === 'function') {
        var instruments = [
            { short: 'SILVERM', name: 'MCX Silver Mini', unit: '5 kg / lot' },
            { short: 'GOLDM',   name: 'MCX Gold Mini',   unit: '100 g / lot' }
        ];
        var html = '<table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Instrument</th>' +
                '<th style="padding:6px 8px">Lot size</th>' +
                '<th style="padding:6px 8px;text-align:right">Point value (₹/pt)</th>' +
                '<th style="padding:6px 8px;text-align:right">Margin %</th>' +
                '</tr></thead><tbody>';
        instruments.forEach(function (inst) {
            var pv = autoGsPointValue(inst.short);
            var mp = typeof autoGsMarginPct === 'function' ? autoGsMarginPct(inst.short) : null;
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px"><b>' + autoEsc(inst.short) + '</b> <span style="color:#6b7280">— ' + autoEsc(inst.name) + '</span></td>' +
                    '<td style="padding:6px 8px">' + autoEsc(inst.unit) + '</td>' +
                    '<td style="padding:6px 8px;text-align:right">' + (pv != null ? '₹' + pv : '—') + '</td>' +
                    '<td style="padding:6px 8px;text-align:right">' + (mp != null ? mp + '%' : '—') + '</td>' +
                    '</tr>';
        });
        html += '</tbody></table>';
        catEl.innerHTML = html;
    }
}

// ----------------------------------------------------------------------------
// GS Strategy Parameters editor (metadata.params → runner)
//
// Writes auto_strategies.metadata.params, which the automation-runner threads
// into the strategy plugin (index.ts runOne → fetchData/scan). These are the
// UI-editable risk/exit knobs — changing them needs NO code deploy. One block
// per GS-family config row, so v2.2 / v2.3 / v3 each get their own params.
// ----------------------------------------------------------------------------
var _AU_GS_PARAM_SPEC = [
    { key: 'stop_mode',          col: 'stop_mode',  label: 'stop_mode',          type: 'select', opts: ['drift', 'fixed'], def: 'drift' },
    { key: 'stop_mult',          col: 'stop_mult',  label: 'stop_mult (×ATR)',   type: 'number', step: '0.1',  def: 1.8 },
    { key: 'risk_per_trade',     col: 'risk (₹)',   label: 'risk_per_trade (₹)', type: 'number', step: '1000', def: 50000, fmt: 'comma' },
    { key: 'entry_roll_days',    col: 'entry_roll', label: 'entry_roll_days',    type: 'number', step: '1',    def: 6 },
    { key: 'position_roll_days', col: 'pos_roll',   label: 'position_roll_days', type: 'number', step: '1',    def: 3 },
    // Enforced in gs_state.calcQty as a hard ceiling on lots/entry. Instrument-aware
    // default (gold 20 / silver 12) per the go-live plan; 0 = no cap.
    { key: 'lot_cap',            col: 'lot_cap',    label: 'lot_cap (#lots)',    type: 'number', step: '1',    def: 12,
      defFor: function (s) { return /gold/i.test(s.name || '') ? 20 : 12; } }
];

// Row names in the currently-rendered config table — the Save-all button iterates these.
var _auGsRowNames = [];

// Indian-grouping thousands formatter for ₹ inputs (e.g. 75000 → "75,000",
// 150000 → "1,50,000"). Strips any existing separators first so it's idempotent.
function _auFmtIntComma(v) {
    var n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
    if (!isFinite(n)) return '';
    return Math.round(n).toLocaleString('en-IN');
}

// Reads the inline inputs for one row and returns a merged params object.
// Throws (with the row name) on any invalid field.
function _auGsCollectParams(name, baseMeta) {
    var idBase = 'au-gsp-' + name;
    var params = Object.assign({}, (baseMeta && baseMeta.params) || {});
    _AU_GS_PARAM_SPEC.forEach(function (f) {
        var inp = document.getElementById(idBase + '-' + f.key);
        if (!inp) return;
        if (f.type === 'select') {
            params[f.key] = inp.value;
        } else {
            // Strip thousands separators (comma-formatted ₹ fields) before parsing.
            var v = parseFloat(String(inp.value).replace(/,/g, ''));
            if (!isFinite(v)) throw new Error(name + ' · ' + f.label + ' must be a number');
            if (v < 0) throw new Error(name + ' · ' + f.label + ' cannot be negative');
            params[f.key] = v;
        }
    });
    return params;
}

// Single "Save all" — commits every row in the table. Each row is an independent
// read-modify-write PATCH (metadata also carries driver/family/plugin/version, and
// PostgREST PATCH replaces the whole jsonb — so merge, never overwrite).
async function autoSaveGsParamsAll() {
    var msg = document.getElementById('au-gsp-allmsg');
    if (msg) { msg.style.color = '#6b7280'; msg.textContent = 'Saving…'; }
    try {
        var names = _auGsRowNames || [];
        if (!names.length) { if (msg) msg.textContent = 'Nothing to save.'; return; }

        // One read of all GS metadata as the merge base, then PATCH each row.
        var rr = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?metadata->>family=eq.gs&select=name,metadata',
            { headers: wmsHeaders() });
        if (!rr.ok) throw new Error('read HTTP ' + rr.status + ' ' + (await rr.text()));
        var metaByName = {};
        (await rr.json()).forEach(function (row) { metaByName[row.name] = row.metadata || {}; });

        var saved = 0;
        for (var n = 0; n < names.length; n++) {
            var name = names[n];
            var meta = Object.assign({}, metaByName[name] || {});
            if (!meta.driver || !meta.family) throw new Error(name + ': row missing driver/family');
            meta.params = _auGsCollectParams(name, meta);
            var pr = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?name=eq.' + encodeURIComponent(name), {
                method: 'PATCH',
                headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
                body: JSON.stringify({ metadata: meta })
            });
            if (!pr.ok) throw new Error(name + ': save HTTP ' + pr.status + ' ' + (await pr.text()));
            saved++;
        }
        if (msg) { msg.style.color = '#16a34a'; msg.textContent = '✓ Saved ' + saved + ' row' + (saved === 1 ? '' : 's') + ' — applies to the next scan.'; }
        autoLoadGsFamAdmin();   // re-read the unified table — never claim success from the local copy
    } catch (e) {
        if (msg) { msg.style.color = '#dc2626'; msg.textContent = 'Failed: ' + String(e.message || e); }
    }
}

// ============================================================================
// GS — Live Trading table: a FLAT table with the SAME shape as the Paper table, plus a
// Trader column, password-gated Pause/Resume, per-row Remove, and an Add-trader control
// that CLONES a base strategy into a new LIVE auto_strategies row for a beneficiary.
// Each live row is its own independent row (own params + one trader_id = beneficiary);
// executor is always Veins/Fyers; multiple traders on an instrument = multiple rows.
// Pause/Resume reuses the manual-order password (_auManualPw; server-side check @ Stage 2).
// ============================================================================
var _auGsLiveRowNames = [];
var _auGsLiveTagCtrls = {};   // strategy_name -> wmsTagInput controller (per-row tags)
// Clone from the v3 PAPER canonical rows — they always exist for both instruments and carry the
// v3 params. (The old bases pointed at gold_mini_15m_v3_live / silver_mini_15m_v3_live; the silver
// one was never created, so "Add trader" for silver failed with "base strategy not found".)
var _AU_GS_LIVE_BASES = [
    { name: 'gold_mini_15m_v3',   label: 'Gold Mini v3 (clone)' },
    { name: 'silver_mini_15m_v3', label: 'Silver Mini v3 (clone)' }
];

function autoGsTraderOptions() {
    return '<option value="">(select trader)</option>' + (_auManualTraders || []).map(function (t) {
        return '<option value="' + t.id + '">' + autoEsc(t.short_name || t.name || t.id) + '</option>';
    }).join('');
}
function _auGsTraderName(id) { var t = (_auManualTraders || []).find(function (x) { return x.id === id; }); return t ? (t.short_name || t.name) : ''; }

// Arming/removing a LIVE algo row is higher-stakes than one manual trade, so — unlike the
// manual form — this NEVER reuses the session-cached password. Prompts on EVERY Resume/Remove
// click and returns the value (not cached) to POST to wms-manual-order, which verifies it
// server-side (MANUAL_ORDER_PW_SHA256) — the same second factor as manual orders. This is a
// ONE-TIME gate at the click; it does NOT gate order placement or SL shifts. Owner, 2026-07-22.
function _auGsLivePw() {
    var v = prompt('Enter the manual-order password to arm/remove this LIVE row (required every time):');
    return (v && v.length) ? v : null;
}

// The account-ceiling row (first row of the Live table): total open-lots + total ₹-risk
// ACROSS all traders + both instruments. Backed by wms_live_risk_limits (signal_source='gs').
// The per-instrument caps are superseded by this single account ceiling.
function autoGsAcctRowHtml(acct) {
    acct = acct || {};
    var lots = (acct.lots != null && acct.lots !== '') ? acct.lots : '';
    var on = acct.enforce !== false;
    var h = '<tr style="border-top:2px solid #f3a0a0;background:#fff2f2">';
    h += '<td style="padding:6px 8px;white-space:normal;max-width:150px"><b>🏦 Account ceiling</b><div style="font-size:10px;color:#6b7280">all traders + both instruments</div></td>';
    h += '<td style="padding:6px 8px;color:#c0a0a0">—</td>';   // trader
    h += '<td style="padding:6px 8px;color:#c0a0a0">—</td>';   // tags
    h += '<td style="padding:6px 8px"><label style="font-size:11px"><input type="checkbox" id="au-gsl-acct-enforce" ' + (on ? 'checked' : '') + '> enforce</label></td>';   // Live col → enforce
    h += '<td style="padding:6px 8px;color:#c0a0a0">—</td>';   // last run
    _AU_GS_PARAM_SPEC.forEach(function (f) {
        h += '<td style="padding:6px 8px">';
        if (f.key === 'lot_cap') h += '<input id="au-gsl-acct-lots" type="number" min="0" step="1" value="' + (lots === '' ? '' : autoEsc(String(lots))) + '" placeholder="max lots" class="wms-input-compact wms-input-number" style="width:60px" title="Max total open lots across all traders + both instruments. Enforce off, or blank/0 = no limit.">';
        else h += '<span style="color:#d0b0b0">—</span>';
        h += '</td>';
    });
    h += '<td style="padding:6px 8px;color:#c0a0a0">—</td>';
    h += '</tr>';
    return h;
}

// Upsert one account-level limit into wms_live_risk_limits (signal_source='gs').
async function _auGsUpsertAcctLimit(type, valueObj, enabled) {
    var ex = await fetch(SUPABASE_URL + '/rest/v1/wms_live_risk_limits?signal_source=eq.gs&strategy_name=is.null&limit_type=eq.' + encodeURIComponent(type) + '&select=id', { headers: wmsHeaders() }).then(function (r) { return r.json(); });
    if (ex && ex[0]) {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/wms_live_risk_limits?id=eq.' + ex[0].id,
            { method: 'PATCH', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }), body: JSON.stringify({ limit_value: valueObj, enabled: enabled, breach_action: 'reject' }) });
        if (!resp.ok) throw new Error('account limit ' + type + ': HTTP ' + resp.status + ' ' + (await resp.text()));
    } else {
        var resp2 = await fetch(SUPABASE_URL + '/rest/v1/wms_live_risk_limits',
            { method: 'POST', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }), body: JSON.stringify({ signal_source: 'gs', strategy_name: null, iba_id: null, limit_type: type, limit_value: valueObj, enabled: enabled, breach_action: 'reject' }) });
        if (!resp2.ok) throw new Error('account limit ' + type + ': HTTP ' + resp2.status + ' ' + (await resp2.text()));
    }
}

function autoGsRenderLiveTable(liveRows, latestRun, acct) {
    var el = document.getElementById('au-gs-fam-strategies-live'); if (!el) return;
    liveRows = liveRows || [];
    // Hidden rows (metadata.hidden) are kept in the DB but tucked out of the panel so a
    // retired/paused row can't be resumed or edited by accident. Reveal with "Show hidden".
    var _hiddenCount = liveRows.filter(function (s) { return s.metadata && s.metadata.hidden; }).length;
    var _visibleRows = _auGsShowHidden ? liveRows : liveRows.filter(function (s) { return !(s.metadata && s.metadata.hidden); });
    _auGsLiveRowNames = _visibleRows.map(function (s) { return s.name; });   // Save-all only touches shown rows
    var nowMs = Date.now();
    var ncols = 6 + _AU_GS_PARAM_SPEC.length;
    var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse;white-space:nowrap">';
    html += '<thead><tr style="background:#fde8e8;text-align:left">' +
        '<th style="padding:6px 8px">Strategy</th><th style="padding:6px 8px">Trader</th><th style="padding:6px 8px">Tags</th><th style="padding:6px 8px" title="enabled / paused">Live</th><th style="padding:6px 8px">Last run</th>';
    _AU_GS_PARAM_SPEC.forEach(function (f) { html += '<th style="padding:6px 8px">' + autoEsc(f.col) + '</th>'; });
    html += '<th style="padding:6px 8px">Actions</th></tr></thead><tbody>';
    html += autoGsAcctRowHtml(acct);
    if (!_visibleRows.length) {
        html += '<tr><td colspan="' + ncols + '" style="padding:10px;color:#9ca3af">' +
            (liveRows.length ? 'All live rows are hidden — tick “Show hidden (' + _hiddenCount + ')” below to reveal.' : 'No live strategies yet — add a trader below (or run <code>GS-live-rows-seed.sql</code>).') + '</td></tr>';
    } else {
        _visibleRows.forEach(function (s) {
            var params = (s.metadata && s.metadata.params) ? s.metadata.params : {};
            var _isHidden = !!(s.metadata && s.metadata.hidden);
            var idB = 'au-gsl-' + s.name;
            var tid = (s.metadata && s.metadata.trader_id) || '';
            var tname = tid ? (_auGsTraderName(tid) || tid) : '';
            html += '<tr style="border-top:1px solid #f0d0d0">';
            var _disp = s.display_name || s.name;
            html += '<td style="padding:6px 8px;white-space:normal;max-width:190px">' +
                '<div data-name="' + autoEsc(s.name) + '" data-disp="' + autoEsc(_disp) + '" title="' + autoEsc(s.name) + ' — double-click to rename" ondblclick="autoGsEditDisplayName(this)" style="font-weight:700;color:#1d4ed8;cursor:text">' + autoEsc(_disp) + '</div>' +
                '<div style="margin-top:2px"><code style="font-size:9.5px;color:#64748b;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;padding:1px 5px;word-break:break-all">' + autoEsc(s.name) + '</code> <span style="font-size:10px;color:#9ca3af">' + autoEsc(s.version || '') + ' · LIVE</span>' + (_isHidden ? ' <span style="font-size:10px;color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:4px;padding:1px 5px">hidden</span>' : '') + '</div></td>';
            // Trader — fixed at Add-trader time; shown as text, not editable
            // No explicit trader_id → the executor Veins is the beneficiary (booking defaults
            // trader→Veins, same as KH). Show that instead of a bare dash.
            html += '<td style="padding:6px 8px">' + (tname ? autoEsc(tname) : 'Veins <span style="color:#9ca3af;font-size:10px" title="no explicit beneficiary — trades and books to the executor, Veins">(default)</span>') + '</td>';
            // Tags — global tag widget (wmsTagInput), initialised after render, → metadata.transaction_tags
            html += '<td style="padding:6px 8px"><div style="min-width:150px">' +
                '<input id="' + idB + '-tags-input" type="text" placeholder="tags…" autocomplete="off" style="padding:4px 6px;border:1px solid #d1d5db;border-radius:4px;font-size:11px;width:100%;box-sizing:border-box">' +
                '<div class="wms-tag-pills" id="' + idB + '-tags-pills"></div>' +
                '<div class="wms-tag-dd" id="' + idB + '-tags-dd"></div></div></td>';
            // Live status dot (green = enabled, red = paused)
            html += '<td style="padding:6px 8px;text-align:center"><span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:' + (s.enabled ? '#16a34a' : '#dc2626') + '" title="' + (s.enabled ? 'enabled (live)' : 'paused') + '"></span></td>';
            var lr = latestRun ? latestRun[s.name] : null;
            html += '<td style="padding:6px 8px">' + ((!lr || !lr.finished_at) ? '<span style="color:#9ca3af">never</span>' : (Math.round((nowMs - new Date(lr.finished_at).getTime()) / 60000) + 'm ago')) + '</td>';
            _AU_GS_PARAM_SPEC.forEach(function (f) {
                var dflt = f.defFor ? f.defFor(s) : f.def;
                var cur = (params[f.key] !== undefined && params[f.key] !== null) ? params[f.key] : dflt;
                var inputId = idB + '-' + f.key;
                html += '<td style="padding:6px 8px">';
                if (f.type === 'select') {
                    html += '<select id="' + inputId + '" class="wms-df-select">';
                    f.opts.forEach(function (o) { html += '<option value="' + o + '"' + (String(cur) === o ? ' selected' : '') + '>' + o + '</option>'; });
                    html += '</select>';
                } else if (f.fmt === 'comma') {
                    html += '<input id="' + inputId + '" type="text" inputmode="numeric" value="' + autoEsc(_auFmtIntComma(cur)) + '" onblur="this.value=_auFmtIntComma(this.value)" class="wms-input-compact wms-input-number" style="width:90px">';
                } else {
                    var w = f.key === 'lot_cap' ? '60px' : (f.key === 'stop_mult' ? '56px' : '52px');
                    html += '<input id="' + inputId + '" type="number" step="' + f.step + '" value="' + autoEsc(String(cur)) + '" class="wms-input-compact wms-input-number" style="width:' + w + '">';
                }
                html += '</td>';
            });
            // Actions — small icons (pause/resume password-gated + delete), like the ✕
            // Hide/Unhide sits on its OWN line below Pause/Delete so it doesn't widen the row.
            var _hideBtn = _isHidden
                ? '<button class="au-btn au-btn-secondary" style="padding:3px 7px;font-size:12px" title="Unhide — show this row in the panel again" onclick="autoGsLiveToggleHidden(\'' + s.name + '\',false)">👁 Unhide</button>'
                : (!s.enabled
                    ? '<button class="au-btn au-btn-secondary" style="padding:3px 7px;font-size:12px" title="Hide — tuck this paused row out of the panel (kept in DB, stays paused, reversible via Show hidden)" onclick="autoGsLiveToggleHidden(\'' + s.name + '\',true)">🙈 Hide</button>'
                    : '');   // enabled rows can\'t be hidden — pause first, so a live-trading row is never out of sight
            html += '<td style="padding:6px 8px;white-space:nowrap;vertical-align:middle;text-align:left">' +
                '<div style="display:flex;gap:6px;align-items:center">' +
                    '<button class="au-btn ' + (s.enabled ? 'au-btn-secondary' : 'au-btn-primary') + '" style="padding:3px 7px;font-size:12px" title="' + (s.enabled ? 'Pause (no password — safety stop)' : 'Resume (password required)') + '" onclick="autoGsLiveTogglePw(\'' + s.name + '\',' + (s.enabled ? 'true' : 'false') + ')">' + (s.enabled ? '⏸' : '▶') + '🔒</button>' +
                    '<button class="au-btn au-btn-danger" style="padding:3px 7px;font-size:12px" title="Delete this live row" onclick="autoGsLiveRemoveRow(\'' + s.name + '\')">✕</button>' +
                '</div>' +
                (_hideBtn ? '<div style="margin-top:4px;display:flex">' + _hideBtn + '</div>' : '') +
                '</td>';
            html += '</tr>';
        });
    }
    html += '</tbody></table></div>';
    // One aligned footer row: Save all (live) + a divider + the Add-trader controls.
    // Both primary buttons share the same size so nothing looks mismatched.
    html += '<div style="margin-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
        '<button class="au-btn au-btn-primary" style="font-size:12px;padding:6px 14px" onclick="autoSaveGsLiveAll()">Save all (live)</button>' +
        '<span id="au-gsl-allmsg" style="font-size:11px;color:#6b7280"></span>' +
        '<span style="width:1px;align-self:stretch;background:#f0c0c0;margin:0 4px"></span>' +
        '<span style="font-size:12px;color:#374151;font-weight:600">Add trader:</span>' +
        '<select id="au-gsl-add-strat" class="wms-df-select" style="min-width:160px">' + _AU_GS_LIVE_BASES.map(function (b) { return '<option value="' + b.name + '">' + autoEsc(b.label) + '</option>'; }).join('') + '</select>' +
        '<select id="au-gsl-add-trader" class="wms-df-select" style="min-width:140px">' + autoGsTraderOptions() + '</select>' +
        '<button class="au-btn au-btn-primary" style="font-size:12px;padding:6px 14px" onclick="autoGsLiveAddTrader()">+ Add trader</button>' +
        (_hiddenCount ? '<label style="font-size:11px;color:#6b7280;margin-left:auto;cursor:pointer" title="Reveal rows hidden with the 🙈 button">' +
            '<input type="checkbox" ' + (_auGsShowHidden ? 'checked' : '') + ' onchange="autoGsToggleShowHidden(this.checked)"> Show hidden (' + _hiddenCount + ')</label>' : '') +
    '</div>';
    el.innerHTML = html;
    autoGsInitLiveTags(_visibleRows);   // wire the per-row global tag widgets for shown rows only
}

// Show/hide the hidden (retired/paused) live rows. UI-only flag; re-renders the panel.
var _auGsShowHidden = false;
function autoGsToggleShowHidden(on) { _auGsShowHidden = !!on; if (typeof autoLoadGsFamAdmin === 'function') autoLoadGsFamAdmin(); }

// Hide / unhide a live row via metadata.hidden (non-destructive; keeps name, history, params,
// and paused state intact). Read-modify-write so no other metadata key is disturbed.
async function autoGsLiveToggleHidden(name, hide) {
    try {
        var cur = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?name=eq.' + encodeURIComponent(name) + '&select=metadata', { headers: wmsHeaders() }).then(function (r) { return r.json(); });
        var md = (cur && cur[0] && cur[0].metadata) ? cur[0].metadata : {};
        if (hide) md.hidden = true; else delete md.hidden;
        var r = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?name=eq.' + encodeURIComponent(name),
            { method: 'PATCH', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }), body: JSON.stringify({ metadata: md }) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        if (typeof autoLoadGsFamAdmin === 'function') autoLoadGsFamAdmin();
    } catch (e) { alert('Hide/unhide failed: ' + (e.message || e)); }
}

// Per-row tag widgets (wmsTagInput) → auto_strategies.metadata.transaction_tags. Same field
// the fill-writer will apply to each booked GS fill (like KH's transaction_tags).
async function autoGsInitLiveTags(liveRows) {
    if (typeof wmsTagInput !== 'function') return;
    var existing = [];
    try { existing = await autoGetExistingTags(); } catch (e) {}
    _auGsLiveTagCtrls = {};
    (liveRows || []).forEach(function (s) {
        var idB = 'au-gsl-' + s.name;
        var input = document.getElementById(idB + '-tags-input');
        var pills = document.getElementById(idB + '-tags-pills');
        var dd = document.getElementById(idB + '-tags-dd');
        if (!input || !pills || !dd) return;
        var tags = (s.metadata && Array.isArray(s.metadata.transaction_tags)) ? s.metadata.transaction_tags.slice() : [];
        _auGsLiveTagCtrls[s.name] = wmsTagInput(input, pills, dd, { tags: tags, existingTags: existing, onChange: function () {} });
    });
}

async function autoGsLiveTogglePw(name, enabled) {
    // 'enabled' is the CURRENT state. Resuming (currently paused) ARMS the row → server-verified
    // password every click (via wms-manual-order). Pausing is a free safety stop (direct PATCH,
    // no password) so it can be hit fast, like the kill switch.
    if (enabled) {
        if (!confirm('Pause LIVE row "' + name + '"?')) return;
        try {
            var presp = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?name=eq.' + encodeURIComponent(name),
                { method: 'PATCH', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }), body: JSON.stringify({ enabled: false }) });
            if (!presp.ok) throw new Error('HTTP ' + presp.status + ' ' + (await presp.text()));
            autoLoadGsFamAdmin();
        } catch (e) { alert('Failed to pause: ' + (e.message || e)); }
        return;
    }
    // Resume — arm the row. Password verified server-side.
    var pw = _auGsLivePw();
    if (!pw) return;
    if (!confirm('Resume LIVE row "' + name + '"?\n\nResuming ARMS this row — the next entry places a REAL order for its beneficiary.')) return;
    try {
        var resp = await fetch(SUPABASE_URL + '/functions/v1/wms-manual-order', {
            method: 'POST', headers: wmsEdgeHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ action: 'set_live_enabled', strategy_name: name, enabled: true, password: pw, confirm: true })
        });
        var j = await resp.json().catch(function () { return {}; });
        if (resp.status === 401) { alert((j.error || 'Invalid password') + ' — not armed.'); return; }
        if (!resp.ok || !j.ok) throw new Error(j.error || ('HTTP ' + resp.status));
        autoLoadGsFamAdmin();
    } catch (e) { alert('Failed to resume: ' + (e.message || e)); }
}

async function autoGsLiveRemoveRow(name) {
    var pw = _auGsLivePw();
    if (!pw) return;
    if (!confirm('Delete the LIVE row "' + name + '"? This removes the strategy row entirely.')) return;
    try {
        var resp = await fetch(SUPABASE_URL + '/functions/v1/wms-manual-order', {
            method: 'POST', headers: wmsEdgeHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ action: 'delete_live_row', strategy_name: name, password: pw, confirm: true })
        });
        var j = await resp.json().catch(function () { return {}; });
        if (resp.status === 401) { alert((j.error || 'Invalid password') + ' — not deleted.'); return; }
        if (!resp.ok || !j.ok) throw new Error(j.error || ('HTTP ' + resp.status));
        autoLoadGsFamAdmin();
    } catch (e) { alert('Failed to delete: ' + (e.message || e)); }
}

async function autoGsLiveAddTrader() {
    var base = document.getElementById('au-gsl-add-strat').value;
    var tid = document.getElementById('au-gsl-add-trader').value;
    if (!base) { alert('Pick a strategy.'); return; }
    if (!tid) { alert('Pick a trader.'); return; }
    var tname = _auGsTraderName(tid);
    var slug = (tname || 'trader').toLowerCase().replace(/[^a-z0-9]+/g, '');
    // base is the paper canonical (e.g. silver_mini_15m_v3) → live row is <canonical>_live_<slug>.
    var newName = base + '_live_' + slug;
    try {
        var br = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?name=eq.' + encodeURIComponent(base) + '&select=display_name,version,owner,recipients,metadata', { headers: wmsHeaders() }).then(function (r) { return r.json(); });
        if (!br || !br[0]) throw new Error('base strategy not found');
        var exists = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?name=eq.' + encodeURIComponent(newName) + '&select=name', { headers: wmsHeaders() }).then(function (r) { return r.json(); });
        if (exists && exists.length) { alert('A row for that strategy + trader already exists (' + newName + ').'); return; }
        var md = Object.assign({}, br[0].metadata || {});
        // CRITICAL: strip `channels` — the paper canonical carries channels:{paper}, but a LIVE row
        // MUST have no channels object or the engine's resolver treats it as a paper row and never
        // places live orders (gs_channels.ts: a row carrying metadata.channels is paper-only).
        md.trader_id = tid; delete md.beneficiaries; delete md.live_armed; delete md.channels;
        var body = { name: newName, display_name: (br[0].display_name || base) + ' LIVE · ' + (tname || ''), owner: br[0].owner || 'Vikash', version: br[0].version || null, execution_mode: 'LIVE', enabled: false, recipients: br[0].recipients || [], metadata: md };
        var resp = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies', { method: 'POST', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }), body: JSON.stringify(body) });
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));
        autoLoadGsFamAdmin();
    } catch (e) { alert('Failed to add trader: ' + (e.message || e)); }
}

function _auGsCollectLiveParams(idB, baseMeta) {
    var params = Object.assign({}, (baseMeta && baseMeta.params) || {});
    _AU_GS_PARAM_SPEC.forEach(function (f) {
        var inp = document.getElementById(idB + '-' + f.key);
        if (!inp) return;
        if (f.type === 'select') { params[f.key] = inp.value; }
        else { var v = parseFloat(String(inp.value).replace(/,/g, '')); if (isFinite(v) && v >= 0) params[f.key] = v; }
    });
    return params;
}

async function autoSaveGsLiveAll() {
    var msg = document.getElementById('au-gsl-allmsg');
    if (msg) { msg.style.color = '#6b7280'; msg.textContent = 'Saving…'; }
    try {
        var names = _auGsLiveRowNames || [];
        if (!names.length) { if (msg) msg.textContent = 'Nothing to save.'; return; }
        var rr = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?metadata->>family=eq.gs&execution_mode=eq.LIVE&select=name,metadata', { headers: wmsHeaders() });
        var metaByName = {};
        (await rr.json()).forEach(function (row) { metaByName[row.name] = row.metadata || {}; });
        var saved = 0;
        for (var i = 0; i < names.length; i++) {
            var name = names[i], idB = 'au-gsl-' + name, meta = Object.assign({}, metaByName[name] || {});
            meta.params = _auGsCollectLiveParams(idB, meta);
            // Trader is fixed (set at Add-trader time) — not editable here. Tags → transaction_tags.
            var _tc = _auGsLiveTagCtrls[name];
            if (_tc && typeof _tc.getTags === 'function') {
                var _tg = _tc.getTags().map(function (x) { return String(x).trim(); }).filter(Boolean);
                if (_tg.length) meta.transaction_tags = _tg; else delete meta.transaction_tags;
            }
            var pr = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?name=eq.' + encodeURIComponent(name),
                { method: 'PATCH', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }), body: JSON.stringify({ metadata: meta }) });
            if (!pr.ok) throw new Error(name + ': HTTP ' + pr.status + ' ' + (await pr.text()));
            saved++;
        }
        // Account ceiling → wms_live_risk_limits (signal_source='gs'). Lot-cap ONLY (owner).
        // Enforce off OR blank/0 lots = no limit. Legacy total-risk row is dropped.
        var acctEnf = document.getElementById('au-gsl-acct-enforce');
        var acctLotsEl = document.getElementById('au-gsl-acct-lots');
        if (acctLotsEl) {
            var on = acctEnf ? acctEnf.checked : false;
            var lotsV = parseInt(acctLotsEl.value, 10); if (!isFinite(lotsV)) lotsV = 0;
            await _auGsUpsertAcctLimit('max_total_open_lots', { value: lotsV }, on && lotsV > 0);
            try { await fetch(SUPABASE_URL + '/rest/v1/wms_live_risk_limits?signal_source=eq.gs&strategy_name=is.null&limit_type=eq.max_total_risk_inr', { method: 'DELETE', headers: wmsHeaders({ 'Prefer': 'return=minimal' }) }); } catch (e) {}
        }
        if (msg) { msg.style.color = '#16a34a'; msg.textContent = '✓ Saved ' + saved + ' live row(s) + account ceiling.'; }
        autoLoadGsFamAdmin();
    } catch (e) { if (msg) { msg.style.color = '#dc2626'; msg.textContent = 'Failed: ' + String(e.message || e); } }
}

// ============================================================================
// Pairs family page (Phase C — 2026-07-09; de-mirrored Phase E.1b — 2026-07-10)
//
// Same anatomy as GS. Open/Closed renderers (autoLoadOpenTrades /
// autoLoadClosedTrades) write DIRECTLY into this page's targets via
// autoTarget() / autoBadgeTarget(), fanning out to the Legacy elements while
// they still exist. Signals & Events / Run History / Admin have their own
// renderers scoped to non-GS strategies. Controls are locked per LESSONS §B.21.8
// (the lock covers scanner logic, not the Pause/Resume enabled flag).
// ============================================================================

function autoLoadPairsFamRefresh() {
    if (typeof autoLoadOpenTrades === 'function')   autoLoadOpenTrades();
    if (typeof autoLoadClosedTrades === 'function') autoLoadClosedTrades();
    autoLoadPairsFamHeader();
    autoLoadPairsFamEvents();
    autoLoadPairsFamRuns();
    autoLoadPairsFamAdmin();
    autoLoadPairsFamMetricsFull();  // extra queries the trade tables don't cover
}

// ----- Header (mode pill + last activity) ------------------------------------
async function autoLoadPairsFamHeader() {
    try {
        // Mode: read auto_strategies for pairs strategies (non-GS)
        var fam = await autoGetStrategyFamilies();
        var sr = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?enabled=eq.true&select=name,execution_mode',
            { headers: wmsHeaders() });
        var all = sr.ok ? await sr.json() : [];
        var pairsStrats = all.filter(function (s) { return autoIsPairs(fam, s.name); });
        var pill = document.getElementById('au-pairs-fam-mode');
        if (pill) {
            if (pairsStrats.length === 0) { pill.className = 'status-pill stopped'; pill.textContent = '⏹ NO ENABLED PAIRS STRATEGIES'; }
            else if (pairsStrats.some(function (s) { return s.execution_mode === 'LIVE'; })) { pill.className = 'status-pill live';  pill.textContent = '🟢 LIVE'; }
            else                                                                             { pill.className = 'status-pill paper'; pill.textContent = '🟡 PAPER'; }
        }
        // Last activity — most-recent auto_signals for non-GS strategies
        var stratNames = pairsStrats.map(function (s) { return s.name; });
        if (stratNames.length > 0) {
            var ar = await fetch(SUPABASE_URL + '/rest/v1/auto_signals?strategy_name=in.(' + stratNames.join(',') + ')&order=fired_at.desc&limit=1&select=fired_at,event_type,strategy_name',
                { headers: wmsHeaders() });
            var last = ar.ok ? (await ar.json())[0] : null;
            var laEl = document.getElementById('au-pairs-fam-lastact');
            if (laEl) {
                if (last) {
                    var ago = Math.round((Date.now() - new Date(last.fired_at).getTime()) / 60000);
                    var agoStr = ago < 60 ? (ago + 'm ago') : ago < 1440 ? (Math.round(ago/60) + 'h ago') : (Math.round(ago/1440) + 'd ago');
                    laEl.textContent = 'Last activity: ' + last.event_type + ' · ' + last.strategy_name + ' · ' + agoStr;
                } else {
                    laEl.textContent = 'Last activity: no signals yet';
                }
            }
        }
    } catch (_e) { /* silent */ }
}

// ----- Metrics --------------------------------------------------------------
var _auPairsMetrics = { openCount: null, openLivePnl: null, realised: null, avgZ: null, avgZN: null, signalsIn30d: null, lastScanAt: null };

function autoRenderPairsFamMetrics() {
    var t = _auPairsMetrics;
    var fmt = function (n) { if (n == null) return '—'; return '₹' + Math.round(n).toLocaleString('en-IN'); };
    var fmtSigned = function (n) {
        if (n == null) return '—';
        var sign = n >= 0 ? '+' : '−';
        return sign + '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN');
    };
    var setText = function (id, txt, cls) {
        var e = document.getElementById(id);
        if (!e) return;
        e.textContent = txt;
        if (cls !== undefined) e.className = 'metric-value ' + cls;
    };
    var setSub = function (id, txt) { var e = document.getElementById(id); if (e) e.textContent = txt || ''; };

    if (t.openCount != null) {
        setText('au-pairs-fam-metric-open', t.openCount + (t.openCount === 1 ? ' trade' : ' trades'), '');
        setSub('au-pairs-fam-metric-open-sub', t.openLivePnl != null ? ('live P&L ' + fmtSigned(t.openLivePnl)) : '');
    }
    if (t.realised != null) {
        setText('au-pairs-fam-metric-realised', fmtSigned(t.realised), t.realised >= 0 ? 'pos' : 'neg');
        setSub('au-pairs-fam-metric-realised-sub', '');
    }
    if (t.avgZ != null) {
        setText('au-pairs-fam-metric-avgz', t.avgZ.toFixed(2), '');
        setSub('au-pairs-fam-metric-avgz-sub', t.avgZN != null ? ('n=' + t.avgZN + ' entries') : '');
    }
    if (t.lastScanAt) {
        var ago = Math.round((Date.now() - new Date(t.lastScanAt).getTime()) / 60000);
        var agoStr = ago < 60 ? (ago + 'm ago') : ago < 1440 ? (Math.round(ago/60) + 'h ago') : (Math.round(ago/1440) + 'd ago');
        setText('au-pairs-fam-metric-lastscan', agoStr, '');
        setSub('au-pairs-fam-metric-lastscan-sub', new Date(t.lastScanAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
    }
    if (t.signalsIn30d != null) {
        setText('au-pairs-fam-metric-signals', String(t.signalsIn30d), '');
        setSub('au-pairs-fam-metric-signals-sub', '');
    }
}

async function autoLoadPairsFamMetricsFull() {
    try {
        var fam = await autoGetStrategyFamilies();

        // Open count from view (excluding GS + utility _-prefixed)
        var vr = await fetch(SUPABASE_URL + '/rest/v1/v_auto_open_trades?select=strategy_name,net_qty', { headers: wmsHeaders() });
        if (vr.ok) {
            var openRows = await vr.json();
            var pairsOpen = (openRows || []).filter(function (r) {
                return autoIsPairs(fam, r.strategy_name);
            });
            _auPairsMetrics.openCount = pairsOpen.length;
        }

        // Realised P&L all-time and 30-day signal count from auto_signals — approximate:
        // for a proper realised we'd need to walk entry/exit pairs; for now show a
        // signals-count proxy plus deep-link Legacy for full realised (until we
        // wire the same walker used by autoLoadClosedTrades to feed a state var).
        var since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
        var sc = await fetch(SUPABASE_URL + '/rest/v1/auto_signals?event_type=eq.ENTRY&fired_at=gte.' + since30 + '&select=score,metadata,strategy_name',
            { headers: wmsHeaders() });
        if (sc.ok) {
            var entries = (await sc.json()).filter(function (s) {
                return autoIsPairs(fam, s.strategy_name);
            });
            _auPairsMetrics.signalsIn30d = entries.length;
            // Avg Z at entry — from metadata.Z90 field (per legacy render at line 2056)
            var zVals = entries.map(function (s) { return s.metadata && s.metadata.Z90 != null ? Math.abs(Number(s.metadata.Z90)) : null; })
                               .filter(function (v) { return v != null && !isNaN(v); });
            if (zVals.length > 0) {
                _auPairsMetrics.avgZ = zVals.reduce(function (a, b) { return a + b; }, 0) / zVals.length;
                _auPairsMetrics.avgZN = zVals.length;
            } else { _auPairsMetrics.avgZ = null; _auPairsMetrics.avgZN = null; }
        }

        // Last scan = latest auto_runs finished_at for any non-GS non-utility strategy
        var lr = await fetch(SUPABASE_URL + '/rest/v1/auto_runs?order=finished_at.desc&limit=20&select=strategy_name,finished_at',
            { headers: wmsHeaders() });
        if (lr.ok) {
            var runs = await lr.json();
            var lastPairsRun = runs.find(function (r) {
                return autoIsPairs(fam, r.strategy_name);
            });
            _auPairsMetrics.lastScanAt = lastPairsRun ? lastPairsRun.finished_at : null;
        }

        autoRenderPairsFamMetrics();
    } catch (_e) { /* silent */ }
}

// ----- Signals & Events tab -------------------------------------------------
async function autoLoadPairsFamEvents(filterOverride) {
    var el = document.getElementById('au-pairs-fam-events-content');
    var statusEl = document.getElementById('au-pairs-fam-events-status');
    if (!el) return;
    var sel = document.getElementById('au-pairs-fam-events-filter');
    var filter = filterOverride && typeof filterOverride === 'string' && filterOverride !== '[object Event]'
        ? filterOverride : (sel ? sel.value : 'all');
    if (sel && filter !== sel.value) sel.value = filter;
    if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }

    try {
        var fam = await autoGetStrategyFamilies();
        // Ideally we'd filter server-side; PostgREST doesn't support "not in (...)"
        // cleanly for arbitrary sets, so overfetch + client-filter (limit 300).
        var qs = '?order=fired_at.desc&limit=300&select=id,trade_id,strategy_name,fired_at,event_type,direction,score,metadata,source,email_status';
        if (filter === 'ENTRY')     qs += '&event_type=eq.ENTRY';
        else if (filter === 'EXIT') qs += '&event_type=neq.ENTRY';
        else if (filter === 'email-failed') qs += '&email_status=eq.FAILED';   // see autoLoadGsFamEvents (Phase E.2b)
        var r = await fetch(SUPABASE_URL + '/rest/v1/auto_signals' + qs, { headers: wmsHeaders() });
        var all = r.ok ? await r.json() : [];
        var rows = (all || []).filter(function (s) {
            return autoIsPairs(fam, s.strategy_name);
        }).slice(0, 200);

        if (rows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No pairs events match this filter.</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 events'; }
            return;
        }

        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left;position:sticky;top:0;z-index:1">' +
                '<th style="padding:6px 8px">Time (IST)</th>' +
                '<th style="padding:6px 8px">Strategy</th>' +
                '<th style="padding:6px 8px">Pair</th>' +
                '<th style="padding:6px 8px">Event</th>' +
                '<th style="padding:6px 8px">Side</th>' +
                '<th style="padding:6px 8px;text-align:right">Score</th>' +
                '<th style="padding:6px 8px;text-align:right">Z90</th>' +
                '<th style="padding:6px 8px">Email</th>' +
                '<th style="padding:6px 8px">Trade</th>' +
                '</tr></thead><tbody>';
        rows.forEach(function (s) {
            var m = s.metadata || {};
            var typeColor = s.event_type === 'ENTRY' ? '#047857' :
                           /STOP_HIT|EXIT_STOP/.test(s.event_type) ? '#dc2626' :
                           /TARGET_HIT|EXIT_TARGET/.test(s.event_type) ? '#0891b2' :
                           s.event_type === 'TIME_STOP' ? '#92400e' :
                           /MANUAL/.test(s.event_type) ? '#7c3aed' : '#6b7280';
            var emailBadge = s.email_status === 'SENT' ? '<span class="au-badge success" style="font-size:9px">sent</span>'
                          : s.email_status === 'FAILED' ? '<span class="au-badge error" style="font-size:9px">failed</span>'
                          : s.email_status === 'PENDING' ? '<span class="au-badge loading" style="font-size:9px">pending</span>'
                          : '<span class="au-badge idle" style="font-size:9px">—</span>';
            var tradeFrag = s.trade_id ? s.trade_id.slice(0, 20) : '—';
            var z90 = m.Z90 != null ? Number(m.Z90).toFixed(2) : '—';
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px;white-space:nowrap;font-family:monospace;font-size:11px">' + autoEsc(autoFmtIST(s.fired_at)) + '</td>' +
                    '<td style="padding:6px 8px"><code style="font-size:11px">' + autoEsc(s.strategy_name) + '</code></td>' +
                    '<td style="padding:6px 8px"><b>' + autoEsc(m.Pair || '—') + '</b></td>' +
                    '<td style="padding:6px 8px;color:' + typeColor + ';font-weight:600">' + autoEsc(s.event_type) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(s.direction || m.Action || '—') + '</td>' +
                    '<td style="padding:6px 8px;text-align:right">' + (s.score != null ? s.score : '—') + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums">' + z90 + '</td>' +
                    '<td style="padding:6px 8px">' + emailBadge + '</td>' +
                    '<td style="padding:6px 8px;font-family:monospace;font-size:10px;color:#6b7280" title="' + autoEsc(s.trade_id || '') + '">' + autoEsc(tradeFrag) + '</td>' +
                    '</tr>';
        });
        html += '</tbody></table></div>';
        el.innerHTML = html;
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = rows.length + ' events'; }
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
    }
}

// ----- Run History tab ------------------------------------------------------
async function autoLoadPairsFamRuns(filterOverride) {
    var el = document.getElementById('au-pairs-fam-runs-content');
    var statusEl = document.getElementById('au-pairs-fam-runs-status');
    if (!el) return;
    var sel = document.getElementById('au-pairs-fam-runs-filter');
    var filter = filterOverride && typeof filterOverride === 'string' && filterOverride !== '[object Event]'
        ? filterOverride : (sel ? sel.value : 'all');
    if (sel && filter !== sel.value) sel.value = filter;
    if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }

    try {
        var fam = await autoGetStrategyFamilies();
        var qs = '?order=started_at.desc&limit=200&select=id,strategy_name,started_at,finished_at,duration_ms,status,signals_generated,emails_sent,emails_failed,error';
        if (filter === 'failed')            qs += '&status=eq.FAILED';
        else if (filter === 'with_signals') qs += '&signals_generated=gt.0';
        var r = await fetch(SUPABASE_URL + '/rest/v1/auto_runs' + qs, { headers: wmsHeaders() });
        var all = r.ok ? await r.json() : [];
        var rows = (all || []).filter(function (rn) {
            return autoIsPairs(fam, rn.strategy_name);
        }).slice(0, 100);

        if (rows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No pairs runs match this filter.</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 runs'; }
            return;
        }
        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left;position:sticky;top:0;z-index:1">' +
                '<th style="padding:6px 8px">Started (IST)</th>' +
                '<th style="padding:6px 8px">Strategy</th>' +
                '<th style="padding:6px 8px">Status</th>' +
                '<th style="padding:6px 8px;text-align:right">Signals</th>' +
                '<th style="padding:6px 8px">Email</th>' +
                '<th style="padding:6px 8px;text-align:right">Duration</th>' +
                '<th style="padding:6px 8px">Error</th>' +
                '</tr></thead><tbody>';
        rows.forEach(function (rn) {
            var emailCell = '—';
            if (rn.emails_sent || rn.emails_failed) {
                var sent = rn.emails_sent || 0, failed = rn.emails_failed || 0;
                emailCell = (failed > 0 ? '<span style="color:#dc2626">' + failed + ' failed</span>' : '') +
                            (sent > 0 && failed > 0 ? ' / ' : '') +
                            (sent > 0 ? '<span style="color:#047857">' + sent + ' sent</span>' : '');
            }
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px;white-space:nowrap;font-family:monospace;font-size:11px">' + autoEsc(autoFmtIST(rn.started_at)) + '</td>' +
                    '<td style="padding:6px 8px"><code style="font-size:11px">' + autoEsc(rn.strategy_name) + '</code></td>' +
                    '<td style="padding:6px 8px">' + autoStatusBadge(rn.status) + '</td>' +
                    '<td style="padding:6px 8px;text-align:right">' + (rn.signals_generated != null ? rn.signals_generated : '—') + '</td>' +
                    '<td style="padding:6px 8px;font-size:11px">' + emailCell + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums">' + autoFmtDuration(rn.duration_ms) + '</td>' +
                    '<td style="padding:6px 8px;color:#7f1d1d;font-size:11px;max-width:400px;overflow:hidden;text-overflow:ellipsis" title="' + autoEsc(rn.error || '') + '">' +
                        autoEsc((rn.error || '').slice(0, 100)) + (rn.error && rn.error.length > 100 ? '…' : '') +
                    '</td>' +
                    '</tr>';
        });
        html += '</tbody></table></div>';
        el.innerHTML = html;
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = rows.length + ' runs'; }
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
    }
}

// ----- Controls & Admin tab -------------------------------------------------
async function autoLoadPairsFamAdmin() {
    var fam = await autoGetStrategyFamilies();

    // 1. Strategy config table
    var stratsEl = document.getElementById('au-pairs-fam-strategies');
    if (stratsEl) {
        try {
            var r = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?select=*', { headers: wmsHeaders() });
            var all = r.ok ? await r.json() : [];
            _auCacheStrategies(all);
            var rows = all.filter(function (s) { return autoIsPairs(fam, s.name); });
            if (rows.length === 0) {
                stratsEl.innerHTML = '<div class="au-soon">No pairs strategies configured.</div>';
            } else {
                var html = '<table style="width:100%;font-size:12px;border-collapse:collapse">';
                html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                        '<th style="padding:6px 8px">Name</th>' +
                        '<th style="padding:6px 8px">Enabled</th>' +
                        '<th style="padding:6px 8px">Mode</th>' +
                        '<th style="padding:6px 8px">Version</th>' +
                        '<th style="padding:6px 8px">Metadata</th>' +
                        '<th style="padding:6px 8px">Actions</th>' +
                        '</tr></thead><tbody>';
                rows.forEach(function (s) {
                    var meta = s.metadata ? JSON.stringify(s.metadata) : '—';
                    html += '<tr style="border-top:1px solid #e5e7eb">' +
                            '<td style="padding:6px 8px"><code>' + autoEsc(s.name) + '</code></td>' +
                            '<td style="padding:6px 8px">' + (s.enabled ? '<span class="au-badge success">yes</span>' : '<span class="au-badge error">no</span>') + '</td>' +
                            '<td style="padding:6px 8px"><b>' + autoEsc(s.execution_mode || '—') + '</b></td>' +
                            '<td style="padding:6px 8px;font-family:monospace">' + autoEsc(s.version || '—') + '</td>' +
                            '<td style="padding:6px 8px;font-family:monospace;font-size:10px;color:#6b7280;max-width:500px;overflow:hidden;text-overflow:ellipsis" title="' + autoEsc(meta) + '">' + autoEsc(meta.slice(0, 120)) + (meta.length > 120 ? '…' : '') + '</td>' +
                            '<td style="padding:6px 8px">' + autoStrategyActionCell(s) + '</td>' +
                            '</tr>';
                });
                html += '</tbody></table>';
                stratsEl.innerHTML = html;
            }
        } catch (e) {
            stratsEl.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
        }
    }

    // 2. Scheduling — cron-job.org "all enabled" cron hits automation-runner (no ?strategy=)
    //    5 fixed times/day. Freshness = latest auto_runs across any pairs strategy.
    var schedEl = document.getElementById('au-pairs-fam-scheduling');
    if (schedEl) {
        try {
            var lr = await fetch(SUPABASE_URL + '/rest/v1/auto_runs?order=finished_at.desc&limit=20&select=strategy_name,finished_at,status',
                { headers: wmsHeaders() });
            var runs = lr.ok ? await lr.json() : [];
            var last = runs.find(function (rn) {
                return autoIsPairs(fam, rn.strategy_name);
            });
            var lastCell, badgeCell;
            var STALE_MIN = 60 * 6;  // pairs runs at fixed times; 6h without a run = stale
            if (!last) {
                lastCell = '<span style="color:#9ca3af">never</span>';
                badgeCell = '<span class="au-badge idle" style="font-size:10px">no data</span>';
            } else {
                var ageMin = Math.round((Date.now() - new Date(last.finished_at).getTime()) / 60000);
                var stale = ageMin > STALE_MIN;
                var ago = ageMin < 60 ? (ageMin + 'm ago') : ageMin < 1440 ? (Math.round(ageMin/60) + 'h ago') : (Math.round(ageMin/1440) + 'd ago');
                lastCell = '<span title="' + autoEsc(autoFmtIST(last.finished_at)) + '">' + ago + ' · <code>' + autoEsc(last.strategy_name) + '</code></span>';
                badgeCell = stale ? '<span class="au-badge error" style="font-size:10px">STALE</span>' : '<span class="au-badge success" style="font-size:10px">OK</span>';
            }
            var html = '<table style="width:100%;font-size:12px;border-collapse:collapse">';
            html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                    '<th style="padding:6px 8px">Job</th>' +
                    '<th style="padding:6px 8px">Endpoint (Edge Function)</th>' +
                    '<th style="padding:6px 8px">Cadence</th>' +
                    '<th style="padding:6px 8px">Last run</th>' +
                    '<th style="padding:6px 8px">Status</th>' +
                    '</tr></thead><tbody>';
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px"><b>Pairs scan</b></td>' +
                    '<td style="padding:6px 8px;font-family:monospace;font-size:11px;color:#4b5563">automation-runner (no ?strategy= param)</td>' +
                    '<td style="padding:6px 8px;font-size:11px;color:#4b5563">5 fixed times/day · NSE hours</td>' +
                    '<td style="padding:6px 8px;font-size:11px">' + lastCell + '</td>' +
                    '<td style="padding:6px 8px">' + badgeCell + '</td>' +
                    '</tr></tbody></table>';
            html += '<div style="font-size:11px;color:#6b7280;margin-top:8px;line-height:1.5">' +
                    '• Runner iterates ALL enabled non-GS strategies on the pairs cron (per <code>EXPLICIT_ONLY_STRATEGIES</code> guard).<br>' +
                    '• GS is excluded from this cron path — it has its own 15-min crons (see GS → Controls &amp; Admin).' +
                    '</div>';
            schedEl.innerHTML = html;
        } catch (e) {
            schedEl.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
        }
    }

    // 3. Universe — hard-coded in the strategy plugin; we can only show what
    //    signals reveal. Approximate by extracting unique pair labels from the
    //    last 90d of ENTRY signals.
    var uniEl = document.getElementById('au-pairs-fam-universe');
    if (uniEl) {
        try {
            var since90 = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
            var er = await fetch(SUPABASE_URL + '/rest/v1/auto_signals?event_type=eq.ENTRY&fired_at=gte.' + since90 + '&select=metadata,strategy_name',
                { headers: wmsHeaders() });
            var entries = er.ok ? (await er.json()).filter(function (s) {
                return autoIsPairs(fam, s.strategy_name);
            }) : [];
            var pairSet = new Set();
            entries.forEach(function (s) { if (s.metadata && s.metadata.Pair) pairSet.add(s.metadata.Pair); });
            var pairs = Array.from(pairSet).sort();
            if (pairs.length === 0) {
                uniEl.innerHTML = '<div style="color:#6b7280;font-size:12px">No entry signals in the last 90 days — universe cannot be inferred. Consult the strategy plugin source directly.</div>';
            } else {
                uniEl.innerHTML =
                    '<div style="font-size:12px;color:#4b5563;margin-bottom:6px"><b>' + pairs.length + '</b> unique pairs observed in the last 90d of ENTRY signals:</div>' +
                    '<div style="display:flex;flex-wrap:wrap;gap:6px">' +
                    pairs.map(function (p) { return '<span style="background:#eff6ff;color:#1e40af;padding:2px 8px;border-radius:4px;font-size:11px;font-family:monospace">' + autoEsc(p) + '</span>'; }).join('') +
                    '</div>' +
                    '<div style="font-size:11px;color:#9ca3af;margin-top:8px">' +
                    'Note: this is inferred from signal history, not the strategy plugin\'s configured universe. Silent pairs (no entries in 90d) won\'t appear.' +
                    '</div>';
            }
        } catch (e) {
            uniEl.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
        }
    }
}

// ============================================================================
// KH family page (Phase D — 2026-07-09)
//
// First UI presence for Katalysthive. KH does NOT go through auto_signals;
// its data lives in wms_live_commands (signal_source='katalysthive').
// The Controls & Admin sub-tab DOM-mirrors the Legacy Live Trading panel
// content — SAME live-enforcing widgets, no rebuild. Legacy panel stays fully
// functional in parallel until Phase E.
// ============================================================================

var _AU_KH_SRC = 'katalysthive';
var _auKhMetrics = {
    open: null, ingested24h: null, filled24h: null, rejected24h: null, errors24h: null,
    topRejectReason: null
};

// ----------------------------------------------------------------------------
// KH trade tags (KH-PLAN Phase KH-3, 2026-07-10)
//
// Owner-configured tags applied to every transaction written from a Katalysthive
// fill (KH-4 writes those rows in wms-live-cmd-complete). Stored on the strategy
// row: auto_strategies.metadata.transaction_tags — strategy metadata, not a risk
// limit, so it does not belong in wms_live_risk_limits.
//
// LESSONS A.2.12 forbids the SYSTEM adding/editing/removing tags. These are the
// OWNER's own tags, typed into a UI tag field, merely applied at insert time.
// The carve-out is recorded in A.2.12 — the system still never invents a tag.
//
// Uses the app-wide wmsTagInput widget, so behaviour matches every other tag field.
// ⚠️ The widget captures the `tags` ARRAY REFERENCE at construction. Never reassign
// _auKhTags — mutate it in place, or the pills silently stop updating (B.2.3).
// ----------------------------------------------------------------------------

var _auKhTags = [];
var _auKhTagCtrl = null;

// Distinct tags already in use, for autocomplete. 'blank' excluded (A.2.1).
async function autoGetExistingTags() {
    if (Array.isArray(window._auExistingTags)) return window._auExistingTags;
    var seen = {};
    try {
        var rows = await wmsFetchAllRaw(SUPABASE_URL + '/rest/v1/transactions?select=tags');
        (rows || []).forEach(function (r) {
            (Array.isArray(r.tags) ? r.tags : []).forEach(function (t) {
                var v = String(t || '').trim();
                if (!v || v.toLowerCase() === 'blank') return;
                if (!(v.toLowerCase() in seen)) seen[v.toLowerCase()] = v;
            });
        });
        window._auExistingTags = Object.values(seen).sort();
    } catch (e) {
        console.error('[autoGetExistingTags] failed:', e);
        return [];   // never cache a failure — an empty list would look like "no tags exist"
    }
    return window._auExistingTags;
}

async function autoLoadKhTags() {
    var badge = document.getElementById('au-kh-tags-status');
    var msg   = document.getElementById('au-kh-tags-msg');
    var input = document.getElementById('au-kh-tags-input');
    var pills = document.getElementById('au-kh-tags-pills');
    var dd    = document.getElementById('au-kh-tags-dd');
    if (!input || !pills || !dd) return;
    if (badge) { badge.className = 'au-badge loading'; badge.textContent = 'loading'; }
    try {
        var r = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?name=eq.' + AU_KH.strategy + '&select=metadata',
            { headers: wmsHeaders() });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()));
        var rows = await r.json();
        if (!Array.isArray(rows) || rows.length === 0) throw new Error('strategy row ' + AU_KH.strategy + ' not found');
        var saved = (rows[0].metadata || {}).transaction_tags;

        _auKhTags.length = 0;                                  // mutate in place (B.2.3)
        if (Array.isArray(saved)) Array.prototype.push.apply(_auKhTags, saved);

        var existing = await autoGetExistingTags();
        if (!_auKhTagCtrl) {
            _auKhTagCtrl = wmsTagInput(input, pills, dd, { tags: _auKhTags, existingTags: existing, onChange: function () {} });
        } else if (typeof _auKhTagCtrl.setExistingTags === 'function') {
            _auKhTagCtrl.setExistingTags(existing);
        }
        if (_auKhTagCtrl && typeof _auKhTagCtrl.refresh === 'function') _auKhTagCtrl.refresh();

        if (badge) {
            badge.className = _auKhTags.length ? 'au-badge success' : 'au-badge idle';
            badge.textContent = _auKhTags.length ? _auKhTags.length + ' tag' + (_auKhTags.length === 1 ? '' : 's') : 'none';
        }
        if (msg) msg.textContent = _auKhTags.length
            ? 'Applied to every KH fill written into Trading.'
            : "No tags set — KH trades will import with ['blank'].";
    } catch (e) {
        if (badge) { badge.className = 'au-badge error'; badge.textContent = 'error'; }
        if (msg) msg.innerHTML = '<span style="color:#dc2626">Failed to load: ' + autoEsc(String(e.message || e)) + '</span>';
    }
}

async function autoSaveKhTags() {
    var badge = document.getElementById('au-kh-tags-status');
    var msg   = document.getElementById('au-kh-tags-msg');
    try {
        // Read-modify-write: metadata also carries family + driver (KH-1). PostgREST
        // PATCH replaces the whole jsonb value, so merge — never overwrite.
        var r = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?name=eq.' + AU_KH.strategy + '&select=metadata',
            { headers: wmsHeaders() });
        if (!r.ok) throw new Error('read HTTP ' + r.status + ' ' + (await r.text()));
        var cur = (await r.json())[0];
        if (!cur) throw new Error('strategy row ' + AU_KH.strategy + ' not found');
        var meta = Object.assign({}, cur.metadata || {});
        if (!meta.family || !meta.driver) throw new Error('refusing to save: strategy row is missing family/driver');

        var live = (_auKhTagCtrl && typeof _auKhTagCtrl.getTags === 'function') ? _auKhTagCtrl.getTags() : _auKhTags;

        // B.17.1 — getTags() returns only tags CONFIRMED with Enter / comma / dropdown.
        // Text still sitting in the box is not yet a tag. Typing a tag and clicking
        // Save (without pressing Enter) must not silently discard it.
        var pendingEl = document.getElementById('au-kh-tags-input');
        if (pendingEl && pendingEl.value.trim()) live = live.concat(pendingEl.value.split(/[,;]/));

        var seen = {}, clean = [];
        live.forEach(function (t) {
            var v = String(t || '').trim();
            if (!v || v.toLowerCase() === 'blank') return;     // A.2.1 — 'blank' is the empty marker
            if (v.toLowerCase() in seen) return;
            seen[v.toLowerCase()] = 1; clean.push(v);
        });
        if (clean.length) meta.transaction_tags = clean; else delete meta.transaction_tags;

        var pr = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?name=eq.' + AU_KH.strategy, {
            method: 'PATCH',
            headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
            body: JSON.stringify({ metadata: meta })
        });
        if (!pr.ok) throw new Error('save HTTP ' + pr.status + ' ' + (await pr.text()));

        if (pendingEl) pendingEl.value = '';   // consumed above; don't let it re-apply on the next Save
        if (msg) msg.textContent = 'Saved. Applies to KH fills booked from now on; existing transactions are unchanged.';
        await autoLoadKhTags();   // re-read — never claim success from the local copy
    } catch (e) {
        if (badge) { badge.className = 'au-badge error'; badge.textContent = 'error'; }
        if (msg) msg.innerHTML = '<span style="color:#dc2626">Failed to save: ' + autoEsc(String(e.message || e)) + '</span>';
    }
}

function autoLoadKhFamRefresh() {
    autoLoadKhFamHeader();
    autoLoadKhFamMetrics();
    autoLoadKhFamOpen();
    autoLoadKhFamRecent();
    autoLoadKhFamRejections();
    // This page IS the live-controls surface now (Phase E.1d) — load it directly.
    if (typeof autoLoadLive === 'function') autoLoadLive();
    autoLoadKhTags();
}

// ----- Header (mode pill + last activity) ------------------------------------
async function autoLoadKhFamHeader() {
    try {
        var sr = await fetch(SUPABASE_URL + '/rest/v1/app_state?id=eq.1&select=kill_switch,paused_sources',
            { headers: wmsHeaders() });
        var state = sr.ok ? (await sr.json())[0] || {} : {};
        var paused = (state.paused_sources || []).indexOf(_AU_KH_SRC) !== -1;
        var pill = document.getElementById('au-kh-fam-mode');
        if (pill) {
            if (state.kill_switch)  { pill.className = 'status-pill stopped'; pill.textContent = '🛑 KILL SWITCH'; }
            else if (paused)        { pill.className = 'status-pill paused';  pill.textContent = '⏸ PAUSED'; }
            else                    { pill.className = 'status-pill live';    pill.textContent = '🟢 LIVE'; }
        }
        // Last activity — most-recent wms_live_commands row
        var lr = await fetch(SUPABASE_URL + '/rest/v1/wms_live_commands?signal_source=eq.' + _AU_KH_SRC + '&order=created_at.desc&limit=1&select=created_at,status,broker_status,payload',
            { headers: wmsHeaders() });
        var last = lr.ok ? (await lr.json())[0] : null;
        var laEl = document.getElementById('au-kh-fam-lastact');
        if (laEl) {
            if (last) {
                var ago = Math.round((Date.now() - new Date(last.created_at).getTime()) / 60000);
                var agoStr = ago < 60 ? (ago + 'm ago') : ago < 1440 ? (Math.round(ago/60) + 'h ago') : (Math.round(ago/1440) + 'd ago');
                var sym = (last.payload && last.payload.symbol) || '';
                laEl.textContent = 'Last activity: ' + (last.broker_status || last.status) + (sym ? ' · ' + sym : '') + ' · ' + agoStr;
            } else {
                laEl.textContent = 'Last activity: no commands yet';
            }
        }
    } catch (_e) { /* silent */ }
}

// ----- Metrics --------------------------------------------------------------
async function autoLoadKhFamMetrics() {
    try {
        var since24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        var results = await Promise.all([
            // Open commands (in-flight)
            fetch(SUPABASE_URL + "/rest/v1/wms_live_commands?signal_source=eq." + _AU_KH_SRC + "&status=in.(pending,claimed,placed)&broker_status=is.null&select=id", { headers: wmsHeaders() }),
            // Open commands with broker_status non-terminal
            fetch(SUPABASE_URL + "/rest/v1/wms_live_commands?signal_source=eq." + _AU_KH_SRC + "&status=eq.placed&broker_status=in.(PENDING,OPEN,PARTIAL)&select=id", { headers: wmsHeaders() }),
            // Ingested 24h — count all commands regardless of status
            fetch(SUPABASE_URL + "/rest/v1/wms_live_commands?signal_source=eq." + _AU_KH_SRC + "&created_at=gte." + since24 + "&select=id,status,broker_status,error_code", { headers: wmsHeaders() })
        ]);
        var openNoBroker  = results[0].ok ? await results[0].json() : [];
        var openNonTerm   = results[1].ok ? await results[1].json() : [];
        var last24        = results[2].ok ? await results[2].json() : [];

        _auKhMetrics.open        = openNoBroker.length + openNonTerm.length;
        _auKhMetrics.ingested24h = last24.length;
        _auKhMetrics.filled24h   = last24.filter(function (c) { return c.broker_status === 'FILLED'; }).length;
        _auKhMetrics.rejected24h = last24.filter(function (c) { return c.status === 'rejected'; }).length;
        _auKhMetrics.errors24h   = last24.filter(function (c) { return c.status === 'error'; }).length;

        // Top reject reason
        var codes = {};
        last24.forEach(function (c) {
            if (c.status === 'rejected' && c.error_code) codes[c.error_code] = (codes[c.error_code] || 0) + 1;
        });
        var top = Object.keys(codes).sort(function (a, b) { return codes[b] - codes[a]; })[0];
        _auKhMetrics.topRejectReason = top ? (top + ' (' + codes[top] + ')') : null;

        autoRenderKhFamMetrics();
    } catch (_e) { /* silent */ }
}

function autoRenderKhFamMetrics() {
    var t = _auKhMetrics;
    var setText = function (id, txt, cls) {
        var e = document.getElementById(id);
        if (!e) return;
        e.textContent = txt;
        if (cls !== undefined) e.className = 'metric-value ' + cls;
    };
    var setSub = function (id, txt) { var e = document.getElementById(id); if (e) e.textContent = txt || ''; };

    if (t.open != null)        { setText('au-kh-fam-metric-open', String(t.open), ''); setSub('au-kh-fam-metric-open-sub', 'pending / claimed / working'); }
    if (t.ingested24h != null) { setText('au-kh-fam-metric-ingested', String(t.ingested24h), ''); setSub('au-kh-fam-metric-ingested-sub', 'all statuses'); }
    if (t.filled24h != null)   { setText('au-kh-fam-metric-filled', String(t.filled24h), t.filled24h > 0 ? 'pos' : ''); setSub('au-kh-fam-metric-filled-sub', 'broker_status=FILLED'); }
    if (t.rejected24h != null) {
        setText('au-kh-fam-metric-rejected', String(t.rejected24h), t.rejected24h > 0 ? 'neg' : '');
        setSub('au-kh-fam-metric-rejected-sub', t.topRejectReason ? ('top: ' + t.topRejectReason) : 'status=rejected');
    }
    if (t.errors24h != null)   { setText('au-kh-fam-metric-errors', String(t.errors24h), t.errors24h > 0 ? 'neg' : ''); setSub('au-kh-fam-metric-errors-sub', 'status=error'); }
}

// ----- KH commands renderers ------------------------------------------------
function _autoKhStatusPill(status, brokerStatus) {
    var t = brokerStatus || status || '—';
    var cls = 'idle', color = '#6b7280';
    if (brokerStatus === 'FILLED')                                { cls = 'success'; color = '#047857'; }
    else if (brokerStatus === 'PARTIAL')                          { cls = 'loading'; color = '#0891b2'; }
    else if (brokerStatus === 'PENDING' || brokerStatus === 'OPEN'){ cls = 'loading'; color = '#0891b2'; }
    else if (brokerStatus === 'REJECTED')                         { cls = 'error';   color = '#dc2626'; }
    else if (brokerStatus === 'CANCELLED' || brokerStatus === 'EXPIRED') { cls = 'idle'; color = '#7f1d1d'; }
    else if (status === 'rejected')                               { cls = 'error';   color = '#dc2626'; }
    else if (status === 'error')                                  { cls = 'error';   color = '#dc2626'; }
    else if (status === 'placed')                                 { cls = 'loading'; color = '#0891b2'; }
    else if (status === 'claimed')                                { cls = 'loading'; color = '#0891b2'; }
    return '<span class="au-badge ' + cls + '" style="color:' + color + '">' + autoEsc(t) + '</span>';
}

function _autoKhCmdRow(c) {
    var p = c.payload || {};
    var symbol = p.symbol || '—';
    var side = p.side === 1 ? 'BUY' : p.side === -1 ? 'SELL' : (p.side || '—');
    var sideCell = side === 'BUY'  ? '<span class="au-badge success">BUY</span>'
                : side === 'SELL' ? '<span class="au-badge error">SELL</span>'
                : autoEsc(String(side));
    var qty = p.qty != null ? p.qty : '—';
    var filled = c.filled_qty != null ? c.filled_qty : 0;
    var qtyCell = qty + (filled > 0 && filled !== qty ? ' <span style="color:#0891b2;font-size:10px">(' + filled + ' filled)</span>' : '');
    var typeMap = { 1: 'LIMIT', 2: 'MARKET', 3: 'STOP', 4: 'STOPLIMIT' };
    var type = typeMap[p.type] || p.type || '—';
    var price = c.avg_fill_price != null ? autoFmtPrice0(Number(c.avg_fill_price))
              : (p.limitPrice != null ? autoFmtPrice0(Number(p.limitPrice)) : '—');
    var errCell = c.error_code
        ? '<span style="color:#dc2626;font-weight:600" title="' + autoEsc(c.error_message || '') + '">' + autoEsc(c.error_code) + '</span>'
        : '';
    return '<tr style="border-top:1px solid #e5e7eb">' +
           '<td style="padding:6px 8px;white-space:nowrap;font-family:monospace;font-size:11px">' + autoEsc(autoFmtIST(c.created_at)) + '</td>' +
           '<td style="padding:6px 8px;font-family:monospace;font-size:11px">' + autoEsc(symbol) + '</td>' +
           '<td style="padding:6px 8px">' + sideCell + '</td>' +
           '<td style="padding:6px 8px;text-align:right">' + qtyCell + '</td>' +
           '<td style="padding:6px 8px;font-size:11px">' + autoEsc(String(type)) + '</td>' +
           '<td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums">' + price + '</td>' +
           '<td style="padding:6px 8px">' + _autoKhStatusPill(c.status, c.broker_status) + '</td>' +
           '<td style="padding:6px 8px;font-family:monospace;font-size:10px;color:#6b7280">' + autoEsc(c.broker_order_id || '') + '</td>' +
           '<td style="padding:6px 8px;font-size:11px">' + errCell + '</td>' +
           '</tr>';
}

// ----- Open Commands tab ----------------------------------------------------
async function autoLoadKhFamOpen() {
    var el = document.getElementById('au-kh-fam-open-content');
    var badge = document.getElementById('au-kh-fam-open-badge');
    if (!el) return;
    if (badge) { badge.className = 'au-badge loading'; badge.textContent = 'loading'; }
    try {
        // Open = not-yet-terminal. Three categories:
        //  (a) status IN (pending, claimed) — Droplet hasn't finalized broker call
        //  (b) status=placed AND broker_status IN (PENDING, OPEN, PARTIAL) — with broker
        //  (c) status=placed AND broker_status IS NULL — placed but no update yet
        //      (rare + transient post-F2 orders-monitoring, but defensively included)
        var qs = '?signal_source=eq.' + _AU_KH_SRC +
                 '&or=(status.in.(pending,claimed),and(status.eq.placed,or(broker_status.is.null,broker_status.in.(PENDING,OPEN,PARTIAL))))' +
                 '&order=created_at.desc&limit=50' +
                 '&select=id,created_at,status,broker_status,broker_order_id,filled_qty,avg_fill_price,payload,error_code,error_message';
        var r = await fetch(SUPABASE_URL + '/rest/v1/wms_live_commands' + qs, { headers: wmsHeaders() });
        var rows = r.ok ? await r.json() : [];
        if (!Array.isArray(rows) || rows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No open Katalysthive commands.</div>';
            if (badge) { badge.className = 'au-badge idle'; badge.textContent = '0 open'; }
            return;
        }
        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left;position:sticky;top:0;z-index:1">' +
                '<th style="padding:6px 8px">Created (IST)</th>' +
                '<th style="padding:6px 8px">Symbol</th>' +
                '<th style="padding:6px 8px">Side</th>' +
                '<th style="padding:6px 8px;text-align:right">Qty</th>' +
                '<th style="padding:6px 8px">Type</th>' +
                '<th style="padding:6px 8px;text-align:right">Price</th>' +
                '<th style="padding:6px 8px">Status</th>' +
                '<th style="padding:6px 8px">Broker order</th>' +
                '<th style="padding:6px 8px">Error</th>' +
                '</tr></thead><tbody>';
        rows.forEach(function (c) { html += _autoKhCmdRow(c); });
        html += '</tbody></table></div>';
        el.innerHTML = html;
        if (badge) { badge.className = 'au-badge success'; badge.textContent = rows.length + ' open'; }
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
        if (badge) { badge.className = 'au-badge error'; badge.textContent = 'error'; }
    }
}

// ----- Recent Activity tab --------------------------------------------------
async function autoLoadKhFamRecent(filterOverride) {
    var el = document.getElementById('au-kh-fam-recent-content');
    var statusEl = document.getElementById('au-kh-fam-recent-status');
    var badge = document.getElementById('au-kh-fam-recent-badge');
    if (!el) return;
    var sel = document.getElementById('au-kh-fam-recent-filter');
    var filter = filterOverride && typeof filterOverride === 'string' && filterOverride !== '[object Event]'
        ? filterOverride : (sel ? sel.value : 'all');
    if (sel && filter !== sel.value) sel.value = filter;
    if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }
    if (badge) { badge.className = 'au-badge loading'; badge.textContent = 'loading'; }

    try {
        var qs = '?signal_source=eq.' + _AU_KH_SRC + '&order=created_at.desc&limit=100' +
                 '&select=id,created_at,status,broker_status,broker_order_id,filled_qty,avg_fill_price,payload,error_code,error_message';
        if (filter === 'terminal') qs += '&or=(status.in.(rejected,error,cancelled),broker_status.in.(FILLED,REJECTED,CANCELLED,EXPIRED))';
        else if (filter === 'rejected') qs += '&status=eq.rejected';
        var r = await fetch(SUPABASE_URL + '/rest/v1/wms_live_commands' + qs, { headers: wmsHeaders() });
        var rows = r.ok ? await r.json() : [];
        if (!Array.isArray(rows) || rows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No commands match this filter.</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0'; }
            if (badge) { badge.className = 'au-badge idle'; badge.textContent = '0'; }
            return;
        }
        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left;position:sticky;top:0;z-index:1">' +
                '<th style="padding:6px 8px">Created (IST)</th>' +
                '<th style="padding:6px 8px">Symbol</th>' +
                '<th style="padding:6px 8px">Side</th>' +
                '<th style="padding:6px 8px;text-align:right">Qty</th>' +
                '<th style="padding:6px 8px">Type</th>' +
                '<th style="padding:6px 8px;text-align:right">Price</th>' +
                '<th style="padding:6px 8px">Status</th>' +
                '<th style="padding:6px 8px">Broker order</th>' +
                '<th style="padding:6px 8px">Error</th>' +
                '</tr></thead><tbody>';
        rows.forEach(function (c) { html += _autoKhCmdRow(c); });
        html += '</tbody></table></div>';
        el.innerHTML = html;
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = rows.length + ' rows'; }
        if (badge) { badge.className = 'au-badge success'; badge.textContent = rows.length; }
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
        if (badge) { badge.className = 'au-badge error'; badge.textContent = 'error'; }
    }
}

// ----- Rejections tab -------------------------------------------------------
async function autoLoadKhFamRejections() {
    var el = document.getElementById('au-kh-fam-rejections-content');
    if (!el) return;
    try {
        var since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
        var qs = '?signal_source=eq.' + _AU_KH_SRC + '&status=eq.rejected&created_at=gte.' + since30 +
                 '&order=created_at.desc&limit=200&select=id,created_at,error_code,error_message,payload';
        var r = await fetch(SUPABASE_URL + '/rest/v1/wms_live_commands' + qs, { headers: wmsHeaders() });
        var rows = r.ok ? await r.json() : [];
        if (rows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No rejections in the last 30 days. ✅</div>';
            return;
        }
        // Group by error_code for breakdown chart
        var byCode = {};
        rows.forEach(function (c) {
            var k = c.error_code || 'UNKNOWN';
            if (!byCode[k]) byCode[k] = { count: 0, latest: null, sample: null };
            byCode[k].count += 1;
            if (!byCode[k].latest || c.created_at > byCode[k].latest) {
                byCode[k].latest = c.created_at;
                byCode[k].sample = c.error_message || '';
            }
        });
        var codes = Object.keys(byCode).sort(function (a, b) { return byCode[b].count - byCode[a].count; });
        var maxCount = byCode[codes[0]].count;

        var html = '<div class="au-card"><h3>Rejection breakdown (last 30d)</h3>';
        html += '<div style="margin-top:12px;font-size:12px">';
        codes.forEach(function (code) {
            var info = byCode[code];
            var pct = Math.round((info.count / maxCount) * 100);
            html += '<div style="margin-bottom:8px">' +
                    '<div style="display:flex;justify-content:space-between;margin-bottom:2px">' +
                    '<b style="color:#7f1d1d">' + autoEsc(code) + '</b>' +
                    '<span style="color:#4b5563">' + info.count + ' · latest ' + autoEsc(autoFmtIST(info.latest)) + '</span>' +
                    '</div>' +
                    '<div style="background:#fee2e2;border-radius:4px;height:6px;overflow:hidden">' +
                    '<div style="background:#dc2626;height:100%;width:' + pct + '%"></div>' +
                    '</div>' +
                    (info.sample ? '<div style="font-size:11px;color:#6b7280;margin-top:2px">' + autoEsc(info.sample.slice(0, 200)) + '</div>' : '') +
                    '</div>';
        });
        html += '</div></div>';

        // Full list
        html += '<div class="au-card" style="margin-top:12px"><h3>All rejections (last 30d)</h3>';
        html += '<div style="overflow-x:auto;margin-top:8px"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Created (IST)</th>' +
                '<th style="padding:6px 8px">Symbol</th>' +
                '<th style="padding:6px 8px">Error code</th>' +
                '<th style="padding:6px 8px">Message</th>' +
                '</tr></thead><tbody>';
        rows.forEach(function (c) {
            var sym = (c.payload && c.payload.symbol) || '—';
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px;white-space:nowrap;font-family:monospace;font-size:11px">' + autoEsc(autoFmtIST(c.created_at)) + '</td>' +
                    '<td style="padding:6px 8px;font-family:monospace;font-size:11px">' + autoEsc(sym) + '</td>' +
                    '<td style="padding:6px 8px;color:#7f1d1d;font-weight:600">' + autoEsc(c.error_code || 'UNKNOWN') + '</td>' +
                    '<td style="padding:6px 8px;font-size:11px;color:#4b5563">' + autoEsc((c.error_message || '').slice(0, 200)) + '</td>' +
                    '</tr>';
        });
        html += '</tbody></table></div></div>';
        el.innerHTML = html;
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
    }
}

async function autoLoadGsFamHeader() {
    try {
        // Mode: read auto_strategies.execution_mode for silver + gold
        var sr = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?metadata->>family=eq.gs&select=name,enabled,execution_mode,version,metadata',
            { headers: wmsHeaders() });
        var strategies = sr.ok ? await sr.json() : [];
        var pill = document.getElementById('au-gs-fam-mode');
        if (pill) {
            var anyLive = strategies.some(function (s) { return s.execution_mode === 'LIVE'; });
            var allEnabled = strategies.length > 0 && strategies.every(function (s) { return s.enabled; });
            if (anyLive)         { pill.className = 'status-pill live';    pill.textContent = '🟢 LIVE'; }
            else if (allEnabled) { pill.className = 'status-pill paper';   pill.textContent = '🟡 PAPER'; }
            else                 { pill.className = 'status-pill stopped'; pill.textContent = '⏹ DISABLED'; }
        }
        // Version card is now driven by the FILTERED closed trades (owner request,
        // 2026-07-22): it shows the distinct strategy versions present in the rows the
        // Closed-Trades filter bar currently selects. Written solely in
        // autoRenderGsFamMetrics from _auGsTotals.filteredVersions — the header no longer
        // writes it (it would race the filtered value with the deployed-config version).
        // Last activity: most recent auto_signals row for GS strategies
        var ar = await fetch(SUPABASE_URL + '/rest/v1/auto_signals?' + auGsNameFilter() + '&order=fired_at.desc&limit=1&select=fired_at,event_type,strategy_name',
            { headers: wmsHeaders() });
        var last = ar.ok ? (await ar.json())[0] : null;
        var laEl = document.getElementById('au-gs-fam-lastact');
        if (laEl) {
            if (last) {
                var ago = Math.round((Date.now() - new Date(last.fired_at).getTime()) / 60000);
                var agoStr = ago < 60 ? (ago + 'm ago') : ago < 1440 ? (Math.round(ago/60) + 'h ago') : (Math.round(ago/1440) + 'd ago');
                laEl.textContent = 'Last activity: ' + last.event_type + ' · ' + last.strategy_name.replace('_mini_15m', '') + ' · ' + agoStr;
            } else {
                laEl.textContent = 'Last activity: no signals yet';
            }
        }
    } catch (e) {
        // Silent — header is nice-to-have, not critical
    }
}

function autoRenderGsFamMetrics(mode) {
    var t = (_auGsTotals && _auGsTotals[mode]) || {};
    var p = 'au-gs-' + mode + '-metric-';
    var fmt = function (n) { if (n == null) return '—'; return '₹' + Math.round(n).toLocaleString('en-IN'); };
    var fmtSigned = function (n) {
        if (n == null) return '—';
        var sign = n >= 0 ? '+' : '−';
        return sign + '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN');
    };
    var setText = function (id, txt, cls) {
        var e = document.getElementById(id);
        if (!e) return;
        e.textContent = txt;
        if (cls !== undefined) e.className = 'metric-value ' + cls;
    };
    var setSub = function (id, txt) {
        var e = document.getElementById(id);
        if (e) e.textContent = txt || '';
    };

    // Open positions
    if (t.openCount != null) {
        setText(p + 'open', t.openCount + (t.openCount === 1 ? ' trade' : ' trades'), '');
        setSub(p + 'open-sub', t.openExposure != null ? ('exposure ' + fmt(t.openExposure)) : '');
    }
    // Live P&L on open
    if (t.openLivePnl != null) {
        var pnl = t.openLivePnl;
        setText(p + 'livepnl', fmtSigned(pnl), pnl >= 0 ? 'pos' : 'neg');
        var pct = null;
        if (t.openExposure && t.openExposure !== 0) pct = (pnl / t.openExposure) * 100;
        setSub(p + 'livepnl-sub', pct != null ? ((pct >= 0 ? '+' : '−') + Math.abs(pct).toFixed(2) + '% of exposure') : '');
    } else if (t.openCount === 0) {
        setText(p + 'livepnl', '—', '');
        setSub(p + 'livepnl-sub', 'no open positions');
    }
    // Realised (all-time closed)
    if (t.closedRealisedPnl != null) {
        setText(p + 'realised', fmtSigned(t.closedRealisedPnl), t.closedRealisedPnl >= 0 ? 'pos' : 'neg');
        var w = t.closedWins || 0, l = t.closedLosses || 0, tot = w + l;
        setSub(p + 'realised-sub', tot > 0 ? (w + ' wins · ' + l + ' losses · ' + tot + ' closed') : '');
    }
    // Peak exposure — respects ALL the closed-trade filters (source, instrument,
    // version, result, exit). The sub-label flags when it is scoped rather than whole-book.
    if (t.peakExposure != null) {
        setText(p + 'peak', fmt(t.peakExposure), '');
        var srcLabel = '';
        if (t.peakSourceFilter === 'chassis')    srcLabel = ' · runner only';
        else if (t.peakSourceFilter === 'tv_webhook') srcLabel = ' · TV webhook only';
        if (t.peakFiltered) srcLabel += ' · filtered';
        setSub(p + 'peak-sub',
            (t.peakMargin != null ? ('peak margin ' + fmt(t.peakMargin)) : '') + srcLabel);
    }
    // Version — distinct strategy versions present in the FILTERED closed trades.
    if (t.filteredVersions != null) {
        setText(p + 'version', t.filteredVersions.length ? t.filteredVersions.join(' / ') : '—', '');
    }
}

// ----------------------------------------------------------------------------
// Health page renderers (Phase A — kill switch + families board + crons + errors)
// ----------------------------------------------------------------------------

function autoHealthLoadAll() {
    autoHealthLoadKill();
    autoHealthLoadFamilies();
    autoHealthLoadCrons();
    autoHealthLoadErrors();
    autoHealthLoadPlatformRuns();
}

// ----------------------------------------------------------------------------
// Health page — Platform Maintenance (2026-07-09; de-mirrored Phase E.1c 2026-07-10).
//
// The Legacy Admin utilities (EOD ingest, market_prices snapshot, Strategy
// Runner) now render straight into BOTH surfaces via autoTarget() /
// autoBadgeTarget(). The old MutationObserver mirror is gone. Buttons were
// already class-based (.au-eod-btn / .au-runner-btn) so both surfaces enable and
// disable together with no extra wiring.
// ----------------------------------------------------------------------------

var _auHealthState = null;

async function autoHealthLoadKill() {
    try {
        var r = await fetch(SUPABASE_URL + '/rest/v1/app_state?id=eq.1&select=kill_switch,paused_sources,updated_at,updated_by,updated_reason',
            { headers: wmsHeaders() });
        var rows = r.ok ? await r.json() : [];
        _auHealthState = (rows && rows[0]) || { kill_switch: false, paused_sources: [] };
        autoHealthRenderKill();
    } catch (e) {
        var el = document.getElementById('au-health-kill-label');
        if (el) el.textContent = 'Failed to load: ' + (e.message || e);
    }
}

function autoHealthRenderKill() {
    var s = _auHealthState || {};
    var on = !!s.kill_switch;
    var badge = document.getElementById('au-health-kill-badge');
    var label = document.getElementById('au-health-kill-label');
    var btn   = document.getElementById('au-health-kill-btn');
    var meta  = document.getElementById('au-health-kill-meta');
    if (badge) {
        badge.className = 'status-pill ' + (on ? 'stopped' : 'live');
        badge.textContent = on ? 'TRIPPED' : 'ARMED';
    }
    if (label) {
        label.className = 'kill-state-label ' + (on ? 'tripped' : 'armed');
        label.textContent = on ? '🛑 Kill switch is TRIPPED — ALL strategies halted' : '✅ Kill switch is ARMED — strategies allowed to trade';
    }
    if (btn) {
        btn.disabled = false;
        btn.className = 'kill-btn ' + (on ? 'arm' : 'trip');
        btn.textContent = on ? 'Resume all' : 'Trip kill switch';
    }
    if (meta) {
        var ts = s.updated_at ? new Date(s.updated_at).toLocaleString() : '';
        var who = s.updated_by || '';
        var why = s.updated_reason || '';
        meta.textContent = ts ? ('Last change: ' + ts + (who ? ' by ' + who : '') + (why ? ' — ' + why : '')) : '';
    }
}

async function autoHealthToggleKill() {
    if (!_auHealthState) return;
    var on = !!_auHealthState.kill_switch;
    var msg = on
        ? 'Resume — turn the kill switch OFF?\n\nAll LIVE order placement is re-enabled from the next signal onwards.'
        : '⚠️ TRIP the master kill switch?\n\nHalts all LIVE order placement broker-wide:\n• Katalysthive inbound signals are rejected (HTTP 503 KILL_SWITCH)\n• Droplet stops dispensing queued orders (poller returns kill_switch:true)\n\nReversible — toggle OFF to resume. No queue is destroyed, no data is lost.\n\nGS PAPER continues writing signals to auto_signals (chassis doesn\'t check kill_switch yet — see task #43); no orders reach any broker regardless.';
    if (!confirm(msg)) return;
    try {
        var patch = {
            kill_switch: !on,
            updated_by: (window.currentUser && window.currentUser.email) || 'app',
            updated_reason: (on ? 'Resume from' : 'Trip') + ' kill switch (Health page)'
        };
        var r = await fetch(SUPABASE_URL + '/rest/v1/app_state?id=eq.1',
            { method: 'PATCH', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }), body: JSON.stringify(patch) });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()));
        autoHealthLoadKill();
        // The KH page renders the same app_state row (kill switch + KH pause).
        // Re-read it so both surfaces agree immediately. (Pre-E.1d this reset a
        // window._auLiveLoaded cache flag on the Legacy Live Trading tab.)
        if (document.getElementById('au-kh-fam-live-controls')) autoLoadLive();
    } catch (e) {
        alert('Failed to toggle kill switch: ' + (e.message || e));
    }
}

async function autoHealthLoadFamilies() {
    var tbody = document.getElementById('au-health-families-body');
    if (!tbody) return;
    try {
        var results = await Promise.all([
            fetch(SUPABASE_URL + '/rest/v1/auto_strategies?select=name,enabled,execution_mode,version', { headers: wmsHeaders() }),
            fetch(SUPABASE_URL + '/rest/v1/v_auto_open_trades?select=strategy_name,net_qty', { headers: wmsHeaders() }),
            fetch(SUPABASE_URL + '/rest/v1/app_state?id=eq.1&select=kill_switch,paused_sources', { headers: wmsHeaders() }),
            fetch(SUPABASE_URL + '/rest/v1/wms_live_commands?signal_source=eq.katalysthive&status=in.(PENDING,WORKING,PLACED)&select=trade_id,quantity', { headers: wmsHeaders() })
        ]);
        var strategies = results[0].ok ? await results[0].json() : [];
        var openLegs   = results[1].ok ? await results[1].json() : [];
        var stateRows  = results[2].ok ? await results[2].json() : [];
        var khOpen     = results[3].ok ? await results[3].json() : [];
        var state = (stateRows && stateRows[0]) || { kill_switch: false, paused_sources: [] };
        var paused = state.paused_sources || [];

        var families = [
            { key: 'gs',    label: '🥈🥇 GS — Silver & Gold', matcher: auGsIsFamilyName, sources: ['chassis', 'tv_webhook'] },
            { key: 'kh',    label: '🐦 Katalysthive — sharanaga_v1', matcher: null, sources: ['katalysthive'], external: true },
            { key: 'pairs', label: '🔗 Pairs Scanner',              matcher: function (n) { return n && n.indexOf('pairs') === 0; }, sources: ['chassis'] }
        ];

        var rows = families.map(function (f) {
            if (f.external) {
                var isPaused = paused.indexOf('katalysthive') !== -1;
                var status, statusLabel;
                if (state.kill_switch) { status = 'stopped'; statusLabel = '🛑 STOPPED'; }
                else if (isPaused)     { status = 'paused';  statusLabel = '⏸ PAUSED'; }
                else                   { status = 'live';    statusLabel = '🟢 LIVE'; }
                return { key: f.key, label: f.label, mode: 'LIVE', status: status, statusLabel: statusLabel, open: khOpen.length + ' cmd', pnl: '—', activity: '—' };
            }
            var matching = strategies.filter(function (s) { return f.matcher(s.name); });
            var enabled = matching.some(function (s) { return s.enabled; });
            var mode = matching.some(function (s) { return s.execution_mode === 'LIVE'; }) ? 'LIVE' : 'PAPER';
            var openLots = openLegs.filter(function (l) { return f.matcher(l.strategy_name); }).length;
            var isPaused = f.sources.some(function (src) { return paused.indexOf(src) !== -1; });
            var status = 'building', statusLabel = '🔨 EMPTY';
            if (matching.length > 0) {
                if (state.kill_switch)      { status = 'stopped'; statusLabel = '🛑 STOPPED'; }
                else if (!enabled)          { status = 'stopped'; statusLabel = '⏹ DISABLED'; }
                else if (isPaused)          { status = 'paused';  statusLabel = '⏸ PAUSED'; }
                else if (mode === 'LIVE')   { status = 'live';    statusLabel = '🟢 LIVE'; }
                else                        { status = 'paper';   statusLabel = '🟡 PAPER'; }
            }
            return { key: f.key, label: f.label, mode: mode, status: status, statusLabel: statusLabel, open: openLots + ' legs', pnl: '—', activity: '—' };
        });

        tbody.innerHTML = rows.map(function (r) {
            return '<tr class="clickable" onclick="autoSwitchFamily(\'' + r.key + '\')">'
                + '<td><b>' + r.label + '</b></td>'
                + '<td>' + r.mode + '</td>'
                + '<td><span class="status-pill ' + r.status + '">' + r.statusLabel + '</span></td>'
                + '<td>' + r.open + '</td>'
                + '<td>' + r.pnl + '</td>'
                + '<td>' + r.activity + '</td>'
                + '</tr>';
        }).join('');
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6" style="color:#b91c1c;padding:12px">Failed: ' + (e.message || e) + '</td></tr>';
    }
}

async function autoHealthLoadCrons() {
    var el = document.getElementById('au-health-crons');
    if (!el) return;
    var jobs = [
        { name: 'automation-runner (5-min)', strategy: null,           staleMinutes: 15 },
        { name: 'eod-prices-ingest (daily)', strategy: '_eod_ingest',  staleMinutes: 60 * 30 },
        { name: 'fyers-auto-login (daily)',  strategy: '_fyers_login', staleMinutes: 60 * 30 }
    ];
    try {
        var results = await Promise.all(jobs.map(function (j) {
            var q = j.strategy
                ? '/rest/v1/auto_runs?strategy_name=eq.' + encodeURIComponent(j.strategy) + '&order=finished_at.desc&limit=1&select=finished_at,status'
                : '/rest/v1/auto_runs?order=finished_at.desc&limit=1&select=finished_at,status';
            return fetch(SUPABASE_URL + q, { headers: wmsHeaders() }).then(function (r) { return r.ok ? r.json() : []; });
        }));
        var now = Date.now();
        el.innerHTML = jobs.map(function (j, i) {
            var row = results[i][0];
            if (!row || !row.finished_at) {
                return '<li><span class="cron-name">' + j.name + '</span><span class="cron-time">never</span><span class="cron-badge na">no data</span></li>';
            }
            var ageMin = Math.round((now - new Date(row.finished_at).getTime()) / 60000);
            var stale = ageMin > j.staleMinutes;
            var label = ageMin < 60 ? (ageMin + 'm ago') : ageMin < 1440 ? (Math.round(ageMin / 60) + 'h ago') : (Math.round(ageMin / 1440) + 'd ago');
            return '<li><span class="cron-name">' + j.name + '</span><span class="cron-time">' + label + '</span><span class="cron-badge ' + (stale ? 'stale' : 'ok') + '">' + (stale ? 'STALE' : 'OK') + '</span></li>';
        }).join('');
    } catch (e) {
        el.innerHTML = '<li><span class="cron-name">Load failed</span><span class="cron-badge stale">' + (e.message || e) + '</span></li>';
    }
}

async function autoHealthLoadErrors() {
    var el = document.getElementById('au-health-errors');
    if (!el) return;
    try {
        var since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        // auto_runs.status domain is SUCCESS / FAILED / RUNNING (NOT lowercase
        // 'error'), and the message column is `error` (NOT `error_message`).
        // With the wrong column in ?select= PostgREST 400s, r.ok is false, rows
        // becomes [], and this card rendered a GREEN "no failed runs" on every
        // load — a monitoring card that could not report a failure. Fixed E.1c.
        var q = '/rest/v1/auto_runs?status=eq.FAILED&started_at=gte.' + since + '&order=started_at.desc&limit=20&select=strategy_name,started_at,error';
        var r = await fetch(SUPABASE_URL + q, { headers: wmsHeaders() });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()));
        var rows = await r.json();
        if (rows.length === 0) {
            el.innerHTML = '<div style="color:#16a34a;font-weight:600">✅ No failed runs in the last 24h.</div>';
            return;
        }
        el.innerHTML = '<div style="color:#b91c1c;font-weight:600;margin-bottom:6px">' + rows.length + ' failed run(s) in last 24h</div>'
            + '<ul style="list-style:none;padding:0;margin:0;max-height:200px;overflow-y:auto">'
            + rows.map(function (r) {
                var ago = Math.round((Date.now() - new Date(r.started_at).getTime()) / 60000);
                var msg = autoEsc((r.error || '').substring(0, 100));
                return '<li style="padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:11px">'
                    + '<b>' + autoEsc(r.strategy_name) + '</b> — ' + ago + 'm ago<br>'
                    + '<span style="color:#7f1d1d">' + msg + '</span></li>';
            }).join('')
            + '</ul>';
    } catch (e) {
        el.innerHTML = '<div style="color:#b91c1c">Failed: ' + (e.message || e) + '</div>';
    }
}

// ----------------------------------------------------------------------------
// Platform run history (Phase E.1c, 2026-07-10)
//
// Housekeeping jobs run under `_`-prefixed SENTINEL strategy names
// (`_eod_ingest`, `_mcx_candles_ingest`, `_test`). They belong to no strategy
// family, so the family pages filter them out — Legacy's global Run History tab
// was their ONLY surface. This card is their home per owner directive
// 2026-07-10 ("move them to Health for the time being"), so Phase E.3 can delete
// Legacy without losing visibility. Interim placement; revisit at restructure.
//
// The F&O contract sync (`securities-fno-sync`) does NOT write to `auto_runs` —
// it reports by email. Don't expect it here.
// ----------------------------------------------------------------------------
async function autoHealthLoadPlatformRuns(filterOverride) {
    var el = document.getElementById('au-hp-platform-runs');
    var badge = document.getElementById('au-hp-platform-runs-badge');
    if (!el) return;
    var sel = document.getElementById('au-hp-platform-runs-filter');
    // The 30s Health auto-refresh calls this with no argument — honour whatever
    // filter the user last picked rather than silently resetting it to 'all'.
    var filter = (typeof filterOverride === 'string' && filterOverride !== '[object Event]')
        ? filterOverride
        : (sel ? sel.value : 'all');
    if (sel && sel.value !== filter) sel.value = filter;

    if (badge) { badge.className = 'au-badge loading'; badge.textContent = 'loading'; }
    try {
        // Sentinel scope. PostgREST: the underscore is a LIKE single-char wildcard
        // and MUST be escaped — bare `like._%` matches EVERY strategy, not just the
        // `_`-prefixed system jobs (AUTOMATION-LESSONS F.12).
        var q = '/rest/v1/auto_runs?strategy_name=like.' + encodeURIComponent('\\_%') +
                '&order=started_at.desc&limit=50' +
                '&select=strategy_name,started_at,finished_at,duration_ms,status,signals_generated,emails_sent,emails_failed,error,metadata';
        if (filter === 'failed')                       q += '&status=eq.FAILED';
        else if (filter === 'with_signals')            q += '&signals_generated=gt.0';
        else if (filter && filter.charAt(0) === '_')   q += '&strategy_name=eq.' + encodeURIComponent(filter);

        var r = await fetch(SUPABASE_URL + q, { headers: wmsHeaders() });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()));
        var rows = await r.json();

        if (!Array.isArray(rows) || rows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No runs match this filter.</div>';
            if (badge) { badge.className = 'au-badge idle'; badge.textContent = '0 runs'; }
            return;
        }

        var failed = rows.filter(function (x) { return x.status === 'FAILED'; }).length;

        var html = '<div style="width:100%;overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Job</th>' +
                '<th style="padding:6px 8px">Started (IST)</th>' +
                '<th style="padding:6px 8px">Status</th>' +
                '<th style="padding:6px 8px;text-align:right">Duration</th>' +
                '<th style="padding:6px 8px;text-align:right">Signals</th>' +
                '<th style="padding:6px 8px;text-align:right">Emails</th>' +
                '<th style="padding:6px 8px">Detail</th>' +
                '</tr></thead><tbody>';
        rows.forEach(function (x) {
            var badgeHtml = x.status === 'SUCCESS'
                ? '<span class="au-badge success">SUCCESS</span>'
                : (x.status === 'RUNNING'
                    ? '<span class="au-badge loading">RUNNING</span>'
                    : '<span class="au-badge error">' + autoEsc(x.status || '—') + '</span>');
            var dur = x.duration_ms != null ? (x.duration_ms / 1000).toFixed(1) + 's' : '—';
            var emails = (x.emails_sent || 0) + (x.emails_failed ? ' / ' + x.emails_failed + ' failed' : '');
            var detail = x.status === 'FAILED'
                ? '<span style="color:#7f1d1d" title="' + autoEsc(String(x.error || '')) + '">' + autoEsc(String(x.error || '').slice(0, 120)) + '</span>'
                : '<span style="color:#6b7280">' + autoEsc(String((x.metadata && x.metadata.summary) || '').slice(0, 120)) + '</span>';
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px"><code>' + autoEsc(x.strategy_name) + '</code></td>' +
                    '<td style="padding:6px 8px">' + autoHealthFmtIst(x.started_at) + '</td>' +
                    '<td style="padding:6px 8px">' + badgeHtml + '</td>' +
                    '<td style="padding:6px 8px;text-align:right">' + dur + '</td>' +
                    '<td style="padding:6px 8px;text-align:right">' + (x.signals_generated != null ? x.signals_generated : '—') + '</td>' +
                    '<td style="padding:6px 8px;text-align:right">' + emails + '</td>' +
                    '<td style="padding:6px 8px;max-width:380px;overflow:hidden;text-overflow:ellipsis">' + detail + '</td>' +
                    '</tr>';
        });
        html += '</tbody></table></div>';
        el.innerHTML = html;

        if (badge) {
            badge.className = failed > 0 ? 'au-badge error' : 'au-badge success';
            badge.textContent = failed > 0 ? failed + ' failed / ' + rows.length : rows.length + ' runs';
        }
    } catch (e) {
        el.innerHTML = '<div style="color:#dc2626">Failed to load: ' + autoEsc(String(e.message || e)) + '</div>';
        if (badge) { badge.className = 'au-badge error'; badge.textContent = 'error'; }
    }
}

// IST short timestamp for the Health cards.
function autoHealthFmtIst(iso) {
    if (!iso) return '—';
    try {
        var ist = new Date(new Date(iso).getTime() + (5.5 * 3600 * 1000));
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var hh = String(ist.getUTCHours()).padStart(2, '0');
        var mm = String(ist.getUTCMinutes()).padStart(2, '0');
        return ist.getUTCDate() + ' ' + months[ist.getUTCMonth()] + ' ' + hh + ':' + mm;
    } catch (_) { return '—'; }
}

// GS Open Trades live P&L flows through the SINGLE app-wide price system
// (wms-shared.js → wmsStandardRefresh / wmsLivePrices / wmsStartRefreshTimer).
// No module-local timer or Fyers fetch — the shared timer keeps wmsLivePrices
// warm on the app cadence (10s equity, 2-min MCX evening) and its
// wmsRefreshRender() calls autoOnSharedRefresh() each cycle to re-render.
// (AUTOMATION-LESSONS Part 1; WMS-LESSONS §E.11.10)

// Symbols the open-trade views need priced; merged into the shared refresh list
// via wmsRegisterRefreshSymbolProvider. Updated whenever GS open trades load.
var _auGsSyms = { live: [], paper: [] };  // GS open-trade symbols per page [{ fyersKey, cacheKey }]
var _auPairsSyms = [];  // Pairs (equity) open-trade symbols
var _auAt2Syms = [];    // AT2 open-trade symbols [{ fyersKey, cacheKey }] — set by auAt2RenderOpen
function autoGetRefreshSymbols() { return _auGsSyms.live.concat(_auGsSyms.paper).concat(_auPairsSyms).concat(_auAt2Syms); }

// Register the provider (idempotent) + make sure the single shared timer runs
// while the user is on an Open Trades sub-tab. Called from autoSwitchSubTab.
function autoEnsureSharedRefresh() {
    if (typeof wmsRegisterRefreshSymbolProvider === 'function') {
        wmsRegisterRefreshSymbolProvider('auto_open_trades', autoGetRefreshSymbols);
    }
    if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
    if (typeof wmsStartRefreshTimer === 'function' && typeof wmsIsRefreshWindow === 'function'
        && wmsIsRefreshWindow() && window.fyersToken) {
        wmsStartRefreshTimer();
    }
}

// Called by wms-shared.js wmsRefreshRender() on every shared price cycle.
// Re-renders the GS open trades (reading LTP from wmsLivePrices) only while the
// user is viewing that sub-tab.
function autoOnSharedRefresh() {
    if (document.hidden) return;
    // Phase E.3: the Legacy Open Trades tab is gone — the family pages are the
    // only surfaces. Re-render only the open-trades panel the user is looking at.
    var famGs        = document.getElementById('au-fam-gs')?.classList.contains('active');
    var famLive      = document.getElementById('au-gs-live-panel')?.classList.contains('active');
    var famPaper     = document.getElementById('au-gs-paper-panel')?.classList.contains('active');
    var famPairs     = document.getElementById('au-fam-pairs')?.classList.contains('active');
    var famPairsOpen = document.getElementById('au-pairs-fam-open-panel')?.classList.contains('active');
    var famAt2       = document.getElementById('au-fam-at2')?.classList.contains('active');
    // Re-render only the open block of whichever GS page the user is viewing (its
    // open <details> is inside the active Live/Paper panel — see autoGsRenderPageShell).
    if (famGs && famLive)          autoLoadGsOpenTrades('live', true  /* silent — flicker-free */);
    if (famGs && famPaper)         autoLoadGsOpenTrades('paper', true /* silent — flicker-free */);
    if (famPairs && famPairsOpen)  autoLoadOpenTrades(true /* silent — flicker-free */);
    // AT2's Open trades block is always visible on the Trades sub-tab (never
    // filtered/hidden behind a sub-panel toggle the way GS's Live/Paper are),
    // so a family-active check is enough — no sub-tab check needed.
    if (famAt2 && typeof auAt2RenderOpen === 'function') auAt2RenderOpen(true /* silent — flicker-free */);
    // NOTE: the live/paused/"mkt closed" refresh-tick indicator lived in the Legacy
    // totals bar and was NOT ported (owner call 2026-07-10 — defer to the next round
    // of page improvements). Re-add it to the GS header strip then.
}


// Shared GS totals state — populated by both autoLoadGsOpenTrades and
// autoLoadGsClosedTrades, read by autoRenderGsFamMetrics via autoGsTotalsChanged().
//
// peakExposure / peakMargin are the HIGH-WATER marks across all signal time
// (entries add, exits subtract the matching entry's value). They represent
// the MAX simultaneous capital at risk at any point since the first trade.
// Recomputed every time autoLoadGsClosedTrades runs (since it already pulls
// every webhook signal — closed AND still-open).
// Per-page GS totals (Live / Paper split, 2026-07-23). Each page's cards read
// _auGsTotals[mode]; the two pages never share state so filter changes on one
// can't distort the other's cards.
function _auGsBlankTotals() {
    return {
        openCount: null, openExposure: null, openMargin: null, openLivePnl: null,
        closedCount: null, closedWins: null, closedLosses: null, closedRealisedPnl: null,
        peakExposure: null, peakMargin: null, peakSourceFilter: 'all', peakFiltered: false,
        filteredVersions: null,
    };
}
var _auGsTotals = { live: _auGsBlankTotals(), paper: _auGsBlankTotals() };
// How many engine-open LIVE trades were hidden this render because the broker has
// already closed them (fill-awareness, 2026-07-24). Surfaced in the open-trades summary.
var _auGsFillSettled = 0;

// Single "GS totals changed → repaint that page's cards" chokepoint. Keyed by
// mode so only the affected page repaints.
function autoGsTotalsChanged(mode) {
    if (typeof autoRenderGsFamMetrics === 'function') autoRenderGsFamMetrics(mode);
}

function autoSwitchSubTab(subtabId) {
    var panel = document.getElementById(subtabId);
    if (!panel) return;
    var parent = panel.parentElement;
    if (!parent) return;
    parent.querySelectorAll('.au-subtab-btn').forEach(function (b) { b.classList.remove('active'); });
    parent.querySelectorAll('.au-subtab-panel').forEach(function (p) { p.classList.remove('active'); });
    var btn = parent.querySelector('.au-subtab-btn[data-subtab="' + subtabId + '"]');
    if (btn) btn.classList.add('active');
    panel.classList.add('active');

    // Arm the shared price timer whenever an Open Trades panel becomes visible.
    // (Phase E.3 removed the Legacy au-ot-gs / au-ot-pairs sub-tabs and the fixed
    // totals bar that used to be toggled here.)
    if (subtabId === 'au-gs-live-panel' || subtabId === 'au-gs-paper-panel' || subtabId === 'au-pairs-fam-open-panel') {
        autoEnsureSharedRefresh();
    }
}

// ----------------------------------------------------------------------------
// Init
// ----------------------------------------------------------------------------

async function initAutomation() {
    // Family tabs (Phase A of UI reimagining) — outer nav [Health][GS][KH][Pairs][Legacy]
    document.querySelectorAll('.au-fam-tab-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            if (!btn.disabled && btn.dataset.fam) autoSwitchFamily(btn.dataset.fam);
        });
    });

    // Wire sub-tab buttons (Open Trades: GS vs Pairs)
    document.querySelectorAll('.au-subtab-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { autoSwitchSubTab(btn.dataset.subtab); });
    });

    // Health page is the default landing tab. (Phase E.1c: no mirror setup — the
    // platform-utility renderers write into the Health targets directly.)
    autoHealthLoadAll();
    window._auHealthLoaded = true;
    if (!window._auHealthTimer) {
        window._auHealthTimer = setInterval(function () {
            var el = document.getElementById('au-fam-health');
            if (el && el.classList.contains('active')) autoHealthLoadAll();
        }, 30000);
    }

    // Warm the Health page's platform-maintenance panels (EOD ingest / market_prices
    // / Runner last-run). Health is the default landing tab.
    autoLoadEodLastRun();
    autoLoadMarketPricesStats();
    autoLoadRunnerLastRun();
}

// Expose for app.html loader
window.initAutomation = initAutomation;

// ----------------------------------------------------------------------------
// EOD Ingest — invoke Edge Function + render response
// ----------------------------------------------------------------------------

var _autoEodInFlight = false;

async function autoRunEodIngest(daysBack, confirmFirst) {
    if (_autoEodInFlight) return;
    if (confirmFirst && !confirm('Backfill ' + daysBack + ' days for the entire universe — takes ~30s. Continue?')) return;

    _autoEodInFlight = true;
    autoSetEodStatus('loading', 'running ' + daysBack + 'd');
    autoSetEodButtonsDisabled(true);

    var responsePanel = autoTarget(['au-hp-eod-response']);
    responsePanel.style.display = 'block';
    responsePanel.innerHTML = '<div class="au-meta">⏳ Running ' + daysBack + '-day ingest… (may take ' + (daysBack > 30 ? '20–60' : '5–15') + ' seconds)</div>';

    var startedAt = Date.now();
    try {
        // ?wait=true → synchronous mode (function awaits completion before
        // responding). cron-job.org uses async-default to avoid its 30s
        // HTTP timeout, but here the user IS waiting for the answer in the UI.
        var resp = await fetch(SUPABASE_URL + '/functions/v1/eod-prices-ingest?wait=true', {
            method: 'POST',
            headers: wmsEdgeHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ days_back: daysBack })
        });
        var text = await resp.text();
        var data;
        try { data = JSON.parse(text); } catch (_e) { data = { raw_response: text }; }

        var ms = Date.now() - startedAt;
        if (resp.ok && data && data.success) {
            autoSetEodStatus('success', 'success');
            autoRenderEodSuccess(data, ms);
        } else {
            autoSetEodStatus('error', 'failed');
            autoRenderEodError(data, resp.status, ms);
        }
    } catch (err) {
        autoSetEodStatus('error', 'failed');
        autoRenderEodError({ error: String(err) }, 0, Date.now() - startedAt);
    } finally {
        _autoEodInFlight = false;
        autoSetEodButtonsDisabled(false);
        // Refresh last-run + market_prices stats — they should now show today's run
        autoLoadEodLastRun();
        autoLoadMarketPricesStats();
    }
}

function autoSetEodStatus(cls, label) {
    var el = autoBadgeTarget(['au-hp-eod-status']);
    if (!el) return;
    el.className = 'au-badge ' + cls;
    el.textContent = label;
}

function autoSetEodButtonsDisabled(disabled) {
    // Class-based selector so both Legacy Admin (au-admin) and the new Health
    // page platform-maintenance card get disabled simultaneously.
    document.querySelectorAll('.au-eod-btn').forEach(function (b) {
        b.disabled = disabled;
    });
}

function autoRenderEodSuccess(d, ms) {
    var rp = autoTarget(['au-hp-eod-response']);
    var html = '';
    html += '<div style="font-size:13px;color:#047857;font-weight:600">✓ Success <span class="au-badge success">' + (ms / 1000).toFixed(1) + 's</span></div>';
    html += '<div class="au-stat-grid">';
    html += autoStatBlock('Rows upserted', d.rows_upserted || 0);
    html += autoStatBlock('Resolved',      d.resolved      || 0);
    html += autoStatBlock('Missing',       (d.missing || []).length);
    html += autoStatBlock('Failed',        (d.failed_symbols || []).length);
    html += autoStatBlock('Range from',    d.range_from || '—', true);
    html += autoStatBlock('Range to',      d.range_to   || '—', true);
    html += '</div>';

    if ((d.missing || []).length > 0) {
        html += '<div class="au-warn-list"><strong>Missing from securities_db (' + d.missing.length + '):</strong> ' + d.missing.join(', ') + '</div>';
    }
    if ((d.failed_symbols || []).length > 0) {
        html += '<div class="au-error-list"><strong>Fyers errors (' + d.failed_symbols.length + '):</strong><ul>';
        d.failed_symbols.forEach(function (f) {
            html += '<li><code>' + autoEsc(f.symbol) + '</code>: ' + autoEsc(f.error) + '</li>';
        });
        html += '</ul></div>';
    }
    html += '<details style="margin-top:10px"><summary>Full JSON response</summary>';
    html += '<pre class="au-result-block">' + autoEsc(JSON.stringify(d, null, 2)) + '</pre></details>';

    rp.innerHTML = html;
}

function autoRenderEodError(d, status, ms) {
    var rp = autoTarget(['au-hp-eod-response']);
    var html = '';
    html += '<div style="font-size:13px;color:#dc2626;font-weight:600">✗ Failed' + (status ? ' (HTTP ' + status + ')' : '') + ' <span class="au-badge error">' + (ms / 1000).toFixed(1) + 's</span></div>';
    if (d && d.error) html += '<div style="margin-top:6px;color:#7f1d1d;font-size:13px">' + autoEsc(d.error) + '</div>';
    html += '<details style="margin-top:10px" open><summary>Full JSON response</summary>';
    html += '<pre class="au-result-block">' + autoEsc(JSON.stringify(d, null, 2)) + '</pre></details>';
    rp.innerHTML = html;
}

function autoStatBlock(label, value, small) {
    return '<div class="au-stat"><div class="au-stat-label">' + autoEsc(label) + '</div>' +
           '<div class="au-stat-value' + (small ? ' small' : '') + '">' + autoEsc(String(value)) + '</div></div>';
}

function autoEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
}

// ----------------------------------------------------------------------------
// Last EOD-ingest run summary — read auto_runs WHERE strategy_name='_eod_ingest'
// ----------------------------------------------------------------------------

async function autoLoadEodLastRun() {
    var el = autoTarget(['au-hp-eod-last-run']);
    if (!el) return;
    el.textContent = 'Loading last run…';
    try {
        var resp = await fetch(
            SUPABASE_URL + '/rest/v1/auto_runs?strategy_name=eq._eod_ingest&order=started_at.desc&limit=1',
            { headers: wmsHeaders() }
        );
        var rows = await resp.json();
        if (!Array.isArray(rows) || rows.length === 0) {
            el.innerHTML = '<em style="color:#9ca3af">No runs yet — try the smoke-test button above.</em>';
            autoSetEodStatus('idle', 'never run');
            return;
        }
        var r = rows[0];
        var dt = new Date(r.started_at);
        var when = dt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
        var dur = r.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) + 's' : '—';
        var meta = r.metadata || {};

        var statusBadge = r.status === 'SUCCESS' ? '<span class="au-badge success">success</span>' :
                          r.status === 'FAILED'  ? '<span class="au-badge error">failed</span>' :
                                                   '<span class="au-badge loading">running</span>';

        el.innerHTML =
            '<span><strong>Last run:</strong> ' + when + ' ' + statusBadge + '</span>' +
            '<span><strong>Duration:</strong> ' + dur + '</span>' +
            '<span><strong>Rows:</strong> ' + (meta.rows_upserted != null ? meta.rows_upserted : '—') + '</span>' +
            '<span><strong>Resolved:</strong> ' + (meta.resolved != null ? meta.resolved : '—') + '/' + (meta.universe_size != null ? meta.universe_size : '—') + '</span>' +
            '<span><strong>Range:</strong> ' + (meta.range_from || '—') + ' → ' + (meta.range_to || '—') + '</span>';

        if (r.status === 'FAILED' && r.error) {
            el.innerHTML += '<div class="au-error-list" style="width:100%"><strong>Error:</strong> ' + autoEsc(r.error) + '</div>';
        }
        autoSetEodStatus(r.status === 'SUCCESS' ? 'success' : r.status === 'FAILED' ? 'error' : 'idle',
                         r.status.toLowerCase());
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load run history: ' + autoEsc(String(e)) + '</span>';
    }
}

// ----------------------------------------------------------------------------
// Strategy Runner — invoke automation-runner Edge Function + render response
// ----------------------------------------------------------------------------

var _autoRunnerInFlight = false;

async function autoRunStrategy(stratName) {
    if (_autoRunnerInFlight) return;
    _autoRunnerInFlight = true;

    autoSetRunnerStatus('loading', stratName ? 'running ' + stratName : 'running all');
    autoSetRunnerButtonsDisabled(true);

    var responsePanel = autoTarget(['au-hp-runner-response']);
    responsePanel.style.display = 'block';
    responsePanel.innerHTML = '<div class="au-meta">⏳ Running strategy ' + (stratName || '(all enabled)') + '… (~1-3s for stub, longer for real strategies)</div>';

    var qs = '?wait=true';
    if (stratName) qs += '&strategy=' + encodeURIComponent(stratName);

    var startedAt = Date.now();
    try {
        var resp = await fetch(SUPABASE_URL + '/functions/v1/automation-runner' + qs, {
            method: 'POST',
            headers: wmsEdgeHeaders({ 'Content-Type': 'application/json' }),
            body: '{}'
        });
        var text = await resp.text();
        var data;
        try { data = JSON.parse(text); } catch (_e) { data = { raw_response: text }; }
        var ms = Date.now() - startedAt;
        if (resp.ok && data && data.success) {
            autoSetRunnerStatus('success', 'success');
            autoRenderRunnerSuccess(data, ms);
        } else {
            autoSetRunnerStatus('error', 'failed');
            autoRenderRunnerError(data, resp.status, ms);
        }
    } catch (err) {
        autoSetRunnerStatus('error', 'failed');
        autoRenderRunnerError({ error: String(err) }, 0, Date.now() - startedAt);
    } finally {
        _autoRunnerInFlight = false;
        autoSetRunnerButtonsDisabled(false);
        autoLoadRunnerLastRun();
    }
}

function autoSetRunnerStatus(cls, label) {
    var el = autoBadgeTarget(['au-hp-runner-status']);
    if (!el) return;
    el.className = 'au-badge ' + cls;
    el.textContent = label;
}

function autoSetRunnerButtonsDisabled(disabled) {
    // Class-based selector so both Legacy runner card and the new Health page
    // runner card get disabled simultaneously.
    document.querySelectorAll('.au-runner-btn').forEach(function (b) {
        b.disabled = disabled;
    });
}

function autoRenderRunnerSuccess(d, ms) {
    var rp = autoTarget(['au-hp-runner-response']);
    var html = '<div style="font-size:13px;color:#047857;font-weight:600">✓ Dispatch Success <span class="au-badge success">' + (ms / 1000).toFixed(1) + 's</span></div>';

    var results = d.results || [];
    if (results.length === 0) {
        html += '<div class="au-warn-list" style="margin-top:8px">No strategies ran (none enabled, or filter excluded all).</div>';
    } else {
        html += '<div class="au-stat-grid">';
        html += autoStatBlock('Strategies run', d.strategies_run || 0);
        html += autoStatBlock('Total signals', results.reduce(function (a, r) { return a + (r.signals_generated || 0); }, 0));
        html += autoStatBlock('Emails sent', results.reduce(function (a, r) { return a + (r.emails_sent || 0); }, 0));
        html += autoStatBlock('Emails failed', results.reduce(function (a, r) { return a + (r.emails_failed || 0); }, 0));
        html += '</div>';

        // Per-strategy breakdown
        html += '<div style="margin-top:10px"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Strategy</th><th style="padding:6px 8px">Status</th>' +
                '<th style="padding:6px 8px">Signals</th><th style="padding:6px 8px">Email</th>' +
                '<th style="padding:6px 8px">Duration</th><th style="padding:6px 8px">Error</th></tr></thead><tbody>';
        results.forEach(function (r) {
            var statusBadge = r.status === 'SUCCESS'
                ? '<span class="au-badge success">success</span>'
                : '<span class="au-badge error">failed</span>';
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px"><code>' + autoEsc(r.strategy_name) + '</code></td>' +
                    '<td style="padding:6px 8px">' + statusBadge + '</td>' +
                    '<td style="padding:6px 8px">' + (r.signals_generated || 0) + '</td>' +
                    '<td style="padding:6px 8px">' + (r.emails_sent ? '✓' : (r.emails_failed ? '✗' : '—')) + '</td>' +
                    '<td style="padding:6px 8px">' + ((r.duration_ms || 0) / 1000).toFixed(1) + 's</td>' +
                    '<td style="padding:6px 8px;color:#7f1d1d;font-size:11px">' + autoEsc(r.error || '') + '</td>' +
                    '</tr>';
        });
        html += '</tbody></table></div>';
    }

    html += '<details style="margin-top:10px"><summary>Full JSON response</summary>';
    html += '<pre class="au-result-block">' + autoEsc(JSON.stringify(d, null, 2)) + '</pre></details>';
    rp.innerHTML = html;
}

function autoRenderRunnerError(d, status, ms) {
    var rp = autoTarget(['au-hp-runner-response']);
    var html = '<div style="font-size:13px;color:#dc2626;font-weight:600">✗ Failed' + (status ? ' (HTTP ' + status + ')' : '') + ' <span class="au-badge error">' + (ms / 1000).toFixed(1) + 's</span></div>';
    if (d && d.error) html += '<div style="margin-top:6px;color:#7f1d1d;font-size:13px">' + autoEsc(d.error) + '</div>';
    html += '<details style="margin-top:10px" open><summary>Full JSON response</summary>';
    html += '<pre class="au-result-block">' + autoEsc(JSON.stringify(d, null, 2)) + '</pre></details>';
    rp.innerHTML = html;
}

async function autoLoadRunnerLastRun() {
    var el = autoTarget(['au-hp-runner-last-run']);
    if (!el) return;
    el.textContent = 'Loading last run…';
    try {
        // Skip _eod_ingest sentinel — that has its own card.
        var resp = await fetch(
            SUPABASE_URL + '/rest/v1/auto_runs?strategy_name=neq._eod_ingest&order=started_at.desc&limit=1',
            { headers: wmsHeaders() }
        );
        var rows = await resp.json();
        if (!Array.isArray(rows) || rows.length === 0) {
            el.innerHTML = '<em style="color:#9ca3af">No strategy runs yet — try the buttons above.</em>';
            autoSetRunnerStatus('idle', 'never run');
            return;
        }
        var r = rows[0];
        var dt = new Date(r.started_at);
        var when = dt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
        var dur = r.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) + 's' : '—';
        var statusBadge = r.status === 'SUCCESS' ? '<span class="au-badge success">success</span>' :
                          r.status === 'FAILED'  ? '<span class="au-badge error">failed</span>' :
                                                   '<span class="au-badge loading">running</span>';
        el.innerHTML =
            '<span><strong>Last run:</strong> ' + when + ' ' + statusBadge + '</span>' +
            '<span><strong>Strategy:</strong> <code>' + autoEsc(r.strategy_name) + '</code></span>' +
            '<span><strong>Duration:</strong> ' + dur + '</span>' +
            '<span><strong>Signals:</strong> ' + (r.signals_generated != null ? r.signals_generated : '—') + '</span>' +
            '<span><strong>Emails:</strong> ' + (r.emails_sent != null ? r.emails_sent : 0) + ' sent / ' + (r.emails_failed != null ? r.emails_failed : 0) + ' failed</span>';
        if (r.status === 'FAILED' && r.error) {
            el.innerHTML += '<div class="au-error-list" style="width:100%"><strong>Error:</strong> ' + autoEsc(r.error) + '</div>';
        }
        autoSetRunnerStatus(r.status === 'SUCCESS' ? 'success' : r.status === 'FAILED' ? 'error' : 'idle',
                            r.status.toLowerCase());
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load: ' + autoEsc(String(e)) + '</span>';
    }
}

// ----------------------------------------------------------------------------
// market_prices snapshot
// ----------------------------------------------------------------------------

async function autoLoadMarketPricesStats() {
    var el = autoTarget(['au-hp-mp-stats']);
    if (!el) return;
    el.textContent = 'Loading…';
    try {
        // resolution=eq.1D filter — explicit since migration 43 made market_prices polymorphic.
        // This card describes the equity EOD ingest only; MCX 15-min rows have their own card.
        // Without this filter the "Latest date" would jump to an intraday timestamp once
        // mcx-candles-ingest starts landing rows, making the EOD-staleness signal misleading.
        var countResp = await fetch(
            SUPABASE_URL + '/rest/v1/market_prices?select=id&resolution=eq.1D',
            { headers: wmsHeaders({ 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' }) }
        );
        var contentRange = countResp.headers.get('content-range') || '';
        var totalRows = (contentRange.split('/')[1] || '0').replace(/\D/g, '') || '0';

        // Distinct security count + min/max date — separate small queries for clarity
        var minResp = await fetch(SUPABASE_URL + '/rest/v1/market_prices?select=price_date&resolution=eq.1D&order=price_date.asc&limit=1',
                                  { headers: wmsHeaders() });
        var minRows = await minResp.json();
        var maxResp = await fetch(SUPABASE_URL + '/rest/v1/market_prices?select=price_date&resolution=eq.1D&order=price_date.desc&limit=1',
                                  { headers: wmsHeaders() });
        var maxRows = await maxResp.json();

        var minDate = minRows[0] ? minRows[0].price_date : '—';
        var maxDate = maxRows[0] ? maxRows[0].price_date : '—';

        el.innerHTML =
            '<span><strong>Total rows:</strong> ' + Number(totalRows).toLocaleString() + '</span>' +
            '<span><strong>Earliest date:</strong> ' + minDate + '</span>' +
            '<span><strong>Latest date:</strong> ' + maxDate + '</span>';
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load: ' + autoEsc(String(e)) + '</span>';
    }
}

// ----------------------------------------------------------------------------
// auto_strategies list
// ----------------------------------------------------------------------------


// ----------------------------------------------------------------------------
// Strategy write actions (Phase 7a)
// ----------------------------------------------------------------------------
//
// ONE button builder + ONE toggle handler, shared by every table that lists
// strategies (Legacy Admin, GS Controls & Admin, Pairs Controls & Admin).
// Per LESSONS §B.4.9 the button HTML is NOT copied per renderer — a fourth
// table added tomorrow inherits the correct button, dialog and refresh.
//
// Note for Pairs: Pause/Resume flips `auto_strategies.enabled`. That is NOT a
// change to scanner logic / constants / boundaries, so it does not engage the
// LESSONS §B.21.8 lock. The "logic locked" notice on that tab stands as-is.
// ----------------------------------------------------------------------------

// Resume cadence, per strategy — the confirm() dialog must tell the truth about
// WHEN a resumed strategy next runs. GS runs on the 15-min automation-runner EF;
// pairs runs on the five fixed cron-job.org ticks. (Before 2026-07-10 the dialog
// hard-coded the pairs times for EVERY strategy, which mis-stated GS.)
var _AU_RESUME_CADENCE = {
    silver_mini_15m: 'every 15 minutes during MCX hours (9:00–23:30 IST, Mon–Fri)',
    gold_mini_15m:   'every 15 minutes during MCX hours (9:00–23:30 IST, Mon–Fri)',
    pairs:           'at the next scheduled scan (weekdays 9:30 / 11:30 / 13:30 / 15:15 / 18:05 IST)'
};

// Renders the Actions cell for one auto_strategies row. Used by all three tables.
function autoStrategyActionCell(row) {
    var nameArg = JSON.stringify(row.name).replace(/"/g, '&quot;');
    return '<button class="au-btn au-btn-secondary" style="padding:4px 8px;font-size:11px"' +
           ' onclick="autoToggleStrategy(' + nameArg + ',' + (!!row.enabled) + ')">' +
           (row.enabled ? '⏸ Pause' : '▶ Resume') + '</button>';
}

// After a toggle, re-render every strategy surface currently in the DOM.
// Element-presence guards mean this keeps working unchanged once Phase E
// deletes the Legacy panel. Family headers refresh too — their status pill
// reads `enabled` (all enabled => PAPER, otherwise DISABLED).
// Merge freshly-fetched auto_strategies rows into the shared cache (used by the
// dormant recipients editor). Merge, not replace — GS and Pairs each fetch a subset.
function _auCacheStrategies(rows) {
    if (!Array.isArray(rows)) return;
    var cache = window._auStrategiesCache || [];
    rows.forEach(function (r) {
        var i = cache.findIndex(function (c) { return c.name === r.name; });
        if (i >= 0) cache[i] = r; else cache.push(r);
    });
    window._auStrategiesCache = cache;
}

function autoRefreshStrategySurfaces() {
    if (document.getElementById('au-gs-fam-strategies-paper')) autoLoadGsFamAdmin();
    if (document.getElementById('au-gs-fam-mode'))          autoLoadGsFamHeader();
    if (document.getElementById('au-pairs-fam-strategies')) autoLoadPairsFamAdmin();
    if (document.getElementById('au-pairs-fam-mode'))       autoLoadPairsFamHeader();
}

async function autoToggleStrategy(name, currentlyEnabled) {
    var verb = currentlyEnabled ? 'Pause' : 'Resume';
    var cadence = _AU_RESUME_CADENCE[name] || 'at its next scheduled run';
    var consequence = currentlyEnabled
        ? 'No new scans will run for "' + name + '" until you Resume it. Open trades are NOT auto-managed while paused (no exit checks).'
        : 'Strategy "' + name + '" will resume scanning ' + cadence + '.';
    if (!confirm(verb + ' strategy "' + name + '"?\n\n' + consequence)) return;
    try {
        var resp = await fetch(
            SUPABASE_URL + '/rest/v1/auto_strategies?name=eq.' + encodeURIComponent(name),
            { method: 'PATCH', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
              body: JSON.stringify({ enabled: !currentlyEnabled }) }
        );
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));
        autoRefreshStrategySurfaces();
    } catch (e) {
        alert('Failed to update: ' + (e.message || e));
    }
}

// DORMANT (Phase 7b). No caller: the recipients editor is intentionally not exposed
// (Resend free tier 403s the whole batch on one unverified address — AUTOMATION-LESSONS
// F.7f/F.7i). Kept for when per-recipient send or a verified domain ships; it must then
// be wired onto the family Controls & Admin tabs, not a Legacy list. _auStrategiesCache
// is populated by autoLoadGsFamAdmin / autoLoadPairsFamAdmin since Phase E.3 deleted
// autoLoadStrategies along with the Legacy Admin table.
function autoOpenRecipientsModal(name) {
    var strat = (window._auStrategiesCache || []).find(function (s) { return s.name === name; });
    if (!strat) { alert('Strategy "' + name + '" not loaded — refresh the strategies list.'); return; }
    var rcpts = Array.isArray(strat.recipients) ? strat.recipients.slice() : [];
    // Render modal
    var modal = document.getElementById('au-recipients-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'au-recipients-modal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9999;display:flex;align-items:center;justify-content:center';
        document.body.appendChild(modal);
    }
    modal.innerHTML =
        '<div style="background:#fff;border-radius:8px;max-width:560px;width:90%;padding:20px;box-shadow:0 8px 24px rgba(0,0,0,0.18)">' +
            '<h3 style="margin:0 0 4px;font-size:15px;color:#1f2937">Recipients for <code>' + autoEsc(name) + '</code></h3>' +
            '<p style="margin:0 0 12px;font-size:12px;color:#6b7280">Anyone listed here gets the strategy\'s alert email on every signal. ' +
            'The first email must match a Resend-verified address (currently <code>vikash.bagla@gmail.com</code>); additional recipients should be handled via Gmail forwards or domain verification.</p>' +
            '<div id="au-recipients-rows"></div>' +
            '<div style="margin-top:8px"><button class="au-btn au-btn-secondary" onclick="autoAddRecipientRow()">+ Add recipient</button></div>' +
            '<div style="margin-top:18px;display:flex;gap:8px;justify-content:flex-end">' +
                '<button class="au-btn au-btn-secondary" onclick="autoCloseRecipientsModal()">Cancel</button>' +
                '<button class="au-btn au-btn-primary" onclick="autoSaveRecipients(' + JSON.stringify(name).replace(/"/g, '&quot;') + ')">Save</button>' +
            '</div>' +
        '</div>';
    autoRenderRecipientsRows(rcpts);
}

function autoCloseRecipientsModal() {
    var modal = document.getElementById('au-recipients-modal');
    if (modal) modal.remove();
}

function autoRenderRecipientsRows(arr) {
    var box = document.getElementById('au-recipients-rows');
    if (!box) return;
    if (arr.length === 0) { box.innerHTML = '<div style="font-size:12px;color:#9ca3af;padding:8px 0">No recipients — add at least one.</div>'; return; }
    var html = '';
    arr.forEach(function (r, i) {
        html += '<div class="au-rcpt-row" style="display:flex;gap:6px;margin-bottom:6px;align-items:center">' +
                '<input class="au-rcpt-name"  data-i="' + i + '" placeholder="Name"  value="' + autoEsc(r.name || '') + '" style="flex:1;padding:6px;border:1px solid #d1d5db;border-radius:4px;font-size:12px">' +
                '<input class="au-rcpt-email" data-i="' + i + '" placeholder="email" value="' + autoEsc(r.email || '') + '" style="flex:2;padding:6px;border:1px solid #d1d5db;border-radius:4px;font-size:12px">' +
                '<button class="au-btn au-btn-danger" style="padding:4px 10px;font-size:11px" onclick="autoRemoveRecipientRow(' + i + ')">×</button>' +
                '</div>';
    });
    box.innerHTML = html;
    box.dataset.rcpts = JSON.stringify(arr);
}

function autoCollectRecipientsFromForm() {
    var rows = document.querySelectorAll('#au-recipients-rows .au-rcpt-row');
    var arr = [];
    rows.forEach(function (row) {
        var name  = (row.querySelector('.au-rcpt-name')  || {}).value || '';
        var email = (row.querySelector('.au-rcpt-email') || {}).value || '';
        arr.push({ name: name.trim(), email: email.trim() });
    });
    return arr;
}

function autoAddRecipientRow() {
    var current = autoCollectRecipientsFromForm();
    current.push({ name: '', email: '' });
    autoRenderRecipientsRows(current);
}

function autoRemoveRecipientRow(i) {
    var current = autoCollectRecipientsFromForm();
    current.splice(i, 1);
    autoRenderRecipientsRows(current);
}

async function autoSaveRecipients(name) {
    var rcpts = autoCollectRecipientsFromForm().filter(function (r) { return r.email; });
    // Basic email shape validation
    var bad = rcpts.find(function (r) { return !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email); });
    if (bad) { alert('Invalid email: ' + bad.email); return; }
    if (rcpts.length === 0) {
        if (!confirm('No recipients — emails will not be sent for any future signal. Continue?')) return;
    }
    try {
        var resp = await fetch(
            SUPABASE_URL + '/rest/v1/auto_strategies?name=eq.' + encodeURIComponent(name),
            { method: 'PATCH', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
              body: JSON.stringify({ recipients: rcpts }) }
        );
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));
        autoCloseRecipientsModal();
        autoRefreshStrategySurfaces();
    } catch (e) {
        alert('Failed to save: ' + (e.message || e));
    }
}

// ----------------------------------------------------------------------------
// Manual close (Phase 7a)
// ----------------------------------------------------------------------------
//
// v_auto_open_trades closes a trade when net qty per symbol == 0. So a manual
// close is just a signal row whose legs are the reverse-side of the ENTRY's
// legs, same qty. event_type='MANUAL_EXIT' (the value allowed by the
// auto_signals_event_type_check constraint) for the audit trail; email skipped
// — chassis is the only thing that calls Resend. Operator already knows.

async function autoManualClose(tradeId) {
    if (!tradeId) return;
    // Pull the ENTRY signal for this trade to get the legs
    var entryResp = await fetch(
        SUPABASE_URL + '/rest/v1/auto_signals?trade_id=eq.' + encodeURIComponent(tradeId) + '&event_type=eq.ENTRY&select=*',
        { headers: wmsHeaders() }
    );
    var entries = await entryResp.json();
    if (!Array.isArray(entries) || entries.length === 0) {
        alert('Could not find ENTRY signal for trade ' + tradeId.slice(0, 8));
        return;
    }
    var entry = entries[0];
    var pair = (entry.metadata && entry.metadata.Pair) || '(unknown pair)';
    var prompt = 'Manually close ' + pair + '?\n\n' +
                 'This inserts a CLOSE signal with reversed legs at entry prices. The trade will disappear from Open Trades immediately. ' +
                 'NO email is sent. P&L will be computed against actual market close prices in the Performance dashboard (Phase 8).\n\n' +
                 'Trade: ' + tradeId.slice(0, 8) + '…';
    if (!confirm(prompt)) return;

    var closeLegs = (entry.legs || []).map(function (leg) {
        return Object.assign({}, leg, { side: leg.side === 'BUY' ? 'SELL' : 'BUY' });
    });
    var payload = {
        trade_id: tradeId,
        strategy_name: entry.strategy_name,
        execution_mode: entry.execution_mode || 'PAPER',
        event_type: 'MANUAL_EXIT',
        direction: 'CLOSE',
        score: 0,
        legs: closeLegs,
        metadata: {
            Pair: pair,
            exit_reason: 'manual close by operator',
            manual_override: true,
            entry_signal_id: entry.id,
        },
        notes: 'Manually closed by operator at ' + new Date().toISOString(),
        email_status: 'SKIPPED',
        email_subject: null,
        email_recipients: null,
    };

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/auto_signals', {
            method: 'POST',
            headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
            body: JSON.stringify(payload),
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));
        autoLoadOpenTrades();
        // Phase E.3: the Legacy Events tab is gone. Refresh the Pairs family
        // Signals & Events tab instead, if it has been rendered.
        if (document.getElementById('au-pairs-fam-events-content')) autoLoadPairsFamEvents();
    } catch (e) {
        alert('Failed to close: ' + (e.message || e));
    }
}

// ----------------------------------------------------------------------------
// IST timestamp formatter — used everywhere a fired_at / started_at is shown.
// ----------------------------------------------------------------------------

// dd-mmm-yy hh:mm in IST. Compact for tight columns.
// e.g. "03-Jun-26 14:21"
function autoFmtIST(iso) {
    if (!iso) return '—';
    try {
        var d = new Date(iso);
        // Add +5:30 to UTC to get IST, then read UTC parts
        var ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var dd = String(ist.getUTCDate()).padStart(2, '0');
        var mm = months[ist.getUTCMonth()];
        var yy = String(ist.getUTCFullYear()).slice(2);
        var hh = String(ist.getUTCHours()).padStart(2, '0');
        var min = String(ist.getUTCMinutes()).padStart(2, '0');
        return dd + '-' + mm + '-' + yy + ' ' + hh + ':' + min;
    } catch (_e) { return iso; }
}

// Pretty-format a futures contract symbol for display.
// Strips the MCX: prefix and reconstructs as "SILVERM 30 Jun 26 Fut"
// using the expiry_date field instead of the symbol's embedded month code.
// e.g. ("MCX:SILVERM26JUNFUT", "2026-06-30") → "SILVERM 30 Jun 26 Fut"
function autoFmtContract(symbol, expiry_date) {
    if (!symbol) return '—';
    var short = symbol.replace(/^MCX:/, '');
    // If no expiry_date provided, return the bare short (e.g. SILVERM26JUNFUT)
    if (!expiry_date) return short;
    // Extract the underlying (strip trailing "26JUNFUT" / "26JUL FUT" etc)
    var underlying = short.replace(/\d+[A-Z]+FUT$/, '');
    try {
        var d = new Date(expiry_date);
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var dd = String(d.getUTCDate()).padStart(2, '0');
        var mm = months[d.getUTCMonth()];
        var yy = String(d.getUTCFullYear()).slice(2);
        return underlying + ' ' + dd + ' ' + mm + ' ' + yy + ' Fut';
    } catch (_e) {
        return underlying || short;
    }
}

// Indian-format integer rupee (zero decimals). e.g. 271955 → "2,71,955"
function autoFmtPrice0(n) {
    if (n == null || !isFinite(n)) return '—';
    return Math.round(Number(n)).toLocaleString('en-IN');
}

function autoFmtDuration(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
}

function autoStatusBadge(status) {
    if (status === 'SUCCESS')  return '<span class="au-badge success">success</span>';
    if (status === 'FAILED')   return '<span class="au-badge error">failed</span>';
    if (status === 'RUNNING')  return '<span class="au-badge loading">running</span>';
    return '<span class="au-badge idle">' + autoEsc(String(status || '—').toLowerCase()) + '</span>';
}

// ----------------------------------------------------------------------------
// Open Trades tab
// ----------------------------------------------------------------------------
//
// v_auto_open_trades is sparse (trade_id, strategy_name, net_position). To
// give the user something useful, we join client-side to auto_signals to fetch
// the ENTRY row for each open trade — that carries the metadata (Pair, Z90,
// Score, Action, Z_Target, Z_Stop, qtys, etc).
//
// Live P&L mark: pull latest close per symbol from market_prices; compute
// P&L per leg = (mark - entry_price) * qty for BUY, flipped for SELL; sum
// across legs. Mark is yesterday's close during trading hours, today's after
// eod-prices-ingest runs at 18:00 IST. Tooltip shows the mark date.

async function autoFetchLatestPrices(sigRows) {
    // Marks for live P&L. Live LTP comes from the shared price cache
    // (wmsLivePrices, populated by the single app-wide wmsStandardRefresh) — no
    // direct Fyers call. Returns { SHORT_SYMBOL: { close, date } } with
    // date='live' for cache hits; falls back to the latest market_prices close
    // for any symbol not in the cache. (WMS-LESSONS §E.11.10)
    var shortToFyers = {};
    sigRows.forEach(function (s) {
        (s.legs || []).forEach(function (l) {
            if (l.symbol && l.short_symbol) shortToFyers[l.short_symbol] = l.symbol;
        });
    });
    var result = {};
    var shorts = Object.keys(shortToFyers);
    if (shorts.length === 0) return result;

    // Register pairs symbols with the shared refresh list so the app-wide timer
    // fetches them; warm the cache once if anything is still missing.
    _auPairsSyms = shorts.map(function (ss) { return { fyersKey: shortToFyers[ss], cacheKey: ss }; });
    if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
    if (typeof wmsStandardRefresh === 'function' && window.fyersToken) {
        var cold = shorts.some(function (ss) { var r = (window.wmsLivePrices || {})[ss]; return !(r && r.lp > 0); });
        if (cold) { try { await wmsStandardRefresh(true); } catch (_e) {} }
    }
    var cache = window.wmsLivePrices || {};
    shorts.forEach(function (ss) {
        var fk = shortToFyers[ss];
        var bare = fk.replace(/^[A-Z]+:/, '').replace(/-(EQ|BE|BZ|BL|SM|ST)$/i, '');
        var rec = cache[ss] || cache[fk] || cache[bare];
        if (rec && Number.isFinite(rec.lp) && rec.lp > 0) result[ss] = { close: rec.lp, date: 'live' };
    });
    if (Object.keys(result).length === shorts.length) return result;

    // Fallback: latest close from market_prices for any symbols not in the cache
    try {
        var missing = Object.keys(shortToFyers).filter(function (s) { return !result[s]; });
        if (missing.length === 0) return result;
        var symList = missing.map(encodeURIComponent).join(',');
        var secResp = await fetch(
            SUPABASE_URL + '/rest/v1/securities_db?symbol=in.(' + symList + ')&select=id,symbol',
            { headers: wmsHeaders() }
        );
        var secs = await secResp.json();
        if (!Array.isArray(secs) || secs.length === 0) return result;
        var idToSym = {};
        var secIds = secs.map(function (r) { idToSym[r.id] = r.symbol; return r.id; });
        var cutoff = new Date(Date.now() - 10 * 86400 * 1000).toISOString().slice(0, 10);
        var idsList = secIds.map(encodeURIComponent).join(',');
        var priceResp = await fetch(
            SUPABASE_URL + '/rest/v1/market_prices?security_id=in.(' + idsList + ')&resolution=eq.1D&price_date=gte.' + cutoff + '&select=security_id,price_date,close&order=price_date.desc',
            { headers: wmsHeaders() }
        );
        var prices = await priceResp.json();
        prices.forEach(function (p) {
            var sym = idToSym[p.security_id];
            if (!sym || result[sym]) return;
            if (!result[sym] || p.price_date > result[sym].date) {
                result[sym] = { close: p.close, date: p.price_date };
            }
        });
    } catch (_e) { /* keep whatever Fyers returned */ }
    return result;
}

function autoComputePnL(legs, priceMap) {
    if (!Array.isArray(legs) || legs.length === 0) return null;
    var total = 0;
    var anyPriced = false;
    var legBreakdown = [];
    var markDate = null;
    legs.forEach(function (l) {
        var mark = priceMap[l.short_symbol];
        if (!mark || !Number.isFinite(mark.close)) {
            legBreakdown.push(l.short_symbol + ': mark unavailable');
            return;
        }
        anyPriced = true;
        if (!markDate || mark.date < markDate) markDate = mark.date; // oldest mark wins (worst case freshness)
        var legPnL = (l.side === 'BUY')
            ? (mark.close - l.price) * l.qty
            : (l.price - mark.close) * l.qty;
        total += legPnL;
        legBreakdown.push(l.short_symbol + ' ' + l.side + ' ' + l.qty + ' @ entry ₹' + l.price + ' / mark ₹' + mark.close + ' = ' + (legPnL >= 0 ? '+' : '') + Math.round(legPnL));
    });
    if (!anyPriced) return null;
    return { total: total, breakdown: legBreakdown.join(' • '), markDate: markDate };
}

// ----------------------------------------------------------------------------
// Strategy family classifier (KH-PLAN Phase KH-2, 2026-07-10).
//
// Was: `metadata.source === 'tv_webhook'` — a flag that stopped describing
// reality when GS moved in-house on 2026-06-20 (AUTOMATION-LESSONS F.10), yet
// was load-bearing in 9 places as "is this GS?". Worse, the Pairs page derived
// its own membership as "not a `_` sentinel and not tv_webhook" — i.e. EVERYTHING
// ELSE. So the moment the Katalysthive strategy row existed, KH appeared on the
// Pairs page with a Pause button. Verified on prod before this fix.
//
// Now: `metadata.family` ∈ gs | pairs | kh | system is the single source of truth,
// set by KH-1.1. Each page asks for ITS family by name; nobody is "everything else".
//
// A row with no family belongs to no page (and is logged). Fail-closed: a new
// strategy is invisible until classified, rather than silently landing on Pairs.
// ----------------------------------------------------------------------------
async function autoGetStrategyFamilies() {
    if (window._auStrategyFamilies instanceof Map) return window._auStrategyFamilies;
    var map = new Map();
    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?select=name,metadata', { headers: wmsHeaders() });
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));
        var rows = await resp.json();
        (rows || []).forEach(function (r) {
            var fam = (r.metadata || {}).family || null;
            if (!fam) console.warn('[autoGetStrategyFamilies] strategy has no metadata.family — it will appear on no page:', r.name);
            map.set(r.name, fam);
        });
        window._auStrategyFamilies = map;
    } catch (e) {
        // Do NOT cache a failure: an empty map would silently empty every page.
        console.error('[autoGetStrategyFamilies] failed:', e);
    }
    return map;
}
function autoIsGs(fam, name)    { return fam.get(name) === 'gs'; }
function autoIsPairs(fam, name) { return fam.get(name) === 'pairs'; }

async function autoLoadOpenTrades(silent) {
    // Family target first (reads prefer it); Legacy target drops out at Phase E.3.
    var el = autoTarget(['au-pairs-fam-open-content']);
    var statusEl = autoBadgeTarget(['au-pairs-fam-open-badge']);
    if (!el) return;
    if (!silent) {
        if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }
        // Keep the existing table on screen during silent shared-refresh cycles
        // for flicker-free updates; only show the spinner on a user-initiated load.
        if (!el.firstElementChild || !el.querySelector('table')) {
            el.innerHTML = '<div class="au-meta">⏳ Loading open trades…</div>';
        }
    }

    try {
        // 1) Get list of open trade_ids from the view, filter out webhook strategies
        var fam = await autoGetStrategyFamilies();
        var openResp = await fetch(
            SUPABASE_URL + '/rest/v1/v_auto_open_trades?select=*',
            { headers: wmsHeaders() }
        );
        var openRowsAll = await openResp.json();
        var openRows = (openRowsAll || []).filter(function (r) { return autoIsPairs(fam, r.strategy_name); });
        if (!Array.isArray(openRows) || openRows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No open pairs trades.</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 open'; }
            return;
        }

        // 2) Fetch ENTRY signals for those trade_ids
        var tradeIds = openRows.map(function (r) { return r.trade_id; });
        var idsList = tradeIds.map(encodeURIComponent).join(',');
        var sigResp = await fetch(
            SUPABASE_URL + '/rest/v1/auto_signals?event_type=eq.ENTRY&trade_id=in.(' + idsList + ')&select=trade_id,fired_at,score,direction,legs,metadata,strategy_name',
            { headers: wmsHeaders() }
        );
        var sigRows = await sigResp.json();
        var byTrade = {};
        sigRows.forEach(function (s) { byTrade[s.trade_id] = s; });

        // 3) Fetch latest close per symbol from market_prices for live P&L mark.
        //    During trading hours this is yesterday's close; after eod-prices-ingest
        //    runs (18:00 IST) it'll be today's close. Tooltip shows the mark date.
        var priceMap = await autoFetchLatestPrices(sigRows);

        var now = Date.now();
        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Pair</th>' +
                '<th style="padding:6px 8px">Strategy</th>' +
                '<th style="padding:6px 8px">Action</th>' +
                '<th style="padding:6px 8px">Entry</th>' +
                '<th style="padding:6px 8px">Days</th>' +
                '<th style="padding:6px 8px">Entry Z90</th>' +
                '<th style="padding:6px 8px">Z<sub>tgt</sub> / Z<sub>stop</sub></th>' +
                '<th style="padding:6px 8px">Score</th>' +
                '<th style="padding:6px 8px">P&amp;L</th>' +
                '<th style="padding:6px 8px">Net Position</th>' +
                '<th style="padding:6px 8px">Trade</th>' +
                '<th style="padding:6px 8px">Action</th>' +
                '</tr></thead><tbody>';
        openRows.forEach(function (ot) {
            var sig = byTrade[ot.trade_id];
            var m = (sig && sig.metadata) || {};
            var pair = m.Pair || '—';
            var action = m.Action || (sig ? sig.direction : '—');
            var entry = sig ? autoFmtIST(sig.fired_at) : '—';
            var daysHeld = sig ? Math.floor((now - new Date(sig.fired_at).getTime()) / 86400000) : '—';
            var entryZ = m.Z90 != null ? m.Z90 : '—';
            var zTgt = m.Z_Target != null ? m.Z_Target : '—';
            var zStop = m.Z_Stop != null ? m.Z_Stop : '—';
            var score = sig ? (sig.score + '/' + (m.Score_Max || 13)) : '—';
            // net_position is a JSONB object — render as compact string
            var netPos = ot.net_position ? Object.keys(ot.net_position).map(function (k) {
                var v = ot.net_position[k];
                return (v > 0 ? '+' : '') + v + ' ' + k.replace('NSE:', '').replace('-EQ', '');
            }).join(' / ') : '—';
            var tradeFrag = ot.trade_id ? ot.trade_id.slice(0, 8) + '…' : '—';

            // Live P&L — computed against latest market_prices close
            var pnlCell = '<span style="color:#9ca3af">—</span>';
            var pnlTooltip = 'Mark prices not available — was the EOD ingest run today?';
            var pnl = sig ? autoComputePnL(sig.legs, priceMap) : null;
            if (pnl) {
                var sign = pnl.total >= 0 ? '+' : '−';
                var color = pnl.total >= 0 ? '#047857' : '#dc2626';
                var abs = Math.abs(Math.round(pnl.total)).toLocaleString('en-IN');
                pnlCell = '<span style="color:' + color + ';font-weight:600">' + sign + '₹' + abs + '</span>';
                pnlTooltip = 'Mark date: ' + pnl.markDate + ' • ' + pnl.breakdown;
            }
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px"><strong>' + autoEsc(pair) + '</strong></td>' +
                    '<td style="padding:6px 8px"><code>' + autoEsc(ot.strategy_name) + '</code></td>' +
                    '<td style="padding:6px 8px">' + autoEsc(action) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(entry) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(String(daysHeld)) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(String(entryZ)) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(String(zTgt)) + ' / ' + autoEsc(String(zStop)) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(score) + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;white-space:nowrap" title="' + autoEsc(pnlTooltip) + '">' + pnlCell + '</td>' +
                    '<td style="padding:6px 8px;font-size:11px">' + autoEsc(netPos) + '</td>' +
                    '<td style="padding:6px 8px;font-family:monospace;font-size:11px">' + autoEsc(tradeFrag) + '</td>' +
                    '<td style="padding:6px 8px"><button class="au-btn au-btn-danger" style="padding:4px 8px;font-size:11px"' +
                        ' onclick="autoManualClose(' + JSON.stringify(ot.trade_id).replace(/"/g, '&quot;') + ')">✕ Close</button></td>' +
                    '</tr>';
        });
        html += '</tbody></table></div>';
        el.innerHTML = html;
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = openRows.length + ' open'; }
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
    }
}

// ----------------------------------------------------------------------------
// Closed Trades block (sibling card on the Open Trades tab)
// ----------------------------------------------------------------------------
//
// There is no auto_trades table — every trade is a `trade_id` UUID shared
// across `auto_signals` events (ENTRY → TARGET_HIT / STOP_HIT / TIME_STOP /
// MANUAL_CLOSE). The `v_auto_open_trades` SQL view derives openness by
// summing legs across signals and keeping trade_ids where some leg has
// non-zero net qty.
//
// "Closed" is the inverse: trade_ids where ALL legs net to zero. Rather
// than adding a mirror SQL view (Option B in the design discussion), we
// derive this client-side from the same `legs` JSON the open view uses —
// no DB migration, same source data, can't disagree with the open view
// because both consume the same events.
//
// Realised P&L = Σ legs across all events of (side === 'SELL' ? +1 : −1)
// × price × qty. For a fully-closed trade this is the actual cash settled.

var _AU_CLOSED_LIMIT = 500;  // Recent events window — covers everything since PAPER launch

function _autoExitTypeLabel(t) {
    if (!t) return '—';
    return t.replace(/_/g, ' ');  // TARGET_HIT → "TARGET HIT"
}

function _autoExitTypeColor(t) {
    return t === 'TARGET_HIT' ? '#0891b2' :
           t === 'STOP_HIT'   ? '#dc2626' :
           t === 'TIME_STOP'  ? '#92400e' :
           t === 'MANUAL_CLOSE' ? '#7c3aed' : '#6b7280';
}

async function autoLoadClosedTrades() {
    // Family target first (reads prefer it); Legacy target drops out at Phase E.3.
    var el = autoTarget(['au-pairs-fam-closed-content']);
    var statusEl = autoBadgeTarget(['au-pairs-fam-closed-badge']);
    // Scope footnote (the _AU_CLOSED_LIMIT disclosure, AUTOMATION-LESSONS F.7n) —
    // must appear on BOTH surfaces or the limit becomes invisible on the family page.
    var footEl = autoBadgeTarget(['au-pairs-fam-closed-footnote']);
    if (!el) return;
    if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }
    el.innerHTML = '<div class="au-meta">⏳ Loading closed trades…</div>';
    if (footEl) footEl.textContent = '';

    try {
        // Get set of webhook strategy names to exclude (handled by GS Closed card)
        var fam = await autoGetStrategyFamilies();
        // Fetch recent events. The window covers everything since the module
        // went live (29-Apr-2026); revisit pagination if/when the event log
        // grows past 500. Order desc so we naturally see the most recent
        // first and footnote the scope cleanly.
        var resp = await fetch(
            SUPABASE_URL + '/rest/v1/auto_signals?order=fired_at.desc&limit=' + _AU_CLOSED_LIMIT +
            '&select=id,trade_id,strategy_name,fired_at,event_type,direction,score,legs,metadata',
            { headers: wmsHeaders() }
        );
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
        var allSignals = await resp.json();
        if (!Array.isArray(allSignals)) allSignals = [];

        // Group by trade_id
        var byTrade = {};
        allSignals.forEach(function (s) {
            if (!s.trade_id) return;
            if (!byTrade[s.trade_id]) byTrade[s.trade_id] = [];
            byTrade[s.trade_id].push(s);
        });

        // For each group: compute per-symbol net qty + realised P&L. Closed
        // iff every symbol nets to exactly zero AND there is ≥1 non-ENTRY
        // event. Trades that have only the ENTRY in our window are obviously
        // not closed.
        var closedRows = [];
        Object.keys(byTrade).forEach(function (tradeId) {
            var events = byTrade[tradeId];
            var hasExitEvent = false;
            var netBySym = {};
            var pnl = 0;
            events.forEach(function (s) {
                if (s.event_type !== 'ENTRY') hasExitEvent = true;
                (s.legs || []).forEach(function (l) {
                    var sym = l.short_symbol || l.symbol || '';
                    if (!sym) return;
                    var q = Number(l.qty) || 0;
                    var p = Number(l.price) || 0;
                    if ((l.side || '').toUpperCase() === 'BUY') {
                        netBySym[sym] = (netBySym[sym] || 0) + q;
                        pnl -= p * q;
                    } else if ((l.side || '').toUpperCase() === 'SELL') {
                        netBySym[sym] = (netBySym[sym] || 0) - q;
                        pnl += p * q;
                    }
                });
            });
            if (!hasExitEvent) return;
            // All symbols must net to zero (tolerate float dust from numeric storage)
            var allZero = Object.keys(netBySym).every(function (k) {
                return Math.abs(netBySym[k]) < 1e-6;
            });
            if (!allZero) return;

            // Pick the ENTRY event (oldest within the trade) and the closing
            // event (most recent non-ENTRY)
            var entry = null, exit = null;
            events.forEach(function (s) {
                if (s.event_type === 'ENTRY') {
                    if (!entry || s.fired_at < entry.fired_at) entry = s;
                } else {
                    if (!exit || s.fired_at > exit.fired_at) exit = s;
                }
            });
            if (!entry) return;  // edge case — no ENTRY in our window (window too narrow)

            // Skip webhook-driven strategies — they have their own GS Closed card
            if (autoIsGs(fam, entry.strategy_name)) return;
            closedRows.push({
                trade_id: tradeId,
                strategy_name: entry.strategy_name,
                entry: entry,
                exit: exit,
                pnl: pnl
            });
        });

        // Sort: most recently closed first
        closedRows.sort(function (a, b) {
            var aT = a.exit ? a.exit.fired_at : a.entry.fired_at;
            var bT = b.exit ? b.exit.fired_at : b.entry.fired_at;
            return bT < aT ? -1 : bT > aT ? 1 : 0;
        });

        if (closedRows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No closed trades in the last ' + _AU_CLOSED_LIMIT + ' events.</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 closed'; }
            if (footEl) footEl.textContent = 'Scope: most recent ' + allSignals.length + ' events (max ' + _AU_CLOSED_LIMIT + ').';
            return;
        }

        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Pair</th>' +
                '<th style="padding:6px 8px">Strategy</th>' +
                '<th style="padding:6px 8px">Action</th>' +
                '<th style="padding:6px 8px">Entry</th>' +
                '<th style="padding:6px 8px">Exit</th>' +
                '<th style="padding:6px 8px">Days</th>' +
                '<th style="padding:6px 8px">Entry Z90</th>' +
                '<th style="padding:6px 8px">Exit Reason</th>' +
                '<th style="padding:6px 8px;text-align:right">Realised P&amp;L</th>' +
                '<th style="padding:6px 8px">Trade</th>' +
                '</tr></thead><tbody>';

        var totalPnL = 0, winCount = 0, lossCount = 0;
        closedRows.forEach(function (ct) {
            var em = (ct.entry && ct.entry.metadata) || {};
            var pair = em.Pair || '—';
            var action = em.Action || (ct.entry ? ct.entry.direction : '—');
            var entryStr = ct.entry ? autoFmtIST(ct.entry.fired_at) : '—';
            var exitStr = ct.exit ? autoFmtIST(ct.exit.fired_at) : '—';
            var daysHeld = (ct.entry && ct.exit) ? Math.max(0, Math.floor((new Date(ct.exit.fired_at).getTime() - new Date(ct.entry.fired_at).getTime()) / 86400000)) : '—';
            var entryZ = em.Z90 != null ? em.Z90 : '—';
            var exitType = ct.exit ? ct.exit.event_type : '—';
            var exitTypeColor = _autoExitTypeColor(exitType);

            var pnl = ct.pnl;
            totalPnL += pnl;
            if (pnl >= 0) winCount++; else lossCount++;
            var pnlSign = pnl >= 0 ? '+' : '−';
            var pnlColor = pnl >= 0 ? '#047857' : '#dc2626';
            var pnlAbs = Math.abs(Math.round(pnl)).toLocaleString('en-IN');
            var pnlCell = '<span style="color:' + pnlColor + ';font-weight:600">' + pnlSign + '₹' + pnlAbs + '</span>';

            var tradeFrag = ct.trade_id ? ct.trade_id.slice(0, 8) + '…' : '—';

            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px"><strong>' + autoEsc(pair) + '</strong></td>' +
                    '<td style="padding:6px 8px"><code>' + autoEsc(ct.strategy_name) + '</code></td>' +
                    '<td style="padding:6px 8px">' + autoEsc(action) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(entryStr) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(exitStr) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(String(daysHeld)) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(String(entryZ)) + '</td>' +
                    '<td style="padding:6px 8px"><span style="color:' + exitTypeColor + ';font-weight:600">' + autoEsc(_autoExitTypeLabel(exitType)) + '</span></td>' +
                    '<td style="padding:6px 8px;text-align:right;white-space:nowrap">' + pnlCell + '</td>' +
                    '<td style="padding:6px 8px;font-family:monospace;font-size:11px">' + autoEsc(tradeFrag) + '</td>' +
                    '</tr>';
        });

        // Summary footer row
        var totalSign = totalPnL >= 0 ? '+' : '−';
        var totalColor = totalPnL >= 0 ? '#047857' : '#dc2626';
        var totalAbs = Math.abs(Math.round(totalPnL)).toLocaleString('en-IN');
        html += '<tfoot><tr style="border-top:2px solid #cbd5e0;background:#f7fafc;font-weight:700">' +
                '<td colspan="8" style="padding:8px">Total (' + closedRows.length + ' closed' +
                (winCount + lossCount > 0 ? ' — ' + winCount + 'W / ' + lossCount + 'L' : '') + ')</td>' +
                '<td style="padding:8px;text-align:right;color:' + totalColor + '">' + totalSign + '₹' + totalAbs + '</td>' +
                '<td style="padding:8px">—</td>' +
                '</tr></tfoot>';

        html += '</tbody></table></div>';
        el.innerHTML = html;
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = closedRows.length + ' closed'; }
        if (footEl) footEl.textContent = 'Scope: most recent ' + allSignals.length + ' events (max ' + _AU_CLOSED_LIMIT + '). Trades whose ENTRY falls outside this window won\'t appear.';
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
    }
}

// ----------------------------------------------------------------------------
// GS Open + Closed Trades cards (TV webhook driven — single-instrument MS007)
// ----------------------------------------------------------------------------
//
// These cards mirror the structure of autoLoadOpenTrades / autoLoadClosedTrades
// but render fields specific to single-instrument futures strategies (Silver
// Mini, Gold Mini): entry/stop/ATR/contract/qty + live P&L computed against
// the current Fyers LTP for the executed front-month symbol.
//
// Live P&L formula:
//   side_sign × (ltp − entry_price) × qty_lots × point_value
//   where side_sign = +1 for LONG, −1 for SHORT.
//
// Point values are intrinsic to the underlying contract spec (₹ profit per ₹1
// price move per lot). Source of truth = gs_catalogue.ts on the server; we
// duplicate the values here for browser use. Add new entries when a new GS
// instrument is added to gs_catalogue.

var AU_GS_POINT_VALUES = {
    SILVERM: 5.0,
    GOLDM:   10.0,
    // Add more when needed; trades for instruments not listed show P&L as "—".
};


// Physical lot size for display (so "5 lots" can be enriched as "= 25 kg").
// SILVERM: 1 lot = 5 kg of silver.
// GOLDM:   1 lot = 100 g of gold (= 10 × 10g quotation unit).
var AU_GS_PHYSICAL_LOT = {
    SILVERM: { qty: 5,   unit: 'kg' },
    GOLDM:   { qty: 100, unit: 'g'  },
};

// Margin requirement as % of notional exposure (Fyers SPAN + exposure, rounded
// up to a conservative buffer). Confirmed against Fyers margin calculator
// 2026-06-02: SILVERM 1 lot @ ~₹13.65L exposure → ~₹2.55L margin (18.7%, round
// to 20). GOLDM 1 lot @ ~₹15.80L exposure → ~₹1.45L margin (9.2%, round to 10).
// Update when broker margin rules change.
var AU_GS_MARGIN_PCT = {
    SILVERM: 20,
    GOLDM:   10,
};

function autoGsPointValue(shortSymbol) {
    return AU_GS_POINT_VALUES[shortSymbol] || null;
}

function autoGsPhysicalLot(shortSymbol) {
    return AU_GS_PHYSICAL_LOT[shortSymbol] || null;
}

function autoGsMarginPct(shortSymbol) {
    return AU_GS_MARGIN_PCT[shortSymbol] || null;
}

// Read current LTP for a list of full Fyers symbols from the shared price cache
// `wmsLivePrices` (populated by the single app-wide wmsStandardRefresh). Returns
// Map<symbol, ltp>. No direct Fyers call — the shared timer owns all fetching.
// (WMS-LESSONS §E.11.10)
function autoFetchLtpForSymbols(symbols) {
    var out = new Map();
    if (!symbols || symbols.length === 0) return out;
    var cache = window.wmsLivePrices || {};
    symbols.forEach(function (sym) {
        if (!sym) return;
        var bare = sym.replace(/^[A-Z]+:/, '');
        var rec = cache[sym] || cache[bare];
        if (rec && typeof rec.lp === 'number' && rec.lp > 0) out.set(sym, rec.lp);
    });
    return out;
}

// Compute live P&L for one GS trade. Returns { pnl, breakdown } or null if
// we can't compute (missing LTP or unknown point_value).
// entryPxOverride (optional): the REAL broker-fill entry price for a LIVE trade
// (joined via transactions). When supplied it replaces the modelled leg price so
// the Live page's open P&L reflects the actual entry (owner decision 2026-07-23).
function autoGsComputeLivePnl(entry, ltpMap, entryPxOverride) {
    if (!entry || !Array.isArray(entry.legs) || entry.legs.length === 0) return null;
    var leg = entry.legs[0];
    var sym = leg.symbol;
    var shortSym = leg.short_symbol;
    var side = (leg.side || '').toUpperCase();
    var entryPrice = (entryPxOverride != null && isFinite(entryPxOverride)) ? Number(entryPxOverride) : Number(leg.price);
    var qtyLots = (entry.metadata && Number(entry.metadata.qty_lots)) || 1;
    var pv = autoGsPointValue(shortSym);
    var ltp = ltpMap.get(sym);
    if (!isFinite(entryPrice) || !pv || !isFinite(ltp)) return null;
    var sideSign = side === 'BUY' ? 1 : -1;
    var pnl = sideSign * (ltp - entryPrice) * qtyLots * pv;
    var breakdown = side + ' ' + qtyLots + ' lot · entry ' + entryPrice + ' → LTP ' + ltp +
                    ' · move ' + (ltp - entryPrice).toFixed(2) + ' × pv ' + pv;
    return { pnl: pnl, ltp: ltp, breakdown: breakdown };
}

async function autoLoadGsOpenTrades(mode, silent) {
    mode = mode || 'paper';
    var isLive = mode === 'live';
    var el = document.getElementById('au-gs-' + mode + '-open-content');
    var statusEl = document.getElementById('au-gs-' + mode + '-open-badge');
    var sumEl = document.getElementById('au-gs-' + mode + '-open-summary');
    if (!el) return;
    if (!silent) {
        if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }
        if (!el.firstElementChild || el.firstElementChild.tagName !== 'DIV' || !el.firstElementChild.querySelector('table')) {
            // Only show the spinner if there's no rendered table yet — auto-refresh
            // keeps the existing table on screen for smooth flicker-free updates.
            el.innerHTML = '<div class="au-meta">⏳ Loading GS open trades…</div>';
        }
    }

    try {
        var fam = await autoGetStrategyFamilies();
        var modeMap = await autoGetStrategyModes();

        // 1. Open trades from v_auto_open_trades → GS family AND this page's channel/mode.
        //    Channel-authoritative (single-scan fan-out): a canonical strategy holds BOTH books,
        //    so the open row's own `channel` decides the page. Falls back to the strategy mode
        //    classifier only for rows without a channel (pre-migration legacy).
        var openResp = await fetch(SUPABASE_URL + '/rest/v1/v_auto_open_trades?select=*', { headers: wmsHeaders() });
        var openAll = await openResp.json();
        var openRows = (openAll || []).filter(function (r) {
            if (!autoIsGs(fam, r.strategy_name)) return false;
            if (r.channel) return r.channel === mode;
            return autoGsModeOf(modeMap, r.strategy_name) === mode;
        });

        if (openRows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No open ' + (isLive ? 'LIVE' : 'PAPER') + ' GS trades.</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 open'; }
            if (sumEl) sumEl.textContent = '';
            _auGsSyms[mode] = [];
            if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
            var _tz = _auGsTotals[mode];
            _tz.openCount = 0; _tz.openExposure = null; _tz.openMargin = null; _tz.openLivePnl = null;
            autoGsTotalsChanged(mode);
            return;
        }

        // 2. Fetch ENTRY signals for those trade_ids
        var tradeIds = openRows.map(function (r) { return r.trade_id; });
        var idsList = tradeIds.map(encodeURIComponent).join(',');
        var sigResp = await fetch(
            SUPABASE_URL + '/rest/v1/auto_signals?event_type=eq.ENTRY&trade_id=in.(' + idsList + ')&select=id,trade_id,strategy_name,fired_at,direction,legs,metadata',
            { headers: wmsHeaders() }
        );
        var sigRows = await sigResp.json();
        var byTrade = {};
        sigRows.forEach(function (s) { byTrade[s.trade_id] = s; });

        // 2b. LIVE page only — real broker fills for the entry orders (owner decision
        //     2026-07-23). Join auto_signals.metadata.broker_order_id → transactions.
        //     Fail-soft: any signal without a matching fill falls back to modelled.
        var fillMap = new Map();
        if (isLive) {
            var entryOrderIds = sigRows.map(function (s) { return s.metadata && s.metadata.broker_order_id; }).filter(Boolean);
            fillMap = await autoGsFetchFillMap(entryOrderIds);

            // Fill-awareness (2026-07-24): the engine may still show a trade "open"
            // for several candles after the broker's resting-SL has already covered
            // it (bar-close CLOSE signal lags the intrabar fill). Cross-check each
            // engine-open trade against the broker's real net position; drop the ones
            // the broker has already closed. Fail-soft: null → keep engine truth.
            var coreOf = function (ot) {
                var s = byTrade[ot.trade_id];
                var sym = s && s.legs && s.legs[0] && s.legs[0].symbol;
                return sym ? sym.replace(/^[A-Z]+:/, '') : null;
            };
            var netBySym = await autoGsFetchNetBySymbol(openRows.map(coreOf).filter(Boolean));
            if (netBySym) {
                var settled = 0;
                openRows = openRows.filter(function (ot) {
                    var core = coreOf(ot);
                    if (!core || !netBySym.has(core)) return true;   // unknown symbol → keep (engine truth)
                    if (Math.round(netBySym.get(core)) !== 0) return true;   // broker still holds → keep
                    settled++; return false;                          // broker flat → already closed, drop
                });
                _auGsFillSettled = settled;   // surfaced in the summary line below
            } else {
                _auGsFillSettled = 0;
            }

            // All engine-open live trades are already closed at the broker.
            if (openRows.length === 0) {
                el.innerHTML = '<div class="au-soon" style="padding:20px">No open LIVE GS trades.' +
                    (_auGsFillSettled ? ' <span style="color:#6b7280">(' + _auGsFillSettled +
                    ' just closed at broker — engine settling)</span>' : '') + '</div>';
                if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 open'; }
                if (sumEl) sumEl.textContent = '';
                _auGsSyms[mode] = [];
                if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
                var _tzl = _auGsTotals[mode];
                _tzl.openCount = 0; _tzl.openExposure = null; _tzl.openMargin = null; _tzl.openLivePnl = null;
                autoGsTotalsChanged(mode);
                return;
            }
        }

        // 2c. Trader resolution (LIVE only) — for the Trader column. (Filtering by trader lives in
        //     the always-visible Closed filter bar; the open table just labels each row's trader.)
        var _traderMap = isLive ? await autoGetStrategyTraders() : new Map();
        if (isLive && (!_auManualTraders || !_auManualTraders.length)) { try { await autoManualLoadTraders(); } catch (e) {} }

        // 3. Live LTP for unique executed symbols — sourced from the shared price
        //    cache (wmsLivePrices), kept warm by the single app-wide refresh timer.
        var uniqSyms = Array.from(new Set(sigRows.map(function (s) {
            return (s.legs && s.legs[0] && s.legs[0].symbol) || null;
        }).filter(Boolean)));
        // Register this page's symbols with the shared refresh list (E.11.10).
        _auGsSyms[mode] = uniqSyms.map(function (s) { return { fyersKey: s, cacheKey: s.replace(/^[A-Z]+:/, '') }; });
        // Register the provider + start the shared 10s timer so these MCX symbols are kept warm
        // (without this, wmsBuildRefreshSymbols may not include them → LTP stops updating = the lag).
        if (typeof autoEnsureSharedRefresh === 'function') autoEnsureSharedRefresh();
        else if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
        // On a user-initiated (non-silent) load, warm the cache once if these
        // symbols aren't priced yet — the silent shared-refresh cycles just read.
        if (!silent && typeof wmsStandardRefresh === 'function' && window.fyersToken) {
            var cold = uniqSyms.some(function (s) {
                var b = s.replace(/^[A-Z]+:/, '');
                var r = (window.wmsLivePrices || {})[s] || (window.wmsLivePrices || {})[b];
                return !(r && r.lp > 0);
            });
            if (cold) { try { await wmsStandardRefresh(true); } catch (_e) {} }
        }
        var ltpMap = autoFetchLtpForSymbols(uniqSyms);
        // Friendly labels + current trail SL (live only) for the render below.
        var dispMap = await autoGetStrategyDisplayNames();
        var slMap = isLive ? await autoGsFetchSlMap(Array.from(new Set(openRows.map(function (o) { return o.strategy_name; })))) : new Map();

        var now = Date.now();
        // Current amount display unit suffix ('000 / L / M / Cr) for the ₹ column headers.
        var _uSfx = (typeof getUnitConfig === 'function' && typeof getDisplayUnit === 'function')
            ? (getUnitConfig(getDisplayUnit()).suffix || '') : '';
        var headerRow = '<tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Strategy</th>' +
                (isLive ? '<th style="padding:6px 8px">Trader</th>' : '') +
                '<th style="padding:6px 8px">Side</th>' +
                '<th style="padding:6px 8px">Entry<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ days held</span></th>' +
                '<th style="padding:6px 8px">Contract</th>' +
                '<th style="padding:6px 8px;text-align:right">Qty</th>' +
                '<th style="padding:6px 8px;text-align:right">Entry Px<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ SL</span></th>' +
                '<th style="padding:6px 8px;text-align:right">LTP</th>' +
                '<th style="padding:6px 8px;text-align:right">Exposure<br><span style="font-weight:400;color:#6b7280;font-size:10px">₹ ' + _uSfx + '</span></th>' +
                '<th style="padding:6px 8px;text-align:right">Margin<br><span style="font-weight:400;color:#6b7280;font-size:10px">₹ ' + _uSfx + ' / %</span></th>' +
                '<th style="padding:6px 8px;text-align:right">Live P&amp;L<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ % of exp</span></th>' +
                '<th style="padding:6px 8px">Action</th>' +
                '</tr>';

        var totalPnl = 0, anyPnl = false;
        var totalExposure = 0, totalMargin = 0, anyExposure = false;
        var body = '';
        openRows.forEach(function (ot) {
            var sig = byTrade[ot.trade_id];
            var leg = sig && sig.legs && sig.legs[0];
            var m = (sig && sig.metadata) || {};
            var side = sig ? (sig.direction || (leg && leg.side === 'BUY' ? 'LONG' : 'SHORT')) : '—';
            var sideBadge = side === 'LONG'
                ? '<span class="au-badge success">LONG</span>'
                : side === 'SHORT'
                    ? '<span class="au-badge error">SHORT</span>'
                    : autoEsc(side);
            var entryStr = sig ? autoFmtIST(sig.fired_at) : '—';
            var daysHeld = sig ? Math.floor((now - new Date(sig.fired_at).getTime()) / 86400000) : null;
            var daysSub = daysHeld != null
                ? '<div style="color:#6b7280;font-size:10px;margin-top:1px">' + daysHeld + ' day' + (daysHeld === 1 ? '' : 's') + '</div>'
                : '';
            var contract = leg ? autoFmtContract(leg.symbol, leg.expiry_date) : '—';
            var shortSym = leg ? leg.short_symbol : null;

            // LIVE: prefer the REAL broker-fill entry price; fall back to modelled if
            // the signal has no broker_order_id yet or the transaction isn't linked.
            var modelledEntry = leg && leg.price != null ? Number(leg.price) : null;
            var fill = isLive ? fillMap.get(String(m.broker_order_id || '')) : null;
            var usingReal = !!(fill && isFinite(fill.price));
            var entryPriceNum = usingReal ? fill.price : modelledEntry;
            // Trail SL: prefer the live resting-SL level (the moving broker stop), then the entry
            // stop, then the legacy metadata.stop_price. (The old code read only stop_price, which
            // these v3 signals don't carry → the SL sub-row was always blank.)
            var trailSl = isLive ? slMap.get(ot.strategy_name) : null;
            var stopPriceNum = (trailSl != null) ? Number(trailSl)
                : (m.stop_at_entry != null ? Number(m.stop_at_entry)
                : (m.stop_price != null ? Number(m.stop_price) : null));

            // Qty cell: "5 lots" + sub-row "25 kg" (physical size if known).
            var qtyLots = m.qty_lots != null ? Number(m.qty_lots) : (leg ? Number(leg.qty) : null);
            var qtyMain = qtyLots != null ? qtyLots + ' lot' + (qtyLots == 1 ? '' : 's') : '—';
            var physLot = autoGsPhysicalLot(shortSym);
            var qtySub = '';
            if (qtyLots != null && physLot) {
                var totalPhys = qtyLots * physLot.qty;
                qtySub = '<div style="color:#6b7280;font-size:10px;margin-top:1px">' + totalPhys + ' ' + physLot.unit + '</div>';
            }
            var qtyCell = autoEsc(qtyMain) + qtySub;

            // Entry Px cell: main = entry price (zero decimals); sub = "SL: 272,661".
            // LIVE fallback rows are marked "~modelled" so nothing blanks out silently.
            var entryPxMain = autoFmtPrice0(entryPriceNum);
            var stopSub = stopPriceNum != null
                ? '<div style="color:#6b7280;font-size:10px;margin-top:1px">SL: ' + autoFmtPrice0(stopPriceNum) + '</div>'
                : '';
            if (isLive && !usingReal) {
                stopSub += '<div style="color:#b45309;font-size:10px;margin-top:1px" title="No linked broker fill yet — showing the modelled signal price.">~modelled</div>';
            }

            // Exposure = qty_lots × point_value × entry_price  (₹ notional).
            var pv = shortSym ? autoGsPointValue(shortSym) : null;
            var exposure = (qtyLots != null && pv && entryPriceNum != null) ? (qtyLots * pv * entryPriceNum) : null;
            var exposureCell = exposure != null
                ? formatAmount(exposure)   // app display-unit ('000/L/…), ₹ full amount in tooltip
                : '<span style="color:#9ca3af">—</span>';
            if (exposure != null) { totalExposure += exposure; anyExposure = true; }

            // Margin = exposure × margin_pct/100. Per-instrument %, see AU_GS_MARGIN_PCT.
            var marginPct = shortSym ? autoGsMarginPct(shortSym) : null;
            var margin = (exposure != null && marginPct != null) ? (exposure * marginPct / 100) : null;
            var marginCell;
            if (margin != null) {
                totalMargin += margin;
                marginCell = formatAmount(margin) +
                             '<div style="color:#6b7280;font-size:10px;margin-top:1px">' + marginPct + '%</div>';
            } else {
                marginCell = '<span style="color:#9ca3af">—</span>';
            }

            // P&L vs LTP — LIVE uses the real entry price override.
            var pnlInfo = sig ? autoGsComputeLivePnl(sig, ltpMap, usingReal ? fill.price : null) : null;
            var ltpCell, pnlCell, pnlTooltip;
            if (pnlInfo) {
                anyPnl = true;
                totalPnl += pnlInfo.pnl;
                ltpCell = autoFmtPrice0(pnlInfo.ltp);
                var sign = pnlInfo.pnl >= 0 ? '+' : '−';
                var col = pnlInfo.pnl >= 0 ? '#047857' : '#dc2626';
                var abs = Math.abs(Math.round(pnlInfo.pnl)).toLocaleString('en-IN');
                var pctSub = '';
                if (exposure && exposure > 0) {
                    var pct = (pnlInfo.pnl / exposure) * 100;
                    var pctSign = pct >= 0 ? '+' : '−';
                    pctSub = '<div style="color:' + col + ';font-size:10px;margin-top:1px;font-weight:500">' +
                             pctSign + Math.abs(pct).toFixed(2) + '%</div>';
                }
                pnlCell = '<span style="color:' + col + ';font-weight:600">' + sign + '₹' + abs + '</span>' + pctSub;
                pnlTooltip = pnlInfo.breakdown + (isLive ? (usingReal ? ' · real fill' : ' · modelled (no linked fill)') : '');
            } else {
                ltpCell = '<span style="color:#9ca3af">—</span>';
                pnlCell = '<span style="color:#9ca3af">—</span>';
                pnlTooltip = 'Live P&L needs (a) Fyers connection for LTP and (b) a known point_value for the underlying.';
            }

            body += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px;vertical-align:top"><div title="' + autoEsc(ot.strategy_name) + '" style="font-weight:700;color:#1d4ed8">' + autoEsc(autoGsDispLabel(dispMap, ot.strategy_name)) + '</div><div style="margin-top:2px"><code style="font-size:9.5px;color:#64748b;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;padding:1px 5px">' + autoEsc(ot.strategy_name) + '</code></div></td>' +
                    (isLive ? '<td style="padding:6px 8px;vertical-align:top"><span class="au-badge" style="background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe">' + autoEsc(autoGsTraderOf(_traderMap, ot.strategy_name)) + '</span></td>' : '') +
                    '<td style="padding:6px 8px;vertical-align:top">' + sideBadge + '</td>' +
                    '<td style="padding:6px 8px;vertical-align:top">' + autoEsc(entryStr) + daysSub + '</td>' +
                    '<td style="padding:6px 8px;vertical-align:top">' + autoEsc(contract) + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + qtyCell + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + autoEsc(entryPxMain) + stopSub + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + ltpCell + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + exposureCell + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + marginCell + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;white-space:nowrap;vertical-align:top" title="' + autoEsc(pnlTooltip) + '">' + pnlCell + '</td>' +
                    '<td style="padding:6px 8px;vertical-align:top"><button class="au-btn au-btn-danger" style="padding:4px 8px;font-size:11px"' +
                        ' onclick="autoManualClose(' + JSON.stringify(ot.trade_id).replace(/"/g, '&quot;') + ')">✕ Close</button></td>' +
                    '</tr>';
        });

        // Totals row — rendered at the TOP of the table (owner ask; matches Closed).
        var totalsRowTop = '';
        if (anyExposure || anyPnl) {
            var expCell = anyExposure
                ? formatAmount(totalExposure)
                : '<span style="color:#9ca3af">—</span>';
            var mgnCell = anyExposure
                ? formatAmount(totalMargin)
                : '<span style="color:#9ca3af">—</span>';
            var pnlTotalCell;
            if (anyPnl) {
                var tSign = totalPnl >= 0 ? '+' : '−';
                var tCol = totalPnl >= 0 ? '#047857' : '#dc2626';
                var tAbs = Math.abs(Math.round(totalPnl)).toLocaleString('en-IN');
                var totPctSub = '';
                if (anyExposure && totalExposure > 0) {
                    var totPct = (totalPnl / totalExposure) * 100;
                    var totPctSign = totPct >= 0 ? '+' : '−';
                    totPctSub = '<div style="color:' + tCol + ';font-size:10px;margin-top:1px;font-weight:500">' +
                                totPctSign + Math.abs(totPct).toFixed(2) + '%</div>';
                }
                pnlTotalCell = '<span style="color:' + tCol + '">' + tSign + '₹' + tAbs + '</span>' + totPctSub;
            } else {
                pnlTotalCell = '<span style="color:#9ca3af">—</span>';
            }
            totalsRowTop = '<tr style="background:#f7fafc;border-bottom:2px solid #cbd5e0;font-weight:700;position:sticky;top:0">' +
                    '<td colspan="' + (isLive ? 8 : 7) + '" style="padding:8px;text-align:right">Totals (' + openRows.length + ' open):</td>' +
                    '<td style="padding:8px;text-align:right;vertical-align:top">' + expCell + '</td>' +
                    '<td style="padding:8px;text-align:right;vertical-align:top">' + mgnCell + '</td>' +
                    '<td style="padding:8px;text-align:right;vertical-align:top">' + pnlTotalCell + '</td>' +
                    '<td style="padding:8px"></td>' +
                    '</tr>';
        }

        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">' +
                   '<thead>' + totalsRowTop + headerRow + '</thead><tbody>' + body + '</tbody></table></div>';
        html += '<div class="au-meta" style="margin-top:8px;font-size:11px;color:#6b7280;line-height:1.6">' +
                '• LTP via Fyers /quotes (needs active Fyers connection).<br>' +
                '• Lot sizes: SILVERM 1 lot = 5 kg · GOLDM 1 lot = 100 g.<br>' +
                '• Exposure = lots × point_value × entry price.<br>' +
                '• Margin: SILVERM 20% · GOLDM 10% (Fyers SPAN+exposure, rounded up).<br>' +
                (isLive
                    ? '• Entry Px + P&amp;L use REAL broker fills (via transactions); ~modelled = no linked fill yet.'
                    + (_auGsFillSettled ? '<br>• ' + _auGsFillSettled + ' engine-open trade(s) hidden — already closed at broker, engine settling.' : '')
                    : '• P&amp;L = side × (LTP − entry) × lots × point_value (modelled prices).') +
                '</div>';
        el.innerHTML = html;
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = openRows.length + ' open'; }
        if (sumEl) {
            var sumBits = [openRows.length + ' open'];
            if (anyExposure) sumBits.push('exposure ₹' + Math.round(totalExposure).toLocaleString('en-IN'));
            if (anyPnl) sumBits.push('P&L ' + (totalPnl >= 0 ? '+' : '−') + '₹' + Math.abs(Math.round(totalPnl)).toLocaleString('en-IN'));
            sumEl.textContent = sumBits.join(' · ');
        }

        // Populate this page's totals for its card strip.
        var _t = _auGsTotals[mode];
        _t.openCount = openRows.length;
        _t.openExposure = anyExposure ? totalExposure : null;
        _t.openMargin = anyExposure ? totalMargin : null;
        _t.openLivePnl = anyPnl ? totalPnl : null;
        autoGsTotalsChanged(mode);
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load GS open trades: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
    }
}

async function autoLoadGsClosedTrades(mode) {
    mode = mode || 'paper';
    var isLive = mode === 'live';
    var f = _auGsFilters[mode];
    var el = document.getElementById('au-gs-' + mode + '-closed-content');
    var statusEl = document.getElementById('au-gs-' + mode + '-closed-badge');
    var sumEl = document.getElementById('au-gs-' + mode + '-closed-summary');
    if (!el) return;
    if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }
    el.innerHTML = '<div class="au-meta">⏳ Loading GS closed trades…</div>';

    try {
        var fam = await autoGetStrategyFamilies();
        var modeMap = await autoGetStrategyModes();
        // Trader filter (LIVE only): name → trader map, so closed trades can be scoped by trader.
        var _closedTraderMap = isLive ? await autoGetStrategyTraders() : new Map();
        if (isLive && (!_auManualTraders || !_auManualTraders.length)) { try { await autoManualLoadTraders(); } catch (e) {} }

        // Fetch GS auto_signals (last _AU_CLOSED_LIMIT events) for THIS page's mode.
        // Group by trade_id; include only trades that have at least one EXIT and net
        // to zero qty.
        //
        // Filter by strategy_name — NOT by source. The GS strategies migrated from
        // tv-webhook execution to the automation-runner (chassis) in Jun 2026, so
        // pre-migration signals have `source='tv_webhook'` and post-migration ones
        // have `source='chassis'`. A strategy-name filter cleanly covers both eras.
        // Channel-authoritative Live/Paper split (single-scan fan-out): fetch ALL GS-family
        // signals, then keep this page's channel. A canonical strategy holds both books, so
        // filtering by strategy mode would mix them — the signal's own `channel` is the split.
        // Legacy signals (no channel) fall back to the strategy mode classifier.
        var stratList = [...fam.keys()].filter(function (n) {
            return autoIsGs(fam, n);
        }).map(function (n) { return '"' + n + '"'; }).join(',');
        var sigs = [];
        if (stratList) {
            var resp = await fetch(
                SUPABASE_URL + '/rest/v1/auto_signals?strategy_name=in.(' + encodeURIComponent(stratList) +
                ')&order=fired_at.desc&limit=' + _AU_CLOSED_LIMIT +
                '&select=id,trade_id,strategy_name,fired_at,event_type,direction,legs,metadata,source,channel',
                { headers: wmsHeaders() }
            );
            if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
            sigs = await resp.json();
            if (!Array.isArray(sigs)) sigs = [];
            sigs = sigs.filter(function (s) {
                return s.channel ? (s.channel === mode) : (autoGsModeOf(modeMap, s.strategy_name) === mode);
            });
        }

        // LIVE page only — real broker fills for every order in these signals (owner
        // decision 2026-07-23). _gsRealPx() resolves each signal's price to its real
        // fill when linked, else falls back to the modelled leg price (fail-soft).
        var fillMap = new Map();
        if (isLive) {
            var _allOrderIds = sigs.map(function (s) { return s.metadata && s.metadata.broker_order_id; }).filter(Boolean);
            fillMap = await autoGsFetchFillMap(_allOrderIds);
        }
        var _gsRealPx = function (sig) {
            if (isLive && sig && sig.metadata) {
                var fx = fillMap.get(String(sig.metadata.broker_order_id || ''));
                if (fx && isFinite(fx.price)) return fx.price;
            }
            var lg = sig && sig.legs && sig.legs[0];
            return lg && lg.price != null ? Number(lg.price) : null;
        };

        // Source filter (per page). Values: 'all' (default), 'chassis'
        // (automation-runner), 'tv_webhook' (legacy Pine). The trade's source is the
        // ENTRY row's source; EXIT can differ but ENTRY defines origin.
        var _srcFilter = f.source || 'all';

        var byTrade = {};
        sigs.forEach(function (s) {
            if (!s.trade_id) return;
            if (!byTrade[s.trade_id]) byTrade[s.trade_id] = [];
            byTrade[s.trade_id].push(s);
        });

        // Peak exposure / margin computation (HIGH-WATER mark — entries add,
        // exits subtract the matching ENTRY's value, not the EXIT's leg.qty
        // which may be ATR-mismatched per D.26). The running total at any
        // moment = sum of currently-open trades' entry exposures. Max of that
        // running total is the peak.
        //
        // Filter-aware (2026-07-09): when the source filter is set to a
        // specific value, the peak is computed as if only that source ever
        // existed — i.e. we walk only the signals whose ENTRY source matches.
        // "Peak exposure for chassis-only" answers "max risk from that source
        // alone" — the more useful lens for a per-source risk review.
        var sigsAsc = sigs.slice().sort(function (a, b) {
            return a.fired_at < b.fired_at ? -1 : a.fired_at > b.fired_at ? 1 : 0;
        });
        var entryByTrade = {};
        sigsAsc.forEach(function (s) {
            if (s.event_type === 'ENTRY') entryByTrade[s.trade_id] = s;
        });
        function _gsTradeExposureOf(entrySig) {
            if (!entrySig || !entrySig.legs || !entrySig.legs[0]) return { exp: 0, mgn: 0 };
            var leg = entrySig.legs[0];
            var em = entrySig.metadata || {};
            var qLots = em.qty_lots != null ? Number(em.qty_lots) : Number(leg.qty || 0);
            var pv  = autoGsPointValue(leg.short_symbol);
            var mP  = autoGsMarginPct(leg.short_symbol);
            var _px = _gsRealPx(entrySig);   // LIVE → real fill; else modelled leg price
            var exp = (qLots && pv && _px != null) ? (qLots * pv * Number(_px)) : 0;
            var mgn = mP ? (exp * mP / 100) : 0;
            return { exp: exp, mgn: mgn };
        }
        // Apply the FULL closed-trade filter set to the peak walk (owner request,
        // 2026-07-22): source, instrument, version, result (win/loss) and exit category —
        // the same bar that scopes the Realised card. A trade is included in the walk only
        // if it passes every active filter. Result/exit are outcome-derived: a still-open
        // trade (no exit yet) has no result, so it is treated as non-matching whenever the
        // Result or Exit filter is active.
        var _gsExitOf = function (tid) {
            var ev = byTrade[tid] || [], ex = null;
            ev.forEach(function (s) { if (s.event_type !== 'ENTRY' && (!ex || s.fired_at > ex.fired_at)) ex = s; });
            return ex;
        };
        var _gsPnlOf = function (entrySig, exitSig) {
            var leg = entrySig && entrySig.legs && entrySig.legs[0];
            var xLeg = exitSig && exitSig.legs && exitSig.legs[0];
            if (!leg || !xLeg) return null;   // open trade (no exit) → no realised result. NOTE: isFinite(null)===true, so an explicit null-guard is required here, not isFinite alone.
            var em = entrySig.metadata || {};
            var qLots = em.qty_lots != null ? em.qty_lots : leg.qty;
            var pv = autoGsPointValue(leg.short_symbol);
            var ePx = Number(_gsRealPx(entrySig));   // LIVE → real fills; else modelled
            var xPx = Number(_gsRealPx(exitSig));
            if (pv && isFinite(ePx) && isFinite(xPx)) {
                return ((leg.side || '').toUpperCase() === 'BUY' ? 1 : -1) * (xPx - ePx) * qLots * pv;
            }
            return null;
        };
        var _gsTradePassesFilters = function (tid) {
            var e = entryByTrade[tid];
            if (!e) return false;
            var leg = e.legs && e.legs[0];
            var short = leg ? leg.short_symbol : null;
            var ver = (e.metadata && (e.metadata.strategy_version || e.metadata.version)) || '';
            if ((_srcFilter === 'chassis' || _srcFilter === 'tv_webhook') && e.source !== _srcFilter) return false;
            if (isLive && f.trader !== 'all' && autoGsTraderOf(_closedTraderMap, e.strategy_name) !== f.trader) return false;
            if (f.instr === 'gold'   && short !== 'GOLDM')   return false;
            if (f.instr === 'silver' && short !== 'SILVERM') return false;
            if (f.versions.length && !f.versions.some(function (tok) { return ver.indexOf(tok) >= 0; })) return false;
            if (f.result === 'win' || f.result === 'loss') {
                var pnl = _gsPnlOf(e, _gsExitOf(tid));
                if (pnl == null) return false;
                if (f.result === 'win'  && !(pnl >= 0)) return false;
                if (f.result === 'loss' && !(pnl <  0)) return false;
            }
            if (f.exits.length && f.exits.indexOf(_auGsExitCategory(_gsExitOf(tid))) < 0) return false;
            return true;
        };
        var peakSigs = sigsAsc.filter(function (s) { return _gsTradePassesFilters(s.trade_id); });
        var _runExp = 0, _runMgn = 0;
        var _peakExp = 0, _peakMgn = 0;
        peakSigs.forEach(function (s) {
            var entrySig = entryByTrade[s.trade_id];
            var em = _gsTradeExposureOf(entrySig);
            if (s.event_type === 'ENTRY') { _runExp += em.exp; _runMgn += em.mgn; }
            else                          { _runExp -= em.exp; _runMgn -= em.mgn; }
            if (_runExp > _peakExp) _peakExp = _runExp;
            if (_runMgn > _peakMgn) _peakMgn = _runMgn;
        });
        _auGsTotals[mode].peakExposure = _peakExp > 0 ? _peakExp : null;
        _auGsTotals[mode].peakMargin   = _peakMgn > 0 ? _peakMgn : null;
        _auGsTotals[mode].peakSourceFilter = _srcFilter;  // for label rendering
        // Peak now honours instrument/version/result/exit too — flag any non-source filter
        // so the sub-label can show it's scoped, not the whole-book high-water mark.
        _auGsTotals[mode].peakFiltered = (f.instr !== 'all' || f.result !== 'all' ||
                                    f.versions.length > 0 || f.exits.length > 0 || (isLive && f.trader !== 'all'));

        var closedRows = [];
        Object.keys(byTrade).forEach(function (tradeId) {
            var events = byTrade[tradeId];
            var hasExit = false;
            var netQty = 0;
            var entry = null, exit = null;
            events.forEach(function (s) {
                if (s.event_type !== 'ENTRY') hasExit = true;
                if (s.event_type === 'ENTRY') {
                    if (!entry || s.fired_at < entry.fired_at) entry = s;
                } else {
                    if (!exit || s.fired_at > exit.fired_at) exit = s;
                }
                (s.legs || []).forEach(function (l) {
                    var q = Number(l.qty) || 0;
                    if ((l.side || '').toUpperCase() === 'BUY')  netQty += q;
                    if ((l.side || '').toUpperCase() === 'SELL') netQty -= q;
                });
            });
            if (!hasExit || !entry) return;
            if (Math.abs(netQty) > 1e-6) return;

            // Compute realised P&L: side_sign × (exit_price − entry_price) × qty_lots × point_value.
            // LIVE page uses REAL broker fills (via _gsRealPx); Paper uses modelled prices.
            var leg = entry.legs && entry.legs[0];
            var em = entry.metadata || {};
            var qtyLots = em.qty_lots != null ? em.qty_lots : (leg ? leg.qty : 1);
            var pv = leg ? autoGsPointValue(leg.short_symbol) : null;
            var entryPx = _gsRealPx(entry);
            var exitPx = _gsRealPx(exit);
            // On the Live page, flag rows that fell back to modelled (no linked fill).
            var _entryReal = !isLive || (entry.metadata && fillMap.has(String(entry.metadata.broker_order_id || '')));
            var _exitReal  = !isLive || (exit && exit.metadata && fillMap.has(String(exit.metadata.broker_order_id || '')));
            var pnl = null;
            if (pv && isFinite(entryPx) && isFinite(exitPx)) {
                var sideSign = (leg.side || '').toUpperCase() === 'BUY' ? 1 : -1;
                pnl = sideSign * (exitPx - entryPx) * qtyLots * pv;
            }

            var _entrySrc = entry.source || null;
            var _entryVer = (entry.metadata && (entry.metadata.strategy_version || entry.metadata.version)) || null;
            closedRows.push({
                trade_id: tradeId,
                strategy_name: entry.strategy_name,
                entry: entry, exit: exit,
                entry_price: entryPx, exit_price: exitPx, qty_lots: qtyLots,
                entry_real: _entryReal, exit_real: _exitReal,
                pnl: pnl,
                contract: leg ? leg.symbol : '—',
                expiry_date: leg ? leg.expiry_date : null,
                short_symbol: leg ? leg.short_symbol : null,
                source: _entrySrc,       // 'chassis' | 'tv_webhook' | null
                version: _entryVer,      // e.g. 'v2.2' or 'MS007-v2.0' or null
            });
        });

        // Apply ALL filters now (after the totals bar's peak exposure / peak margin,
        // which reflect ALL closed trades so filter changes don't distort them).
        // Instrument / result / version are client-side over the built rows.
        var _closedTotal = closedRows.length;
        closedRows = closedRows.filter(function (ct) {
            if ((_srcFilter === 'chassis' || _srcFilter === 'tv_webhook') && ct.source !== _srcFilter) return false;
            if (isLive && f.trader !== 'all' && autoGsTraderOf(_closedTraderMap, ct.strategy_name) !== f.trader) return false;
            if (f.instr === 'gold'   && ct.short_symbol !== 'GOLDM')   return false;
            if (f.instr === 'silver' && ct.short_symbol !== 'SILVERM') return false;
            if (f.result === 'win'  && !(ct.pnl != null && ct.pnl >= 0)) return false;
            if (f.result === 'loss' && !(ct.pnl != null && ct.pnl < 0))  return false;
            if (f.versions.length) {
                var _v = ct.version || '';
                if (!f.versions.some(function (tok) { return _v.indexOf(tok) >= 0; })) return false;
            }
            if (f.exits.length) {
                if (f.exits.indexOf(_auGsExitCategory(ct.exit)) < 0) return false;
            }
            return true;
        });
        var _anyFilter = _srcFilter !== 'all' || f.instr !== 'all' ||
                         f.result !== 'all' || f.versions.length > 0 ||
                         f.exits.length > 0 || (isLive && f.trader !== 'all');

        // Sort — click-to-sort on headers (default: exit date, newest first).
        var _sortDir = f.sort.dir === 'asc' ? 1 : -1;
        function _gsClosedSortVal(ct, key) {
            if (key === 'entry')    return ct.entry ? ct.entry.fired_at : '';
            if (key === 'exit')     return ct.exit ? ct.exit.fired_at : (ct.entry ? ct.entry.fired_at : '');
            if (key === 'contract') return (ct.short_symbol || '') + '|' + (ct.expiry_date || '');
            if (key === 'qty')      return Number(ct.qty_lots) || 0;
            if (key === 'pnl')      return ct.pnl == null ? -Infinity : ct.pnl;
            return '';
        }
        closedRows.sort(function (a, b) {
            var av = _gsClosedSortVal(a, f.sort.key), bv = _gsClosedSortVal(b, f.sort.key);
            if (av < bv) return -1 * _sortDir;
            if (av > bv) return  1 * _sortDir;
            return 0;
        });

        if (closedRows.length === 0) {
            var _emptyMsg = _closedTotal === 0
                ? 'No closed ' + (isLive ? 'LIVE' : 'PAPER') + ' GS trades yet.'
                : 'No closed GS trades match the current filters (' + _closedTotal + ' hidden). Adjust the filters above to see them.';
            el.innerHTML = '<div class="au-soon" style="padding:20px">' + _emptyMsg + '</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 / ' + _closedTotal + ' closed'; }
            if (sumEl) sumEl.textContent = _closedTotal ? (_closedTotal + ' hidden by filters') : '';
            // Reset this page's closed-derived cards so a filtered-empty page shows zeros.
            var _tc = _auGsTotals[mode];
            _tc.closedCount = 0; _tc.closedWins = 0; _tc.closedLosses = 0; _tc.closedRealisedPnl = null;
            _tc.filteredVersions = [];
            autoGsTotalsChanged(mode);
            return;
        }

        // Compute totals up front so we can render the total row at the TOP
        // (owner ask 2026-07-09 — with many trades, scrolling to the tfoot is tedious).
        var _totalPnl = 0, _wins = 0, _losses = 0;
        var _totalExposure = 0, _anyExposure = false;
        closedRows.forEach(function (ct) {
            var _lg = ct.entry.legs && ct.entry.legs[0];
            var _pv = _lg ? autoGsPointValue(_lg.short_symbol) : null;
            var _mgPct = _lg ? autoGsMarginPct(_lg.short_symbol) : null;
            if (_pv && ct.qty_lots && ct.entry_price != null) {
                var _exp = Number(ct.qty_lots) * _pv * Number(ct.entry_price);
                if (isFinite(_exp) && _exp > 0) { _totalExposure += _exp; _anyExposure = true; }
            }
            if (ct.pnl != null) {
                _totalPnl += ct.pnl;
                if (ct.pnl >= 0) _wins++; else _losses++;
            }
        });
        var _tSign = _totalPnl >= 0 ? '+' : '−';
        var _tCol  = _totalPnl >= 0 ? '#047857' : '#dc2626';
        var _tAbs  = Math.abs(Math.round(_totalPnl)).toLocaleString('en-IN');
        var _tPctSub = '';
        if (_anyExposure && _totalExposure > 0) {
            var _tPct = (_totalPnl / _totalExposure) * 100;
            var _tPctSign = _tPct >= 0 ? '+' : '−';
            _tPctSub = '<div style="color:' + _tCol + ';font-size:10px;margin-top:1px;font-weight:500">' +
                        _tPctSign + Math.abs(_tPct).toFixed(2) + '%</div>';
        }
        var _totalLabel = 'Total (' + closedRows.length + ' closed — ' + _wins + 'W / ' + _losses + 'L' +
                         (_anyFilter ? ' — filtered from ' + _closedTotal : '') + ')';

        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead>' +
                // Row 1 — totals (sticky at top so it stays visible even during vertical scroll of the table)
                '<tr style="background:#f7fafc;border-bottom:2px solid #cbd5e0;font-weight:700;position:sticky;top:0">' +
                '<td colspan="9" style="padding:8px">' + autoEsc(_totalLabel) + '</td>' +
                '<td style="padding:8px;text-align:right;vertical-align:top;white-space:nowrap">' +
                '<span style="color:' + _tCol + '">' + _tSign + '₹' + _tAbs + '</span>' + _tPctSub +
                '</td>' +
                '</tr>' +
                // Row 2 — column headers. Entry / Exit / Contract / Qty / P&L are
                // click-to-sort (arrow marks the active column + direction).
                '<tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Strategy<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ source · version</span></th>' +
                '<th style="padding:6px 8px">Side</th>' +
                _gsClosedTh(mode, 'Entry', 'entry', 'left') +
                _gsClosedTh(mode, 'Exit', 'exit', 'left', '/ days held') +
                _gsClosedTh(mode, 'Contract', 'contract', 'left') +
                _gsClosedTh(mode, 'Qty', 'qty', 'right') +
                '<th style="padding:6px 8px;text-align:right">Entry Px</th>' +
                '<th style="padding:6px 8px;text-align:right">Exit Px</th>' +
                '<th style="padding:6px 8px">Exit Reason</th>' +
                _gsClosedTh(mode, 'Realised P&amp;L', 'pnl', 'right', '/ % of exp') +
                '</tr></thead><tbody>';

        var totalPnl = 0, wins = 0, losses = 0;
        var totalExposure = 0, anyExposure = false;
        closedRows.forEach(function (ct) {
            var leg = ct.entry.legs && ct.entry.legs[0];
            var side = ct.entry.direction || (leg && leg.side === 'BUY' ? 'LONG' : 'SHORT');
            var sideBadge = side === 'LONG'
                ? '<span class="au-badge success">LONG</span>'
                : side === 'SHORT' ? '<span class="au-badge error">SHORT</span>' : autoEsc(side);
            var entryStr = autoFmtIST(ct.entry.fired_at);
            var exitStr = ct.exit ? autoFmtIST(ct.exit.fired_at) : '—';
            var daysHeld = ct.exit
                ? Math.max(0, Math.floor((new Date(ct.exit.fired_at).getTime() - new Date(ct.entry.fired_at).getTime()) / 86400000))
                : null;
            var daysSub = daysHeld != null
                ? '<div style="color:#6b7280;font-size:10px;margin-top:1px">' + daysHeld + ' day' + (daysHeld === 1 ? '' : 's') + '</div>'
                : '';
            var _exitCat = _auGsExitCategory(ct.exit);
            var exitReasonLabel = ct.exit ? _auGsExitLabel(_exitCat) : '—';
            var exitReasonColor = _auGsExitColor(_exitCat);
            var _mdl = '<div style="color:#b45309;font-size:9px;margin-top:1px" title="No linked broker fill — modelled price.">~modelled</div>';
            var entryPxStr = autoFmtPrice0(ct.entry_price);
            var exitPxStr = autoFmtPrice0(ct.exit_price);
            var entryPxMark = (isLive && !ct.entry_real) ? _mdl : '';
            var exitPxMark = (isLive && !ct.exit_real) ? _mdl : '';
            var contractStr = autoFmtContract(ct.contract, ct.expiry_date);

            // Qty cell: lots + physical sub-row
            var qtyLots = ct.qty_lots != null ? Number(ct.qty_lots) : null;
            var qtyMain = qtyLots != null ? qtyLots + ' lot' + (qtyLots == 1 ? '' : 's') : '—';
            var physLot = autoGsPhysicalLot(ct.short_symbol);
            var qtySub = '';
            if (qtyLots != null && physLot) {
                qtySub = '<div style="color:#6b7280;font-size:10px;margin-top:1px">' + (qtyLots * physLot.qty) + ' ' + physLot.unit + '</div>';
            }
            var qtyCell = autoEsc(qtyMain) + qtySub;

            // Exposure for % calc (same formula as Open Trades): lots × pv × entry_price
            var pv = ct.short_symbol ? autoGsPointValue(ct.short_symbol) : null;
            var exposure = (qtyLots != null && pv && ct.entry_price != null) ? (qtyLots * pv * ct.entry_price) : null;
            if (exposure != null) { totalExposure += exposure; anyExposure = true; }

            var pnlCell;
            if (ct.pnl != null) {
                totalPnl += ct.pnl;
                if (ct.pnl >= 0) wins++; else losses++;
                var sign = ct.pnl >= 0 ? '+' : '−';
                var col = ct.pnl >= 0 ? '#047857' : '#dc2626';
                var abs = Math.abs(Math.round(ct.pnl)).toLocaleString('en-IN');
                var pctSub = '';
                if (exposure && exposure > 0) {
                    var pct = (ct.pnl / exposure) * 100;
                    var pctSign = pct >= 0 ? '+' : '−';
                    pctSub = '<div style="color:' + col + ';font-size:10px;margin-top:1px;font-weight:500">' +
                             pctSign + Math.abs(pct).toFixed(2) + '%</div>';
                }
                pnlCell = '<span style="color:' + col + ';font-weight:600">' + sign + '₹' + abs + '</span>' + pctSub;
            } else {
                pnlCell = '<span style="color:#9ca3af">—</span>';
            }

            // Source + version go under the Strategy code, as a small grey sub-line.
            var srcLabel = ct.source === 'chassis' ? 'Runner'
                         : ct.source === 'tv_webhook' ? 'TV Webhook'
                         : (ct.source ? autoEsc(String(ct.source)) : '—');
            var srcColor = ct.source === 'chassis' ? '#4338ca'
                         : ct.source === 'tv_webhook' ? '#0891b2'
                         : '#6b7280';
            var verStr = ct.version ? autoEsc(String(ct.version)) : '—';
            var strategyCell = '<code>' + autoEsc(ct.strategy_name) + '</code>' +
                '<div style="font-size:10px;margin-top:2px">' +
                    '<span style="color:' + srcColor + ';font-weight:500">' + srcLabel + '</span>' +
                    '<span style="color:#9ca3af"> · </span>' +
                    '<span style="color:#6b7280">' + verStr + '</span>' +
                '</div>';

            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px;vertical-align:top">' + strategyCell + '</td>' +
                    '<td style="padding:6px 8px;vertical-align:top">' + sideBadge + '</td>' +
                    '<td style="padding:6px 8px;vertical-align:top">' + autoEsc(entryStr) + '</td>' +
                    '<td style="padding:6px 8px;vertical-align:top">' + autoEsc(exitStr) + daysSub + '</td>' +
                    '<td style="padding:6px 8px;vertical-align:top">' + autoEsc(contractStr) + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + qtyCell + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + autoEsc(entryPxStr) + entryPxMark + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + autoEsc(exitPxStr) + exitPxMark + '</td>' +
                    '<td style="padding:6px 8px;vertical-align:top"><span style="color:' + exitReasonColor + ';font-weight:600">' + autoEsc(exitReasonLabel) + '</span></td>' +
                    '<td style="padding:6px 8px;text-align:right;white-space:nowrap;vertical-align:top">' + pnlCell + '</td>' +
                    '</tr>';
        });

        // Totals row now renders at the TOP of the table (see thead above) —
        // no tfoot needed. totalPnl/wins/losses computed inside the loop above
        // are still used to populate _auGsTotals for the sticky totals bar.
        html += '</tbody></table></div>';
        el.innerHTML = html;
        var _statusLabel = !_anyFilter
            ? closedRows.length + ' closed'
            : closedRows.length + ' / ' + _closedTotal + ' closed';
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = _statusLabel; }

        // Populate this page's closed-derived cards.
        var _tc = _auGsTotals[mode];
        _tc.closedCount = closedRows.length;
        _tc.closedWins = wins;
        _tc.closedLosses = losses;
        _tc.closedRealisedPnl = totalPnl;
        // Version card: distinct strategy versions present in the FILTERED closed trades.
        _tc.filteredVersions = Array.from(new Set(closedRows.map(function (ct) { return ct.version; }).filter(Boolean)));
        autoGsTotalsChanged(mode);

        if (sumEl) {
            var cSign = totalPnl >= 0 ? '+' : '−';
            sumEl.textContent = closedRows.length + ' closed · ' + wins + 'W/' + losses + 'L · realised ' +
                                cSign + '₹' + Math.abs(Math.round(totalPnl)).toLocaleString('en-IN');
        }
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load GS closed trades: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
    }
}

// ----------------------------------------------------------------------------
// Recent Events tab — auto_signals listing
// ----------------------------------------------------------------------------


// ----------------------------------------------------------------------------
// Run History tab — auto_runs listing
// ----------------------------------------------------------------------------


// ============================================================================
// Live Trading tab (Phase 13) — LIVE order-placement controls + risk wrappers
// ----------------------------------------------------------------------------
// Reads/writes app_state (kill switch + per-source pause) and wms_live_risk_limits
// (the rules the katalysthive-webhook enforces before placing orders). All writes
// go through the owner's session JWT (RLS owner_all). No SQL, no deploy.
// ============================================================================

var _auLiveState  = null;   // app_state singleton row
var _auLiveLimits = [];     // wms_live_risk_limits rows
var AU_KH = { source: 'katalysthive', strategy: 'sharanaga_v1' };
var _AU_INP = 'padding:6px 8px;border:1px solid #d1d5db;border-radius:4px;font-size:12px';

async function autoLoadLive() {
    var ctrl = document.getElementById('au-kh-fam-live-controls');
    if (ctrl) ctrl.innerHTML = 'Loading…';
    try {
        var results = await Promise.all([
            fetch(SUPABASE_URL + '/rest/v1/app_state?id=eq.1&select=kill_switch,paused_sources,paused_brokers', { headers: wmsHeaders() }),
            fetch(SUPABASE_URL + '/rest/v1/wms_live_risk_limits?select=*', { headers: wmsHeaders() })
        ]);
        var sRows = await results[0].json();
        _auLiveState = (Array.isArray(sRows) && sRows[0]) || { kill_switch: false, paused_sources: [], paused_brokers: [] };
        _auLiveLimits = await results[1].json();
        if (!Array.isArray(_auLiveLimits)) _auLiveLimits = [];
        await _auSyncLotSizes();          // auto-derive lot sizes from securities_nfo cache (self-heals)
        autoRenderLiveControls();
        autoRenderKhWrappers();
        autoRenderLotSizes();
    } catch (e) {
        if (ctrl) ctrl.innerHTML = '<span style="color:#dc2626">Failed to load live config: ' + autoEsc(String(e)) + '</span>';
    }
}

function _auFindLimit(source, strategy, iba, type) {
    return _auLiveLimits.find(function (r) {
        return (r.signal_source || null) === (source || null)
            && (r.strategy_name || null) === (strategy || null)
            && (r.iba_id || null) === (iba || null)
            && r.limit_type === type;
    }) || null;
}

// ---- Live controls (kill switch + KH pause) ----
function autoRenderLiveControls() {
    var el = document.getElementById('au-kh-fam-live-controls'); if (!el) return;
    var ks = !!_auLiveState.kill_switch;
    var paused = (_auLiveState.paused_sources || []).indexOf('katalysthive') !== -1;
    var badge = document.getElementById('au-kh-fam-live-badge');
    if (badge) {
        if (ks)          { badge.textContent = 'KILL SWITCH ON'; badge.className = 'au-badge error'; }
        else if (paused) { badge.textContent = 'KH paused';      badge.className = 'au-badge warning'; }
        else             { badge.textContent = 'live';           badge.className = 'au-badge success'; }
    }
    el.innerHTML =
        '<div style="display:flex;gap:28px;flex-wrap:wrap;align-items:flex-end">' +
            '<div><div style="font-size:11px;color:#6b7280;margin-bottom:4px">Global kill switch (all sources)</div>' +
                '<button class="au-btn ' + (ks ? 'au-btn-danger' : 'au-btn-secondary') + '" onclick="autoToggleKillSwitch()">' +
                (ks ? '🛑 ON — click to resume trading' : 'Engage kill switch') + '</button></div>' +
            '<div><div style="font-size:11px;color:#6b7280;margin-bottom:4px">Katalysthive source</div>' +
                '<button class="au-btn ' + (paused ? 'au-btn-danger' : 'au-btn-secondary') + '" onclick="autoToggleKhPause()">' +
                (paused ? '⏸ Paused — click to resume' : 'Pause Katalysthive') + '</button></div>' +
        '</div>';
}

async function autoToggleKillSwitch() {
    var on = !!_auLiveState.kill_switch;
    var msg = on
        ? 'Resume LIVE order placement (turn the kill switch OFF)?'
        : '⚠️ Engage the GLOBAL kill switch?\n\nALL live order placement halts immediately. Every signal (Katalysthive + any future source) is rejected until you turn it off.';
    if (!confirm(msg)) return;
    await _auPatchAppState({ kill_switch: !on }, (on ? 'Resume from' : 'Engage') + ' kill switch (Live Trading tab)');
}

async function autoToggleKhPause() {
    var cur = _auLiveState.paused_sources || [];
    var paused = cur.indexOf('katalysthive') !== -1;
    var next = paused ? cur.filter(function (s) { return s !== 'katalysthive'; }) : cur.concat(['katalysthive']);
    var msg = paused
        ? 'Resume Katalysthive signals?'
        : 'Pause Katalysthive only?\n\nIts signals will be rejected (HTTP 503 SOURCE_PAUSED) until resumed. Other sources are unaffected.';
    if (!confirm(msg)) return;
    await _auPatchAppState({ paused_sources: next }, (paused ? 'Resume' : 'Pause') + ' katalysthive (Live Trading tab)');
}

async function _auPatchAppState(patch, reason) {
    try {
        patch.updated_by = (window.currentUser && window.currentUser.email) || 'app';
        patch.updated_reason = reason;
        var resp = await fetch(SUPABASE_URL + '/rest/v1/app_state?id=eq.1',
            { method: 'PATCH', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }), body: JSON.stringify(patch) });
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));
        autoLoadLive();
    } catch (e) { alert('Failed to update live controls: ' + (e.message || e)); }
}

// ---- Katalysthive risk wrappers ----
function autoRenderKhWrappers() {
    var el = document.getElementById('au-kh-fam-live-kh'); if (!el) return;
    var cap = _auFindLimit(AU_KH.source, AU_KH.strategy, null, 'max_open_exposure_lots');
    var und = _auFindLimit(AU_KH.source, AU_KH.strategy, null, 'allowed_underlyings');
    var capVal = (cap && cap.limit_value && cap.limit_value.value != null) ? cap.limit_value.value : '';
    var capOn  = cap ? cap.enabled : true;
    var undVals = (und && und.limit_value && Array.isArray(und.limit_value.values)) ? und.limit_value.values.join(', ') : '';
    var undOn  = und ? und.enabled : true;
    var lb = _auFindLimit(AU_KH.source, AU_KH.strategy, null, 'exposure_lookback_days');
    var lbVal = (lb && lb.limit_value && lb.limit_value.value != null) ? lb.limit_value.value : 3;
    el.innerHTML =
        '<div style="margin-bottom:18px">' +
            '<div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:3px">Max open exposure (lots)' +
                (cap ? '' : ' <span style="color:#9ca3af;font-weight:400">— not set (no cap enforced)</span>') + '</div>' +
            '<div style="font-size:11px;color:#6b7280;margin-bottom:6px">Total open lots across all live KH trades (a trade counts as its largest leg’s lots). A new signal that would exceed this is rejected.</div>' +
            '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
                '<input id="au-kh-cap" type="number" min="0" step="0.5" value="' + autoEsc(String(capVal)) + '" placeholder="e.g. 4" style="' + _AU_INP + ';width:120px">' +
                '<label style="font-size:12px;color:#374151"><input type="checkbox" id="au-kh-cap-on" ' + (capOn ? 'checked' : '') + '> enforce</label>' +
                '<button class="au-btn au-btn-primary" onclick="autoSaveKhCap()">Save cap</button>' +
            '</div>' +
        '</div>' +
        '<div>' +
            '<div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:3px">Allowed underlyings' +
                (und ? '' : ' <span style="color:#9ca3af;font-weight:400">— not set (all allowed)</span>') + '</div>' +
            '<div style="font-size:11px;color:#6b7280;margin-bottom:6px">Use the quick-add chips below or type (comma-separated). Checked against your securities master on save to catch typos. A signal on any other underlying is rejected; uncheck “enforce” to allow all.</div>' +
            '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
                '<input id="au-kh-und" value="' + autoEsc(undVals) + '" placeholder="NIFTY, BANKNIFTY" style="' + _AU_INP + ';flex:1;min-width:220px;max-width:380px;text-transform:uppercase">' +
                '<label style="font-size:12px;color:#374151"><input type="checkbox" id="au-kh-und-on" ' + (undOn ? 'checked' : '') + '> enforce</label>' +
                '<button class="au-btn au-btn-primary" onclick="autoSaveKhUnderlyings()">Save underlyings</button>' +
            '</div>' +
            '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
                '<span style="font-size:11px;color:#9ca3af">Quick add:</span>' +
                ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'].map(function (u) { return '<button type="button" onclick="autoAddUnderlying(\'' + u + '\')" style="font-size:11px;padding:2px 9px;border:1px solid #d1d5db;border-radius:12px;background:#f9fafb;cursor:pointer;color:#374151">+ ' + u + '</button>'; }).join('') +
            '</div>' +
        '</div>' +
        '<div style="margin-top:18px">' +
            '<div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:3px">Open-position look-back (days)</div>' +
            '<div style="font-size:11px;color:#6b7280;margin-bottom:6px">Days of order history scanned when tallying open KH exposure. KH is intraday, so 3 is plenty (covers a Fri→Mon weekend). Lower = faster check.</div>' +
            '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
                '<input id="au-kh-lookback" type="number" min="1" max="90" value="' + autoEsc(String(lbVal)) + '" style="' + _AU_INP + ';width:120px">' +
                '<button class="au-btn au-btn-primary" onclick="autoSaveKhLookback()">Save look-back</button>' +
            '</div>' +
        '</div>';
}

async function autoSaveKhCap() {
    var v = document.getElementById('au-kh-cap').value;
    var on = document.getElementById('au-kh-cap-on').checked;
    if (v === '' || isNaN(Number(v)) || Number(v) < 0) { alert('Enter a non-negative number of lots (or 0 to block everything).'); return; }
    try {
        var ex = _auFindLimit(AU_KH.source, AU_KH.strategy, null, 'max_open_exposure_lots');
        await _auUpsertLimit(ex, AU_KH, 'max_open_exposure_lots', { value: Number(v) }, on, 'reject');
        autoLoadLive();
    } catch (e) { alert('Failed to save cap: ' + (e.message || e)); }
}

// Valid F&O underlyings = distinct active underlyings in securities_nfo, plus the known
// index set (some, e.g. SENSEX/BANKEX, are BSE and may not be in the NSE cache).
function _auValidUnderlyings() {
    var set = {};
    ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX'].forEach(function (u) { set[u] = 1; });
    var nfo = (window.wmsRefData && window.wmsRefData.securitiesNfo) || [];
    nfo.forEach(function (r) { if (r.is_active !== false) { var u = String(r.underlying_symbol || '').toUpperCase(); if (u) set[u] = 1; } });
    return set;
}

// Quick-add chip → append an underlying to the box (deduped, uppercase).
function autoAddUnderlying(u) {
    var inp = document.getElementById('au-kh-und'); if (!inp) return;
    var cur = inp.value.split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);
    if (cur.indexOf(u) < 0) cur.push(u);
    inp.value = cur.join(', ');
    inp.focus();
}

async function autoSaveKhUnderlyings() {
    var raw = document.getElementById('au-kh-und').value;
    var on  = document.getElementById('au-kh-und-on').checked;
    var vals = raw.split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean)
        .filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (on && vals.length === 0) { alert('Add at least one underlying, or uncheck “enforce” to allow all.'); return; }
    // Validate against the securities master — flag anything unrecognised (likely a typo).
    var valid = _auValidUnderlyings();
    var unknown = vals.filter(function (v) { return !valid[v]; });
    if (unknown.length) {
        if (!confirm('These underlyings are NOT in your securities master and look like typos:\n\n   ' + unknown.join(', ') +
            '\n\nA mistyped underlying will silently block its real signals. Fix it, or save anyway?')) return;
    }
    try {
        var ex = _auFindLimit(AU_KH.source, AU_KH.strategy, null, 'allowed_underlyings');
        await _auUpsertLimit(ex, AU_KH, 'allowed_underlyings', { values: vals }, on, 'reject');
        autoLoadLive();
    } catch (e) { alert('Failed to save underlyings: ' + (e.message || e)); }
}

// ---- Look-back window (per-strategy) ----
async function autoSaveKhLookback() {
    var v = Number(document.getElementById('au-kh-lookback').value);
    if (!v || v < 1 || v > 90) { alert('Enter a look-back between 1 and 90 days.'); return; }
    try {
        var ex = _auFindLimit(AU_KH.source, AU_KH.strategy, null, 'exposure_lookback_days');
        await _auUpsertLimit(ex, AU_KH, 'exposure_lookback_days', { value: v }, true, 'log_only');
        autoLoadLive();
    } catch (e) { alert('Failed to save look-back: ' + (e.message || e)); }
}

// ---- Lot sizes — AUTO-derived from the securities_nfo cache (read-only, self-healing) ----
var _AU_DEFAULT_UNDS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX', 'MIDCPNIFTY'];

// Front-month lot size per underlying, from the in-memory securities_nfo cache (zero extra DB calls).
function _auDeriveLotSizes(unds) {
    var nfo = (window.wmsRefData && window.wmsRefData.securitiesNfo) || [];
    var today = new Date().toISOString().slice(0, 10);
    var map = {};
    (unds || []).forEach(function (u) {
        u = String(u || '').toUpperCase(); if (!u) return;
        var rows = nfo.filter(function (r) { return String(r.underlying_symbol || '').toUpperCase() === u && r.lot_size && r.is_active !== false; });
        if (!rows.length) return;
        var future = rows.filter(function (r) { return r.expiry_date && r.expiry_date >= today; }).sort(function (a, b) { return a.expiry_date < b.expiry_date ? -1 : 1; });
        var pick = future[0] || rows[0];
        if (pick && Number(pick.lot_size) > 0) map[u] = Number(pick.lot_size);
    });
    return map;
}

// Derive lot sizes for the covered underlyings and persist ONLY if they changed (auto-heal each load/save).
async function _auSyncLotSizes() {
    try {
        var undRule = _auFindLimit(AU_KH.source, AU_KH.strategy, null, 'allowed_underlyings');
        var existing = _auFindLimit(null, null, null, 'lot_sizes');
        var existingMap = (existing && existing.limit_value && existing.limit_value.values && typeof existing.limit_value.values === 'object') ? existing.limit_value.values : {};
        var allowed = (undRule && undRule.limit_value && Array.isArray(undRule.limit_value.values)) ? undRule.limit_value.values.map(function (x) { return String(x).toUpperCase(); }) : [];
        var covered = (allowed.length ? allowed.slice() : _AU_DEFAULT_UNDS.slice());
        Object.keys(existingMap).forEach(function (u) { if (covered.indexOf(u) < 0) covered.push(u); });
        var merged = Object.assign({}, existingMap, _auDeriveLotSizes(covered));   // derived wins; keep existing on a cache miss
        if (JSON.stringify(merged) !== JSON.stringify(existingMap)) {
            await _auUpsertLimit(existing, { source: null, strategy: null }, 'lot_sizes', { values: merged }, true, 'log_only');
            var fresh = (await window.supabaseClient.from('wms_live_risk_limits').select('*')).data;
            if (Array.isArray(fresh)) _auLiveLimits = fresh;
        }
    } catch (e) { /* non-fatal — display falls back to whatever is stored */ }
}

function autoRenderLotSizes() {
    var el = document.getElementById('au-kh-fam-live-lotsizes'); if (!el) return;
    var row = _auFindLimit(null, null, null, 'lot_sizes');
    var map = (row && row.limit_value && row.limit_value.values && typeof row.limit_value.values === 'object') ? row.limit_value.values : {};
    var keys = Object.keys(map).sort();
    var body = keys.length
        ? keys.map(function (k) { return '<tr><td style="padding:3px 24px 3px 0">' + autoEsc(k) + '</td><td style="text-align:right">' + autoEsc(String(map[k])) + '</td></tr>'; }).join('')
        : '<tr><td colspan="2" style="color:#9ca3af;padding:4px 0">No lot sizes yet — set an allowed underlying and they auto-fill from the securities master.</td></tr>';
    el.innerHTML =
        '<table style="font-size:12px;border-collapse:collapse">' +
            '<thead><tr style="color:#6b7280;font-size:10px;text-transform:uppercase"><th style="text-align:left;padding-right:24px">Underlying</th><th style="text-align:right">Lot size</th></tr></thead>' +
            '<tbody>' + body + '</tbody>' +
        '</table>' +
        '<div style="font-size:11px;color:#9ca3af;margin-top:8px">Auto-filled from the securities master (front-month contract) — no manual entry. Refreshes when you reopen this tab or run the F&amp;O sync.</div>';
}

// ---- shared upsert: PATCH by id if the rule exists, else POST a new row ----
async function _auUpsertLimit(existing, scope, type, value, enabled, breach) {
    var url, method, body;
    if (existing) {
        url = SUPABASE_URL + '/rest/v1/wms_live_risk_limits?id=eq.' + existing.id;
        method = 'PATCH';
        body = JSON.stringify({ limit_value: value, enabled: enabled, breach_action: breach });
    } else {
        url = SUPABASE_URL + '/rest/v1/wms_live_risk_limits';
        method = 'POST';
        body = JSON.stringify({
            signal_source: scope.source || null,
            strategy_name: scope.strategy || null,
            iba_id: null,
            limit_type: type,
            limit_value: value,
            enabled: enabled,
            breach_action: breach
        });
    }
    var resp = await fetch(url, { method: method, headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }), body: body });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));
}


// ============================================================================
// 🧪 AT2 — Auto Trading v2 family page  (Package 11, 2026-08-04)
// ============================================================================
//
// ── WHAT MAKES THIS PAGE DIFFERENT FROM THE GS PAGE ─────────────────────────
// GS derives open positions by netting a signal log (v_auto_open_trades). AT2
// does not: state is a COLUMN (Plan v12 rule R1/R3), so this page READS
// at2_trade rather than reconstructing it. If a number here looks wrong, the
// row is wrong — there is no derivation in between to blame.
//
// ── ☠️ UNKNOWN STATES RENDER LOUDLY ─────────────────────────────────────────
// Plan §14's definition of done for this package. A status, exit reason or
// severity this page does not recognise is EXACTLY when a human needs to see
// something is wrong — so it renders as a red badge naming the unknown value,
// never as a blank cell and never silently mapped to a default.
//
// ── RLS ─────────────────────────────────────────────────────────────────────
// Every at2_ table is owner-read (`auth.jwt()->>'email'`), verified 04-Aug-2026,
// so these plain PostgREST reads work from the browser under the owner session.
// Writes are revoked — the manual close goes through the at2-ms007 EF (EX-09).
// ============================================================================

var _auAt2 = { strategies: [], books: [], trades: [], alerts: [], signals: [], events: [],
               runlog: [], families: [], accounts: [], loadedAt: null };

// ── The known vocabularies. Anything outside these renders LOUD. ────────────
var AU_AT2_STATUS = {
    pending:          { label: 'Pending',      cls: 'idle',    note: 'order placed, no fill yet' },
    open_unprotected: { label: 'UNPROTECTED',  cls: 'error',   note: 'open with NO resting stop' },
    open_protected:   { label: 'Protected',    cls: 'success', note: 'open, stop resting' },
    closing:          { label: 'Closing',      cls: 'warning', note: 'exit routed, awaiting fill' },
    closed:           { label: 'Closed',       cls: 'idle',    note: '' },
    voided:           { label: 'Voided',       cls: 'idle',    note: 'never filled' }
};
var AU_AT2_EXIT_REASONS = ['STOP', 'TRAIL', 'TARGET', 'TIME', 'SQUARE_OFF', 'ROLL', 'MANUAL'];
var AU_AT2_SEVERITY = {
    critical: { cls: 'error',   icon: '❌' },
    warn:     { cls: 'warning', icon: '⚠️' },
    info:     { cls: 'idle',    icon: 'ℹ️' }
};

// ============================================================================
// AT2 Trades filter bar — GS-STYLE (autoGsFilterBar), minus Version and
// Source: AT2 has no engine param versions and no legacy signal source to
// split by (§10-Aug owner instruction). Filters apply to CLOSED trades only —
// same as GS: "Open trades" always shows the whole open book, unfiltered
// (matches AT2's own long-standing rule that an open position must never be
// hidden — see auAt2RenderOpen's own comment on that).
//
//   instr  : all | gold | silver           (radio)
//   result : all | win  | loss             (radio)
//   exits  : [] = all, else AU_AT2_EXIT_REASONS tokens (checkbox, multi-select)
//   book   : all | <book_id>               (radio, built from the live book list)
// Persisted to localStorage so selections survive a reload, same pattern GS uses.
// ============================================================================
function _auAt2BlankFilters() { return { instr: 'all', result: 'all', exits: [], books: [] }; }
var _auAt2Filters = _auAt2BlankFilters();
var _AU_AT2_FILTERS_KEY = 'wms.at2Filters.v2';   // v2: Book is multi-select (books[]), not a single radio
function _auAt2FiltersSave() {
    try { localStorage.setItem(_AU_AT2_FILTERS_KEY, JSON.stringify(_auAt2Filters)); }
    catch (e) { /* private mode / storage disabled — filters just won't persist */ }
}
function _auAt2FiltersRestore() {
    try {
        var s = JSON.parse(localStorage.getItem(_AU_AT2_FILTERS_KEY) || '{}');
        if (s.instr)  _auAt2Filters.instr  = s.instr;
        if (s.result) _auAt2Filters.result = s.result;
        if (Array.isArray(s.exits)) _auAt2Filters.exits = s.exits;
        if (Array.isArray(s.books)) _auAt2Filters.books = s.books;
    } catch (e) { /* ignore malformed */ }
}
_auAt2FiltersRestore();

/**
 * Gold or silver, from the trade's STRATEGY CODE ('gs_goldm_15m' /
 * 'gs_silverm_15m') — not the contract symbol. AT2 loads `at2_trade` without a
 * join to `securities_nfo`, and the strategy code already carries the
 * instrument unambiguously, so there is nothing to look up.
 */
function auAt2Instrument(t) {
    var strat = _auAt2.strategies.filter(function (s) { return s.id === t.strategy_id; })[0];
    var code = (strat && strat.code || '').toLowerCase();
    if (code.indexOf('goldm') >= 0)   return 'gold';
    if (code.indexOf('silverm') >= 0) return 'silver';
    return '';
}

function auAt2SetFilter(kind, value) {
    if (kind === 'instr')       _auAt2Filters.instr = value;
    else if (kind === 'result') _auAt2Filters.result = value;
    _auAt2FiltersSave();
    auAt2RenderClosed();
}

/** Book is multi-select: empty = all, same "tick to filter" pattern as Exit reason. */
function auAt2ToggleBook(bookId, on) {
    var arr = _auAt2Filters.books, i = arr.indexOf(bookId);
    if (on && i < 0) arr.push(bookId);
    else if (!on && i >= 0) arr.splice(i, 1);
    _auAt2FiltersSave();
    auAt2RenderClosed();
}

function auAt2ToggleExit(reason, on) {
    var arr = _auAt2Filters.exits, i = arr.indexOf(reason);
    if (on && i < 0) arr.push(reason);
    else if (!on && i >= 0) arr.splice(i, 1);
    _auAt2FiltersSave();
    auAt2RenderClosed();
}

/** Does this CLOSED trade pass the current filter set? Open trades never call this. */
function auAt2ClosedPassesFilters(t) {
    var f = _auAt2Filters;
    if (f.instr !== 'all' && auAt2Instrument(t) !== f.instr) return false;
    if (f.result === 'win'  && !(Number(t.realised_pnl) > 0)) return false;
    if (f.result === 'loss' && !(Number(t.realised_pnl) < 0)) return false;
    if (f.exits.length && f.exits.indexOf(t.exit_reason) < 0) return false;
    if (f.books.length && f.books.indexOf(t.book_id) < 0) return false;
    return true;
}

function auAt2FilterBar() {
    var lbl = 'font-size:10px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.04em';
    var f = _auAt2Filters;
    function radio(name, val, cur, handler, text) {
        return '<label class="radio-label" style="font-size:12px"><input type="radio" name="' + name + '" value="' + val + '"' +
               (cur === val ? ' checked' : '') + ' onchange="' + handler + '"> ' + text + '</label>';
    }
    function check(name, val, on, handler, text) {
        return '<label class="radio-label" style="font-size:12px"><input type="checkbox" name="' + name + '" value="' + val + '"' +
               (on ? ' checked' : '') + ' onchange="' + handler + '"> ' + text + '</label>';
    }
    var exitLabels = { STOP: 'Hard SL', TRAIL: 'Trail SL', TARGET: 'Target', TIME: 'Time stop',
                        SQUARE_OFF: 'Square-off', ROLL: 'Roll', MANUAL: 'Manual' };
    var exitsHtml = AU_AT2_EXIT_REASONS.map(function (r) {
        return check('auat2f-exit', r, f.exits.indexOf(r) >= 0, "auAt2ToggleExit('" + r + "', this.checked)", exitLabels[r] || r);
    }).join('');
    var books = _auAt2.books.slice().sort(function (a, b) { return (a.display_name || '').localeCompare(b.display_name || ''); });
    var bookHtml = books.map(function (b) {
            return check('auat2f-book', b.id, f.books.indexOf(b.id) >= 0, "auAt2ToggleBook('" + b.id + "', this.checked)", auAt2Esc(b.display_name));
        }).join('');
    var col = 'display:flex;flex-direction:column;gap:4px';
    var tick = ' <span style="font-weight:400;color:#9ca3af;text-transform:none">(tick to filter)</span>';

    // Even column widths for the four groups; Exit reason gets double width and
    // lays its (longer) list out in two columns. Note sits full-width below.
    return '<div style="margin-bottom:10px;padding:10px 12px;background:#fff;border:1px solid #e2e8f0;border-radius:6px">' +
        '<div style="display:flex;align-items:flex-start;gap:22px">' +
            '<div style="flex:1 1 0;' + col + '"><span style="' + lbl + '">Instrument</span>' +
                radio('auat2f-instr', 'all',    f.instr, "auAt2SetFilter('instr','all')",    'All') +
                radio('auat2f-instr', 'gold',   f.instr, "auAt2SetFilter('instr','gold')",   'Gold') +
                radio('auat2f-instr', 'silver', f.instr, "auAt2SetFilter('instr','silver')", 'Silver') +
            '</div>' +
            '<div style="flex:1 1 0;' + col + '"><span style="' + lbl + '">Result</span>' +
                radio('auat2f-result', 'all',  f.result, "auAt2SetFilter('result','all')",  'All') +
                radio('auat2f-result', 'win',  f.result, "auAt2SetFilter('result','win')",  'Winning') +
                radio('auat2f-result', 'loss', f.result, "auAt2SetFilter('result','loss')", 'Losing') +
            '</div>' +
            '<div style="flex:2 1 0;' + col + '"><span style="' + lbl + '">Exit reason' + tick + '</span>' +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 16px">' + exitsHtml + '</div>' +
            '</div>' +
            '<div style="flex:1 1 0;' + col + '"><span style="' + lbl + '">Book' + tick + '</span>' +
                bookHtml +
            '</div>' +
        '</div>' +
        '<div style="font-size:11px;color:#6b7280;line-height:1.5;margin-top:8px">These filters apply to <b>Closed trades</b> only — Open trades always shows the whole open book, so a filter can never hide a live position.</div>' +
    '</div>';
}

function auAt2Esc(s) {
    return String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * ☠️ The loud-unknown renderer. Every enum-ish value on this page goes through
 * one of these. Returning a blank or a plausible default for an unrecognised
 * value is the specific failure this package exists to prevent.
 */
function auAt2StatusBadge(status) {
    var k = AU_AT2_STATUS[status];
    if (!k) {
        return '<span class="au-badge error" title="This page does not recognise this status. '
             + 'It may be a new state the UI has not been taught, or corrupt data.">'
             + '⛔ UNKNOWN STATE: ' + auAt2Esc(status === null || status === undefined ? '(null)' : status)
             + '</span>';
    }
    return '<span class="au-badge ' + k.cls + '"' + (k.note ? ' title="' + auAt2Esc(k.note) + '"' : '') + '>'
         + auAt2Esc(k.label) + '</span>';
}

function auAt2ExitReason(reason) {
    if (reason === null || reason === undefined || reason === '') return '<span style="color:#6b7280">—</span>';
    if (AU_AT2_EXIT_REASONS.indexOf(reason) < 0) {
        return '<span class="au-badge error">⛔ UNKNOWN REASON: ' + auAt2Esc(reason) + '</span>';
    }
    return auAt2Esc(reason);
}

/** Colour key for the Closed-trades Reason column — mirrors GS's exit-category
 *  colouring (autoLoadGsClosedTrades' _auGsExitColor) so the two tables read
 *  the same way: red = stop-driven, green = target, grey = neutral/time. */
function auAt2ExitColor(reason) {
    switch (reason) {
        case 'STOP':       return '#dc2626';
        case 'TRAIL':      return '#b45309';
        case 'TARGET':     return '#047857';
        case 'TIME':       return '#6b7280';
        case 'SQUARE_OFF': return '#2563eb';
        case 'ROLL':       return '#7c3aed';
        case 'MANUAL':     return '#6b7280';
        default:           return '#6b7280';
    }
}

function auAt2Severity(sev) {
    var k = AU_AT2_SEVERITY[sev];
    if (!k) {
        return '<span class="au-badge error">⛔ UNKNOWN SEVERITY: ' + auAt2Esc(sev) + '</span>';
    }
    return '<span class="au-badge ' + k.cls + '">' + k.icon + ' ' + auAt2Esc(sev) + '</span>';
}

/** IST, dd-mmm-yy hh:mm. Returns an em dash for null rather than "Invalid Date". */
function auAt2Ts(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '<span class="au-badge error">⛔ BAD DATE: ' + auAt2Esc(iso) + '</span>';
    return d.toLocaleString('en-GB', {
        timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
    }).replace(',', '');
}

function auAt2Num(v) {
    if (v === null || v === undefined || v === '') return '—';
    var n = Number(v);
    if (!isFinite(n)) return '<span class="au-badge error">⛔ NOT A NUMBER</span>';
    // Prices: full rupees, ZERO decimals (owner ask 11-Aug-2026) — same comma
    // style as formatPrice, just without the paise.
    return formatPrice(Math.round(n), false).replace(/\.00(?=\)?$)/, '');
}

/** D.7 — negatives in parentheses and red; zero is a neutral dash. Amounts use
 *  the global display unit (₹'000 by default). */
function auAt2Pnl(v) {
    if (v === null || v === undefined || v === '') return '<span style="color:#6b7280">—</span>';
    var n = Number(v);
    if (!isFinite(n)) return '<span class="au-badge error">⛔ NOT A NUMBER</span>';
    return '<span class="' + getAmountClass(n) + '">' + formatAmount(n) + '</span>';
}

/** POINTS are a PRICE MOVEMENT (owner ask 11-Aug-2026: "price, no decimals"):
 *  ZERO dp, NO '000 unit scaling, but keep the red/parentheses of a signed value. */
function auAt2Pts(v) {
    if (v === null || v === undefined || v === '') return '';
    var n = Number(v);
    if (!isFinite(n)) return '<span class="au-badge error">⛔</span>';
    return '<span class="' + getAmountClass(n) + '">' + formatPrice(Math.round(n), false).replace(/\.00(?=\)?$)/, '') + '</span>';
}

// ── Loading ─────────────────────────────────────────────────────────────────

async function auAt2Get(table, query) {
    var url = SUPABASE_URL + '/rest/v1/' + table + '?' + query;
    var r = await fetch(url, { headers: wmsHeaders() });
    if (!r.ok) throw new Error(table + ': HTTP ' + r.status + ' — ' + (await r.text()).slice(0, 200));
    return await r.json();
}

async function autoAt2Refresh() {
    var panels = ['open', 'closed', 'alerts', 'events', 'log', 'controls'];
    panels.forEach(function (p) {
        var el = document.getElementById('au-at2-' + p + '-content');
        if (el) el.innerHTML = '<div class="au-meta">Loading…</div>';
    });

    try {
        var res = await Promise.all([
            auAt2Get('at2_strategy', 'select=*&order=code'),
            auAt2Get('at2_book', 'select=*&order=display_name'),
            auAt2Get('at2_trade', 'select=*&order=created_at.desc&limit=500'),
            auAt2Get('at2_alert', 'select=*&order=last_seen.desc&limit=200'),
            auAt2Get('at2_signal', 'select=*&order=fired_at.desc&limit=100'),
            auAt2Get('at2_trade_event', 'select=*&order=at.desc&limit=200'),
            // Reference data for the CREATE forms. Accounts come from
            // investor_broker_accounts, not from investors × brokers: DB-05
            // refuses a book whose (investor, broker) pair has no real account,
            // so offering only real pairs prevents a refusal the owner would
            // have to decode.
            auAt2Get('at2_strategy_family', 'select=id,code,name,engine,driver,params_schema&order=code'),
            auAt2Get('investor_broker_accounts',
                     'select=investor_id,broker_id,investors(name),brokers(name)&order=investor_id'),
            // The per-run journal (migration 95) — the terse events the digest emails
            // used to carry. Feeds the Log tab; every scan, newest first.
            auAt2Get('at2_run_log', 'select=*&order=run_at.desc&limit=200')
        ]);
        _auAt2.strategies = res[0]; _auAt2.books = res[1]; _auAt2.trades = res[2];
        _auAt2.alerts = res[3]; _auAt2.signals = res[4]; _auAt2.events = res[5];
        _auAt2.families = res[6] || []; _auAt2.accounts = res[7] || [];
        _auAt2.runlog = res[8] || [];
        _auAt2.loadedAt = new Date();

        // Contract identity (symbol/expiry/lot_size) lives on securities_nfo,
        // joined manually in JS — same pattern the rest of the app uses for
        // this table (wmsRefData.securitiesNfoMap); Supabase's embed syntax
        // is never used against securities_nfo anywhere in this codebase.
        // Needed so the Open/Closed tables can show a Contract column and
        // fetch live prices, matching GS's table (owner instruction).
        var secIds = Array.from(new Set(_auAt2.trades.map(function (t) { return t.security_id; }).filter(Boolean)));
        _auAt2.securities = new Map();
        if (secIds.length) {
            var secRows = await auAt2Get('securities_nfo',
                'select=id,symbol,underlying_symbol,expiry_date,lot_size,instrument_name&id=in.('
                + secIds.map(encodeURIComponent).join(',') + ')');
            (secRows || []).forEach(function (s) { _auAt2.securities.set(s.id, s); });
        }

        auAt2RenderHeader();
        auAt2RenderMetrics();
        // Filter bar is rebuilt on every full refresh (book list may have
        // changed) — but NOT on every filter click, same as GS: a filter
        // click re-renders only the Closed table + its badge/summary, so the
        // inputs' own checked/DOM state isn't disturbed mid-interaction.
        var fb = document.getElementById('au-at2-filterbar');
        if (fb) fb.innerHTML = auAt2FilterBar();
        await auAt2RenderOpen();
        auAt2RenderClosed();
        auAt2RenderAlerts();
        auAt2RenderEvents();
        auAt2RenderLog();
        auAt2RenderControls();
    } catch (e) {
        // F.13/F.14 — a failed load must NOT fall through to an empty-looking
        // page. An empty table and a broken query look identical otherwise.
        var msg = '<div class="au-error-list"><strong>⛔ AT2 data could not be loaded.</strong>'
                + '<div style="margin-top:6px">' + auAt2Esc(e.message) + '</div>'
                + '<div style="margin-top:6px">This page is showing NOTHING, not "no trades". '
                + 'Do not read an empty page as a flat book.</div></div>';
        panels.forEach(function (p) {
            var el = document.getElementById('au-at2-' + p + '-content');
            if (el) el.innerHTML = msg;
        });
    }
}

function auAt2RenderHeader() {
    var modes = {};
    _auAt2.books.forEach(function (b) { modes[b.mode] = true; });
    var pill = document.getElementById('au-at2-mode');
    if (pill) {
        if (modes.live) { pill.className = 'status-pill live'; pill.textContent = '🟢 LIVE'; }
        else if (modes.paper) { pill.className = 'status-pill paper'; pill.textContent = '🟡 PAPER'; }
        else { pill.className = 'status-pill'; pill.textContent = '— no books'; }
    }
    var last = null;
    _auAt2.trades.forEach(function (t) {
        [t.entry_at, t.exit_at, t.updated_at].forEach(function (x) {
            if (x && (!last || x > last)) last = x;
        });
    });
    var la = document.getElementById('au-at2-lastact');
    if (la) la.textContent = 'Last activity: ' + (last ? auAt2Ts(last) : '—');

    var sub = document.getElementById('au-at2-sub');
    if (sub) {
        var enabled = _auAt2.strategies.filter(function (s) { return s.enabled; }).length;
        sub.textContent = 'Engine MS007 · at2-ms007 · ' + _auAt2.strategies.length + ' strategy(ies), '
                        + enabled + ' enabled · state read from at2_trade';
    }
}

function auAt2RenderMetrics() {
    var HELD = ['pending', 'open_unprotected', 'open_protected', 'closing'];
    var open = _auAt2.trades.filter(function (t) { return HELD.indexOf(t.status) >= 0; });
    var lots = open.reduce(function (n, t) { return n + (Number(t.qty_lots) || 0); }, 0);
    var exposure = open.reduce(function (n, t) {
        return n + (Number(t.entry_price) || 0) * (Number(t.qty_open_units) || 0);
    }, 0);
    var closed = _auAt2.trades.filter(function (t) { return t.status === 'closed'; });
    var realised = _auAt2.trades.reduce(function (n, t) { return n + (Number(t.realised_pnl) || 0); }, 0);
    var wins = closed.filter(function (t) { return Number(t.realised_pnl) > 0; }).length;
    var losses = closed.filter(function (t) { return Number(t.realised_pnl) < 0; }).length;
    var openAlerts = _auAt2.alerts.filter(function (a) { return !a.resolved_at; });
    var crit = openAlerts.filter(function (a) { return a.severity === 'critical'; }).length;
    var enabled = _auAt2.strategies.filter(function (s) { return s.enabled; }).length;

    // GS-style tiles: a plain value plus a small grey sub-line, rather than
    // baking the extra detail into the value itself.
    function set(id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; }
    function sub(id, text) { var el = document.getElementById(id); if (el) el.textContent = text || ''; }

    set('au-at2-m-open', String(open.length));
    sub('au-at2-m-open-sub', lots + ' lot(s)');

    set('au-at2-m-exposure', exposure ? formatAmount(exposure) : '—');
    sub('au-at2-m-exposure-sub', open.length ? 'across ' + open.length + ' position(s)' : '');

    set('au-at2-m-realised', auAt2Pnl(realised));
    sub('au-at2-m-realised-sub', closed.length ? (wins + 'W / ' + losses + 'L · ' + closed.length + ' closed') : 'no closed trades yet');

    set('au-at2-m-alerts', openAlerts.length
        ? (crit ? '<span class="negative">' + openAlerts.length + ' (' + crit + ' critical)</span>'
                : openAlerts.length)
        : '<span style="color:#059669">0</span>');
    sub('au-at2-m-alerts-sub', openAlerts.length ? '' : 'all clear');

    set('au-at2-m-strategies', _auAt2.strategies.length);
    sub('au-at2-m-strategies-sub', enabled + ' enabled');

    var tab = document.getElementById('au-at2-alerts-tab');
    if (tab) tab.innerHTML = 'Alerts' + (openAlerts.length
        ? ' <span class="au-badge ' + (crit ? 'error' : 'warning') + '" style="margin-left:4px">' + openAlerts.length + '</span>'
        : '');
}

/**
 * ☠️ AN INVERTED STOP — a long's stop at or above its entry, or a short's at or
 * below — would fire the instant it rested. The position LOOKS protected and is
 * not, which is the exact condition this whole module exists to prevent.
 *
 * ⚠️ The engine refuses to PLACE one (at2StopOnConfirmation), but the DATABASE
 * does not: at2_set_stop has no directional check, so a stop written by any
 * other route can land inverted and the row will happily read `open_protected`.
 * That gap is why this page tests it independently rather than trusting the
 * status column. Found 04-Aug-2026 by seeding a bad level and seeing the page
 * report a calm green PROTECTED.
 */
function auAt2StopInverted(t) {
    var stop = Number(t.current_stop), entry = Number(t.entry_price);
    if (!isFinite(stop) || !isFinite(entry) || !stop || !entry) return false;
    if (t.side === 'LONG')  return stop >= entry;
    if (t.side === 'SHORT') return stop <= entry;
    return false;
}

function auAt2BookName(id) {
    var b = _auAt2.books.filter(function (x) { return x.id === id; })[0];
    return b ? b.display_name : '<span class="au-badge error">⛔ UNKNOWN BOOK</span>';
}

/** The trade's joined securities_nfo row (symbol/expiry/lot_size), or null if
 *  unresolved — see the join built in autoAt2Refresh. Used for the Contract
 *  column and to key LTP / point-value / margin lookups, matching GS. */
function auAt2Security(t) {
    if (!t || !t.security_id || !_auAt2.securities) return null;
    return _auAt2.securities.get(t.security_id) || null;
}

async function auAt2RenderOpen(silent) {
    // ☠️ DO NOT filter to the four KNOWN held states. A trade whose status this
    // page does not recognise is not held, not closed, and would appear in
    // NEITHER table — it would vanish silently, which is strictly worse than
    // rendering blank because nothing would indicate the row exists at all.
    // Caught 04-Aug-2026 by injecting status='teleported': six loud-render
    // assertions passed and this one failed, because the row was filtered out
    // before any renderer saw it.
    //
    // So: Open shows everything NOT terminal. Unknown statuses land here and
    // shout. Terminal is the short, closed list — the one we can be sure of.
    var TERMINAL = ['closed', 'voided'];
    var rows = _auAt2.trades.filter(function (t) { return TERMINAL.indexOf(t.status) < 0; });
    var el = document.getElementById('au-at2-open-content');
    var badge = document.getElementById('au-at2-open-badge');
    var summary = document.getElementById('au-at2-open-summary');
    if (!el) return;

    if (badge) { badge.className = 'au-badge ' + (rows.length ? 'success' : 'idle'); badge.textContent = rows.length + ' open'; }

    if (!rows.length) {
        if (summary) summary.textContent = '';
        el.innerHTML = '<div class="au-soon">No open AT2 positions.<br>'
                     + '<span style="font-size:12px">Read from <code>at2_trade</code> — '
                     + _auAt2.trades.length + ' trade(s) total, none currently held.</span></div>';
        return;
    }

    var unknown = rows.filter(function (t) { return !AU_AT2_STATUS[t.status]; });
    var bad = rows.filter(auAt2StopInverted);
    // Computed unconditionally (not just when `summary` exists) — the totals
    // row in the table below also needs this, and a missing DOM node must not
    // silently leave it undefined for that second use.
    var lots = rows.reduce(function (n, t) { return n + (Number(t.qty_lots) || 0); }, 0);
    if (summary) {
        summary.textContent = lots + ' lot(s) · amounts in ' + getUnitDescription()
            + (unknown.length ? ' · ' + unknown.length + ' unknown status' : '')
            + (bad.length ? ' · ' + bad.length + ' inverted stop' : '');
    }
    var h = '';
    if (unknown.length) {
        h += '<div class="au-error-list" style="margin:0 0 12px"><strong>\u26D4 '
           + unknown.length + ' trade(s) carry a status this page does not recognise.</strong>'
           + '<div style="margin-top:4px">They are listed below rather than hidden. Either the UI has not '
           + 'been taught a new state, or the data is wrong — both need a human.</div></div>';
    }
    if (bad.length) {
        h += '<div class="au-error-list" style="margin:0 0 12px"><strong>\u26D4 '
           + bad.length + ' position(s) carry an INVERTED stop.</strong>'
           + '<div style="margin-top:4px">The stop sits on the wrong side of the entry and would fire the '
           + 'instant it rested. These positions read as protected and are NOT. Fix the level before the '
           + 'next session opens.</div></div>';
    }
    // GS-style table (mirrors autoLoadGsOpenTrades): shaded #f3f4f6 header, a
    // sticky totals row on top, sub-values (days held / stop level) nested
    // under their main cell rather than given their own column — so AT2's
    // table reads as the same product as GS's, not a different one bolted on.
    // Owner instruction (2026-08-10): match GS's COLUMN SET too, not just the
    // visual style — Contract / Qty(physical) / LTP / Exposure / Margin /
    // Live P&L are new here; Status / Risk-lot / Flags stay (owner's explicit
    // call: keep AT2's own protection columns alongside GS's).
    var now = Date.now();
    var totalExposure = 0, anyExposure = false;
    var totalMargin = 0;
    var totalPnl = 0, anyPnl = false;

    // Live LTP for the resolved contracts — same shared-cache mechanism GS uses
    // (autoFetchLtpForSymbols reads window.wmsLivePrices). _auAt2Syms registers
    // these symbols with the app-wide refresh timer; autoOnSharedRefresh calls
    // this function again (silently) on every price tick while AT2 is active.
    var uniqSyms = Array.from(new Set(rows.map(function (t) {
        var sec = auAt2Security(t);
        return sec ? sec.symbol : null;
    }).filter(Boolean)));
    _auAt2Syms = uniqSyms.map(function (s) { return { fyersKey: s, cacheKey: s.replace(/^[A-Z]+:/, '') }; });
    if (typeof autoEnsureSharedRefresh === 'function') autoEnsureSharedRefresh();
    else if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
    if (!silent && typeof wmsStandardRefresh === 'function' && window.fyersToken) {
        var cold = uniqSyms.some(function (s) {
            var bare = s.replace(/^[A-Z]+:/, '');
            var rec = (window.wmsLivePrices || {})[s] || (window.wmsLivePrices || {})[bare];
            return !(rec && rec.lp > 0);
        });
        if (cold) { try { await wmsStandardRefresh(true); } catch (_e) {} }
    }
    var ltpMap = autoFetchLtpForSymbols(uniqSyms);

    var body = '';
    rows.forEach(function (t) {
        var sec = auAt2Security(t);
        var shortSymbol = sec ? sec.underlying_symbol : null;
        var contractStr = sec ? autoFmtContract(sec.symbol, sec.expiry_date) : '—';
        var physLot = shortSymbol ? autoGsPhysicalLot(shortSymbol) : null;
        var rowLots = Number(t.qty_lots) || 0;

        // Exposure/Margin/Live P&L — same formula the metric tile above already
        // uses (entry price × currently-open units; see auAt2RenderMetrics), so
        // this row-level number and that tile total always agree. No separate
        // point-value multiplier: qty_open_units is already in the same basis
        // as entry_price (unlike GS's lots × point-value convention).
        var qtyOpenUnits = Number(t.qty_open_units);
        var exposure = (isFinite(qtyOpenUnits) && t.entry_price != null) ? qtyOpenUnits * Number(t.entry_price) : null;
        if (exposure != null && exposure > 0) { totalExposure += exposure; anyExposure = true; }
        var marginPct = shortSymbol ? autoGsMarginPct(shortSymbol) : null;
        var margin = (exposure != null && marginPct != null) ? exposure * marginPct / 100 : null;
        if (margin != null) totalMargin += margin;

        var ltpVal = sec ? ltpMap.get(sec.symbol) : undefined;
        var ltpCell, pnlCell;
        if (ltpVal != null && exposure != null) {
            var sideSign = t.side === 'LONG' ? 1 : -1;
            var pnl = sideSign * (ltpVal - Number(t.entry_price)) * qtyOpenUnits;
            anyPnl = true; totalPnl += pnl;
            ltpCell = auAt2Num(ltpVal);
            var pnlCol = pnl >= 0 ? '#047857' : '#dc2626';
            var pnlPctSub = '';
            if (exposure > 0) {
                var pnlPct = (pnl / exposure) * 100;
                pnlPctSub = '<div style="color:' + pnlCol + ';font-size:10px;margin-top:1px;font-weight:500">' + (pnlPct >= 0 ? '+' : '-') + Math.abs(pnlPct).toFixed(2) + '%</div>';
            }
            // Live P&L in ₹'000, same unit as the closed table's realised column.
            pnlCell = auAt2Pnl(pnl) + pnlPctSub;
        } else {
            ltpCell = '<span style="color:#9ca3af">-</span>';
            pnlCell = '<span style="color:#9ca3af">-</span>';
        }
        var exposureCell = exposure != null ? formatAmount(exposure) : '<span style="color:#9ca3af">-</span>';
        var marginCell = margin != null
            ? formatAmount(margin) + '<div style="color:#6b7280;font-size:10px;margin-top:1px">' + marginPct + '%</div>'
            : '<span style="color:#9ca3af">-</span>';

        var flags = [];
        if (t.cap_bound) flags.push('<span class="au-badge warning" title="the book\'s lot_cap reduced this allocation">cap-bound</span>');
        if (t.rolled_from_trade_id) flags.push('<span class="au-badge idle" title="opened by a roll">rolled</span>');
        if (auAt2StopInverted(t)) flags.push('<span class="au-badge error" title="A long stop at or above its '
            + 'entry (or a short at or below) would fire the instant it rested. This position reads as protected '
            + 'and is not.">\u26D4 INVERTED STOP</span>');
        if (t.mode === 'live') flags.push('<span class="au-badge error">LIVE</span>');

        var sideBadge = t.side === 'LONG'
            ? '<span class="au-badge success">LONG</span>'
            : '<span class="au-badge error">SHORT</span>';
        var daysHeld = t.entry_at ? Math.max(0, Math.floor((now - new Date(t.entry_at).getTime()) / 86400000)) : null;
        var daysSub = daysHeld != null
            ? '<div style="color:#6b7280;font-size:10px;margin-top:1px">' + daysHeld + ' day' + (daysHeld === 1 ? '' : 's') + '</div>'
            : '';
        var qtySub = physLot
            ? '<div style="color:#6b7280;font-size:10px;margin-top:1px">' + (rowLots * physLot.qty) + ' ' + physLot.unit + '</div>'
            : '';

        body += '<tr style="border-top:1px solid #e5e7eb">'
           + '<td style="padding:6px 8px;vertical-align:top">' + auAt2StatusBadge(t.status) + '</td>'
           + '<td style="padding:6px 8px;vertical-align:top;font-weight:700;color:#1d4ed8">' + auAt2Esc(auAt2BookName(t.book_id)).replace(/&lt;/g, '<').replace(/&gt;/g, '>') + '</td>'
           + '<td style="padding:6px 8px;vertical-align:top">' + sideBadge + '</td>'
           + '<td style="padding:6px 8px;vertical-align:top">' + auAt2Ts(t.entry_at) + daysSub + '</td>'
           + '<td style="padding:6px 8px;vertical-align:top">' + auAt2Esc(contractStr) + '</td>'
           + '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + rowLots + ' lot' + (rowLots === 1 ? '' : 's') + qtySub + '</td>'
           + '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + auAt2Num(t.entry_price) + (!t.current_stop
                        ? '<div style="margin-top:2px"><span class="au-badge error" style="font-size:9px">NO STOP</span></div>'
                        : auAt2StopInverted(t)
                            ? '<div style="color:#dc2626;font-weight:700;font-size:10px;margin-top:1px">Stop: ' + auAt2Num(t.current_stop) + ' \u26D4</div>'
                            : '<div style="color:#6b7280;font-size:10px;margin-top:1px">Stop: ' + auAt2Num(t.current_stop) + '</div>') + '</td>'
           + '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + ltpCell + '</td>'
           + '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + exposureCell + '</td>'
           + '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + marginCell + '</td>'
           + '<td style="padding:6px 8px;text-align:right;white-space:nowrap;vertical-align:top">' + pnlCell + '</td>'
           + '<td style="padding:6px 8px;vertical-align:top;white-space:normal;line-height:1.7">' + (flags.join(' ') || '—') + '</td>'
           + '<td style="padding:6px 8px;text-align:right;vertical-align:top"><button class="au-btn au-btn-danger" style="padding:4px 8px;font-size:11px"'
           + ' onclick="autoAt2OpenCloseModal(\'' + t.id + '\')">Close</button></td>'
           + '</tr>';
    });

    var pnlTotalCell = anyPnl ? auAt2Pnl(totalPnl) : '<span style="color:#9ca3af">-</span>';

    var totalsRow = '<tr style="background:#f7fafc;border-bottom:2px solid #cbd5e0;font-weight:700;position:sticky;top:0">'
            + '<td colspan="4" style="padding:8px;text-align:right">Totals (' + rows.length + ' open):</td>'
            + '<td style="padding:8px"></td>'
            + '<td style="padding:8px;text-align:right">' + lots + ' lot(s)</td>'
            + '<td style="padding:8px"></td>'
            + '<td style="padding:8px"></td>'
            + '<td style="padding:8px;text-align:right">' + (anyExposure ? formatAmount(totalExposure) : '<span style="color:#9ca3af">-</span>') + '</td>'
            + '<td style="padding:8px;text-align:right">' + (anyExposure ? formatAmount(totalMargin) : '<span style="color:#9ca3af">-</span>') + '</td>'
            + '<td style="padding:8px;text-align:right">' + pnlTotalCell + '</td>'
            + '<td style="padding:8px" colspan="2"></td>'
            + '</tr>';

    var headerRow = '<tr style="background:#f3f4f6;text-align:left">'
            + '<th style="padding:6px 8px">Status</th>'
            + '<th style="padding:6px 8px">Book</th>'
            + '<th style="padding:6px 8px">Side</th>'
            + '<th style="padding:6px 8px">Entered<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ days held</span></th>'
            + '<th style="padding:6px 8px">Contract</th>'
            + '<th style="padding:6px 8px;text-align:right">Qty<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ physical</span></th>'
            + '<th style="padding:6px 8px;text-align:right">Entry Px<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ stop</span></th>'
            + '<th style="padding:6px 8px;text-align:right">LTP</th>'
            + '<th style="padding:6px 8px;text-align:right">Exposure</th>'
            + '<th style="padding:6px 8px;text-align:right">Margin<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ %</span></th>'
            + '<th style="padding:6px 8px;text-align:right">Live P&amp;L<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ % of exp</span></th>'
            + '<th style="padding:6px 8px">Flags</th>'
            + '<th style="padding:6px 8px;text-align:right">Action</th>'
            + '</tr>';

    h += '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">'
       + '<thead>' + totalsRow + headerRow + '</thead><tbody>' + body + '</tbody></table></div>';
    h += '<div class="au-meta" style="margin-top:8px;font-size:11px;color:#6b7280;line-height:1.6">'
       + '• LTP via Fyers /quotes (needs an active Fyers connection) — same shared price cache GS uses.<br>'
       + '• Exposure = entry price × currently-open units (matches the metric tile above). Margin = Exposure × GOLDM 10% / SILVERM 20%.<br>'
       + '• Live P&amp;L = side × (LTP − entry) × currently-open units.<br>'
       + '• Flags: cap-bound = book’s lot_cap reduced the allocation · rolled = opened by a roll · ⛔ INVERTED STOP = the stop is on the wrong side of entry (reads protected, isn’t) · LIVE = real order, not paper.'
       + '</div>';
    el.innerHTML = h;
}

function auAt2RenderClosed() {
    var all = _auAt2.trades.filter(function (t) { return t.status === 'closed' || t.status === 'voided'; });
    // Filters (Instrument / Result / Exit reason / Book) apply HERE ONLY —
    // Open trades (above) is never filtered. See auAt2ClosedPassesFilters.
    var rows = all.filter(auAt2ClosedPassesFilters);
    var el = document.getElementById('au-at2-closed-content');
    var badge = document.getElementById('au-at2-closed-badge');
    var summary = document.getElementById('au-at2-closed-summary');
    if (!el) return;

    var filtered = rows.length !== all.length;
    if (badge) { badge.className = 'au-badge idle'; badge.textContent = rows.length + ' closed' + (filtered ? ' (of ' + all.length + ')' : ''); }

    if (!rows.length) {
        if (summary) summary.textContent = '';
        el.innerHTML = '<div class="au-soon">' + (all.length
            ? 'No closed AT2 trades match the current filters (' + all.length + ' total, all filtered out).'
            : 'No closed AT2 trades yet.') + '</div>';
        return;
    }

    var wins = rows.filter(function (t) { return Number(t.realised_pnl) > 0; }).length;
    var losses = rows.filter(function (t) { return Number(t.realised_pnl) < 0; }).length;
    var total = rows.reduce(function (n, t) { return n + (Number(t.realised_pnl) || 0); }, 0);
    if (summary) summary.textContent = wins + 'W / ' + losses + 'L · P&L in ' + getUnitDescription() + (filtered ? ' · filtered' : '');

    // GS-style table (mirrors autoLoadGsClosedTrades): totals row pinned to the
    // top (owner ask on GS, carried over here — no scrolling to a tfoot to see
    // the bottom line), shaded header, Reason colour-coded the same way GS
    // colours its exit categories (auAt2ExitColor).
    var totalLabel = 'Total (' + rows.length + ' closed - ' + wins + 'W / ' + losses + 'L'
                    + (filtered ? ' - filtered from ' + all.length : '') + ')';

    // Total in the SAME ₹'000 unit + red/parens style as the column (owner ask
    // 11-Aug-2026 — it used to render full rupees, an independent format).
    var totalsRow = '<tr style="background:#f7fafc;border-bottom:2px solid #cbd5e0;font-weight:700;position:sticky;top:0">'
            + '<td colspan="10" style="padding:8px">' + auAt2Esc(totalLabel) + '</td>'
            + '<td style="padding:8px;text-align:right;white-space:nowrap">' + auAt2Pnl(total) + '</td>'
            + '</tr>';

    var headerRow = '<tr style="background:#f3f4f6;text-align:left">'
            + '<th style="padding:6px 8px">Status</th>'
            + '<th style="padding:6px 8px">Book</th>'
            + '<th style="padding:6px 8px">Side</th>'
            + '<th style="padding:6px 8px">Entry</th>'
            + '<th style="padding:6px 8px">Exit<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ days held</span></th>'
            + '<th style="padding:6px 8px">Contract</th>'
            + '<th style="padding:6px 8px;text-align:right">Qty<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ physical</span></th>'
            + '<th style="padding:6px 8px;text-align:right">Entry Px</th>'
            + '<th style="padding:6px 8px;text-align:right">Exit Px</th>'
            + '<th style="padding:6px 8px">Reason</th>'
            + '<th style="padding:6px 8px;text-align:right">Realised P&amp;L<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ points</span></th>'
            + '</tr>';

    var body = '';
    rows.forEach(function (t) {
        var sideBadge = t.side === 'LONG'
            ? '<span class="au-badge success">LONG</span>'
            : '<span class="au-badge error">SHORT</span>';

        var daysHeld = (t.entry_at && t.exit_at)
            ? Math.max(0, Math.floor((new Date(t.exit_at).getTime() - new Date(t.entry_at).getTime()) / 86400000))
            : null;
        var daysSub = daysHeld != null
            ? '<div style="color:#6b7280;font-size:10px;margin-top:1px">' + daysHeld + ' day' + (daysHeld === 1 ? '' : 's') + '</div>'
            : '';

        var reasonCell = t.exit_reason
            ? '<span style="color:' + auAt2ExitColor(t.exit_reason) + ';font-weight:600">' + auAt2ExitReason(t.exit_reason) + '</span>'
            : auAt2ExitReason(t.exit_reason);

        var sec = auAt2Security(t);
        var shortSymbol = sec ? sec.underlying_symbol : null;
        var contractStr = sec ? autoFmtContract(sec.symbol, sec.expiry_date) : '—';
        var physLot = shortSymbol ? autoGsPhysicalLot(shortSymbol) : null;

        var rowLots = Number(t.qty_lots) || 0;
        var qtySub = physLot
            ? '<div style="color:#6b7280;font-size:10px;margin-top:1px">' + (rowLots * physLot.qty) + ' ' + physLot.unit + '</div>'
            : '';
        var pointsSub = (t.pnl_points !== null && t.pnl_points !== undefined)
            ? '<div style="font-size:10px;margin-top:1px">' + auAt2Pts(t.pnl_points) + ' pts</div>' : '';

        body += '<tr style="border-top:1px solid #e5e7eb">'
           + '<td style="padding:6px 8px;vertical-align:top">' + auAt2StatusBadge(t.status) + '</td>'
           + '<td style="padding:6px 8px;vertical-align:top;font-weight:700;color:#1d4ed8">' + auAt2Esc(auAt2BookName(t.book_id)).replace(/&lt;/g, '<').replace(/&gt;/g, '>') + '</td>'
           + '<td style="padding:6px 8px;vertical-align:top">' + sideBadge + '</td>'
           + '<td style="padding:6px 8px;vertical-align:top">' + auAt2Ts(t.entry_at) + '</td>'
           + '<td style="padding:6px 8px;vertical-align:top">' + auAt2Ts(t.exit_at) + daysSub + '</td>'
           + '<td style="padding:6px 8px;vertical-align:top">' + auAt2Esc(contractStr) + '</td>'
           + '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + rowLots + ' lot' + (rowLots === 1 ? '' : 's') + qtySub + '</td>'
           + '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + auAt2Num(t.entry_price) + '</td>'
           + '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + auAt2Num(t.exit_price) + '</td>'
           + '<td style="padding:6px 8px;vertical-align:top">' + reasonCell + '</td>'
           + '<td style="padding:6px 8px;text-align:right;white-space:nowrap;vertical-align:top">' + auAt2Pnl(t.realised_pnl) + pointsSub + '</td>'
           + '</tr>';
    });

    var h = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">'
          + '<thead>' + totalsRow + headerRow + '</thead><tbody>' + body + '</tbody></table></div>';
    el.innerHTML = h;
}

function auAt2RenderAlerts() {
    var el = document.getElementById('au-at2-alerts-content');
    if (!el) return;
    var open = _auAt2.alerts.filter(function (a) { return !a.resolved_at; });
    var resolved = _auAt2.alerts.filter(function (a) { return a.resolved_at; });
    // Titles carry raw trade/command UUIDs (e.g. "trade 8e1f3fdd-… is UNPROTECTED");
    // shorten to the first 8 chars so the table reads in plain English, not jargon.
    var shortIds = function (x) { return String(x || '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, function (m) { return m.slice(0, 8) + '\u2026'; }); };

    var h = '<div class="au-card" style="padding:10px 12px;margin-bottom:10px">'
          + '<strong>The email is a notification. This table is the truth.</strong>'
          + '<div class="au-sub" style="margin:2px 0 0">A condition emails once when it fires and once when it '
          + 'escalates — recurrences are silent by design. An alert you stopped receiving mail about is still '
          + 'open here until it is resolved.</div></div>';

    if (!open.length) {
        h += '<div class="au-soon" style="border-color:#a7f3d0;color:#065f46">✅ No open alerts.</div>';
    } else {
        h += '<table class="au-at2-table"><thead><tr><th>Severity</th><th>Alert</th>'
           + '<th class="text-right">Seen</th><th>First</th><th>Last</th><th>Escalated</th></tr></thead><tbody>';
        open.forEach(function (a) {
            h += '<tr' + (a.severity === 'critical' ? ' style="background:#fef2f2"' : '') + '>'
               + '<td>' + auAt2Severity(a.severity) + '</td>'
               + '<td>' + shortIds(auAt2Esc(a.title)) + '</td>'
               + '<td class="text-right">' + auAt2Esc(a.occurrences) + '×</td>'
               + '<td>' + auAt2Ts(a.first_seen) + '</td>'
               + '<td>' + auAt2Ts(a.last_seen) + '</td>'
               + '<td>' + (a.escalated_at ? auAt2Ts(a.escalated_at) : '—') + '</td>'
               + '</tr>';
        });
        h += '</tbody></table>';
    }

    if (resolved.length) {
        h += '<details style="margin-top:12px"><summary>' + resolved.length + ' resolved alert(s)</summary>'
           + '<table class="au-at2-table" style="margin-top:8px"><thead><tr><th>Severity</th><th>Title</th>'
           + '<th>Resolved</th></tr></thead><tbody>';
        resolved.forEach(function (a) {
            h += '<tr><td>' + auAt2Severity(a.severity) + '</td><td>' + shortIds(auAt2Esc(a.title)) + '</td>'
               + '<td>' + auAt2Ts(a.resolved_at) + '</td></tr>';
        });
        h += '</tbody></table></details>';
    }
    el.innerHTML = h;
}

function auAt2RenderEvents() {
    var el = document.getElementById('au-at2-events-content');
    if (!el) return;
    var h = '<div class="au-card" style="padding:10px 12px"><strong>Signals</strong> '
          + '<span class="au-sub">— one row per decision. The dedupe key makes a second decision '
          + 'from one input impossible.</span></div>';
    if (!_auAt2.signals.length) {
        h += '<div class="au-soon">No signals recorded.</div>';
    } else {
        h += '<table class="au-at2-table"><thead><tr><th>Intent</th><th>Fired</th><th>Bar</th>'
           + '<th>Dedupe key</th><th>Metrics</th></tr></thead><tbody>';
        _auAt2.signals.forEach(function (s) {
            h += '<tr><td><span class="au-badge idle">' + auAt2Esc(s.intent) + '</span></td>'
               + '<td>' + auAt2Ts(s.fired_at) + '</td><td>' + auAt2Ts(s.bar_ts) + '</td>'
               + '<td><code style="font-size:11px">' + auAt2Esc(s.dedupe_key) + '</code></td>'
               + '<td style="font-size:11px;color:#6b7280">' + auAt2Esc(JSON.stringify(s.metrics)) + '</td></tr>';
        });
        h += '</tbody></table>';
    }

    h += '<div class="au-card" style="padding:10px 12px;margin-top:14px"><strong>Trade events</strong> '
       + '<span class="au-sub">— append-only. The database refuses UPDATE and DELETE here.</span></div>';
    if (!_auAt2.events.length) {
        h += '<div class="au-soon">No trade events.</div>';
    } else {
        h += '<table class="au-at2-table"><thead><tr><th>Seq</th><th>Kind</th><th>At</th>'
           + '<th class="text-right">Price</th><th class="text-right">Lots</th><th>Reason</th></tr></thead><tbody>';
        _auAt2.events.forEach(function (ev) {
            h += '<tr><td>' + auAt2Esc(ev.seq) + '</td>'
               + '<td><span class="au-badge idle">' + auAt2Esc(ev.kind) + '</span></td>'
               + '<td>' + auAt2Ts(ev.at) + '</td>'
               + '<td class="text-right">' + auAt2Num(ev.price) + '</td>'
               + '<td class="text-right">' + (ev.qty_lots === null ? '—' : auAt2Esc(ev.qty_lots)) + '</td>'
               + '<td style="font-size:11px">' + auAt2Esc(ev.reason || '') + '</td></tr>';
        });
        h += '</tbody></table>';
    }
    el.innerHTML = h;
}

// ----- Log tab --------------------------------------------------------------
// Every run as ONE table row, newest first — the terse lines the digest emails
// carried (blocked X of Y bars, entry Z lots @ price, exit … P&L, stop → level).
// Emails are gated to entries/exits/criticals; this is the FULL record.
// Source: at2_run_log (mig 95 + engine col mig 96), one row per scan.
function auAt2RenderLog() {
    var el = document.getElementById('au-at2-log-content');
    if (!el) return;
    var runs = _auAt2.runlog || [];
    var h = '<div class="au-card" style="padding:10px 12px"><strong>Run log</strong> '
          + '<span class="au-sub">— every scan, newest first; times IST. The same terse lines the '
          + 'digest emails carried. Emails now fire only for entries, exits and criticals; this is the full record.</span></div>';
    if (!runs.length) {
        h += '<div class="au-soon">No runs journalled yet — starts once the engine build carrying the Log is deployed.</div>';
        el.innerHTML = h; return;
    }
    var px = function (n) { return (n === null || n === undefined || !isFinite(Number(n))) ? '—' : '\u20b9' + auAt2Num(n); };
    var money = function (n) { n = Number(n) || 0;
        return '<span style="color:' + (n < 0 ? '#c53030' : '#2f855a') + '">' + (n < 0 ? '\u2212\u20b9' : '+\u20b9') + auAt2Num(Math.abs(n)) + '</span>'; };
    var chip = function (m) { return '<span class="au-badge ' + (m === 'live' ? 'error' : 'idle')
          + '" style="font-size:9px;padding:0 5px;margin-left:2px">' + (m === 'live' ? 'LIVE' : 'paper') + '</span>'; };

    h += '<table class="au-at2-table"><thead><tr>'
       + '<th style="white-space:nowrap">Time</th><th>Family</th><th>What happened</th>'
       + '<th style="text-align:center">Email</th></tr></thead><tbody>';
    runs.forEach(function (r) {
        var d = r.digest || {};
        var evs = d.events || [], blocks = d.blocks || [], failed = d.failed || [];
        var lines = [];
        evs.forEach(function (e) {
            var who = auAt2Esc(e.instrument) + ' ' + auAt2Esc(e.side);
            var lot = e.lots + ' lot' + (Number(e.lots) > 1 ? 's' : '');
            if (e.kind === 'ENTRY')
                lines.push('\ud83d\udfe2 ' + who + ' \u00b7 entry ' + lot + ' @ ' + px(e.price) + ' \u00b7 SL ' + px(e.toStop) + ' \u00b7 ' + auAt2Esc(e.book || '') + chip(e.mode));
            else if (e.kind === 'EXIT')
                lines.push('\ud83d\udd34 ' + who + ' \u00b7 exit ' + lot + ' @ ' + px(e.price) + ' \u00b7 ' + auAt2Esc(e.reason || '') + ' \u00b7 ' + money(e.pnl) + chip(e.mode));
            else if (e.kind === 'STOP_MOVE')
                lines.push('\ud83d\udd27 ' + who + ' \u00b7 SL \u2192 ' + px(e.toStop) + chip(e.mode));
            else if (e.kind === 'ROLL')
                lines.push('\ud83d\udd04 ' + who + ' \u00b7 rolled' + chip(e.mode));
        });
        blocks.forEach(function (b) { lines.push('\u23f8 ' + auAt2Esc(b)); });
        failed.forEach(function (fl) { lines.push('\u26a0 ' + auAt2Esc(fl)); });

        // ONE ROW PER RUN. Family badge = at2_run_log.engine (mig 96) — the journal
        // serves EVERY AT2 family. Multiple events stack in the last cell; a quiet
        // scan is one dimmed row so the eye skips it.
        var what = lines.length
            ? lines.map(function (l) { return '<div>' + l + '</div>'; }).join('')
            : '<span class="au-sub">quiet \u2014 nothing to act on</span>';
        h += '<tr' + (lines.length ? '' : ' style="opacity:.5"') + '>'
           + '<td style="white-space:nowrap;font-weight:600">' + auAt2Esc(r.run_ist || auAt2Ts(r.run_at)) + '</td>'
           + '<td><span class="au-badge idle" style="font-size:9px;padding:0 5px;font-weight:600">' + auAt2Esc(r.engine || 'MS007') + '</span></td>'
           + '<td style="line-height:1.7">' + what + '</td>'
           + '<td style="text-align:center">' + (r.emailed ? '\u2709' : '\u2014') + '</td></tr>';
    });
    h += '</tbody></table>';
    el.innerHTML = h;
}

// ════════════════════════════════════════════════════════════════════════════
// AT2 CONFIGURATION — structured view + edit
//
// ☠️ WHY STRUCTURED FIELDS AND NOT A JSON BOX. Owner, 05-Aug-2026: the point is
// to SEE what the database holds and to TEST whether a value can be written. A
// JSON textarea shows the same thing the SQL editor shows and teaches nothing
// about which keys are legal — the whole question being asked.
//
// ☠️ THE DATABASE IS THE VALIDATOR, NOT THIS FORM. at2_strategy.params is checked
// against the family's params_schema by a trigger (pg_jsonschema). This form does
// NOT re-implement those rules — a second copy would drift from the first, and
// the first is the one that actually runs. The form's job is to send the value
// and show the refusal VERBATIM when the database says no. Proved 05-Aug-2026:
// hour 99 is refused with "params for strategy X do not satisfy the MS007 family
// template".
//
// ⚠️ INLINE, NOT A MODAL — matching this module's own idiom (KH tags, lot sizes
// are inline cards). It also avoids D.8.6's shipped bug: the app's 940px table
// min-width is unscoped and leaks into every modal containing a table.
//
// ⚠️ D.8.10 — an UNRECOGNISED params key is rendered LOUDLY, never dropped. A
// renderer that shows only the keys it knows silently hides a value that IS
// driving the engine.
// ════════════════════════════════════════════════════════════════════════════

// The MS007 params contract (Plan §4.3). `path` is the dotted location in the
// params jsonb; `kind` drives the input; `hint` is what the owner needs to know
// to set it. Adding an engine key means adding a row here AND updating
// params_schema — the schema is what enforces it.
// ── THE PARAMETER CONTRACT ──────────────────────────────────────────────────
//
// One row per editable param. Rendering, reading, saving and the "not
// recognised" check all derive from this array, so a new param is ONE entry
// here rather than four edits scattered around.
//
// `group` orders the form. Fields used to render in declaration order, which
// put the roll settings between the session times and made the screen read as
// a list of unrelated numbers. They are now grouped the way you actually think
// about them: what it trades → what it risks → how it trails → when it may
// trade → when it rolls.
//
// `money:true` formats with thousands separators on display and strips them on
// read. `readonly:true` renders the value but never lets it be edited — see
// timeframe_minutes, which is the one field on this screen that lies.
var AU_AT2_PARAM_GROUPS = [
    { key: 'instrument', label: 'Instrument & run' },
    { key: 'risk',       label: 'Risk & stop' },
    { key: 'trail',      label: 'Trail' },
    { key: 'session',    label: 'Session — when it may trade' },
    { key: 'roll',       label: 'Roll' }
];

var AU_AT2_PARAM_FIELDS = [
    { group: 'instrument', path: 'instrument_key',   label: 'Instrument',        kind: 'text',  hint: 'GOLDM · SILVERM — from the catalogue. An unknown key makes the engine REFUSE, by design' },

    // ☠️ READ-ONLY, AND THE HINT SAYS WHY. This field was editable and did NOT
    // do what its name says. `readBars()` is called WITHOUT a resolution, so it
    // always reads 15-minute bars whatever this says. Changing it to 5 would
    // leave the engine reading 15-minute bars while treating them as 5-minute
    // ones — wrong staleness threshold, wrong cooldown duration, wrong
    // bar-matching tolerance, and NO error anywhere. Locked until the bar
    // resolution is actually plumbed through.
    { group: 'instrument', path: 'timeframe_minutes', label: 'Timeframe (min)',  kind: 'int', readonly: true,
      hint: '⚠️ LOCKED at 15. It does NOT choose the bar size — the engine always reads 15-minute bars. Editing it only mis-sets the staleness and cooldown maths' },

    { group: 'risk', path: 'risk_per_trade', label: 'Risk per trade',   kind: 'num', money: true, hint: 'Rupees at risk per signal, before each book\'s exposure factor' },
    { group: 'risk', path: 'stop.mode',      label: 'Stop mode',        kind: 'enum', opts: ['atr'], hint: 'How the hard stop is computed' },
    { group: 'risk', path: 'stop.mult',      label: 'Stop × ATR',       kind: 'num',  hint: 'Stop distance = mult × ATR. Lots = risk ÷ (ATR × mult × point value)' },
    { group: 'risk', path: 'min_hold_bars',  label: 'Min hold (bars)',  kind: 'int',  hint: 'Exit rules do not fire before this many bars since entry' },

    { group: 'trail', path: 'trail.mode',    label: 'Trail mode',       kind: 'enum', opts: ['atr', 'none'], hint: 'Whether a trail runs at all' },
    { group: 'trail', path: 'trail.trigger', label: 'Trigger × ATR',    kind: 'num',  hint: 'Arms once unrealised gain ≥ trigger × ATR' },
    { group: 'trail', path: 'trail.step',    label: 'Step × ATR',       kind: 'num',  hint: 'Level = close ∓ step × ATR. It only ever ratchets — never loosens' },

    { group: 'session', path: 'session.entry_cutoff',   label: 'Entry cutoff',     kind: 'hhmm', hint: 'HH:MM IST. A ONE-WAY door — no new entry for the rest of the day' },
    { group: 'session', path: 'session.no_entry_start', label: 'Dead period from', kind: 'hour', hint: 'IST hour, inclusive. Blank = no dead period' },
    { group: 'session', path: 'session.no_entry_end',   label: 'Dead period until',kind: 'hour', hint: 'IST hour, exclusive. It REOPENS here — unlike the cutoff. May wrap midnight' },
    { group: 'session', path: 'session.square_off_time',label: 'Square-off',       kind: 'hhmm', hint: 'HH:MM IST. Blank = the position carries overnight (MS007 carries)' },

    { group: 'roll', path: 'roll.entry_days_before', label: 'Entry roll — days before expiry', kind: 'int', hint: 'A NEW entry rolls to the NEXT month this many days before the front contract\'s expiry (contract selection). 7 clears MCX\'s staggered-delivery block near expiry.' },
    { group: 'roll', path: 'roll.days_before', label: 'Roll days before', kind: 'int',  hint: 'Roll when the held contract is within this many days of expiry (open-position rollover — currently disabled)' },
    { group: 'roll', path: 'roll.time',        label: 'Roll at',          kind: 'hhmm', hint: 'HH:MM IST — when in the day the roll executes' }
];

/** ₹ with thousands separators, Indian grouping. Blank stays blank. */
function auAt2Money(v) {
    if (v === undefined || v === null || v === '') return '';
    var n = Number(v);
    if (!isFinite(n)) return String(v);
    return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
/** The inverse — strip separators so the DB gets a number, not "75,000". */
function auAt2Unmoney(raw) {
    return String(raw === undefined || raw === null ? '' : raw).replace(/,/g, '').trim();
}

// Which cards are open. Module-level so a re-render (save, cancel, refresh)
// does not collapse everything the owner had expanded.
var _auAt2Open = {};

// Whether retired (hidden) rows are on screen. OFF by default — the whole point
// of hiding is a shorter list — but the count is always shown, so a hidden row
// is never a row you cannot find.
var _auAt2ShowHidden = false;

function auAt2Dig(obj, path) {
    return path.split('.').reduce(function (o, k) {
        return (o === null || o === undefined) ? undefined : o[k];
    }, obj);
}
function auAt2Bury(obj, path, val) {
    var ks = path.split('.'), cur = obj;
    for (var i = 0; i < ks.length - 1; i++) {
        if (typeof cur[ks[i]] !== 'object' || cur[ks[i]] === null) cur[ks[i]] = {};
        cur = cur[ks[i]];
    }
    if (val === undefined) delete cur[ks[ks.length - 1]];
    else cur[ks[ks.length - 1]] = val;
}

/** Every params key NOT in the contract above. D.8.10 — never silently dropped. */
function auAt2UnknownParamPaths(params) {
    var known = {}, out = [];
    AU_AT2_PARAM_FIELDS.forEach(function (f) { known[f.path] = 1; });
    (function walk(o, prefix) {
        Object.keys(o || {}).forEach(function (k) {
            var path = prefix ? prefix + '.' + k : k;
            var v = o[k];
            if (v && typeof v === 'object' && !Array.isArray(v)) { walk(v, path); return; }
            if (!known[path]) out.push({ path: path, value: v });
        });
    })(params || {}, '');
    return out;
}

function auAt2FieldInput(f, params, sid) {
    var v = auAt2Dig(params, f.path);
    var id = 'au-at2-p-' + sid + '-' + f.path.replace(/\./g, '_');
    var numeric = (f.kind === 'num' || f.kind === 'int' || f.kind === 'hour');
    var cls = 'wms-input au-at2-pf' + (numeric ? ' wms-input-number' : '');
    if (f.readonly) cls += ' au-at2-locked';

    if (f.kind === 'enum') {
        // NOT a <select> (D.8.7). A short enum is a pill toggle — the canonical
        // .wms-pill — rather than a search-suggest widget it does not need.
        return '<div class="au-at2-pills" id="' + id + '" data-path="' + f.path + '" data-kind="enum"'
             + (f.readonly ? ' data-readonly="yes"' : '') + '>'
             + f.opts.map(function (o) {
                 return '<span class="wms-pill au-at2-pill' + (String(v) === o ? ' on' : '')
                      + '" data-val="' + o + '">' + auAt2Esc(o) + '</span>';
               }).join('') + '</div>';
    }

    // ☠️ A MONEY FIELD IS A TEXT INPUT, NOT number. `<input type="number">`
    // rejects "75,000" outright — it reports an empty value and the separators
    // would have to be dropped to keep the control usable. Text + an inputmode
    // keeps the grouping visible AND still brings up a numeric keypad.
    var type = (f.money || f.kind === 'hhmm' || f.kind === 'text') ? 'text' : 'number';
    var step = f.kind === 'num' ? 'any' : '1';
    var shown = f.money ? auAt2Money(v) : (v === undefined || v === null ? '' : String(v));

    return '<input id="' + id + '" class="' + cls + '" data-path="' + f.path + '" data-kind="' + f.kind + '"'
         + (f.money ? ' data-money="yes" inputmode="decimal"' : '')
         + (f.readonly ? ' data-readonly="yes"' : '')
         + ' type="' + type + '"' + (type === 'number' ? ' step="' + step + '"' : '')
         + ' value="' + auAt2Esc(shown) + '"'
         + (f.kind === 'hhmm' ? ' placeholder="HH:MM"' : '')
         + (f.money ? ' placeholder="0"' : '') + ' disabled>';
}

/** One labelled field cell. */
function auAt2FieldCell(f, params, sid) {
    return '<div class="au-at2-field' + (f.readonly ? ' au-at2-field-locked' : '') + '">'
         +   '<label>' + auAt2Esc(f.label) + (f.money ? ' <span class="au-at2-unit">₹</span>' : '')
         +     (f.readonly ? ' <span class="au-at2-lockbadge" title="Read-only">🔒</span>' : '') + '</label>'
         +   auAt2FieldInput(f, params, sid)
         +   '<div class="au-at2-hint">' + auAt2Esc(f.hint) + '</div>'
         + '</div>';
}

/** The grouped parameter form for one strategy. */
function auAt2ParamForm(params, sid) {
    var h = '';
    AU_AT2_PARAM_GROUPS.forEach(function (g) {
        var fields = AU_AT2_PARAM_FIELDS.filter(function (f) { return f.group === g.key; });
        if (!fields.length) return;
        h += '<div class="au-at2-group"><div class="au-at2-group-label">' + auAt2Esc(g.label) + '</div>'
           + '<div class="au-at2-grid">'
           + fields.map(function (f) { return auAt2FieldCell(f, params, sid); }).join('')
           + '</div></div>';
    });
    return h;
}

function auAt2RenderControls() {
    var el = document.getElementById('au-at2-controls-content');
    if (!el) return;

    // ── Strategies ──────────────────────────────────────────────────────────
    var h = '<div class="au-card">'
          + '<div class="au-at2-cardhead">'
          +   '<h3>Strategies</h3>'
          +   '<button class="au-btn au-btn-primary" id="au-at2-newstrat">＋ New strategy</button>'
          + '</div>'
          + '<div class="au-sub">Every value is read from <code>at2_strategy</code>. Saving writes straight back — '
          + 'and the <b>database</b> validates it against the family template, so an illegal value is REFUSED with '
          + 'the reason shown here rather than silently accepted. Click a name to expand or collapse it.</div>';

    var stratHidden = _auAt2.strategies.filter(function (x) { return x.hidden; }).length;
    h += auAt2HiddenBar(stratHidden);
    // Retired rows are OUT of the list unless asked for. The count above is
    // always shown, so a hidden row is never one you cannot find.
    var stratShown = _auAt2.strategies.filter(function (x) { return _auAt2ShowHidden || !x.hidden; });

    if (!stratShown.length) {
        h += '<div class="au-soon">' + (stratHidden ? 'Every strategy is hidden — use “Show retired”.'
                                                    : 'No AT2 strategies configured. Use ＋ New strategy.') + '</div>';
    } else {
        stratShown.forEach(function (s2) {
            var params = s2.params || {};
            var open = !!_auAt2Open['s:' + s2.id];
            h += '<div class="au-at2-strat' + (open ? ' open' : '') + (s2.hidden ? ' retired' : '') + '" data-sid="' + s2.id + '">'
               + '<div class="au-at2-strat-head">'
               +   '<div class="au-at2-title" data-toggle="s:' + s2.id + '">'
               +     '<span class="au-at2-caret">' + (open ? '▾' : '▸') + '</span>'
               +     '<span class="au-at2-name">' + auAt2Esc(s2.display_name || s2.code) + '</span>'
               +     (s2.hidden ? ' <span class="au-badge idle">retired</span>' : '')
               +     '<code class="au-at2-code">' + auAt2Esc(s2.code) + '</code>'
               +     ' <span class="au-badge idle">' + auAt2Esc(s2.version) + '</span>'
               +     (s2.enabled ? ' <span class="au-badge success">enabled</span>'
                                 : ' <span class="au-badge idle">disabled</span>')
               +     (s2.requires_resting_stop ? '' : ' <span class="au-badge warning">no resting stop</span>')
               +   '</div>'
               +   '<div class="au-at2-strat-actions">'
               +     '<button class="au-btn au-btn-secondary au-at2-edit" data-sid="' + s2.id + '">✏️ Edit</button>'
               +     '<button class="au-btn au-btn-primary au-at2-save" data-sid="' + s2.id + '" style="display:none">Save</button>'
               +     '<button class="au-btn au-btn-secondary au-at2-cancel" data-sid="' + s2.id + '" style="display:none">Cancel</button>'
               +     '<button class="au-btn au-btn-secondary au-at2-hide" data-sid="' + s2.id + '" data-hidden="' + (s2.hidden ? '1' : '0') + '"'
               +       ' title="' + (s2.hidden ? 'Bring it back into the list' : 'Retire it from the list. Nothing is lost and it can be restored') + '">'
               +       (s2.hidden ? '👁 Restore' : '🗄 Hide') + '</button>'
               +   '</div>'
               + '</div>'
               + '<div class="au-at2-body">'
               +   '<div class="au-at2-group"><div class="au-at2-group-label">Identity</div><div class="au-at2-grid">'
               +     '<div class="au-at2-field"><label>Display name</label>'
               +       '<input class="wms-input au-at2-sf" data-sid="' + s2.id + '" data-col="display_name" type="text" value="' + auAt2Esc(s2.display_name || '') + '" disabled>'
               +       '<div class="au-at2-hint">What this screen and the dashboard call it. Free text</div></div>'
               +     '<div class="au-at2-field au-at2-field-locked"><label>Code <span class="au-at2-lockbadge" title="Read-only">🔒</span></label>'
               +       '<input class="wms-input au-at2-locked" type="text" value="' + auAt2Esc(s2.code) + '" disabled>'
               +       '<div class="au-at2-hint">The identity every trade, signal and book points at. Changing it would orphan history</div></div>'
               +     '<div class="au-at2-field"><label>Enabled</label>'
               +       '<div class="au-at2-pills au-at2-sf" data-sid="' + s2.id + '" data-col="enabled">'
               +         '<span class="wms-pill au-at2-pill' + (s2.enabled ? ' on' : '') + '" data-val="true">enabled</span>'
               +         '<span class="wms-pill au-at2-pill' + (s2.enabled ? '' : ' on') + '" data-val="false">disabled</span>'
               +       '</div>'
               +       '<div class="au-at2-hint">☠️ A disabled strategy is NOT SCANNED — an open position stops being managed, though its stop still rests at the broker</div></div>'
               +   '</div></div>'
               +   auAt2ParamForm(params, s2.id);

            // ☠️ D.8.10 — anything the contract does not know about is SHOWN, not
            // hidden. A key here is either a schema change nobody told the UI
            // about, or a value quietly driving the engine.
            var unknown = auAt2UnknownParamPaths(params);
            if (unknown.length) {
                h += '<div class="au-at2-unknown">⛔ NOT RECOGNISED BY THIS SCREEN — present in the database and left untouched on save: '
                   + unknown.map(function (u) {
                       return '<code>' + auAt2Esc(u.path) + '</code> = ' + auAt2Esc(JSON.stringify(u.value));
                     }).join(' · ')
                   + '</div>';
            }
            h += '<div class="au-at2-msg" id="au-at2-msg-' + s2.id + '"></div></div></div>';
        });
    }
    h += '</div>';

    // ── Books ───────────────────────────────────────────────────────────────
    h += '<div class="au-card">'
       + '<div class="au-at2-cardhead">'
       +   '<h3>Books</h3>'
       +   '<button class="au-btn au-btn-primary" id="au-at2-newbook">＋ New book</button>'
       + '</div>'
       + '<div class="au-sub">A book is one (strategy, mode, trader). <code>exposure_factor</code> changes SIZE, '
       + 'not routing; <code>lot_cap</code> is a hard per-book ceiling and its surplus is NOT redistributed. '
       + '<b>The identity — strategy, mode, trader — is deliberately not editable:</b> changing it would silently '
       + 're-point a book\'s history. Create a new book instead.</div>'
       + '<div class="au-at2-unknown" style="margin:8px 0 0">☠️ <b>ONE CONTRACT, ONE STRATEGY, PER LIVE ACCOUNT.</b> '
       + 'The broker NETS positions — two strategies on the same instrument and the same live account hold ONE '
       + 'position between them. Opposite sides cancel to flat while both still believe they are in, and both '
       + 'resting stops then protect nothing. To A/B parameter sets, use a different account — or run them on '
       + '<b>paper</b>, where nothing nets and side-by-side variants are exactly right.</div>';

    var bookHidden = _auAt2.books.filter(function (x) { return x.hidden; }).length;
    h += auAt2HiddenBar(bookHidden);
    var booksShown = _auAt2.books.filter(function (x) { return _auAt2ShowHidden || !x.hidden; });

    if (!booksShown.length) {
        h += '<div class="au-soon">' + (bookHidden ? 'Every book is hidden — use “Show retired”.'
                                                   : 'No books configured. Use ＋ New book.') + '</div>';
    } else {
        booksShown.forEach(function (b2) {
            var open = !!_auAt2Open['b:' + b2.id];
            h += '<div class="au-at2-strat' + (open ? ' open' : '') + (b2.hidden ? ' retired' : '') + '" data-bid="' + b2.id + '">'
               + '<div class="au-at2-strat-head">'
               +   '<div class="au-at2-title" data-toggle="b:' + b2.id + '">'
               +     '<span class="au-at2-caret">' + (open ? '▾' : '▸') + '</span>'
               +     '<span class="au-at2-name">' + auAt2Esc(b2.display_name || '(unnamed book)') + '</span>'
               +     (b2.hidden ? ' <span class="au-badge idle">retired</span>' : '')
               +     (b2.mode === 'live' ? ' <span class="au-badge error">LIVE</span>'
                                         : ' <span class="au-badge idle">paper</span>')
               +     (b2.enabled ? ' <span class="au-badge success">enabled</span>'
                                 : ' <span class="au-badge idle">disabled</span>')
               +   '</div>'
               +   '<div class="au-at2-strat-actions">'
               +     '<button class="au-btn au-btn-secondary au-at2-bedit" data-bid="' + b2.id + '">✏️ Edit</button>'
               +     '<button class="au-btn au-btn-primary au-at2-bsave" data-bid="' + b2.id + '" style="display:none">Save</button>'
               +     '<button class="au-btn au-btn-secondary au-at2-bcancel" data-bid="' + b2.id + '" style="display:none">Cancel</button>'
               +     '<button class="au-btn au-btn-secondary au-at2-bhide" data-bid="' + b2.id + '" data-hidden="' + (b2.hidden ? '1' : '0') + '"'
               +       ' title="' + (b2.hidden ? 'Bring it back into the list' : 'Retire it from the list. Nothing is lost and it can be restored') + '">'
               +       (b2.hidden ? '👁 Restore' : '🗄 Hide') + '</button>'
               +   '</div>'
               + '</div>'
               + '<div class="au-at2-body">'
               +   '<div class="au-at2-group"><div class="au-at2-group-label">Identity</div><div class="au-at2-grid">'
               +     '<div class="au-at2-field"><label>Display name</label>'
               +       '<input class="wms-input au-at2-bf" data-bid="' + b2.id + '" data-col="display_name" type="text" value="' + auAt2Esc(b2.display_name || '') + '" disabled>'
               +       '<div class="au-at2-hint">Free text. This is what the trade tables and alerts call the book</div></div>'
               +     '<div class="au-at2-field au-at2-field-locked"><label>Strategy · mode · trader <span class="au-at2-lockbadge" title="Read-only">🔒</span></label>'
               +       '<input class="wms-input au-at2-locked" type="text" value="' + auAt2Esc(auAt2StrategyName(b2.strategy_id) + ' · ' + b2.mode) + '" disabled>'
               +       '<div class="au-at2-hint">The book\'s identity. Re-pointing it would silently move its history — make a new book</div></div>'
               +     '<div class="au-at2-field"><label>Enabled</label>'
               +       '<div class="au-at2-pills au-at2-bf" data-bid="' + b2.id + '" data-col="enabled">'
               +         '<span class="wms-pill au-at2-pill' + (b2.enabled ? ' on' : '') + '" data-val="true">enabled</span>'
               +         '<span class="wms-pill au-at2-pill' + (b2.enabled ? '' : ' on') + '" data-val="false">disabled</span>'
               +       '</div>'
               +       '<div class="au-at2-hint">A disabled book is skipped silently — the switch working as intended</div></div>'
               +   '</div></div>'
               +   '<div class="au-at2-group"><div class="au-at2-group-label">Sizing</div><div class="au-at2-grid">'
               +     '<div class="au-at2-field"><label>Exposure factor</label>'
               +       '<input class="wms-input wms-input-number au-at2-bf" data-bid="' + b2.id + '" data-col="exposure_factor" type="number" step="any" value="' + auAt2Esc(b2.exposure_factor) + '" disabled>'
               +       '<div class="au-at2-hint">The scaling dial, read by sizing every run. 0.5 = half size. Small enough and the book rounds to zero lots and is excluded</div></div>'
               +     '<div class="au-at2-field"><label>Lot cap</label>'
               +       '<input class="wms-input wms-input-number au-at2-bf" data-bid="' + b2.id + '" data-col="lot_cap" type="number" step="1" value="' + auAt2Esc(b2.lot_cap) + '" disabled>'
               +       '<div class="au-at2-hint">Hard ceiling per signal. Surplus is NOT redistributed to other books</div></div>'
               +   '</div></div>'
               +   '<div class="au-at2-group"><div class="au-at2-group-label">Booking</div><div class="au-at2-grid">'
               +     '<div class="au-at2-field"><label>Tags</label>'
               +       '<input class="wms-input au-at2-bf" data-bid="' + b2.id + '" data-col="transaction_tags" type="text" value="' + auAt2Esc((b2.transaction_tags || []).join(', ')) + '" disabled>'
               +       '<div class="au-at2-hint">Comma-separated. Stamped on this book\'s transaction rows</div></div>'
               +   '</div></div>'
               + '<div class="au-at2-msg" id="au-at2-bmsg-' + b2.id + '"></div></div></div>';
        });
    }
    h += '</div>';
    el.innerHTML = h;
    auAt2WireControls();
}

/**
 * HIDE / UNHIDE a retired strategy or book.
 *
 * ☠️ THIS IS THE ALTERNATIVE TO DELETE, and it is deliberate (owner, 06-Aug-2026:
 * *"delete is not a good idea … But we need a hide button for disabled
 * strategies / books and a provision to unhide too."*). Deleting a strategy
 * would orphan every signal, trade, order and alert that points at it; a book
 * that has traded is an accounting record. Hiding loses NOTHING — every history
 * view still resolves through `book_id` / `strategy_id` — and it reverses in one
 * click. Delete stays a back-end operation against
 * `automation/AT2-DELETE-CHECKLIST.md`.
 *
 * ⚠️ ONLY A DISABLED ROW MAY BE HIDDEN, and the database enforces it
 * (`at2_*_hidden_implies_disabled`, migration 70). The check below is the
 * courteous version of the same rule — it explains, where the constraint would
 * only refuse. **Both are needed:** the UI one can be bypassed, the DB one is
 * the guarantee. If the screen could omit a row that still trades, the list you
 * read would not be the list that runs.
 */
async function auAt2SetHidden(table, id, hidden, btn) {
    var isStrat = table === 'at2_strategy';
    var row = (isStrat ? _auAt2.strategies : _auAt2.books)
                .filter(function (x) { return x.id === id; })[0];
    var msg = document.getElementById((isStrat ? 'au-at2-msg-' : 'au-at2-bmsg-') + id);
    if (!row) return;

    if (hidden && row.enabled) {
        if (msg) msg.innerHTML = '<span class="au-at2-err">✕ <b>Disable it first.</b> Hiding something that can still '
            + 'trade would leave the screen showing a shorter list than the one that actually runs — and the row you '
            + 'cannot see is the row you will not check. The database refuses this too.</span>';
        return;
    }

    if (btn) btn.disabled = true;
    if (msg) msg.innerHTML = '<span class="au-meta">' + (hidden ? 'Hiding…' : 'Restoring…') + '</span>';
    try {
        var r = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?id=eq.' + encodeURIComponent(id), {
            method: 'PATCH',
            headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
            body: JSON.stringify({ hidden: hidden })
        });
        var body = await r.text();
        if (!r.ok) {
            if (msg) msg.innerHTML = '<span class="au-at2-err">✕ REFUSED by the database — nothing changed:<br>'
                                   + auAt2Esc(body.slice(0, 500)) + '</span>';
            if (btn) btn.disabled = false;
            return;
        }
        var saved = JSON.parse(body)[0];
        if (saved) Object.keys(saved).forEach(function (k) { row[k] = saved[k]; });
        // Reveal the list when something is hidden, so the row does not simply
        // vanish under the cursor with no explanation.
        if (hidden) _auAt2ShowHidden = true;
        auAt2RenderControls();
        if (typeof showAlert === 'function') {
            showAlert(hidden ? 'Hidden — it keeps all its history and can be restored' : 'Restored to the list', 'success');
        }
    } catch (e) {
        if (msg) msg.innerHTML = '<span class="au-at2-err">✕ ' + auAt2Esc(String(e).slice(0, 300)) + '</span>';
        if (btn) btn.disabled = false;
    }
}

/** The "N hidden · show/hide" strip. Rendered even at zero? No — only when there is something to say. */
function auAt2HiddenBar(n) {
    if (!n) return '';
    return '<div class="au-at2-hiddenbar">'
         + '<span>' + n + ' hidden</span>'
         + '<button class="au-btn au-btn-secondary au-at2-toggle-hidden">'
         +   (_auAt2ShowHidden ? 'Hide retired' : 'Show retired') + '</button>'
         + '</div>';
}

/** Strategy display name for a book row, falling back to the code, then the id. */
function auAt2StrategyName(sid) {
    var s = _auAt2.strategies.filter(function (x) { return x.id === sid; })[0];
    return s ? (s.display_name || s.code) : ('(strategy ' + String(sid || '').slice(0, 8) + '…)');
}

/**
 * ⚠️ addEventListener, never inline onclick — this markup arrives via innerHTML,
 * where inline handlers are unreliable (CONTEXT.md §367). Re-wired on every
 * render because automation.js re-executes on module switches (D.13.14).
 */
function auAt2WireControls() {
    var root = document.getElementById('au-at2-controls-content');
    if (!root) return;

    // ── Collapse / expand. The open set lives in _auAt2Open so a save, a cancel
    //    or a background refresh does not slam every card shut under the owner.
    root.querySelectorAll('.au-at2-title').forEach(function (t) {
        t.addEventListener('click', function () {
            var key = t.dataset.toggle;
            var card = t.closest('.au-at2-strat');
            // ⚠️ Never collapse a card that is being EDITED — it would hide
            // half-typed values that are still there and would still save.
            if (card && card.dataset.editing === 'yes') return;
            _auAt2Open[key] = !_auAt2Open[key];
            if (card) card.classList.toggle('open', !!_auAt2Open[key]);
            var caret = t.querySelector('.au-at2-caret');
            if (caret) caret.textContent = _auAt2Open[key] ? '▾' : '▸';
        });
    });

    // Pill toggles — one value per group, and never on a read-only group.
    root.querySelectorAll('.au-at2-pills').forEach(function (g) {
        g.querySelectorAll('.au-at2-pill').forEach(function (p) {
            p.addEventListener('click', function () {
                if (g.dataset.locked !== 'no') return;              // read-only unless editing
                if (g.dataset.readonly === 'yes') return;
                g.querySelectorAll('.au-at2-pill').forEach(function (q) { q.classList.remove('on'); });
                p.classList.add('on');
            });
        });
    });

    // ── ₹ separators, re-applied when the field loses focus. Typing "75000"
    //    and tabbing away shows "75,000"; the save path strips them again.
    root.querySelectorAll('input[data-money="yes"]').forEach(function (i) {
        i.addEventListener('focus', function () { i.value = auAt2Unmoney(i.value); });
        i.addEventListener('blur', function () {
            var raw = auAt2Unmoney(i.value);
            if (raw === '') { i.value = ''; return; }
            var n = Number(raw);
            i.value = isFinite(n) ? auAt2Money(n) : raw;   // a non-number stays visible so the DB can refuse it
        });
    });

    function setMode(scope, editing) {
        scope.dataset.editing = editing ? 'yes' : 'no';
        // ☠️ A LOCKED FIELD STAYS LOCKED IN EDIT MODE. Without this test, Edit
        // would enable timeframe_minutes and the code field along with
        // everything else — which is exactly the bug being fixed.
        scope.querySelectorAll('input').forEach(function (i) {
            i.disabled = !editing || i.dataset.readonly === 'yes' || i.classList.contains('au-at2-locked');
        });
        scope.querySelectorAll('.au-at2-pills').forEach(function (g) {
            g.dataset.locked = (editing && g.dataset.readonly !== 'yes') ? 'no' : 'yes';
        });
        // Hide/Restore is hidden while editing — it re-renders the card, which
        // would throw away whatever is half-typed.
        scope.querySelectorAll('.au-at2-edit,.au-at2-bedit,.au-at2-hide,.au-at2-bhide')
             .forEach(function (b) { b.style.display = editing ? 'none' : ''; });
        scope.querySelectorAll('.au-at2-save,.au-at2-cancel,.au-at2-bsave,.au-at2-bcancel')
             .forEach(function (b) { b.style.display = editing ? '' : 'none'; });
    }
    root.querySelectorAll('.au-at2-strat').forEach(function (card) { setMode(card, false); });

    root.querySelectorAll('.au-at2-edit,.au-at2-bedit').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var card = btn.closest('.au-at2-strat');
            // Editing a collapsed card would hide the form it just unlocked.
            var t = card.querySelector('.au-at2-title');
            if (t && !card.classList.contains('open')) t.click();
            setMode(card, true);
            var first = card.querySelector('.au-at2-body input:not([disabled])');
            if (first) first.focus();
        });
    });
    root.querySelectorAll('.au-at2-cancel,.au-at2-bcancel').forEach(function (btn) {
        // Cancel re-renders from the cache — never from the edited DOM, so a
        // half-typed value cannot survive as if it had been saved.
        btn.addEventListener('click', function () { auAt2RenderControls(); });
    });
    root.querySelectorAll('.au-at2-save').forEach(function (btn) {
        btn.addEventListener('click', function () { auAt2SaveStrategy(btn.dataset.sid, btn); });
    });
    root.querySelectorAll('.au-at2-bsave').forEach(function (btn) {
        btn.addEventListener('click', function () { auAt2SaveBook(btn.dataset.bid, btn); });
    });

    root.querySelectorAll('.au-at2-toggle-hidden').forEach(function (b) {
        b.addEventListener('click', function () { _auAt2ShowHidden = !_auAt2ShowHidden; auAt2RenderControls(); });
    });
    root.querySelectorAll('.au-at2-hide').forEach(function (b) {
        b.addEventListener('click', function () {
            auAt2SetHidden('at2_strategy', b.dataset.sid, b.dataset.hidden !== '1', b);
        });
    });
    root.querySelectorAll('.au-at2-bhide').forEach(function (b) {
        b.addEventListener('click', function () {
            auAt2SetHidden('at2_book', b.dataset.bid, b.dataset.hidden !== '1', b);
        });
    });

    var ns = document.getElementById('au-at2-newstrat');
    if (ns) ns.addEventListener('click', function () { auAt2NewStrategyModal(); });
    var nb = document.getElementById('au-at2-newbook');
    if (nb) nb.addEventListener('click', function () { auAt2NewBookModal(); });
}

/** Read one field back out of the DOM, typed. Blank = the key is REMOVED. */
function auAt2ReadField(card, f) {
    if (f.kind === 'enum') {
        var on = card.querySelector('[data-path="' + f.path + '"] .au-at2-pill.on');
        return on ? on.dataset.val : undefined;
    }
    var i = card.querySelector('input[data-path="' + f.path + '"]');
    if (!i) return undefined;
    // ☠️ A MONEY FIELD MUST BE UN-FORMATTED BEFORE IT IS READ. "75,000" parses
    // as NaN, and NaN would have been sent as the string "75,000" — refused by
    // the DB, but only after a confusing round trip.
    var raw = (f.money ? auAt2Unmoney(i.value) : (i.value || '')).trim();
    if (raw === '') return undefined;                      // absent, not zero
    if (f.kind === 'text' || f.kind === 'hhmm') return raw;
    var n = Number(raw);
    return isFinite(n) ? n : raw;    // a non-number is sent as text so the DB refuses it LOUDLY
}

async function auAt2SaveStrategy(sid, btn) {
    var card = btn.closest('.au-at2-strat');
    var msg  = document.getElementById('au-at2-msg-' + sid);
    var row  = _auAt2.strategies.filter(function (x) { return x.id === sid; })[0];
    if (!row) return;

    // Start from what the DATABASE holds, so keys this screen does not know
    // about survive untouched (the ⛔ block above tells the owner they exist).
    var params = JSON.parse(JSON.stringify(row.params || {}));
    // ⚠️ A READ-ONLY FIELD IS NEVER WRITTEN BACK. Its input is disabled, so
    // reading it would return the rendered value and re-save it — harmless
    // today, but it would silently resurrect a value the DB had changed
    // underneath us. Skipping is the honest behaviour.
    AU_AT2_PARAM_FIELDS.forEach(function (f) {
        if (f.readonly) return;
        auAt2Bury(params, f.path, auAt2ReadField(card, f));
    });

    // The identity block — display name and the enabled switch — are COLUMNS,
    // not params, so they ride along in the same PATCH.
    var patch = { params: params };
    var dn = card.querySelector('input.au-at2-sf[data-col="display_name"]');
    if (dn) {
        var nm = (dn.value || '').trim();
        if (!nm) {
            if (msg) msg.innerHTML = '<span class="au-at2-err">✕ Display name cannot be blank — it is what every other screen calls this strategy.</span>';
            return;
        }
        patch.display_name = nm;
    }
    var ep = card.querySelector('.au-at2-pills.au-at2-sf[data-col="enabled"] .au-at2-pill.on');
    if (ep) patch.enabled = ep.dataset.val === 'true';

    btn.disabled = true;
    if (msg) msg.innerHTML = '<span class="au-meta">Saving…</span>';
    try {
        var r = await fetch(SUPABASE_URL + '/rest/v1/at2_strategy?id=eq.' + encodeURIComponent(sid), {
            method: 'PATCH',
            headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
            body: JSON.stringify(patch)
        });
        var body = await r.text();
        if (!r.ok) {
            // ☠️ VERBATIM. The database's refusal is the most useful sentence on
            // this screen — it names the rule that was broken. Paraphrasing it
            // would hide exactly what the owner is trying to find out.
            if (msg) msg.innerHTML = '<span class="au-at2-err">✕ REFUSED by the database — nothing was saved:<br>'
                                   + auAt2Esc(body.slice(0, 500)) + '</span>';
            btn.disabled = false;
            return;
        }
        var saved = JSON.parse(body)[0];
        // cache = what the DB actually STORED, not what was sent. If a trigger
        // normalised a value, this screen shows the normalised one.
        if (saved) Object.keys(saved).forEach(function (k) { row[k] = saved[k]; });
        _auAt2Open['s:' + sid] = true;                      // keep it open to SEE the result
        auAt2RenderControls();
        var m2 = document.getElementById('au-at2-msg-' + sid);
        if (m2) m2.innerHTML = '<span class="au-at2-ok">✓ Saved — the values above are re-read from the database</span>';
        if (typeof showAlert === 'function') showAlert('Strategy parameters saved', 'success');
    } catch (e) {
        if (msg) msg.innerHTML = '<span class="au-at2-err">✕ ' + auAt2Esc(String(e).slice(0, 300)) + '</span>';
    } finally {
        btn.disabled = false;                               // D.1.7 — always re-enabled
    }
}

async function auAt2SaveBook(bid, btn) {
    var card = btn.closest('.au-at2-strat');
    var msg  = document.getElementById('au-at2-bmsg-' + bid);
    var row  = _auAt2.books.filter(function (x) { return x.id === bid; })[0];
    if (!row) return;

    var patch = {};
    var blank = null;
    card.querySelectorAll('input.au-at2-bf').forEach(function (i) {
        var col = i.dataset.col, raw = (i.value || '').trim();
        if (col === 'transaction_tags') {
            patch[col] = raw ? raw.split(',').map(function (t) { return t.trim(); }).filter(Boolean) : [];
        } else if (col === 'display_name') {
            // ☠️ TEXT. The old loop ran Number() over EVERY non-tag input, so a
            // display name would have been saved as NaN the moment one existed.
            if (!raw) { blank = 'Display name cannot be blank — it is what the trade tables and alerts call this book.'; return; }
            patch[col] = raw;
        } else {
            patch[col] = raw === '' ? null : Number(raw);
        }
    });
    if (blank) {
        if (msg) msg.innerHTML = '<span class="au-at2-err">✕ ' + auAt2Esc(blank) + '</span>';
        return;
    }
    var pill = card.querySelector('.au-at2-pills[data-col="enabled"] .au-at2-pill.on');
    if (pill) patch.enabled = pill.dataset.val === 'true';

    btn.disabled = true;
    if (msg) msg.innerHTML = '<span class="au-meta">Saving…</span>';
    try {
        var r = await fetch(SUPABASE_URL + '/rest/v1/at2_book?id=eq.' + encodeURIComponent(bid), {
            method: 'PATCH',
            headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
            body: JSON.stringify(patch)
        });
        var body = await r.text();
        if (!r.ok) {
            if (msg) msg.innerHTML = '<span class="au-at2-err">✕ REFUSED by the database — nothing was saved:<br>'
                                   + auAt2Esc(body.slice(0, 500)) + '</span>';
            btn.disabled = false;
            return;
        }
        var saved = JSON.parse(body)[0];
        if (saved) Object.keys(saved).forEach(function (k) { row[k] = saved[k]; });
        _auAt2Open['b:' + bid] = true;
        auAt2RenderControls();
        var bm2 = document.getElementById('au-at2-bmsg-' + bid);
        if (bm2) bm2.innerHTML = '<span class="au-at2-ok">✓ Saved — the values above are re-read from the database</span>';
        if (typeof showAlert === 'function') showAlert('Book saved', 'success');
    } catch (e) {
        if (msg) msg.innerHTML = '<span class="au-at2-err">✕ ' + auAt2Esc(String(e).slice(0, 300)) + '</span>';
    } finally {
        btn.disabled = false;
    }
}

// ============================================================================
// CREATE — a new strategy, a new book
// ============================================================================
//
// ☠️ THESE WRITE CONFIG TABLES, NOT STATE. `at2_strategy` and `at2_book` are
// owner-editable by design (migration 60; register D28). Every at2_ STATE table
// stays function-only, and nothing here goes near the order queue.
//
// ⚠️ Both forms POST and show the database's refusal VERBATIM. They do not
// re-implement the family's JSON-Schema — two validators drift, and the DB's is
// the one that actually decides.

/** A generic modal shell. Closes four ways (D.1.2). */
function auAt2Modal(id, title, bodyHtml, okLabel, onOk) {
    var old = document.getElementById(id);
    if (old) old.remove();
    var ov = document.createElement('div');
    ov.id = id;
    ov.className = 'wms-modal-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.40);z-index:1100;'
                     + 'display:flex;align-items:center;justify-content:center';
    ov.innerHTML =
        '<div class="wms-modal-dialog" style="background:#fff;border-radius:10px;max-width:720px;width:94%;'
      + 'max-height:88vh;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,0.15)">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;'
      + 'border-bottom:1px solid #e2e8f0">'
      + '<h3 style="margin:0;font-size:14px">' + auAt2Esc(title) + '</h3>'
      + '<button class="btn-close-modal" id="' + id + '-x" '
      + 'style="width:28px;height:28px;background:#f7fafc;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer">✕</button>'
      + '</div>'
      + '<div style="padding:16px;overflow-y:auto" id="' + id + '-body">' + bodyHtml + '</div>'
      + '<div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #e2e8f0">'
      + '<button class="au-btn au-btn-secondary" id="' + id + '-cancel">Cancel</button>'
      + '<button class="au-btn au-btn-primary" id="' + id + '-ok">' + auAt2Esc(okLabel) + '</button>'
      + '</div></div>';
    function close() { ov.remove(); document.removeEventListener('keydown', esc); }
    function esc(e) { if (e.key === 'Escape') close(); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.addEventListener('keydown', esc);
    document.body.appendChild(ov);
    document.getElementById(id + '-x').addEventListener('click', close);
    document.getElementById(id + '-cancel').addEventListener('click', close);
    document.getElementById(id + '-ok').addEventListener('click', function () {
        onOk(document.getElementById(id + '-ok'), document.getElementById(id + '-body'), close);
    });
    var f = ov.querySelector('input,select');
    if (f) f.focus();
    return ov;
}

/**
 * A blank strategy, with EVERY parameter the edit form shows.
 *
 * Defaults are copied from an existing strategy of the same family where one
 * exists — a blank form invites a params_schema refusal on the first save, and
 * the fastest way to a valid row is to start from one that already validates.
 */
function auAt2NewStrategyModal() {
    if (!_auAt2.families.length) {
        wmsShowError && wmsShowError('No strategy family is loaded — refresh the tab first.');
        return;
    }
    var fam = _auAt2.families[0];
    var template = _auAt2.strategies.filter(function (x) { return x.family_id === fam.id; })[0];
    var seed = template ? JSON.parse(JSON.stringify(template.params || {})) : {};
    if (seed.timeframe_minutes === undefined) seed.timeframe_minutes = 15;

    var famOpts = _auAt2.families.map(function (f) {
        return '<option value="' + auAt2Esc(f.id) + '">' + auAt2Esc(f.code + ' — ' + (f.name || '')) +
               (f.engine ? ' (' + auAt2Esc(f.engine) + ')' : '') + '</option>';
    }).join('');

    var body =
        '<div class="au-warn-list" style="margin:0 0 12px">The <b>database validates this</b> against the '
      + 'family template, so anything it does not accept comes back here word for word. '
      + (template ? 'Values are pre-filled from <code>' + auAt2Esc(template.code) + '</code> so the first save has a chance of passing.'
                  : '⚠️ No existing strategy to copy from — every value starts blank.')
      + '</div>'
      + '<div class="au-at2-group"><div class="au-at2-group-label">Identity</div><div class="au-at2-grid">'
      +   '<div class="au-at2-field"><label>Family</label>'
      +     '<select class="wms-input" id="au-at2-nf-family">' + famOpts + '</select>'
      +     '<div class="au-at2-hint">Decides the parameter template AND which engine runs it</div></div>'
      +   '<div class="au-at2-field"><label>Code</label>'
      +     '<input class="wms-input" id="au-at2-nf-code" type="text" placeholder="gs_silverm_15m">'
      +     '<div class="au-at2-hint">Permanent identity — lower case, no spaces. It can never be changed</div></div>'
      +   '<div class="au-at2-field"><label>Display name</label>'
      +     '<input class="wms-input" id="au-at2-nf-name" type="text" placeholder="GS Silver Mini 15m">'
      +     '<div class="au-at2-hint">What every screen calls it. Editable later</div></div>'
      +   '<div class="au-at2-field"><label>Version</label>'
      +     '<input class="wms-input" id="au-at2-nf-version" type="text" value="v1">'
      +     '<div class="au-at2-hint">Free text, for your own book-keeping</div></div>'
      + '</div></div>'
      + auAt2ParamForm(seed, 'new')
      + '<div class="au-error-list" style="margin:12px 0 0"><b>It is created DISABLED</b>, always. '
      + 'Nothing can trade until you enable it deliberately.</div>'
      + '<div id="au-at2-nf-msg" style="margin-top:10px"></div>';

    auAt2Modal('auAt2NewStratOverlay', 'New strategy', body, 'Create strategy', async function (btn, root, close) {
        var msg = document.getElementById('au-at2-nf-msg');
        var code = (document.getElementById('au-at2-nf-code').value || '').trim();
        var name = (document.getElementById('au-at2-nf-name').value || '').trim();
        var ver  = (document.getElementById('au-at2-nf-version').value || '').trim() || 'v1';
        var fid  = document.getElementById('au-at2-nf-family').value;
        if (!code || !name) {
            msg.innerHTML = '<span class="au-at2-err">✕ Code and display name are both required.</span>';
            return;
        }
        if (!/^[a-z0-9_]+$/.test(code)) {
            msg.innerHTML = '<span class="au-at2-err">✕ Code must be lower-case letters, digits and underscores only — it is an identity, not a label.</span>';
            return;
        }
        if (_auAt2.strategies.some(function (x) { return x.code === code; })) {
            msg.innerHTML = '<span class="au-at2-err">✕ A strategy with the code <code>' + auAt2Esc(code) + '</code> already exists.</span>';
            return;
        }
        var params = {};
        AU_AT2_PARAM_FIELDS.forEach(function (f) {
            // The locked field still has to be SENT on create — the row needs a
            // value — but it is taken from the seed, never from the input.
            var v = f.readonly ? auAt2Dig(seed, f.path) : auAt2ReadField(root, f);
            auAt2Bury(params, f.path, v);
        });

        btn.disabled = true;
        msg.innerHTML = '<span class="au-meta">Creating…</span>';
        try {
            var r = await fetch(SUPABASE_URL + '/rest/v1/at2_strategy', {
                method: 'POST',
                headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
                body: JSON.stringify({
                    family_id: fid, code: code, display_name: name,
                    version: ver, params: params, enabled: false
                })
            });
            var txt = await r.text();
            if (!r.ok) {
                msg.innerHTML = '<span class="au-at2-err">✕ REFUSED by the database — nothing was created:<br>'
                              + auAt2Esc(txt.slice(0, 600)) + '</span>';
                btn.disabled = false;
                return;
            }
            var row = JSON.parse(txt)[0];
            if (row) { _auAt2.strategies.push(row); _auAt2Open['s:' + row.id] = true; }
            close();
            auAt2RenderControls();
            if (typeof showAlert === 'function') showAlert('Strategy created — disabled, as designed', 'success');
        } catch (e) {
            msg.innerHTML = '<span class="au-at2-err">✕ ' + auAt2Esc(String(e).slice(0, 300)) + '</span>';
            btn.disabled = false;
        }
    });
}

/** A new book on an existing strategy. */
function auAt2NewBookModal() {
    if (!_auAt2.strategies.length) {
        wmsShowError && wmsShowError('Create a strategy first — a book belongs to one.');
        return;
    }
    var stratOpts = _auAt2.strategies.map(function (s) {
        return '<option value="' + auAt2Esc(s.id) + '">' + auAt2Esc((s.display_name || s.code) + '  [' + s.code + ']') + '</option>';
    }).join('');
    // ☠️ Only REAL accounts. DB-05 (at2_book_real_account) refuses a pair with
    // no investor_broker_accounts row, so a free-form investor/broker picker
    // would manufacture refusals.
    // Sorted by name. Thirty accounts arriving in insertion order is a list you
    // scan, not a list you choose from.
    var acctOpts = _auAt2.accounts.map(function (a) {
        return {
            v: a.investor_id + '|' + a.broker_id,
            t: ((a.investors && a.investors.name) || a.investor_id) + ' · '
             + ((a.brokers && a.brokers.name) || a.broker_id)
        };
    }).sort(function (x, y) { return x.t.localeCompare(y.t); })
      .map(function (o) { return '<option value="' + auAt2Esc(o.v) + '">' + auAt2Esc(o.t) + '</option>'; })
      .join('');

    // Unique traders, sorted, deduped on the ID — the earlier version deduped
    // rendered HTML strings, which happens to work and breaks the moment the
    // markup changes.
    var seenTrader = {};
    var traderOpts = _auAt2.accounts.map(function (a) {
        return { id: a.investor_id, name: (a.investors && a.investors.name) || a.investor_id };
    }).filter(function (t) {
        if (seenTrader[t.id]) return false;
        seenTrader[t.id] = 1; return true;
    }).sort(function (x, y) { return x.name.localeCompare(y.name); })
      .map(function (t) { return '<option value="' + auAt2Esc(t.id) + '">' + auAt2Esc(t.name) + '</option>'; })
      .join('');

    var body =
        '<div class="au-warn-list" style="margin:0 0 12px">A book is one <b>(strategy, mode, trader)</b> — that '
      + 'combination is unique and can never be edited afterwards, because re-pointing it would silently move the '
      + 'book\'s history. Accounts listed are only those that actually exist.</div>'
      + '<div class="au-at2-group"><div class="au-at2-group-label">Identity — permanent</div><div class="au-at2-grid">'
      +   '<div class="au-at2-field"><label>Strategy</label>'
      +     '<select class="wms-input" id="au-at2-nb-strategy">' + stratOpts + '</select>'
      +     '<div class="au-at2-hint">The book sizes off this strategy\'s risk settings</div></div>'
      +   '<div class="au-at2-field"><label>Mode</label>'
      +     '<div class="au-at2-pills" id="au-at2-nb-mode" data-locked="no">'
      +       '<span class="wms-pill au-at2-pill on" data-val="paper">paper</span>'
      +       '<span class="wms-pill au-at2-pill" data-val="live">live</span>'
      +     '</div>'
      +     '<div class="au-at2-hint">☠️ <b>live</b> means real orders. <code>at2_enqueue_entry</code> still RAISES on live until the cutover, so a live book cannot trade yet</div></div>'
      +   '<div class="au-at2-field"><label>Account (investor · broker)</label>'
      +     '<select class="wms-input" id="au-at2-nb-account">' + acctOpts + '</select>'
      +     '<div class="au-at2-hint">Where the order is placed and whose rate card prices the charges</div></div>'
      +   '<div class="au-at2-field"><label>Beneficiary (trader)</label>'
      +     '<select class="wms-input" id="au-at2-nb-trader"><option value="">— same as the account holder —</option>'
      +       traderOpts
      +     '</select>'
      +     '<div class="au-at2-hint">Who the trade belongs to. One order can serve several traders — that is the multi-trader split</div></div>'
      + '</div></div>'
      + '<div class="au-at2-group"><div class="au-at2-group-label">Identity — editable</div><div class="au-at2-grid">'
      +   '<div class="au-at2-field"><label>Display name</label>'
      +     '<input class="wms-input" id="au-at2-nb-name" type="text" placeholder="Veins · FYERS · paper">'
      +     '<div class="au-at2-hint">Leave blank and one is built from the account and mode</div></div>'
      + '</div></div>'
      + '<div class="au-at2-group"><div class="au-at2-group-label">Sizing</div><div class="au-at2-grid">'
      +   '<div class="au-at2-field"><label>Exposure factor</label>'
      +     '<input class="wms-input wms-input-number" id="au-at2-nb-exposure" type="number" step="any" value="1.0">'
      +     '<div class="au-at2-hint">1.0 = full size. Must be greater than zero</div></div>'
      +   '<div class="au-at2-field"><label>Lot cap</label>'
      +     '<input class="wms-input wms-input-number" id="au-at2-nb-lotcap" type="number" step="1" value="1">'
      +     '<div class="au-at2-hint">Hard ceiling per signal. Must be greater than zero</div></div>'
      +   '<div class="au-at2-field"><label>Tags</label>'
      +     '<input class="wms-input" id="au-at2-nb-tags" type="text" value="at2">'
      +     '<div class="au-at2-hint">Comma-separated, stamped on this book\'s transaction rows</div></div>'
      + '</div></div>'
      + '<div class="au-error-list" style="margin:12px 0 0"><b>It is created DISABLED</b>, always.</div>'
      + '<div id="au-at2-nb-msg" style="margin-top:10px"></div>';

    var ov = auAt2Modal('auAt2NewBookOverlay', 'New book', body, 'Create book', async function (btn, root, close) {
        var msg = document.getElementById('au-at2-nb-msg');
        var sid = document.getElementById('au-at2-nb-strategy').value;
        var acct = (document.getElementById('au-at2-nb-account').value || '').split('|');
        var modeEl = document.querySelector('#au-at2-nb-mode .au-at2-pill.on');
        var mode = modeEl ? modeEl.dataset.val : 'paper';
        var trader = document.getElementById('au-at2-nb-trader').value || acct[0];
        var expo = Number(document.getElementById('au-at2-nb-exposure').value);
        var cap  = Number(document.getElementById('au-at2-nb-lotcap').value);
        var tags = (document.getElementById('au-at2-nb-tags').value || '').split(',')
                     .map(function (t) { return t.trim(); }).filter(Boolean);
        var name = (document.getElementById('au-at2-nb-name').value || '').trim();

        if (!acct[0] || !acct[1]) { msg.innerHTML = '<span class="au-at2-err">✕ Pick an account.</span>'; return; }
        if (!(expo > 0)) { msg.innerHTML = '<span class="au-at2-err">✕ Exposure factor must be greater than zero — the database refuses 0 or less.</span>'; return; }
        if (!(cap > 0))  { msg.innerHTML = '<span class="au-at2-err">✕ Lot cap must be greater than zero.</span>'; return; }
        // Caught here rather than as a raw unique-violation, because "duplicate
        // key value violates ..._unique" does not tell you WHICH book already exists.
        var clash = _auAt2.books.filter(function (b) {
            return b.strategy_id === sid && b.mode === mode && b.trader_id === trader; })[0];
        if (clash) {
            msg.innerHTML = '<span class="au-at2-err">✕ That combination already exists — <b>'
                          + auAt2Esc(clash.display_name || '(unnamed)') + '</b>. One book per (strategy, mode, trader).</span>';
            return;
        }
        // ☠️ D31 — ONE CONTRACT, ONE STRATEGY, PER LIVE ACCOUNT.
        //
        // A broker account is NETTED. Two strategies on the same instrument and
        // the same live account do not hold two positions at Fyers — they hold
        // ONE, and neither of them owns it. Opposite sides cancel to flat while
        // both still believe they are in, and both resting stops then protect
        // nothing. RC-14 detects it after the fact; this catches it at the
        // moment it would be created, which is the only cheap moment.
        //
        // ⚠️ PAPER IS EXEMPT and must stay that way — running variants side by
        // side on paper is the RIGHT way to compare parameter sets.
        if (mode === 'live') {
            var myStrat = _auAt2.strategies.filter(function (x) { return x.id === sid; })[0];
            var myInst = myStrat && myStrat.params && myStrat.params.instrument_key;
            var rival = null;
            if (myInst) {
                _auAt2.books.forEach(function (b) {
                    if (rival || b.mode !== 'live') return;
                    if (b.investor_id !== acct[0] || b.broker_id !== acct[1]) return;
                    if (b.strategy_id === sid) return;                  // same strategy = fine
                    var os = _auAt2.strategies.filter(function (x) { return x.id === b.strategy_id; })[0];
                    if (os && os.params && os.params.instrument_key === myInst) rival = os;
                });
            }
            if (rival) {
                msg.innerHTML = '<span class="au-at2-err">✕ <b>REFUSED — one contract, one strategy, per live account.</b><br>'
                    + '<b>' + auAt2Esc(rival.display_name || rival.code) + '</b> already trades '
                    + '<code>' + auAt2Esc(myInst) + '</code> live on this account.<br><br>'
                    + 'The broker NETS positions: two strategies on one contract hold ONE position between them. '
                    + 'Opposite sides cancel to flat while both still believe they are in — and both resting stops '
                    + 'then protect nothing.<br><br>'
                    + 'Use a <b>different account</b> for the variant, or run it on <b>paper</b>, where nothing nets.</span>';
                return;
            }
        }

        if (!name) {
            var a = _auAt2.accounts.filter(function (x) { return x.investor_id === acct[0] && x.broker_id === acct[1]; })[0];
            name = ((a && a.investors && a.investors.name) || 'Account') + ' · '
                 + ((a && a.brokers && a.brokers.name) || '') + ' · ' + mode;
        }

        btn.disabled = true;
        msg.innerHTML = '<span class="au-meta">Creating…</span>';
        try {
            var r = await fetch(SUPABASE_URL + '/rest/v1/at2_book', {
                method: 'POST',
                headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
                body: JSON.stringify({
                    strategy_id: sid, mode: mode, investor_id: acct[0], broker_id: acct[1],
                    trader_id: trader, display_name: name, exposure_factor: expo,
                    lot_cap: cap, transaction_tags: tags, enabled: false
                })
            });
            var txt = await r.text();
            if (!r.ok) {
                msg.innerHTML = '<span class="au-at2-err">✕ REFUSED by the database — nothing was created:<br>'
                              + auAt2Esc(txt.slice(0, 600)) + '</span>';
                btn.disabled = false;
                return;
            }
            var row = JSON.parse(txt)[0];
            if (row) { _auAt2.books.push(row); _auAt2Open['b:' + row.id] = true; }
            close();
            auAt2RenderControls();
            if (typeof showAlert === 'function') showAlert('Book created — disabled, as designed', 'success');
        } catch (e) {
            msg.innerHTML = '<span class="au-at2-err">✕ ' + auAt2Esc(String(e).slice(0, 300)) + '</span>';
            btn.disabled = false;
        }
    });

    // The mode pills need their own handler — this markup is outside the
    // controls root that auAt2WireControls walks.
    ov.querySelectorAll('#au-at2-nb-mode .au-at2-pill').forEach(function (p) {
        p.addEventListener('click', function () {
            ov.querySelectorAll('#au-at2-nb-mode .au-at2-pill').forEach(function (q) { q.classList.remove('on'); });
            p.classList.add('on');
        });
    });
}

// ── Manual close (EX-09) ────────────────────────────────────────────────────
//
// ☠️ THIS IS NOT A SECOND WAY TO CLOSE A POSITION. It calls the at2-ms007 EF's
// `manual_close` action, which runs cancel → exit → re-place through the SAME
// write functions an engine exit uses. The browser never touches the order
// queue and never calls the at2_* RPCs directly — a second implementation is
// how two paths drift apart, and the manual one is used under pressure.
//
// Owner decision 04-Aug-2026: a REASON ONLY. No typed lot-count confirmation
// and no password gate, for live or paper. Do not add one back.
// The reason is mandatory — at2_trade_event_manual_has_reason refuses a MANUAL
// event without it, so the UI asks rather than letting the database refuse.

var _auAt2CloseTradeId = null;

function autoAt2OpenCloseModal(tradeId) {
    var t = _auAt2.trades.filter(function (x) { return x.id === tradeId; })[0];
    if (!t) { wmsShowError && wmsShowError('Trade not found — refresh the page.'); return; }
    _auAt2CloseTradeId = tradeId;

    var existing = document.getElementById('auAt2CloseOverlay');
    if (existing) existing.remove();

    var isLive = t.mode === 'live';
    var ov = document.createElement('div');
    ov.id = 'auAt2CloseOverlay';
    ov.className = 'wms-modal-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.40);z-index:1100;'
                     + 'display:flex;align-items:center;justify-content:center';
    ov.innerHTML =
        '<div class="wms-modal-dialog" style="background:#fff;border-radius:10px;max-width:560px;width:92%;'
      + 'max-height:85vh;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,0.15)">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;'
      + 'border-bottom:1px solid #e2e8f0">'
      + '<h3 style="margin:0;font-size:14px">Close position by hand</h3>'
      + '<button class="btn-close-modal" onclick="autoAt2CloseModal()" '
      + 'style="width:28px;height:28px;background:#f7fafc;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer">✕</button>'
      + '</div>'
      + '<div style="padding:16px;overflow-y:auto">'
      + (isLive
          ? '<div class="au-error-list" style="margin:0 0 12px"><strong>⚠️ This is a LIVE position.</strong> '
          + 'Closing it places real orders at the broker: the resting stop is cancelled, the exit is sent, and '
          + 'the stop is re-placed for whatever remains.</div>'
          : '<div class="au-warn-list" style="margin:0 0 12px"><strong>PAPER position.</strong> '
          + 'No broker order is placed; the close is simulated through the same write functions.</div>')
      + '<table style="width:100%;font-size:12px;margin-bottom:12px" class="au-at2-kv">'
      + '<tr><td>Book</td><td><strong>' + auAt2BookName(t.book_id) + '</strong></td></tr>'
      + '<tr><td>Side / lots</td><td><strong>' + auAt2Esc(t.side) + ' ' + auAt2Esc(t.qty_lots) + '</strong></td></tr>'
      + '<tr><td>Entry</td><td>' + auAt2Num(t.entry_price) + '</td></tr>'
      + '<tr><td>Resting stop</td><td>' + (t.current_stop ? auAt2Num(t.current_stop)
            : '<span class="au-badge error">none — position is UNPROTECTED</span>') + '</td></tr>'
      + '<tr><td>State</td><td>' + auAt2StatusBadge(t.status) + '</td></tr>'
      + '</table>'
      + '<label style="display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:4px">'
      + 'Reason <span style="color:#dc2626">*</span></label>'
      + '<textarea id="auAt2CloseReason" rows="3" placeholder="Why are you closing this by hand?" '
      + 'style="width:100%;padding:8px;border:1.5px solid #cbd5e0;border-radius:6px;font-size:13px;'
      + 'font-family:inherit;box-sizing:border-box"></textarea>'
      + '<div style="font-size:11px;color:#6b7280;margin-top:4px">Recorded on the trade event. The database '
      + 'refuses a manual event without one — this is the audit trail for a hand-made change.</div>'
      + '<div id="auAt2CloseResult" style="margin-top:12px"></div>'
      + '</div>'
      + '<div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #e2e8f0">'
      + '<button class="au-btn au-btn-secondary" onclick="autoAt2CloseModal()">Cancel</button>'
      + '<button class="au-btn au-btn-danger" id="auAt2CloseGo" onclick="autoAt2ConfirmClose()">Close position</button>'
      + '</div></div>';

    // D.1.2 — every modal closes four ways.
    ov.addEventListener('click', function (e) { if (e.target === ov) autoAt2CloseModal(); });
    document.addEventListener('keydown', auAt2EscClose);
    document.body.appendChild(ov);
    var ta = document.getElementById('auAt2CloseReason');
    if (ta) ta.focus();
}

function auAt2EscClose(e) { if (e.key === 'Escape') autoAt2CloseModal(); }

function autoAt2CloseModal() {
    var ov = document.getElementById('auAt2CloseOverlay');
    if (ov) ov.remove();
    document.removeEventListener('keydown', auAt2EscClose);
    _auAt2CloseTradeId = null;
}

async function autoAt2ConfirmClose() {
    var reason = (document.getElementById('auAt2CloseReason') || {}).value || '';
    var out = document.getElementById('auAt2CloseResult');
    var btn = document.getElementById('auAt2CloseGo');
    if (!reason.trim()) {
        if (out) out.innerHTML = '<div class="au-error-list">A reason is required.</div>';
        return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Closing…'; }
    if (out) out.innerHTML = '<div class="au-meta">Calling at2-ms007 → manual_close…</div>';

    try {
        var r = await fetch(SUPABASE_URL + '/functions/v1/at2-ms007', {
            method: 'POST',
            headers: wmsEdgeHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ action: 'manual_close', trade_id: _auAt2CloseTradeId, reason: reason.trim() })
        });
        var j = await r.json().catch(function () { return { error: 'response was not JSON' }; });

        if (r.ok && j.ok) {
            if (out) out.innerHTML = '<div class="au-warn-list" style="background:#ecfdf5;border-color:#a7f3d0;color:#065f46">'
                + '<strong>✅ Closed.</strong><ul>' + (j.steps || []).map(function (s) {
                    return '<li>' + auAt2Esc(s) + '</li>'; }).join('') + '</ul></div>';
            setTimeout(function () { autoAt2CloseModal(); autoAt2Refresh(); }, 1400);
        } else {
            // A refusal is INFORMATION, not a failure to hide. The engine and
            // the database both refuse for stated reasons — show them verbatim.
            if (out) out.innerHTML = '<div class="au-error-list"><strong>Refused — nothing was changed.</strong>'
                + '<div style="margin-top:6px">' + auAt2Esc(j.refusal || j.error || ('HTTP ' + r.status)) + '</div>'
                + ((j.steps && j.steps.length) ? '<ul>' + j.steps.map(function (s) {
                    return '<li>' + auAt2Esc(s) + '</li>'; }).join('') + '</ul>' : '')
                + '</div>';
        }
    } catch (e) {
        if (out) out.innerHTML = '<div class="au-error-list"><strong>Call failed.</strong><div>'
            + auAt2Esc(e.message) + '</div><div style="margin-top:6px">The position state is UNKNOWN from here — '
            + 'refresh and check before retrying.</div></div>';
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Close position'; }
}
