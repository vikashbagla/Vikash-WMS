// ============================================================================
// wms-store.js — the app-wide data store (ADR-001).
//
// ONE in-memory source of truth for shared datasets. Modules read via
// wmsStore.get(name) instead of fetching their own copy; on reuse the store does
// a cheap change-check and reuses / reconciles rather than re-fetching. This
// generalises the transactions cache (window._wmsTxnCache, LESSONS §A.9.6) to
// every shared dataset. See Documentation/architecture/ADR-001.
//
// Descriptor: { policy, loader, peek, syncState, deltaReconcile, keyBy }
//   'delegate'     loader owns its cache (e.g. wmsLoadTransactions, self-gated).
//   'cache'        STORE-managed: syncState token match -> reuse; changed ->
//                  deltaReconcile (or full reload); no signal -> session-cached.
//   'always-fresh' never cached (live/streaming data).
//   'ttl:<sec>'    reload only when older than N seconds.
// ============================================================================

(function () {
  'use strict';

  var _ds = {};       // name -> descriptor
  var _state = {};    // cacheKey -> { data, token, loadedAt, loading }
  var _subs = {};     // name -> [fn]

  function _keyOf(name, params) {
    var d = _ds[name];
    var k = (d && typeof d.keyBy === 'function') ? d.keyBy(params) : '';
    return name + (k ? '::' + k : '');
  }
  function _st(name, params) {
    var key = _keyOf(name, params);
    return _state[key] || (_state[key] = { data: undefined, token: null, loadedAt: 0, loading: null });
  }
  function _tokEq(a, b) {
    if (a == null || b == null) return false;
    if (typeof a === 'object' && typeof b === 'object') {
      if (a.checksum != null || b.checksum != null) return a.checksum === b.checksum;
      return JSON.stringify(a) === JSON.stringify(b);
    }
    return a === b;
  }
  function _notify(name) {
    var list = _subs[name];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](); } catch (e) { if (typeof console !== 'undefined') console.warn('[wmsStore] subscriber threw for ' + name, e); }
    }
  }

  function register(name, descriptor) { _ds[name] = descriptor || {}; }
  function isRegistered(name) { return !!_ds[name]; }

  function peek(name, params) {
    var d = _ds[name];
    if (d && typeof d.peek === 'function') return d.peek(params);
    var s = _state[_keyOf(name, params)];
    return s ? s.data : undefined;
  }

  function subscribe(name, fn) {
    (_subs[name] = _subs[name] || []).push(fn);
    return function () { var l = _subs[name]; if (l) { var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } };
  }

  function invalidate(name, params) {
    if (params === undefined) {
      Object.keys(_state).forEach(function (k) { if (k === name || k.indexOf(name + '::') === 0) delete _state[k]; });
    } else {
      delete _state[_keyOf(name, params)];
    }
  }

  function get(name, params) {
    var d = _ds[name];
    if (!d) return Promise.reject(new Error('wmsStore: unknown dataset "' + name + '"'));
    var st = _st(name, params);
    st.lastParams = params;
    if (st.loading) return st.loading;

    var policy = d.policy || 'cache';
    var run = (async function () {
      if (policy === 'delegate') {
        var out = await d.loader(params);
        st.data = (out !== undefined) ? out : (typeof d.peek === 'function' ? d.peek(params) : st.data);
        _notify(name);
        return st.data;
      }
      if (policy === 'always-fresh') {
        st.data = await d.loader(params); st.loadedAt = Date.now(); _notify(name); return st.data;
      }
      if (typeof policy === 'string' && policy.indexOf('ttl:') === 0) {
        var ttlMs = (parseInt(policy.slice(4), 10) || 0) * 1000;
        if (st.data === undefined || (Date.now() - st.loadedAt) > ttlMs) {
          st.data = await d.loader(params); st.loadedAt = Date.now(); _notify(name);
        }
        return st.data;
      }
      if (st.data === undefined || st.token == null) {
        st.data = await d.loader(params);
        try { st.token = d.syncState ? await d.syncState(params) : null; } catch (e) { st.token = null; }
        st.loadedAt = Date.now(); _notify(name);
        return st.data;
      }
      if (!d.syncState) return st.data;
      var tok;
      try { tok = await d.syncState(params); }
      catch (e) { st.data = await d.loader(params); st.token = null; st.loadedAt = Date.now(); _notify(name); return st.data; }
      if (_tokEq(tok, st.token)) return st.data;
      var ok = false;
      if (typeof d.deltaReconcile === 'function') { try { ok = await d.deltaReconcile(st, params); } catch (e) { ok = false; } }
      if (!ok) st.data = await d.loader(params);
      st.token = tok; st.loadedAt = Date.now(); _notify(name);
      return st.data;
    })();

    st.loading = run;
    return run.then(function (v) { st.loading = null; return v; },
                    function (e) { st.loading = null; throw e; });
  }

  function refresh(name, params) { return get(name, params); }

  function applyLocalWrite(name, mutate, params) {
    var st = _st(name, params);
    if (typeof mutate === 'function') mutate(st.data);
    _notify(name);
  }

  var api = {
    register: register, isRegistered: isRegistered, get: get, refresh: refresh, peek: peek,
    subscribe: subscribe, invalidate: invalidate, applyLocalWrite: applyLocalWrite,
    _datasets: _ds, _state: _state
  };

  // ---- Data self-check (ADR-001) --------------------------------------------
  // For every store-managed ('cache') dataset currently held, fetch a FRESH copy
  // from the DB and compare it to what is cached — proving the on-screen data
  // equals the database, with no eyeballing. Run in the browser console:
  //     await wmsStoreVerify()
  function _hash(v) {
    var str = JSON.stringify(v);
    var h = 5381; for (var i = 0; i < str.length; i++) { h = ((h << 5) + h) ^ str.charCodeAt(i); }
    return (h >>> 0).toString(16) + ':' + str.length;
  }
  async function verify() {
    var out = [];
    for (var key in _state) {
      var name = key.indexOf('::') >= 0 ? key.slice(0, key.indexOf('::')) : key;
      var d = _ds[name];
      var st = _state[key];
      if (!d || d.policy !== 'cache' || st.data === undefined) continue;
      var line = { dataset: key, ok: false, detail: '' };
      try {
        var fresh = await d.loader(st.lastParams);
        var cachedRows = Array.isArray(st.data) ? st.data.length : (st.data && st.data.rows ? st.data.rows.length : (st.data ? 1 : 0));
        var freshRows = Array.isArray(fresh) ? fresh.length : (fresh && fresh.rows ? fresh.rows.length : (fresh ? 1 : 0));
        var ch = _hash(st.data), fh = _hash(fresh);
        line.ok = (ch === fh);
        line.detail = 'cached ' + cachedRows + ' rows [' + ch + '] vs DB ' + freshRows + ' rows [' + fh + ']';
      } catch (e) { line.detail = 'fetch failed: ' + (e && e.message); }
      out.push(line);
      if (typeof console !== 'undefined') console.log((line.ok ? '\u2705 PASS ' : '\u274c FAIL ') + line.dataset + ' \u2014 ' + line.detail);
    }
    var fails = out.filter(function (x) { return !x.ok; }).length;
    if (typeof console !== 'undefined') console.log(fails ? ('\u274c ' + fails + ' dataset(s) DIFFER from the DB') : ('\u2705 all ' + out.length + ' cached datasets match the DB'));
    return out;
  }
  api.verify = verify;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof window !== 'undefined') {
    window.wmsStore = api;
    window.wmsStoreVerify = verify;
    // Phase 1 registrations — the three already-shared caches as DELEGATES.
    register('transactions', {
      policy: 'delegate',
      loader: async function () { if (typeof window.wmsLoadTransactions === 'function') await window.wmsLoadTransactions(); return window._wmsTxnCache ? window._wmsTxnCache.rows : []; },
      peek: function () { return window._wmsTxnCache ? window._wmsTxnCache.rows : undefined; }
    });
    register('refData', {
      policy: 'delegate',
      loader: async function () { if (window.wmsRefData && !window.wmsRefData.ready && typeof window.wmsLoadRefData === 'function') await window.wmsLoadRefData(); return window.wmsRefData; },
      peek: function () { return window.wmsRefData; }
    });
    // Leverage balances (Brokers/Traders/Cash&Bank Dr-Cr) for a set of accounting
    // books — the Trading banner's Leverage metric (§A.21). Keyed by the book-id set
    // (the Consolidation page's selection). Change-signal = the acct_vouchers probe.
    var _wmsLevSync = function (ids) {
        if (!ids || !ids.length) return Promise.resolve({ checksum: 'empty' });
        var filter = ids.length === 1 ? ('investor_id=eq.' + ids[0]) : ('investor_id=in.(' + ids.join(',') + ')');
        return fetch(SUPABASE_URL + '/rest/v1/acct_vouchers?' + filter + '&select=updated_at&order=updated_at.desc&limit=1', { headers: wmsHeaders({ Prefer: 'count=exact' }) })
            .then(function (res) { if (!res.ok) return null; var cr = res.headers.get('content-range'); var total = cr ? cr.split('/')[1] : '?'; return res.json().then(function (rows) { return { checksum: total + '|' + ((rows && rows[0]) ? rows[0].updated_at : '?') }; }); })
            .catch(function () { return null; });
    };
    register('leverageBalances', {
        policy: 'cache',
        keyBy: function (pr) { return (pr && pr.ids) ? pr.ids.slice().sort().join(',') : ''; },
        loader: function (pr) {
            var ids = (pr && pr.ids) || [];
            if (!ids.length) return Promise.resolve({ brokers: 0, traders: 0, cash_bank: 0 });
            return fetch(SUPABASE_URL + '/rest/v1/rpc/leverage_balances', { method: 'POST', headers: wmsHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ p_book_ids: ids }) })
                .then(function (res) { return res.ok ? res.json() : null; })
                .then(function (rows) { var r = Array.isArray(rows) ? rows[0] : rows; return r ? { brokers: Number(r.brokers) || 0, traders: Number(r.traders) || 0, cash_bank: Number(r.cash_bank) || 0 } : { brokers: 0, traders: 0, cash_bank: 0 }; });
        },
        syncState: function (pr) { return _wmsLevSync((pr && pr.ids) || []); }
    });
    register('livePrices', {
      policy: 'delegate',
      loader: async function () { if (typeof window.wmsStandardRefresh === 'function') { try { await window.wmsStandardRefresh(false); } catch (e) {} } return window.wmsLivePrices; },
      peek: function () { return window.wmsLivePrices; }
    });
  }
})();
