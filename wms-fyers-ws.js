// =============================================================================
// wms-fyers-ws.js — Fyers v3 Data WebSocket client
// =============================================================================
//
// PHASE 1 (current): LOGGER-ONLY MODE.
//   • Runs only on dev environment (WMS_ENV === 'dev'). Production untouched.
//   • Connects to Fyers Data WS, subscribes to a small test set of symbols.
//   • Logs every message to console (including binary frames as hex preview).
//   • DOES NOT write to wmsLivePrices, DOES NOT touch wmsStandardRefresh,
//     DOES NOT alter any UI. Pure observation.
//
// Goal of Phase 1: confirm connection works, see actual subscribe message
//   shape Fyers accepts, see actual tick frame format. Phase 2 wires writes
//   in based on what we observe.
//
// See WMS Claude/LIVE-PRICES-WS-SPEC.md for the full phase plan.
// See WMS-LESSONS.md §E.11 + §B.8A for the live-price architecture
// this will eventually integrate into.
//
// Fyers v3 Data WS facts (verified 2026-05-19):
//   Endpoint:    wss://api.fyers.in/socket/v2/data/
//   Auth:        access_token in URL query string (format: APPID:ACCESSTOKEN)
//   Modes:       'lite' (LTP only), 'symbolUpdate' (OHLCV + day H/L)
//   Sub limit:   5,000 unique symbols per API key
//   We use:      symbolUpdate (need day H/L for Watchlist, OHLCV for everything)
//
// Refs:
//   • https://support.fyers.in/portal/en/kb/articles/how-can-i-use-the-data-websocket-in-api-v3-to-access-real-time-data
//   • https://support.fyers.in/portal/en/kb/articles/is-there-a-limit-to-the-number-of-symbols-i-can-track-using-the-data-websocket-in-api-v3
// =============================================================================

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Phase 1 safety gates
  // ---------------------------------------------------------------------------
  // 1. Only run on dev environment. Per WMS-LESSONS A.8 — production untouched.
  // 2. Only run if owner explicitly opts in via window._wmsWsEnabled = true OR
  //    by default in dev. Allows quick disable from console if anything misbehaves.

  var IS_DEV = (window.WMS_ENV === 'dev');
  if (!IS_DEV) {
    console.log('[wms-fyers-ws] Skipping — not dev environment.');
    return;
  }

  // Allow runtime disable via console:  window._wmsWsEnabled = false
  // Default: enabled in dev
  if (window._wmsWsEnabled === false) {
    console.log('[wms-fyers-ws] Skipping — window._wmsWsEnabled is false.');
    return;
  }

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  var WS_ENDPOINT = 'wss://api.fyers.in/socket/v2/data/';
  var FYERS_APP_ID = '88XL3K3R7R';  // public app id — same as our edge functions use

  // Phase 1 test universe: a hardcoded mix covering every instrument type we care about.
  // Once we validate the protocol, Phase 2 will populate this dynamically from
  // wmsRefreshSymbols (the same list wmsBuildRefreshSymbols generates).
  var PHASE1_TEST_SYMBOLS = [
    'NSE:RELIANCE-EQ',        // big-cap equity
    'NSE:HDFCBANK-EQ',        // bank
    'NSE:NIFTY50-INDEX',      // index
    'MCX:SILVERM26JUNFUT',    // MCX commodity (front-month) — silver mini
    'MCX:GOLDM26JUNFUT'       // MCX commodity (front-month) — gold mini
  ];

  // Reconnect backoff
  var BACKOFF_INITIAL_MS = 1000;
  var BACKOFF_MAX_MS = 30000;
  var backoffMs = BACKOFF_INITIAL_MS;

  // State
  var ws = null;
  var connectAttempts = 0;
  var lastMessageAt = null;
  var messageCount = 0;
  var binaryMessageCount = 0;
  var textMessageCount = 0;

  // ---------------------------------------------------------------------------
  // Logging helpers — keep it readable in the console
  // ---------------------------------------------------------------------------
  var COLOR_INFO = 'color:#667eea';            // brand purple
  var COLOR_OK = 'color:#059669;font-weight:600';  // green
  var COLOR_ERR = 'color:#dc2626;font-weight:600'; // red
  var COLOR_TICK = 'color:#6b7280';            // grey for high-volume tick logs

  function logInfo(msg, data) {
    console.log('%c[wms-fyers-ws]%c ' + msg, COLOR_INFO, '', data !== undefined ? data : '');
  }
  function logOk(msg, data) {
    console.log('%c[wms-fyers-ws]%c ' + msg, COLOR_OK, '', data !== undefined ? data : '');
  }
  function logErr(msg, data) {
    console.error('%c[wms-fyers-ws]%c ' + msg, COLOR_ERR, '', data !== undefined ? data : '');
  }
  function logTick(msg, data) {
    console.log('%c[wms-fyers-ws-tick]%c ' + msg, COLOR_TICK, '', data !== undefined ? data : '');
  }

  // Convert an ArrayBuffer to a short hex preview for console logging
  function bufferPreview(buffer, maxBytes) {
    if (!(buffer instanceof ArrayBuffer)) return String(buffer);
    var view = new Uint8Array(buffer);
    var limit = Math.min(view.length, maxBytes || 64);
    var hex = [];
    for (var i = 0; i < limit; i++) {
      hex.push(view[i].toString(16).padStart(2, '0'));
    }
    return '<' + view.length + ' bytes> ' + hex.join(' ') + (view.length > limit ? ' …' : '');
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------
  function connect() {
    var token = window._wmsFyersAccessToken;
    if (!token) {
      logErr('No Fyers access token in memory (window._wmsFyersAccessToken). Waiting 5s and retrying.');
      setTimeout(connect, 5000);
      return;
    }

    connectAttempts++;
    var authStr = FYERS_APP_ID + ':' + token;
    // Several Fyers SDK examples put the token in the URL query string.
    // We try that first; if it fails we'll iterate based on the error.
    var url = WS_ENDPOINT + '?access_token=' + encodeURIComponent(authStr) + '&type=symbolUpdate';

    logInfo('Attempt ' + connectAttempts + ' — connecting to ' + WS_ENDPOINT);
    logInfo('Test symbols (Phase 1):', PHASE1_TEST_SYMBOLS);

    try {
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';  // Fyers sends binary tick frames
    } catch (e) {
      logErr('WebSocket constructor threw:', e);
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', onOpen);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onError);
  }

  function onOpen() {
    logOk('WS open ✓ (attempt ' + connectAttempts + ')');
    backoffMs = BACKOFF_INITIAL_MS;  // reset backoff on successful connect

    // Send a subscribe message. Format below is the most common shape from
    // Fyers SDK examples; if Fyers rejects, the response (logged in onMessage)
    // will tell us what shape to use instead. THIS IS THE KEY PHASE-1 PROBE.
    var subscribePayload = {
      T: 'SUB_DATA',           // Fyers v3 SDK observed convention
      TLIST: PHASE1_TEST_SYMBOLS,
      SUB_T: 1                 // 1 = subscribe (0 = unsubscribe)
    };
    logInfo('Sending subscribe →', subscribePayload);
    try {
      ws.send(JSON.stringify(subscribePayload));
    } catch (e) {
      logErr('subscribe send failed:', e);
    }
  }

  function onMessage(evt) {
    lastMessageAt = Date.now();
    messageCount++;

    if (evt.data instanceof ArrayBuffer) {
      binaryMessageCount++;
      // Binary frame — log preview only (first N bytes as hex). Don't try to
      // parse yet; we'll add a parser in Phase 2 once we see real ticks.
      if (binaryMessageCount <= 10) {
        // First 10 binary messages — log each for shape analysis
        logTick('binary #' + binaryMessageCount + ' ' + bufferPreview(evt.data, 64));
      } else if (binaryMessageCount % 50 === 0) {
        // Then sample every 50th to avoid console spam
        logTick('binary #' + binaryMessageCount + ' (sampling 1/50) ' + bufferPreview(evt.data, 32));
      }
    } else if (typeof evt.data === 'string') {
      textMessageCount++;
      // Text frame — usually subscribe ack, errors, server pings. Log every one.
      logInfo('text msg #' + textMessageCount + ':', evt.data);
      // If it looks like JSON, also log parsed form
      if (evt.data.charAt(0) === '{' || evt.data.charAt(0) === '[') {
        try {
          logInfo('text msg #' + textMessageCount + ' parsed:', JSON.parse(evt.data));
        } catch (e) { /* not JSON, that's fine */ }
      }
    } else {
      logInfo('other msg type:', typeof evt.data, evt.data);
    }
  }

  function onClose(evt) {
    logErr('WS closed — code ' + evt.code + ', reason "' + (evt.reason || '(none)') +
           '", wasClean=' + evt.wasClean + ', received ' + messageCount + ' messages (' +
           textMessageCount + ' text, ' + binaryMessageCount + ' binary)');
    ws = null;
    scheduleReconnect();
  }

  function onError(evt) {
    // 'error' on WS doesn't give much detail (security restriction in browsers).
    // 'close' will follow with the actual code. Just note it happened.
    logErr('WS error event (close will follow with code)');
  }

  function scheduleReconnect() {
    var delay = backoffMs;
    logInfo('Reconnect in ' + (delay / 1000).toFixed(1) + 's …');
    setTimeout(connect, delay);
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  }

  // ---------------------------------------------------------------------------
  // Public hooks for console debugging (Phase 1 only)
  // ---------------------------------------------------------------------------
  window._wmsWsDebug = {
    get state() {
      if (!ws) return 'CLOSED';
      switch (ws.readyState) {
        case 0: return 'CONNECTING';
        case 1: return 'OPEN';
        case 2: return 'CLOSING';
        case 3: return 'CLOSED';
        default: return 'UNKNOWN';
      }
    },
    get stats() {
      return {
        connectAttempts: connectAttempts,
        messageCount: messageCount,
        textMessageCount: textMessageCount,
        binaryMessageCount: binaryMessageCount,
        lastMessageAt: lastMessageAt ? new Date(lastMessageAt).toLocaleTimeString('en-IN') : null,
        subscribedSymbols: PHASE1_TEST_SYMBOLS
      };
    },
    forceReconnect: function () {
      logInfo('Force reconnect requested via console');
      if (ws) { try { ws.close(1000, 'manual reconnect'); } catch (e) {} }
      backoffMs = BACKOFF_INITIAL_MS;
      setTimeout(connect, 100);
    },
    disconnect: function () {
      logInfo('Manual disconnect via console (will not auto-reconnect this session)');
      window._wmsWsEnabled = false;
      if (ws) { try { ws.close(1000, 'manual disconnect'); } catch (e) {} }
      ws = null;
    },
    sendRaw: function (payload) {
      // Useful for trying alternate subscribe shapes if SUB_DATA doesn't work
      if (!ws || ws.readyState !== 1) {
        logErr('WS not open; cannot send.');
        return;
      }
      var str = (typeof payload === 'string') ? payload : JSON.stringify(payload);
      logInfo('Manual send →', str);
      ws.send(str);
    }
  };

  // ---------------------------------------------------------------------------
  // Bootstrap — wait for master data + Fyers auth, then connect
  // ---------------------------------------------------------------------------
  // Per WMS-LESSONS H.4.1, app startup blocks on Promise.all([
  //   wmsLoadRefData, wmsLoadSecuritiesCm, wmsLoadSecuritiesNfo
  // ]). We poll for window._wmsFyersAccessToken because checkFyersAuth() runs
  // independently of the master-data loaders. Once both are ready, connect.

  function waitForReadyThenConnect() {
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      var tokenReady = !!window._wmsFyersAccessToken;
      var dataReady = window.wmsRefData && window.wmsRefData.securitiesCmReady;
      if (tokenReady && dataReady) {
        clearInterval(iv);
        logOk('Ready (token + master data loaded). Connecting in 1s …');
        setTimeout(connect, 1000);
      } else if (tries > 120) {  // 2 minutes
        clearInterval(iv);
        logErr('Gave up waiting after 2 min — tokenReady=' + tokenReady +
               ', dataReady=' + dataReady + '. Run window._wmsWsDebug.forceReconnect() ' +
               'manually after fixing whatever is missing.');
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForReadyThenConnect);
  } else {
    waitForReadyThenConnect();
  }

  logInfo('Module loaded (dev only, Phase 1 logger mode). Waiting for app boot to complete.');
})();
