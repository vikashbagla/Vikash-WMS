// wms-prices-client.js — real-time price relay (subscriber side)
// ============================================================================
// Subscribes to the Supabase Realtime "wms-prices" channel, which the Droplet's
// wms-prices service (Fyers Data WS) broadcasts ticks to. Writes each tick into
// the shared wmsLivePrices cache (same shape every consumer already reads) and
// re-renders. REST polling (wmsStandardRefresh) stays as the automatic fallback
// when the channel is quiet or down — this only makes the cache fresher, faster.
//
// LEADER-ONLY (egress dedup, 2026-09-03): every subscribed tab receives the
// Droplet's ~1/sec broadcast, so N open tabs = N× Realtime egress. Only the
// tab-sync LEADER now holds the subscription; followers stay unsubscribed and
// get these prices via the shared cache + the leader's tab-sync price push /
// the 10s REST fallback. One browser => one subscription regardless of tabs.
// ============================================================================
(function () {
  var CHANNEL = 'wms-prices';
  var _renderTimer = null, _ch = null, _subscribed = false, _t0 = Date.now();

  function scheduleRender() {
    if (_renderTimer) return;
    _renderTimer = setTimeout(function () {
      _renderTimer = null;
      try { if (typeof autoOnSharedRefresh === 'function') autoOnSharedRefresh(); } catch (e) {}
      // Scalp open-trades P&L (silent = don't trigger a REST fetch; the tick IS the fresh data)
      try { if (typeof auScalpRenderOpen === 'function') { auScalpRenderOpen('paper', true); auScalpRenderOpen('live', true); } } catch (e) {}
    }, 250);
  }

  function applyTick(t) {
    if (!t || !t.s || typeof window.wmsLivePrices === 'undefined' || !window.wmsLivePrices) return;
    var full = t.s;                              // e.g. MCX:SILVERMIC26NOVFUT
    var bare = full.replace(/^[A-Z]+:/, '');     // SILVERMIC26NOVFUT  (E.11.10 cache-key convention)
    var val = { lp: t.lp, ch: t.ch, chp: t.chp, high: t.h, low: t.l, resolvedSymbol: full };
    window.wmsLivePrices[full] = val;
    window.wmsLivePrices[bare] = val;
  }

  function onBroadcast(msg) {
    var t = msg && msg.payload && msg.payload.t;
    if (!Array.isArray(t)) return;
    for (var i = 0; i < t.length; i++) applyTick(t[i]);
    window._wmsPricesWsLastMsg = Date.now();
    scheduleRender();
  }

  function subscribe() {
    if (_subscribed || !window.supabaseClient) return;
    try {
      _ch = window.supabaseClient.channel(CHANNEL);
      _ch.on('broadcast', { event: 'ticks' }, onBroadcast).subscribe(function (status) {
        window._wmsPricesWsStatus = status;
        if (status === 'SUBSCRIBED') console.log('[wms-prices-client] live on Realtime channel (leader):', CHANNEL);
      });
      window._wmsPricesChannel = _ch;
      _subscribed = true;
    } catch (e) { console.warn('[wms-prices-client] subscribe failed', e); }
  }

  function unsubscribe() {
    if (!_subscribed) return;
    try { if (_ch && window.supabaseClient) window.supabaseClient.removeChannel(_ch); } catch (e) {}
    _ch = null; window._wmsPricesChannel = null; _subscribed = false;
    window._wmsPricesWsStatus = 'UNSUBSCRIBED';
  }

  // Hold the subscription only while this tab is the leader. A confirmed follower
  // never subscribes (that's the egress saving). If the tab-sync role never resolves
  // (unexpected), fall back to subscribing after a grace window so the feed is never
  // dead. Runs on a light timer so a leadership change (leader tab closes -> a
  // follower promotes) is followed within a couple of seconds.
  function reconcile() {
    if (!window.supabaseClient) return;
    var ready = !!window._wmsTabSyncReady;
    var isLeader = !!window.wmsTabIsLeader;
    if (ready && !isLeader) { unsubscribe(); return; }           // confirmed follower -> drop it
    if (isLeader || (Date.now() - _t0 > 8000)) { subscribe(); }  // leader, or grace-window fallback
  }

  function start() {
    if (!window.supabaseClient) { setTimeout(start, 1000); return; }
    reconcile();
    setInterval(reconcile, 2500);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') start();
  else window.addEventListener('DOMContentLoaded', start);
})();
