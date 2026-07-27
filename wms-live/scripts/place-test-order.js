// place-test-order.js — Phase 13 Stream 2 seed.
//
// Simulates the moment AFTER an analyst webhook signal has been validated by
// our Edge Function and the order command has reached the Droplet. We
// construct a real Fyers order payload from a hardcoded signal and POST it
// to /api/v3/orders/sync. This validates that:
//   1. The Droplet's whitelisted IP (139.59.67.107) is accepted by Fyers for
//      order placement endpoints (per SEBI April-2026 framework — the
//      requirement we registered for back on 2026-06-16).
//   2. The new SEBI-compliant App ID (CSEZBR93R3-200) accepts orders.
//   3. The order payload format is correct for Fyers v3.
//
// Run from Droplet only (the whitelisted IP), as user `wms`:
//   cd /opt/Vikash-WMS/wms-live
//   node scripts/place-test-order.js
//
// Requires .env with: SUPABASE_URL, SUPABASE_SERVICE_KEY, FYERS_APP_ID.
// Reads the daily Fyers token from investor_broker_accounts (auto-refreshed
// by the fyers-auto-login Edge Function every morning).
//
// Does NOT auto-cancel — owner manages the position via the Fyers app.

import 'dotenv/config';

// ===========================================================================
// Configuration — HARDCODED for first LIVE test. Once the webhook path is
// wired, these will come from the validated signal payload instead.
// ===========================================================================

const TEST_SIGNAL = {
  symbol:      'MCX:SILVERM26JUNFUT',  // SILVERM front-month future
  side:        1,                       // 1 = BUY, -1 = SELL (Fyers v3 spec)
  qty:         1,                       // 1 contract — Fyers uses contract count, not units
  type:        2,                       // 1=LIMIT, 2=MARKET, 3=STOP, 4=STOPLIMIT
  productType: 'MARGIN',                // For MCX commodities (NRML equivalent)
  limitPrice:  0,                       // MARKET — Fyers ignores when type=2
  stopPrice:   0,                       // not a stop order
  disclosedQty: 0,                      // hide nothing
  validity:    'DAY',                   // GTD not supported by all brokers
  offlineOrder: false,                  // false = NOW order (vs AMO)
  stopLoss:    0,
  takeProfit:  0,
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FYERS_APP_ID = process.env.FYERS_APP_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !FYERS_APP_ID) {
  console.error('FATAL: missing env vars. .env must contain SUPABASE_URL, SUPABASE_SERVICE_KEY, FYERS_APP_ID.');
  process.exit(1);
}

const FYERS_BASE = 'https://api-t1.fyers.in';

// ===========================================================================
// 1. Fetch today's Fyers access token from the DB.
//    Same pattern as fyers-market-data, eod-prices-ingest, mcx-candles-ingest.
// ===========================================================================

async function getFyersToken() {
  const today = new Date().toISOString().slice(0, 10);
  const url = `${SUPABASE_URL}/rest/v1/investor_broker_accounts`
    + `?api_token_date=eq.${today}`
    + `&api_access_token=not.is.null`
    + `&select=account_number,api_access_token,api_token_generated_at`
    + `&limit=1`;

  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Token fetch failed: ${res.status} ${await res.text()}`);
  }

  const rows = await res.json();
  if (!rows || rows.length === 0) {
    throw new Error(`No Fyers token in DB for ${today}. Run fyers-auto-login first.`);
  }

  return {
    accountNumber: rows[0].account_number,
    token: rows[0].api_access_token,
    generatedAt: rows[0].api_token_generated_at,
  };
}

// ===========================================================================
// 2. Place the order via Fyers /api/v3/orders/sync.
// ===========================================================================

async function placeOrder(token, signal) {
  const url = `${FYERS_BASE}/api/v3/orders/sync`;

  const payload = {
    symbol:        signal.symbol,
    qty:           signal.qty,
    type:          signal.type,
    side:          signal.side,
    productType:   signal.productType,
    limitPrice:    signal.limitPrice,
    stopPrice:     signal.stopPrice,
    disclosedQty:  signal.disclosedQty,
    validity:      signal.validity,
    offlineOrder:  signal.offlineOrder,
    stopLoss:      signal.stopLoss,
    takeProfit:    signal.takeProfit,
  };

  console.log('[place-order] Request URL :', url);
  console.log('[place-order] Auth header  : Authorization: ' + FYERS_APP_ID + ':<TOKEN>');
  console.log('[place-order] Payload     :', JSON.stringify(payload, null, 2));

  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `${FYERS_APP_ID}:${token}`,
    },
    body: JSON.stringify(payload),
  });
  const dt = Date.now() - t0;

  const bodyText = await res.text();
  let bodyJson = null;
  try { bodyJson = JSON.parse(bodyText); } catch (_e) {}

  return {
    http: res.status,
    elapsedMs: dt,
    bodyJson,
    bodyText,
  };
}

// ===========================================================================
// 3. Main — orchestrate token fetch + order placement + readable output.
// ===========================================================================

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Phase 13 — order placement test from Droplet');
  console.log('  ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════════════');
  console.log();
  console.log('[env] SUPABASE_URL :', SUPABASE_URL);
  console.log('[env] FYERS_APP_ID :', FYERS_APP_ID);
  console.log('[env] SERVICE_KEY  : present (' + SUPABASE_SERVICE_KEY.length + ' chars)');
  console.log();

  console.log('Step 1: Fetching Fyers token from DB...');
  const { accountNumber, token, generatedAt } = await getFyersToken();
  console.log('[token] Account     :', accountNumber);
  console.log('[token] Generated   :', generatedAt);
  console.log('[token] Prefix      :', token.slice(0, 20) + '...');
  console.log();

  console.log('Step 2: Placing order via Fyers /api/v3/orders/sync...');
  console.log();
  const result = await placeOrder(token, TEST_SIGNAL);
  console.log();
  console.log('─── Response ──────────────────────────────────────────────────');
  console.log('[response] HTTP status :', result.http);
  console.log('[response] Elapsed     :', result.elapsedMs + ' ms');

  if (result.bodyJson) {
    console.log('[response] Body (JSON) :');
    console.log(JSON.stringify(result.bodyJson, null, 2));

    // Highlight key fields
    if (result.bodyJson.s === 'ok' && result.bodyJson.id) {
      console.log();
      console.log('✅  ORDER PLACED SUCCESSFULLY');
      console.log('   Order ID    :', result.bodyJson.id);
      console.log('   Message     :', result.bodyJson.message || '(none)');
      console.log();
      console.log('   Check your Fyers app for the open position.');
      console.log('   Cancel/exit manually if needed.');
    } else if (result.bodyJson.s === 'error' || result.bodyJson.code) {
      console.log();
      console.log('❌  ORDER REJECTED');
      console.log('   Fyers code  :', result.bodyJson.code);
      console.log('   Message     :', result.bodyJson.message);
    }
  } else {
    console.log('[response] Body (raw)  :', result.bodyText.slice(0, 500));
    console.log('⚠️  Non-JSON response — see raw body above.');
  }

  console.log();
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error();
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
