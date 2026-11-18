// ============================================================================
// automation-slippage.js — MS007 › Slippage tab (read-only)
//
// Plan: "MS007 Slippage Dashboard Plan v4" (private repo docs / project docs).
// What it shows: on every LIVE MS007 trade since the switch to #2125
// (29-Sep-2026 21:00 IST), the gap between the price the strategy asked for and
// the price the broker filled, for the entry and the exit, plus how long each
// order took. READ-ONLY: no write to any table, no change to any record.
//
// Asked-for price (plan §2.1):
//   entry                   close of the decision bar (market_prices, 15m)
//   exit STOP / TRAIL       the stop level in force when it was hit
//                           (last STOP_PLACED / STOP_MODIFIED event)
//   exit SQUARE_OFF/TARGET/TIME  close of the exit decision bar (market_prices)
//   exit MANUAL / ROLL      none → slippage shows "—"
// Fill price: the order record's broker average (wms_live_commands), falling
// back to the trade's own price.
// Sign: + = cost to you (red), − = better than asked (green).
// Opening gap: a STOP/TRAIL exit filled in the first minute after that day's
// MCX session opened (market_hours, same rules as the DB's market_session()).
// Charges: ONE rate for every book and trade — T3a's futures rate on its
// Fyers account (investor_broker_accounts, from wmsRefData; no DB call).
// Open trades are left out until they close.
//
// Meters (LESSONS §A.22): loads only when the tab is opened; one filtered,
// column-limited read per table through wmsStore ('ms007_slippage'); later
// opens make one tiny change-check and reuse the cache when nothing moved.
// ============================================================================

var AU_SLIP_SINCE = '2026-09-29T15:30:00Z';   // #2125 live switch (plan §1)
var AU_SLIP_EXITS = ['STOP', 'TRAIL', 'SQUARE_OFF', 'TARGET', 'TIME', 'ROLL', 'MANUAL'];
var AU_SLIP_EXIT_LABEL = { STOP: 'Stop', TRAIL: 'Trail', SQUARE_OFF: 'Trend-break', TARGET: 'Target',
                           TIME: 'Time', ROLL: 'Roll', MANUAL: 'Manual' };
var AU_SLIP_BAR_MS = 15 * 60 * 1000;

var _auSlip = {
    data: null,             // { trades, signals, events, cmds, prices, hours, loadedAt }
    rows: [],               // computed per-trade rows (all, before filters)
    ui: null,               // pill-search / date-filter controllers
    f: { strategy: '', books: [], exits: [], result: 'all', from: null, to: null },
    sort: { key: 'exit_at', dir: -1 },
    page: 1,
    open: {}                // expanded stop-history rows (trade id → true)
};
var _AU_SLIP_KEY = 'wms.ms007Slip.v1';

function _auSlipSave() {
    try {
        localStorage.setItem(_AU_SLIP_KEY, JSON.stringify({ strategy: _auSlip.f.strategy, books: _auSlip.f.books,
            exits: _auSlip.f.exits, result: _auSlip.f.result, sort: _auSlip.sort }));
    } catch (e) { /* storage off — filters just won't persist */ }
}
(function _auSlipRestore() {
    try {
        var s = JSON.parse(localStorage.getItem(_AU_SLIP_KEY) || '{}');
        if (s.strategy) _auSlip.f.strategy = s.strategy;
        if (Array.isArray(s.books)) _auSlip.f.books = s.books;
        if (Array.isArray(s.exits)) _auSlip.f.exits = s.exits;
        if (s.result) _auSlip.f.result = s.result;
        if (s.sort && s.sort.key) _auSlip.sort = s.sort;
    } catch (e) { /* ignore malformed */ }
})();

// ── Data ────────────────────────────────────────────────────────────────────

function _auSlipStratIds() {
    return (_auAt2.strategies || []).map(function (s) { return s.id; });
}

async function _auSlipGetChunked(table, select, col, ids, extra) {
    var out = [], uniq = Array.from(new Set(ids.filter(Boolean)));
    for (var i = 0; i < uniq.length; i += 60) {
        var part = uniq.slice(i, i + 60).map(function (v) { return '"' + v + '"'; }).join(',');
        var q = 'select=' + select + '&' + col + '=in.(' + encodeURIComponent(part) + ')' + (extra ? '&' + extra : '');
        out = out.concat(await auAt2Get(table, q));
    }
    return out;
}

async function _auSlipLoad() {
    var sids = _auSlipStratIds();
    if (!sids.length) return { trades: [], signals: [], events: [], cmds: [], prices: [], hours: [], loadedAt: new Date() };
    var trades = await auAt2Get('at2_trade',
        'select=id,book_id,strategy_id,signal_id,side,qty_lots,qty_units,entry_at,entry_price,exit_at,exit_price,' +
        'exit_reason,realised_pnl,entry_command_id,exit_command_id' +
        '&mode=eq.live&status=eq.closed&entry_at=gte.' + encodeURIComponent(AU_SLIP_SINCE) +
        '&strategy_id=in.(' + sids.join(',') + ')&order=exit_at.desc');
    var tids = trades.map(function (t) { return t.id; });
    var res = await Promise.all([
        _auSlipGetChunked('at2_signal', 'id,bar_ts,fired_at', 'id', trades.map(function (t) { return t.signal_id; })),
        _auSlipGetChunked('at2_trade_event', 'trade_id,seq,at,kind,price,live_command_id', 'trade_id', tids,
            'kind=in.(STOP_PLACED,STOP_MODIFIED,EXIT_FILLED)'),
        auAt2Get('market_hours', 'select=on_date,closed,open_time,days,valid_from,valid_to' +
            '&enabled=eq.true&exchange=eq.MCX&segment=eq.COMM')
    ]);
    var signals = res[0], events = res[1], hours = res[2];
    var cmdIds = [];
    trades.forEach(function (t) { cmdIds.push(t.entry_command_id, t.exit_command_id); });
    events.forEach(function (e) { if (e.kind === 'EXIT_FILLED') cmdIds.push(e.live_command_id); });
    var cmds = await _auSlipGetChunked('wms_live_commands',
        'id,claimed_at,placed_at,filled_at,avg_fill_price,sym:payload->>symbol,run_ts:payload->_at2_meta->>bar_ts',
        'id', cmdIds);

    // Decision bars to price: entry = signal bar − 15m; market-order exit = the
    // exit run's bar close (run time floored to 15m) − 15m. market_prices.bar_ts
    // is the bar's START; the signal's bar_ts is its CLOSE.
    var sigMap = {}; signals.forEach(function (s) { sigMap[s.id] = s; });
    var cmdMap = {}; cmds.forEach(function (c) { cmdMap[c.id] = c; });
    var syms = {}, bars = {};
    trades.forEach(function (t) {
        var ec = cmdMap[t.entry_command_id], s = sigMap[t.signal_id];
        if (ec && ec.sym && s && s.bar_ts) { syms[ec.sym] = 1; bars[new Date(new Date(s.bar_ts).getTime() - AU_SLIP_BAR_MS).toISOString()] = 1; }
        var xc = cmdMap[t.exit_command_id];
        var xb = (xc && xc.sym && xc.run_ts) ? _auSlipFloorBar(xc.run_ts) : 0;
        if (xb) { syms[xc.sym] = 1; bars[new Date(xb - AU_SLIP_BAR_MS).toISOString()] = 1; }
    });
    var prices = [];
    var symList = Object.keys(syms), barList = Object.keys(bars).filter(Boolean);
    if (symList.length && barList.length) {
        var symIn = encodeURIComponent(symList.map(function (v) { return '"' + v + '"'; }).join(','));
        for (var i = 0; i < barList.length; i += 60) {
            var part = encodeURIComponent(barList.slice(i, i + 60).map(function (v) { return '"' + v + '"'; }).join(','));
            prices = prices.concat(await auAt2Get('market_prices', 'select=external_symbol,bar_ts,close&resolution=eq.15' +
                '&external_symbol=in.(' + symIn + ')&bar_ts=in.(' + part + ')'));
        }
    }
    return { trades: trades, signals: signals, events: events, cmds: cmds, prices: prices, hours: hours, loadedAt: new Date() };
}

// Cheap change-check for wmsStore: latest closed live MS007 trade + count, plus
// today's date (so a trade closed today is re-priced after tonight's archive).
async function _auSlipSyncState() {
    var sids = _auSlipStratIds();
    if (!sids.length) return { checksum: 'none' };
    var url = SUPABASE_URL + '/rest/v1/at2_trade?select=updated_at&mode=eq.live&status=eq.closed' +
        '&entry_at=gte.' + encodeURIComponent(AU_SLIP_SINCE) + '&strategy_id=in.(' + sids.join(',') + ')' +
        '&order=updated_at.desc&limit=1';
    var r = await fetch(url, { headers: wmsHeaders({ 'Prefer': 'count=exact' }) });
    if (!r.ok) throw new Error('at2_trade sync: HTTP ' + r.status);
    var rows = await r.json();
    var cr = r.headers.get('content-range') || '';
    return { checksum: cr.split('/')[1] + '|' + (rows[0] ? rows[0].updated_at : '') + '|' + _auSlipIst(Date.now()).date };
}

if (window.wmsStore && !wmsStore.isRegistered('ms007_slippage')) {
    wmsStore.register('ms007_slippage', { policy: 'cache', loader: _auSlipLoad, syncState: _auSlipSyncState });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function _auSlipFloorBar(iso) { var ms = new Date(iso).getTime(); return isNaN(ms) ? 0 : Math.floor(ms / AU_SLIP_BAR_MS) * AU_SLIP_BAR_MS; }
function _auSlipIst(ms) {   // IST has no DST: a fixed +05:30
    var s = new Date(ms + 19800000).toISOString();
    return { date: s.slice(0, 10), time: s.slice(11, 19) };
}
function _auSlipMedian(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function _auSlipMean(a) { return a.length ? a.reduce(function (n, v) { return n + v; }, 0) / a.length : null; }
function _auSlipSum(a) { return a.reduce(function (n, v) { return n + v; }, 0); }

// MCX session open for an IST date — the same rule as the DB's market_session():
// a dated exception row wins; else the latest regular row valid on that date.
function _auSlipOpenTime(hours, dateStr) {
    var ex = hours.filter(function (h) { return h.on_date === dateStr; })[0];
    if (ex) return ex.closed ? null : ex.open_time;
    var reg = hours.filter(function (h) {
        return !h.on_date && h.valid_from <= dateStr && (!h.valid_to || h.valid_to >= dateStr);
    }).sort(function (a, b) { return a.valid_from < b.valid_from ? 1 : -1; })[0];
    return reg ? reg.open_time : null;
}
var AU_SLIP_MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function _auSlipDdMon(iso) { var d = _auSlipIst(new Date(iso).getTime()).date; return d.slice(8, 10) + '-' + AU_SLIP_MON[+d.slice(5, 7) - 1]; }
function _auSlipSecs(t) { var p = String(t || '').split(':'); return (+p[0] || 0) * 3600 + (+p[1] || 0) * 60 + (+p[2] || 0); }

// T3a's futures rate (fraction per side) from the cached broker-account rates.
// One rate for every book and every trade (owner, 18-Nov-2026). Shared with the
// MS007 Live / Paper Net P&L cards.
function auMs007ChargeRate() {
    try {
        var inv = wmsRefData.investorCache && wmsRefData.investorCache['t3a'];
        var brk = wmsRefData.brokerCache && (wmsRefData.brokerCache['fyers'] || wmsRefData.brokerCache['fyers securities']);
        var iba = inv && brk && wmsRefData.ibaRatesMap && wmsRefData.ibaRatesMap[inv + '|' + brk];
        var pct = iba && iba.rates && iba.rates.derivatives && iba.rates.derivatives.futures && iba.rates.derivatives.futures.pct;
        var n = Number(pct);
        return (pct !== undefined && pct !== null && isFinite(n)) ? n : null;
    } catch (e) { return null; }
}
function auMs007ChargeLabel(rate) {
    return rate === null ? 'rate not set' : (rate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '%/side';
}

// ── Per-trade computation ───────────────────────────────────────────────────

function _auSlipCompute(d) {
    var rate = auMs007ChargeRate();
    var sig = {}, cmd = {}, px = {}, ev = {};
    d.signals.forEach(function (s) { sig[s.id] = s; });
    d.cmds.forEach(function (c) { cmd[c.id] = c; });
    d.prices.forEach(function (p) { px[p.external_symbol + '|' + new Date(p.bar_ts).getTime()] = Number(p.close); });
    d.events.forEach(function (e) { (ev[e.trade_id] = ev[e.trade_id] || []).push(e); });
    return d.trades.map(function (t) {
        var sg = t.side === 'LONG' ? 1 : -1;
        var units = Number(t.qty_units) || 0;
        var s = sig[t.signal_id], ec = cmd[t.entry_command_id];
        var barClose = s && s.bar_ts ? new Date(s.bar_ts).getTime() : null;
        var eAsk = (ec && barClose !== null) ? px[ec.sym + '|' + (barClose - AU_SLIP_BAR_MS)] : undefined;
        var eFill = ec && ec.avg_fill_price !== null ? Number(ec.avg_fill_price) : Number(t.entry_price);
        var es = (eAsk !== undefined) ? sg * (eFill - eAsk) : null;

        var tev = (ev[t.id] || []).slice().sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : (a.seq - b.seq); });
        var xFillEv = tev.filter(function (e) { return e.kind === 'EXIT_FILLED'; })[0];
        var xc = cmd[t.exit_command_id || (xFillEv && xFillEv.live_command_id)];
        var xFill = xc && xc.avg_fill_price !== null ? Number(xc.avg_fill_price) : Number(t.exit_price);
        var stops = tev.filter(function (e) { return (e.kind === 'STOP_PLACED' || e.kind === 'STOP_MODIFIED') && e.price !== null; });
        var xAsk, xBar = null, xNote = '';
        if (t.exit_reason === 'STOP' || t.exit_reason === 'TRAIL') {
            var inForce = stops.filter(function (e) { return e.at <= t.exit_at; });
            xAsk = inForce.length ? Number(inForce[inForce.length - 1].price) : undefined;
        } else if (t.exit_reason === 'SQUARE_OFF' || t.exit_reason === 'TARGET' || t.exit_reason === 'TIME') {
            var mc = cmd[t.exit_command_id];
            xBar = mc && mc.run_ts ? _auSlipFloorBar(mc.run_ts) : null;
            xAsk = (mc && xBar) ? px[mc.sym + '|' + (xBar - AU_SLIP_BAR_MS)] : undefined;
        } else {
            xAsk = null; xNote = 'no asked-for price';
        }
        var xs = (xAsk !== undefined && xAsk !== null) ? sg * (xAsk - xFill) : null;

        var exIst = _auSlipIst(new Date(t.exit_at).getTime());
        var today = exIst.date === _auSlipIst(Date.now()).date;   // price archive fills in at 23:56
        var open = (t.exit_reason === 'STOP' || t.exit_reason === 'TRAIL') ? _auSlipOpenTime(d.hours, exIst.date) : null;
        var gap = false;
        if (open) { var dt = _auSlipSecs(exIst.time) - _auSlipSecs(open); gap = dt >= 0 && dt < 60; }

        var gross = Number(t.realised_pnl) || 0;
        var charges = rate === null ? 0 : rate * ((Number(t.entry_price) || 0) + (Number(t.exit_price) || 0)) * units;
        var secs = function (iso, from) { return (iso && from !== null) ? (new Date(iso).getTime() - from) / 1000 : null; };
        return {
            id: t.id, book_id: t.book_id, strategy_id: t.strategy_id, side: t.side, lots: Number(t.qty_lots) || 0, units: units,
            entry_at: t.entry_at, exit_at: t.exit_at, exit_ist: exIst, reason: t.exit_reason, gap: gap,
            eAsk: eAsk === undefined ? null : eAsk, eFill: eFill, es: es, esPct: es !== null && eAsk ? es / eAsk * 100 : null,
            ePending: eAsk === undefined && today,
            xAsk: xAsk === undefined ? null : xAsk, xFill: xFill, xs: xs, xsPct: xs !== null && xAsk ? xs / xAsk * 100 : null,
            xPending: xAsk === undefined && today, xNote: xNote,
            eDelay: ec ? secs(ec.placed_at, barClose) : null,
            lat: ec ? { decided: s ? secs(s.fired_at, barClose) : null, claimed: secs(ec.claimed_at, barClose),
                        placed: secs(ec.placed_at, barClose), filled: secs(ec.filled_at, barClose) } : null,
            xDelay: (xBar && xc) ? secs(xc.placed_at, xBar) : null,
            gross: gross, charges: charges, net: gross - charges,
            eRs: es !== null ? es * units : null, xRs: xs !== null ? xs * units : null,
            stops: stops
        };
    });
}

// ── Filters ─────────────────────────────────────────────────────────────────

function _auSlipFiltered() {
    var f = _auSlip.f;
    return _auSlip.rows.filter(function (r) {
        if (f.strategy && r.strategy_id !== f.strategy) return false;
        if (f.books.length && f.books.indexOf(r.book_id) < 0) return false;
        if (f.exits.length && f.exits.indexOf(r.reason) < 0) return false;
        if (f.result === 'profit' && !(r.net > 0)) return false;
        if (f.result === 'loss' && !(r.net < 0)) return false;
        if (f.from && r.exit_ist.date < f.from) return false;
        if (f.to && r.exit_ist.date > f.to) return false;
        return true;
    });
}

function _auSlipBuildFilters() {
    var bar = document.getElementById('au-at2-slip-filterbar');
    if (!bar) return;
    if (_auSlip.ui) { try { _auSlip.ui.books.destroy(); _auSlip.ui.exits.destroy(); _auSlip.ui.dates.destroy(); } catch (e) {} }
    var strats = (_auAt2.strategies || []).slice().sort(function (a, b) { return (a.code || '').localeCompare(b.code || ''); });
    if (!_auSlip.f.strategy || !strats.some(function (s) { return s.id === _auSlip.f.strategy; })) {
        var silver = strats.filter(function (s) { return /silverm/i.test(s.code || ''); })[0];
        _auSlip.f.strategy = silver ? silver.id : (strats[0] ? strats[0].id : '');
    }
    var lbl = 'font-size:10px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.04em;display:block;margin-bottom:4px';
    bar.innerHTML =
        '<div class="au-slip-filters">' +
          '<div><span style="' + lbl + '">Strategy</span><select id="au-slip-strat" class="au-slip-select">' +
            strats.map(function (s) {
                return '<option value="' + s.id + '"' + (s.id === _auSlip.f.strategy ? ' selected' : '') + '>' + auAt2Esc(s.code) + '</option>';
            }).join('') + '</select></div>' +
          '<div id="au-slip-books" class="au-slip-pill"></div>' +
          '<div id="au-slip-exits" class="au-slip-pill"></div>' +
          '<div><span style="' + lbl + '">Result</span><select id="au-slip-result" class="au-slip-select">' +
            [['all', 'All'], ['profit', 'Profit'], ['loss', 'Loss']].map(function (o) {
                return '<option value="' + o[0] + '"' + (_auSlip.f.result === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
            }).join('') + '</select></div>' +
          '<div><span style="' + lbl + '">Dates (exit)</span><div id="au-slip-dates"></div></div>' +
        '</div>';
    document.getElementById('au-slip-strat').onchange = function () { _auSlip.f.strategy = this.value; _auSlip.page = 1; _auSlipSave(); auSlipRender(); };
    document.getElementById('au-slip-result').onchange = function () { _auSlip.f.result = this.value; _auSlip.page = 1; _auSlipSave(); auSlipRender(); };
    var books = (_auAt2.books || []).filter(function (b) { return b.mode === 'live'; })
        .map(function (b) { return { id: b.id, label: b.display_name, searchText: b.display_name }; });
    _auSlip.f.books = _auSlip.f.books.filter(function (id) { return books.some(function (b) { return b.id === id; }); });
    var onPill = function () { _auSlip.page = 1; _auSlipSave(); auSlipRender(); };
    var books$ = wmsPillSearch(document.getElementById('au-slip-books'), {
        label: 'Books', placeholder: 'Type to search books…', items: books, selectedIds: _auSlip.f.books, onChange: onPill });
    var exits$ = wmsPillSearch(document.getElementById('au-slip-exits'), {
        label: 'Exit type', placeholder: 'Type to search exit types…', selectedIds: _auSlip.f.exits, onChange: onPill,
        items: AU_SLIP_EXITS.map(function (r) { return { id: r, label: AU_SLIP_EXIT_LABEL[r], searchText: AU_SLIP_EXIT_LABEL[r] + ' ' + r }; }) });
    var fyStart = (wmsRefData && wmsRefData.userPrefs && wmsRefData.userPrefs.fy_start_month) || 4;
    var dates$ = wmsDateFilter(document.getElementById('au-slip-dates'), {
        default: 'all', persistKey: 'wms_ms007_slip_datefilter', fyStartMonth: fyStart,
        transactions: _auSlip.rows.map(function (r) { return { transaction_date: r.exit_ist.date }; }),
        onChange: function (from, to) { _auSlip.f.from = from; _auSlip.f.to = to; _auSlip.page = 1; auSlipRender(); }
    });
    if (dates$) { var rg = dates$.getRange(); _auSlip.f.from = rg.from; _auSlip.f.to = rg.to; }
    _auSlip.ui = { books: books$, exits: exits$, dates: dates$ };
}

// ── Formatting ──────────────────────────────────────────────────────────────

function _auSlipPts(v, pct, bold) {
    if (v === null || v === undefined) return '<td class="text-right" style="color:#9ca3af">—</td>';
    var cls = v > 0 ? 'au-slip-cost' : v < 0 ? 'au-slip-better' : '';
    var n = (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    var p = (pct === null || pct === undefined) ? '' : '<div class="au-slip-pc">' + (pct > 0 ? '+' : pct < 0 ? '−' : '') + Math.abs(pct).toFixed(3) + '%</div>';
    return '<td class="text-right ' + cls + '">' + (bold ? '<b>' + n + '</b>' : n) + p + '</td>';
}
function _auSlipAmt(v, sub, bold, isCost) {
    if (v === null || v === undefined) return '<td class="text-right" style="color:#9ca3af">—</td>';
    var cls = isCost ? (v > 0 ? 'au-slip-cost' : v < 0 ? 'au-slip-better' : '') : getAmountClass(v);
    var n = formatAmount(isCost ? v : v);
    return '<td class="text-right ' + cls + '">' + (bold ? '<b>' + n + '</b>' : n) +
           (sub ? '<div class="au-slip-pc">' + sub + '</div>' : '') + '</td>';
}
function _auSlipPctTxt(num, den) {
    if (num === null || !den) return '';
    return (num / Math.abs(den) * 100).toFixed(2) + '%';
}
function _auSlipFmtSec(v) { return v === null || v === undefined ? '—' : v.toFixed(1); }

// ── Render ──────────────────────────────────────────────────────────────────

/** Opened from the Slippage sub-tab (autoSwitchSubTab) and its ↻ button. */
async function auSlipOpen(force) {
    var host = document.getElementById('au-at2-slip-content');
    if (!host) return;
    if (!window.wmsStore) { host.innerHTML = '<div class="au-error-list">⛔ App data store not loaded.</div>'; return; }
    if (!_auSlip.data) host.innerHTML = '<div class="au-meta">Loading slippage…</div>';
    try {
        if (!wmsStore.isRegistered('ms007_slippage')) wmsStore.register('ms007_slippage', { policy: 'cache', loader: _auSlipLoad, syncState: _auSlipSyncState });
        if (!_auAt2.loadedAt) await autoAt2Refresh();
        if (force) wmsStore.invalidate('ms007_slippage');
        var d = await wmsStore.get('ms007_slippage');
        if (d !== _auSlip.data || !_auSlip.rows.length) { _auSlip.data = d; _auSlip.rows = _auSlipCompute(d); }
        _auSlipBuildFilters();
        auSlipRender();
    } catch (e) {
        host.innerHTML = '<div class="au-error-list"><strong>⛔ Slippage data could not be loaded.</strong>' +
            '<div style="margin-top:6px">' + auAt2Esc(e && e.message) + '</div>' +
            '<div style="margin-top:6px">This page is showing NOTHING, not "no slippage".</div></div>';
    }
}

function auSlipRender() {
    var host = document.getElementById('au-at2-slip-content');
    if (!host || !_auSlip.data) return;
    var all = _auSlipFiltered();
    var pending = all.filter(function (r) { return r.ePending || r.xPending; });
    var rows = all.filter(function (r) { return !(r.ePending || r.xPending); });
    var rate = auMs007ChargeRate();
    var full = (typeof wmsIsFullAmount === 'function' && wmsIsFullAmount());
    var unit = (typeof getUnitDescription === 'function') ? getUnitDescription() : "₹ '000";
    var h = '';
    if (rate === null) {
        h += '<div class="au-error-list" style="margin-bottom:10px">⚠️ T3a\'s futures charge rate is not set on its Fyers broker account, ' +
             'so Net P&amp;L below is shown <b>before charges</b>. Set it in Master Data → Investors → T3a → broker accounts.</div>';
    }
    if (!rows.length) {
        h += '<div class="au-meta">No closed live trades match these filters.</div>';
        host.innerHTML = h + _auSlipPendingNote(pending);
        return;
    }
    h += _auSlipSummary(rows, rate, unit, full);
    h += _auSlipLatency(rows);
    h += _auSlipChart(rows);
    h += _auSlipTrades(rows, unit, full);
    h += _auSlipPendingNote(pending);
    host.className = 'au-slip-host';   // drop the loading-state 'au-meta' styling once there is content
    host.innerHTML = h;
}

function _auSlipPendingNote(p) {
    if (!p.length) return '';
    return '<div class="au-meta" style="margin-top:8px">⏳ ' + p.length + ' trade(s) closed today are waiting for tonight\'s price archive ' +
           '(fills in at 23:56) and are left out until then.</div>';
}

function _auSlipStatRow(label, sub, trs, ptsKey, pctKey, rsKey, net, grandNet, cls, entryLike) {
    var pts = trs.map(function (r) { return r[ptsKey]; }).filter(function (v) { return v !== null; });
    var pcs = trs.map(function (r) { return r[pctKey]; }).filter(function (v) { return v !== null; });
    var lots = _auSlipSum(trs.map(function (r) { return r.lots; }));
    var rs = _auSlipSum(trs.map(function (r) { return r[rsKey] || 0; }));
    var bold = cls === 'au-slip-tt' || cls === 'au-slip-gt';
    var avg = _auSlipMean(pts), med = _auSlipMedian(pts);
    var skew = (avg !== null && med !== null && Math.max(Math.abs(avg), Math.abs(med)) > 0 &&
                Math.abs(avg - med) > 0.5 * Math.max(Math.abs(avg), Math.abs(med)));
    var bi = pts.length ? pts.indexOf(Math.min.apply(null, pts)) : -1, wi = pts.length ? pts.indexOf(Math.max.apply(null, pts)) : -1;
    var td = function (v, p) { var c = _auSlipPts(v, p, bold); return skew ? c.replace('<td class="text-right', '<td title="Average and median differ by more than half: one or two trades are pulling the average" class="text-right au-slip-skew') : c; };
    var cells = '<td>' + (bold ? '<b>' + label + '</b>' : label) + (sub ? '<div class="au-slip-pc">' + sub + '</div>' : '') + '</td>' +
        '<td class="text-right">' + (bold ? '<b>' + trs.length + '</b>' : trs.length) + '</td>' +
        '<td class="text-right">' + (bold ? '<b>' + lots + '</b>' : lots) + '</td>';
    if (ptsKey === 'rt' && label.indexOf('Grand') >= 0) {
        cells += '<td class="text-right">—</td><td class="text-right">—</td><td class="text-right">—</td><td class="text-right">—</td>';
    } else {
        cells += td(avg, _auSlipMean(pcs)) + td(med, _auSlipMedian(pcs));
        cells += (ptsKey === 'rt') ? '<td class="text-right">—</td><td class="text-right">—</td>'
                                   : _auSlipPts(bi >= 0 ? pts[bi] : null, bi >= 0 ? pcs[bi] : null, bold) + _auSlipPts(wi >= 0 ? pts[wi] : null, wi >= 0 ? pcs[wi] : null, bold);
    }
    cells += (net === null) ? '<td class="text-right">—</td>' : _auSlipAmt(net, grandNet ? (net / grandNet * 100).toFixed(2) + '%' : '', bold, false);
    var slipSub = entryLike ? (grandNet ? (rs / grandNet * 100).toFixed(2) + '%*' : '') : _auSlipPctTxt(rs, net);
    cells += _auSlipAmt(rs, slipSub, bold, true);
    return '<tr class="' + (cls || '') + '">' + cells + '</tr>';
}

function _auSlipSummary(rows, rate, unit, full) {
    var ng = rows.filter(function (r) { return !r.gap; }), gp = rows.filter(function (r) { return r.gap; });
    rows.forEach(function (r) {
        r.rt = (r.es !== null && r.xs !== null) ? r.es + r.xs : null;
        r.rtPct = (r.esPct !== null && r.xsPct !== null) ? r.esPct + r.xsPct : null;
        r.rtRs = (r.eRs || 0) + (r.xRs || 0);
    });
    var grandNet = _auSlipSum(rows.map(function (r) { return r.net; }));
    var netOf = function (a) { return _auSlipSum(a.map(function (r) { return r.net; })); };
    var b = '';
    b += _auSlipStatRow('Entry', '', ng, 'es', 'esPct', 'eRs', null, grandNet, '', true);
    var reasons = AU_SLIP_EXITS.concat(ng.map(function (r) { return r.reason; }).filter(function (x) { return AU_SLIP_EXITS.indexOf(x) < 0; }));
    reasons.forEach(function (k) {
        var s = ng.filter(function (r) { return r.reason === k; });
        if (!s.length) return;
        b += _auSlipStatRow('Exit · ' + auAt2Esc((AU_SLIP_EXIT_LABEL[k] || k).toLowerCase()), '', s, 'xs', 'xsPct', 'xRs', netOf(s), grandNet, '', false);
    });
    b += _auSlipStatRow('Total', 'round trip, excl. gaps', ng, 'rt', 'rtPct', 'rtRs', netOf(ng), grandNet, 'au-slip-tt', false);
    if (gp.length) {
        b += _auSlipStatRow('Opening gaps · entry', 'reference, not in total', gp, 'es', 'esPct', 'eRs', null, grandNet, '', true);
        b += _auSlipStatRow('Opening gaps · exit', 'reference, not in total', gp, 'xs', 'xsPct', 'xRs', netOf(gp), grandNet, '', false);
    }
    b += _auSlipStatRow('Grand total', 'all closed trades', rows, 'rt', 'rtPct', 'rtRs', grandNet, grandNet, 'au-slip-gt', false);

    var gross = _auSlipSum(rows.map(function (r) { return r.gross; }));
    var charges = _auSlipSum(rows.map(function (r) { return r.charges; }));
    var cg = full ? [13, 6, 5, 10, 10, 10, 10, 18, 18] : [16, 7, 6, 11, 11, 11, 11, 13.5, 13.5];
    return '<div class="au-slip-h">Summary <span class="au-slip-unit">all amounts in ' + unit + '</span>' +
        '<span class="au-slip-sub">points, with % of the asked-for price below · red = cost, green = better than asked · losses in brackets</span></div>' +
        '<table class="au-at2-table au-slip-table">' + _auSlipCols(cg) + '<thead><tr><th>Part</th><th class="text-right">Trades</th><th class="text-right">Lots</th>' +
        '<th class="text-right">Average</th><th class="text-right">Median</th><th class="text-right">Best</th><th class="text-right">Worst</th>' +
        '<th class="text-right">Net P&amp;L</th><th class="text-right">Slippage</th></tr></thead><tbody>' + b + '</tbody></table>' +
        '<ul class="au-slip-notes">' +
          '<li>Net P&amp;L = gross booked P&amp;L minus charges; the % under it is its share of the Grand total.</li>' +
          '<li>Charges: T3a\'s futures rate on its Fyers account (' + auMs007ChargeLabel(rate) + '), on the traded value of entry and exit, for every book. ' +
              formatAmount(charges) + ' on these closed trades = ' + (gross ? (charges / gross * 100).toFixed(2) : '0.00') + '% of the gross P&amp;L.</li>' +
          '<li>The % under Slippage is slippage as a share of that row\'s own net P&amp;L (or loss).</li>' +
          '<li>* An entry has no P&amp;L of its own: its % is of the Grand total net P&amp;L.</li>' +
          '<li>Entry and Total cover the closed trades that did not exit on an opening gap; each exit row covers the trades that exited that way. ' +
              'Open trades are left out until they close. Amber = average and median differ by more than half.</li>' +
        '</ul>';
}

function _auSlipCols(w) { return '<colgroup>' + w.map(function (x) { return '<col style="width:' + x + '%">'; }).join('') + '</colgroup>'; }

function _auSlipLatency(rows) {
    var L = rows.map(function (r) { return r.lat; }).filter(Boolean);
    var line = function (label, key, bold) {
        var v = L.map(function (l) { return l[key]; }).filter(function (x) { return x !== null && isFinite(x); });
        var b = function (s) { return bold ? '<b>' + s + '</b>' : s; };
        return '<tr' + (bold ? ' class="au-slip-tt"' : '') + '><td>' + b(label) + '</td>' +
            '<td class="text-right">' + b(_auSlipFmtSec(_auSlipMean(v))) + '</td><td class="text-right">' + b(_auSlipFmtSec(_auSlipMedian(v))) + '</td>' +
            '<td class="text-right">' + b(v.length ? _auSlipFmtSec(Math.min.apply(null, v)) + '–' + _auSlipFmtSec(Math.max.apply(null, v)) : '—') + '</td></tr>';
    };
    return '<div class="au-slip-h">Latency <span class="au-slip-sub">entry orders, seconds from the bar close · ' + L.length + ' entries</span></div>' +
        '<table class="au-at2-table au-slip-table">' + _auSlipCols([40, 15, 15, 30]) +
        '<thead><tr><th>Step</th><th class="text-right">Average</th><th class="text-right">Median</th><th class="text-right">Range</th></tr></thead><tbody>' +
        line('Signal decided', 'decided') + line('Order handed to the order server', 'claimed') +
        line('Order accepted by the broker', 'placed') + line('Filled (as WMS recorded it)*', 'filled', true) +
        '</tbody></table>' +
        '<div class="au-slip-sub" style="margin:4px 0 0">* WMS records a fill when the broker\'s reply arrives, slightly after the exchange fill ' +
        '(checked against the Fyers tradebook: the exchange fill comes under 1 s after the order). ' +
        'Stop and trail exits rest at the broker, so they have no delay on our side.</div>';
}

function _auSlipChart(rows) {
    var cr = rows.filter(function (r) { return !r.gap; }).slice().sort(function (a, b) { return a.entry_at < b.entry_at ? -1 : 1; });
    if (!cr.length) return '';
    var W = 760, H = 230, ML = 48, MR = 8, MT = 26, MB = 40, n = cr.length, PW = W - ML - MR, PH = H - MT - MB;
    var TOP = 300, BOT = -200;
    var y = function (v) { return MT + (TOP - Math.max(BOT, Math.min(TOP, v))) / (TOP - BOT) * PH; };
    var s = ['<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Slippage per trade, entry and exit, in points" style="width:100%;height:auto;font-family:inherit">'];
    [-200, -100, 0, 100, 200, 300].forEach(function (t) {
        var yy = y(t).toFixed(1);
        s.push('<line x1="' + ML + '" x2="' + (W - MR) + '" y1="' + yy + '" y2="' + yy + '" stroke="' + (t === 0 ? '#94a3b8' : '#e5e7eb') + '" stroke-width="' + (t === 0 ? 1.2 : 0.6) + '"/>');
        s.push('<text x="' + (ML - 6) + '" y="' + (+yy + 3) + '" font-size="10" text-anchor="end" fill="#6b7280">' + (t > 0 ? '+' : '') + t + '</text>');
    });
    s.push('<text x="12" y="' + (MT + PH / 2) + '" font-size="10.5" fill="#6b7280" text-anchor="middle" transform="rotate(-90 12 ' + (MT + PH / 2) + ')">points (+ = cost)</text>');
    var slot = PW / n, bw = Math.max(2, (slot - 4) / 2), lastLab = -99;
    cr.forEach(function (r, i) {
        var x0 = ML + i * slot + 2, dt = _auSlipIst(new Date(r.entry_at).getTime()).date;
        [[r.es, '#2563eb', 'entry'], [r.xs, '#f59e0b', 'exit']].forEach(function (b, j) {
            if (b[0] === null) return;
            var v = b[0], x = x0 + j * bw, top = Math.min(y(v), y(0)), hh = Math.max(1, Math.abs(y(v) - y(0)));
            s.push('<rect x="' + x.toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + (bw - 0.5).toFixed(1) + '" height="' + hh.toFixed(1) + '" fill="' + b[1] + '">' +
                   '<title>' + dt + ' · ' + b[2] + ' ' + (v > 0 ? '+' : '') + v.toFixed(2) + ' pts</title></rect>');
            if (v > TOP || v < BOT) {
                var ey = v > TOP ? MT + 4 : MT + PH - 6;
                s.push('<path d="M' + (x - 1).toFixed(1) + ',' + ey + ' l' + (bw + 1).toFixed(1) + ',-3 M' + (x - 1).toFixed(1) + ',' + (ey + 3) + ' l' + (bw + 1).toFixed(1) + ',-3" stroke="#fff" stroke-width="1.5"/>');
                s.push('<text x="' + (x + bw + 2).toFixed(1) + '" y="' + (v > TOP ? MT + 10 : MT + PH - 2) + '" font-size="9.5" fill="#6b7280">' + Math.round(v) + '</text>');
            }
        });
        var cx = x0 + bw;
        if (cx - lastLab > 62) {
            lastLab = cx;
            s.push('<text x="' + cx.toFixed(1) + '" y="' + (MT + PH + 16) + '" font-size="10" text-anchor="middle" fill="#6b7280">' +
                   _auSlipDdMon(r.entry_at) + '</text>');
        }
    });
    s.push('<text x="' + (ML + PW / 2) + '" y="' + (H - 4) + '" font-size="10.5" text-anchor="middle" fill="#6b7280">trade (by entry date)</text></svg>');
    return '<div class="au-slip-h">Slippage per trade <span class="au-slip-sub">' +
        '<span class="au-slip-key" style="background:#2563eb"></span>entry <span class="au-slip-key" style="background:#f59e0b"></span>exit · ' +
        'above zero = cost, below = better than asked · opening-gap trades left out · bars beyond the scale are cut, with the full value printed</span></div>' +
        '<div class="au-slip-chart">' + s.join('') + '</div>';
}

var AU_SLIP_SORT = {
    exit_at:  function (r) { return r.exit_at; },
    side:     function (r) { return r.side; },
    lots:     function (r) { return r.lots; },
    es:       function (r) { return r.es; },
    eDelay:   function (r) { return r.eDelay; },
    reason:   function (r) { return AU_SLIP_EXIT_LABEL[r.reason] || r.reason; },
    xs:       function (r) { return r.xs; },
    xDelay:   function (r) { return r.xDelay; },
    net:      function (r) { return r.net; },
    slip:     function (r) { return (r.eRs || 0) + (r.xRs || 0); }
};

function auSlipSort(key) {
    if (_auSlip.sort.key === key) _auSlip.sort.dir = -_auSlip.sort.dir;
    else { _auSlip.sort.key = key; _auSlip.sort.dir = (key === 'exit_at') ? -1 : 1; }
    _auSlip.page = 1; _auSlipSave(); auSlipRender();
}
function auSlipPage(p) { _auSlip.page = p; auSlipRender(); }
function auSlipToggle(id) { _auSlip.open[id] = !_auSlip.open[id]; auSlipRender(); }

function _auSlipTrades(rows, unit, full) {
    var key = _auSlip.sort.key, dir = _auSlip.sort.dir, get = AU_SLIP_SORT[key] || AU_SLIP_SORT.exit_at;
    var list = rows.slice().sort(function (a, b) {   // blanks last either way (D.8.2a)
        var x = get(a), y = get(b);
        var xn = (x === null || x === undefined || x === ''), yn = (y === null || y === undefined || y === '');
        if (xn || yn) return xn === yn ? 0 : (xn ? 1 : -1);
        return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
    var per = 10, pages = Math.max(1, Math.ceil(list.length / per));
    if (_auSlip.page > pages) _auSlip.page = pages;
    var pg = list.slice((_auSlip.page - 1) * per, _auSlip.page * per);
    var th = function (k, label, right) {
        var on = key === k;
        return '<th class="au-slip-sortable' + (right ? ' text-right' : '') + '" onclick="auSlipSort(\'' + k + '\')">' + label +
               (on ? ' <span class="au-slip-arrow">' + (dir > 0 ? '▲' : '▼') + '</span>' : '') + '</th>';
    };
    var body = pg.map(function (r) {
        var dt = _auSlipDdMon(r.exit_at);
        var slip = (r.eRs || 0) + (r.xRs || 0);
        var tr = '<tr class="au-slip-row" onclick="auSlipToggle(\'' + r.id + '\')" title="Click for the stop history">' +
            '<td>' + dt + '<div class="au-slip-pc">' + r.exit_ist.time.slice(0, 5) + '</div></td>' +
            '<td>' + (r.side === 'LONG' ? 'Long' : 'Short') + '</td>' +
            '<td class="text-right">' + r.lots + '</td>' +
            _auSlipPts(r.es, null, false) +
            '<td class="text-right">' + (r.eDelay === null ? '—' : r.eDelay.toFixed(1) + ' s') + '</td>' +
            '<td>' + auAt2Esc(AU_SLIP_EXIT_LABEL[r.reason] || r.reason || '—') + (r.gap ? ' <span class="au-slip-gap">gap</span>' : '') + '</td>' +
            _auSlipPts(r.xs, null, false) +
            '<td class="text-right" style="color:#6b7280">' + (r.xDelay !== null ? r.xDelay.toFixed(1) + ' s' : (r.reason === 'STOP' || r.reason === 'TRAIL') ? 'at broker' : '—') + '</td>' +
            _auSlipAmt(r.net, '', false, false) +
            _auSlipAmt(slip, _auSlipPctTxt(slip, r.net), true, true) + '</tr>';
        if (_auSlip.open[r.id]) {
            var hist = r.stops.length ? r.stops.map(function (e) {
                return '<span class="au-slip-stop">' + auAt2Ts(e.at) + ' · ' + (e.kind === 'STOP_PLACED' ? 'placed' : 'moved') + ' ' + auAt2Num(e.price) + '</span>';
            }).join('') : '<span class="au-slip-stop">No stop history recorded.</span>';
            tr += '<tr class="au-slip-hist"><td colspan="10"><b>Stop history</b> ' + hist +
                  '<div class="au-slip-pc">Asked: entry ' + (r.eAsk !== null ? auAt2Num(r.eAsk) : '—') + ', filled ' + auAt2Num(r.eFill, null, 2) +
                  ' · exit ' + (r.xAsk !== null ? auAt2Num(r.xAsk) : '— (' + (r.xNote || 'none') + ')') + ', filled ' + auAt2Num(r.xFill, null, 2) + '</div></td></tr>';
        }
        return tr;
    }).join('');
    var pager = '<div class="au-slip-pager"><span>Showing ' + ((_auSlip.page - 1) * per + 1) + '–' + Math.min(_auSlip.page * per, list.length) + ' of ' + list.length + ' trades</span><span>' +
        '<button class="au-btn au-btn-secondary" ' + (_auSlip.page <= 1 ? 'disabled' : 'onclick="auSlipPage(' + (_auSlip.page - 1) + ')"') + '>‹ Prev</button>';
    for (var p = 1; p <= pages; p++) {
        pager += '<button class="au-btn ' + (p === _auSlip.page ? 'au-btn-primary' : 'au-btn-secondary') + '" onclick="auSlipPage(' + p + ')">' + p + '</button>';
    }
    pager += '<button class="au-btn au-btn-secondary" ' + (_auSlip.page >= pages ? 'disabled' : 'onclick="auSlipPage(' + (_auSlip.page + 1) + ')"') + '>Next ›</button></span></div>';
    var cg = full ? [8, 5, 5, 9, 10, 12, 10, 10, 15.5, 15.5] : [9, 6, 6, 10, 12, 13, 11, 12, 10.5, 10.5];
    return '<div class="au-slip-h">Trades <span class="au-slip-unit">all amounts in ' + unit + '</span>' +
        '<span class="au-slip-sub">click a column header to sort · click a row for its stop history · slippage = entry + exit, with its % of the trade\'s net P&amp;L</span></div>' +
        '<table class="au-at2-table au-slip-table">' + _auSlipCols(cg) + '<thead><tr>' +
        th('exit_at', 'Exit') + th('side', 'Side') + th('lots', 'Lots', 1) + th('es', 'Entry pts', 1) + th('eDelay', 'Entry delay', 1) +
        th('reason', 'Exit type') + th('xs', 'Exit pts', 1) + th('xDelay', 'Exit delay', 1) + th('net', 'Net P&amp;L', 1) + th('slip', 'Slippage', 1) +
        '</tr></thead><tbody>' + body + '</tbody></table>' + pager;
}

window.auSlipOpen = auSlipOpen;
window.auSlipRender = auSlipRender;
window.auSlipSort = auSlipSort;
window.auSlipPage = auSlipPage;
window.auSlipToggle = auSlipToggle;
window.auMs007ChargeRate = auMs007ChargeRate;
window.auMs007ChargeLabel = auMs007ChargeLabel;
