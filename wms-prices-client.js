// wms-prices-client.js — real-time price relay (subscriber side)
// ============================================================================
// Subscribes to the Supabase Realtime "wms-prices" channel, which the Droplet's
// wms-prices service (Fyers Data WS) broadcasts ticks to. Writes each tick into
// the shared wmsLivePrices cache (same shape every consumer already reads) and
// re-renders. REST polling (wmsStandardRefresh) stays as the automatic fallback
// when the channel is quiet or down — this only makes the cache fresher, faster.
// ============================================================================
(function () {
  var CHANNEL = 'wms-prices';
  var _renderTimer = null;

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

  function start() {
    if (!window.supabaseClient) { setTimeout(start, 1000); return; }
    try {
      var ch = window.supabaseClient.channel(CHANNEL);
      ch.on('broadcast', { event: 'ticks' }, function (msg) {
        var t = msg && msg.payload && msg.payload.t;
        if (!Array.isArray(t)) return;
        for (var i = 0; i < t.length; i++) applyTick(t[i]);
        window._wmsPricesWsLastMsg = Date.now();
        scheduleRender();
      }).subscribe(function (status) {
        window._wmsPricesWsStatus = status;
        if (status === 'SUBSCRIBED') console.log('[wms-prices-client] live on Realtime channel:', CHANNEL);
      });
      window._wmsPricesChannel = ch;
    } catch (e) { console.warn('[wms-prices-client] subscribe failed', e); }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') start();
  else window.addEventListener('DOMContentLoaded', start);
})();
