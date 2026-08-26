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

  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof window !== 'undefined') {
    window.wmsStore = api;
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
    register('livePrices', {
      policy: 'delegate',
      loader: async function () { if (typeof window.wmsStandardRefresh === 'function') { try { await window.wmsStandardRefresh(false); } catch (e) {} } return window.wmsLivePrices; },
      peek: function () { return window.wmsLivePrices; }
    });
  }
})();
