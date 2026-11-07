// =============================================================================
// broker-order-modal.js — the Broker Order modal (app-wide, desktop).
//
// Places orders straight with the broker on the CHOSEN investor › broker account
// (Broker Order Modal Plan v6, phase 3). Opened from the ribbon's broker-order icon,
// next to the Add Transaction icon (both share the old Trade button's space).
//
//   New order tab   account cards (login status, never a token) → rows (Trader ·
//                   Symbol · Lots · Qty · Price · Tags, like Add Trade) → a live
//                   panel that recalculates as you type: the broker orders after
//                   grouping (with each trader's split), the broker balance and the
//                   estimated margin, the estimated charges → Place → order password
//                   (Enter sends, Esc / Cancel goes back with every row kept).
//   Today's orders  the modal's orders today: broker status, fills, each trader's line.
//
// The server (wms-broker-order) checks everything again and does the placing and the
// booking. This file does NO writes of its own except through that server function.
// Numbers use the app's shared formatters and charge engine; the "=" calculator works
// in every number box (app-wide). Phone: not shown yet (phase 6).
//
// Created 07-Nov-2026.
// =============================================================================

(function () {
  'use strict';

  var BOM = {
    accounts: [],            // login-status rows (Fyers + MOSL) with investor + broker ids
    acct: null,              // the chosen account row
    traders: [],             // investors with an account at the chosen broker
    rows: [],                // modal rows
    seq: 1,
    funds: null,             // { at, available, lines[] } | { error }
    fundsBusy: false,
    tab: 'new',
    pollTimer: null,
    tagCtrls: {},
    ddCtrls: {},
    ddItems: {},
    ltp: {},                 // symbol → last price (for market rows)
  };
  window.BOM_STATE = BOM;   // for testing / inspection only

  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var num = function (v) { var n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
  var rupees = function (v) { return (v == null || isNaN(v) || v === 0) ? '-' : '₹' + Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
  var price2 = function (v) { return typeof formatPrice === 'function' ? formatPrice(v) : String(v); };
  var amt = function (v) { return typeof formatAmount === 'function' ? formatAmount(v) : String(v); };
  var qtyFmt = function (v) { return typeof formatQuantity === 'function' ? formatQuantity(v) : String(v); };
  var unitDesc = function () { return typeof getUnitDescription === 'function' ? getUnitDescription() : '₹'; };
  var invName = function (id) { var i = (wmsRefData.investorObjMap || {})[id]; return i ? (i.short_name || i.name) : '?'; };
  var brkCode = function (id) { var b = (wmsRefData.brokerObjMap || {})[id]; return b ? (b.broker_code || b.name || '') : ''; };
  var fmtQ = function (q) { return q ? (q < 0 ? '-' : '') + qtyFmt(Math.abs(q)) : ''; };
  var isOption = function (sym) { return /(CE|PE)$/.test(String(sym || '')); };

  // ---------------------------------------------------------------------------
  // Styles (scoped to .bom-*)
  // ---------------------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById('bom-styles')) return;
    var s = document.createElement('style');
    s.id = 'bom-styles';
    s.textContent = [
      '.bom-ov{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:3000;display:none;align-items:flex-start;justify-content:center;padding:4vh 16px;overflow:auto}',
      '.bom-ov.show{display:flex}',
      '.bom-m{background:#fff;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.25);width:min(1080px,100%);min-width:740px;font-size:13px;color:#1a202c;display:flex;flex-direction:column}',
      '.bom-h{display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-bottom:1px solid #e2e8f0}',
      '.bom-h h3{margin:0;font-size:16px;display:flex;gap:10px;align-items:center}',
      '.bom-live{font-size:10.5px;font-weight:700;letter-spacing:.08em;color:#b91c1c;background:#fee2e2;border:1px solid #fecaca;padding:2px 8px;border-radius:999px}',
      '.bom-x{background:none;border:0;font-size:20px;color:#718096;cursor:pointer}',
      '.bom-tabs{display:flex;gap:4px;padding:8px 18px 0}',
      '.bom-tab{border:1px solid #e2e8f0;border-bottom:0;background:#f7fafc;padding:6px 14px;border-radius:8px 8px 0 0;cursor:pointer;font:inherit;color:#4a5568}',
      '.bom-tab.on{background:#fff;color:#1a202c;font-weight:600}',
      '.bom-b{padding:12px 18px;border-top:1px solid #e2e8f0}',
      '.bom-lbl{font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#718096;margin:2px 0 6px}',
      '.bom-lbl-row{display:flex;justify-content:space-between;align-items:baseline;gap:8px}',
      '.bom-at{text-transform:none;letter-spacing:0;font-weight:400;color:#a0aec0;font-size:10.5px;white-space:nowrap}',
      '.bom-rf{text-decoration:none;color:#2c7a7b;font-size:12px;margin-left:4px}',
      '.bom-kv.sub span:first-child{padding-left:10px;color:#4a5568}',
      '.bom-c3{display:grid;grid-template-columns:1fr 84px 84px;column-gap:16px;padding:2px 0;font-size:12.5px}',
      '.bom-c3 span:nth-child(n+2){text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.bom-c3.hd{margin:2px 0 4px}',
      '.bom-c3.hd span{font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#718096}',
      '.bom-c3.tot{border-top:1px solid #e2e8f0;margin-top:4px;padding-top:5px;font-weight:700}',
      '.bom-c3.sp{margin-top:6px}',
      '.bom-c3.sub span:first-child{padding-left:10px;color:#4a5568}',
      '.bom-accs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}',
      '.bom-acc{min-width:170px;padding:7px 12px;border-radius:8px;border:1.5px solid #cbd5e0;background:#fff;cursor:pointer;text-align:left;font:inherit}',
      '.bom-acc b{display:block;font-size:13.5px}',
      '.bom-acc i{font-style:normal;font-size:11.5px;color:#4a5568}',
      '.bom-acc.on{border-color:#2c7a7b;background:#e6f4f4;box-shadow:0 0 0 1px #2c7a7b inset}',
      '.bom-acc.off{opacity:.6;border-style:dashed;cursor:not-allowed}',
      '.bom-t{width:100%;border-collapse:collapse;min-width:0}',
      '.bom-t th{font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#718096;text-align:left;padding:4px;border-bottom:1px solid #e2e8f0}',
      '.bom-t td{padding:4px;border-bottom:1px solid #edf2f7;vertical-align:top}',
      '.bom-t input,.bom-t select{width:100%;box-sizing:border-box;padding:5px 7px;border:1px solid #cbd5e0;border-radius:6px;font:inherit;background:#fff}',
      '.bom-t input.r{text-align:right;font-variant-numeric:tabular-nums}',
      '.bom-t input:disabled{background:#f7fafc;color:#a0aec0}',
      '.bom-sub{font-size:10.5px;color:#718096;margin-top:2px;white-space:nowrap}',
      '.bom-sym{position:relative}',
      '.bom-sym .wms-dd{min-width:380px;font-size:12px}',
      '.bom-sym .wms-dd .sub{font-size:10px;color:#a0aec0;margin-left:6px}',
      '.bom-sym .wms-dd .wms-dd-item.nfo{color:#667eea}',
      '.bom-del{background:none;border:0;cursor:pointer;color:#a0aec0;font-size:15px}',
      '.bom-add{margin:8px 0 2px;background:none;border:0;color:#2c7a7b;font-weight:600;cursor:pointer;font:inherit;padding:0}',
      '.bom-panel{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;padding:12px 18px;border-top:1px solid #e2e8f0;background:#f7fafc}',
      '.bom-box{background:#fff;border:1px solid #e2e8f0;border-radius:9px;padding:9px 11px;min-width:0}',
      '.bom-kv{display:flex;justify-content:space-between;gap:8px;padding:2px 0;font-size:12.5px}',
      '.bom-kv span:last-child{font-variant-numeric:tabular-nums;text-align:right}',
      '.bom-kv.tot{border-top:1px solid #e2e8f0;margin-top:4px;padding-top:5px;font-weight:700}',
      '.bom-ord{border-bottom:1px dashed #e2e8f0;padding:4px 0}',
      '.bom-ord:last-child{border-bottom:0}',
      '.bom-ord b{font-variant-numeric:tabular-nums}',
      '.bom-split{font-size:11.5px;color:#4a5568;padding-left:10px}',
      '.bom-warn{color:#b45309;font-weight:600}',
      '.bom-ok{color:#047857;font-weight:600}',
      '.bom-err{color:#b91c1c}',
      '.bom-f{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 18px;border-top:1px solid #e2e8f0}',
      '.bom-note{font-size:11.5px;color:#718096}',
      '.bom-btn{font:inherit;font-weight:600;border-radius:7px;padding:8px 16px;border:1px solid #cbd5e0;background:#fff;cursor:pointer}',
      '.bom-btn.go{background:#b91c1c;border-color:#b91c1c;color:#fff}',
      '.bom-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.bom-pw{display:none;gap:10px;align-items:center;padding:10px 18px;border-top:1px solid #fecaca;background:#fef2f2;color:#991b1b;font-size:12.5px}',
      '.bom-pw.show{display:flex}',
      '.bom-pw input{width:200px;padding:6px 8px;border:1px solid #fca5a5;border-radius:6px;font:inherit}',
      '.bom-today .bom-ord{padding:8px 0}',
      '.bom-st{display:inline-block;font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid #cbd5e0;color:#4a5568}',
      '.bom-st.done{color:#047857;border-color:#6ee7b7;background:#ecfdf5}',
      '.bom-st.bad{color:#b91c1c;border-color:#fecaca;background:#fef2f2}',
      '.bom-st.wip{color:#1d4ed8;border-color:#bfdbfe;background:#eff6ff}',
      '#trBrokerOrderBtn img{height:16px;width:16px;vertical-align:middle;object-fit:contain}',
      // Broker-order button: its own colour, so it is never mistaken for ✎ Record a trade (brand purple).
      '.trading-header-bar #trBrokerOrderBtn{background:#0f766e}',
      '.trading-header-bar #trBrokerOrderBtn:hover{background:#115e59}',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------------------
  function ensureShell() {
    if (document.getElementById('bomOverlay')) return;
    injectStyles();
    var ov = document.createElement('div');
    ov.className = 'bom-ov';
    ov.id = 'bomOverlay';
    ov.innerHTML =
      '<div class="bom-m" role="dialog" aria-label="Broker order">' +
        '<div class="bom-h"><h3>Broker order <span class="bom-live">LIVE</span></h3>' +
          '<button class="bom-x" id="bomClose" title="Close (Esc)">×</button></div>' +
        '<div class="bom-tabs"><button class="bom-tab on" data-tab="new">New order</button><button class="bom-tab" data-tab="today">Today\'s orders</button></div>' +
        '<div id="bomNew" style="display:flex;flex-direction:column;min-height:0;flex:1">' +
          '<div class="bom-b" style="flex:1">' +
            '<div class="bom-lbl">Account</div><div class="bom-accs" id="bomAccs"></div>' +
            '<table class="bom-t"><thead><tr>' +
              '<th style="width:110px">Trader</th><th>Symbol</th><th style="width:70px">Lots</th><th style="width:90px">Qty</th>' +
              '<th style="width:110px">Price <span style="text-transform:none;letter-spacing:0">(0 = market)</span></th><th style="width:170px">Tags</th><th style="width:24px"></th>' +
            '</tr></thead><tbody id="bomRows"></tbody></table>' +
            '<button class="bom-add" id="bomAddRow">+ Add row</button>' +
          '</div>' +
          '<div class="bom-panel">' +
            '<div class="bom-box"><div class="bom-lbl">Goes to the broker</div><div id="bomOrders"></div></div>' +
            '<div class="bom-box"><div class="bom-lbl bom-lbl-row"><span>Balance &amp; margin <span id="bomUnit" style="text-transform:none;letter-spacing:0"></span>' +
              '<a href="#" class="bom-rf" id="bomRefresh" title="Read the balance and the prices again">↻</a></span><span class="bom-at" id="bomFundsAt"></span></div><div id="bomMargin"></div></div>' +
            '<div class="bom-box"><div id="bomCharges"></div></div>' +
          '</div>' +
          '<div class="bom-pw" id="bomPw">Order password: <input type="password" id="bomPwInput" autocomplete="off">' +
            '<button class="bom-btn go" id="bomSend">Send to broker</button><button class="bom-btn" id="bomPwCancel">Cancel</button>' +
            '<span class="bom-note" style="color:#991b1b">Enter sends · Esc goes back (nothing sent)</span></div>' +
          '<div class="bom-f"><span class="bom-note" id="bomFootNote">Market and limit, day orders. The broker makes the final margin check.</span>' +
            '<div style="display:flex;gap:8px"><button class="bom-btn" id="bomClear" title="Remove all rows and start again">Clear</button><button class="bom-btn" id="bomCancel">Close</button><button class="bom-btn go" id="bomPlace" disabled>Place</button></div></div>' +
        '</div>' +
        '<div id="bomToday" class="bom-b bom-today" style="display:none;flex:1"></div>' +
      '</div>';
    document.body.appendChild(ov);

    // Clicking outside does NOT close the modal (owner, 07-Nov) — only × / Close / Esc.
    document.getElementById('bomClose').addEventListener('click', bomClose);
    document.getElementById('bomCancel').addEventListener('click', bomClose);
    document.getElementById('bomAddRow').addEventListener('click', function () { var id = addRow(BOM.rows[BOM.rows.length - 1]); focusTrader(id); });
    document.getElementById('bomClear').addEventListener('click', clearRows);
    document.getElementById('bomRefresh').addEventListener('click', function (e) { e.preventDefault(); refreshAll(); });
    document.getElementById('bomPlace').addEventListener('click', openPassword);
    document.getElementById('bomSend').addEventListener('click', send);
    document.getElementById('bomPwCancel').addEventListener('click', closePassword);
    document.getElementById('bomPwInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePassword(); }
    });
    ov.querySelectorAll('.bom-tab').forEach(function (b) { b.addEventListener('click', function () { setTab(b.dataset.tab); }); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !ov.classList.contains('show')) return;
      if (e.defaultPrevented) return;   // Esc already used (e.g. leaving an "=" calculation) — keep the modal open
      if (document.getElementById('bomPw').classList.contains('show')) { closePassword(); return; }
      if (document.querySelector('#bomOverlay .wms-dd.show, #bomOverlay .wms-tag-dd.show')) return;  // let the dropdown close first
      bomClose();
    });
  }

  // ---------------------------------------------------------------------------
  // Open / close
  // ---------------------------------------------------------------------------
  async function bomOpen() {
    ensureShell();
    if (window.wmsRefData && !wmsRefData.ready && typeof wmsLoadRefData === 'function') await wmsLoadRefData();
    document.getElementById('bomOverlay').classList.add('show');
    document.getElementById('bomUnit').textContent = '(' + unitDesc() + ')';
    setTab('new');
    await loadAccounts();
    if (!BOM.rows.length) addRow();
    renderPanel();
    var first = BOM.rows[0];
    if (first) focusRow(first.id);
  }
  function bomClose() {
    var ov = document.getElementById('bomOverlay');
    if (ov) ov.classList.remove('show');
    closePassword();
    stopPoll();
  }
  window.bomOpen = bomOpen;
  window.bomClose = bomClose;

  function setTab(t) {
    BOM.tab = t;
    document.querySelectorAll('#bomOverlay .bom-tab').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === t); });
    document.getElementById('bomNew').style.display = t === 'new' ? 'flex' : 'none';
    document.getElementById('bomToday').style.display = t === 'today' ? 'block' : 'none';
    if (t === 'today') loadToday(); else stopPoll();
  }

  // ---------------------------------------------------------------------------
  // Accounts (login status — never a token)
  // ---------------------------------------------------------------------------
  async function loadAccounts() {
    var box = document.getElementById('bomAccs');
    var rows = typeof wmsReadLoginStatus === 'function' ? await wmsReadLoginStatus() : null;
    if (!rows) { box.innerHTML = '<span class="bom-err">Could not read the account logins — reload the app.</span>'; BOM.accounts = []; return; }
    BOM.accounts = rows.filter(function (r) { return r.investor_id && r.broker_id && (r.broker_code === 'FYERS' || r.broker_code === 'MOSL'); });
    var keep = BOM.acct && BOM.accounts.find(function (r) { return r.investor_id === BOM.acct.investor_id && r.broker_id === BOM.acct.broker_id; });
    var pick = keep || BOM.accounts.find(function (r) { return canPlace(r); }) || null;
    renderAccounts();
    if (pick) selectAccount(pick.investor_id, pick.broker_id, !!keep);
    else { BOM.acct = null; renderPanel(); }
  }
  function canPlace(r) { return r && r.broker_code === 'FYERS' && r.logged_in_today === true; }
  function renderAccounts() {
    var box = document.getElementById('bomAccs');
    if (!BOM.accounts.length) { box.innerHTML = '<span class="bom-note">No broker account with a login is set up.</span>'; return; }
    box.innerHTML = BOM.accounts.map(function (r) {
      var on = BOM.acct && r.investor_id === BOM.acct.investor_id && r.broker_id === BOM.acct.broker_id;
      var state = r.broker_code !== 'FYERS'
        ? (r.logged_in_today ? '● Logged in · ' : '○ ') + r.broker_code + ' orders come later'
        : (r.logged_in_today ? '● Live' : '○ Offline · not logged in today');
      var brk = r.broker_code === 'FYERS' ? 'Fyers' : r.broker_code;
      return '<button type="button" class="bom-acc' + (on ? ' on' : '') + (canPlace(r) ? '' : ' off') + '"' +
        (canPlace(r) ? ' data-inv="' + r.investor_id + '" data-brk="' + r.broker_id + '"' : ' disabled') + '>' +
        '<b>' + esc((r.investor_short || r.account) + ' › ' + brk) + '</b><i>' + esc(state) + '</i></button>';
    }).join('');
    box.querySelectorAll('.bom-acc[data-inv]').forEach(function (b) {
      b.addEventListener('click', function () { selectAccount(b.dataset.inv, b.dataset.brk); });
    });
  }
  function selectAccount(investorId, brokerId, keepRows) {
    var r = BOM.accounts.find(function (a) { return a.investor_id === investorId && a.broker_id === brokerId; });
    if (!canPlace(r)) return;
    var changed = !BOM.acct || BOM.acct.investor_id !== investorId || BOM.acct.broker_id !== brokerId;
    BOM.acct = r;
    // Traders = investors with an account at THIS broker (Plan decision 7; the server checks again).
    BOM.traders = Object.keys(wmsRefData.ibaRatesMap || {}).map(function (k) { return k.split('|'); })
      .filter(function (p) { return p[1] === brokerId; })
      .map(function (p) { return { id: p[0], name: invName(p[0]) }; })
      .sort(function (a, b) { return a.id === investorId ? -1 : b.id === investorId ? 1 : a.name.localeCompare(b.name); });
    renderAccounts();
    if (changed && !keepRows) {
      BOM.rows.forEach(function (row) { if (!BOM.traders.some(function (t) { return t.id === row.trader_id; })) row.trader_id = investorId; });
      renderRows();
    }
    loadFunds();
    renderPanel();
  }

  async function loadFunds() {
    if (!BOM.acct) return;
    BOM.fundsBusy = true; renderPanel();
    var acct = BOM.acct;
    try {
      var r = await fetch(window.SUPABASE_URL + '/functions/v1/wms-broker-order', {
        method: 'POST', headers: wmsEdgeHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action: 'funds', investor_id: acct.investor_id, broker_id: acct.broker_id }) });
      var j = await r.json().catch(function () { return {}; });
      if (BOM.acct !== acct) return;
      if (!j.ok) { BOM.funds = { error: j.error || ('HTTP ' + r.status) }; }
      else {
        var line = function (re) { var l = (j.funds || []).find(function (x) { return re.test(x.title); }); return l ? (l.equity + l.commodity) : null; };
        BOM.funds = { at: j.as_of, available: line(/^available balance$/i), startLimit: line(/^limit at start of the day$/i),
                      total: line(/^total balance$/i), used: line(/^utilized amount$/i), holdings: j.holdings || [] };
        BOM.funds.liquid = await liquidMargin(acct);
        BOM.funds.fnoUsed = fnoUsedEstimate(acct);
      }
    } catch (e) { BOM.funds = { error: e.message }; }
    BOM.fundsBusy = false; renderPanel();
  }
  // Liquid margin = WMS holding × current price × (1 − haircut %), over the few securities that carry a
  // haircut for THIS broker (Master Data › security › Collateral haircut %). Blank / NULL = not counted.
  // Holdings come from WMS itself (owner, 07-Nov): equity/ETF/SGB from the app's loaded transactions
  // for this investor at this broker; mutual funds from mf_trades (demat at this broker). Price: the
  // app's live price, else the latest NAV (MF) or last traded price. Returns { value, parts[] } or null.
  async function liquidMargin(acct) {
    try {
      var inv = acct.investor_id, brk = acct.broker_id;
      var secs = await fetch(window.SUPABASE_URL + '/rest/v1/securities_db?select=id,symbol,security_type,collateral_haircuts&collateral_haircuts=not.is.null',
        { headers: wmsHeaders() }).then(function (x) { return x.json(); });
      if (!Array.isArray(secs)) return null;
      var list = secs.map(function (sc) {
        var h = sc.collateral_haircuts && sc.collateral_haircuts[brk];
        var n = (h === null || h === undefined || h === '') ? NaN : Number(h);
        return isFinite(n) ? { id: sc.id, symbol: sc.symbol, haircut: n } : null;
      }).filter(Boolean);
      if (!list.length) return null;
      var ids = list.map(function (x) { return x.id; }).join(',');
      var b = (wmsRefData.brokerObjMap || {})[brk] || {};
      var brkNames = [String(b.name || '').toLowerCase(), String(b.broker_code || '').toLowerCase()].filter(Boolean);
      var atBroker = function (d) { d = String(d || '').toLowerCase().trim(); return !!d && brkNames.some(function (n) { return n === d || n.indexOf(d) === 0 || d.indexOf(n) === 0; }); };
      var [mf, navs] = await Promise.all([
        fetch(window.SUPABASE_URL + '/rest/v1/mf_trades?select=security_id,txn_type,units,demat_broker&investor_id=eq.' + inv + '&security_id=in.(' + ids + ')', { headers: wmsHeaders() }).then(function (x) { return x.json(); }).catch(function () { return []; }),
        fetch(window.SUPABASE_URL + '/rest/v1/market_prices?select=security_id,close,price_date&security_type=eq.MF&resolution=eq.1D&security_id=in.(' + ids + ')&order=price_date.desc&limit=50', { headers: wmsHeaders() }).then(function (x) { return x.json(); }).catch(function () { return []; }),
      ]);
      var txns = typeof trTransactions !== 'undefined' ? trTransactions : [];
      var total = 0, parts = [];
      list.forEach(function (sc) {
        var mine = txns.filter(function (t) { return !t.dont_display && t.investor_id === inv && t.broker_id === brk &&
          (t.security_id === sc.id || String(t.short_symbol || t.symbol || '').replace(/^[A-Z]+:/, '').replace(/-EQ$/, '') === sc.symbol); });
        var qty = 0, px = 0, src = '';
        if (mine.length) {
          qty = wmsCalcAvgCost(mine).netQuantity;
          var lp = (typeof wmsLivePrices !== 'undefined' && wmsLivePrices[sc.symbol]) ? wmsLivePrices[sc.symbol].lp : 0;
          px = lp > 0 ? lp : Number(mine[mine.length - 1].price) || 0; src = lp > 0 ? 'live' : 'last trade';
        } else {
          (Array.isArray(mf) ? mf : []).forEach(function (m) {
            if (m.security_id !== sc.id || !atBroker(m.demat_broker)) return;
            var tt = String(m.txn_type || '').toUpperCase(), u = Math.abs(Number(m.units) || 0);
            if (tt === 'REDEMPTION') qty -= u; else if (tt !== 'DIV_PAYOUT') qty += u;
          });
          var nv = (Array.isArray(navs) ? navs : []).find(function (x) { return x.security_id === sc.id; });
          px = nv ? Number(nv.close) || 0 : 0; src = nv ? 'NAV ' + nv.price_date : 'no NAV';
        }
        if (!(qty > 0) || !(px > 0)) return;
        var v = qty * px * (1 - sc.haircut / 100);
        total += v;
        parts.push(sc.symbol + ': ' + (Number.isInteger(qty) ? qtyFmt(qty) : qty.toFixed(3)) + ' × ' + price2(px) + ' (' + src + '), less ' + sc.haircut.toFixed(1) + '% haircut');
      });
      return { value: total, parts: parts };
    } catch (e) { console.warn('liquid margin', e); return null; }
  }

  // Utilised in F&O — ESTIMATE for Fyers (owner, 07-Nov): FNO_USED_PCT of the account's open NSE F&O
  // exposure (all traders at this investor › broker). Fyers gives one combined "Utilized Amount" with
  // no segment split; MOSL's segment break-up will replace this with the actual figure (Plan v7 §3).
  // Exposure: futures = |net qty| × price; short options = |net qty| × strike; long options = 0
  // (premium already paid). MCX is left out (never short of MCX margin — owner).
  var FNO_USED_PCT = 30;
  function fnoUsedEstimate(acct) {
    var txns = typeof trTransactions !== 'undefined' ? trTransactions : [];
    var pos = {};
    txns.forEach(function (t) {
      if (t.dont_display || t.investor_id !== acct.investor_id || t.broker_id !== acct.broker_id) return;
      if (String(t.security_type || '').toUpperCase() !== 'NFO') return;
      var sym = String(t.symbol || '');
      if (/^MCX:/.test(sym) || String(t.exchange || '').toUpperCase() === 'MCX') return;
      var k = sym.replace(/^[A-Z]+:/, '');
      var q = Number(t.quantity) || 0;
      var ps = pos[k] || (pos[k] = { qty: 0, last: 0 });
      ps.qty += q; if (Number(t.price) > 0) ps.last = Number(t.price);
    });
    var exposure = 0, parts = [];
    Object.keys(pos).forEach(function (k) {
      var ps = pos[k]; if (!ps.qty) return;
      var opt = /(CE|PE)$/.test(k), v = 0, how = '';
      if (opt) {
        if (ps.qty > 0) return;                                   // long option: no margin
        var sec = (wmsRefData.securitiesNfo || []).find(function (x) { return String(x.symbol || '').replace(/^[A-Z]+:/, '') === k; });
        var strike = sec && Number(sec.strike_price) > 0 ? Number(sec.strike_price) : 0;
        if (!strike) return;
        v = Math.abs(ps.qty) * strike; how = 'strike ' + price2(strike);
      } else {
        var lp = (typeof wmsLivePrices !== 'undefined' && wmsLivePrices[k] && wmsLivePrices[k].lp > 0) ? wmsLivePrices[k].lp : ps.last;
        v = Math.abs(ps.qty) * lp; how = price2(lp);
      }
      exposure += v; parts.push(k + ': ' + qtyFmt(ps.qty) + ' × ' + how);
    });
    return { exposure: exposure, value: exposure * FNO_USED_PCT / 100, parts: parts };
  }

  // ↻ in the Balance & margin heading: read the balance again AND the live prices (both margins move).
  function refreshAll() {
    loadFunds();
    var seen = {};
    BOM.rows.forEach(function (r) { if (r.symbol && !seen[r.symbol]) { seen[r.symbol] = 1; fetchLtp(r.symbol); } });
  }
  window.bomRefreshFunds = refreshAll;

  // ---------------------------------------------------------------------------
  // Rows
  // ---------------------------------------------------------------------------
  // A new row copies the row before it (trader, symbol, lots, qty, price, tags), as Add Trade does.
  function newRow(from) {
    var r = { id: BOM.seq++, trader_id: BOM.acct ? BOM.acct.investor_id : null, symbol: '', display: '', security_id: null,
              security_type: 'EQUITY', asset_class: null, exchange: 'NSE', lot_size: 1, lots: 0, qty: 0, price: 0, tags: [] };
    if (from) {
      ['trader_id', 'symbol', 'display', 'security_id', 'security_type', 'asset_class', 'exchange', 'lot_size', 'lots', 'qty', 'price']
        .forEach(function (k) { r[k] = from[k]; });
      r.tags = from.tags.slice();
    }
    return r;
  }
  function addRow(from) { var r = newRow(from); BOM.rows.push(r); renderRows(); renderPanel(); return r.id; }
  function clearRows() {
    BOM.rows = [newRow()]; renderRows(); renderPanel(); closePassword();
    showMsg('Market and limit, day orders. The broker makes the final margin check.');
    focusRow(BOM.rows[0].id);
  }
  function focusTrader(id) { setTimeout(function () { var el = document.querySelector('.bom-tr[data-rid="' + id + '"]'); if (el) el.focus(); }, 30); }
  function removeRow(id) {
    if (BOM.rows.length <= 1) { BOM.rows = [newRow()]; } else BOM.rows = BOM.rows.filter(function (r) { return r.id !== id; });
    renderRows(); renderPanel();
  }
  function focusRow(id) { setTimeout(function () { var el = document.querySelector('.bom-sym-in[data-rid="' + id + '"]'); if (el) el.focus(); }, 30); }
  function rowById(id) { return BOM.rows.find(function (r) { return r.id === id; }); }

  function renderRows() {
    var tb = document.getElementById('bomRows');
    if (!tb) return;
    tb.innerHTML = BOM.rows.map(function (r) {
      var tOpts = BOM.traders.map(function (t) { return '<option value="' + t.id + '"' + (t.id === r.trader_id ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('');
      var nfo = r.lot_size > 1;
      return '<tr data-row-id="' + r.id + '" data-rid="' + r.id + '">' +
        '<td data-mlabel="Trader"><select class="bom-tr" data-rid="' + r.id + '">' + tOpts + '</select></td>' +
        '<td data-mlabel="Symbol" class="bom-sym"><input type="text" class="bom-sym-in" data-rid="' + r.id + '" placeholder="Search…" autocomplete="off" value="' + esc(r.display || r.symbol) + '">' +
          '<div class="wms-dd" id="bomSymDd_' + r.id + '"></div><div class="bom-sub" id="bomSymSub_' + r.id + '">' + symSub(r) + '</div></td>' +
        '<td data-mlabel="Lots"><input type="text" inputmode="numeric" class="bom-lots r wms-input-number" data-rid="' + r.id + '" value="' + (nfo && r.lots ? r.lots : '') + '"' + (nfo ? '' : ' disabled') + '><div class="bom-sub" id="bomBalL_' + r.id + '"></div></td>' +
        '<td data-mlabel="Qty"><input type="text" class="bom-qty r wms-input-number" data-rid="' + r.id + '" value="' + fmtQ(r.qty) + '"><div class="bom-sub" id="bomBalQ_' + r.id + '"></div></td>' +
        '<td data-mlabel="Price"><input type="text" class="bom-px r wms-input-number" data-rid="' + r.id + '" inputmode="decimal" placeholder="market" value="' + (r.price ? price2(r.price) : '') + '"></td>' +
        '<td data-mlabel="Tags" style="position:relative"><input type="text" class="bom-tag-in" data-rid="' + r.id + '" placeholder="Tags…" autocomplete="off">' +
          '<div class="wms-tag-pills" id="bomTagPills_' + r.id + '"></div><div class="wms-tag-dd" id="bomTagDd_' + r.id + '"></div></td>' +
        '<td><button class="bom-del" data-rid="' + r.id + '" title="Remove row">🗑</button></td></tr>';
    }).join('');
    BOM.rows.forEach(function (r) { wireRow(r); showBalance(r); });
  }

  function symSub(r) {
    if (!r.symbol) return '';
    var bits = [];
    if (r.lot_size > 1) bits.push('lot ' + r.lot_size);
    if (BOM.ltp[r.symbol]) bits.push('LTP ' + price2(BOM.ltp[r.symbol]));
    return esc(bits.join(' · '));
  }

  function wireRow(r) {
    var q = function (cls) { return document.querySelector('.' + cls + '[data-rid="' + r.id + '"]'); };
    var trSel = q('bom-tr'), symIn = q('bom-sym-in'), lotsIn = q('bom-lots'), qtyIn = q('bom-qty'), pxIn = q('bom-px'), tagIn = q('bom-tag-in'), del = q('bom-del');

    trSel.addEventListener('change', function () { r.trader_id = trSel.value; showBalance(r); autoTags(r); renderPanel(); });

    // Symbol search — the app's shared search (same as Add Trade): securities cache + Fyers option lookup.
    var dd = document.getElementById('bomSymDd_' + r.id);
    BOM.ddCtrls[r.id] = wmsDropdown(symIn, dd, {
      onSelect: function (el) { pickResult(r, parseInt(el.dataset.idx, 10)); },
      itemSelector: '.wms-dd-item', closeOnSelect: true, blurDelay: 200, escClearsInput: false });
    var timer = null;
    symIn.addEventListener('input', function () {
      clearTimeout(timer);
      var text = symIn.value.trim();
      if (text.length < 2) { BOM.ddCtrls[r.id].close(); return; }
      timer = setTimeout(function () { search(r, text); }, 250);
    });
    dd.addEventListener('mousedown', function (e) {
      var it = e.target.closest('.wms-dd-item'); if (!it) return;
      e.preventDefault(); pickResult(r, parseInt(it.dataset.idx, 10)); BOM.ddCtrls[r.id].close();
    });

    // Lots ↔ Qty exactly as Add Trade: lots × lot size → qty; qty edit updates lots. Signed: + buy, − sell.
    lotsIn.addEventListener('input', function () {
      r.lots = Math.trunc(num(lotsIn.value));
      if (r.lot_size > 1) { r.qty = r.lots * r.lot_size; qtyIn.value = fmtQ(r.qty); }
      renderPanel();
    });
    qtyIn.addEventListener('focus', function () { qtyIn.value = r.qty ? String(r.qty) : ''; });
    qtyIn.addEventListener('blur', function () { qtyIn.value = fmtQ(r.qty); });
    qtyIn.addEventListener('input', function () {
      r.qty = Math.trunc(num(qtyIn.value));
      if (r.lot_size > 1) { r.lots = r.qty / r.lot_size; lotsIn.value = r.lots ? (Number.isInteger(r.lots) ? r.lots : r.lots.toFixed(2)) : ''; }
      else r.lots = r.qty;
      renderPanel();
    });
    pxIn.addEventListener('input', function () { r.price = Math.max(0, num(pxIn.value)); renderPanel(); });
    pxIn.addEventListener('focus', function () { pxIn.value = r.price ? String(r.price) : ''; });
    pxIn.addEventListener('blur', function () { pxIn.value = r.price ? price2(r.price) : ''; });

    BOM.tagCtrls[r.id] = wmsTagInput(tagIn, document.getElementById('bomTagPills_' + r.id), document.getElementById('bomTagDd_' + r.id),
      { tags: r.tags, existingTags: wmsRefData.tags || [], onChange: function () {} });
    

    // Tab on the last field adds a row (Add Trade behaviour).
    tagIn.addEventListener('keydown', function (e) {
      if (e.key === 'Tab' && !e.shiftKey && BOM.rows[BOM.rows.length - 1] === r) {
        var typed = tagIn.value.trim();
        if (typed && r.tags.indexOf(typed) < 0) { r.tags.push(typed); tagIn.value = ''; }
        e.preventDefault();
        var id = addRow(r); focusTrader(id);
      }
    });
    del.addEventListener('click', function () { removeRow(r.id); });
  }

  async function search(r, text) {
    var dd = document.getElementById('bomSymDd_' + r.id);
    var ctrl = BOM.ddCtrls[r.id];
    var parsed = typeof wmsParseOptionsQuery === 'function' ? wmsParseOptionsQuery(text) : null;
    var items = [];
    try {
      if (parsed) {
        dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px">Searching options…</div>'; ctrl.show();
        var cands = wmsBuildOptionsCandidates(parsed.underlying, parsed.strike, parsed.optionType, parsed.expiryHint);
        var data = cands.length ? await window.fyersCall({ action: 'quotes', symbols: cands }) : null;
        ((data && data.d) || []).forEach(function (it) {
          if (it.v && it.v.lp > 0) items.push({ kind: 'opt', fy: it.v.symbol, lp: it.v.lp,
            label: wmsFormatOptionsDisplay(it.v.symbol, parsed.underlying, parsed.strike, parsed.optionType) });
        });
      } else {
        if (!wmsRefData.securitiesCmReady || !wmsRefData.securitiesNfoReady) {
          dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px">Loading securities…</div>'; ctrl.show();
          if (!wmsRefData.securitiesCmReady) await wmsLoadSecuritiesCm(0, { all: true });
          if (!wmsRefData.securitiesNfoReady) await wmsLoadSecuritiesNfo();
        }
        wmsSearchSecurities(text).forEach(function (s) { items.push({ kind: s._isNfo ? 'nfo' : 'cm', s: s }); });
      }
    } catch (e) { dd.innerHTML = '<div style="padding:8px;color:#b91c1c;font-size:11px">Search failed: ' + esc(e.message) + '</div>'; ctrl.show(); return; }
    BOM.ddItems[r.id] = items;
    dd.innerHTML = items.length ? items.map(function (it, i) {
      if (it.kind === 'opt') return '<div class="wms-dd-item nfo" data-idx="' + i + '">' + esc(it.label) + ' <span class="sub">₹' + it.lp.toFixed(2) + '</span></div>';
      var s = it.s;
      return '<div class="wms-dd-item' + (it.kind === 'nfo' ? ' nfo' : '') + '" data-idx="' + i + '">' + esc(s.symbol) +
        (s.expiry_date ? ' <span class="sub">exp ' + esc(s.expiry_date) + '</span>' : (s.company_name ? '<span class="sub">' + esc(s.company_name) + '</span>' : '')) + '</div>';
    }).join('') : '<div style="padding:8px;color:#a0aec0;font-size:11px">No matches</div>';
    ctrl.show(); ctrl.resetIdx && ctrl.resetIdx();
  }

  function pickResult(r, idx) {
    var it = (BOM.ddItems[r.id] || [])[idx];
    if (!it) return;
    var sec = null;
    if (it.kind === 'opt') {
      sec = (wmsRefData.securitiesNfo || []).find(function (x) { return x.symbol === it.fy; });
      if (!sec) {
        showMsg('“' + it.label + '” is not in the contract list yet — open it once in Add Trade or the Watchlist, then pick it here.', true);
        return;
      }
      BOM.ltp[sec.symbol] = it.lp;
    } else sec = it.s;
    if (it.kind === 'cm') {
      var fy = sec.broker_tokens && sec.broker_tokens.fyers && sec.broker_tokens.fyers.nse_symbol;
      if (!fy) { showMsg(sec.symbol + ' has no NSE trading symbol — it cannot be ordered here.', true); return; }
      Object.assign(r, { symbol: fy, display: sec.nse_symbol || sec.symbol, security_id: sec.id, security_type: sec.security_type || 'EQUITY',
                         asset_class: sec.asset_class || null, exchange: 'NSE', lot_size: 1 });
    } else {
      Object.assign(r, { symbol: sec.symbol, display: sec.symbol, security_id: sec.id, security_type: 'NFO',
                         asset_class: isOption(sec.symbol) ? 'OPTIONS' : 'FUTURES', exchange: sec.exchange || 'NSE', lot_size: sec.lot_size || 1 });
    }
    r.lots = 0; r.qty = 0;
    renderRows(); autoTags(r); fetchLtp(r.symbol);
    setTimeout(function () {
      var el = document.querySelector((r.lot_size > 1 ? '.bom-lots' : '.bom-qty') + '[data-rid="' + r.id + '"]');
      if (el) el.focus();
    }, 30);
    renderPanel();
  }

  async function fetchLtp(sym) {
    if (!sym || !window.fyersCall) return;
    try {
      var d = await window.fyersCall({ action: 'quotes', symbols: [sym] });
      var v = d && d.d && d.d[0] && d.d[0].v;
      if (v && v.lp > 0) { BOM.ltp[sym] = v.lp; BOM.rows.forEach(function (r) { if (r.symbol === sym) { var s = document.getElementById('bomSymSub_' + r.id); if (s) s.innerHTML = symSub(r); } }); renderPanel(); }
    } catch (_) { /* the estimate shows "price needed" */ }
  }

  function autoTags(r) {
    if (!BOM.acct || !r.security_id || r.tags.length) return;
    var txns = typeof trTransactions !== 'undefined' ? trTransactions : [];
    var found = wmsFindMatchingTags(txns, BOM.acct.investor_id, r.trader_id || BOM.acct.investor_id, r.symbol);
    if (found.length) { found.forEach(function (t) { r.tags.push(t); }); var c = BOM.tagCtrls[r.id]; if (c && c.refresh) c.refresh(); }
  }

  // The trader's current holding at this account ("Bal:"), as Add Trade shows it.
  function showBalance(r) {
    var lq = document.getElementById('bomBalQ_' + r.id), ll = document.getElementById('bomBalL_' + r.id);
    if (!lq || !BOM.acct || !r.security_id) { if (lq) lq.textContent = ''; if (ll) ll.textContent = ''; return; }
    var txns = typeof trTransactions !== 'undefined' ? trTransactions : [];
    var bare = function (s) { return String(s || '').replace(/^[A-Z]+:/, '').replace(/-EQ$/, ''); };
    var mine = txns.filter(function (t) {
      return t.investor_id === BOM.acct.investor_id && t.broker_id === BOM.acct.broker_id && (t.trader_id || t.investor_id) === r.trader_id &&
             bare(t.symbol) === bare(r.symbol) && !t.dont_display;
    });
    var bal = mine.length ? wmsCalcAvgCost(mine).netQuantity : 0;
    lq.textContent = bal ? 'Bal: ' + qtyFmt(bal) : '';
    if (ll) ll.textContent = bal && r.lot_size > 1 ? 'Bal: ' + Math.round(bal / r.lot_size) + ' lots' : '';
  }

  // ---------------------------------------------------------------------------
  // The live panel: grouping (Order Aggregation Rules v4), margin, charges
  // ---------------------------------------------------------------------------
  // The grouping shown here follows the same rule the server applies (bo_core.ts planOrders):
  // key = symbol + side + price; one line per trader; MCX in lots, NSE/BSE in units; 0 lots left out.
  function plan() {
    var problems = [], groups = {}, order = [];
    BOM.rows.forEach(function (r, i) {
      if (!r.symbol && !r.qty) return;                          // empty row
      var n = 'Row ' + (i + 1);
      if (!r.symbol) { problems.push(n + ': pick a symbol'); return; }
      if (!r.qty) return;                                       // 0 lots: left out
      var lots = r.lot_size > 1 ? r.qty / r.lot_size : r.qty;
      if (!Number.isInteger(lots)) { problems.push(n + ': qty must be whole lots of ' + r.lot_size); return; }
      if (!r.trader_id) { problems.push(n + ': pick a trader'); return; }
      var side = r.qty < 0 ? 'SELL' : 'BUY';
      var key = [r.symbol, side, r.price > 0 ? 'L@' + r.price : 'MKT'].join('|');
      var g = groups[key];
      if (!g) { g = groups[key] = { key: key, symbol: r.symbol, display: r.display || r.symbol, side: side, price: r.price > 0 ? r.price : 0,
                                    lot_size: r.lot_size, exchange: r.exchange, security_id: r.security_id, security_type: r.security_type,
                                    asset_class: r.asset_class, lots: 0, lines: [] }; order.push(key); }
      var ln = g.lines.find(function (l) { return l.trader_id === r.trader_id; });
      if (ln) ln.lots += Math.abs(lots); else g.lines.push({ trader_id: r.trader_id, lots: Math.abs(lots) });
      g.lots += Math.abs(lots);
    });
    var list = order.sort().map(function (k) { return groups[k]; });
    list.forEach(function (g) {
      g.units = g.lots * g.lot_size;
      g.brokerQty = g.exchange === 'MCX' ? g.lots : g.units;
      g.estPrice = g.price || BOM.ltp[g.symbol] || 0;
    });
    return { orders: list, problems: problems };
  }

  // The account's open position in a symbol (all traders at this investor › broker), signed units.
  function openPosition(sym) {
    var txns = typeof trTransactions !== 'undefined' ? trTransactions : [];
    var bare = function (x) { return String(x || '').replace(/^[A-Z]+:/, '').replace(/-EQ$/, ''); };
    var k = bare(sym), q = 0;
    txns.forEach(function (t) {
      if (t.dont_display || t.investor_id !== BOM.acct.investor_id || t.broker_id !== BOM.acct.broker_id) return;
      if (bare(t.symbol) === k) q += Number(t.quantity) || 0;
    });
    return q;
  }

  // Margin only for the part of an order that OPENS or ADDS to a position (owner, 07-Nov):
  // an order that exits the account's open position (sell against a long, buy against a short)
  // needs no margin for the units it closes; any units beyond it (a flip) are charged as new.
  // Orders in this batch on the same symbol use up the open position in turn.
  function marginNeeded(orders) {
    var left = {}, need = 0, unknown = false, freed = 0;
    orders.forEach(function (g) {
      if (!(g.symbol in left)) left[g.symbol] = openPosition(g.symbol);
      var pos = left[g.symbol], signed = g.side === 'SELL' ? -g.units : g.units;
      var closing = (pos > 0 && signed < 0) || (pos < 0 && signed > 0) ? Math.min(Math.abs(pos), g.units) : 0;
      left[g.symbol] = pos + signed;
      g.closingUnits = closing;
      var m = marginFor(g, g.units - closing);
      if (m == null) unknown = true; else need += m;
      if (closing) freed += closing;
    });
    return { need: need, unknown: unknown };
  }

  function marginFor(g, units) {
    if (!g.estPrice) return null;
    if (units == null) units = g.units;
    var value = units * g.estPrice;
    if (g.security_type !== 'NFO') return value;                                // cash equity: full value
    if (isOption(g.symbol) && g.side === 'BUY') return value;                   // option buy: full premium
    var pct = typeof wmsGetMarginRate === 'function' ? Number(wmsGetMarginRate(BOM.acct.investor_id, BOM.acct.broker_id)) || 0 : 0;
    return value * pct / 100;                                                    // futures, option sell: the account's margin %
  }

  function chargesFor(g) {
    if (!g.estPrice) return null;
    var holder = BOM.acct.investor_id, broker = BOM.acct.broker_id;
    var row = { gross_amount: wmsRoundMoney(g.units * g.estPrice), security_type: g.security_type, asset_class: g.asset_class,
                symbol: g.symbol, exchange: g.exchange, transaction_type: g.side, security_id: g.security_id, trader_id: holder,
                price: g.estPrice, quantity: g.side === 'SELL' ? -g.units : g.units, lots: g.lots };
    wmsAutoCalcCharges(row, { ibaRatesMap: wmsRefData.ibaRatesMap, regCharges: wmsRefData.regCharges, investorId: holder, brokerId: broker, preserveExisting: false });
    return { brokerage: row.brokerage || 0, stt: row.stt || 0, other: row.other_charges || 0, gst: row.gst || 0, total: row.total_charges || 0,
             traders: g.lines.filter(function (l) { return l.trader_id !== holder; }).map(function (l) {
               var u = l.lots * g.lot_size;
               return { id: l.trader_id, amt: wmsCalcTraderCharges({ ibaRatesMap: wmsRefData.ibaRatesMap, investorId: holder, brokerId: broker, traderId: l.trader_id,
                 securityType: g.security_type, assetClass: g.asset_class, securityId: g.security_id, symbol: g.symbol,
                 gross: u * g.estPrice, price: g.estPrice, quantity: g.side === 'SELL' ? -u : u, lots: l.lots }) || 0 }; }) };
  }

  function renderPanel() {
    var ordersEl = document.getElementById('bomOrders');
    if (!ordersEl) return;
    var placeBtn = document.getElementById('bomPlace');
    if (!BOM.acct) {
      ordersEl.innerHTML = '<span class="bom-note">Pick a live account first.</span>';
      document.getElementById('bomMargin').innerHTML = ''; document.getElementById('bomCharges').innerHTML = '';
      placeBtn.disabled = true; placeBtn.textContent = 'Place'; return;
    }
    var p = plan();
    BOM.lastPlan = p;
    var mn = marginNeeded(p.orders), need = mn.need, unknown = mn.unknown;   // also marks exits on each order
    ordersEl.innerHTML = (p.problems.length ? p.problems.map(function (x) { return '<div class="bom-warn">' + esc(x) + '</div>'; }).join('') : '') +
      (p.orders.length ? p.orders.map(function (g) {
        return '<div class="bom-ord"><b>' + g.side + ' ' + qtyFmt(g.brokerQty) + (g.exchange === 'MCX' ? ' lots' : '') + '</b> ' + esc(g.display) +
          ' · ' + (g.price ? 'limit ' + price2(g.price) : 'market') +
          (g.closingUnits ? ' <span class="bom-note" title="Closes part or all of the open position: no margin for these units">(' +
            (g.closingUnits >= g.units ? 'exit' : 'exits ' + qtyFmt(g.closingUnits)) + ')</span>' : '') +
          '<div class="bom-split">' + g.lines.map(function (l) { return esc(invName(l.trader_id)) + ' ' + l.lots + (l.lots === 1 ? ' lot' : ' lots'); }).join(' · ') + '</div></div>';
      }).join('') : (p.problems.length ? '' : '<span class="bom-note">Nothing to send yet.</span>'));

    // Margin
    var f = BOM.funds, mHtml = '';
    var atEl = document.getElementById('bomFundsAt');
    if (atEl) atEl.textContent = BOM.fundsBusy ? 'reading…' : (f && f.at ? (typeof wmsLoginStamp === 'function' ? wmsLoginStamp(f.at) : f.at) : '');
    var kv = function (label, val, cls) { return '<div class="bom-kv' + (cls ? ' ' + cls : '') + '"><span>' + label + '</span><span>' + val + '</span></div>'; };
    if (f && f.error && !BOM.fundsBusy) mHtml += kv('Total available', '<span class="bom-err" title="' + esc(f.error) + '">could not read</span>');
    else {
      var fv = function (v) { return BOM.fundsBusy || !f ? '…' : (v == null ? '-' : amt(v)); };
      mHtml += kv('Limit at start of the day', fv(f && f.startLimit)) +
               kv('Total available', fv(f && f.available)) +
               '';
      if (BOM.fundsBusy || !f) mHtml += kv('Max F&amp;O margin', '…');
      else if (!f.liquid) mHtml += kv('Max F&amp;O margin', '<span class="bom-note" title="Set a haircut % for this broker on the liquid securities (Master Data › security)">not set up</span>');
      else {
        var maxFno = f.liquid.value * 2, used = f.fnoUsed ? f.fnoUsed.value : 0;
        f.fnoAvail = maxFno - used;
        mHtml += kv('<span title="Liquid margin × 2">Max F&amp;O margin</span>',
                   '<span title="' + esc('Liquid margin ' + amt(f.liquid.value).replace(/<[^>]+>/g, '') + ' × 2\n' + (f.liquid.parts.join('\n') || 'none')) + '">' + amt(maxFno) + '</span>') +
                 kv('<span title="Estimate: ' + FNO_USED_PCT + '% of the open NSE F&amp;O exposure in this account (MOSL will give the actual)">− Utilised in F&amp;O (est. ' + FNO_USED_PCT + '%)</span>',
                   '<span title="' + esc('Exposure ' + amt(f.fnoUsed ? f.fnoUsed.exposure : 0).replace(/<[^>]+>/g, '') + ' × ' + FNO_USED_PCT + '%\n' + ((f.fnoUsed && f.fnoUsed.parts.join('\n')) || 'no open NSE F&O')) + '">' + amt(used) + '</span>') +
                 kv('= Total F&amp;O margin available', amt(f.fnoAvail), 'tot');
      }
    }
    mHtml += '<div class="bom-kv"><span>Margin needed (estimate)</span><span>' + (unknown ? '<span class="bom-warn">price needed</span>' : amt(need)) + '</span></div>';
    // Check: against Total F&O margin available (owner, 07-Nov), not Total available.
    if (f && !f.error && f.liquid && f.fnoAvail != null && !unknown && p.orders.length) {
      mHtml += need > f.fnoAvail
        ? '<div class="bom-kv"><span>Check</span><span class="bom-warn">more than F&amp;O available</span></div>'
        : '<div class="bom-kv"><span>Check</span><span class="bom-ok">within F&amp;O available</span></div>';
    }
    document.getElementById('bomMargin').innerHTML = mHtml;

    // Charges — split Self (the account holder's own lines) | Traders, by units, exactly as booking
    // splits an order across its lines (bo_core splitMoney: each charge shared by units).
    var keys = ['brokerage', 'stt', 'other', 'total'];        // other = exchange · SEBI · stamp + GST
    var cs = {}, ct = {}, trd = {}, cUnknown = false, anyTrader = false;
    keys.forEach(function (k) { cs[k] = 0; ct[k] = 0; });
    p.orders.forEach(function (g) {
      var x = chargesFor(g); if (!x) { cUnknown = true; return; }
      x.other = x.other + x.gst;
      var selfU = 0; g.lines.forEach(function (l) { if (l.trader_id === BOM.acct.investor_id) selfU += l.lots * g.lot_size; });
      if (selfU < g.units) anyTrader = true;
      keys.forEach(function (k) { var sh = Math.round(x[k] * selfU / g.units * 100) / 100; cs[k] += sh; ct[k] += x[k] - sh; });
      x.traders.forEach(function (t) { trd[t.id] = (trd[t.id] || 0) + t.amt; });
    });
    // Plain amounts (2 decimals, no ₹ — the heading says ₹)
    var n2 = function (v) { return (v == null || isNaN(v) || Math.abs(v) < 0.005) ? '-' : Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
    var cv = function (v) { return cUnknown ? '<span class="bom-warn">?</span>' : n2(v); };
    var row3 = function (label, a, b, cls) { return '<div class="bom-c3' + (cls ? ' ' + cls : '') + '"><span>' + label + '</span><span>' + a + '</span><span>' + b + '</span></div>'; };
    var anyMcx = p.orders.some(function (g) { return g.exchange === 'MCX'; });
    var lbl = { brokerage: 'Brokerage', stt: anyMcx ? 'STT / CTT' : 'STT', other: '<span title="Exchange, SEBI, stamp duty and GST">Other charges</span>', total: 'Total' };
    document.getElementById('bomCharges').innerHTML =
      row3('Charges (est., ₹)', 'Self', 'Traders', 'hd') +
      (p.orders.length
        ? keys.map(function (k) { return row3(lbl[k], cv(cs[k]), anyTrader ? cv(ct[k]) : '-', k === 'total' ? 'tot' : ''); }).join('') +
          Object.keys(trd).map(function (id) { return row3(esc(invName(id)) + ' charges', '', cv(trd[id])); }).join('') +
          (cUnknown ? '<div class="bom-note bom-warn">price needed for a market row</div>' : '')
        : '<span class="bom-note">-</span>');

    placeBtn.disabled = !p.orders.length || p.problems.length > 0;
    placeBtn.textContent = p.orders.length ? 'Place ' + p.orders.length + (p.orders.length === 1 ? ' order' : ' orders') : 'Place';
  }

  // ---------------------------------------------------------------------------
  // Place: password after Place; Enter sends; Esc / Cancel goes back, rows kept
  // ---------------------------------------------------------------------------
  function openPassword() {
    if (document.getElementById('bomPlace').disabled) return;
    document.getElementById('bomPw').classList.add('show');
    var i = document.getElementById('bomPwInput'); i.value = ''; setTimeout(function () { i.focus(); }, 20);
  }
  function closePassword() { var pw = document.getElementById('bomPw'); if (pw) pw.classList.remove('show'); }
  function showMsg(t, bad) { var n = document.getElementById('bomFootNote'); if (n) { n.innerHTML = esc(t); n.className = 'bom-note' + (bad ? ' bom-err' : ''); } }

  var sending = false;
  async function send() {
    if (sending) return;
    var pw = document.getElementById('bomPwInput').value;
    if (!pw) { document.getElementById('bomPwInput').focus(); return; }
    var p = plan();
    if (!p.orders.length || p.problems.length) { closePassword(); return; }
    var rows = BOM.rows.filter(function (r) { return r.symbol && r.qty; }).map(function (r) {
      return { trader_id: r.trader_id, symbol: r.symbol, side: r.qty < 0 ? 'SELL' : 'BUY',
               lots: Math.abs(r.lot_size > 1 ? r.qty / r.lot_size : r.qty), price: r.price > 0 ? r.price : 0, tags: r.tags.slice() };
    });
    var ref = 'BOM-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    sending = true; document.getElementById('bomSend').disabled = true; showMsg('Sending…');
    try {
      var r = await fetch(window.SUPABASE_URL + '/functions/v1/wms-broker-order', {
        method: 'POST', headers: wmsEdgeHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action: 'place', confirm: true, password: pw, client_ref: ref,
          account: { investor_id: BOM.acct.investor_id, broker_id: BOM.acct.broker_id }, rows: rows }) });
      var j = await r.json().catch(function () { return {}; });
      if (!j.ok) {
        showMsg('Not sent: ' + (j.error || ('HTTP ' + r.status)), true);
        if (r.status === 401) { document.getElementById('bomPwInput').value = ''; document.getElementById('bomPwInput').focus(); }
        return;
      }
      closePassword();
      BOM.rows = []; addRow(); renderPanel();
      showMsg('Sent: ' + (j.orders || []).length + ' broker order(s). Follow them in Today\'s orders.');
      setTab('today');
    } catch (e) { showMsg('Not sent: ' + e.message, true); }
    finally { sending = false; var b = document.getElementById('bomSend'); if (b) b.disabled = false; }
  }

  // ---------------------------------------------------------------------------
  // Today's orders
  // ---------------------------------------------------------------------------
  function stopPoll() { if (BOM.pollTimer) { clearTimeout(BOM.pollTimer); BOM.pollTimer = null; } }
  async function loadToday() {
    stopPoll();
    var box = document.getElementById('bomToday');
    if (!box) return;
    var ist = new Date(Date.now() + 330 * 60000);
    var startUtc = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60000).toISOString();
    try {
      var cmds = await fetch(window.SUPABASE_URL + '/rest/v1/wms_live_commands?select=id,created_at,status,broker_status,filled_qty,avg_fill_price,error_message,payload' +
        '&signal_source=eq.manual&payload->_manual_meta->>placed_via=eq.broker_order_modal&created_at=gte.' + encodeURIComponent(startUtc) + '&order=created_at.desc&limit=100',
        { headers: wmsHeaders() }).then(function (x) { return x.json(); });
      if (!Array.isArray(cmds)) throw new Error((cmds && cmds.message) || 'could not read');
      var lines = cmds.length ? await fetch(window.SUPABASE_URL + '/rest/v1/at2_trade?select=entry_command_id,trader_id,status,qty_lots,entry_price&entry_command_id=in.(' +
        cmds.map(function (c) { return c.id; }).join(',') + ')', { headers: wmsHeaders() }).then(function (x) { return x.json(); }) : [];
      var working = false;
      box.innerHTML = cmds.length ? cmds.map(function (c) {
        var pl = c.payload || {}, bs = String(c.broker_status || c.status || '').toUpperCase();
        var cls = bs === 'FILLED' ? 'done' : (bs === 'REJECTED' || bs === 'CANCELLED' || bs === 'EXPIRED' || c.status === 'error') ? 'bad' : 'wip';
        if (cls === 'wip') working = true;
        var mine = (Array.isArray(lines) ? lines : []).filter(function (l) { return l.entry_command_id === c.id; });
        var t = new Date(new Date(c.created_at).getTime() + 330 * 60000).toISOString().slice(11, 16);
        return '<div class="bom-ord"><span class="bom-note">' + t + '</span> <b>' + (pl.side === -1 ? 'SELL' : 'BUY') + ' ' + qtyFmt(pl.qty) + '</b> ' + esc(pl.symbol || '') +
          ' · ' + (pl.type === 1 ? 'limit ' + price2(pl.limitPrice) : 'market') +
          ' &nbsp;<span class="bom-st ' + cls + '">' + esc(bs || 'QUEUED') + '</span>' +
          (c.filled_qty ? ' <span class="bom-note">filled ' + qtyFmt(c.filled_qty) + ' @ ' + price2(c.avg_fill_price) + '</span>' : '') +
          (c.error_message ? ' <span class="bom-err">' + esc(String(c.error_message).slice(0, 160)) + '</span>' : '') +
          '<div class="bom-split">' + mine.map(function (l) { return esc(invName(l.trader_id)) + ' ' + l.qty_lots + ' · ' + esc(l.status); }).join(' &nbsp;|&nbsp; ') + '</div></div>';
      }).join('') : '<span class="bom-note">No broker orders from this screen today.</span>';
      if (working && BOM.tab === 'today' && document.getElementById('bomOverlay').classList.contains('show')) BOM.pollTimer = setTimeout(loadToday, 5000);
    } catch (e) { box.innerHTML = '<span class="bom-err">Could not read today\'s orders: ' + esc(e.message) + '</span>'; }
  }
  // When the app comes back to the front, re-read once (phone-ready, Plan §6.1 item 6).
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && BOM.tab === 'today' && document.getElementById('bomOverlay') && document.getElementById('bomOverlay').classList.contains('show')) loadToday();
  });

  // ---------------------------------------------------------------------------
  // The ribbon button (desktop only for now — the phone version is phase 6)
  // ---------------------------------------------------------------------------
  function wireButton() {
    var b = document.getElementById('trBrokerOrderBtn');
    if (!b) return;
    injectStyles();
    if (window.WMS_PHONE) { b.style.display = 'none'; if (b.parentNode) b.parentNode.style.width = 'auto'; return; }
    b.addEventListener('click', bomOpen);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireButton); else wireButton();
})();
