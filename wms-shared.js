// ============================================================================
// WMS SHARED MODULE — Canonical implementations used across the entire app.
// Any function here MUST NOT be duplicated elsewhere.
// See WMS-LESSONS.md Section B.6-B.9 for shared code rules and inventory.
//
// Naming: all shared functions use `wms` prefix.
// Loading: this file is loaded in app.html AFTER utils.js, BEFORE feature modules.
// Rule: use `var` for all declarations (Rule A.1.2 — avoid TDZ on script reload).
// ============================================================================

// ============================================================================
// AUTH HEADERS — Single source of truth for all Supabase REST API calls.
// Phase 1A: returns anon key (identical to current behavior).
// Phase 1B: will return session JWT after Google OAuth login.
// ============================================================================

/** Auth token — set after OAuth login, null = fall back to anon key */
var _wmsAuthToken = null;

/**
 * Build Supabase REST headers with the current auth token.
 * @param {Object} [extra] — additional headers to merge (e.g. Content-Type, Prefer)
 * @returns {Object} headers object ready for fetch()
 */
function wmsHeaders(extra) {
    var token = _wmsAuthToken || SUPABASE_ANON_KEY;
    var h = { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token };
    if (extra) { for (var k in extra) h[k] = extra[k]; }
    return h;
}

/**
 * Build headers for Supabase Edge Function calls.
 * Edge functions use SERVICE_ROLE_KEY internally; gateway needs anon key.
 * The user's JWT is passed as x-user-token for auth verification inside
 * the edge function (prevents anonymous callers from invoking functions).
 * @param {Object} [extra] — additional headers to merge
 * @returns {Object} headers object ready for fetch()
 */
function wmsEdgeHeaders(extra) {
    var h = { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY };
    if (_wmsAuthToken) { h['x-user-token'] = _wmsAuthToken; }
    if (extra) { for (var k in extra) h[k] = extra[k]; }
    return h;
}

// ============================================================================
// CONSTANTS
// ============================================================================

var WMS_MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
var WMS_WEEKLY_EXPIRY_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];
var WMS_INCOME_TYPES = ['DIVIDEND', 'INTEREST', 'OTHER_INCOME', 'CAPITAL_REDUCTION'];
var WMS_TDS_DEFAULT_RATE = 0.10; // 10% TDS — TODO: move to DB config table (see G.8.1). Income tax rate already moved to DB (wmsGetTaxRate).

// Transaction types whose quantity does NOT count toward holdings/balance.
// Income types carry a quantity for display but don't change holdings.
// RIGHTS_PAYMENT stores qty for audit (units paid for) but doesn't change holdings.
var WMS_QTY_EXCLUDED_TYPES = ['DIVIDEND', 'INTEREST', 'OTHER_INCOME', 'CAPITAL_REDUCTION', 'RIGHTS_PAYMENT', 'HISTORICAL_PL'];

/**
 * Check if a transaction type's quantity should be excluded from holdings.
 * Use this everywhere instead of inline income-type checks.
 */
function wmsIsQtyExcluded(transactionType) {
    return WMS_QTY_EXCLUDED_TYPES.indexOf(transactionType) >= 0;
}

// ============================================================================
// SUPABASE ERROR PARSER — Turns raw Supabase/PostgREST JSON errors into
// short, human-readable messages for showAlert(). Full details go to console.
// Usage: catch(e) { wmsShowError('Save failed', e); }
// ============================================================================

/**
 * Parse a Supabase/PostgREST error and show a friendly toast.
 * @param {string} prefix  — short context, e.g. "Rights entitlement save failed"
 * @param {Error|string} err — the caught error (Error object or raw string)
 * @param {number} [duration] — toast duration in ms (default 6000)
 */
function wmsShowError(prefix, err, duration) {
    duration = duration || 6000;
    var raw = (err && err.message) ? err.message : String(err || '');
    var friendly = '';

    // Try to extract Supabase JSON body from "DB error: 4xx — {...}" pattern
    var jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            var parsed = JSON.parse(jsonMatch[0]);
            // Map common PostgreSQL error codes to plain language
            var code = parsed.code || '';
            var msg = parsed.message || '';
            if (code === '23505') {
                friendly = 'Duplicate entry — a record with these details already exists.';
            } else if (code === '23514') {
                // CHECK constraint violation — extract constraint name
                var cName = (msg.match(/constraint "([^"]+)"/) || [])[1] || '';
                if (cName.indexOf('transaction_type') >= 0) {
                    friendly = 'Invalid transaction type. Check if the DB constraint has been updated.';
                } else if (cName.indexOf('quantity') >= 0) {
                    friendly = 'Quantity must not be zero.';
                } else {
                    friendly = 'Data validation failed' + (cName ? ' (' + cName + ')' : '') + '.';
                }
            } else if (code === '23503') {
                friendly = 'Referenced record not found (foreign key error).';
            } else if (code === '42501') {
                friendly = 'Permission denied — check Supabase RLS policies.';
            } else if (code === '42P01') {
                friendly = 'Table not found — check database schema.';
            } else if (msg) {
                // Fallback: use the message but trim technical prefix
                friendly = msg.replace(/^new row for relation "[^"]+" violates check constraint "[^"]+"/, 'Data validation failed.');
            }
            // Always log the full details for debugging
            console.error(prefix + ':', parsed);
        } catch (ignore) {
            // JSON parse failed — fall through to raw message
        }
    }

    if (!friendly) {
        // Non-JSON error or parse failed — show a trimmed version
        if (raw.length > 120) {
            friendly = raw.substring(0, 120) + '…';
        } else {
            friendly = raw || 'Unknown error';
        }
        console.error(prefix + ':', raw);
    }

    showAlert(prefix + ': ' + friendly, 'error', duration);
}

// ============================================================================
// SHARED REFERENCE DATA — loaded once at app startup, refreshed after edits.
// Feature modules read from these instead of loading their own copies.
// ============================================================================

var wmsRefData = {
    investors: [],       // Array of {id, name, short_name, stt_accounting_method, financial_year_start}
    brokers: [],         // Array of {id, name, broker_code}
    investorObjMap: {},  // id → investor object
    brokerObjMap: {},    // id → broker object
    investorCache: {},   // lowercase name/short_name → id (for Excel import matching)
    brokerCache: {},     // lowercase name/broker_code → id (for Excel import matching)
    ibaRatesMap: {},     // "investorId|brokerId" → {rates, charges_inclusive}
    regCharges: [],      // Array from regulatory_charges_config (active only)
    tags: [],            // Sorted array of distinct tag strings
    ready: false,        // True after initial load completes

    // Securities master data — loaded once at startup, refreshed after sync
    securitiesCm: [],        // All rows from securities_db
    securitiesNfo: [],       // All rows from securities_nfo
    securitiesCmMap: {},     // id → row (O(1) lookups)
    securitiesNfoMap: {},    // id → row (O(1) lookups)
    securitiesCmReady: false,
    securitiesNfoReady: false,

    // Per-master change tokens from masters_sync_state() — the baseline the background
    // cadence compares against to keep the in-memory masters current (§A.4.4b).
    _masterTokens: {}
};

/**
 * Load all reference data from Supabase. Called once at app startup.
 * Feature modules should check wmsRefData.ready before using data.
 * After master data edits (investors, brokers, IBA, reg charges), call this again.
 */
async function wmsLoadRefData() {
    try {
        await wmsReloadRefMastersOnly();

        // 5. Tags autocomplete list — derived from trTransactions, NOT from a
        // separate DB query. Trading's `trLoadData()` populates this via
        // `wmsRefreshTagsFromTransactions(trTransactions)` AFTER the full
        // transaction set is loaded, so the tag list always reflects the
        // current in-memory state. This avoids an extra DB round-trip at
        // app start AND avoids the LESSONS A.1.14 trap (Supabase capping a
        // separate query at 1000 rows and silently dropping newer tags).
        // Initialise empty here so non-Trading modules can still safely
        // read `wmsRefData.tags || []` before Trading loads.
        // 2026-05-12: previously fetched directly here, but 'advNA' was
        // missing from the Add Transaction dropdown because the book grew
        // past 1000 rows and the newest tags fell off the truncated query.
        wmsRefData.tags = [];

        wmsRefData.ready = true;
        console.log('WMS ref data loaded: ' + (wmsRefData.investors || []).length + ' investors, ' + (wmsRefData.brokers || []).length + ' brokers, ' + (wmsRefData.regCharges || []).length + ' reg charges (tags derived from trTransactions by Trading module)');
    } catch (e) {
        console.error('WMS ref data load error:', e);
    }
}

// Load ONLY the small reference masters (investors, brokers, IBA rates, regulatory charges) +
// their lookup maps. Extracted from wmsLoadRefData so the background master delta-sync can reload
// them on a checksum change without touching tags / the `ready` flag / the securities masters. (§A.4.4b)
async function wmsReloadRefMastersOnly() {
    var headers = wmsHeaders();
    var resp;

    // 1. Investors
    resp = await fetch(SUPABASE_URL + '/rest/v1/investors?select=id,name,short_name,stt_accounting_method,financial_year_start,interest_terms,tax_rate,accounting_enabled,book_parent_id,post_fno,books_closed_upto&is_active=eq.true', { headers: headers });
    var investors = await resp.json();
    wmsRefData.investors = investors;
    wmsRefData.investorObjMap = {};
    wmsRefData.investorCache = {};
    investors.forEach(function(inv) {
        wmsRefData.investorObjMap[inv.id] = inv;
        if (inv.name) wmsRefData.investorCache[inv.name.toLowerCase()] = inv.id;
        if (inv.short_name) wmsRefData.investorCache[inv.short_name.toLowerCase()] = inv.id;
    });

    // 2. Brokers
    resp = await fetch(SUPABASE_URL + '/rest/v1/brokers?select=id,name,broker_code&is_active=eq.true', { headers: headers });
    var brokers = await resp.json();
    wmsRefData.brokers = brokers;
    wmsRefData.brokerObjMap = {};
    wmsRefData.brokerCache = {};
    brokers.forEach(function(brk) {
        wmsRefData.brokerObjMap[brk.id] = brk;
        if (brk.name) wmsRefData.brokerCache[brk.name.toLowerCase()] = brk.id;
        if (brk.broker_code) wmsRefData.brokerCache[brk.broker_code.toLowerCase()] = brk.id;
    });

    // 3. IBA rates (investor_broker_accounts with brokerage_rates + charges_inclusive + ledger fields)
    resp = await fetch(SUPABASE_URL + '/rest/v1/investor_broker_accounts?select=investor_id,broker_id,brokerage_rates,charges_inclusive,interest_terms,margin_rate,tax_rate&is_active=eq.true', { headers: headers });
    var ibAccounts = await resp.json();
    wmsRefData.ibaRatesMap = {};
    ibAccounts.forEach(function(iba) {
        var key = iba.investor_id + '|' + iba.broker_id;
        wmsRefData.ibaRatesMap[key] = {
            rates: iba.brokerage_rates || null,
            charges_inclusive: !!iba.charges_inclusive,
            interest_terms: iba.interest_terms || null,
            margin_rate: parseFloat(iba.margin_rate) || 0,
            tax_rate: (iba.tax_rate != null) ? parseFloat(iba.tax_rate) : null
        };
    });

    // 4. Regulatory charges (active only — effective_to IS NULL)
    resp = await fetch(SUPABASE_URL + '/rest/v1/regulatory_charges_config?effective_to=is.null&select=*', { headers: headers });
    wmsRefData.regCharges = await resp.json();
    wmsRefData.regChargesIndex = {};
    wmsRefData.regCharges.forEach(function(rc) {
        var key = rc.charge_type + '|' + rc.transaction_category + '|' + rc.transaction_type + '|' + rc.exchange;
        wmsRefData.regChargesIndex[key] = rc.rate_percentage || 0;
    });
}

/**
 * Refresh the shared tag autocomplete list from a transactions array.
 * Trading calls this from trLoadData() right after trTransactions is
 * populated so wmsRefData.tags always mirrors the in-memory state. The
 * resulting array is lower-cased + de-duplicated, sorted alphabetically,
 * matching the previous DB-query shape. Returns the array for convenience.
 */
function wmsRefreshTagsFromTransactions(transactions) {
    var tagSet = {};
    if (Array.isArray(transactions)) {
        transactions.forEach(function(t) {
            if (Array.isArray(t.tags)) {
                t.tags.forEach(function(tag) {
                    var trimmed = (tag || '').trim().toLowerCase();
                    if (trimmed) tagSet[trimmed] = true;
                });
            }
        });
    }
    var next = Object.keys(tagSet).sort();
    // Mutate in place (B.2.3) so any consumer that captured a reference to
    // wmsRefData.tags (e.g. trading-add-transaction.js's atExistingTags)
    // sees the updated values without re-binding.
    if (!Array.isArray(wmsRefData.tags)) wmsRefData.tags = [];
    wmsRefData.tags.length = 0;
    Array.prototype.push.apply(wmsRefData.tags, next);
    return wmsRefData.tags;
}

// ============================================================================
// PAGINATED RAW FETCH — bypasses Supabase's 1000-row default limit
// Use for any raw fetch() call that might return > 1000 rows.
// ============================================================================

/**
 * Fetch ALL rows from a Supabase REST URL using raw fetch() with Range headers.
 * Paginates in batches of 1000 until a partial page is returned.
 * @param {string} url - Full Supabase REST URL with query params
 * @param {object} [opts] - Optional fetch options (headers, etc.)
 * @returns {Promise<Array>} All rows concatenated
 */
async function wmsFetchAllRaw(url, opts) {
    var BATCH = 1000;
    var all = [], from = 0;
    var baseHeaders = (opts && opts.headers) ? opts.headers : wmsHeaders();
    while (true) {
        var reqHeaders = Object.assign({}, baseHeaders, {
            'Range': from + '-' + (from + BATCH - 1)
        });
        var resp = await fetchWithTimeout(url, { headers: reqHeaders });
        if (!resp.ok) throw new Error('DB error: ' + resp.status + ' — ' + (await resp.text()));
        var data = await resp.json();
        all = all.concat(data);
        if (data.length < BATCH) break;
        from += BATCH;
    }
    return all;
}

// ============================================================================
// SECURITIES MASTER DATA — Paginated loader + client-side search
// Loaded once at app startup (background), refreshed after CM/F&O Sync.
// All modules read from wmsRefData.securitiesCm / securitiesNfo.
// ============================================================================

/**
 * Fetch ALL rows from a Supabase table, bypassing the 1000-row default limit
 * by paginating with .range() until a partial page is returned.
 */
async function wmsFetchAllRows(table, select, orderCol, filterFn) {
    orderCol = orderCol || 'symbol';
    var BATCH = 1000;
    var all = [], from = 0;
    while (true) {
        var query = window.supabaseClient
            .from(table)
            .select(select)
            .order(orderCol, { ascending: true })
            // Tie-breaker — REQUIRED, not cosmetic. Paging with .range() over a
            // non-unique orderCol is undefined behaviour: rows sharing a value can
            // come back in a different order per request, so some are returned twice
            // and others never at all. securities_nfo pages by expiry_date, where
            // thousands of contracts share a handful of monthly expiries — measured
            // 2026-07-20 on live data: 2,104 rows fetched, only 2,083 distinct,
            // 21 silently lost. Ordering by (orderCol, id) makes paging total.
            .order('id', { ascending: true });
        if (filterFn) query = filterFn(query);
        query = query.range(from, from + BATCH - 1);
        var result = await query;
        if (result.error) throw result.error;
        all = all.concat(result.data || []);
        if (!result.data || result.data.length < BATCH) break;
        from += BATCH;
    }
    return all;
}

// Shared column list for securities_db fetches
var WMS_SECURITIES_CM_SELECT = 'id,symbol,company_name,isin,nse_symbol,bse_symbol,security_type,asset_class,sector,size,is_active,lot_size,broker_tokens,merged_into_id,merged_at,week_52_high,week_52_low,income_ledgers,capital_gains';

// Debt security types excluded from initial load (loaded in background)
var WMS_DEBT_TYPES = ['NCD', 'GOVT_BOND'];

/**
 * Load CM (Cash Market) securities into wmsRefData.securitiesCm.
 * Excludes NCD/GOVT_BOND for fast startup; those are loaded in background
 * via wmsLoadSecuritiesDebt(). After CM Sync, pass {all: true} to reload everything.
 * Retries up to 3 times with 3s/6s/12s backoff on network failure.
 */
async function wmsLoadSecuritiesCm(retryCount, opts) {
    retryCount = retryCount || 0;
    opts = opts || {};
    try {
        var filterFn = null;
        if (!opts.all) {
            // Exclude debt types for fast startup
            filterFn = function(q) {
                return q.not('security_type', 'in', '(' + WMS_DEBT_TYPES.join(',') + ')');
            };
        }
        var rows = await wmsFetchAllRows('securities_db', WMS_SECURITIES_CM_SELECT, 'isin', filterFn);
        wmsRefData.securitiesCm = rows;
        wmsRefData.securitiesCmMap = {};
        rows.forEach(function(r) { wmsRefData.securitiesCmMap[r.id] = r; });
        wmsRefData.securitiesCmReady = true;
        wmsRefData.securitiesDebtLoaded = !!opts.all;
        console.log('Securities CM loaded: ' + rows.length + ' rows' + (opts.all ? ' (full)' : ' (excl. debt)'));
    } catch (e) {
        console.error('Securities CM load error (attempt ' + (retryCount + 1) + '):', e);
        if (retryCount < 3) {
            var delay = 3000 * Math.pow(2, retryCount); // 3s, 6s, 12s
            console.log('Retrying CM load in ' + (delay / 1000) + 's...');
            await new Promise(function(resolve) { setTimeout(resolve, delay); });
            return wmsLoadSecuritiesCm(retryCount + 1, opts);
        }
    }
}

/**
 * Background-load debt securities (NCD, GOVT_BOND) and merge into securitiesCm.
 * Called after app startup completes. Non-blocking — search works without it,
 * debt results just appear once this finishes.
 */
async function wmsLoadSecuritiesDebt() {
    if (wmsRefData.securitiesDebtLoaded) return; // already loaded (e.g. after CM Sync)
    try {
        var filterFn = function(q) {
            return q.in('security_type', WMS_DEBT_TYPES);
        };
        var rows = await wmsFetchAllRows('securities_db', WMS_SECURITIES_CM_SELECT, 'isin', filterFn);
        // Re-check after await: CM Sync may have loaded everything while we were fetching
        if (wmsRefData.securitiesDebtLoaded) {
            console.log('Securities debt: skipped merge — already loaded by CM Sync');
            return;
        }
        // Merge into existing arrays (avoid duplicates by checking map)
        var added = 0;
        rows.forEach(function(r) {
            if (!wmsRefData.securitiesCmMap[r.id]) {
                wmsRefData.securitiesCm.push(r);
                wmsRefData.securitiesCmMap[r.id] = r;
                added++;
            }
        });
        wmsRefData.securitiesDebtLoaded = true;
        console.log('Securities debt loaded: ' + rows.length + ' rows (' + added + ' new)');
    } catch (e) {
        console.error('Securities debt background load error:', e);
    }
}

// Shared column list for securities_nfo fetches (full loader + surgical backfill)
var WMS_SECURITIES_NFO_SELECT = 'id,symbol,instrument_name,exchange,instrument_type,underlying_symbol,expiry_date,strike_price,option_type,lot_size,is_active,broker_tokens,updated_at';

/**
 * Load all F&O (Futures & Options) securities into wmsRefData.securitiesNfo.
 * Called at app startup (background) and after F&O Sync.
 * Retries up to 3 times with 3s/6s/12s backoff on network failure.
 */
async function wmsLoadSecuritiesNfo(retryCount) {
    retryCount = retryCount || 0;
    try {
        var rows = await wmsFetchAllRows('securities_nfo', WMS_SECURITIES_NFO_SELECT, 'expiry_date');
        wmsRefData.securitiesNfo = rows;
        wmsRefData.securitiesNfoMap = {};
        rows.forEach(function(r) { wmsRefData.securitiesNfoMap[r.id] = r; });
        wmsRefData.securitiesNfoReady = true;
        console.log('Securities NFO loaded: ' + rows.length + ' rows');
    } catch (e) {
        console.error('Securities NFO load error (attempt ' + (retryCount + 1) + '):', e);
        if (retryCount < 3) {
            var delay = 3000 * Math.pow(2, retryCount);
            console.log('Retrying NFO load in ' + (delay / 1000) + 's...');
            await new Promise(function(resolve) { setTimeout(resolve, delay); });
            return wmsLoadSecuritiesNfo(retryCount + 1);
        }
    }
}

// security_ids referenced by a trade but STILL absent from securities_nfo after
// a fresh by-id fetch. Per the master-DB invariant — a fill cannot be booked
// without its contract row (supabase/functions/_shared/nfo-contract.ts throws
// otherwise; Add Transaction / imports create the row before booking) — this
// set should stay empty. A populated entry means a genuinely-orphaned trade; we
// record it ONLY so we don't re-query the same absent id on every render. This
// is NOT a latch: it never suppresses a contract that actually exists, and any
// id is picked up the instant a later fetch/seed returns its row. (Rule A.1.2 → var.)
var _wmsNfoConfirmedAbsent = {};

// Surgically fetch specific securities_nfo rows by id and merge them into the
// in-memory master (securitiesNfoMap + securitiesNfo). Used to cover a contract
// created AFTER this session loaded the master — instead of reloading the whole
// ~2k-row master, pull ONLY the missing ids. Cheap enough to run on demand, so
// there is no "give up" latch. Returns rows merged, or -1 on a fetch error (so
// the caller can retry rather than mistake a network blip for a missing row).
// See LESSONS §A.4.4.
async function wmsBackfillNfoContracts(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    var result = await window.supabaseClient
        .from('securities_nfo')
        .select(WMS_SECURITIES_NFO_SELECT)
        .in('id', ids);
    if (result.error) { console.error('wmsBackfillNfoContracts error:', result.error); return -1; }
    var rows = result.data || [];
    if (!wmsRefData.securitiesNfoMap) wmsRefData.securitiesNfoMap = {};
    rows.forEach(function(r) {
        if (!wmsRefData.securitiesNfoMap[r.id]) {
            wmsRefData.securitiesNfoMap[r.id] = r;
            if (Array.isArray(wmsRefData.securitiesNfo)) wmsRefData.securitiesNfo.push(r);
        }
    });
    return rows.length;
}

// Insert a single freshly-created securities_nfo row into the in-memory master
// synchronously, so a just-booked contract resolves immediately (structured
// expiry / lot_size / strike) with no reload round-trip or perceived latency.
// The producer already holds the DB row (POST return=representation). §A.4.4.
function wmsSeedNfoContract(row) {
    if (!row || !row.id) return;
    if (!wmsRefData.securitiesNfoMap) wmsRefData.securitiesNfoMap = {};
    if (!wmsRefData.securitiesNfoMap[row.id]) {
        wmsRefData.securitiesNfoMap[row.id] = row;
        if (Array.isArray(wmsRefData.securitiesNfo)) wmsRefData.securitiesNfo.push(row);
    }
    delete _wmsNfoConfirmedAbsent[row.id];
}

// Ensure the in-memory NFO master (securitiesNfoMap) covers every F&O contract
// referenced by `transactions`. The master is loaded ONCE at app startup, but a
// contract can be written to securities_nfo mid-session — a trade cannot be
// booked without its contract row existing (nfo-contract.ts). A contract missing
// from the pre-loaded map makes structured lookups (wmsFormatContract → expiry
// label / lot size / strike, margin FIFO, etc.) fall back to fuzzy symbol
// parsing and mis-format — e.g. an option leaking into the F&O expiry filter as
// its full contract name. When we spot referenced contracts that aren't cached,
// backfill exactly those ids (cheap, targeted). Covers NFO and MCX (both live in
// securities_nfo). Returns true if a backfill ran. Await before rendering
// anything that decodes F&O contracts. See LESSONS §A.4.4.
async function wmsEnsureNfoContracts(transactions) {
    if (!Array.isArray(transactions)) return false;
    var map = wmsRefData.securitiesNfoMap || {};
    var missing = [], seen = {};
    for (var i = 0; i < transactions.length; i++) {
        var t = transactions[i];
        if (!t || !t.security_id) continue;
        if (t.security_type !== 'NFO' && t.security_type !== 'MCX') continue;
        var id = t.security_id;
        if (map[id]) continue;                    // already cached
        if (_wmsNfoConfirmedAbsent[id]) continue; // known-orphan — don't re-query
        if (seen[id]) continue;
        seen[id] = true;
        missing.push(id);
    }
    if (missing.length === 0) return false;
    console.log('wmsEnsureNfoContracts: backfilling ' + missing.length + ' F&O contract(s) not in cache');
    var merged = await wmsBackfillNfoContracts(missing);
    if (merged < 0) return true; // fetch failed — retry next render, don't mark absent
    // Anything still missing after a successful by-id fetch is genuinely absent
    // from the master (invariant violation) — record so we don't re-query it
    // every render. Self-clears if the row later appears (seed / next fetch).
    map = wmsRefData.securitiesNfoMap || {};
    for (var j = 0; j < missing.length; j++) {
        if (!map[missing[j]]) _wmsNfoConfirmedAbsent[missing[j]] = true;
    }
    return true;
}

// ============================================================================
// MASTER REFERENCE-DATA DELTA SYNC (§A.4.4b)
// Keeps the in-memory masters current on the SAME cadence as transactions, so a
// contract / investor / rate created or edited mid-session is picked up without a
// full reload or a module re-entry (root cause of the recurring F&O phantom expiry).
// One RPC (masters_sync_state) returns a change-token per master; only the tables
// whose checksum moved are fetched — securities_nfo via a row-level delta, the rest
// via a targeted reload. Idle cost = one small RPC per tick, zero row fetches.
// SAFE BEFORE THE MIGRATION IS APPLIED: the probe 404s → wmsMastersSyncNow no-ops.
// ============================================================================

// Small masters reloaded wholesale on any change (tiny, negligible bandwidth).
// securities_nfo → row-level delta; securities_db (CM) → reload (rare intraday; the
// CM+debt split makes a row-delta fiddly for little gain).
var WMS_MASTER_SMALL = ['investors', 'brokers', 'investor_broker_accounts', 'regulatory_charges_config'];

// One probe → { table: {row_count, checksum, max_updated} } for every master.
async function wmsMastersSyncState() {
    var resp = await fetch(SUPABASE_URL + '/rest/v1/rpc/masters_sync_state', {
        method: 'POST', headers: wmsHeaders({ 'Content-Type': 'application/json' }), body: '{}'
    });
    if (!resp.ok) throw new Error('masters_sync_state ' + resp.status);
    var rows = await resp.json();
    var out = {};
    (Array.isArray(rows) ? rows : []).forEach(function(r) {
        out[r.table_name] = { row_count: Number(r.row_count), checksum: r.checksum, max_updated: r.max_updated };
    });
    return out;
}

// Record current tokens as the baseline the cadence compares against. Call once after the
// startup master load (and after any manual full master reload / CM-F&O Sync).
async function wmsMastersCaptureBaseline() {
    try { wmsRefData._masterTokens = await wmsMastersSyncState(); }
    catch (e) { console.warn('masters baseline probe unavailable (will prime on first tick):', e && e.message); }
}

// Fetch specific securities_nfo rows by id (full columns) for the delta. Batched under URL limits.
async function _wmsFetchNfoByIds(ids) {
    var out = [], BATCH = 100;
    for (var i = 0; i < ids.length; i += BATCH) {
        var slice = ids.slice(i, i + BATCH);
        var resp = await fetch(SUPABASE_URL + '/rest/v1/securities_nfo?select=' + WMS_SECURITIES_NFO_SELECT + '&id=in.(' + slice.join(',') + ')', { headers: wmsHeaders() });
        if (!resp.ok) throw new Error('_wmsFetchNfoByIds ' + resp.status);
        var rows = await resp.json();
        for (var j = 0; j < rows.length; j++) out.push(rows[j]);
    }
    return out;
}

// Row-level delta for securities_nfo (mirror of wmsTxnDeltaSync): manifest of id+updated_at →
// changed (new / updated_at differs) fetched by id and merged (overwrite); rows absent from the
// manifest are deleted. Keeps securitiesNfo[] and securitiesNfoMap{} in lockstep.
async function _wmsNfoDeltaSync() {
    var manifest = await wmsFetchAllRaw(SUPABASE_URL + '/rest/v1/securities_nfo?select=id,updated_at&order=id.asc');
    var serverHas = Object.create(null), changedIds = [];
    var map = wmsRefData.securitiesNfoMap || (wmsRefData.securitiesNfoMap = {});
    for (var i = 0; i < manifest.length; i++) {
        var mid = manifest[i].id; serverHas[mid] = true;
        var cur = map[mid];
        if (!cur || cur.updated_at !== manifest[i].updated_at) changedIds.push(mid);
    }
    var arr = wmsRefData.securitiesNfo || (wmsRefData.securitiesNfo = []);
    for (var d = arr.length - 1; d >= 0; d--) {                        // deletions
        if (!serverHas[arr[d].id]) { delete map[arr[d].id]; arr.splice(d, 1); }
    }
    if (changedIds.length) {                                            // changed / new
        var rows = await _wmsFetchNfoByIds(changedIds);
        for (var c = 0; c < rows.length; c++) {
            var r = rows[c];
            if (map[r.id]) { for (var a = 0; a < arr.length; a++) { if (arr[a].id === r.id) { arr[a] = r; break; } } }
            else { arr.push(r); }
            map[r.id] = r;
        }
    }
    return changedIds.length;
}

// Bring every in-memory master current (one probe → delta only the tables that moved). Returns
// true if anything changed. Guarded on `ready`; non-fatal per table (a failed table keeps its old
// token so it retries next tick). Wired into the 2-min cadence + tab-focus.
async function wmsMastersSyncNow() {
    if (!wmsRefData.ready) return false;
    var probe;
    try { probe = await wmsMastersSyncState(); } catch (e) { return false; }  // RPC absent → no-op
    var base = wmsRefData._masterTokens || {};
    var next = {}; for (var k in probe) next[k] = probe[k];
    var changed = false;
    function moved(t) { return probe[t] && (!base[t] || base[t].checksum !== probe[t].checksum); }

    if (moved('securities_nfo')) {
        try { await _wmsNfoDeltaSync(); changed = true; }
        catch (e) { console.warn('NFO master delta failed:', e && e.message); if (base.securities_nfo) next.securities_nfo = base.securities_nfo; }
    }
    if (moved('securities_db')) {
        try { await wmsLoadSecuritiesCm(0, { all: true }); changed = true; }
        catch (e) { console.warn('CM master reload failed:', e && e.message); if (base.securities_db) next.securities_db = base.securities_db; }
    }
    var smallMoved = WMS_MASTER_SMALL.filter(moved);
    if (smallMoved.length) {
        try { await wmsReloadRefMastersOnly(); changed = true; }
        catch (e) { console.warn('small masters reload failed:', e && e.message); smallMoved.forEach(function(t){ if (base[t]) next[t] = base[t]; }); }
    }

    wmsRefData._masterTokens = next;
    return changed;
}

// ============================================================================
// SHARED TRANSACTIONS CACHE + DRIFT-PROOF DELTA SYNC (LESSONS §A.9.6)
// ----------------------------------------------------------------------------
// ONE cache for the whole app: window._wmsTxnCache = { rows, count, checksum,
// maxUpdated }. Loaded once at app startup (app.html Promise.all) and read by
// every module — Trading (trTransactions = the shared rows), Reports (derives
// its camelCase view + edit-modal rows from the same cache). No module fetches
// transactions itself, so the modules can never diverge. wmsLoadTransactions()
// is checksum-gated: unchanged → reuse; changed → reconcile only the delta;
// any integrity miss or opts.force → full reload. Lives in wms-shared.js (not
// trading.js) so it is available at startup before any feature module loads.
// ============================================================================

// Full column list for a transaction row (shared by the full load + by-id fetch).
var WMS_TXN_SELECT = 'id,investor_id,trader_id,broker_id,security_id,security_type,symbol,short_symbol,company_name,exchange,product,transaction_type,transaction_date,transaction_time,quantity,lots,price,gross_amount,net_amount,brokerage,stt,other_charges,gst,tds,total_charges,trader_charges,margin_blocked,broker_contract_note_no,broker_trade_id,tags,notes,is_locked,ignore_for_avg_cost,dont_display,created_at,updated_at';

// Opaque change token via the txn_sync_state RPC (migration 2026-07-17). Returns
// { count, checksum, maxUpdated }. The checksum flips iff any row is inserted /
// edited / deleted; the client only compares it to the stored token.
async function wmsTxnSyncState() {
    var isDev = (window.WMS_ENV === 'dev');
    var resp = await fetch(SUPABASE_URL + '/rest/v1/rpc/txn_sync_state', {
        method: 'POST',
        headers: wmsHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ p_dev: isDev })
    });
    if (!resp.ok) throw new Error('txn_sync_state ' + resp.status);
    var rows = await resp.json();
    var r = Array.isArray(rows) ? rows[0] : rows;
    return { count: r ? Number(r.row_count) : NaN, checksum: r ? r.checksum : null, maxUpdated: r ? r.max_updated : null };
}

// Full rows for a set of ids (delta heavy-fetch), batched under URL limits.
async function wmsTxnFetchByIds(ids) {
    var out = [];
    var BATCH = 100;
    for (var i = 0; i < ids.length; i += BATCH) {
        var slice = ids.slice(i, i + BATCH);
        var url = SUPABASE_URL + '/rest/v1/transactions?select=' + WMS_TXN_SELECT + '&id=in.(' + slice.join(',') + ')';
        var resp = await fetch(url, { headers: wmsHeaders() });
        if (!resp.ok) throw new Error('wmsTxnFetchByIds ' + resp.status);
        var rows = await resp.json();
        for (var j = 0; j < rows.length; j++) out.push(rows[j]);
    }
    return out;
}

// Process one row exactly as a full load does (Rule E.14 sanitize + B.9.2 search text).
function wmsTxnProcessRow(txn) {
    txn = wmsSanitizeTransactions([txn])[0];
    txn._searchText = wmsBuildSecuritySearchText({
        securityId: txn.security_id, symbol: txn.symbol,
        shortSymbol: txn.short_symbol, companyName: txn.company_name
    });
    return txn;
}

// Full paginated fetch → sanitize + search-text every row → set the shared cache.
async function wmsTxnFullFetch() {
    var syncBaseline = null;
    try { syncBaseline = await wmsTxnSyncState(); } catch (e) { console.warn('wmsTxnSyncState unavailable:', e.message); }
    var rows = await wmsFetchAllRaw(
        SUPABASE_URL + '/rest/v1/transactions?select=' + WMS_TXN_SELECT + '&order=transaction_date.asc,transaction_time.asc.nullsfirst,id.asc'
    );
    wmsSanitizeTransactions(rows);
    rows.forEach(function(t) {
        t._searchText = wmsBuildSecuritySearchText({ securityId: t.security_id, symbol: t.symbol, shortSymbol: t.short_symbol, companyName: t.company_name });
    });
    window._wmsTxnCache = {
        rows: rows,
        count: rows.length,
        checksum: syncBaseline ? syncBaseline.checksum : null,
        maxUpdated: syncBaseline ? syncBaseline.maxUpdated : null
    };
    console.log('Transactions: full load — ' + rows.length + ' rows');
    return rows;
}

// Manifest-reconcile delta on the shared cache. Mutates cache.rows IN PLACE
// (so Trading's trTransactions reference stays valid). Returns true on verified
// integrity; false => caller must full-reload.
async function wmsTxnDeltaSync() {
    var cache = window._wmsTxnCache;
    if (!cache || !Array.isArray(cache.rows)) return false;
    var arr = cache.rows;

    var manifest = await wmsFetchAllRaw(SUPABASE_URL + '/rest/v1/transactions?select=id,updated_at&order=id.asc');
    var serverUpd = Object.create(null);
    for (var i = 0; i < manifest.length; i++) serverUpd[manifest[i].id] = manifest[i].updated_at;

    var memUpd = Object.create(null);
    for (var m = 0; m < arr.length; m++) memUpd[arr[m].id] = arr[m].updated_at;

    var changedIds = [];
    for (var s = 0; s < manifest.length; s++) {
        var sid = manifest[s].id;
        if (memUpd[sid] === undefined || memUpd[sid] !== manifest[s].updated_at) changedIds.push(sid);
    }
    var deleted = Object.create(null);
    var delCount = 0;
    for (var d = 0; d < arr.length; d++) {
        if (serverUpd[arr[d].id] === undefined) { deleted[arr[d].id] = true; delCount++; }
    }

    var changedRows = changedIds.length ? await wmsTxnFetchByIds(changedIds) : [];
    var changedMap = Object.create(null);
    for (var c = 0; c < changedRows.length; c++) { var pr = wmsTxnProcessRow(changedRows[c]); changedMap[pr.id] = pr; }

    if (delCount) { for (var r = arr.length - 1; r >= 0; r--) { if (deleted[arr[r].id]) arr.splice(r, 1); } }
    for (var p = 0; p < arr.length; p++) { var rep = changedMap[arr[p].id]; if (rep) { arr[p] = rep; delete changedMap[arr[p].id]; } }
    for (var nid in changedMap) { arr.push(changedMap[nid]); }

    if (arr.length !== manifest.length) { console.warn('wmsTxnDeltaSync: count ' + arr.length + ' != manifest ' + manifest.length); return false; }
    var memIds = Object.create(null);
    for (var q = 0; q < arr.length; q++) memIds[arr[q].id] = true;
    for (var v = 0; v < manifest.length; v++) { if (!memIds[manifest[v].id]) { console.warn('wmsTxnDeltaSync: missing id ' + manifest[v].id); return false; } }
    console.log('Transactions: delta reconciled (' + changedIds.length + ' changed, ' + delCount + ' deleted)');
    return true;
}

// SINGLE ENTRY POINT for loading transactions app-wide. Populates
// window._wmsTxnCache and returns cache.rows. opts.force = skip the checksum
// gate and full-reload. Callers (Trading, Reports, startup) do their own
// module-specific derivation on the returned rows.
async function wmsLoadTransactions(opts) {
    opts = opts || {};
    var cache = window._wmsTxnCache;
    var haveCache = cache && Array.isArray(cache.rows) && cache.rows.length > 0 && cache.checksum != null;
    if (!opts.force && haveCache) {
        try {
            var sync = await wmsTxnSyncState();
            if (sync.checksum && sync.checksum === cache.checksum) {
                return cache.rows;  // unchanged
            }
            var ok = await wmsTxnDeltaSync();
            if (ok) {
                cache.count = cache.rows.length;
                cache.checksum = sync.checksum;   // pre-manifest token → cache is a superset (safe)
                cache.maxUpdated = sync.maxUpdated;
                await _wmsCoverNewNfoContracts(cache.rows);
                return cache.rows;
            }
            console.warn('Transactions: delta integrity failed → full reload');
        } catch (e) {
            console.warn('Transactions: sync/delta failed → full reload', e);
        }
    }
    var full = await wmsTxnFullFetch();
    await _wmsCoverNewNfoContracts(full);
    return full;
}

// Backfill the in-memory NFO master for any contract referenced by a just-(re)loaded
// transaction set — so EVERY module (F&O expiry label, lot size, margin FIFO) decodes it
// structurally, not via fuzzy symbol parsing. Previously coverage ran ONLY on Trading-module
// entry (trDeriveAfterLoad), so a contract booked mid-session by a webhook — created in
// securities_nfo AFTER this session loaded the master — stayed uncached until the user re-entered
// Trading or reloaded; in that window an option leaked into the F&O expiry filter as its full
// contract name (e.g. "Aug 26 57100 PE"). Hooking it into the shared loader covers all modules.
// Guarded on master-ready so startup (master not yet loaded) never tries to backfill the whole
// universe. Non-fatal. See LESSONS §A.4.4.
async function _wmsCoverNewNfoContracts(rows) {
    try {
        if (wmsRefData && wmsRefData.ready && typeof wmsEnsureNfoContracts === 'function') {
            await wmsEnsureNfoContracts(rows);
        }
    } catch (e) { console.warn('NFO coverage after transaction (re)load failed (non-fatal):', e); }
}

// ============================================================================
// MULTI-TOKEN SEARCH HELPER (Rule B.9.2)
// Splits query into tokens, returns true if ALL tokens match at least one field.
// Used by ALL search/filter across the app — single source of truth.
// Usage: wmsMultiTokenMatch(tokens, field1, field2, ...)
//   tokens = array from wmsTokenize(query)
//   remaining args = string fields to search against
// ============================================================================

/**
 * Tokenize a search query: lowercase, split on whitespace, remove empties.
 * Returns array of lowercase tokens. Returns [] if input is empty.
 */
function wmsTokenize(query) {
    var q = (query || '').trim().toLowerCase();
    if (!q) return [];
    return q.split(/\s+/);
}

/**
 * Multi-token AND match. Returns true if EVERY token in `tokens` is found
 * in at least one of the remaining string arguments.
 * Concatenates all fields into one string for matching — so a token can
 * match across any field.
 *
 * @param {string[]} tokens - Array from wmsTokenize()
 * @param {...string} fields - One or more string fields to search
 * @returns {boolean}
 */
function wmsMultiTokenMatch(tokens) {
    // Build combined lowercase string from all field arguments
    var parts = [];
    for (var i = 1; i < arguments.length; i++) {
        if (arguments[i]) parts.push(String(arguments[i]).toLowerCase());
    }
    var combined = parts.join(' ');
    // Every token must appear somewhere in the combined string
    for (var t = 0; t < tokens.length; t++) {
        if (combined.indexOf(tokens[t]) === -1) return false;
    }
    return true;
}

/**
 * Build a comprehensive search text for any security by enriching from wmsRefData.
 * Looks up by security_id first (CM map, then NFO map), falls back to symbol scan.
 * Returns a single lowercase string containing all searchable fields.
 * Call once per record at data-load time, store as _searchText for fast filtering.
 *
 * @param {object} opts - { securityId, symbol, shortSymbol, companyName }
 * @returns {string} Combined lowercase search text
 */
function wmsBuildSecuritySearchText(opts) {
    var parts = [];
    var sid = opts.securityId;
    var sym = opts.symbol || '';
    var shortSym = opts.shortSymbol || '';
    var co = opts.companyName || '';

    // Always include the record's own fields
    if (sym) parts.push(sym);
    if (shortSym && shortSym !== sym) parts.push(shortSym);
    if (co) parts.push(co);

    // Enrich from CM cache
    var cmRec = null;
    if (sid && wmsRefData.securitiesCmMap) {
        cmRec = wmsRefData.securitiesCmMap[sid];
    }
    if (!cmRec && shortSym && wmsRefData.securitiesCmReady) {
        // Fallback: scan by symbol match
        for (var i = 0; i < wmsRefData.securitiesCm.length; i++) {
            var s = wmsRefData.securitiesCm[i];
            if (s.symbol === shortSym || s.nse_symbol === shortSym || s.bse_symbol === shortSym) {
                cmRec = s; break;
            }
        }
    }
    if (cmRec) {
        if (cmRec.symbol) parts.push(cmRec.symbol);
        if (cmRec.company_name) parts.push(cmRec.company_name);
        if (cmRec.isin) parts.push(cmRec.isin);
        if (cmRec.nse_symbol) parts.push(cmRec.nse_symbol);
        if (cmRec.bse_symbol) parts.push(cmRec.bse_symbol);
    }

    // Enrich from NFO cache
    var nfoRec = null;
    if (sid && wmsRefData.securitiesNfoMap) {
        nfoRec = wmsRefData.securitiesNfoMap[sid];
    }
    if (!nfoRec && sym && wmsRefData.securitiesNfoReady) {
        for (var j = 0; j < wmsRefData.securitiesNfo.length; j++) {
            var n = wmsRefData.securitiesNfo[j];
            if (n.symbol === sym) { nfoRec = n; break; }
        }
    }
    if (nfoRec) {
        if (nfoRec.symbol) parts.push(nfoRec.symbol);
        if (nfoRec.instrument_name) parts.push(nfoRec.instrument_name);
        if (nfoRec.underlying_symbol) parts.push(nfoRec.underlying_symbol);
        if (nfoRec.exchange) parts.push(nfoRec.exchange);
        if (nfoRec.expiry_date) parts.push(nfoRec.expiry_date);
        if (nfoRec.strike_price) parts.push(String(nfoRec.strike_price));
        if (nfoRec.option_type) parts.push(nfoRec.option_type);
    }

    return parts.join(' ').toLowerCase();
}

/**
 * Client-side symbol search across cached securities data.
 * Returns sorted results: CM first (alpha), then F&O by expiry, inactive filtered out.
 * Used by Add Transaction, Watchlist, and any future symbol search.
 */
function wmsSearchSecurities(query) {
    var tokens = wmsTokenize(query);
    if (tokens.length === 0) return [];

    // Search CM securities (active only)
    var cmMatches = [];
    if (wmsRefData.securitiesCmReady) {
        var cmAll = wmsRefData.securitiesCm;
        for (var i = 0; i < cmAll.length; i++) {
            var sec = cmAll[i];
            if (sec.is_active === false) continue;
            if (wmsMultiTokenMatch(tokens,
                    sec.symbol, sec.nse_symbol, sec.bse_symbol,
                    sec.company_name, sec.isin)) {
                cmMatches.push(sec);
                if (cmMatches.length >= 20) break;
            }
        }
    }

    // Search NFO securities (include inactive/expired for historical entries)
    var nfoMatches = [];
    if (wmsRefData.securitiesNfoReady) {
        var nfoAll = wmsRefData.securitiesNfo;
        for (var j = 0; j < nfoAll.length; j++) {
            var nfo = nfoAll[j];
            if (wmsMultiTokenMatch(tokens,
                    nfo.symbol, nfo.underlying_symbol, nfo.instrument_name,
                    nfo.exchange, nfo.expiry_date,
                    nfo.strike_price ? String(nfo.strike_price) : '',
                    nfo.option_type)) {
                nfoMatches.push(nfo);
                if (nfoMatches.length >= 20) break;
            }
        }
    }

    // Mark source for sort function, then combine and sort
    cmMatches.forEach(function(r) { r._isNfo = false; r._displaySym = r.symbol; });
    nfoMatches.forEach(function(r) {
        r._isNfo = true;
        r._displaySym = r.symbol;
        r._expiryDate = r.expiry_date || '';
    });

    var all = cmMatches.concat(nfoMatches);
    return wmsSortSearchResults(all);
}

// ============================================================================
// MONEY ROUNDING
// Round to 2 decimal places. Used across charge calculations, DB inserts, etc.
// ============================================================================

function wmsRoundMoney(v) {
    return Math.round((v || 0) * 100) / 100;
}

// ============================================================================
// TAG INHERITANCE (shared across Add Transaction + CN Import + Fyers Import)
// ============================================================================
// Given a pool of transactions, find all tags that have previously been used
// for the same (investor, trader, symbol) combination. Deduped case-insensitive
// (keeps original casing of the first occurrence). Filters the 'blank' sentinel
// (A.2.1) so it's never returned as an actual tag.
//
// Symbol comparison strips exchange prefix (NSE:, BSE:, ...) per A.2.13 so a
// Fyers-imported `NSE:INDHOTEL26MARFUT` matches a CN-imported bare
// `INDHOTEL26MARFUT`. Trader comparison uses `trader_id || investor_id` so
// legacy rows without an explicit trader still match correctly (Rule A.2.2).
//
// @param {Array}  transactions — pool to search (typically trTransactions)
// @param {string} investorId
// @param {string} traderId    — falls back to investorId if null/undefined
// @param {string} symbol
// @returns {string[]} — list of distinct tags, original casing preserved
function wmsFindMatchingTags(transactions, investorId, traderId, symbol) {
    if (!Array.isArray(transactions) || !investorId || !symbol) return [];
    var bareSymbol = (symbol || '').replace(/^[A-Z]+:/, '');
    var effTrader = traderId || investorId;
    var collected = {}; // lowercased → original casing
    for (var i = 0; i < transactions.length; i++) {
        var t = transactions[i];
        if (t.investor_id !== investorId) continue;
        if ((t.trader_id || t.investor_id) !== effTrader) continue;
        if ((t.symbol || '').replace(/^[A-Z]+:/, '') !== bareSymbol) continue;
        if (!Array.isArray(t.tags)) continue;
        for (var k = 0; k < t.tags.length; k++) {
            var tag = t.tags[k];
            if (!tag) continue;
            var trimmed = String(tag).trim();
            if (!trimmed || trimmed.toLowerCase() === 'blank') continue;
            var key = trimmed.toLowerCase();
            if (!(key in collected)) collected[key] = trimmed;
        }
    }
    var out = [];
    for (var key2 in collected) { if (Object.prototype.hasOwnProperty.call(collected, key2)) out.push(collected[key2]); }
    return out;
}

// ============================================================================
// FORMULA INPUT — Excel-style "=" calculator for any text/number input
// ============================================================================
// USAGE
//   Call wmsInitFormulaInput() once at app startup (from DOMContentLoaded).
//   Every <input> in the app then accepts formulas when value starts with "=".
//   Operators: + − × ÷  ( )  decimal  postfix %  (Core + percent).
//   BODMAS / standard precedence honoured.
//
// TRIGGER
//   User types "=" as first character. For type=number inputs (which reject
//   "=" natively), we intercept the keydown and switch input type to "text"
//   transparently while the user types the formula. On Enter or blur:
//     * valid formula → replace value with the numeric result, fire input
//       + change events so downstream recalculations run, restore original
//       input type
//     * invalid on Enter → flash red border + title tooltip, keep formula
//       visible so user can fix
//     * invalid on blur → silent revert to the value held before formula
//       mode (they left the field, no point pestering)
//   Escape while in formula mode → revert to pre-formula value.
//
// SAFETY
//   Parser is recursive-descent — NEVER uses eval(). Accepts only digits,
//   decimal point, +, −, *, /, (, ), %, and whitespace. Anything else is
//   rejected with "Unexpected character".
//
// @param {string} expr  Expression string (with or without leading =)
// @returns {{ok: boolean, value?: number, error?: string}}
// ============================================================================
function wmsEvalFormula(expr) {
    if (expr === null || expr === undefined) return { ok: false, error: 'Empty formula' };
    var s = String(expr).trim();
    if (s.charAt(0) === '=') s = s.slice(1).trim();
    if (!s) return { ok: false, error: 'Empty formula' };

    // --- Tokenise ---
    var tokens = [];
    var i = 0;
    while (i < s.length) {
        var c = s.charAt(i);
        if (c === ' ' || c === '\t') { i++; continue; }
        if ((c >= '0' && c <= '9') || c === '.') {
            var j = i, dotSeen = (c === '.');
            j++;
            while (j < s.length) {
                var cj = s.charAt(j);
                if (cj >= '0' && cj <= '9') { j++; continue; }
                if (cj === '.' && !dotSeen) { dotSeen = true; j++; continue; }
                break;
            }
            var num = parseFloat(s.slice(i, j));
            if (isNaN(num)) return { ok: false, error: 'Invalid number: ' + s.slice(i, j) };
            tokens.push({ t: 'num', v: num });
            i = j;
        } else if ('+-*/()%'.indexOf(c) >= 0) {
            tokens.push({ t: c });
            i++;
        } else {
            return { ok: false, error: 'Unexpected character: ' + c };
        }
    }
    if (tokens.length === 0) return { ok: false, error: 'Empty formula' };

    // --- Recursive-descent parser ---
    var pos = 0;
    function peek() { return tokens[pos]; }
    function consume() { return tokens[pos++]; }

    function parseExpression() {        // + -
        var left = parseTerm();
        if (left.error) return left;
        while (peek() && (peek().t === '+' || peek().t === '-')) {
            var op = consume().t;
            var right = parseTerm();
            if (right.error) return right;
            left = { value: (op === '+') ? left.value + right.value : left.value - right.value };
        }
        return left;
    }
    function parseTerm() {              // * /
        var left = parseFactor();
        if (left.error) return left;
        while (peek() && (peek().t === '*' || peek().t === '/')) {
            var op = consume().t;
            var right = parseFactor();
            if (right.error) return right;
            if (op === '*') left = { value: left.value * right.value };
            else {
                if (right.value === 0) return { error: 'Division by zero' };
                left = { value: left.value / right.value };
            }
        }
        return left;
    }
    function parseFactor() {            // postfix % (applies to whole unary above it)
        var u = parseUnary();
        if (u.error) return u;
        while (peek() && peek().t === '%') { consume(); u = { value: u.value / 100 }; }
        return u;
    }
    function parseUnary() {             // prefix - / +
        if (peek() && peek().t === '-') { consume(); var n = parseUnary(); if (n.error) return n; return { value: -n.value }; }
        if (peek() && peek().t === '+') { consume(); return parseUnary(); }
        return parsePrimary();
    }
    function parsePrimary() {           // number or ( expression )
        var tk = peek();
        if (!tk) return { error: 'Unexpected end of formula' };
        if (tk.t === 'num') { consume(); return { value: tk.v }; }
        if (tk.t === '(') {
            consume();
            var e = parseExpression();
            if (e.error) return e;
            if (!peek() || peek().t !== ')') return { error: 'Missing closing parenthesis' };
            consume();
            return e;
        }
        return { error: 'Unexpected token: ' + tk.t };
    }

    var result = parseExpression();
    if (result.error) return { ok: false, error: result.error };
    if (pos !== tokens.length) return { ok: false, error: 'Trailing input after formula' };
    if (!isFinite(result.value) || isNaN(result.value)) return { ok: false, error: 'Result is not a finite number' };
    return { ok: true, value: result.value };
}

// --- Internal state trackers (WeakMaps so no DOM memory leak) ---
var _wmsFormulaPrev = null;   // input → value before formula mode
var _wmsFormulaType = null;   // input → original input.type

function _wmsFormulaInit() {
    if (_wmsFormulaPrev) return;
    _wmsFormulaPrev = new WeakMap();
    _wmsFormulaType = new WeakMap();
}

function _wmsFormulaEnter(el) {
    _wmsFormulaInit();
    if (_wmsFormulaPrev.has(el)) return; // already in formula mode
    _wmsFormulaPrev.set(el, el.value);
    var t = (el.type || '').toLowerCase();
    if (t === 'number') {
        _wmsFormulaType.set(el, 'number');
        try { el.type = 'text'; } catch (e) { /* some browsers disallow type change — ignore */ }
    }
}

function _wmsFormulaRestoreType(el) {
    if (_wmsFormulaType && _wmsFormulaType.has(el)) {
        try { el.type = _wmsFormulaType.get(el); } catch (e) {}
        _wmsFormulaType.delete(el);
    }
}

function _wmsFormulaFlashError(el, msg) {
    var origBorder = el.style.borderColor;
    var origTitle = el.title;
    el.style.borderColor = '#e53e3e';
    el.title = 'Formula error: ' + msg;
    setTimeout(function() {
        el.style.borderColor = origBorder;
        el.title = origTitle;
    }, 1500);
}

function _wmsFormulaRevert(el) {
    if (!_wmsFormulaPrev || !_wmsFormulaPrev.has(el)) return;
    el.value = _wmsFormulaPrev.get(el);
    _wmsFormulaPrev.delete(el);
    _wmsFormulaRestoreType(el);
}

function _wmsFormulaFinalize(el, loud) {
    if (!_wmsFormulaPrev || !_wmsFormulaPrev.has(el)) return;
    var val = el.value;
    if (!val || val.charAt(0) !== '=') {
        // User deleted the leading = — exit formula mode silently
        _wmsFormulaPrev.delete(el);
        _wmsFormulaRestoreType(el);
        return;
    }
    var r = wmsEvalFormula(val);
    if (r.ok) {
        // Write result. If the original field was type=number or has step constraint,
        // write a plain numeric string. Keep 2dp for non-integer results to match
        // typical money fields; strip trailing zeros for clean display.
        var out = (Math.abs(r.value - Math.round(r.value)) < 1e-9)
            ? String(Math.round(r.value))
            : String(Math.round(r.value * 100) / 100);
        el.value = out;
        _wmsFormulaPrev.delete(el);
        _wmsFormulaRestoreType(el);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
        if (loud) {
            _wmsFormulaFlashError(el, r.error);
            // Keep formula in field so user can correct
        } else {
            _wmsFormulaRevert(el);
        }
    }
}

// ===========================================================================
// GLOBAL FULL-AMOUNT TOGGLE (F4)
// One app-wide switch (flag + formatters live in utils.js) that flips every
// money view between the user's display unit (₹ '000 / Lakhs …) and full
// rupees. Bound to F4 — a safe function key (browsers reserve F3=Find,
// F5=reload, F6=address bar; F4 is unbound in browsers and in-app; F2 is taken by the accounting date-picker). Owner request
// 2026-08-21. The accounting header/ledger buttons drive the SAME flag.
// ===========================================================================

// Re-render whichever money view is currently on screen so amounts re-format.
function wmsRerenderAmounts() {
    // Accounting page (detected via its header toggle button).
    try {
        if (document.getElementById('acctUnitToggle') && typeof acctRenderActiveTab === 'function') {
            if (typeof acctSyncUnitToggle === 'function') acctSyncUnitToggle();
            acctRenderActiveTab();
            if (typeof acctLedgerModalCtrl !== 'undefined' && acctLedgerModalCtrl &&
                acctLedgerModalCtrl.isOpen() && typeof acctRenderLedgerDetail === 'function') {
                acctRenderLedgerDetail();
            }
        }
    } catch (err) { console.warn('full-amount: accounting re-render failed', err); }

    // Trading — re-render the active tab fully (wmsRefreshRender under-renders
    // Statements + Transactions, so those get their own full render).
    try {
        if (document.getElementById('tr-portfolio')) {
            // Page-level caption ("all amounts in ₹ '000" → "₹ (full)") — set only
            // at module load otherwise, so refresh it here on every toggle.
            if (typeof trUpdateUnitLabels === 'function') trUpdateUnitLabels();
            var at = document.querySelector('.trading-tab-content.active');
            var id = at ? at.id : '';
            if (id === 'tr-ledger' && typeof lgRefresh === 'function') {
                lgRefresh();
            } else if (id === 'tr-transactions' && typeof trTxRender === 'function') {
                trTxRender();
            } else if (typeof wmsRefreshRender === 'function') {
                wmsRefreshRender();   // portfolio / F&O / watchlist
            }
        }
    } catch (err) { console.warn('full-amount: trading re-render failed', err); }

    // Reports — update the page caption + re-render the ACTIVE section.
    // ⚠️ Reports > Consolidation (#rpt-consol) is pinned to the real display unit
    // by design (its own rptConsFmt + #rptConsolUnit label); F4 leaves it untouched.
    try {
        if (document.getElementById('rpt-unit-desc')) {          // reports module loaded
            var rConsol = document.getElementById('rpt-consol');
            var rConsolActive = !!(rConsol && rConsol.classList.contains('active'));
            if (!rConsolActive) {
                if (typeof rptUpdateUnitLabels === 'function') rptUpdateUnitLabels();
                var rCg = document.getElementById('rpt-capgains');
                if (rCg && rCg.classList.contains('active')) {
                    if (typeof rptRenderCapGains === 'function') rptRenderCapGains();
                } else if (typeof rptRenderPortfolio === 'function') {
                    rptRenderPortfolio();
                }
            }
        }
    } catch (err) { console.warn('full-amount: reports re-render failed', err); }
}

// Flip the global full-amount flag, re-render, and confirm with a brief toast
// that also teaches the shortcut.
function wmsToggleFullAmount() {
    if (typeof wmsSetFullAmount !== 'function' || typeof wmsIsFullAmount !== 'function') return;
    wmsSetFullAmount(!wmsIsFullAmount());
    wmsRerenderAmounts();
    if (typeof showAlert === 'function') {
        var msg = wmsIsFullAmount()
            ? 'Showing full amounts · F4 to toggle'
            : ('Showing ' + ((typeof getUnitDescription === 'function') ? getUnitDescription() : "₹ '000") + ' · F4 to toggle');
        showAlert(msg, 'info', 2000);
    }
}
window.wmsToggleFullAmount = wmsToggleFullAmount;
window.wmsRerenderAmounts = wmsRerenderAmounts;

// Bind F4 once (capture phase so it beats any element-level handler; F4 has no
// native browser action, but preventDefault keeps it inert everywhere).
(function wmsInstallFullAmountShortcut() {
    if (window._wmsFullAmtShortcut) return;
    window._wmsFullAmtShortcut = true;
    document.addEventListener('keydown', function(e) {
        if (e.key === 'F4' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !e.repeat) {
            e.preventDefault();
            // Consolidation page owns F4 as a 3-stage scale cycle while it is the
            // active view; everywhere else this is the normal 2-stage toggle.
            if (typeof window.rptConsHandleF4 === 'function' && window.rptConsHandleF4()) return;
            wmsToggleFullAmount();
        }
    }, true);
})();

/**
 * Install the global formula-input handlers. Call once at app startup.
 * Idempotent — safe to call multiple times.
 */
function wmsInitFormulaInput() {
    if (window._wmsFormulaInstalled) return;
    window._wmsFormulaInstalled = true;
    _wmsFormulaInit();

    document.addEventListener('keydown', function(e) {
        var el = e.target;
        if (!el || el.tagName !== 'INPUT') return;
        var t = (el.type || '').toLowerCase();
        // Only apply to textual / numeric inputs; skip checkbox/radio/file/etc.
        if (t && t !== 'number' && t !== 'text' && t !== 'search' && t !== 'tel') return;

        // Enter formula mode when "=" is typed and the field is empty or
        // fully selected (so the user clearly intends to start fresh).
        if (e.key === '=' && !_wmsFormulaPrev.has(el)) {
            var isEmpty = !el.value;
            var fullySelected = false;
            try {
                fullySelected = el.value && el.selectionStart === 0 && el.selectionEnd === el.value.length;
            } catch (_) { /* selectionStart may throw on some number inputs — treat as not selected */ }
            if (!isEmpty && !fullySelected) {
                // Mid-string "=" — not a formula, ignore (text inputs will insert it; number inputs will reject it)
                return;
            }
            _wmsFormulaEnter(el);
            if (t === 'number') {
                // Switched to text; but the "=" keystroke arrived BEFORE the type switch,
                // so the browser may have already rejected it. Write it ourselves.
                e.preventDefault();
                el.value = '=';
                // Move caret to end
                try { el.setSelectionRange(1, 1); } catch (_) {}
            }
            return;
        }

        if (_wmsFormulaPrev.has(el)) {
            if (e.key === 'Enter') {
                e.preventDefault();
                _wmsFormulaFinalize(el, true);  // loud: show error if invalid
            } else if (e.key === 'Escape') {
                e.preventDefault();
                _wmsFormulaRevert(el);
            }
        }
    }, false);

    // blur doesn't bubble; listen in capture phase on document
    document.addEventListener('blur', function(e) {
        var el = e.target;
        if (!el || el.tagName !== 'INPUT') return;
        _wmsFormulaFinalize(el, false);  // quiet: silent revert if invalid
    }, true);
}

// ============================================================================
// SELECT-ON-FOCUS — select entire content when a text/number input gains focus
//
// Install once at app startup via wmsInitSelectOnFocus(). When any text-ish
// input or textarea receives focus AND already has non-empty content, the
// content is selected so the user can replace it with a single keystroke
// instead of getting a cursor at end / middle. Default browser behaviour
// puts the cursor wherever the click landed (or at the end on Tab), which
// meant every edit required a Ctrl+A or manual selection first.
//
// Skips: readonly / disabled / hidden / checkbox / radio / date / color /
// etc. — only text, number, search, tel, url, email, password, and textareas.
// ============================================================================

function wmsInitSelectOnFocus() {
    if (window._wmsSelectOnFocusInstalled) return;
    window._wmsSelectOnFocusInstalled = true;

    document.addEventListener('focusin', function(e) {
        var el = e.target;
        if (!el) return;
        var tag = el.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') return;
        if (el.readOnly || el.disabled) return;
        if (tag === 'INPUT') {
            var t = (el.type || 'text').toLowerCase();
            if (['text','number','search','tel','url','email','password'].indexOf(t) < 0) return;
        }
        if (!el.value) return;
        // Defer past the browser's own focus / click handling so we don't
        // fight cursor placement. Wrap in try/catch because Chrome rejects
        // setSelectionRange on some number inputs.
        setTimeout(function() {
            if (document.activeElement !== el) return;  // moved on already
            try { el.select(); } catch (err) { /* ignore */ }
        }, 0);
    });
}

// ============================================================================
// INCOME TYPE CHECK (Rule G.3.1)
// ============================================================================

function wmsIsIncomeType(txnType) {
    return WMS_INCOME_TYPES.indexOf(txnType) >= 0;
}

// ============================================================================
// BUY-LIKE TYPE CHECK (Rule G.3.2)
// ============================================================================
// Transaction types where charges ADD to gross to produce net_amount (cash outflow).
// BUY: purchasing securities on market
// RIGHTS_PAYMENT: paying for rights shares (same economics as BUY)
// All other non-income types default to SELL-like (charges subtract from gross).

var WMS_BUY_LIKE_TYPES = ['BUY', 'RIGHTS_PAYMENT'];
function wmsIsBuyLikeType(txnType) {
    return WMS_BUY_LIKE_TYPES.indexOf(txnType) >= 0;
}

// ============================================================================
// TAG HELPERS — Case-insensitive tag handling (Rule D.5.5)
// ============================================================================

/**
 * Build unique tag items for pill filters. Case-insensitive dedup:
 * "Intraday" and "intraday" merge into one item. First-seen casing used
 * for display label; id is always lowercase.
 * @param {Array} transactions - array with .tags arrays
 * @returns {Array} sorted [{id: 'lowertag', label: 'OriginalCase'}, ...]
 */
function wmsBuildTagItems(transactions) {
    var tagMap = {}; // lowercase → first-seen original casing
    transactions.forEach(function(t) {
        if (t.tags) t.tags.forEach(function(tag) {
            if (tag) {
                var lower = tag.toLowerCase();
                if (!tagMap.hasOwnProperty(lower)) tagMap[lower] = tag;
            }
        });
    });
    return Object.keys(tagMap).sort().map(function(lower) {
        return { id: lower, label: tagMap[lower] };
    });
}

/**
 * Case-insensitive tag filter. Returns true if txn matches the selected tags.
 * @param {Array} txnTags - the transaction's tags array
 * @param {Array} selectedTags - selected tag IDs (already lowercase from pill)
 * @param {string} logic - 'AND' or 'OR'
 */
function wmsMatchTagsFilter(txnTags, selectedTags, logic) {
    if (!selectedTags || selectedTags.length === 0) return true;
    if (!txnTags || txnTags.length === 0) return false;
    var lowerTxnTags = txnTags.map(function(t) { return t ? t.toLowerCase() : ''; });
    if (logic === 'AND') {
        return selectedTags.every(function(st) { return lowerTxnTags.indexOf(st) >= 0; });
    } else {
        return lowerTxnTags.some(function(t) { return selectedTags.indexOf(t) >= 0; });
    }
}

// ============================================================================
// DISPLAY NET AMOUNT (Rule E.14)
// ============================================================================
// When investor ≠ trader, the investor's account is used by the trader
// (the trader is the beneficiary). The trader's cost is gross ± trader_charges —
// NOT the market-facing net_amount in the DB (which reflects the broker's
// total_charges billed to the investor).
//
// `display_net_amount` is a PURELY IN-MEMORY field, computed on DB load and
// after any in-place edit. It represents the amount to show in trading views,
// average-cost calculations, and investor-perspective ledgers. It is NEVER
// persisted to the database — the DB column remains `net_amount` (broker
// truth). Edit modals and the broker-perspective ledger continue to read
// `net_amount` directly so users see and edit the DB value.
//
// wmsComputeDisplayNetAmount(txn) — returns the display value for one row:
//   • investor = trader, or no trader:  display = net_amount (DB value)
//   • non-trade types (DIVIDEND etc.):  display = net_amount (DB value)
//   • BUY / RIGHTS_PAYMENT (buy-like):  display = gross + trader_charges
//   • SELL:                             display = gross − trader_charges
//
// wmsSanitizeTransactions(transactions) — populates display_net_amount on
//   every row. Call once after loading transactions from DB, and again on
//   any in-memory mutation (edit save, split) before rendering.
// ============================================================================

function wmsComputeDisplayNetAmount(txn) {
    if (!txn) return 0;
    var investorId = txn.investor_id || '';
    var traderId = txn.trader_id || investorId;
    var dbNet = parseFloat(txn.net_amount) || 0;

    // Same-entity or no trader → DB value
    if (!traderId || traderId === investorId) return dbNet;

    var txnType = txn.transaction_type || '';
    if (txnType !== 'BUY' && txnType !== 'SELL' && txnType !== 'RIGHTS_PAYMENT') {
        return dbNet;
    }

    var gross = Math.abs(parseFloat(txn.gross_amount) || 0);
    var traderCh = Math.abs(parseFloat(txn.trader_charges) || 0);
    if (wmsIsBuyLikeType(txnType)) {
        return wmsRoundMoney(gross + traderCh);
    }
    return wmsRoundMoney(gross - traderCh);
}

function wmsSanitizeTransactions(transactions) {
    if (!transactions) return transactions;
    for (var i = 0; i < transactions.length; i++) {
        transactions[i].display_net_amount = wmsComputeDisplayNetAmount(transactions[i]);
    }
    return transactions;
}

// ============================================================================
// AVERAGE COST CALCULATION (Spec A1)
// Single source of truth — used by trading.js and any future module.
//
// PREREQUISITE: transactions must be sanitized via wmsSanitizeTransactions() first.
//   When investor ≠ trader (investor's account used by trader), net_amount is
//   adjusted to gross ± trader_charges for BUY/SELL; unchanged for other types (Rule E.14).
//
// Rules:
//   totalCost  = sum(BUY net_amount) − sum(SELL net_amount) − sum(INCOME net_amount)
//   net_amount is ALWAYS positive (BUY = gross+charges, SELL/INCOME = gross−charges)
//   Respects ignore_for_avg_cost flag (skips BOTH cost and quantity for BUY/SELL)
//   INCOME never affects quantity (even if qty field is populated in DB)
//   net_quantity = sum(all BUY/SELL quantities) where BUY>0, SELL<0
//   Long  (net_qty > 0): if totalCost < 0 → avgCost = 0
//   Short (net_qty < 0): avgCost = |totalCost / net_qty|
//   Flat  (net_qty = 0): avgCost = 0
// ============================================================================

function wmsCalcAvgCost(transactions) {
    // ----------------------------------------------------------------
    // Rule E.12: Options handling
    // ----------------------------------------------------------------
    // Options (CE/PE) NEVER contribute quantity. Cost rule is simple:
    //   netCost = sum(buy) − sum(sell) for the option contract.
    //   • netQty != 0 AND netCost > 0  →  IGNORE entirely
    //   • netQty != 0 AND netCost <= 0  →  include netCost (surplus)
    //   • netQty == 0                   →  include netCost (realized P&L)
    // ----------------------------------------------------------------

    var i, txn, sym, shortSym, txnType, isIncome;
    // Normalize NFO contract symbols by stripping any exchange prefix (e.g. "NSE:")
    // so that the same contract with/without prefix buckets together. This mirrors
    // the fix applied to _engineKey and prevents open/closed mis-classification
    // when a symbol appears with inconsistent prefixing across txns.
    var _normSym = function (s) { return (s || '').replace(/^[A-Z]+:/, ''); };

    // Step 0: identify option contracts, compute net qty AND net cost
    var optionData = {};  // fullSymbol (normalized) → { netQty, netCost }

    for (i = 0; i < transactions.length; i++) {
        txn = transactions[i];
        sym = _normSym(txn.symbol || '');
        shortSym = txn.short_symbol || txn.shortSymbol || txn.symbol || '';
        if (!wmsIsOptionContract(txn.symbol || '', shortSym)) continue;
        if (txn.ignore_for_avg_cost) continue;
        txnType = txn.transaction_type || txn.type || '';
        isIncome = WMS_INCOME_TYPES.indexOf(txnType) >= 0;
        if (isIncome) continue;

        if (!optionData[sym]) optionData[sym] = { netQty: 0, netCost: 0 };
        // Prefer display_net_amount (trader-perspective); fall back to net_amount for unsanitized input
        var netAmt = txn.display_net_amount !== undefined ? txn.display_net_amount
                   : (txn.net_amount !== undefined ? txn.net_amount : (txn.netAmount || 0));
        optionData[sym].netQty += (txn.quantity || 0);
        if (txnType === 'BUY') {
            optionData[sym].netCost += netAmt;
        } else if (txnType === 'SELL') {
            optionData[sym].netCost -= netAmt;
        }
    }

    // Classify each option contract
    var ignoreSymbols = {};   // open + netCost > 0 → skip entirely
    var includeSymbols = {};  // closed OR netCost <= 0 → include netCost only
    var optionKeys = Object.keys(optionData);
    for (i = 0; i < optionKeys.length; i++) {
        var od = optionData[optionKeys[i]];
        if (od.netQty !== 0 && od.netCost > 0) {
            ignoreSymbols[optionKeys[i]] = true;
        } else {
            includeSymbols[optionKeys[i]] = od.netCost;
        }
    }

    // Step 1: accumulate cost and quantity (non-option transactions)
    var totalCost = 0;
    var netQuantity = 0;

    for (i = 0; i < transactions.length; i++) {
        txn = transactions[i];
        sym = _normSym(txn.symbol || '');

        // Skip all option transactions — handled via includeSymbols above
        if (ignoreSymbols[sym] || includeSymbols[sym] !== undefined) continue;

        txnType = txn.transaction_type || txn.type || '';
        isIncome = WMS_INCOME_TYPES.indexOf(txnType) >= 0;
        // Prefer display_net_amount (trader-perspective); fall back to net_amount / camelCase for unsanitized input
        var netAmt = txn.display_net_amount !== undefined ? txn.display_net_amount
                   : (txn.net_amount !== undefined ? txn.net_amount : (txn.netAmount || 0));

        if (isIncome) {
            if (!txn.ignore_for_avg_cost) {
                totalCost -= Math.abs(netAmt);
            }
        } else if (txnType === 'HISTORICAL_PL') {
            // Historical P&L: signed amount — profit (+) reduces cost, loss (-) increases cost
            if (!txn.ignore_for_avg_cost) {
                totalCost -= netAmt;
            }
        } else if (txnType === 'RIGHTS_PAYMENT') {
            // Rights payment: adds cost only, does NOT change quantity
            // (the quantity was already added by RIGHTS_ENTITLEMENT)
            if (!txn.ignore_for_avg_cost) {
                totalCost += netAmt;
            }
        } else if (txnType === 'DEMERGER') {
            // DEMERGER (LESSONS §K.1). Incoming leg (qty > 0, resulting company)
            // adds cost + qty like a BUY. Parent leg (qty < 0 sentinel) subtracts
            // the removed cost and does NOT change quantity.
            if (!txn.ignore_for_avg_cost) {
                if (txn.quantity > 0) {
                    netQuantity += txn.quantity;
                    totalCost += netAmt;
                } else {
                    totalCost -= netAmt;
                }
            }
        } else {
            if (txn.ignore_for_avg_cost) continue;
            netQuantity += txn.quantity;
            if (txnType === 'BUY') {
                totalCost += netAmt;
            } else {
                totalCost -= netAmt;
            }
        }
    }

    // Step 2: apply option contract net costs (closed + surplus)
    var inclKeys = Object.keys(includeSymbols);
    for (i = 0; i < inclKeys.length; i++) {
        totalCost += includeSymbols[inclKeys[i]];
    }

    var avgCost = 0;
    if (netQuantity > 0) {
        avgCost = totalCost > 0 ? totalCost / netQuantity : 0;
    } else if (netQuantity < 0) {
        avgCost = Math.abs(totalCost / netQuantity);
    }

    return {
        avgCost: wmsRoundMoney(avgCost),
        netQuantity: netQuantity,
        totalCost: wmsRoundMoney(totalCost)
    };
}

// ============================================================================
// OPEN OPTIONS EXCLUSION
// ============================================================================
// Options contracts (CE/PE suffix) that are still open (net qty != 0 per
// contract) should NOT contribute to the underlying symbol's avg cost or
// net quantity. Only closed (squared-off) options are included.
//
// This logic is built INTO wmsCalcAvgCost itself so every caller benefits
// automatically. The helpers below are also available for standalone use.
//
// wmsIsOptionContract(symbol, shortSymbol):
//   Returns true if the full symbol represents an options contract.
//   Detection: symbol != shortSymbol AND ends with CE or PE.
//
// wmsExcludeOpenOptions(txns):
//   Returns a filtered copy of txns where transactions belonging to open
//   options contracts are removed. Closed options (net qty = 0) are kept.
//   Does NOT mutate the input array or transaction objects.
// ============================================================================
// DAY'S P&L CALCULATION — STOCKS
// Handles all four scenarios correctly:
//   1. Old shares still held:       qty × ch  (movement from prev close)
//   2. Bought today, still held:    qty × (CMP − buyPrice)
//   3. Old shares sold today:       qty × (sellPrice − prevClose)
//   4. Intraday (buy+sell today):   qty × (sellPrice − buyPrice)
// Sells consume old holdings first (FIFO), then today's buys (FIFO).
// txns: raw transaction array for ONE symbol (may include NFO/income — filtered internally)
//       Supports both snake_case and camelCase field names (defensive).
// priceCache: { lp, ch } from wmsLivePrices
// todayStr: optional 'YYYY-MM-DD' string (computed if omitted)
// Returns: number (Day P&L) or null if no live data
// ============================================================================

function wmsCalcStockDayPL(txns, priceCache, todayStr, opts) {
    if (!priceCache || !priceCache.lp) return null;
    if (!todayStr) todayStr = new Date().toISOString().slice(0, 10);
    var includeNfo = opts && opts.includeNfo;
    var cmp = priceCache.lp;
    var ch  = priceCache.ch || 0;
    var prevClose = cmp - ch;

    // Split transactions into: (a) everything that made up yesterday's closing
    // position, and (b) today's BUY / SELL trades, which need price-aware handling.
    //
    // CRITICAL (E.10.3): yesterday's quantity is derived from the canonical cost
    // engine, NOT by summing BUY − SELL here. Quantity also arrives via BONUS,
    // DEMERGER, SPLIT and RIGHTS. A holding built entirely from bonus/demerger
    // shares (e.g. RELIANCE, VAML, VISL) would otherwise net to zero and report
    // no Day P&L at all, while the % change beside it still rendered.
    var oldTxns    = [];   // pre-today trades + corporate actions of any date
    var todayBuys  = [];   // { qty, price }
    var todaySells = [];   // { qty, price }

    for (var i = 0; i < txns.length; i++) {
        var t = txns[i];
        var tType = t.transaction_type || t.type || '';
        if (wmsIsQtyExcluded(tType)) continue;
        if (t.security_type === 'NFO' && !includeNfo) continue;

        // Options (CE/PE) trade at completely different prices than the underlying —
        // never include them in stock Day P&L (they'd use equity prevClose on option prices)
        var _sym = t.symbol || '';
        var _shortSym = t.short_symbol || t.shortSymbol || _sym;
        if (wmsIsOptionContract(_sym, _shortSym)) continue;

        var tDate = t.transaction_date || t.date || '';
        var absQty = Math.abs(t.quantity || 0);
        if (absQty === 0) continue;
        var price = t.price || 0;

        if (tType === 'BUY' && tDate === todayStr) {
            todayBuys.push({ qty: absQty, price: price });
        } else if (tType === 'SELL' && tDate === todayStr) {
            todaySells.push({ qty: absQty, price: price });
        } else {
            oldTxns.push(t);
        }
    }

    // netQuantity from wmsCalcAvgCost is order-independent (a signed sum), so the
    // input order of oldTxns does not matter here. Only its avgCost would care.
    var oldNetQty = oldTxns.length ? (wmsCalcAvgCost(oldTxns).netQuantity || 0) : 0;

    // Fast path: no today trades → simple oldNetQty × ch
    if (todayBuys.length === 0 && todaySells.length === 0) {
        return oldNetQty * ch;
    }

    var dayPL = 0;
    var remainingOld = Math.max(oldNetQty, 0);

    // Process today's sells: FIFO — consume old holdings first, then today's buys
    for (var s = 0; s < todaySells.length; s++) {
        var sell = todaySells[s];
        var rem = sell.qty;
        var sp  = sell.price;

        // Scenario 3: old shares sold today → sellPrice − prevClose
        if (remainingOld > 0 && rem > 0) {
            var fromOld = Math.min(rem, remainingOld);
            dayPL += fromOld * (sp - prevClose);
            remainingOld -= fromOld;
            rem -= fromOld;
        }

        // Scenario 4: intraday — bought and sold today → sellPrice − buyPrice
        for (var b = 0; b < todayBuys.length && rem > 0; b++) {
            if (todayBuys[b].qty <= 0) continue;
            var match = Math.min(rem, todayBuys[b].qty);
            dayPL += match * (sp - todayBuys[b].price);
            todayBuys[b].qty -= match;
            rem -= match;
        }
    }

    // Scenario 1: old shares still held → qty × ch
    dayPL += remainingOld * ch;

    // Scenario 2: today's buys still held → CMP − buyPrice
    for (var tb = 0; tb < todayBuys.length; tb++) {
        if (todayBuys[tb].qty > 0) {
            dayPL += todayBuys[tb].qty * (cmp - todayBuys[tb].price);
        }
    }

    return dayPL;
}

// ============================================================================
// DAY'S P&L CALCULATION FOR F&O OPEN POSITIONS
// For same-day trades: Day's P&L = qty × (CMP − trade price)
// For older trades:    Day's P&L = qty × ch (today's price change)
// isShort flips the sign. Returns 0 if no price data.
// ============================================================================

function wmsCalcFnoDayPnl(qty, isShort, tradeDate, tradePrice, priceCache) {
    if (!priceCache || qty <= 0) return 0;
    var todayStr = new Date().toISOString().slice(0, 10);
    var cmp = priceCache.lp || 0;
    if (tradeDate === todayStr && cmp > 0 && tradePrice > 0) {
        // Same-day trade: P&L relative to trade price
        return isShort ? qty * (tradePrice - cmp) : qty * (cmp - tradePrice);
    }
    var ch = priceCache.ch || 0;
    if (ch !== 0) {
        return isShort ? (-qty * ch) : (qty * ch);
    }
    return 0;
}

// ============================================================================
// DAY'S P&L FOR F&O CLOSED-TODAY POSITIONS
// Called during LIFO matching when a closer's date is today.
// openerDate, openerPpu: the opening trade's date and per-unit price
// closerPpu: the closing trade's per-unit price
// priceCache: { lp, ch } for prevClose derivation
// isShort: true if short position (opener = sell, closer = buy)
// Returns: Day P&L contribution for the matched qty
// ============================================================================

function wmsCalcFnoClosedTodayPnl(matchQty, isShort, openerDate, openerPpu, closerPpu, priceCache, todayStr) {
    if (!priceCache || matchQty <= 0) return 0;
    if (!todayStr) todayStr = new Date().toISOString().slice(0, 10);
    var prevClose = (priceCache.lp || 0) - (priceCache.ch || 0);

    if (openerDate === todayStr) {
        // Intraday: opened and closed today → realized P&L IS the Day P&L
        // Long: qty × (sellPrice − buyPrice) = qty × (closerPpu − openerPpu)
        // Short: qty × (sellPrice − buyPrice) = qty × (openerPpu − closerPpu)
        return isShort ? matchQty * (openerPpu - closerPpu) : matchQty * (closerPpu - openerPpu);
    } else {
        // Old position closed today → movement from prevClose to close price
        // Long: qty × (sellPrice − prevClose) = qty × (closerPpu − prevClose)
        // Short: qty × (prevClose − buyPrice) = qty × (prevClose − closerPpu)
        return isShort ? matchQty * (prevClose - closerPpu) : matchQty * (closerPpu - prevClose);
    }
}

// ============================================================================

function wmsIsOptionContract(symbol, shortSymbol) {
    if (!symbol || !shortSymbol) return false;
    if (symbol === shortSymbol) return false;
    return /(?:CE|PE)$/i.test(symbol);
}

function wmsExcludeOpenOptions(txns) {
    // Step 1: identify all option contracts and compute net qty per contract
    var optionContracts = {};   // fullSymbol → net qty
    for (var i = 0; i < txns.length; i++) {
        var t = txns[i];
        var sym = t.symbol || '';
        var shortSym = t.short_symbol || t.symbol || '';
        if (!wmsIsOptionContract(sym, shortSym)) continue;
        if (t.ignore_for_avg_cost) continue;
        var isIncome = WMS_INCOME_TYPES.indexOf(t.transaction_type) >= 0;
        if (isIncome) continue;

        if (optionContracts[sym] === undefined) optionContracts[sym] = 0;
        optionContracts[sym] += (t.quantity || 0);
    }

    // Step 2: build set of open option contracts (net qty != 0)
    var openContracts = {};
    var keys = Object.keys(optionContracts);
    for (var j = 0; j < keys.length; j++) {
        if (optionContracts[keys[j]] !== 0) {
            openContracts[keys[j]] = true;
        }
    }

    // Step 3: if no open options, return original array (fast path)
    if (Object.keys(openContracts).length === 0) return txns;

    // Step 4: filter out transactions belonging to open option contracts
    return txns.filter(function(t) {
        var sym = t.symbol || '';
        return !openContracts[sym];
    });
}

// ============================================================================
// UNIFIED COST ENGINE — FIFO & LIFO (Spec A2)
//
// Single source of truth for lot-based cost calculation across all modules.
// Accepts raw DB-format transactions (snake_case fields). Automatically groups
// by symbol+exchange. Returns holdings (with open lots) and realized gains.
//
// Public API:
//   wmsCalcFifoCost(transactions)  → { holdings, gains }
//   wmsCalcLifoCost(transactions)  → { holdings, gains }
//
// holdings: { 'SYMBOL-EXCHANGE': { symbol, shortSymbol, companyName, exchange,
//             securityType, quantity, totalCost, avgCost, lots, tags } }
// gains:   [ { symbol, shortSymbol, companyName, exchange, securityType,
//             buyDate, sellDate, qty, buyPrice, buyCostPerUnit, sellPrice,
//             sellProceedsPerUnit, buyCost, sellProceeds, gain, holdingDays,
//             investorId, brokerId } ]
//
// Income types (DIVIDEND, INTEREST, etc.) are excluded automatically.
// Transactions MUST be sorted by date ascending before calling.
// ============================================================================

function _wmsCostEngine(transactions, method) {
    // ------------------------------------------------------------------
    // FIFO/LIFO cost engine. Mirrors wmsCalcAvgCost for qty and for non-
    // sell cost adjustments (income, rights payment, historical P&L,
    // options). The ONE difference: SELLs do NOT reduce the holding's
    // totalCost — they are matched against open lots (FIFO or LIFO) and
    // produce realized gain entries. Remaining lot cost is the holding's
    // cost basis.
    //
    // Grouping key (J.2 updated):
    //   • NFO (futures / options contracts): key = full symbol
    //     → ICICIBANK25APRFUT, ICICIBANK25APR1300CE stay as separate rows
    //   • Everything else (EQUITY): key = short_symbol || symbol
    //     → NSE:ICICIBANK and BSE:ICICIBANK merge into ICICIBANK
    //     → SURJIND and SURJIND-PP stay separate (different short_symbols)
    //
    // Qty rules (must match wmsCalcAvgCost):
    //   BUY                 → +quantity,  push lot with costPerUnit = net/qty
    //   SELL                → +quantity (negative), consume lots (FIFO/LIFO),
    //                         record gain entry; short sells push a negative lot
    //   RIGHTS_ENTITLEMENT  → +quantity,  push zero-cost lot
    //   BONUS               → +quantity,  push zero-cost lot
    //   SPLIT               → redistribute cost: existing lots' qty × ratio,
    //                         costPerUnit ÷ ratio. Total cost unchanged.
    //   RIGHTS_PAYMENT      → no qty,     adjustments += net_amount
    //   DIVIDEND / INTEREST
    //    / OTHER_INCOME
    //    / CAPITAL_REDUCTION → no qty,    adjustments -= |net_amount|
    //   HISTORICAL_PL       → no qty,     adjustments -= net_amount (signed)
    //   ignore_for_avg_cost → skip entirely (cost AND qty)
    //
    // Final: holding.totalCost = sum(lot.qty × lot.costPerUnit) + adjustments
    // ------------------------------------------------------------------

    var lots = {};         // key → [ { date, qty, costPerUnit, ... } ]
    var adjustments = {};  // key → number (non-BUY/SELL cost flow)
    var gains = [];        // realized gain events (SELL matches)
    var meta = {};         // key → { symbol, shortSymbol, companyName, exchange, securityType }

    // ------------------------------------------------------------------
    // Theme D (clarified 2026-04-11): F&O contracts ARE processed by
    // FIFO/LIFO, but each contract is its own independent position with
    // its own lots and cost basis — they do NOT fold into the underlying
    // EQ row. This is enforced by `_engineKey` which keys NFO by full
    // symbol (RELIANCE300CE, ICICIBANK25APRFUT) while EQ keys by
    // short_symbol (RELIANCE, ICICIBANK). The avg-cost engine handles
    // the merge-into-underlying behaviour separately via E.12 — that
    // logic does NOT live here. See WMS-LESSONS §J.5.D.
    // ------------------------------------------------------------------
    // Helper: resolve grouping key. EQ → short_symbol, NFO → full symbol.
    // Exchange prefix (e.g. "NSE:") is stripped for NFO because the same
    // contract can carry inconsistent prefixes across txns (some "NSE:XYZFUT",
    // some "XYZFUT") and all inline callers already normalise this way.
    // Without the strip, the engine would produce two phantom holdings that
    // share the same underlying contract. See WMS-LESSONS §J.5.H.
    // ------------------------------------------------------------------
    function _engineKey(txn) {
        var secType = (txn.security_type !== undefined ? txn.security_type : txn.securityType) || 'EQUITY';
        if (secType === 'NFO') {
            var nfoSym = txn.symbol || txn.short_symbol || txn.shortSymbol || '';
            return nfoSym.replace(/^[A-Z]+:/, '');
        }
        return (txn.short_symbol !== undefined ? txn.short_symbol : txn.shortSymbol) || txn.symbol || '';
    }

    // ------------------------------------------------------------------
    // STEP 1 — Walk all transactions in input order (caller sorts by date)
    // ------------------------------------------------------------------
    for (var i = 0; i < transactions.length; i++) {
        var t = transactions[i];
        var txnType = t.transaction_type || t.type || '';
        if (!txnType) continue;
        // Theme B: ignore_for_avg_cost only affects the avg-cost engine.
        // FIFO/LIFO process IGN BUY/SELL trades as normal — they still move
        // qty and cost, they just don't pollute weighted-avg cost basis.
        // (Income / HISTORICAL_PL hit their own skips below regardless.)

        var sym = t.symbol || '';
        var short = (t.short_symbol !== undefined ? t.short_symbol : t.shortSymbol) || sym;

        // Theme D (clarified): F&O does NOT fold into the underlying EQ row,
        // but each futures / options contract IS its own independent position
        // with its own lots and FIFO/LIFO cost basis. The grouping key
        // (`_engineKey`) already keys NFO by full symbol, so each contract
        // becomes its own holdings row. Avg-cost still folds via E.12 in the
        // separate `wmsCalcAvgCost` engine — this engine just runs every NFO
        // txn through the normal BUY/SELL handling below.

        var key = _engineKey(t);
        if (!key) continue;
        var exch = t.exchange || '';
        var txnDate = t.transaction_date || t.date || '';
        var txnQty = Math.abs(t.quantity || 0);
        var txnPrice = t.price || 0;
        var txnNetAmount = (t.display_net_amount !== undefined ? t.display_net_amount
                            : (t.net_amount !== undefined ? t.net_amount : t.netAmount)) || 0;
        var txnInvestorId = (t.investor_id !== undefined ? t.investor_id : t.investorId) || '';
        var txnBrokerId = (t.broker_id !== undefined ? t.broker_id : t.brokerId) || '';
        var txnTags = t.tags || [];
        var txnSecType = (t.security_type !== undefined ? t.security_type : t.securityType) || 'EQUITY';
        var txnCompanyName = (t.company_name !== undefined ? t.company_name : t.companyName) || '';

        if (!lots[key]) lots[key] = [];
        if (!adjustments[key]) adjustments[key] = adjustments[key] || 0;
        if (!meta[key]) {
            meta[key] = {
                symbol: sym,
                shortSymbol: short,
                companyName: txnCompanyName,
                exchange: exch,
                securityType: txnSecType
            };
        } else {
            // Keep first-seen metadata but upgrade company name if missing.
            if (!meta[key].companyName && txnCompanyName) meta[key].companyName = txnCompanyName;
        }

        // ---------- DEMERGER (LESSONS §K.1) ----------
        // Two legs, both transaction_type 'DEMERGER', distinguished by quantity
        // SIGN (the DB forbids quantity 0 — chk_quantity_not_zero):
        //   • Incoming (resulting company, qty > 0): a cost-bearing lot dated to
        //     the ORIGINAL parent lot's buy date (transaction_date carries that
        //     date so the holding period continues). Treated like a fresh BUY lot
        //     — no short-cover logic (a demerger receipt is always a fresh long).
        //   • Parent reduction (qty < 0, a −1 sentinel): scales every OPEN lot's
        //     costPerUnit down by the retained factor f = 1 − price (price holds
        //     the allocated-away fraction, Σ of resulting-company %). Qty + dates
        //     unchanged — mirrors SPLIT's per-lot cost scaling. Cash-neutral; the
        //     sentinel qty is NOT added to the holding.
        if (txnType === 'DEMERGER') {
            var dmgRawQty = t.quantity || 0;
            if (dmgRawQty > 0) {
                lots[key].push({
                    date: txnDate, qty: txnQty, price: txnPrice,
                    costPerUnit: (txnNetAmount / txnQty),
                    investorId: txnInvestorId, brokerId: txnBrokerId, tags: txnTags,
                    securityType: txnSecType, txnId: t.id
                });
            } else {
                // Parent cost-reduction leg (qty < 0). Derive the retained factor
                // from the cost removed (|net_amount|) and the engine's OWN open
                // cost — f = (openCost − removed) / openCost — so the `price` field
                // is free to carry a display-meaningful per-share value.
                var dmgLots = lots[key] || [];
                var dmgOpenCost = 0;
                for (var dmi = 0; dmi < dmgLots.length; dmi++) {
                    if (dmgLots[dmi].qty > 0) dmgOpenCost += dmgLots[dmi].qty * dmgLots[dmi].costPerUnit;
                }
                var dmgRemoved = Math.abs(txnNetAmount);
                var dmgFactor = (dmgOpenCost > 0) ? Math.max(0, (dmgOpenCost - dmgRemoved) / dmgOpenCost) : 1;
                for (var dmj = 0; dmj < dmgLots.length; dmj++) {
                    if (dmgLots[dmj].qty > 0) {
                        dmgLots[dmj].costPerUnit = dmgLots[dmj].costPerUnit * dmgFactor;
                        dmgLots[dmj].price = (dmgLots[dmj].price || 0) * dmgFactor;
                    }
                }
            }
            continue;
        }

        // ---------- BUY ----------
        if (txnType === 'BUY') {
            var costPerUnit = txnQty !== 0 ? txnNetAmount / txnQty : txnPrice;
            // Theme E: a BUY against an existing short position is a COVER.
            // Walk the short lots in FIFO/LIFO order and close them; record
            // realised gain for each match. The cover gain lives only in
            // `gains[]` — it never folds into the lot cost basis. Any
            // remaining BUY qty after all shorts are closed becomes a fresh
            // long lot at the original buy price (clean cost, no fold-in).
            var remainingBuyQty = txnQty;
            var buyPricePerUnit = costPerUnit;
            var consumeFromEndBuy = (method === 'lifo');
            while (remainingBuyQty > 0 && lots[key].length > 0) {
                var sLotIdx = consumeFromEndBuy ? (lots[key].length - 1) : 0;
                var sLot = lots[key][sLotIdx];
                if (sLot.qty >= 0) break; // not a short lot
                var coverQty = Math.min(remainingBuyQty, -sLot.qty);
                // sLot.costPerUnit was set at SELL time as |sellPrice|, so
                // openCost = qty × costPerUnit is the original short proceeds.
                var openCost  = coverQty * sLot.costPerUnit;
                var coverCost = coverQty * buyPricePerUnit;
                var coverGain = openCost - coverCost; // +ve = profit on short
                gains.push({
                    symbol: sym, shortSymbol: meta[key].shortSymbol,
                    companyName: meta[key].companyName, exchange: exch,
                    securityType: txnSecType || sLot.securityType,
                    buyDate: txnDate, sellDate: sLot.date, qty: coverQty,
                    buyPrice: txnPrice, buyCostPerUnit: buyPricePerUnit,
                    sellPrice: sLot.price, sellProceedsPerUnit: sLot.costPerUnit,
                    buyCost: coverCost, sellProceeds: openCost,
                    gain: coverGain, holdingDays: 0,
                    investorId: txnInvestorId, brokerId: txnBrokerId,
                    buyTxnId: t.id, sellTxnId: sLot.txnId
                });
                sLot.qty += coverQty; // qty was negative, move toward 0
                remainingBuyQty -= coverQty;
                if (sLot.qty >= 0) {
                    if (consumeFromEndBuy) lots[key].pop(); else lots[key].shift();
                }
            }
            if (remainingBuyQty > 0) {
                lots[key].push({
                    date: txnDate, qty: remainingBuyQty, price: txnPrice, costPerUnit: costPerUnit,
                    investorId: txnInvestorId, brokerId: txnBrokerId, tags: txnTags,
                    securityType: txnSecType, txnId: t.id
                });
            }
            continue;
        }

        // ---------- SELL ----------
        if (txnType === 'SELL') {
            var remainingSellQty = txnQty;
            var sellPricePerUnit = txnQty !== 0 ? txnNetAmount / txnQty : txnPrice;
            var sellDate = txnDate;

            var consumeFromEnd = (method === 'lifo');
            while (remainingSellQty > 0 && lots[key].length > 0) {
                var lotIdx = consumeFromEnd ? (lots[key].length - 1) : 0;
                var lot = lots[key][lotIdx];
                // Don't try to consume negative (short) lots with a SELL
                if (lot.qty <= 0) break;
                var matchQty = Math.min(remainingSellQty, lot.qty);

                var buyCost = matchQty * lot.costPerUnit;
                var sellProceeds = matchQty * sellPricePerUnit;
                var gainAmt = sellProceeds - buyCost;
                var holdDays = 0;
                if (lot.date && sellDate) {
                    holdDays = Math.floor((new Date(sellDate) - new Date(lot.date)) / 86400000);
                }

                gains.push({
                    symbol: sym, shortSymbol: meta[key].shortSymbol,
                    companyName: meta[key].companyName, exchange: exch,
                    securityType: txnSecType || lot.securityType,
                    buyDate: lot.date, sellDate: sellDate, qty: matchQty,
                    buyPrice: lot.price, buyCostPerUnit: lot.costPerUnit,
                    sellPrice: txnPrice, sellProceedsPerUnit: sellPricePerUnit,
                    buyCost: buyCost, sellProceeds: sellProceeds,
                    gain: gainAmt, holdingDays: holdDays,
                    investorId: txnInvestorId, brokerId: txnBrokerId,
                    buyTxnId: lot.txnId, sellTxnId: t.id
                });

                lot.qty -= matchQty;
                remainingSellQty -= matchQty;
                if (lot.qty <= 0) {
                    if (consumeFromEnd) lots[key].pop(); else lots[key].shift();
                }
            }

            // Unmatched sell qty → short position, push a negative lot
            if (remainingSellQty > 0) {
                lots[key].push({
                    date: sellDate, qty: -remainingSellQty, price: txnPrice,
                    costPerUnit: sellPricePerUnit,
                    investorId: txnInvestorId, brokerId: txnBrokerId, tags: txnTags,
                    securityType: txnSecType, txnId: t.id
                });
            }
            continue;
        }

        // ---------- RIGHTS_ENTITLEMENT / BONUS (zero-cost lot that adds qty)
        if (txnType === 'RIGHTS_ENTITLEMENT' || txnType === 'BONUS') {
            lots[key].push({
                date: txnDate, qty: txnQty, price: 0, costPerUnit: 0,
                investorId: txnInvestorId, brokerId: txnBrokerId, tags: txnTags,
                securityType: txnSecType, txnId: t.id
            });
            continue;
        }

        // ---------- SPLIT (redistribute cost across existing lots)
        // Unlike BONUS which pushes a zero-cost lot, SPLIT adjusts ALL
        // existing lots: each lot's qty is multiplied by the split ratio
        // and costPerUnit/price are divided by it. Total cost unchanged.
        //
        // The split ratio is derived from the transaction:
        //   additionalQty = txnQty (the new shares credited)
        //   existingQty   = sum of all current lot quantities for this key
        //   splitRatio    = (existingQty + additionalQty) / existingQty
        //
        // Example: 100 shares, 1:5 split → 400 additional → ratio = 500/100 = 5
        //   lot {qty:100, cost:200} → {qty:500, cost:40}
        if (txnType === 'SPLIT') {
            var splitLots = lots[key] || [];
            var existingQty = 0;
            for (var si = 0; si < splitLots.length; si++) {
                existingQty += splitLots[si].qty;
            }
            if (existingQty > 0 && txnQty > 0) {
                var splitRatio = (existingQty + txnQty) / existingQty;
                for (var sj = 0; sj < splitLots.length; sj++) {
                    var sLot = splitLots[sj];
                    if (sLot.qty > 0) {
                        sLot.qty = Math.round(sLot.qty * splitRatio);
                        sLot.costPerUnit = sLot.costPerUnit / splitRatio;
                        sLot.price = sLot.price / splitRatio;
                    }
                    // Note: negative (short) lots are left unchanged — a split
                    // on a short position is an edge case we don't handle yet.
                }
            } else if (txnQty > 0) {
                // No existing lots (sold everything before split?) — push
                // zero-cost lot as fallback so qty is still tracked.
                lots[key].push({
                    date: txnDate, qty: txnQty, price: 0, costPerUnit: 0,
                    investorId: txnInvestorId, brokerId: txnBrokerId, tags: txnTags,
                    securityType: txnSecType, txnId: t.id
                });
            }
            continue;
        }

        // ---------- RIGHTS_PAYMENT (Theme F)
        // Walk lots[key] newest-to-oldest looking for zero-cost rights/bonus
        // lots and attach the payment directly to them by raising their
        // costPerUnit. If multiple zero-cost candidates exist (e.g. two
        // rounds of rights), split the payment proportionally to qty so a
        // later partial sell consumes the right basis. Falls back to the
        // legacy `adjustments[]` flow if no zero-cost lot is available.
        if (txnType === 'RIGHTS_PAYMENT') {
            var rpLots = lots[key] || [];
            var rpCandidates = [];
            for (var rci = rpLots.length - 1; rci >= 0; rci--) {
                var rcLot = rpLots[rci];
                if (rcLot.qty > 0 && rcLot.costPerUnit === 0) rpCandidates.push(rcLot);
            }
            // Fallback: partly-paid shares booked as BUY (not RIGHTS_ENTITLEMENT),
            // so no zero-cost lot exists. Attach the call money to the OPEN
            // positive-qty lots pro-rata by qty, so a later partial SELL releases
            // the fully-paid cost. Without this the rights money is stranded in
            // the holding — the bug that over-stated Lloyds by the call on the
            // already-sold shares.
            if (rpCandidates.length === 0) {
                for (var rcf = rpLots.length - 1; rcf >= 0; rcf--) {
                    if (rpLots[rcf].qty > 0) rpCandidates.push(rpLots[rcf]);
                }
            }
            if (rpCandidates.length === 0) {
                adjustments[key] = (adjustments[key] || 0) + txnNetAmount;
                continue;
            }
            var rpTotalQty = 0;
            for (var rcj = 0; rcj < rpCandidates.length; rcj++) rpTotalQty += rpCandidates[rcj].qty;
            if (rpTotalQty <= 0) {
                adjustments[key] = (adjustments[key] || 0) + txnNetAmount;
                continue;
            }
            for (var rck = 0; rck < rpCandidates.length; rck++) {
                var rcc = rpCandidates[rck];
                var share = txnNetAmount * (rcc.qty / rpTotalQty);
                rcc.costPerUnit = (rcc.costPerUnit * rcc.qty + share) / rcc.qty;
            }
            continue;
        }

        // ---------- DIVIDEND / INTEREST / OTHER_INCOME → SKIP (Theme A)
        // Periodic income is part of the avg-cost return calculation only.
        // FIFO/LIFO realises gain/loss on actual lot disposal, so income
        // here would double-count. CAPITAL_REDUCTION is genuine return of
        // capital, so it still flows through as a cost reduction.
        if (txnType === 'DIVIDEND' || txnType === 'INTEREST' || txnType === 'OTHER_INCOME') {
            continue;
        }
        if (WMS_INCOME_TYPES.indexOf(txnType) >= 0) {  // CAPITAL_REDUCTION lands here
            adjustments[key] = (adjustments[key] || 0) - Math.abs(txnNetAmount);
            continue;
        }

        // ---------- HISTORICAL_PL → SKIP (Theme C)
        // Historical realised P&L was computed under avg-cost rules and
        // would inject phantom basis under FIFO/LIFO. The avg engine still
        // honours it; FIFO/LIFO ignores it entirely.
        if (txnType === 'HISTORICAL_PL') {
            continue;
        }

        // Anything else is ignored (e.g. unknown types).
    }

    // ------------------------------------------------------------------
    // STEP 2 — Build holdings from remaining lots + adjustments
    // ------------------------------------------------------------------
    var holdings = {};
    var allKeys = {};
    var lotKeys = Object.keys(lots);
    for (var lk = 0; lk < lotKeys.length; lk++) allKeys[lotKeys[lk]] = true;
    var adjKeys = Object.keys(adjustments);
    for (var ak = 0; ak < adjKeys.length; ak++) allKeys[adjKeys[ak]] = true;

    var finalKeys = Object.keys(allKeys);
    for (var kk = 0; kk < finalKeys.length; kk++) {
        var hKey = finalKeys[kk];
        var lotArr = lots[hKey] || [];
        var totalQty = 0;
        var lotCost = 0;
        var tagsSet = {};
        for (var j = 0; j < lotArr.length; j++) {
            var lt = lotArr[j];
            totalQty += lt.qty;
            lotCost += lt.qty * lt.costPerUnit;
            if (lt.tags) {
                for (var ti = 0; ti < lt.tags.length; ti++) tagsSet[lt.tags[ti]] = true;
            }
        }
        var totalCost = lotCost + (adjustments[hKey] || 0);

        // Avg cost rule mirrors wmsCalcAvgCost (I.3.4):
        //   long  (qty>0) → totalCost>0 ? totalCost/qty : 0
        //   short (qty<0) → |totalCost/qty|
        //   flat  (qty=0) → 0
        var avgCost = 0;
        if (totalQty > 0) {
            avgCost = totalCost > 0 ? totalCost / totalQty : 0;
        } else if (totalQty < 0) {
            avgCost = Math.abs(totalCost / totalQty);
        }

        // Skip empty rows entirely (no lots, no cost residual)
        if (lotArr.length === 0 && !adjustments[hKey]) continue;

        var m = meta[hKey] || {};
        holdings[hKey] = {
            symbol: m.symbol || '',
            shortSymbol: m.shortSymbol || hKey,
            companyName: m.companyName || '',
            exchange: m.exchange || '',
            securityType: m.securityType || 'EQUITY',
            quantity: totalQty,
            totalCost: wmsRoundMoney(totalCost),
            avgCost: wmsRoundMoney(avgCost),
            lots: lotArr,
            tags: Object.keys(tagsSet)
        };
    }

    return { holdings: holdings, gains: gains };
}

function wmsCalcFifoCost(transactions) {
    return _wmsCostEngine(transactions, 'fifo');
}

function wmsCalcLifoCost(transactions) {
    return _wmsCostEngine(transactions, 'lifo');
}

// ============================================================================
// SHARED LIVE PRICE CACHE + FETCH PROTOCOL
// ============================================================================
//
// SINGLE SOURCE OF TRUTH for equity price resolution.
// Both Positions (trading.js) and Watchlist (trading-watchlist.js) use this.
//
// Architecture:
//   wmsLivePrices    — shared cache, key = shortSymbol (underlying)
//   wmsFetchEquityPrices() — 3-stage resolution, writes to wmsLivePrices
//
// Consumers:
//   Positions:  calls wmsFetchEquityPrices() directly in trFetchLivePrices()
//   Watchlist:  Stage 1 (Fyers batch) is watchlist-specific because it uses
//               per-item _fyersSymbol (which may already be BSE/broker_tokens).
//               For unresolved equity items, it delegates to wmsFetchEquityPrices().
//               After each fetch cycle, trWlSyncToSharedCache() copies all
//               watchlist equity prices into wmsLivePrices.
//
// If a price is already in wmsLivePrices with lp > 0, it's reused (not refetched).
// This means: if Watchlist runs first, Positions skips those symbols.
//
// Protocol (3 stages):
//   Stage 1: Fyers batch — uses broker_tokens.fyers if available, else NSE:SYMBOL-EQ
//   Stage 2: Alternate Fyers symbols (BSE, -SM, broker_tokens from securities_db)
//   Stage 3: Yahoo Finance fallback via Supabase edge function
//
// Stages 2+3 only run on the first fetch cycle (not auto-refresh).
// Resolved symbols are persisted to securities_db.broker_tokens via
// wmsUpdateBrokerToken() so future fetches hit Stage 1 directly.
// ============================================================================

var wmsLivePrices = {};       // shortSymbol → { lp, ch, chp, high, low, resolvedSymbol }
var wmsLivePriceFirstFetch = false;  // Stage 2+3 only on first load

/**
 * wmsFetchFnoContractPrices — fetch live prices for F&O contracts.
 * Uses full symbol (e.g. MANAPPURAM26MAR305PE) with NSE: prefix for Fyers.
 * Stores results in wmsLivePrices keyed by full symbol.
 *
 * @param {Array} symbols — array of full F&O symbol strings
 * @param {boolean} [forceRefresh] — if true, re-fetch even cached symbols
 * @returns {Promise} — resolves when done; prices stored in wmsLivePrices
 */
async function wmsFetchFnoContractPrices(symbols, forceRefresh) {
    if (!symbols || symbols.length === 0) return;
    if (!window.fyersToken || !window.fyersCall) return;

    // Filter out already-cached symbols (unless forceRefresh)
    var toFetch = forceRefresh ? symbols.slice() : symbols.filter(function(sym) {
        return !wmsLivePrices[sym] || wmsLivePrices[sym].lp <= 0;
    });
    if (toFetch.length === 0) return;

    // Batch fetch from Fyers (NSE: prefix for F&O contracts)
    for (var i = 0; i < toFetch.length; i += 50) {
        var chunk = toFetch.slice(i, i + 50);
        var fyersKeys = chunk.map(function(s) { return 'NSE:' + s; });
        try {
            var data = await window.fyersCall({ action: 'quotes', symbols: fyersKeys });
            if (data && data.d) {
                data.d.forEach(function(item) {
                    if (item.v && item.v.lp > 0 && item.v.short_name) {
                        wmsLivePrices[item.v.short_name] = {
                            lp: item.v.lp,
                            ch: item.v.ch || 0,
                            chp: item.v.chp || 0,
                            high: item.v.high_price || null,
                            low: item.v.low_price || null,
                            resolvedSymbol: item.v.symbol
                        };
                    }
                });
            }
        } catch (err) {
            console.warn('wmsFetchFnoContractPrices: error:', err.message);
        }
        if (i + 50 < toFetch.length) {
            await new Promise(function(r) { setTimeout(r, 200); });
        }
    }
}

/**
 * wmsFetchEquityPrices — 3-stage price resolution protocol.
 *   Stage 1: Fyers batch — broker_tokens.fyers if available, else NSE:SYMBOL-EQ
 *   Stage 2: Alternate Fyers symbols (BSE, -SM, broker_tokens) for unresolved
 *   Stage 3: Yahoo Finance fallback
 *
 * @param {Array} items — [{ shortSymbol, securityId }]
 * @param {boolean} [forceRefresh] — if true, re-fetch even cached symbols
 * @returns {Promise} — resolves when done; prices stored in wmsLivePrices
 */
async function wmsFetchEquityPrices(items, forceRefresh) {
    if (!items || items.length === 0) return;
    if (!window.fyersToken && !window.SUPABASE_URL) return;

    // De-duplicate by shortSymbol, skip those already in cache with a positive lp
    var toFetch = [];
    var seen = {};
    items.forEach(function(it) {
        var sym = it.shortSymbol;
        if (!sym || seen[sym]) return;
        seen[sym] = true;
        if (!forceRefresh && wmsLivePrices[sym] && wmsLivePrices[sym].lp > 0) return; // already cached
        toFetch.push(it);
    });
    if (toFetch.length === 0) return;

    // ── Stage 1: Fyers batch — use broker_tokens if available, else NSE:SYMBOL-EQ ──
    var respondedSymbols = {};
    // Map each Fyers key back to its shortSymbol for response parsing
    var fyersKeyToShort = {};
    if (window.fyersToken && window.fyersCall) {
        var fyersKeys = [];
        toFetch.forEach(function(it) {
            var fKey = null;
            // Use broker_tokens.fyers if available (previously resolved, most reliable)
            var dbRec = it.securityId && wmsRefData.securitiesCmMap
                ? wmsRefData.securitiesCmMap[it.securityId] : null;
            if (dbRec && dbRec.broker_tokens && dbRec.broker_tokens.fyers) {
                var btf = dbRec.broker_tokens.fyers;
                fKey = btf.nse_symbol || btf.bse_symbol || null;
            }
            // Default: NSE:SYMBOL-EQ
            if (!fKey) fKey = 'NSE:' + it.shortSymbol + '-EQ';
            if (fyersKeys.indexOf(fKey) < 0) {
                fyersKeys.push(fKey);
            }
            fyersKeyToShort[fKey] = it.shortSymbol;
        });

        // Batch into chunks of 50
        for (var i = 0; i < fyersKeys.length; i += 50) {
            var chunk = fyersKeys.slice(i, i + 50);
            try {
                var data = await window.fyersCall({ action: 'quotes', symbols: chunk });
                if (data && data.d && data.d.length > 0) {
                    data.d.forEach(function(item) {
                        if (item.v && item.v.symbol) {
                            respondedSymbols[item.v.symbol] = true;
                            // Resolve shortSymbol: first try our map, then regex fallback
                            var ss = fyersKeyToShort[item.v.symbol];
                            if (!ss) {
                                var parts = item.v.symbol.match(/^[A-Z]+:(.+)-[A-Z]+$/);
                                ss = parts ? parts[1] : null;
                            }
                            if (ss) {
                                wmsLivePrices[ss] = {
                                    lp: item.v.lp || 0,
                                    ch: item.v.ch || 0,
                                    chp: item.v.chp || 0,
                                    high: item.v.high_price || null,
                                    low: item.v.low_price || null,
                                    resolvedSymbol: item.v.symbol
                                };
                            }
                        }
                    });
                }
            } catch (err) {
                console.warn('wmsLivePrices: Fyers batch error:', err.message);
            }
            if (i + 50 < fyersKeys.length) {
                await new Promise(function(r) { setTimeout(r, 200); });
            }
        }
    }

    // Stage 2+3: only on first fetch, not on auto-refresh
    if (wmsLivePriceFirstFetch) return;

    // Identify unresolved items (no response or lp=0)
    var unresolved = toFetch.filter(function(it) {
        var cached = wmsLivePrices[it.shortSymbol];
        return !cached || cached.lp <= 0;
    });

    if (unresolved.length === 0) {
        wmsLivePriceFirstFetch = true;
        return;
    }

    // ── Stage 2: Alternate Fyers symbols ──
    if (window.fyersToken && window.fyersCall) {
        for (var j = 0; j < unresolved.length; j++) {
            var uItem = unresolved[j];
            var sym = uItem.shortSymbol;
            var sid = uItem.securityId;

            // Build candidate symbols from wmsRefData
            var candidates = [];
            var dbRec = sid && wmsRefData.securitiesCmMap ? wmsRefData.securitiesCmMap[sid] : null;
            if (!dbRec && wmsRefData.securitiesCmReady) {
                for (var k = 0; k < wmsRefData.securitiesCm.length; k++) {
                    var s = wmsRefData.securitiesCm[k];
                    if (s.symbol === sym || s.nse_symbol === sym || s.bse_symbol === sym) {
                        dbRec = s; break;
                    }
                }
            }

            var baseSymbols = [];
            if (dbRec) {
                // Check broker_tokens first (most reliable)
                if (dbRec.broker_tokens && dbRec.broker_tokens.fyers) {
                    var btf = dbRec.broker_tokens.fyers;
                    if (btf.nse_symbol && candidates.indexOf(btf.nse_symbol) < 0) candidates.push(btf.nse_symbol);
                    if (btf.bse_symbol && candidates.indexOf(btf.bse_symbol) < 0) candidates.push(btf.bse_symbol);
                }
                if (dbRec.nse_symbol) baseSymbols.push(dbRec.nse_symbol);
                if (dbRec.bse_symbol) baseSymbols.push(dbRec.bse_symbol);
                if (dbRec.symbol && baseSymbols.indexOf(dbRec.symbol) < 0) baseSymbols.push(dbRec.symbol);
            }
            if (baseSymbols.indexOf(sym) < 0) baseSymbols.push(sym);

            var bseSuffixes = ['', '-A', '-B', '-D', '-E', '-G', '-M', '-P', '-R', '-T', '-W', '-X', '-Z'];
            baseSymbols.forEach(function(bs) {
                var nseEq = 'NSE:' + bs + '-EQ';
                var nseSm = 'NSE:' + bs + '-SM';
                if (candidates.indexOf(nseEq) < 0) candidates.push(nseEq);
                if (candidates.indexOf(nseSm) < 0) candidates.push(nseSm);
                bseSuffixes.forEach(function(sfx) {
                    var bseSym = 'BSE:' + bs + sfx;
                    if (candidates.indexOf(bseSym) < 0) candidates.push(bseSym);
                });
            });

            // Remove the symbol already tried in Stage 1
            var tried = 'NSE:' + sym + '-EQ';
            candidates = candidates.filter(function(c) { return c !== tried; });
            if (candidates.length === 0) continue;

            try {
                var data2 = await window.fyersCall({ action: 'quotes', symbols: candidates });
                if (data2 && data2.d && data2.d.length > 0) {
                    for (var m = 0; m < data2.d.length; m++) {
                        var q = data2.d[m];
                        if (q.v && q.v.lp > 0) {
                            wmsLivePrices[sym] = {
                                lp: q.v.lp, ch: q.v.ch || 0, chp: q.v.chp || 0,
                                high: q.v.high_price || null, low: q.v.low_price || null,
                                resolvedSymbol: q.v.symbol
                            };
                            console.log('wmsLivePrices: Resolved', sym, '→', q.v.symbol);
                            // Persist broker_tokens in background
                            if (sid) wmsUpdateBrokerToken(sid, q.v.symbol);
                            break;
                        }
                    }
                }
            } catch (err) {
                console.warn('wmsLivePrices: Resolution failed for', sym, ':', err.message);
            }

            if (j < unresolved.length - 1) {
                await new Promise(function(r) { setTimeout(r, 150); });
            }
        }
    }

    // Refresh unresolved list after Stage 2
    unresolved = unresolved.filter(function(it) {
        var cached = wmsLivePrices[it.shortSymbol];
        return !cached || cached.lp <= 0;
    });

    // ── Stage 3: Yahoo Finance fallback ──
    if (unresolved.length > 0 && window.SUPABASE_URL) {
        var yahooSymbolMap = {};
        unresolved.forEach(function(uIt) {
            var s = uIt.shortSymbol;
            var dr = uIt.securityId && wmsRefData.securitiesCmMap ? wmsRefData.securitiesCmMap[uIt.securityId] : null;
            var bases = [];
            if (dr) {
                if (dr.nse_symbol) bases.push(dr.nse_symbol + '.NS');
                if (dr.bse_symbol) bases.push(dr.bse_symbol + '.BO');
                if (!dr.nse_symbol && !dr.bse_symbol && dr.symbol) {
                    bases.push(dr.symbol + '.NS');
                    bases.push(dr.symbol + '.BO');
                }
            }
            if (bases.length === 0) {
                bases.push(s + '.NS');
                bases.push(s + '.BO');
            }
            bases.forEach(function(ys) {
                if (!yahooSymbolMap[ys]) yahooSymbolMap[ys] = [];
                yahooSymbolMap[ys].push(uIt);
            });
        });

        var yahooSymbols = Object.keys(yahooSymbolMap);
        if (yahooSymbols.length > 0) {
            try {
                var resp = await fetch(SUPABASE_URL + '/functions/v1/yahoo-finance', {
                    method: 'POST',
                    headers: wmsEdgeHeaders({'Content-Type': 'application/json'}),
                    body: JSON.stringify({ symbols: yahooSymbols })
                });
                if (resp.ok) {
                    var result = await resp.json();
                    if (result && result.results) {
                        yahooSymbols.forEach(function(ySym) {
                            var yData = result.results[ySym];
                            if (!yData || !yData.regularMarketPrice || yData.regularMarketPrice <= 0) return;
                            var mappedItems = yahooSymbolMap[ySym];
                            mappedItems.forEach(function(mIt) {
                                if (wmsLivePrices[mIt.shortSymbol] && wmsLivePrices[mIt.shortSymbol].lp > 0) return;
                                wmsLivePrices[mIt.shortSymbol] = {
                                    lp: yData.regularMarketPrice,
                                    ch: yData.regularMarketChange || 0,
                                    chp: yData.regularMarketChangePercent || 0,
                                    high: yData.regularMarketDayHigh || null,
                                    low: yData.regularMarketDayLow || null,
                                    resolvedSymbol: 'YAHOO:' + ySym
                                };
                                console.log('wmsLivePrices: Yahoo resolved', mIt.shortSymbol, '→', ySym);
                            });
                        });
                    }
                }
            } catch (err) {
                console.warn('wmsLivePrices: Yahoo fallback error:', err.message);
            }
        }
    }

    wmsLivePriceFirstFetch = true;
}

/**
 * Persist resolved Fyers symbol to securities_db broker_tokens (background).
 */
function wmsUpdateBrokerToken(securityId, fyersSymbol) {
    if (!securityId || !fyersSymbol) return;
    fetch(SUPABASE_URL + '/rest/v1/securities_db?id=eq.' + securityId + '&select=broker_tokens', {
        headers: wmsHeaders()
    }).then(function(resp) { return resp.json(); }).then(function(rows) {
        if (!rows || rows.length === 0) return;
        var bt = rows[0].broker_tokens || {};
        if (!bt.fyers) bt.fyers = {};
        if (fyersSymbol.indexOf('NSE:') === 0) bt.fyers.nse_symbol = fyersSymbol;
        else if (fyersSymbol.indexOf('BSE:') === 0) bt.fyers.bse_symbol = fyersSymbol;
        return fetch(SUPABASE_URL + '/rest/v1/securities_db?id=eq.' + securityId, {
            method: 'PATCH',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'}),
            body: JSON.stringify({ broker_tokens: bt })
        });
    }).catch(function(err) { console.warn('wmsUpdateBrokerToken:', err.message); });
}

// Resolve and persist Fyers broker_tokens for an NFO security.
// Calls the Fyers quotes API to validate the symbol and get the canonical response,
// then PATCHes broker_tokens into securities_nfo — same pattern as wmsUpdateBrokerToken
// for securities_db. Runs in the background (fire-and-forget).
// fyersSymbol: the Fyers-format symbol (e.g. NSE:MANAPPURAM26MAR255CE or bare MANAPPURAM26MAR255CE)
function wmsUpdateNfoBrokerToken(securityId, fyersSymbol) {
    if (!securityId || !fyersSymbol) return;
    if (!window.fyersToken || !window.fyersCall) return;

    // Ensure exchange prefix for Fyers API call
    var apiSymbol = fyersSymbol.indexOf(':') >= 0 ? fyersSymbol : 'NSE:' + fyersSymbol;

    // 1. Call Fyers quotes API to validate and get canonical symbol
    window.fyersCall({ action: 'quotes', symbols: [apiSymbol] }).then(function(data) {
        if (!data || !data.d || data.d.length === 0) return;
        var v = data.d[0].v;
        if (!v || !v.symbol) return;

        var resolvedSymbol = v.symbol;  // Canonical Fyers symbol from API response
        console.log('wmsUpdateNfoBrokerToken: resolved', apiSymbol, '→', resolvedSymbol);

        // 2. Read current broker_tokens from DB
        return fetch(SUPABASE_URL + '/rest/v1/securities_nfo?id=eq.' + securityId + '&select=broker_tokens', {
            headers: wmsHeaders()
        }).then(function(resp) { return resp.json(); }).then(function(rows) {
            if (!rows || rows.length === 0) return;
            var bt = rows[0].broker_tokens || {};
            // Only update if fyers tokens are not already set
            if (bt.fyers && bt.fyers.symbol) return;
            bt.fyers = { symbol: resolvedSymbol };
            if (resolvedSymbol.indexOf('NSE:') === 0) bt.fyers.nse_symbol = resolvedSymbol;
            else if (resolvedSymbol.indexOf('BSE:') === 0) bt.fyers.bse_symbol = resolvedSymbol;

            // 3. PATCH back to DB
            return fetch(SUPABASE_URL + '/rest/v1/securities_nfo?id=eq.' + securityId, {
                method: 'PATCH',
                headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'}),
                body: JSON.stringify({ broker_tokens: bt })
            });
        });
    }).catch(function(err) { console.warn('wmsUpdateNfoBrokerToken:', err.message); });
}

// ============================================================================
// SHARED AUTO-REFRESH (Rule D.12.11)
// Centralised market-hours check and per-tab auto-refresh timer management.
// STANDARD REFRESH SYSTEM
// Single refresh cycle for the entire app. Fetches prices for ALL symbols
// (transactions + watchlist), then renders the active page + banners.
//
// Triggers:
//   - 10s timer (market hours)
//   - Tab/page change
//   - Window/tab focus (visibility change)
//   - Modal close
//   - Manual refresh button
//   - Transaction add/edit/delete
//   - Watchlist add/remove
//
// Architecture:
//   wmsBuildRefreshSymbols() → builds master symbol list
//   wmsStandardRefresh()    → fetches prices + renders active page
//   wmsStartRefreshTimer()  → starts 10s timer
//
// Multi-Tab Sync (BroadcastChannel):
//   wmsTabSyncInit()  → probe for existing leader, elect if none
//   Leader tab:  runs wmsStandardRefresh() + broadcasts wmsLivePrices
//   Follower tab: receives prices from leader, calls wmsRefreshRender()
//   If leader closes or times out (15s), follower promotes itself
// ============================================================================

// ── Tab Sync: Leader Election + Price Sharing ───────────────────────────
var wmsTabId = 'tab-' + Math.random().toString(36).substr(2, 8);
var wmsTabIsLeader = false;
var wmsTabChannel = null;
var _wmsLeaderHbTimer = null;     // leader sends heartbeat every 5s
var _wmsLeaderTimeout = null;     // follower: timeout to detect dead leader
var _wmsTabSyncReady = false;     // true once role (leader/follower) is decided

/**
 * wmsTabSyncInit — call once on script load.
 * Sends a probe; if a leader responds within 2s we stay follower,
 * otherwise we promote ourselves to leader.
 */
function wmsTabSyncInit() {
    if (typeof BroadcastChannel === 'undefined') {
        wmsTabIsLeader = true;
        _wmsTabSyncReady = true;
        return; // no support — always leader
    }

    wmsTabChannel = new BroadcastChannel('wms-tab-sync');
    wmsTabChannel.onmessage = _wmsTabOnMessage;

    // Ask if a leader exists
    wmsTabChannel.postMessage({ type: 'probe', tabId: wmsTabId });

    // If no heartbeat in 2s → become leader
    setTimeout(function() {
        if (!_wmsTabSyncReady) _wmsPromoteToLeader();
    }, 2000);

    // On tab close: resign leadership so a follower can take over
    window.addEventListener('beforeunload', function() {
        if (wmsTabIsLeader && wmsTabChannel) {
            wmsTabChannel.postMessage({ type: 'resign', tabId: wmsTabId });
        }
        if (_wmsLeaderHbTimer) clearInterval(_wmsLeaderHbTimer);
    });
}

function _wmsTabOnMessage(e) {
    var msg = e.data;
    if (!msg || msg.tabId === wmsTabId) return; // ignore own messages

    if (msg.type === 'heartbeat') {
        // Another tab is already leader
        if (!_wmsTabSyncReady) {
            wmsTabIsLeader = false;
            _wmsTabSyncReady = true;
            wmsStopRefreshTimer(); // follower does not run its own timer
            console.log('wmsTabSync: [' + wmsTabId + '] → FOLLOWER (leader: ' + msg.tabId + ')');
        }
        _wmsResetLeaderTimeout();
    }

    if (msg.type === 'prices' && !wmsTabIsLeader) {
        // Follower: ingest prices from leader
        var p = msg.prices;
        if (p) {
            for (var k in p) wmsLivePrices[k] = p[k];
            wmsRefreshRender();
        }
    }

    if (msg.type === 'probe' && wmsTabIsLeader) {
        // New tab asking if leader exists → respond with heartbeat + cached prices
        wmsTabChannel.postMessage({ type: 'heartbeat', tabId: wmsTabId });
        if (Object.keys(wmsLivePrices).length > 0) {
            wmsTabChannel.postMessage({ type: 'prices', prices: wmsLivePrices, tabId: wmsTabId });
        }
    }

    if (msg.type === 'resign') {
        // Leader closed → promote ourselves
        console.log('wmsTabSync: leader resigned → promoting self');
        _wmsPromoteToLeader();
    }

    if (msg.type === 'txn-changed') {
        // Another tab changed the transactions — bring THIS tab's shared cache
        // current (its own cheap checksum→delta) and re-render if visible, so
        // every open tab stays in sync. (§A.9.7)
        if (typeof wmsTxnSyncNow === 'function') {
            wmsTxnSyncNow().then(function(changed) {
                if (changed && !document.hidden && typeof wmsRenderActiveModuleAfterTxn === 'function') {
                    wmsRenderActiveModuleAfterTxn();
                }
            }).catch(function() {});
        }
    }
}

function _wmsPromoteToLeader() {
    wmsTabIsLeader = true;
    _wmsTabSyncReady = true;
    if (_wmsLeaderTimeout) { clearTimeout(_wmsLeaderTimeout); _wmsLeaderTimeout = null; }
    console.log('wmsTabSync: [' + wmsTabId + '] → LEADER');

    // Start heartbeat so followers know we're alive
    if (_wmsLeaderHbTimer) clearInterval(_wmsLeaderHbTimer);
    _wmsLeaderHbTimer = setInterval(function() {
        if (wmsTabChannel) wmsTabChannel.postMessage({ type: 'heartbeat', tabId: wmsTabId });
    }, 5000);
    if (wmsTabChannel) wmsTabChannel.postMessage({ type: 'heartbeat', tabId: wmsTabId });

    // Start refresh timer if a market is open (equity, or MCX with MCX symbols)
    if (wmsIsRefreshWindow() && window.fyersToken) {
        wmsStartRefreshTimer();
    }
}

function _wmsResetLeaderTimeout() {
    if (_wmsLeaderTimeout) clearTimeout(_wmsLeaderTimeout);
    _wmsLeaderTimeout = setTimeout(function() {
        console.log('wmsTabSync: leader heartbeat timeout → promoting self');
        _wmsPromoteToLeader();
    }, 15000);
}

// Initialize tab sync immediately
wmsTabSyncInit();

var wmsRefreshSymbols = [];    // [{ fyersKey, cacheKey }, ...]
var wmsRefreshTimer = null;    // single setInterval ID
var wmsRefreshInterval = 10000; // 10 seconds (base tick + equity cadence)
var wmsMcxRefreshInterval = 120000; // 2 minutes — cadence during MCX-only evening
var _wmsLastMcxFetch = 0;       // timestamp of last evening MCX-only fetch
var wmsRefreshFirstDone = false; // first-load flag for Stage 2+3 resolution

// Symbol-provider registry — extension point so any module (e.g. Auto Trading)
// can fold its symbols into the SINGLE refresh list. Each provider is a function
// returning [{ fyersKey, cacheKey }]. This keeps the whole app on ONE
// wmsStandardRefresh / ONE cadence rather than module-local timers + fetches.
var wmsRefreshSymbolProviders = {};
function wmsRegisterRefreshSymbolProvider(key, fn) {
    if (typeof fn === 'function') wmsRefreshSymbolProviders[key] = fn;
}

// Legacy aliases — kept so existing callers don't break during migration
var wmsAutoRefreshTimers = {};
function wmsStartAutoRefresh(id, opts) { /* no-op: replaced by standard refresh */ }
function wmsStopAutoRefresh(id) { /* no-op: replaced by standard refresh */ }

/**
 * wmsIsMarketHours — returns true during Indian market hours.
 * Mon-Fri 9:15 AM – 3:30 PM IST with a 5-min buffer on each side.
 */
function wmsIsMarketHours() {
    var now = new Date();
    var utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
    var ist = new Date(utcMs + (5.5 * 3600000));
    var day = ist.getDay();
    if (day === 0 || day === 6) return false;
    var timeInMinutes = ist.getHours() * 60 + ist.getMinutes();
    return timeInMinutes >= 550 && timeInMinutes <= 935;
}

/**
 * wmsIsMcxHours — true during the MCX commodity session (Mon-Fri, ~9:00 AM–
 * 11:55 PM IST with a 5-min buffer). MCX bullion/metals (GOLD, SILVER, GOLDM,
 * SILVERM, …) trade far later than NSE/BSE equity, so open MCX positions need
 * live prices into the night. Upper bound 11:55 PM covers the DST-extended close.
 * (LESSONS §E.11.9)
 */
function wmsIsMcxHours() {
    var now = new Date();
    var utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
    var ist = new Date(utcMs + (5.5 * 3600000));
    var day = ist.getDay();
    if (day === 0 || day === 6) return false;
    var t = ist.getHours() * 60 + ist.getMinutes();
    return t >= 535 && t <= 1435; // 8:55 AM – 11:55 PM IST
}

/**
 * wmsHasMcxSymbols — true if the current refresh list holds any MCX contract
 * (fyersKey prefixed 'MCX:'). Gates the evening MCX-only refresh so users with
 * no commodity exposure still stop refreshing at the equity close.
 */
function wmsHasMcxSymbols() {
    return wmsRefreshSymbols.some(function(s) { return /^MCX:/.test(s.fyersKey); });
}

/**
 * wmsIsRefreshWindow — the single gate for "should the price-refresh timer run?":
 * EITHER equity is open, OR MCX is open AND we actually hold MCX symbols. Used by
 * every timer start/stop/visibility check so refresh continues through the MCX
 * evening session for commodity positions only.
 */
function wmsIsRefreshWindow() {
    return wmsIsMarketHours() || (wmsIsMcxHours() && wmsHasMcxSymbols());
}

/**
 * wmsBuildRefreshSymbols — build master list of unique symbols to fetch.
 * Sources: (a) all transaction symbols, (b) all watchlist symbols.
 * Call this whenever transactions or watchlist items change.
 */
function wmsBuildRefreshSymbols() {
    var seen = {};
    var list = [];

    // 1. Equity symbols from transactions
    if (typeof trTransactions !== 'undefined' && trTransactions) {
        trTransactions.forEach(function(t) {
            if (t.security_type === 'NFO' || t.security_type === 'MCX') return;
            var ss = t.short_symbol;
            if (!ss || seen[ss]) return;
            seen[ss] = true;
            var fKey = null;
            var dbRec = (typeof wmsRefData !== 'undefined' && wmsRefData.securitiesCmMap)
                ? wmsRefData.securitiesCmMap[t.security_id] : null;
            if (dbRec && dbRec.broker_tokens && dbRec.broker_tokens.fyers) {
                fKey = dbRec.broker_tokens.fyers.nse_symbol || dbRec.broker_tokens.fyers.bse_symbol;
            }
            if (!fKey) fKey = 'NSE:' + ss + '-EQ';
            list.push({ fyersKey: fKey, cacheKey: ss });
        });
    }

    // 2. F&O symbols from transactions
    if (typeof trTransactions !== 'undefined' && trTransactions) {
        trTransactions.forEach(function(t) {
            if (t.security_type !== 'NFO' && t.security_type !== 'MCX') return;
            if (!t.symbol || t.symbol === t.short_symbol) return;
            var bare = t.symbol.replace(/^[A-Z]+:/, '');
            if (!seen[bare]) {
                seen[bare] = true;
                // Keep the stored exchange prefix when present (the working path).
                // If a symbol somehow lacks a prefix, default by segment: MCX
                // commodity contracts → 'MCX:', everything else → 'NSE:'. Previously
                // this always fell back to 'NSE:', which would mis-route an
                // unprefixed MCX symbol. Robustness guard — no effect on existing
                // (prefixed) data.
                var fKey = t.symbol.indexOf(':') >= 0
                    ? t.symbol
                    : ((t.security_type === 'MCX' ? 'MCX:' : 'NSE:') + bare);
                list.push({ fyersKey: fKey, cacheKey: bare });
            }
            // Also add the underlying equity symbol so portfolio rows can look up
            // by shortSymbol (e.g., 'SHRIRAMFIN') even for F&O-only positions
            var underlying = t.short_symbol;
            if (underlying && !seen[underlying]) {
                seen[underlying] = true;
                list.push({ fyersKey: 'NSE:' + underlying + '-EQ', cacheKey: underlying });
            }
        });
    }

    // 2b. Reports module transactions (camelCase, may exist if Reports is active)
    if (typeof rptTransactions !== 'undefined' && rptTransactions) {
        rptTransactions.forEach(function(t) {
            if (t.securityType === 'NFO' || t.securityType === 'MCX') return;
            var ss = t.shortSymbol;
            if (!ss || seen[ss]) return;
            seen[ss] = true;
            // Same broker_tokens lookup as Trading (section 1) — handles REITs, InvITs, BSE stocks
            var fKey = null;
            var dbRec = (typeof wmsRefData !== 'undefined' && wmsRefData.securitiesCmMap)
                ? wmsRefData.securitiesCmMap[t.securityId] : null;
            if (dbRec && dbRec.broker_tokens && dbRec.broker_tokens.fyers) {
                fKey = dbRec.broker_tokens.fyers.nse_symbol || dbRec.broker_tokens.fyers.bse_symbol;
            }
            if (!fKey) fKey = 'NSE:' + ss + '-EQ';
            list.push({ fyersKey: fKey, cacheKey: ss });
        });
    }

    // 3. Watchlist symbols (may include securities not in transactions)
    if (typeof trWlWatchlists !== 'undefined' && trWlWatchlists) {
        trWlWatchlists.forEach(function(wl) {
            wl.items.forEach(function(item) {
                if (!item._fyersSymbol) return;
                // Derive cacheKey: for equity use short_symbol, for NFO strip prefix
                var cacheKey = item.short_symbol;
                if (item.security_source === 'securities_nfo' || item.security_source === 'options_dynamic') {
                    cacheKey = item._fyersSymbol.replace(/^[A-Z]+:/, '');
                }
                if (!cacheKey || seen[cacheKey]) return;
                seen[cacheKey] = true;
                list.push({ fyersKey: item._fyersSymbol, cacheKey: cacheKey });
            });
        });
    }

    // 4. Extra symbols from registered providers (e.g. Auto Trading open trades)
    Object.keys(wmsRefreshSymbolProviders).forEach(function (k) {
        var extra;
        try { extra = wmsRefreshSymbolProviders[k](); } catch (e) { extra = null; }
        (extra || []).forEach(function (s) {
            if (!s || !s.fyersKey || !s.cacheKey || seen[s.cacheKey]) return;
            seen[s.cacheKey] = true;
            list.push({ fyersKey: s.fyersKey, cacheKey: s.cacheKey });
        });
    });

    wmsRefreshSymbols = list;
    console.log('wmsBuildRefreshSymbols:', list.length, 'unique symbols');
}

/**
 * wmsStandardRefresh — the ONE refresh function called by ALL triggers.
 * 1. Fetches prices for all symbols in wmsRefreshSymbols
 * 2. Renders the active page + updates banners
 *
 * @param {boolean} [forceRefresh=false] — true = refetch all; false = only uncached
 */
async function wmsStandardRefresh(forceRefresh, opts) {
    opts = opts || {};
    if (!window.fyersToken || !window.fyersCall) return;
    if (wmsRefreshSymbols.length === 0) return;

    // Tab Sync note: follower protection is structural, not checked here.
    // - The 10s refresh timer only runs on the leader (wmsStartRefreshTimer guards it)
    // - The visibilitychange handler only refreshes on the leader
    // - Manual refreshes (e.g. after transaction edit) work on both tabs normally

    // 1. Determine which symbols need fetching
    var toFetch = forceRefresh
        ? wmsRefreshSymbols.slice()
        : wmsRefreshSymbols.filter(function(s) {
            return !wmsLivePrices[s.cacheKey] || wmsLivePrices[s.cacheKey].lp <= 0;
        });

    // MCX-only mode (evening timer cycles): keep just the MCX contracts so we
    // don't re-poll closed equities every cycle. First-load and manual refresh
    // pass no opts, so they still fetch everything once. (LESSONS §E.11.9)
    if (opts.mcxOnly) {
        toFetch = toFetch.filter(function(s) { return /^MCX:/.test(s.fyersKey); });
    }

    // 2. Batch fetch from Fyers (chunks of 50)
    if (toFetch.length > 0) {
        for (var i = 0; i < toFetch.length; i += 50) {
            var chunk = toFetch.slice(i, i + 50);
            var fyersKeys = chunk.map(function(s) { return s.fyersKey; });
            try {
                var data = await window.fyersCall({ action: 'quotes', symbols: fyersKeys });
                if (data && data.d) {
                    data.d.forEach(function(item) {
                        if (!item.v) return;
                        var priceData = {
                            lp: item.v.lp || 0,
                            ch: item.v.ch || 0,
                            chp: item.v.chp || 0,
                            high: item.v.high_price || null,
                            low: item.v.low_price || null,
                            resolvedSymbol: item.v.symbol
                        };
                        // Store under all relevant keys so every consumer finds it
                        if (item.v.symbol) wmsLivePrices[item.v.symbol] = priceData;
                        if (item.v.short_name) wmsLivePrices[item.v.short_name] = priceData;
                        // Map back to our requested cacheKey + fyersKey
                        chunk.forEach(function(s) {
                            var retBase = (item.v.symbol || '').replace(/^[A-Z]+:/, '');
                            var reqBase = s.fyersKey.replace(/^[A-Z]+:/, '');
                            if (retBase === reqBase || item.v.short_name === s.cacheKey) {
                                wmsLivePrices[s.cacheKey] = priceData;
                                wmsLivePrices[s.fyersKey] = priceData;
                            }
                        });
                    });
                }
            } catch (err) {
                console.warn('wmsStandardRefresh: batch error:', err.message);
            }
            if (i + 50 < toFetch.length) {
                await new Promise(function(r) { setTimeout(r, 200); });
            }
        }
    }

    // 3. First-load only: run Stage 2+3 resolution for unresolved equity symbols
    if (!wmsRefreshFirstDone && !opts.mcxOnly && typeof wmsFetchEquityPrices === 'function') {
        var unresolvedEquity = [];
        wmsRefreshSymbols.forEach(function(s) {
            // Only equity (has -EQ suffix in fyersKey)
            if (s.fyersKey.indexOf('-EQ') < 0) return;
            var cached = wmsLivePrices[s.cacheKey];
            if (cached && cached.lp > 0) return;
            unresolvedEquity.push({ shortSymbol: s.cacheKey, securityId: null });
        });
        if (unresolvedEquity.length > 0) {
            console.log('wmsStandardRefresh: Stage 2+3 for', unresolvedEquity.length, 'unresolved equity');
            await wmsFetchEquityPrices(unresolvedEquity);
        }
        wmsRefreshFirstDone = true;
    }

    // 4. Broadcast prices to follower tabs
    if (wmsTabIsLeader && wmsTabChannel) {
        try {
            wmsTabChannel.postMessage({ type: 'prices', prices: wmsLivePrices, tabId: wmsTabId });
        } catch (err) { /* ignore serialization errors on large payloads */ }
    }

    // 5. Render active page + update banners
    wmsRefreshRender();
}

/**
 * wmsRefreshRender — update the UI after prices are fetched.
 * Detects which module/tab is active and renders accordingly.
 */
function wmsRefreshRender() {
    // Always update the global Fyers refresh time indicator (in app header)
    wmsUpdateFyersTime();

    // Check if Trading module is active (portfolio tab element exists in DOM)
    var isTradingActive = !!document.getElementById('tr-portfolio');

    if (isTradingActive) {
        var activeTab = document.querySelector('.trading-tab-content.active');
        var activeId = activeTab ? activeTab.id : '';

        if (activeId === 'tr-portfolio') {
            // trRenderPortfolio internally calls trComputeBannerStats
            if (typeof trRenderPortfolio === 'function') trRenderPortfolio();
        } else {
            // Not on portfolio — still compute stocks banner from cached prices
            if (typeof trComputeBannerStats === 'function') trComputeBannerStats();
            // Render active F&O, Watchlist, or Statements tab
            if (activeId === 'tr-fno-positions' && typeof trFnoRender === 'function') {
                trFnoRender();
            } else if (activeId === 'tr-watchlist' && typeof trWlUpdatePricesInPlace === 'function') {
                trWlUpdatePricesInPlace();
            } else if (activeId === 'tr-ledger' && typeof lgRenderSummary === 'function') {
                // Re-render Open Positions table + Summary cards so CMP reflects
                // the freshly-fetched wmsLivePrices. Only runs if lgInit has
                // already completed (guarded by typeof check).
                try { lgRenderSummary(); } catch (err) { console.warn('Statements render failed:', err); }
            }
        }

        // Always refresh F&O banner (reads from wmsLivePrices cache — fast)
        if (typeof trFnoBannerRefreshFromDefault === 'function') {
            trFnoBannerRefreshFromDefault();
        }

        // Update price status indicator
        if (typeof trUpdatePriceStatus === 'function') trUpdatePriceStatus('live');
    }

    // Check if Reports module is active
    var isReportsActive = !!document.getElementById('rptPortfolioBody');
    if (isReportsActive && typeof rptRenderPortfolio === 'function') {
        rptRenderPortfolio();
        if (typeof rptUpdatePriceStatus === 'function') rptUpdatePriceStatus('live');
    }

    // Auto Trading module — re-render open-trade P&L from the shared price cache.
    // The module no longer runs its own timer/fetch (LESSONS §E.11.10).
    if (typeof autoOnSharedRefresh === 'function') {
        try { autoOnSharedRefresh(); } catch (err) { console.warn('Auto refresh render failed:', err); }
    }
}

/**
 * wmsUpdateFyersTime — update the global fyers-refresh-time in app header.
 * Called after every successful price fetch, regardless of active module.
 */
function wmsUpdateFyersTime() {
    var el = document.getElementById('fyers-refresh-time');
    if (!el) return;
    var now = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    el.textContent = now;
    var marketOpen = typeof wmsIsRefreshWindow === 'function' && wmsIsRefreshWindow();
    el.style.color = marketOpen ? '#059669' : '#dc2626';
}

/**
 * wmsStartRefreshTimer — start the single 10s auto-refresh timer.
 * Runs always (not tab-dependent). Stops if market closes.
 */
function wmsStartRefreshTimer() {
    // Only the leader tab runs the API refresh timer
    if (_wmsTabSyncReady && !wmsTabIsLeader) return;
    wmsStopRefreshTimer();
    wmsRefreshTimer = setInterval(async function() {
        if (document.hidden) return;
        var equityOpen = wmsIsMarketHours();
        var mcxOpen = wmsIsMcxHours() && wmsHasMcxSymbols();
        if (!equityOpen && !mcxOpen) {
            wmsStopRefreshTimer();
            if (typeof trUpdatePriceStatus === 'function') trUpdatePriceStatus('last-txn');
            return;
        }
        if (equityOpen) {
            // Equity hours: full refresh every tick (10s).
            await wmsStandardRefresh(true);
        } else {
            // Equity closed, MCX open: fetch ONLY MCX contracts, throttled to the
            // MCX cadence (default 2 min) so we don't re-poll closed equities and
            // keep overnight API load low. (LESSONS §E.11.9)
            var now = Date.now();
            if (now - _wmsLastMcxFetch < wmsMcxRefreshInterval) return;
            _wmsLastMcxFetch = now;
            await wmsStandardRefresh(true, { mcxOnly: true });
        }
    }, wmsRefreshInterval);
}

/**
 * wmsStopRefreshTimer — stop the 10s timer.
 */
function wmsStopRefreshTimer() {
    if (wmsRefreshTimer) {
        clearInterval(wmsRefreshTimer);
        wmsRefreshTimer = null;
    }
}

// Resume refresh when page becomes visible again
document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
        // Page became visible — leader does an immediate refresh + restarts timer;
        // follower just renders from cache (leader will broadcast shortly)
        if (wmsIsRefreshWindow() && window.fyersToken) {
            if (wmsTabIsLeader) {
                wmsStandardRefresh(true);
                wmsStartRefreshTimer();
            } else {
                wmsRefreshRender();
            }
        }
    }
});

// ============================================================================
// BACKGROUND TRANSACTIONS AUTO-SYNC (LESSONS §A.9.7)
// A 2-minute background poll — SEPARATE from the 10s price ticker so it never
// disturbs it, but reusing the same gates (market window + visibility) + the
// tab channel. The VISIBLE tab polls; on a real change (checksum moved) it
// re-renders the active module AND broadcasts a `txn-changed` ping so every
// other open tab brings its own cache current. Switching to a tab
// (visibilitychange) also syncs immediately — so whichever tab the user is on
// is always up to date, however many tabs are open. Cheap when idle (one small
// checksum RPC every 2 min); a delta fetch happens only on a real change.
// ============================================================================
var wmsTxnAutoSyncTimer = null;
var WMS_TXN_SYNC_INTERVAL = 120000; // 2 minutes
var _wmsTxnRenderInFlight = false;

// True while an edit / transaction-list modal is open — never disturb it.
function _wmsTxnModalIsOpen() {
    var em = document.getElementById('wmsEditModal');
    var tm = document.getElementById('wmsTxnModal');
    return (em && em.classList.contains('show')) || (tm && tm.classList.contains('show'));
}

// Re-render whatever module is currently showing transaction-derived data,
// mirroring each module's post-write afterChange. No-op while a modal is open.
function wmsRenderActiveModuleAfterTxn() {
    if (_wmsTxnModalIsOpen() || _wmsTxnRenderInFlight) return;
    _wmsTxnRenderInFlight = true;
    try {
        if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
        if (document.getElementById('tr-portfolio')) {
            // Trading active — same re-render the edit modal's afterChange uses.
            if (typeof trRefreshAllViews === 'function') trRefreshAllViews();
            var lg = document.getElementById('tr-ledger');
            if (lg && lg.classList.contains('active') && typeof lgRefresh === 'function') {
                try { lgRefresh(); } catch (e) { /* ignore */ }
            }
        } else if (document.getElementById('rptPortfolioBody')) {
            // Reports active — re-map from the shared cache, then re-render.
            if (typeof rptLoadData === 'function') {
                rptLoadData().then(function() {
                    if (typeof rptRenderPortfolio === 'function') rptRenderPortfolio();
                }).catch(function() {});
            }
        }
    } finally {
        _wmsTxnRenderInFlight = false;
    }
}

// Bring the shared cache current (cheap checksum gate → delta only on change).
// Returns true if the cache changed. Skipped while the cache isn't ready or a
// modal is open.
async function wmsTxnSyncNow() {
    if (!window._wmsTxnCache || _wmsTxnModalIsOpen()) return false;
    var before = window._wmsTxnCache.checksum;
    try { await wmsLoadTransactions(); } catch (e) { return false; }
    return !!(window._wmsTxnCache && window._wmsTxnCache.checksum !== before);
}

function wmsTxnAutoSyncStart() {
    if (wmsTxnAutoSyncTimer) return;
    wmsTxnAutoSyncTimer = setInterval(async function() {
        if (document.hidden) return;                                                    // only the visible tab polls
        if (typeof wmsIsRefreshWindow === 'function' && !wmsIsRefreshWindow()) return;  // market window (same gate as prices)
        var changed = await wmsTxnSyncNow();
        var mChanged = false;
        try { mChanged = await wmsMastersSyncNow(); } catch (e) {}                        // masters: same cadence, one probe RPC
        if (changed && wmsTabChannel) { try { wmsTabChannel.postMessage({ type: 'txn-changed', tabId: wmsTabId }); } catch (e) {} }
        if (changed || mChanged) wmsRenderActiveModuleAfterTxn();
    }, WMS_TXN_SYNC_INTERVAL);
}

function wmsTxnAutoSyncStop() {
    if (wmsTxnAutoSyncTimer) { clearInterval(wmsTxnAutoSyncTimer); wmsTxnAutoSyncTimer = null; }
}

// On becoming visible, sync immediately (regardless of market hours — a manual
// entry made in another tab should show the moment you switch back) + render on change.
document.addEventListener('visibilitychange', function() {
    if (document.hidden) return;
    Promise.all([
        wmsTxnSyncNow().catch(function() { return false; }),
        wmsMastersSyncNow().catch(function() { return false; })
    ]).then(function(res) {
        if (res[0] || res[1]) wmsRenderActiveModuleAfterTxn();
    });
});

// Start the 2-min background poll once, at module load. The tick self-gates on
// visibility + market hours, and wmsTxnSyncNow no-ops until the shared cache +
// auth are ready — so this is safe to arm before the first startup load finishes.
wmsTxnAutoSyncStart();

// ============================================================================
// VIEW-FILTER EVALUATION (LESSONS §E.17.8)
// Single source of truth for "does this candidate row match this filter?".
// Used by:
//   • lgRefresh (transaction display filter)
//   • wmsBuildLedger._entryMatchesFilters (ledger display filter)
//   • wmsFindLatestReconForTxn (pre-recon edit/delete guard)
//   • lgReconReviewOpen (dirty-txn filter)
//
// Semantics (matches how portfolio_views.filters JSON is authored by the UI):
//   • Empty array on any dimension = "no constraint" (any/all match).
//   • Non-empty investorIds = candidate.investor_id must be in the list.
//   • Non-empty traderIds   = effective trader (candidate.trader_id OR, if
//                             null, candidate.investor_id) must be in the list.
//   • Non-empty brokerIds   = candidate.broker_id must be set AND in list.
//   • Non-empty tagNames    = candidate.tags must satisfy the tagLogic join
//                             (AND/OR) of every tagName. Ignored when the
//                             candidate has no `tags` field (ledger entries).
// ============================================================================

function wmsMatchesViewFilter(candidate, filters) {
    if (!candidate || !filters) return true;
    var investors = filters.investorIds || [];
    var traders   = filters.traderIds   || [];
    var brokers   = filters.brokerIds   || [];
    var tagNames  = filters.tagNames    || [];
    var tagLogic  = filters.tagLogic    || 'OR';

    if (investors.length > 0 && investors.indexOf(candidate.investor_id) < 0) return false;
    if (traders.length > 0) {
        var effTrader = candidate.trader_id || candidate.investor_id;
        if (!effTrader || traders.indexOf(effTrader) < 0) return false;
    }
    if (brokers.length > 0) {
        if (!candidate.broker_id || brokers.indexOf(candidate.broker_id) < 0) return false;
    }
    if (tagNames.length > 0 && Array.isArray(candidate.tags)) {
        if (typeof wmsMatchTagsFilter === 'function' &&
            !wmsMatchTagsFilter(candidate.tags, tagNames, tagLogic)) return false;
    }
    return true;
}

// ============================================================================
// STT ELIGIBILITY CHECK (Rule G.8.5)
// Equity cash-market stocks attract STT AND stamp duty — both main-board
// (EQUITY) and SME-board (EQUITY_SME) at the same rates.  Non-equity
// instruments (ETFs, MFs, debt, SGBs, REITs, InvITs, NCDs, etc.) are exempt.
// F&O has its own STT schedule handled separately — this helper is only
// consulted for EQUITY-segment CN imports.
// Source: Finance Act schedule — EQUITY_SME is not on the STT exemption list.
// ============================================================================

function wmsIsSTTEligible(securityType) {
    var t = (securityType || '').toUpperCase();
    return t === 'EQUITY' || t === 'EQUITY_SME';
}

// ============================================================================
// CHARGE CALCULATION HELPERS — parameterized (no global deps)
// All take ibaRatesMap/regCharges as explicit parameters.
// ============================================================================

/**
 * Check if an IBA has charges_inclusive flag set.
 * @param {Object} ibaRatesMap  The "investorId|brokerId" → {rates, charges_inclusive} map
 * @param {string} investorId
 * @param {string} brokerId
 * @returns {boolean}
 */
function wmsIsChargesInclusive(ibaRatesMap, investorId, brokerId) {
    var ibaEntry = ibaRatesMap[investorId + '|' + brokerId];
    return ibaEntry ? ibaEntry.charges_inclusive : false;
}

/**
 * Get brokerage for a transaction from IBA rates (Rule G.2.2 / G.2.10).
 *
 * Asset_class fallback (G.2.10): the `transactions` DB table doesn't carry
 * `asset_class` — it's a derived attribute of `securities_nfo`. Any caller
 * passing `assetClass = undefined` for an NFO row would historically have
 * routed OPTIONS through the FUTURES pricing branch (78× under-charge on
 * per-lot flat tariffs). To prevent this for every present and future
 * caller, the function now resolves a missing assetClass internally via
 * `wmsRefData.securitiesNfoMap[securityId].instrument_type` / `option_type`,
 * falling back to a `/(CE|PE)$/` symbol regex, and finally to FUTURES.
 * Pass the optional `securityId` and `symbol` so the lookup can run; if
 * neither is available the symbol regex / FUTURES fallback still applies.
 * Callers that pass an explicit assetClass keep their original behaviour.
 *
 * @param {Object} ibaRatesMap     The IBA rates map
 * @param {string} investorId
 * @param {string} brokerId
 * @param {number} grossAmount     Absolute gross amount (qty × price)
 * @param {string} securityType    'EQUITY', 'ETF', 'NFO', etc.
 * @param {string} [assetClass]    'OPTIONS' / 'FUTURES' for NFO; resolved if missing
 * @param {number} price           Per-unit price
 * @param {number} quantity        Signed quantity
 * @param {number} lots            Number of lots (for options flat rate)
 * @param {boolean} [inclusiveOverride]  G.2.9a override for the inclusive flag
 * @param {string} [securityId]    NEW (G.2.10) — used for asset_class fallback lookup
 * @param {string} [symbol]        NEW (G.2.10) — used for asset_class regex fallback
 * @returns {number} Brokerage amount rounded to 2 decimal places
 */
function wmsGetBrokerage(ibaRatesMap, investorId, brokerId, grossAmount, securityType, assetClass, price, quantity, lots, inclusiveOverride, securityId, symbol) {
    if (!brokerId) return 0;
    var ibaEntry = ibaRatesMap[investorId + '|' + brokerId];
    if (!ibaEntry) return 0;
    var rates = ibaEntry.rates;
    // Rule G.2.9a — when an explicit inclusive flag is supplied by the caller
    // (e.g. trader_charges must use the SAME formula as total_charges so they
    // can't diverge on the same transaction), honour it instead of reading
    // the per-IBA flag. Passing undefined preserves legacy behaviour.
    var useInclusive = (inclusiveOverride === undefined)
        ? ibaEntry.charges_inclusive
        : inclusiveOverride;

    // Rule G.2.10 — resolve asset_class fallback for NFO when caller passed
    // it as undefined / null / ''. Single resolution point; every caller
    // (current and future) gets the right pricing branch automatically.
    var effAssetClass = assetClass;
    if (!effAssetClass && (securityType === 'NFO' || securityType === 'MCX')) {
        var nfo = (typeof wmsRefData !== 'undefined' && wmsRefData && wmsRefData.securitiesNfoMap && securityId)
            ? wmsRefData.securitiesNfoMap[securityId] : null;
        if (nfo) {
            if (nfo.instrument_type === 'OPTIONS' || nfo.instrument_type === 'FUTURES') {
                effAssetClass = nfo.instrument_type;
            } else if (nfo.option_type) {
                effAssetClass = 'OPTIONS';
            }
        }
        if (!effAssetClass) {
            var sym = (symbol || '').toUpperCase();
            effAssetClass = /(CE|PE)$/.test(sym) ? 'OPTIONS' : 'FUTURES';
        }
    }

    // Navigate the rates JSONB: equity.delivery for EQUITY/ETF, derivatives.futures/options
    // for NFO and MCX (commodity futures/options price off the same derivatives segment).
    var segment = null;
    if (securityType === 'NFO' || securityType === 'MCX') {
        if (effAssetClass === 'OPTIONS' && rates.derivatives && rates.derivatives.options) {
            segment = rates.derivatives.options;
        } else {
            segment = rates.derivatives ? rates.derivatives.futures : null;
        }
    } else {
        segment = rates.equity ? rates.equity.delivery : null;
    }
    if (!segment) return 0;

    // Flat rate (options) — flat × |lots|, capped at max (max 0 = no cap)
    if (segment.flat !== undefined) {
        var absLots = Math.abs(lots || 0) || 1;  // fallback to 1 lot if not available
        var flatCalc = segment.flat * absLots;
        var flatMax = segment.max || 0;
        if (flatMax > 0 && flatCalc > flatMax) flatCalc = flatMax;
        return wmsRoundMoney(flatCalc);
    }

    var pct = segment.pct || 0;
    var max = segment.max || 0;

    // pct is stored as decimal (e.g., 0.005 = 0.5%). NOT a percentage — do NOT divide by 100
    // When charges_inclusive: brokerage = ROUNDUP(price * pct, 2) * abs(qty)
    // Otherwise: brokerage = round(gross * pct, 2)
    var calc;
    if (useInclusive && price && quantity) {
        var perShare = Math.ceil(price * pct * 100) / 100;  // ROUNDUP to 2 decimal places
        calc = perShare * Math.abs(quantity);
    } else {
        calc = wmsRoundMoney(grossAmount * pct);
    }
    if (max > 0 && calc > max) calc = max;
    return wmsRoundMoney(calc);
}

/**
 * Single source of truth for `trader_charges` computation (Rule G.2.9 / G.2.10).
 *
 * Used by every code path that needs to compute trader_charges:
 *   - wmsAutoCalcCharges Step 9 (Add Transaction, fresh-calc imports)
 *   - wmsRecalcTraderCharges (Edit modal — trader dropdown change)
 *   - _wmsCalcSplitTraderCharges (Split preview — partial-qty new row)
 *
 * Same-entity short-circuit: when traderId is missing or equals investorId,
 * returns 0 (no perspective adjustment needed).
 *
 * Inclusive-flag rule (G.2.9a): always reads `charges_inclusive` from the
 * INVESTOR's IBA, never the trader's, so trader_charges and total_charges
 * agree on the rounding formula on the same transaction.
 *
 * Asset_class rule (G.2.10): the `transactions` DB table doesn't carry
 * asset_class — it's derived from securities_nfo. The caller may pass an
 * explicit assetClass; if missing on an NFO row, the helper resolves it
 * from `wmsRefData.securitiesNfoMap[securityId].instrument_type` /
 * `option_type` / symbol regex `/(CE|PE)$/`. This is the ONLY place that
 * resolution lives — consumers must NOT mutate `txn.asset_class` directly
 * (doing so leaks the field into DB-write payloads where the column doesn't
 * exist, triggering PGRST204).
 *
 * @param {object} opts
 * @param {object} opts.ibaRatesMap   wmsRefData.ibaRatesMap
 * @param {string} opts.investorId
 * @param {string} opts.brokerId
 * @param {string} opts.traderId      may equal investorId — short-circuits to 0
 * @param {string} opts.securityType  'NFO', 'EQUITY', etc.
 * @param {string} [opts.assetClass]  'OPTIONS' / 'FUTURES' for NFO; resolved if missing
 * @param {string} [opts.securityId]  Used for NFO asset_class fallback lookup
 * @param {string} [opts.symbol]      Used for NFO asset_class regex fallback
 * @param {number} opts.gross         |gross_amount| of the slice being charged
 * @param {number} opts.price
 * @param {number} opts.quantity      Signed or absolute — wmsGetBrokerage uses abs
 * @param {number} opts.lots
 * @returns {number} Rupees, rounded to 2 dp. 0 when no trader perspective applies.
 */
function wmsCalcTraderCharges(opts) {
    if (!opts) return 0;
    var ibaRatesMap = opts.ibaRatesMap;
    var investorId = opts.investorId;
    var brokerId = opts.brokerId;
    var traderId = opts.traderId;

    if (!ibaRatesMap || !brokerId) return 0;
    if (!traderId || traderId === investorId) return 0;

    // Investor's inclusive flag — NOT the trader's (G.2.9a).
    var inclusive = wmsIsChargesInclusive(ibaRatesMap, investorId, brokerId);

    // asset_class fallback (G.2.10) is now handled inside wmsGetBrokerage —
    // we just pass securityId + symbol through and the underlying function
    // resolves OPTIONS / FUTURES from securities_nfo when missing.
    return wmsGetBrokerage(ibaRatesMap, traderId, brokerId, opts.gross || 0,
        opts.securityType, opts.assetClass, opts.price, opts.quantity, opts.lots,
        inclusive, opts.securityId, opts.symbol) || 0;
}

/**
 * Get regulatory charge rate from config (Rule G.7.1).
 * Falls back to NSE if exchange-specific rate not found (STT, SEBI, stamp are national).
 * @param {Array} regCharges   Array from regulatory_charges_config
 * @param {string} chargeType  'STT', 'EXCHANGE_CHARGES', 'SEBI_CHARGES', 'STAMP_DUTY', 'IPFT'
 * @param {string} txnCategory 'EQUITY_DELIVERY', 'EQUITY_FUTURES', 'EQUITY_OPTIONS'
 * @param {string} txnType     'BUY' or 'SELL'
 * @param {string} exchange    'NSE', 'BSE', 'MCX'
 * @returns {number} Rate percentage (e.g., 0.1 means 0.1%)
 */
function wmsGetRegRate(regCharges, chargeType, txnCategory, txnType, exchange) {
    var exch = exchange || 'NSE';

    // Fast path: use pre-built index if available (O(1) lookup)
    if (wmsRefData.regChargesIndex) {
        var key = chargeType + '|' + txnCategory + '|' + txnType + '|' + exch;
        var rate = wmsRefData.regChargesIndex[key];
        if (rate !== undefined) return rate;
        // Fallback: BSE/MCX → try NSE (national charges)
        if (exch !== 'NSE') {
            var nseKey = chargeType + '|' + txnCategory + '|' + txnType + '|NSE';
            var nseRate = wmsRefData.regChargesIndex[nseKey];
            if (nseRate !== undefined) return nseRate;
        }
        return 0;
    }

    // Slow path fallback: linear scan (only if index not built yet)
    for (var i = 0; i < regCharges.length; i++) {
        var rc = regCharges[i];
        if (rc.charge_type === chargeType &&
            rc.transaction_category === txnCategory &&
            rc.transaction_type === txnType &&
            rc.exchange === exch) {
            return rc.rate_percentage || 0;
        }
    }
    if (exch !== 'NSE') {
        for (var j = 0; j < regCharges.length; j++) {
            var rc2 = regCharges[j];
            if (rc2.charge_type === chargeType &&
                rc2.transaction_category === txnCategory &&
                rc2.transaction_type === txnType &&
                rc2.exchange === 'NSE') {
                return rc2.rate_percentage || 0;
            }
        }
    }
    return 0;
}

// ============================================================================
// AUTO-CALCULATE CHARGES (Rule G.2 — complete calculation sequence)
// Single canonical implementation. Options control behaviour differences
// between Excel import (preserveExisting=true) and Add Transaction (false).
// ============================================================================

/**
 * Auto-calculate all charges for a transaction row.
 * Implements the full G.2 calculation sequence (Steps 1-9).
 *
 * @param {Object} row  Transaction row object (mutated in place)
 * @param {Object} opts Options:
 *   - ibaRatesMap {Object}   The IBA rates map (required)
 *   - regCharges  {Array}    Regulatory charges config array (required)
 *   - investorId  {string}   Investor ID (required)
 *   - brokerId    {string}   Broker ID (required)
 *   - preserveExisting {boolean}  If true, skip fields that already have values
 *                                 (Excel import mode). If false, always recalculate (Add Txn mode).
 *   - debug       {boolean}  If true, console.log charge breakdown
 */
function wmsAutoCalcCharges(row, opts) {
    var ibaRatesMap = opts.ibaRatesMap;
    var regCharges = opts.regCharges;
    var investorId = opts.investorId;
    var brokerId = opts.brokerId;
    var preserve = opts.preserveExisting || false;
    var debug = opts.debug || false;
    var gross = row.gross_amount || 0;

    if (!investorId || !brokerId || gross === 0) {
        if (!preserve) row.net_amount = gross;
        return;
    }

    // Determine transaction category (Rule G.1.1)
    var txnCat = 'EQUITY_DELIVERY';
    if (row.security_type === 'NFO') {
        var symUp = (row.symbol || '').toUpperCase();
        if (symUp.match(/(CE|PE)$/) || (row.asset_class && row.asset_class === 'OPTIONS')) {
            txnCat = 'EQUITY_OPTIONS';
        } else {
            txnCat = 'EQUITY_FUTURES';
        }
    } else if (row.security_type === 'MCX') {
        // MCX commodities use the COMMODITY_* config categories (2026-07-23). Additive:
        // only this branch is new; EQUITY/NFO paths above are unchanged. `exchange`
        // below already resolves to 'MCX' from row.exchange, so the commodity rows
        // (STT/CTT, exchange, sebi, stamp) are picked up instead of the NSE fallback.
        var symUpMcx = (row.symbol || '').toUpperCase();
        if (symUpMcx.match(/(CE|PE)$/) || (row.asset_class && row.asset_class === 'OPTIONS')) {
            txnCat = 'COMMODITY_OPTIONS';
        } else {
            txnCat = 'COMMODITY_FUTURES';
        }
    }
    var exchange = (row.exchange === 'NFO' || !row.exchange) ? 'NSE' : row.exchange;
    var txnType = row.transaction_type || 'BUY';

    // Income type override (Rule G.3.1)
    if (wmsIsIncomeType(txnType)) {
        var incomeTds = (row.total_charges || 0) + (row.trader_charges || 0);
        if (row.tds && row.tds > 0) incomeTds = row.tds; // explicit tds takes priority
        row.tds = wmsRoundMoney(incomeTds);
        row.brokerage = 0;
        row.stt = 0;
        row.gst = 0;
        row.other_charges = 0;
        row.total_charges = row.tds;
        row.trader_charges = 0;
        row.net_amount = wmsRoundMoney(gross - row.tds);
        return;
    }

    var inclusive = wmsIsChargesInclusive(ibaRatesMap, investorId, brokerId);

    // Step 2: Brokerage (Rule G.2.2). Pass security_id + symbol so wmsGetBrokerage
    // can resolve asset_class internally when the caller didn't set it on the row
    // (G.2.10 — DB-loaded NFO rows have no asset_class column).
    var shouldCalcBrokerage = preserve
        ? (row.brokerage === null || row.brokerage === undefined || row.brokerage === 0)
        : true;
    if (shouldCalcBrokerage) {
        row.brokerage = wmsGetBrokerage(ibaRatesMap, investorId, brokerId, gross,
            row.security_type, row.asset_class, row.price, row.quantity, row.lots,
            undefined, row.security_id, row.symbol);
    }

    // Step 3: charges_inclusive check (Rule G.2.3)
    if (inclusive) {
        row.stt = 0;
        row.other_charges = 0;
        row.gst = 0;
        if (!row._totalOverride && (!preserve || row.total_charges === null || row.total_charges === undefined)) {
            row.total_charges = row.brokerage;
        }
        if (debug) console.log('Charges (inclusive):', { brokerage: row.brokerage, total: row.total_charges });
    } else {
        // Step 4: STT (Rule G.2.4) — check STT eligibility
        var sttRate = wmsGetRegRate(regCharges, 'STT', txnCat, txnType, exchange);
        var shouldCalcStt = preserve
            ? (row.stt === null || row.stt === undefined || row.stt === 0)
            : true;
        if (shouldCalcStt) {
            // STT eligibility: only EQUITY stocks attract STT (Rule G.8.5)
            var secTypeForStt = row._db_security_type || row.security_type || '';
            if (!wmsIsSTTEligible(secTypeForStt) && row.security_type !== 'NFO' && row.security_type !== 'MCX') {
                // Non-equity cash market instruments (ETF, MF, debt, SGB) — no STT.
                // MCX is excluded from this force-zero (2026-07-23): a commodity's
                // transaction tax (CTT) lives in the COMMODITY_* config under charge_type
                // 'STT', so let the rate lookup decide (0 today for futures; CTT when added).
                row.stt = 0;
            } else if (sttRate > 0) {
                var sttRaw = gross * (sttRate / 100);
                if (txnCat === 'EQUITY_DELIVERY') {
                    row.stt = Math.ceil(sttRaw);  // Round UP to whole number for equity delivery
                } else {
                    row.stt = wmsRoundMoney(sttRaw);  // 2 decimal places for F&O
                }
            } else {
                row.stt = 0;
            }
        }

        // Step 5: Regulatory sub-charges (Rule G.2.5)
        var exchRate = wmsGetRegRate(regCharges, 'EXCHANGE_CHARGES', txnCat, txnType, exchange);
        var sebiRate = wmsGetRegRate(regCharges, 'SEBI_CHARGES', txnCat, txnType, exchange);
        var stampRate = wmsGetRegRate(regCharges, 'STAMP_DUTY', txnCat, txnType, exchange);
        var ipftRate = wmsGetRegRate(regCharges, 'IPFT', txnCat, txnType, exchange);

        var shouldCalcOther = preserve
            ? (!row._exchange_charges && row._exchange_charges !== 0)
            : true;
        if (shouldCalcOther) {
            row._exchange_charges = wmsRoundMoney(gross * (exchRate / 100));
            row._sebi_charges = wmsRoundMoney(gross * (sebiRate / 100));
            // Stamp duty: same STT eligibility check for cash market instruments
            var secTypeForStamp = row._db_security_type || row.security_type || '';
            if (!wmsIsSTTEligible(secTypeForStamp) && row.security_type !== 'NFO' && row.security_type !== 'MCX') {
                row._stamp_duty = 0;
            } else {
                row._stamp_duty = wmsRoundMoney(gross * (stampRate / 100));
            }
            row._ipft = wmsRoundMoney(gross * (ipftRate / 100));
        }

        var shouldCalcOtherTotal = preserve
            ? (row.other_charges === null || row.other_charges === undefined || row.other_charges === 0)
            : true;
        if (shouldCalcOtherTotal) {
            row.other_charges = wmsRoundMoney(
                (row._exchange_charges || 0) + (row._sebi_charges || 0) +
                (row._stamp_duty || 0) + (row._ipft || 0));
        }

        // Step 6: GST (Rule G.2.6)
        var shouldCalcGst = preserve
            ? (row.gst === null || row.gst === undefined || row.gst === 0)
            : true;
        if (shouldCalcGst) {
            row.gst = wmsRoundMoney(
                (row.brokerage + (row._exchange_charges || 0) + (row._sebi_charges || 0)) * 0.18);
        }

        // Step 7: Total charges (Rule G.2.7)
        if (!row._totalOverride && (!preserve || row.total_charges === null || row.total_charges === undefined || row.total_charges === 0)) {
            row.total_charges = wmsRoundMoney(row.brokerage + row.stt + row.other_charges + row.gst);
        }

        if (debug) {
            console.log('Charges (non-inclusive):', {
                brokerage: row.brokerage, stt: row.stt, sttRate: sttRate,
                exchRate: exchRate, exch: row._exchange_charges,
                sebiRate: sebiRate, sebi: row._sebi_charges,
                stampRate: stampRate, stamp: row._stamp_duty,
                ipftRate: ipftRate, ipft: row._ipft,
                other: row.other_charges, gst: row.gst, total: row.total_charges
            });
        }
    }

    // Step 8: Net amount (Rule G.2.8)
    if (!row._netOverride) {
        if (wmsIsBuyLikeType(txnType)) {
            row.net_amount = wmsRoundMoney(gross + row.total_charges);
        } else {
            row.net_amount = wmsRoundMoney(gross - row.total_charges);
        }
    }

    // Step 9: Trader charges — single canonical helper (Rule G.2.9 / G.2.10).
    var shouldCalcTrader = row._trdChgOverride ? false : (preserve
        ? (row.trader_charges === null || row.trader_charges === undefined)
        : true);
    if (shouldCalcTrader) {
        row.trader_charges = wmsCalcTraderCharges({
            ibaRatesMap: ibaRatesMap,
            investorId: investorId,
            brokerId: brokerId,
            traderId: row.trader_id || investorId,
            securityType: row.security_type,
            assetClass: row.asset_class,
            securityId: row.security_id,
            symbol: row.symbol,
            gross: gross,
            price: row.price,
            quantity: row.quantity,
            lots: row.lots
        });
    }

    // Step 10: Rate basis info for breakdown popover display
    row._chargesBasis = {};
    var ibaEntry = ibaRatesMap[(investorId || '') + '|' + (brokerId || '')];
    if (ibaEntry) {
        var rates = ibaEntry.rates || {};
        var segment = null;
        if (row.security_type === 'NFO') {
            if (row.asset_class === 'OPTIONS' && rates.derivatives && rates.derivatives.options) segment = rates.derivatives.options;
            else segment = rates.derivatives ? rates.derivatives.futures : null;
        } else {
            segment = rates.equity ? rates.equity.delivery : null;
        }
        if (segment) {
            if (segment.flat !== undefined) {
                var bStr = 'Flat \u20B9' + segment.flat + '/lot \u00D7 ' + Math.abs(row.lots || 1) + ' lots';
                if (segment.max > 0) bStr += ' (max \u20B9' + segment.max + ')';
                row._chargesBasis.brokerage = bStr;
            } else {
                var pctD = ((segment.pct || 0) * 100).toFixed(4) + '%';
                row._chargesBasis.brokerage = pctD + ' of gross';
                if (inclusive) row._chargesBasis.brokerage = pctD + ' of price (per-share ROUNDUP) [inclusive]';
                if (segment.max > 0) row._chargesBasis.brokerage += ' (max \u20B9' + segment.max + ')';
            }
        }
    }
    if (!inclusive) {
        var sttRoundLabel = (txnCat === 'EQUITY_DELIVERY') ? ' (rounded up)' : '';
        row._chargesBasis.stt = (sttRate > 0) ? sttRate + '% of gross' + sttRoundLabel : 'N/A';
        row._chargesBasis._exchange_charges = (exchRate > 0) ? exchRate + '% of gross' : 'N/A';
        row._chargesBasis._sebi_charges = (sebiRate > 0) ? sebiRate + '% of gross' : 'N/A';
        row._chargesBasis._stamp_duty = (stampRate > 0) ? stampRate + '% of gross' : 'N/A';
        row._chargesBasis._ipft = (ipftRate > 0) ? ipftRate + '% of gross (IPFT)' : 'N/A';
        row._chargesBasis.gst = '18% on (brokerage + exchange + SEBI)';
    } else {
        ['stt', '_exchange_charges', '_sebi_charges', '_stamp_duty', '_ipft', 'gst'].forEach(function(k) {
            row._chargesBasis[k] = 'Included in brokerage';
        });
    }
}

// ============================================================================
// OPTIONS EXPIRY DATE HELPERS
// Pure date functions for computing F&O expiry dates (Thursdays).
// ============================================================================

/**
 * Get the next Thursday on or after the given date.
 * If it's already past 3pm on a Thursday, returns the following Thursday.
 */
function wmsNextThursday(from) {
    var d = new Date(from);
    var day = d.getDay(); // 0=Sun, 4=Thu
    var diff = (4 - day + 7) % 7;
    if (diff === 0 && d.getHours() >= 15) diff = 7; // Past market close on Thu → next Thu
    d.setDate(d.getDate() + diff);
    return d;
}

/**
 * Get all Thursdays in a given month (for weekly expiry dates).
 * @param {number} year  Full year (e.g. 2026)
 * @param {number} month 0-indexed month (0=Jan, 11=Dec)
 * @returns {Date[]} Array of Date objects for each Thursday in that month
 */
function wmsGetWeeklyExpiries(year, month) {
    var thursdays = [];
    var d = new Date(year, month, 1);
    while (d.getMonth() === month) {
        if (d.getDay() === 4) thursdays.push(new Date(d));
        d.setDate(d.getDate() + 1);
    }
    return thursdays;
}

/**
 * Get the last Thursday of a month (monthly expiry date).
 * @param {number} year  Full year
 * @param {number} month 0-indexed month
 * @returns {Date}
 */
function wmsGetMonthlyExpiry(year, month) {
    var d = new Date(year, month + 1, 0); // Last day of month
    while (d.getDay() !== 4) d.setDate(d.getDate() - 1);
    return d;
}

// ============================================================================
// OPTIONS QUERY PARSING
// Parses user input like "NIFTY 25000 CE" or "RELIANCE 2800 PE MAR"
// into structured { underlying, strike, optionType, expiryHint }.
// Returns null if the query is not an options query.
// ============================================================================

function wmsParseOptionsQuery(query) {
    if (!query) return null;
    var upper = query.toUpperCase().trim();

    // Must contain CE or PE
    if (upper.indexOf('CE') < 0 && upper.indexOf('PE') < 0) return null;

    // ── Whole-word Fyers monthly format ──
    // Handles the case where a user pastes the full Fyers symbol, e.g.
    //   "360ONE26MAY1100CE", "NIFTY26FEB25000PE", "RELIANCE26JUN2500CE".
    // Pattern: UNDERLYING (letters/digits/&, non-greedy) + YY + MMM + STRIKE + (CE|PE).
    // Weekly format (YY + MM + DD) still falls through to the tokenized path.
    var _monthsAlt = WMS_MONTHS_SHORT.join('|');
    var _singleToken = upper.replace(/\s+/g, '');
    var _monthlyRe = new RegExp('^([A-Z0-9&]+?)(\\d{2})(' + _monthsAlt + ')(\\d+(?:\\.\\d+)?)(CE|PE)$');
    var _monthlyMatch = _singleToken.match(_monthlyRe);
    if (_monthlyMatch) {
        return {
            underlying: _monthlyMatch[1],
            strike: parseFloat(_monthlyMatch[4]),
            optionType: _monthlyMatch[5],
            expiryHint: _monthlyMatch[3]
        };
    }

    // ── Tokenized path (space-separated) ──
    var parts = upper.replace(/\s+/g, ' ').split(' ');
    var underlying = null;
    var strike = null;
    var optionType = null;
    var expiryHint = null;

    for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (p === 'CE' || p === 'PE') { optionType = p; continue; }
        var suffixMatch = p.match(/^(\d+(?:\.\d+)?)(CE|PE)$/);
        if (suffixMatch) { strike = parseFloat(suffixMatch[1]); optionType = suffixMatch[2]; continue; }
        if (/^\d+(?:\.\d+)?$/.test(p)) { strike = parseFloat(p); continue; }
        if (WMS_MONTHS_SHORT.indexOf(p) >= 0) { expiryHint = p; continue; }
        // Underlying may start with / contain digits (e.g. 360ONE, 5PAISA, 63MOONS, 3MINDIA).
        // Pure-digit tokens are already intercepted by the strike check above, so this
        // can't accidentally swallow the strike.
        if (!underlying && /^[A-Z0-9&]+$/.test(p)) { underlying = p; }
    }

    if (!underlying || strike === null || !optionType) return null;
    return { underlying: underlying, strike: strike, optionType: optionType, expiryHint: expiryHint };
}

// ============================================================================
// FYERS OPTION SYMBOL CANDIDATE BUILDER
// Generates Fyers-format option symbol strings across multiple expiry dates
// for validation via the Fyers quotes API.
//
// Fyers options format:
//   Monthly: NSE:NIFTY25FEB25000CE  (exchange:underlying + YY + MMM + strike + CE/PE)
//   Weekly:  NSE:NIFTY2502725000CE  (exchange:underlying + YY + MM + DD + strike + CE/PE)
//            — but monthly expiry week still uses MMM format
// ============================================================================

function wmsBuildOptionsCandidates(underlying, strike, optionType, expiryHint) {
    var now = new Date();
    var candidates = [];
    var exchange = 'NSE';
    var mcxUnderlyings = ['CRUDEOIL', 'NATURALGAS', 'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'COPPER'];
    if (mcxUnderlyings.indexOf(underlying) >= 0) exchange = 'MCX';

    // Fyers uses integer for whole numbers, decimal otherwise
    var strikeStr = strike % 1 === 0 ? String(Math.round(strike)) : String(strike);
    var isWeekly = WMS_WEEKLY_EXPIRY_UNDERLYINGS.indexOf(underlying) >= 0;

    if (expiryHint) {
        // User specified a month — generate only that month's candidates
        var monthIdx = WMS_MONTHS_SHORT.indexOf(expiryHint);
        var year = now.getFullYear();
        if (monthIdx < now.getMonth()) year++; // Past month → next year
        var yy = String(year).slice(2);

        // Monthly format
        candidates.push(exchange + ':' + underlying + yy + expiryHint + strikeStr + optionType);

        // For weekly underlyings, also generate weekly expiries within that month
        if (isWeekly) {
            var weeklyDates = wmsGetWeeklyExpiries(year, monthIdx);
            var monthlyLast = wmsGetMonthlyExpiry(year, monthIdx);
            weeklyDates.forEach(function(d) {
                // Skip the monthly expiry date (already covered by MMM format)
                if (d.getDate() === monthlyLast.getDate() && d.getMonth() === monthlyLast.getMonth()) return;
                var mm = String(d.getMonth() + 1).padStart(2, '0');
                var dd = String(d.getDate()).padStart(2, '0');
                candidates.push(exchange + ':' + underlying + yy + mm + dd + strikeStr + optionType);
            });
        }
    } else {
        // No expiry hint — generate upcoming expiries
        if (isWeekly) {
            var seenDates = {};
            for (var w = 0; w < 6; w++) {
                var targetDate = new Date(now);
                targetDate.setDate(targetDate.getDate() + (w * 7));
                var thu = wmsNextThursday(targetDate);
                var dateKey = thu.toISOString().slice(0, 10);
                if (seenDates[dateKey]) continue;
                seenDates[dateKey] = true;

                var yr = thu.getFullYear();
                var yy2 = String(yr).slice(2);
                var monthlyExp = wmsGetMonthlyExpiry(yr, thu.getMonth());
                if (thu.getDate() === monthlyExp.getDate() && thu.getMonth() === monthlyExp.getMonth()) {
                    candidates.push(exchange + ':' + underlying + yy2 + WMS_MONTHS_SHORT[thu.getMonth()] + strikeStr + optionType);
                } else {
                    var mm2 = String(thu.getMonth() + 1).padStart(2, '0');
                    var dd2 = String(thu.getDate()).padStart(2, '0');
                    candidates.push(exchange + ':' + underlying + yy2 + mm2 + dd2 + strikeStr + optionType);
                }
            }
        } else {
            // Monthly options — current month + next 2 months
            for (var m = 0; m < 3; m++) {
                var d2 = new Date(now.getFullYear(), now.getMonth() + m, 1);
                var yy3 = String(d2.getFullYear()).slice(2);
                candidates.push(exchange + ':' + underlying + yy3 + WMS_MONTHS_SHORT[d2.getMonth()] + strikeStr + optionType);
            }
        }
    }

    return candidates;
}

// ============================================================================
// FORMAT OPTIONS DISPLAY
// Convert Fyers symbol to human-readable: "NSE:NIFTY25FEB25000CE" → "NIFTY 25000 CE FEB25"
// ============================================================================

function wmsFormatOptionsDisplay(fyersSymbol, underlying, strike, optionType) {
    var afterExchange = fyersSymbol.split(':')[1] || fyersSymbol;
    var rest = afterExchange.substring(underlying.length);

    var strikeInt = String(Math.round(strike));
    var expiryPart = rest;
    var suffixInt = strikeInt + optionType;
    var suffixOrig = String(strike) + optionType;
    if (expiryPart.endsWith(suffixInt)) {
        expiryPart = expiryPart.substring(0, expiryPart.length - suffixInt.length);
    } else if (expiryPart.endsWith(suffixOrig)) {
        expiryPart = expiryPart.substring(0, expiryPart.length - suffixOrig.length);
    }

    var actualStrike = strike;
    var afterExpiry = rest.substring(expiryPart.length);
    var strikeFromSymbol = afterExpiry.replace(optionType, '');
    if (strikeFromSymbol && !isNaN(Number(strikeFromSymbol))) actualStrike = Number(strikeFromSymbol);

    var expiryLabel = expiryPart;
    if (expiryPart.length === 5) {
        // Monthly: YYMMM → e.g., "26MAR" — keep as-is
        expiryLabel = expiryPart;
    } else if (expiryPart.length === 6) {
        // Weekly: YYMMDD → convert to "DDMMMYY"
        var yyW = expiryPart.substring(0, 2);
        var mmW = parseInt(expiryPart.substring(2, 4)) - 1;
        var ddW = expiryPart.substring(4, 6);
        if (mmW >= 0 && mmW < 12) expiryLabel = ddW + WMS_MONTHS_SHORT[mmW] + yyW;
    }

    return underlying + ' ' + actualStrike + ' ' + optionType + ' ' + expiryLabel;
}

// ============================================================================
// SHARED UI COMPONENTS — Phase 3 UI Standardization
// These replace 5+ separate dropdown implementations, 3 tag input patterns,
// and inconsistent display helpers across all modules.
// ============================================================================

/**
 * HTML-escape a string for safe insertion into innerHTML.
 * @param {string} text
 * @returns {string} Escaped HTML string
 */
var _wmsEscDiv = null;
function wmsEsc(text) {
    if (!text) return '';
    if (!_wmsEscDiv) _wmsEscDiv = document.createElement('div');
    _wmsEscDiv.textContent = text;
    return _wmsEscDiv.innerHTML;
}

/**
 * Inject a PNG `pHYs` chunk (or rewrite an existing one) declaring the image's
 * physical DPI so receiving apps (Word, Pages, image viewers) resolve canvas
 * pixels → page inches correctly. Used by the statement image export so a
 * 1200 px-wide PNG renders as 8 inches when inserted at 150 DPI — fitting
 * inside an A4 portrait page (8.27"). Without metadata, apps default to
 * 96 DPI and the same 1200 px PNG would land at 12.5", overflowing A4.
 *
 * Returns a NEW Blob; the input Blob is not mutated.
 *
 * @param {Blob} blob - PNG blob (e.g. canvas.toBlob output)
 * @param {number} dpi - Target DPI (typically 150 for A4 portrait fit)
 * @returns {Promise<Blob>} new PNG blob with pHYs chunk
 */
function wmsAddPngDpi(blob, dpi) {
    return new Promise(function(resolve, reject) {
        if (!blob || blob.type !== 'image/png') { resolve(blob); return; }
        var reader = new FileReader();
        reader.onerror = function() { resolve(blob); };
        reader.onload = function() {
            try {
                var src = new Uint8Array(reader.result);
                // PNG signature is 8 bytes; first chunk after that is IHDR
                // (always 13 data bytes). Length(4) + Type(4) + Data + CRC(4).
                var sigLen = 8;
                if (src.length < sigLen + 8) { resolve(blob); return; }
                var ihdrLen = (src[sigLen] << 24) | (src[sigLen+1] << 16) | (src[sigLen+2] << 8) | src[sigLen+3];
                var ihdrEnd = sigLen + 4 + 4 + ihdrLen + 4;

                // pixels-per-meter = dpi * 39.3701 (1 inch = 0.0254 m)
                var ppm = Math.round(dpi * 39.3701);
                // pHYs chunk type + data (13 bytes): 'pHYs' + ppmX(4) + ppmY(4) + unit(1=meters)
                var td = new Uint8Array(13);
                td[0] = 0x70; td[1] = 0x48; td[2] = 0x59; td[3] = 0x73; // 'pHYs'
                td[4] = (ppm >>> 24) & 0xff; td[5] = (ppm >>> 16) & 0xff; td[6] = (ppm >>> 8) & 0xff; td[7] = ppm & 0xff;
                td[8] = (ppm >>> 24) & 0xff; td[9] = (ppm >>> 16) & 0xff; td[10] = (ppm >>> 8) & 0xff; td[11] = ppm & 0xff;
                td[12] = 1; // unit specifier = meters
                var crc = _wmsCrc32(td);

                // Strip any pre-existing pHYs chunk before injection (canvas.toBlob
                // doesn't emit one today, but be defensive against future browser changes).
                var clean = _wmsStripPngChunk(src, 'pHYs');

                var pHYs = new Uint8Array(21);
                pHYs[0] = 0; pHYs[1] = 0; pHYs[2] = 0; pHYs[3] = 9; // data length = 9
                for (var k = 0; k < 13; k++) pHYs[4 + k] = td[k];
                pHYs[17] = (crc >>> 24) & 0xff; pHYs[18] = (crc >>> 16) & 0xff;
                pHYs[19] = (crc >>> 8) & 0xff; pHYs[20] = crc & 0xff;

                // Recompute ihdrEnd relative to the (possibly shorter) clean buffer
                // — IHDR is always the first chunk so its offset is unchanged.
                var out = new Uint8Array(clean.length + 21);
                out.set(clean.subarray(0, ihdrEnd), 0);
                out.set(pHYs, ihdrEnd);
                out.set(clean.subarray(ihdrEnd), ihdrEnd + 21);
                resolve(new Blob([out], { type: 'image/png' }));
            } catch (err) {
                console.warn('wmsAddPngDpi: failed, returning original blob —', err && err.message);
                resolve(blob);
            }
        };
        reader.readAsArrayBuffer(blob);
    });
}

// CRC-32 (IEEE 802.3 polynomial 0xEDB88320) — used by PNG chunks. Small enough
// to inline; lazily-built lookup table for speed on repeated calls.
var _wmsCrc32Table = null;
function _wmsCrc32(data) {
    if (!_wmsCrc32Table) {
        _wmsCrc32Table = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            _wmsCrc32Table[n] = c >>> 0;
        }
    }
    var crc = 0xffffffff;
    for (var i = 0; i < data.length; i++) crc = (_wmsCrc32Table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
    return (crc ^ 0xffffffff) >>> 0;
}

// Walks the PNG chunk stream and returns a new buffer with chunks of `type`
// removed (rare — only matters if the source PNG already declared its DPI).
function _wmsStripPngChunk(buf, type) {
    if (buf.length < 8) return buf;
    var sigLen = 8;
    var typeBytes = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
    var pieces = [buf.subarray(0, sigLen)];
    var pos = sigLen;
    while (pos < buf.length - 8) {
        var len = (buf[pos] << 24) | (buf[pos+1] << 16) | (buf[pos+2] << 8) | buf[pos+3];
        var chunkEnd = pos + 4 + 4 + len + 4;
        var match = buf[pos+4] === typeBytes[0] && buf[pos+5] === typeBytes[1] &&
                    buf[pos+6] === typeBytes[2] && buf[pos+7] === typeBytes[3];
        if (!match) pieces.push(buf.subarray(pos, chunkEnd));
        pos = chunkEnd;
    }
    if (pos < buf.length) pieces.push(buf.subarray(pos));
    var totalLen = 0;
    for (var i = 0; i < pieces.length; i++) totalLen += pieces[i].length;
    if (totalLen === buf.length) return buf;  // nothing removed
    var out = new Uint8Array(totalLen);
    var offset = 0;
    for (var j = 0; j < pieces.length; j++) { out.set(pieces[j], offset); offset += pieces[j].length; }
    return out;
}

// ============================================================================
// wmsDropdown — Unified autocomplete/keyboard-navigable dropdown
//
// Manages keyboard navigation (ArrowUp/Down/Enter/Escape), highlighting,
// scroll-into-view, click selection, blur-to-close, and click-outside-close.
//
// Usage:
//   var dd = wmsDropdown(inputEl, ddEl, {
//       onSelect: function(itemEl) { ... },
//       itemSelector: '.wms-dd-item',      // default
//       closeOnSelect: true,               // default
//       blurDelay: 200,                    // ms before closing on blur (default)
//       escClearsInput: true,              // default
//       onClose: function() { ... }        // optional
//   });
//   // Caller populates ddEl.innerHTML with items, then calls dd.show()
//   dd.show();   dd.close();   dd.resetIdx();   dd.isOpen();
// ============================================================================

function wmsDropdown(inputEl, ddEl, opts) {
    opts = opts || {};
    var itemSelector = opts.itemSelector || '.wms-dd-item';
    var highlightClass = 'wms-dd-highlight';
    var closeOnSelect = opts.closeOnSelect !== false;
    var blurDelay = opts.blurDelay !== undefined ? opts.blurDelay : 200;
    var escClearsInput = opts.escClearsInput !== false;
    var onSelect = opts.onSelect || function() {};
    var onClose = opts.onClose || function() {};
    var highlightIdx = -1;

    function getItems() {
        return ddEl.querySelectorAll(itemSelector);
    }

    function highlightItem(items, idx) {
        for (var i = 0; i < items.length; i++) {
            if (i === idx) {
                items[i].classList.add(highlightClass);
                items[i].scrollIntoView({ block: 'nearest' });
            } else {
                items[i].classList.remove(highlightClass);
            }
        }
    }

    // Keyboard navigation on the input
    inputEl.addEventListener('keydown', function(e) {
        if (!ddEl.classList.contains('show')) return;
        var items = getItems();
        if (items.length === 0) {
            if (e.key === 'Escape') {
                e.preventDefault();
                controller.close();
                if (escClearsInput) inputEl.value = '';
                inputEl.blur();
            }
            return;
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            highlightIdx = Math.min(highlightIdx + 1, items.length - 1);
            highlightItem(items, highlightIdx);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            highlightIdx = Math.max(highlightIdx - 1, 0);
            highlightItem(items, highlightIdx);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (highlightIdx >= 0 && highlightIdx < items.length) {
                onSelect(items[highlightIdx]);
                if (closeOnSelect) controller.close();
            } else if (items.length === 1) {
                onSelect(items[0]);
                if (closeOnSelect) controller.close();
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            controller.close();
            if (escClearsInput) inputEl.value = '';
            inputEl.blur();
        }
    });

    // Blur → close after delay (so click on item fires first)
    if (blurDelay > 0) {
        inputEl.addEventListener('blur', function() {
            setTimeout(function() {
                if (ddEl.classList.contains('show')) {
                    controller.close();
                }
            }, blurDelay);
        });
    }

    // Click-outside close
    var outsideHandler = function(e) {
        if (!ddEl.classList.contains('show')) return;
        if (e.target === inputEl || inputEl.contains(e.target)) return;
        if (ddEl.contains(e.target)) return;
        controller.close();
    };
    document.addEventListener('click', outsideHandler);

    var controller = {
        show: function() {
            highlightIdx = -1;
            ddEl.classList.add('show');
        },
        close: function() {
            ddEl.classList.remove('show');
            highlightIdx = -1;
            onClose();
        },
        resetIdx: function() {
            highlightIdx = -1;
            var items = getItems();
            highlightItem(items, -1);
        },
        isOpen: function() {
            return ddEl.classList.contains('show');
        },
        getHighlightIdx: function() {
            return highlightIdx;
        },
        destroy: function() {
            document.removeEventListener('click', outsideHandler);
        }
    };

    return controller;
}

// ============================================================================
// wmsPillSearch — Self-contained pill-based filter widget
//
// Creates its own DOM (label, search input, pill dropdown, selected tags,
// "Clear all" link) inside a container element. Encapsulates ALL behavior:
//   - Multi-token search (wmsTokenize + wmsMultiTokenMatch)
//   - Keyboard navigation (ArrowDown/Up + Enter to toggle)
//   - Text clearing on select/deselect/blur/clearAll
//   - Click-outside close
//   - ESC to close + clear
//   - Selected tag chips with × remove
//
// Usage:
//   var pf = wmsPillSearch(containerEl, {
//       label: 'Investor',
//       placeholder: 'Search investors...',
//       items: [{id: 'uuid', label: 'Vikash', searchText: 'Vikash Bagla'}],
//       selectedIds: someArray,    // mutated in place
//       onChange: function() { renderTable(); }
//   });
//   pf.setItems(newItems);  pf.clearAll();  pf.getSelected();  pf.destroy();
//
// Optional opts:
//   - headerExtra: HTMLElement — extra content for header (e.g., tag logic radios)
//   - pillClass: 'wms-pill' (default)
// ============================================================================

function wmsPillSearch(containerEl, opts) {
    opts = opts || {};
    var label = opts.label || 'Filter';
    var placeholder = opts.placeholder || 'Type to search...';
    var items = opts.items || [];
    var selectedIds = opts.selectedIds || [];
    var onChange = opts.onChange || function() {};
    var pillClass = opts.pillClass || 'wms-pill';
    var headerExtra = opts.headerExtra || null;
    var highlightIdx = -1;

    // Build searchText for each item
    function buildSearchText() {
        items.forEach(function(item) {
            var parts = [item.label || ''];
            if (item.searchText) parts.push(item.searchText);
            item._searchText = parts.join(' ').toLowerCase();
        });
    }
    buildSearchText();

    // ── Destroy previous instance if any (prevents event listener leaks) ──
    if (containerEl._wmsPillSearch && typeof containerEl._wmsPillSearch.destroy === 'function') {
        containerEl._wmsPillSearch.destroy();
    }

    // ── Build DOM ──
    containerEl.innerHTML = '';
    containerEl.className = (containerEl.className || '').replace(/\bfilter-group\b/g, '').trim();
    containerEl.classList.add('filter-group');

    // Header row: label + clear link (and optional extra content)
    var headerDiv = document.createElement('div');
    headerDiv.className = 'filter-header';
    var labelEl = document.createElement('label');
    labelEl.textContent = label;
    headerDiv.appendChild(labelEl);

    if (headerExtra) {
        // Wrap extra + clear in a flex row
        var rightDiv = document.createElement('div');
        rightDiv.style.cssText = 'display:flex; align-items:center; gap:12px;';
        rightDiv.appendChild(headerExtra);
        var clearEl = document.createElement('span');
        clearEl.className = 'clear-link';
        clearEl.textContent = 'Clear all';
        rightDiv.appendChild(clearEl);
        headerDiv.appendChild(rightDiv);
    } else {
        var clearEl = document.createElement('span');
        clearEl.className = 'clear-link';
        clearEl.textContent = 'Clear all';
        headerDiv.appendChild(clearEl);
    }
    containerEl.appendChild(headerDiv);

    // Search container
    var searchContainer = document.createElement('div');
    searchContainer.className = 'filter-search-container';
    var inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'filter-search-input';
    inputEl.placeholder = placeholder;
    var ddEl = document.createElement('div');
    ddEl.className = 'wms-pill-dropdown';
    searchContainer.appendChild(inputEl);
    searchContainer.appendChild(ddEl);
    containerEl.appendChild(searchContainer);

    // Selected tags
    var tagsEl = document.createElement('div');
    tagsEl.className = 'filter-selected-tags';
    containerEl.appendChild(tagsEl);

    // ── Pill rendering ──
    function render() {
        ddEl.innerHTML = items.map(function(item) {
            var isOn = selectedIds.indexOf(item.id) >= 0;
            return '<span class="' + pillClass + (isOn ? ' on' : '') + '" data-wms-id="' + wmsEsc(String(item.id)) + '">' +
                wmsEsc(item.label) + '</span>';
        }).join('');
        attachPillClicks();
    }

    function resetSearch() {
        inputEl.value = '';
        highlightIdx = -1;
        ddEl.querySelectorAll('.' + pillClass).forEach(function(pill) {
            pill.style.display = '';
            pill.classList.remove('wms-pill-highlight');
        });
    }

    function togglePill(pill) {
        var id = pill.getAttribute('data-wms-id');
        var idx = selectedIds.indexOf(id);
        if (idx >= 0) selectedIds.splice(idx, 1);
        else selectedIds.push(id);
        syncStates();
        renderSelectedTags();
        // Multi-select: keep dropdown open and preserve search text so user can select
        // multiple items without reopening. Dropdown closes via outside-click / blur / ESC.
        onChange();
    }

    function getVisiblePills() {
        var all = ddEl.querySelectorAll('.' + pillClass);
        var visible = [];
        all.forEach(function(pill) {
            if (pill.style.display !== 'none') visible.push(pill);
        });
        return visible;
    }

    function highlightPillAt(newIdx) {
        var visible = getVisiblePills();
        highlightIdx = newIdx;
        visible.forEach(function(pill, i) {
            pill.classList.toggle('wms-pill-highlight', i === highlightIdx);
        });
        if (highlightIdx >= 0 && highlightIdx < visible.length) {
            visible[highlightIdx].scrollIntoView({ block: 'nearest' });
        }
    }

    function attachPillClicks() {
        ddEl.querySelectorAll('.' + pillClass).forEach(function(pill) {
            pill.addEventListener('mousedown', function(e) {
                e.preventDefault(); // Prevent blur from firing before click completes
                e.stopPropagation();
                togglePill(pill);
            });
        });
    }

    function renderSelectedTags() {
        tagsEl.innerHTML = selectedIds.map(function(id) {
            var item = items.find(function(it) { return String(it.id) === String(id); });
            var lbl = item ? item.label : id;
            return '<span class="filter-tag-item">' + wmsEsc(lbl) +
                '<span class="filter-tag-remove" data-wms-id="' + wmsEsc(String(id)) + '">&times;</span></span>';
        }).join('');
        tagsEl.querySelectorAll('.filter-tag-remove').forEach(function(x) {
            x.addEventListener('click', function() {
                var id = x.getAttribute('data-wms-id');
                var idx = selectedIds.indexOf(id);
                if (idx >= 0) selectedIds.splice(idx, 1);
                syncStates();
                renderSelectedTags();
                // Preserve search text so multi-select flow isn't disrupted when removing a tag.
                onChange();
            });
        });
    }

    function syncStates() {
        ddEl.querySelectorAll('.' + pillClass).forEach(function(pill) {
            var id = pill.getAttribute('data-wms-id');
            pill.classList.toggle('on', selectedIds.indexOf(id) >= 0);
        });
    }

    // ── Search input ──
    inputEl.addEventListener('click', function() { ddEl.classList.add('show'); });
    inputEl.addEventListener('input', function() {
        ddEl.classList.add('show');
        highlightIdx = -1;
        var tokens = wmsTokenize(inputEl.value);
        var pills = ddEl.querySelectorAll('.' + pillClass);
        pills.forEach(function(pill, idx) {
            pill.classList.remove('wms-pill-highlight');
            if (tokens.length === 0) { pill.style.display = ''; return; }
            var item = items[idx];
            var st = item ? item._searchText : pill.textContent.toLowerCase();
            pill.style.display = wmsMultiTokenMatch(tokens, st) ? '' : 'none';
        });
    });

    // Keyboard: ESC, ArrowDown/Up, Enter
    inputEl.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            resetSearch();
            ddEl.classList.remove('show');
            inputEl.blur();
            return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
            // Open dropdown if not open
            if (!ddEl.classList.contains('show')) {
                ddEl.classList.add('show');
                if (e.key !== 'Enter') { e.preventDefault(); return; }
            }
        }
        if (!ddEl.classList.contains('show')) return;
        var visible = getVisiblePills();
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!visible.length) return;
            highlightPillAt(Math.min(highlightIdx + 1, visible.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (!visible.length) return;
            highlightPillAt(Math.max(highlightIdx - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            if (highlightIdx >= 0 && highlightIdx < visible.length) {
                togglePill(visible[highlightIdx]);
            } else if (visible.length === 1) {
                togglePill(visible[0]);
            }
        }
    });

    // Blur — clear search text and close
    inputEl.addEventListener('blur', function() {
        setTimeout(function() {
            resetSearch();
            ddEl.classList.remove('show');
        }, 150);
    });

    // Click-outside close
    var outsideHandler = function(e) {
        if (!containerEl.contains(e.target)) {
            resetSearch();
            ddEl.classList.remove('show');
        }
    };
    document.addEventListener('click', outsideHandler);

    // Clear all button
    clearEl.addEventListener('click', function() {
        selectedIds.length = 0;
        syncStates();
        renderSelectedTags();
        resetSearch();
        onChange();
    });

    // ── Initial render ──
    render();
    renderSelectedTags();

    // ── Controller ──
    var controller = {
        getSelected: function() { return selectedIds.slice(); },
        setItems: function(newItems) {
            items = newItems;
            buildSearchText();
            render();
            renderSelectedTags();
        },
        clearAll: function() {
            selectedIds.length = 0;
            syncStates();
            renderSelectedTags();
            resetSearch();
            onChange();
        },
        syncStates: syncStates,
        renderSelectedTags: renderSelectedTags,
        getInputEl: function() { return inputEl; },
        destroy: function() {
            document.removeEventListener('click', outsideHandler);
            containerEl.innerHTML = '';
            containerEl._wmsPillSearch = null;
        }
    };
    containerEl._wmsPillSearch = controller;
    return controller;
}

// ============================================================================
// wmsPillFilter — LEGACY wrapper (same as wmsPillSearch but takes pre-built DOM)
//
// Kept for backward compatibility. New code should use wmsPillSearch instead.
// ============================================================================

function wmsPillFilter(inputEl, ddEl, tagsEl, opts) {
    opts = opts || {};
    var items = opts.items || [];
    var selectedIds = opts.selectedIds || [];
    var onChange = opts.onChange || function() {};
    var pillClass = opts.pillClass || 'wms-pill';

    // Build searchText for each item: label + any extra searchable fields
    items.forEach(function(item) {
        if (!item._searchText) {
            var parts = [item.label || ''];
            if (item.searchText) parts.push(item.searchText);
            item._searchText = parts.join(' ').toLowerCase();
        }
    });

    function render() {
        ddEl.innerHTML = items.map(function(item) {
            var isOn = selectedIds.indexOf(item.id) >= 0;
            return '<span class="' + pillClass + (isOn ? ' on' : '') + '" data-wms-id="' + wmsEsc(String(item.id)) + '">' +
                wmsEsc(item.label) + '</span>';
        }).join('');
        attachPillClicks();
    }

    var highlightIdx = -1;

    function resetSearch() {
        inputEl.value = '';
        highlightIdx = -1;
        ddEl.querySelectorAll('.' + pillClass).forEach(function(pill) {
            pill.style.display = '';
            pill.classList.remove('wms-pill-highlight');
        });
    }

    function togglePill(pill) {
        var id = pill.getAttribute('data-wms-id');
        var idx = selectedIds.indexOf(id);
        if (idx >= 0) selectedIds.splice(idx, 1);
        else selectedIds.push(id);
        syncStates();
        renderSelectedTags();
        // Multi-select: keep dropdown open and preserve search text so user can select
        // multiple items without reopening. Dropdown closes via outside-click / blur / ESC.
        onChange();
    }

    function getVisiblePills() {
        var all = ddEl.querySelectorAll('.' + pillClass);
        var visible = [];
        all.forEach(function(pill) {
            if (pill.style.display !== 'none') visible.push(pill);
        });
        return visible;
    }

    function highlightPillAt(newIdx) {
        var visible = getVisiblePills();
        highlightIdx = newIdx;
        visible.forEach(function(pill, i) {
            pill.classList.toggle('wms-pill-highlight', i === highlightIdx);
        });
        if (highlightIdx >= 0 && highlightIdx < visible.length) {
            visible[highlightIdx].scrollIntoView({ block: 'nearest' });
        }
    }

    function attachPillClicks() {
        ddEl.querySelectorAll('.' + pillClass).forEach(function(pill) {
            pill.addEventListener('mousedown', function(e) {
                e.preventDefault();
                e.stopPropagation();
                togglePill(pill);
            });
        });
    }

    function renderSelectedTags() {
        if (!tagsEl) return;
        tagsEl.innerHTML = selectedIds.map(function(id) {
            var item = items.find(function(it) { return String(it.id) === String(id); });
            var label = item ? item.label : id;
            return '<span class="filter-tag-item">' + wmsEsc(label) +
                '<span class="filter-tag-remove" data-wms-id="' + wmsEsc(String(id)) + '">&times;</span></span>';
        }).join('');
        tagsEl.querySelectorAll('.filter-tag-remove').forEach(function(x) {
            x.addEventListener('click', function() {
                var id = x.getAttribute('data-wms-id');
                var idx = selectedIds.indexOf(id);
                if (idx >= 0) selectedIds.splice(idx, 1);
                syncStates();
                renderSelectedTags();
                // Preserve search text so multi-select flow isn't disrupted when removing a tag.
                onChange();
            });
        });
    }

    function syncStates() {
        ddEl.querySelectorAll('.' + pillClass).forEach(function(pill) {
            var id = pill.getAttribute('data-wms-id');
            pill.classList.toggle('on', selectedIds.indexOf(id) >= 0);
        });
    }

    // Search input — show dropdown, filter pills by text
    inputEl.addEventListener('click', function() { ddEl.classList.add('show'); });
    inputEl.addEventListener('input', function() {
        ddEl.classList.add('show');
        highlightIdx = -1;
        var tokens = wmsTokenize(inputEl.value);
        var pills = ddEl.querySelectorAll('.' + pillClass);
        pills.forEach(function(pill, idx) {
            pill.classList.remove('wms-pill-highlight');
            if (tokens.length === 0) { pill.style.display = ''; return; }
            var item = items[idx];
            var searchText = item ? item._searchText : pill.textContent.toLowerCase();
            pill.style.display = wmsMultiTokenMatch(tokens, searchText) ? '' : 'none';
        });
    });

    // Keyboard: ESC closes, Arrow keys navigate visible pills, Enter toggles
    inputEl.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            resetSearch();
            ddEl.classList.remove('show');
            inputEl.blur();
            return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
            if (!ddEl.classList.contains('show')) {
                ddEl.classList.add('show');
                if (e.key !== 'Enter') { e.preventDefault(); return; }
            }
        }
        if (!ddEl.classList.contains('show')) return;
        var visible = getVisiblePills();
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!visible.length) return;
            highlightPillAt(Math.min(highlightIdx + 1, visible.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (!visible.length) return;
            highlightPillAt(Math.max(highlightIdx - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            if (highlightIdx >= 0 && highlightIdx < visible.length) {
                togglePill(visible[highlightIdx]);
            } else if (visible.length === 1) {
                togglePill(visible[0]);
            }
        }
    });

    // Blur — clear search text and reset pill visibility
    inputEl.addEventListener('blur', function() {
        setTimeout(function() {
            resetSearch();
            ddEl.classList.remove('show');
        }, 150);
    });

    // Click-outside close
    var outsideHandler = function(e) {
        if (!e.target.closest('.filter-search-container') ||
            (!inputEl.contains(e.target) && !ddEl.contains(e.target) && !(tagsEl && tagsEl.contains(e.target)))) {
            resetSearch();
            ddEl.classList.remove('show');
        }
    };
    document.addEventListener('click', outsideHandler);

    // Initial render
    render();
    renderSelectedTags();

    return {
        setItems: function(newItems) {
            items = newItems;
            render();
            renderSelectedTags();
        },
        syncStates: syncStates,
        renderSelectedTags: renderSelectedTags,
        clearAll: function() {
            selectedIds.length = 0;
            syncStates();
            renderSelectedTags();
            resetSearch();
            onChange();
        },
        destroy: function() {
            document.removeEventListener('click', outsideHandler);
        }
    };
}

// ============================================================================
// wmsTagInput — Unified tag entry component with autocomplete
//
// Handles: comma/semicolon to add, autocomplete dropdown of existing tags,
// pill rendering with × remove, Enter to add highlighted or typed tag.
// Uses wmsDropdown internally for keyboard navigation.
//
// Usage:
//   var ti = wmsTagInput(inputEl, pillsEl, ddEl, {
//       tags: row.tags,           // array (mutated in place)
//       existingTags: wmsRefData.tags,
//       onChange: function() { ... }
//   });
//   ti.refresh();  ti.getTags();  ti.setExistingTags(arr);
// ============================================================================

function wmsTagInput(inputEl, pillsEl, ddEl, opts) {
    opts = opts || {};
    var tags = opts.tags || [];
    var existingTags = opts.existingTags || [];
    var onChange = opts.onChange || function() {};

    function addTag(tagText) {
        var trimmed = tagText.trim();
        if (!trimmed) return false;
        if (tags.indexOf(trimmed) >= 0) return false;
        tags.push(trimmed);
        // Add to existingTags if new
        if (existingTags.indexOf(trimmed) === -1 && existingTags.indexOf(trimmed.toLowerCase()) === -1) {
            existingTags.push(trimmed);
            existingTags.sort();
        }
        return true;
    }

    function removeTag(tag) {
        var idx = tags.indexOf(tag);
        if (idx >= 0) tags.splice(idx, 1);
        renderPills();
        onChange();
    }

    function renderPills() {
        pillsEl.innerHTML = '';
        tags.forEach(function(tag) {
            var pill = document.createElement('span');
            pill.className = 'wms-pill on';
            pill.textContent = tag;
            var x = document.createElement('span');
            x.className = 'wms-pill-remove';
            x.textContent = '\u00d7';
            x.addEventListener('click', function(e) {
                e.stopPropagation();
                removeTag(tag);
            });
            pill.appendChild(x);
            pillsEl.appendChild(pill);
        });
    }

    function showDd(filter) {
        var filterLower = (filter || '').toLowerCase();
        var matches = existingTags.filter(function(tag) {
            return tags.indexOf(tag) === -1 &&
                tag.toLowerCase().indexOf(filterLower) !== -1;
        });
        if (matches.length === 0) {
            ddEl.classList.remove('show');
            return;
        }
        ddEl.innerHTML = matches.map(function(tag) {
            return '<div class="wms-dd-item">' + wmsEsc(tag) + '</div>';
        }).join('');

        // Attach mousedown (not click) to fire before blur
        ddEl.querySelectorAll('.wms-dd-item').forEach(function(el) {
            el.addEventListener('mousedown', function(e) {
                e.preventDefault();
                addTag(el.textContent);
                inputEl.value = '';
                ddEl.classList.remove('show');
                renderPills();
                onChange();
            });
        });

        ddCtrl.show();
    }

    // Set up dropdown keyboard nav
    var ddCtrl = wmsDropdown(inputEl, ddEl, {
        onSelect: function(itemEl) {
            addTag(itemEl.textContent);
            inputEl.value = '';
            ddEl.classList.remove('show');
            renderPills();
            onChange();
        },
        closeOnSelect: true,
        escClearsInput: true,
        blurDelay: 150
    });

    // Input handler — auto-add on comma/semicolon, otherwise show autocomplete
    inputEl.addEventListener('input', function() {
        var val = inputEl.value;
        if (val.indexOf(',') !== -1 || val.indexOf(';') !== -1) {
            var parts = val.split(/[,;]/).map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; });
            var added = false;
            parts.forEach(function(t) {
                if (addTag(t)) added = true;
            });
            inputEl.value = '';
            ddEl.classList.remove('show');
            if (added) { renderPills(); onChange(); }
            return;
        }
        if (val.trim().length > 0) {
            showDd(val);
        } else {
            ddEl.classList.remove('show');
        }
    });

    inputEl.addEventListener('focus', function() {
        if (inputEl.value.trim().length > 0) showDd(inputEl.value);
    });

    // Override Enter to also add typed text if no dropdown highlight
    var origKeydown = inputEl.onkeydown;
    inputEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !ddEl.classList.contains('show')) {
            e.preventDefault();
            var val = inputEl.value.trim();
            if (val && addTag(val)) {
                inputEl.value = '';
                renderPills();
                onChange();
            }
        }
    });

    renderPills();

    return {
        refresh: renderPills,
        getTags: function() { return tags; },
        setExistingTags: function(arr) { existingTags = arr; },
        destroy: function() { ddCtrl.destroy(); }
    };
}

// ============================================================================
// wmsFormatSecurity — Standardized company name/symbol display
//
// Canonical rule: use short_symbol when available, company_name as secondary.
// Formats: 'symbol-only', 'symbol-name', 'name-only', 'full'
//
// Usage:
//   wmsFormatSecurity({symbol: 'RELIANCE', short_symbol: 'RELIANCE',
//       company_name: 'Reliance Industries Ltd', exchange: 'NSE'}, 'symbol-name')
//   → 'RELIANCE — Reliance Industries Ltd'
// ============================================================================

function wmsFormatSecurity(sec, format) {
    if (!sec) return '';
    var sym = sec.short_symbol || sec.nse_symbol || sec.bse_symbol || sec.symbol || '';
    var name = sec.company_name || sec.instrument_name || '';
    var exchange = sec.exchange || '';

    switch (format || 'symbol-name') {
        case 'symbol-only':
            return sym;
        case 'name-only':
            return name || sym;
        case 'full':
            var parts = [];
            if (exchange) parts.push(exchange + ':');
            parts.push(sym);
            if (name) parts.push(' \u2014 ' + name);
            return parts.join('');
        case 'symbol-name':
        default:
            if (name && name !== sym) return sym + ' \u2014 ' + name;
            return sym;
    }
}

// ============================================================================
// wmsModal — Unified modal open/close with ESC + click-outside
//
// Usage:
//   var modal = wmsModal(overlayEl, {
//       onClose: function() { ... }  // optional callback
//   });
//   modal.open();  modal.close();  modal.isOpen();
// ============================================================================

// Shared stack of currently-open modal overlays, in open order. Lets ESC and
// backdrop-click act on the TOPMOST modal only — so a modal opened on top of
// another (e.g. the voucher modal over the ledger-detail modal) steps back ONE
// layer instead of closing every open modal down to the main screen.
var wmsModalStack = (typeof window !== 'undefined' && window.__wmsModalStack) || [];
if (typeof window !== 'undefined') window.__wmsModalStack = wmsModalStack;

function wmsModalIsTop(overlayEl) {
    return wmsModalStack.length && wmsModalStack[wmsModalStack.length - 1] === overlayEl;
}

function wmsModal(overlayEl, opts) {
    opts = opts || {};
    var onClose = opts.onClose || function() {};
    // backdropClose:false → clicking the dark overlay does nothing (the accounting
    // module opts out so a stray click can't discard a half-typed voucher). ESC and
    // the ✕/Cancel buttons still close.
    var backdropClose = opts.backdropClose !== false;

    function escHandler(e) {
        // Only the top-most open modal responds to ESC.
        if (e.key === 'Escape' && overlayEl.classList.contains('show') && wmsModalIsTop(overlayEl)) {
            e.preventDefault();
            e.stopPropagation();
            controller.close();
        }
    }

    function clickOutsideHandler(e) {
        // Click on overlay background (not on dialog content), top-most only.
        if (backdropClose && e.target === overlayEl && wmsModalIsTop(overlayEl)) {
            controller.close();
        }
    }

    var controller = {
        open: function() {
            overlayEl.classList.add('show');
            // De-dupe then push so this overlay is unambiguously the top.
            var ix = wmsModalStack.indexOf(overlayEl);
            if (ix !== -1) wmsModalStack.splice(ix, 1);
            wmsModalStack.push(overlayEl);
            // Raise this overlay above any modal already open. Base overlay z-index
            // is 1100; DOM order alone would otherwise let an earlier-in-DOM modal
            // sit behind a later one. Stack depth drives the paint order instead.
            overlayEl.style.zIndex = String(1100 + wmsModalStack.length * 10);
            document.addEventListener('keydown', escHandler);
            overlayEl.addEventListener('click', clickOutsideHandler);
        },
        close: function() {
            overlayEl.classList.remove('show');
            overlayEl.style.zIndex = '';
            var ix = wmsModalStack.indexOf(overlayEl);
            if (ix !== -1) wmsModalStack.splice(ix, 1);
            document.removeEventListener('keydown', escHandler);
            overlayEl.removeEventListener('click', clickOutsideHandler);
            onClose();
        },
        isOpen: function() {
            return overlayEl.classList.contains('show');
        }
    };

    return controller;
}

// ═══════════════════════════════════════════════════════════════
// Contract Display — shared across trading.js + trading-transactions.js
// ═══════════════════════════════════════════════════════════════

/**
 * Format a transaction's contract for display in matching trade views.
 * Equity → "Equity". NFO → "DD Mon YY [Strike] Type" from securities_nfo lookup,
 * fallback to symbol parsing if NFO record unavailable (expired contracts).
 *
 * @param {Object} txn — transaction record with symbol, short_symbol, security_type, security_id
 * @returns {string} formatted contract label
 */
function wmsFormatContract(txn) {
    if (!txn) return '';
    // Only F&O instruments get a contract/expiry label; everything else is "Equity".
    // MCX commodity futures/options are F&O too (2026-07-23) — without this they were
    // labelled "Equity" and dropped from the F&O page (its views hide the "Equity" bucket).
    if (txn.security_type !== 'NFO' && txn.security_type !== 'MCX') return 'Equity';
    if (txn.symbol === txn.short_symbol) return 'Equity';

    // Try NFO lookup by security_id for structured data
    if (txn.security_id && wmsRefData.securitiesNfoMap) {
        var nfo = wmsRefData.securitiesNfoMap[txn.security_id];
        if (nfo && nfo.expiry_date) {
            var d = new Date(nfo.expiry_date + 'T00:00:00');
            var parts = [];
            parts.push(d.getDate());
            parts.push(WMS_MONTHS_SHORT_FULL[d.getMonth()]);
            parts.push(String(d.getFullYear()).slice(-2));
            if (nfo.strike_price) parts.push(Math.round(nfo.strike_price));
            parts.push(nfo.option_type ? nfo.option_type.toUpperCase() : 'Fut');
            return parts.join(' ');
        }
    }

    // Fallback: parse from symbol string. Strip an optional exchange prefix first
    // (e.g. "MCX:" / "NSE:") so the short-symbol offset + expiry regex line up for
    // both NSE F&O and MCX commodity symbols.
    var suffix = (txn.symbol || '').replace(/^[A-Z]+:/, '');
    var short = (txn.short_symbol || '').toUpperCase();
    if (short && suffix.toUpperCase().indexOf(short) === 0) {
        suffix = suffix.substring(short.length);
    }
    if (!suffix) return 'NFO';

    // Pattern: YY + MON + (optional strike) + FUT/CE/PE
    var m = suffix.match(/^(\d{2})([A-Z]{3})(\d+)?(FUT|CE|PE)$/i);
    if (m) {
        var monIdx = WMS_MONTHS_SHORT.indexOf(m[2].toUpperCase());
        var monLabel = monIdx >= 0 ? WMS_MONTHS_SHORT_FULL[monIdx] : m[2];
        var parts = [monLabel, m[1]];
        if (m[3]) parts.push(m[3]);
        parts.push(m[4].toUpperCase() === 'FUT' ? 'Fut' : m[4].toUpperCase());
        return parts.join(' ');
    }

    // Last resort: just clean up the suffix
    return suffix.replace(/(FUT|CE|PE)$/i, ' $1').trim();
}

// ═══════════════════════════════════════════════════════════════
// Symbol Search Sort — shared across add-transaction + watchlist
// ═══════════════════════════════════════════════════════════════

/**
 * Sort combined CM + NFO search results:
 *   1. CM/Equity securities first (sorted alphabetically by symbol)
 *   2. NFO securities sorted by expiry_date ascending (nearest first)
 *   3. Expired NFO contracts at the bottom
 *
 * Each item must have:
 *   _isNfo (boolean) — true for NFO, false for CM
 *   _expiryDate or _displayExpiry (string, YYYY-MM-DD) — for NFO sort
 *
 * @param {Array} items - combined search results
 * @returns {Array} sorted copy (does not mutate original)
 */
function wmsSortSearchResults(items) {
    var today = new Date().toISOString().slice(0, 10);
    return items.slice().sort(function(a, b) {
        // 1. CM before NFO (supports both _isNfo flag and security_source field)
        var aIsNfo = (a._isNfo || a.security_source === 'securities_nfo') ? 1 : 0;
        var bIsNfo = (b._isNfo || b.security_source === 'securities_nfo') ? 1 : 0;
        if (aIsNfo !== bIsNfo) return aIsNfo - bIsNfo;

        // 2. Within CM: alphabetical by symbol
        if (aIsNfo === 0 && bIsNfo === 0) {
            var aSym = (a._displaySym || a.short_symbol || a.symbol || '').toUpperCase();
            var bSym = (b._displaySym || b.short_symbol || b.symbol || '').toUpperCase();
            return aSym < bSym ? -1 : (aSym > bSym ? 1 : 0);
        }

        // 3. Within NFO: active before expired, then by expiry ascending
        var aExp = a._expiryDate || a._displayExpiry || '';
        var bExp = b._expiryDate || b._displayExpiry || '';
        var aExpired = aExp && aExp < today ? 1 : 0;
        var bExpired = bExp && bExp < today ? 1 : 0;
        if (aExpired !== bExpired) return aExpired - bExpired;

        // Both active or both expired: sort by expiry ascending
        if (aExp !== bExp) return aExp < bExp ? -1 : (aExp > bExp ? 1 : 0);

        // Same expiry: alphabetical by symbol
        var aSym2 = (a._displaySym || a.short_symbol || a.symbol || '').toUpperCase();
        var bSym2 = (b._displaySym || b.short_symbol || b.symbol || '').toUpperCase();
        return aSym2 < bSym2 ? -1 : (aSym2 > bSym2 ? 1 : 0);
    });
}

/* ============================================================================
   SHARED DATE COMPONENTS
   ============================================================================ */

var WMS_MONTHS_SHORT_FULL = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * wmsGetFYRange(fyStartMonth, offsetYears)
 * Helper function to calculate fiscal year date range.
 * @param {number} fyStartMonth - Month (1-12) when fiscal year starts. Default 4 (April).
 * @param {number} offsetYears - 0 = current FY, -1 = last FY, etc.
 * @returns {Object} {from: 'YYYY-MM-DD', to: 'YYYY-MM-DD'}
 */
var wmsGetFYRange = function(fyStartMonth, offsetYears) {
    fyStartMonth = fyStartMonth || 4;
    offsetYears = (offsetYears !== undefined) ? offsetYears : 0;

    var now = new Date();
    var currentMonth = now.getMonth() + 1; // 1-12
    var currentYear = now.getFullYear();

    // Determine which fiscal year we're in
    var fy;
    if (currentMonth >= fyStartMonth) {
        fy = currentYear + offsetYears;
    } else {
        fy = currentYear - 1 + offsetYears;
    }

    // Build start and end dates
    var startStr = fy + '-' + String(fyStartMonth).padStart(2, '0') + '-01';
    var endMonth = fyStartMonth - 1;
    var endYear = fy + 1;
    if (endMonth < 1) {
        endMonth = 12;
        endYear = fy;
    }
    // Last day of endMonth: create date for 1st of next month, subtract 1 day
    var lastDay = new Date(endYear, endMonth, 0).getDate();
    var endStr = endYear + '-' + String(endMonth).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0');

    return { from: startStr, to: endStr };
};

/* ────────────────────────────────────────────────────────────────────────────
 * wmsDateInput(containerEl, opts)
 * Reusable segmented date widget (dd-mmm-yyyy) with optional calendar icon.
 *
 * @param {HTMLElement} containerEl — will be emptied and filled
 * @param {Object} opts
 *   - onChange: function(ymdStr)  — called when date changes (YYYY-MM-DD)
 *   - compact: boolean            — smaller font/padding for toolbar use
 * @returns {Object} controller: getValue(), setValue(Date|string), destroy()
 * ──────────────────────────────────────────────────────────────────────────── */
var wmsDateInput = function(containerEl, opts) {
    opts = opts || {};
    var onChangeCallback = opts.onChange || function() {};
    var compact = !!opts.compact;

    var state = { day: 1, month: 0, year: 2026 }; // month 0-indexed
    var activeSeg = null;
    var typeBuf = '';
    var typeTimer = null;

    // ── helpers ──
    var daysInMonth = function(m, y) { return new Date(y, m + 1, 0).getDate(); };
    var toYMD = function() {
        return state.year + '-' + String(state.month + 1).padStart(2, '0') + '-' + String(state.day).padStart(2, '0');
    };
    var render = function() {
        ddEl.textContent = String(state.day).padStart(2, '0');
        mmmEl.textContent = WMS_MONTHS_SHORT_FULL[state.month];
        yyyyEl.textContent = String(state.year);
        onChangeCallback(toYMD());
    };

    // ── Build DOM ──
    containerEl.innerHTML = '';

    var wrap = document.createElement('div');
    wrap.className = 'wms-di-wrap' + (compact ? ' wms-di-compact' : '');
    wrap.tabIndex = 0;

    var ddEl = document.createElement('span');
    ddEl.className = 'wms-di-seg';
    ddEl.dataset.seg = 'dd';
    var sep1 = document.createElement('span');
    sep1.className = 'wms-di-sep';
    sep1.textContent = '-';
    var mmmEl = document.createElement('span');
    mmmEl.className = 'wms-di-seg';
    mmmEl.dataset.seg = 'mmm';
    var sep2 = document.createElement('span');
    sep2.className = 'wms-di-sep';
    sep2.textContent = '-';
    var yyyyEl = document.createElement('span');
    yyyyEl.className = 'wms-di-seg';
    yyyyEl.dataset.seg = 'yyyy';

    // Calendar button + hidden native input — inside the wrap
    var calBtn = document.createElement('button');
    calBtn.type = 'button';
    calBtn.className = 'wms-di-cal-btn';
    calBtn.tabIndex = -1; // exclude from tab order — click-only
    calBtn.title = 'Pick from calendar';
    calBtn.textContent = '\uD83D\uDCC5'; // 📅
    var calInput = document.createElement('input');
    calInput.type = 'date';
    calInput.className = 'wms-di-cal-hidden';
    calInput.tabIndex = -1; // exclude from tab order

    wrap.appendChild(ddEl);
    wrap.appendChild(sep1);
    wrap.appendChild(mmmEl);
    wrap.appendChild(sep2);
    wrap.appendChild(yyyyEl);
    wrap.appendChild(calBtn);
    wrap.appendChild(calInput);

    containerEl.appendChild(wrap);

    // ── Segment activation ──
    var setActive = function(seg) {
        activeSeg = seg;
        typeBuf = '';
        wrap.querySelectorAll('.wms-di-seg').forEach(function(el) {
            el.classList.toggle('active', el.dataset.seg === seg);
        });
    };
    var clearActive = function() {
        activeSeg = null;
        typeBuf = '';
        wrap.querySelectorAll('.wms-di-seg').forEach(function(el) { el.classList.remove('active'); });
    };
    var moveSeg = function(dir) {
        var order = ['dd', 'mmm', 'yyyy'];
        var idx = order.indexOf(activeSeg);
        var next = idx + dir;
        if (next >= 0 && next < order.length) setActive(order[next]);
    };
    var adjust = function(delta) {
        if (activeSeg === 'dd') {
            state.day += delta;
            var mx = daysInMonth(state.month, state.year);
            if (state.day > mx) state.day = 1;
            if (state.day < 1) state.day = mx;
        } else if (activeSeg === 'mmm') {
            state.month += delta;
            if (state.month > 11) state.month = 0;
            if (state.month < 0) state.month = 11;
            var mx2 = daysInMonth(state.month, state.year);
            if (state.day > mx2) state.day = mx2;
        } else if (activeSeg === 'yyyy') {
            state.year += delta;
            if (state.year < 2000) state.year = 2000;
            if (state.year > 2099) state.year = 2099;
            var mx3 = daysInMonth(state.month, state.year);
            if (state.day > mx3) state.day = mx3;
        }
        render();
    };

    // ── Typed input ──
    var typeDigit = function(digit) {
        clearTimeout(typeTimer);
        if (activeSeg === 'dd') {
            typeBuf += digit;
            if (typeBuf.length >= 2) {
                var val = parseInt(typeBuf);
                var maxD = daysInMonth(state.month, state.year);
                if (val >= 1 && val <= maxD) state.day = val;
                typeBuf = '';
                render();
                moveSeg(1);
            } else {
                var first = parseInt(typeBuf);
                if (first > 3) {
                    if (first >= 1) state.day = first;
                    typeBuf = '';
                    render();
                    moveSeg(1);
                } else {
                    render();
                    typeTimer = setTimeout(function() {
                        if (typeBuf.length === 1) {
                            var v = parseInt(typeBuf);
                            if (v >= 1) state.day = v;
                            typeBuf = '';
                            render();
                            moveSeg(1);
                        }
                    }, 600);
                }
            }
        } else if (activeSeg === 'mmm') {
            typeBuf += digit;
            if (typeBuf.length >= 2) {
                var mVal = parseInt(typeBuf);
                if (mVal >= 1 && mVal <= 12) state.month = mVal - 1;
                typeBuf = '';
                render();
                moveSeg(1);
            } else {
                var mFirst = parseInt(typeBuf);
                if (mFirst > 1) {
                    if (mFirst >= 1 && mFirst <= 9) state.month = mFirst - 1;
                    typeBuf = '';
                    render();
                    moveSeg(1);
                } else {
                    typeTimer = setTimeout(function() {
                        if (typeBuf.length === 1) {
                            var v2 = parseInt(typeBuf);
                            if (v2 >= 1) state.month = v2 - 1;
                            typeBuf = '';
                            render();
                            moveSeg(1);
                        }
                    }, 600);
                }
            }
        } else if (activeSeg === 'yyyy') {
            typeBuf += digit;
            if (typeBuf.length >= 4) {
                var yr = parseInt(typeBuf);
                if (yr >= 2000 && yr <= 2099) state.year = yr;
                typeBuf = '';
                render();
            } else {
                typeTimer = setTimeout(function() { typeBuf = ''; }, 1200);
            }
        }
    };

    var typeLetter = function(letter) {
        if (activeSeg !== 'mmm') return;
        clearTimeout(typeTimer);
        typeBuf += letter.toLowerCase();
        var matched = -1;
        for (var i = 0; i < 12; i++) {
            if (WMS_MONTHS_SHORT_FULL[i].toLowerCase().indexOf(typeBuf) === 0) {
                matched = i;
                break;
            }
        }
        if (matched >= 0) {
            state.month = matched;
            render();
        }
        if (typeBuf.length >= 3) {
            typeBuf = '';
            moveSeg(1);
        } else {
            typeTimer = setTimeout(function() { typeBuf = ''; }, 800);
        }
    };

    // ── Event listeners ──
    wrap.querySelectorAll('.wms-di-seg').forEach(function(seg) {
        seg.addEventListener('mousedown', function(e) {
            e.preventDefault();
            setActive(seg.dataset.seg);
            wrap.focus();
        });
    });
    wrap.addEventListener('mousedown', function(e) {
        if (e.target === wrap) {
            e.preventDefault();
            setActive('dd');
            wrap.focus();
        }
    });
    wrap.addEventListener('focus', function() {
        if (!activeSeg) setActive('dd');
    });
    wrap.addEventListener('blur', function() { clearActive(); });

    wrap.addEventListener('keydown', function(e) {
        if (!activeSeg) setActive('dd');
        var key = e.key;
        if (key === 'ArrowLeft') { e.preventDefault(); moveSeg(-1); }
        else if (key === 'ArrowRight') { e.preventDefault(); moveSeg(1); }
        else if (key === 'ArrowUp') { e.preventDefault(); adjust(1); }
        else if (key === 'ArrowDown') { e.preventDefault(); adjust(-1); }
        else if (key === 'Tab') {
            if (!e.shiftKey && activeSeg !== 'yyyy') { e.preventDefault(); moveSeg(1); }
            else if (e.shiftKey && activeSeg !== 'dd') { e.preventDefault(); moveSeg(-1); }
            else { clearActive(); }
        } else if (key === 'Enter') {
            e.preventDefault();
            if (activeSeg !== 'yyyy') moveSeg(1); else clearActive();
        } else if (/^[0-9]$/.test(key)) { e.preventDefault(); typeDigit(key); }
        else if (/^[a-zA-Z]$/.test(key)) { e.preventDefault(); typeLetter(key); }
    });

    // Calendar button
    calBtn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        calInput.value = toYMD();
        if (typeof calInput.showPicker === 'function') {
            calInput.showPicker();
        } else {
            calInput.focus();
            calInput.click();
        }
    });
    calInput.addEventListener('change', function() {
        if (calInput.value) {
            var p = calInput.value.split('-');
            state.year = parseInt(p[0]);
            state.month = parseInt(p[1]) - 1;
            state.day = parseInt(p[2]);
            render();
        }
    });

    // ── Set initial value (today) ──
    var now = new Date();
    state.day = now.getDate();
    state.month = now.getMonth();
    state.year = now.getFullYear();
    // silent render (don't fire onChange for initial)
    ddEl.textContent = String(state.day).padStart(2, '0');
    mmmEl.textContent = WMS_MONTHS_SHORT_FULL[state.month];
    yyyyEl.textContent = String(state.year);

    // ── Controller ──
    return {
        getValue: function() { return toYMD(); },
        setValue: function(v) {
            if (v instanceof Date) {
                state.day = v.getDate(); state.month = v.getMonth(); state.year = v.getFullYear();
            } else if (typeof v === 'string' && v) {
                var p = v.split('-');
                state.year = parseInt(p[0]); state.month = parseInt(p[1]) - 1; state.day = parseInt(p[2]);
            }
            ddEl.textContent = String(state.day).padStart(2, '0');
            mmmEl.textContent = WMS_MONTHS_SHORT_FULL[state.month];
            yyyyEl.textContent = String(state.year);
        },
        destroy: function() { containerEl.innerHTML = ''; }
    };
};

/* ────────────────────────────────────────────────────────────────────────────
   wmsAttachAmountInput(input, opts)

   Turns a plain <input> into a comma-formatted amount input that matches
   the rest of the WMS UI:
     • on blur     → reformatted with Indian/International commas (per the
                     user's selected display unit)
     • on focus    → strips commas so the user can edit/select cleanly
     • Enter key   → fires opts.onCommit (if provided), then blur-formats
     • returns a controller with getValue() / setValue() / destroy()

   Values are stored and exposed as raw rupee numbers (no unit division).
   ──────────────────────────────────────────────────────────────────────── */
var wmsAttachAmountInput = function(input, opts) {
    if (!input) return null;
    opts = opts || {};
    var allowNegative = opts.allowNegative !== false;
    var decimals = (typeof opts.decimals === 'number') ? opts.decimals : 2;

    // Make sure the underlying field accepts arbitrary text + commas.
    if (input.type !== 'text') input.type = 'text';
    input.setAttribute('inputmode', allowNegative ? 'decimal' : 'decimal');
    input.autocomplete = 'off';

    var pickStyle = function() {
        try {
            var unit = (typeof getDisplayUnit === 'function') ? getDisplayUnit() : 'lakhs';
            var cfg = (typeof getUnitConfig === 'function') ? getUnitConfig(unit) : { comma: 'indian' };
            return cfg.comma || 'indian';
        } catch (e) { return 'indian'; }
    };

    var fmt = function(num) {
        if (num === null || num === undefined || isNaN(num)) return '';
        var sign = num < 0 ? '-' : '';
        var abs = Math.abs(num);
        var fixed = abs.toFixed(decimals);
        var parts = fixed.split('.');
        var intPart = parts[0];
        var decPart = parts[1];
        var style = pickStyle();
        var grouped;
        if (style === 'indian') {
            var lastThree = intPart.length > 3 ? intPart.substring(intPart.length - 3) : intPart;
            var rest = intPart.length > 3 ? intPart.substring(0, intPart.length - 3) : '';
            if (rest) {
                grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + lastThree;
            } else {
                grouped = lastThree;
            }
        } else {
            grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        }
        return sign + grouped + (decimals > 0 ? '.' + decPart : '');
    };

    var parse = function(str) {
        if (str === null || str === undefined) return NaN;
        var s = String(str).replace(/,/g, '').trim();
        if (s === '' || s === '-') return NaN;
        var n = parseFloat(s);
        return isNaN(n) ? NaN : n;
    };

    var doBlur = function() {
        var n = parse(input.value);
        if (isNaN(n)) {
            input.value = '';
        } else {
            input.value = fmt(n);
        }
    };
    var doFocus = function() {
        var n = parse(input.value);
        if (!isNaN(n)) {
            input.value = (decimals > 0) ? n.toString() : String(Math.round(n));
            // Select all so the user can immediately overwrite
            try { input.select(); } catch (_) {}
        }
    };
    var doKey = function(e) {
        if (e.key === 'Enter') {
            doBlur();
            if (typeof opts.onCommit === 'function') opts.onCommit(parse(input.value));
        }
    };
    // Strip anything that isn't a digit, comma, dot, or leading minus while typing.
    // EXCEPTION: while an "=" formula is being entered (wmsInitFormulaInput), leave
    // the value alone so the Excel-style calculator can work — it replaces the field
    // with the numeric result on Enter/blur, which then formats normally.
    var doInput = function() {
        var v = input.value;
        if (v.charAt(0) === '=') return;
        var cleaned = v.replace(/[^\d.,\-]/g, '');
        if (cleaned !== v) input.value = cleaned;
    };

    input.addEventListener('blur', doBlur);
    input.addEventListener('focus', doFocus);
    input.addEventListener('keydown', doKey);
    input.addEventListener('input', doInput);

    return {
        getValue: function() {
            var n = parse(input.value);
            return isNaN(n) ? null : n;
        },
        setValue: function(n) {
            if (n === null || n === undefined || isNaN(n)) {
                input.value = '';
            } else {
                input.value = (document.activeElement === input)
                    ? ((decimals > 0) ? n.toString() : String(Math.round(n)))
                    : fmt(n);
            }
        },
        destroy: function() {
            input.removeEventListener('blur', doBlur);
            input.removeEventListener('focus', doFocus);
            input.removeEventListener('keydown', doKey);
            input.removeEventListener('input', doInput);
        }
    };
};

/* ────────────────────────────────────────────────────────────────────────────
 * wmsDateFilter(containerEl, opts)
 * Date range filter with 3 controls:
 *   1) Period dropdown — Today, Yesterday, WTD (Mon–today), Last 7/30/90 days, ALL
 *   2) FY dropdown — populated from transaction dates; label "FY26 (Mar26)"
 *   3) Custom button — opens popover with two wmsDateInput widgets
 *
 * Selecting any one deselects the others (mutually exclusive).
 *
 * @param {HTMLElement} containerEl
 * @param {Object} opts
 *   - default: 'today'|'yesterday'|'wtd'|'last7'|'last30'|'last90'|'all'|'currentFY' (default: 'all')
 *   - onChange: function(from, to)
 *   - fyStartMonth: 1-12 (default: 4)
 *   - transactions: Array — transaction records with transaction_date field
 *   - persistKey: string — localStorage key. When set, the user's selection
 *     (period preset, FY choice, or Custom range) is saved on every change and
 *     restored on init, overriding opts.default. Stored value is validated on
 *     restore (unknown preset / FY not in list → falls back to opts.default).
 *     Added 2026-08-05 (owner request — filters were resetting on every load).
 * @returns controller: getRange(), setPreset(), getPreset(), destroy()
 * ──────────────────────────────────────────────────────────────────────────── */
var wmsDateFilter = function(containerEl, opts) {
    opts = opts || {};
    var defaultPreset = opts.default || 'all';
    var persistKey = opts.persistKey || null;
    var onChangeCallback = opts.onChange || function() {};
    var fyStartMonth = opts.fyStartMonth || 4;
    var transactions = opts.transactions || [];

    var currentPreset = null;
    var currentCustomFrom = null;
    var currentCustomTo = null;
    var popoverOpen = false;
    var customFromCtrl = null;
    var customToCtrl = null;

    // ────── Build FY list from transaction data ──────
    var fyList = [];
    var fySet = {};
    // Always include current FY
    var now = new Date();
    var curM = now.getMonth() + 1;
    var curY = now.getFullYear();
    var currentFYEndYear = (curM >= fyStartMonth) ? curY + 1 : curY;
    fySet[currentFYEndYear] = true;

    transactions.forEach(function(t) {
        if (!t.transaction_date) return;
        var parts = t.transaction_date.split('-');
        var y = parseInt(parts[0]);
        var m = parseInt(parts[1]);
        var endYear = (m >= fyStartMonth) ? y + 1 : y;
        fySet[endYear] = true;
    });

    var years = Object.keys(fySet).map(Number).sort(function(a,b){ return b - a; });
    years.forEach(function(endYear) {
        var startYear = endYear - 1;
        var fromStr = startYear + '-' + String(fyStartMonth).padStart(2, '0') + '-01';
        var endMonth = fyStartMonth - 1;
        var ey = endYear;
        if (endMonth < 1) { endMonth = 12; ey = startYear; }
        var lastDay = new Date(ey, endMonth, 0).getDate();
        var toStr = ey + '-' + String(endMonth).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0');

        // Label: "FY26 (Mar26)"
        var endMonthName = WMS_MONTHS_SHORT_FULL[endMonth - 1];
        fyList.push({
            label: 'FY' + String(endYear).slice(-2) + ' (' + endMonthName + String(endYear).slice(-2) + ')',
            value: 'fy_' + endYear,
            from: fromStr,
            to: toStr
        });
    });

    // ────── Helpers ──────
    var formatYMD = function(date) {
        return date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0');
    };

    // Period presets shown in the Period dropdown (order = display order).
    // Used by the default-preset guard and setPreset() too — keep in ONE place.
    var WMS_DF_PERIOD_PRESETS = ['today', 'yesterday', 'wtd', 'last7', 'last30', 'last90', 'all'];

    var getPresetRange = function(preset) {
        var today = new Date();
        if (preset === 'today')  return { from: formatYMD(today), to: formatYMD(today) };
        if (preset === 'yesterday') {
            var yd = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
            return { from: formatYMD(yd), to: formatYMD(yd) };
        }
        if (preset === 'wtd') {
            // Week-to-date: Monday of the current week through today (Mon → getDay()=1; Sun counts as end of the PREVIOUS week)
            var dow = today.getDay(); // Sun=0, Mon=1, ... Sat=6
            var daysSinceMonday = (dow + 6) % 7;
            var monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysSinceMonday);
            return { from: formatYMD(monday), to: formatYMD(today) };
        }
        if (preset === 'last7')  return { from: formatYMD(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7)), to: formatYMD(today) };
        if (preset === 'last30') return { from: formatYMD(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 30)), to: formatYMD(today) };
        if (preset === 'last90') return { from: formatYMD(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 90)), to: formatYMD(today) };
        if (preset === 'all')    return { from: null, to: null };
        if (preset === 'custom') return { from: currentCustomFrom, to: currentCustomTo };
        for (var i = 0; i < fyList.length; i++) {
            if (fyList[i].value === preset) return { from: fyList[i].from, to: fyList[i].to };
        }
        return { from: null, to: null };
    };

    var fireChange = function() {
        var range = getPresetRange(currentPreset);
        onChangeCallback(range.from, range.to);
    };

    // ────── Browser persistence (opts.persistKey) ──────
    var saveState = function() {
        if (!persistKey) return;
        try {
            localStorage.setItem(persistKey, JSON.stringify({
                preset: currentPreset,
                customFrom: currentCustomFrom,
                customTo: currentCustomTo
            }));
        } catch (e) { /* storage full/blocked — persistence is best-effort */ }
    };

    // ────── Build UI ──────
    containerEl.className = 'wms-date-filter';
    containerEl.style.position = 'relative';
    containerEl.style.display = 'inline-flex';
    containerEl.style.alignItems = 'center';
    containerEl.style.gap = '6px';
    containerEl.innerHTML = '';

    // 1) Period dropdown
    var periodSelect = document.createElement('select');
    periodSelect.className = 'wms-df-select';
    periodSelect.innerHTML =
        '<option value="today">Today</option>' +
        '<option value="yesterday">Yesterday</option>' +
        '<option value="wtd">WTD</option>' +
        '<option value="last7">Last 7 days</option>' +
        '<option value="last30">Last 30 days</option>' +
        '<option value="last90">Last 90 days</option>' +
        '<option value="all" selected>All</option>';

    periodSelect.addEventListener('change', function() {
        currentPreset = periodSelect.value;
        fySelect.value = 'fy_all';
        customBtn.classList.remove('active');
        closePopover();
        saveState();
        fireChange();
    });
    containerEl.appendChild(periodSelect);

    // 2) FY dropdown
    var fySelect = document.createElement('select');
    fySelect.className = 'wms-df-select';
    var fyHtml = '<option value="fy_all">FY: All</option>';
    fyList.forEach(function(fy) {
        fyHtml += '<option value="' + fy.value + '">' + fy.label + '</option>';
    });
    fySelect.innerHTML = fyHtml;

    fySelect.addEventListener('change', function() {
        if (fySelect.value === 'fy_all') {
            currentPreset = periodSelect.value;
        } else {
            currentPreset = fySelect.value;
            periodSelect.value = 'all';
        }
        customBtn.classList.remove('active');
        closePopover();
        saveState();
        fireChange();
    });
    containerEl.appendChild(fySelect);

    // 3) Custom button + popover
    var customBtn = document.createElement('button');
    customBtn.type = 'button';
    customBtn.className = 'wms-df-btn';
    customBtn.textContent = 'Custom';

    var closePopover = function() {
        var existing = containerEl.querySelector('.wms-df-popover');
        if (existing) existing.remove();
        popoverOpen = false;
    };

    var openPopover = function() {
        closePopover();
        popoverOpen = true;

        var pop = document.createElement('div');
        pop.className = 'wms-df-popover';

        // From row
        var fromLabel = document.createElement('span');
        fromLabel.className = 'wms-df-popover-label';
        fromLabel.textContent = 'From';
        var fromContainer = document.createElement('div');
        fromContainer.className = 'wms-df-popover-field';

        // To row
        var toLabel = document.createElement('span');
        toLabel.className = 'wms-df-popover-label';
        toLabel.textContent = 'To';
        var toContainer = document.createElement('div');
        toContainer.className = 'wms-df-popover-field';

        // Apply button
        var applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.className = 'wms-df-popover-apply';
        applyBtn.textContent = 'Apply';

        pop.appendChild(fromLabel);
        pop.appendChild(fromContainer);
        pop.appendChild(toLabel);
        pop.appendChild(toContainer);
        pop.appendChild(applyBtn);
        containerEl.appendChild(pop);

        // Create segmented date inputs
        customFromCtrl = wmsDateInput(fromContainer, {
            compact: true,
            onChange: function() {} // don't fire on every segment change
        });
        customToCtrl = wmsDateInput(toContainer, {
            compact: true,
            onChange: function() {}
        });

        // Pre-populate if we already have custom values
        if (currentCustomFrom) customFromCtrl.setValue(currentCustomFrom);
        if (currentCustomTo) customToCtrl.setValue(currentCustomTo);

        applyBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            currentCustomFrom = customFromCtrl.getValue();
            currentCustomTo = customToCtrl.getValue();
            currentPreset = 'custom';
            periodSelect.value = 'all';
            fySelect.value = 'fy_all';
            customBtn.classList.add('active');
            // Update button label
            updateCustomLabel();
            closePopover();
            saveState();
            fireChange();
        });

        // Close on outside click (delayed to avoid catching the button click itself)
        setTimeout(function() {
            var docClickHandler = function(ev) {
                if (!containerEl.contains(ev.target)) {
                    closePopover();
                    document.removeEventListener('click', docClickHandler);
                }
            };
            document.addEventListener('click', docClickHandler);
            var escHandler = function(ev) {
                if (ev.key === 'Escape') {
                    closePopover();
                    document.removeEventListener('keydown', escHandler);
                }
            };
            document.addEventListener('keydown', escHandler);
        }, 10);
    };

    var updateCustomLabel = function() {
        if (currentCustomFrom && currentCustomTo) {
            var fp = currentCustomFrom.split('-');
            var tp = currentCustomTo.split('-');
            var fromDisp = fp[2] + '-' + WMS_MONTHS_SHORT_FULL[parseInt(fp[1])-1];
            var toDisp = tp[2] + '-' + WMS_MONTHS_SHORT_FULL[parseInt(tp[1])-1];
            customBtn.textContent = fromDisp + ' \u2013 ' + toDisp;
        } else {
            customBtn.textContent = 'Custom';
        }
    };

    customBtn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (popoverOpen) { closePopover(); } else { openPopover(); }
    });
    containerEl.appendChild(customBtn);

    // ────── Restore persisted selection (overrides opts.default when valid) ──────
    if (persistKey) {
        try {
            var storedState = JSON.parse(localStorage.getItem(persistKey) || 'null');
            if (storedState && storedState.preset) {
                if (storedState.preset === 'custom' && storedState.customFrom && storedState.customTo) {
                    currentCustomFrom = storedState.customFrom;
                    currentCustomTo = storedState.customTo;
                    defaultPreset = 'custom';
                } else if (WMS_DF_PERIOD_PRESETS.indexOf(storedState.preset) >= 0) {
                    defaultPreset = storedState.preset;
                } else if (storedState.preset.indexOf('fy_') === 0) {
                    // Only restore an FY that exists in the current FY list
                    for (var sfi = 0; sfi < fyList.length; sfi++) {
                        if (fyList[sfi].value === storedState.preset) { defaultPreset = storedState.preset; break; }
                    }
                }
            }
        } catch (e) { /* corrupt stored value — ignore, use opts.default */ }
    }

    // ────── Apply default preset ──────
    if (WMS_DF_PERIOD_PRESETS.indexOf(defaultPreset) >= 0) {
        periodSelect.value = defaultPreset;
        currentPreset = defaultPreset;
    } else if (defaultPreset === 'custom' && currentCustomFrom && currentCustomTo) {
        currentPreset = 'custom';
        periodSelect.value = 'all';
        fySelect.value = 'fy_all';
        customBtn.classList.add('active');
        updateCustomLabel();
    } else if (defaultPreset === 'currentFY' && fyList.length > 0) {
        fySelect.value = fyList[0].value;
        currentPreset = fyList[0].value;
        periodSelect.value = 'all';
    } else if (defaultPreset.indexOf('fy_') === 0) {
        // A specific restored FY (validated against fyList above)
        fySelect.value = defaultPreset;
        currentPreset = defaultPreset;
        periodSelect.value = 'all';
    } else {
        periodSelect.value = 'all';
        currentPreset = 'all';
    }

    fireChange();

    // ────── Controller ──────
    return {
        getRange: function() { return getPresetRange(currentPreset); },
        setPreset: function(preset) {
            currentPreset = preset;
            if (WMS_DF_PERIOD_PRESETS.indexOf(preset) >= 0) {
                periodSelect.value = preset;
                fySelect.value = 'fy_all';
                customBtn.classList.remove('active');
            } else if (preset.indexOf('fy_') === 0) {
                fySelect.value = preset;
                periodSelect.value = 'all';
                customBtn.classList.remove('active');
            }
            closePopover();
            saveState();
            fireChange();
        },
        getPreset: function() { return currentPreset; },
        destroy: function() { closePopover(); containerEl.innerHTML = ''; }
    };
};

// ============================================================================
// SHARED: Holdings as-of-date calculation
// Used by: trading-rights.js, trading-income.js
// Accepts explicit transactions array — caller passes their module's data.
// ============================================================================

/**
 * Is this a derivative (non-cash-market) security type?
 * Corporate actions — dividend, bonus, split, rights — accrue ONLY to cash-market
 * holdings. Critically, NFO/MCX rows carry the UNDERLYING in `short_symbol`
 * (an AMBUJACEM future has short_symbol = 'AMBUJACEM'), so ANY symbol-keyed
 * holdings calculation will silently absorb F&O positions unless they're filtered out.
 */
function wmsIsDerivativeSecurity(securityType) {
    var t = (securityType || '').toUpperCase();
    return t === 'NFO' || t === 'MCX';
}

/**
 * Is this transaction an F&O (derivative) trade? The canonical predicate for
 * every "is this F&O vs cash" decision (ledger cash treatment, margin engine,
 * portfolio F&O/holdings split). Checks BOTH security_type AND the legacy
 * `product` string — imported rows can carry the F&O signal in `product` while
 * security_type is blank. Includes MCX commodity F&O (NSE NFO + MCX are both
 * derivatives; MCX rows carry security_type='MCX' with product=null). Prefer
 * this over hand-rolled `security_type === 'NFO'` / `/F&O|FNO|NFO/` checks so a
 * new security type is handled in ONE place. See LESSONS §E.15 / wmsIsDerivativeSecurity.
 */
function wmsIsDerivativeTxn(t) {
    if (!t) return false;
    if (wmsIsDerivativeSecurity(t.security_type)) return true;
    var product = (t.product || '').toUpperCase();
    return /F&O|FNO|NFO|MCX|COMMODIT/.test(product);
}

/**
 * Short type label for a security_type: 'NFO' / 'MCX' / 'EQ'. Used by ledger
 * holdings + booked-P&L tables so an MCX row reads 'MCX', not the old 'EQ'.
 */
function wmsSecTypeShortLabel(securityType) {
    var t = (securityType || '').toUpperCase();
    return t === 'NFO' ? 'NFO' : (t === 'MCX' ? 'MCX' : 'EQ');
}

/**
 * Calculate CASH-MARKET holdings for a symbol as of a given date, grouped by
 * inv>trader>broker. F&O / MCX positions in the same underlying are EXCLUDED —
 * corporate actions never accrue to a derivative position, and including them
 * inflates both netQuantity and avgCost.
 * @param {string} shortSymbol — e.g. "RELIANCE"
 * @param {string} targetDate — ISO date string e.g. "2026-03-09"
 * @param {Array} transactions — full transactions array from caller
 * @returns {Array} [{investor_id, trader_id, broker_id, combinedLabel, netQuantity, avgCost}]
 */
function wmsCalcHoldingsAsOfDate(shortSymbol, targetDate, transactions) {
    var filtered = transactions.filter(function(t) {
        var sym = t.short_symbol || t.symbol;
        // Cash-market only — see wmsIsDerivativeSecurity(). An AMBUJACEM futures leg
        // shares the equity's short_symbol and would otherwise be counted as shares.
        if (wmsIsDerivativeSecurity(t.security_type)) return false;
        return !t.dont_display && sym === shortSymbol && t.transaction_date <= targetDate;
    });

    var groups = {};
    filtered.forEach(function(t) {
        var key = (t.investor_id || '') + '|' + (t.trader_id || t.investor_id || '') + '|' + (t.broker_id || '');
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
// SHARED: Batch create transactions
// Used by: trading-rights.js, trading-income.js
// Inserts in chunks of 10 to stay within PostgREST limits.
// ============================================================================

async function wmsBatchCreateTransactions(txns) {
    var headers = wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'});
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
// SHARED: Strip exchange prefix for display (NFO symbols only)
// NFO contracts may have inconsistent "NSE:" prefix; this strips it.
// EQ symbols pass through unchanged.
// ============================================================================

function wmsStripExchangePrefix(txn) {
    var sym = txn.symbol || txn.short_symbol || '';
    if (txn.security_type === 'NFO') {
        sym = sym.replace(/^[A-Z]+:/, '');
    }
    return sym;
}

// ============================================================================
// SHARED: Amount formatting (commas, 2 decimals, parentheses for negatives)
// Used by: trading-add-transaction.js, trading-income.js, trading-rights.js
// ============================================================================

function wmsFmtAmt(value) {
    if (value === null || value === undefined || isNaN(value)) return '0.00';
    var abs = Math.abs(value);
    var formatted = abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (value < 0) return '(' + formatted + ')';
    return formatted;
}

// ============================================================================
// LEDGER ENGINE — Interest, Margin & Running Balance Calculations
// ============================================================================

/**
 * Get interest terms for an investor, optionally overridden by broker-account level.
 * Priority: IBA interest_terms (if brokerId provided and rate > 0) > investor interest_terms > null
 *
 * @param {string} investorId
 * @param {string} brokerId (optional)
 * @returns {object|null} {rate, frequency, compound} or null if not configured
 */
function wmsGetInterestTerms(investorId, brokerId) {
    if (brokerId) {
        var ibaKey = investorId + '|' + brokerId;
        var iba = wmsRefData.ibaRatesMap[ibaKey];
        if (iba && iba.interest_terms && iba.interest_terms.rate > 0) return iba.interest_terms;
    }
    var inv = wmsRefData.investorObjMap[investorId];
    if (inv && inv.interest_terms && inv.interest_terms.rate > 0) return inv.interest_terms;
    return null;
}

/**
 * Get margin rate for an investor+broker combo from IBA.
 * Returns 0 if no margin rate configured.
 */
function wmsGetMarginRate(investorId, brokerId) {
    var ibaKey = investorId + '|' + brokerId;
    var iba = wmsRefData.ibaRatesMap[ibaKey];
    return (iba && iba.margin_rate) ? iba.margin_rate : 0;
}

/**
 * Get effective tax rate % for an investor (optionally per-broker).
 * Priority: IBA tax_rate → investor tax_rate → 0 (no tax).
 * DB default is 0, not NULL. Returns a number like 12.5 (meaning 12.5%).
 */
var WMS_DEFAULT_TAX_RATE = 0;

function wmsGetTaxRate(investorId, brokerId) {
    // Check IBA-level override first
    if (investorId && brokerId) {
        var ibaKey = investorId + '|' + brokerId;
        var iba = wmsRefData.ibaRatesMap[ibaKey];
        if (iba && iba.tax_rate != null) return iba.tax_rate;
    }
    // Fall back to investor-level
    if (investorId) {
        var inv = wmsRefData.investorObjMap[investorId];
        var invRate = (inv && inv.tax_rate != null) ? parseFloat(inv.tax_rate) : NaN;
        if (!isNaN(invRate)) return invRate;
    }
    // System default
    return WMS_DEFAULT_TAX_RATE;
}

/**
 * Calculate margin blocked for a single F&O trade.
 * margin_blocked = |net_amount| * (margin_rate / 100)
 */
function wmsCalcMarginBlocked(netAmount, marginRate) {
    if (!marginRate || marginRate === 0) return 0;
    return wmsRoundMoney(Math.abs(netAmount) * (marginRate / 100));
}

/**
 * Calculate simple interest for a period.
 * @param {number} principal - The balance on which interest is computed
 * @param {number} ratePA   - Annual rate as percentage (18 = 18%)
 * @param {number} days     - Number of days in the period
 * @returns {number} interest amount (always positive)
 */
function wmsCalcSimpleInterest(principal, ratePA, days) {
    if (!principal || !ratePA || !days) return 0;
    return wmsRoundMoney(Math.abs(principal) * (ratePA / 100) * (days / 365));
}

/**
 * Generate interest periods between two dates based on frequency.
 * Returns array of {start: Date, end: Date, label: string}
 *
 * Frequencies:
 *   weekly_friday    — each period is Monday..Friday (or partial at edges)
 *   daily_monthly_compound — each period is a calendar month (compounding applied)
 *   monthly          — each period is a calendar month
 *   quarterly        — each period is a calendar quarter
 */
function wmsInterestPeriods(fromDate, toDate, frequency) {
    var periods = [];
    var from = new Date(fromDate);
    var to = new Date(toDate);
    if (from >= to) return periods;

    if (frequency === 'weekly_friday') {
        // Find the first Friday >= from
        var cur = new Date(from);
        // Walk to the end of each week (Friday)
        while (cur <= to) {
            var weekStart = new Date(cur);
            // Find next Friday from weekStart
            var dayOfWeek = weekStart.getDay(); // 0=Sun
            var daysToFri = (5 - dayOfWeek + 7) % 7;
            if (daysToFri === 0 && weekStart > from) daysToFri = 7; // if already Friday, go to next
            var weekEnd = new Date(weekStart);
            weekEnd.setDate(weekEnd.getDate() + (daysToFri || 7));
            if (weekEnd > to) weekEnd = new Date(to);
            var label = weekStart.toLocaleDateString('en-IN', {day:'2-digit',month:'short'}) + ' – ' +
                        weekEnd.toLocaleDateString('en-IN', {day:'2-digit',month:'short'});
            periods.push({ start: new Date(weekStart), end: new Date(weekEnd), label: label });
            cur = new Date(weekEnd);
            cur.setDate(cur.getDate() + 1);
        }
    } else if (frequency === 'monthly' || frequency === 'daily_monthly_compound') {
        var cur = new Date(from.getFullYear(), from.getMonth(), 1);
        while (cur <= to) {
            var mStart = cur < from ? new Date(from) : new Date(cur);
            var mEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0); // last day of month
            if (mEnd > to) mEnd = new Date(to);
            var label = mStart.toLocaleDateString('en-IN', {month:'short', year:'numeric'});
            periods.push({ start: new Date(mStart), end: new Date(mEnd), label: label });
            cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
        }
    } else if (frequency === 'quarterly') {
        var cur = new Date(from.getFullYear(), Math.floor(from.getMonth() / 3) * 3, 1);
        while (cur <= to) {
            var qStart = cur < from ? new Date(from) : new Date(cur);
            var qEnd = new Date(cur.getFullYear(), cur.getMonth() + 3, 0);
            if (qEnd > to) qEnd = new Date(to);
            var qNum = Math.floor(cur.getMonth() / 3) + 1;
            var label = 'Q' + qNum + ' ' + cur.getFullYear();
            periods.push({ start: new Date(qStart), end: new Date(qEnd), label: label });
            cur = new Date(cur.getFullYear(), cur.getMonth() + 3, 1);
        }
    }
    return periods;
}

/**
 * Count calendar days between two dates (inclusive of both).
 */
function wmsDaysBetween(d1, d2) {
    var a = new Date(d1); a.setHours(0,0,0,0);
    var b = new Date(d2); b.setHours(0,0,0,0);
    return Math.round((b - a) / 86400000) + 1;
}

/**
 * Build a combined, date-sorted ledger from manual entries + filtered trade transactions.
 * Implements v2 spec: filters transactions by view opts, uses correct amount rules, supports OPENING_BALANCE.
 *
 * @param {Array}  ledgerEntries - rows from ledger_entries table
 * @param {Array}  transactions  - rows from transactions table (will be filtered by opts)
 * @param {object} opts          - {investorIds, traderIds, brokerIds, tagNames, tagLogic}
 *                                 if omitted/empty, returns just ledgerEntries with running balance
 * @returns {Array} combined rows sorted by date, each with:
 *   - _rowType: 'ledger' or 'trade'
 *   - _source: original object
 *   - date: date string (YYYY-MM-DD)
 *   - entryType: entry_type or 'TRADE'
 *   - amount: signed amount (used for running balance)
 *   - _runningBalance: cumulative balance after this row
 *   - (other fields: investorId, traderId, brokerId, reference, notes, symbol, transactionType, etc.)
 */
function wmsBuildLedger(ledgerEntries, transactions, opts) {
    var combined = [];
    opts = opts || {};

    // Helper: check if a value is in an array (case-insensitive for IDs, case-sensitive for tags)
    var _inArray = function(val, arr, caseInsensitive) {
        if (!arr || arr.length === 0) return true; // empty filter = include all
        for (var i = 0; i < arr.length; i++) {
            if (caseInsensitive && typeof val === 'string' && typeof arr[i] === 'string') {
                if (val.toLowerCase() === arr[i].toLowerCase()) return true;
            } else if (val === arr[i]) return true;
        }
        return false;
    };

    // Helper: check if transaction matches filters (investorIds, traderIds, brokerIds, tagNames)
    var _txnMatchesFilters = function(t) {
        if (!_inArray(t.investor_id, opts.investorIds)) return false;
        if (!_inArray(t.trader_id, opts.traderIds)) return false;
        if (!_inArray(t.broker_id, opts.brokerIds)) return false;
        // For tags: if tagNames is empty, include all. Otherwise, check tag match with tagLogic.
        if (opts.tagNames && opts.tagNames.length > 0) {
            var txnTags = t.tags || [];
            var hasTag = false;
            for (var i = 0; i < opts.tagNames.length; i++) {
                if (txnTags.indexOf(opts.tagNames[i]) !== -1) {
                    hasTag = true;
                    break;
                }
            }
            // tagLogic: 'OR' = any match is OK, 'AND' = all must match (simplified to at least one match for OR)
            if (!hasTag) return false;
        }
        return true;
    };

    // Helper: is this an F&O (derivative) trade? Canonical predicate — includes
    // MCX commodity F&O (LESSONS §E.15). For futures, notional is NOT a cash flow
    // (only P&L + margin hit the ledger); MCX was previously missed here and its
    // full notional leaked into the cash balance.
    var _isNFO = function(t) { return wmsIsDerivativeTxn(t); };

    // Helper: check if an NFO transaction is an option contract (CE/PE suffix).
    // Options have cash impact (premium is real cash), unlike futures where the
    // notional is not a cash flow.
    var _isOption = function(t) {
        var sym = t.symbol || '';
        return /(?:CE|PE)$/i.test(sym);
    };

    // Helper: check if a ledger entry matches investor/trader filters.
    // Ledger entries have investor_id (and trader_id == investor_id in this
    // system's UUID namespace), so a trader filter resolves against investor_id
    // when no explicit trader_id is stored on the entry.
    var _entryMatchesFilters = function(e) {
        if (!_inArray(e.investor_id, opts.investorIds)) return false;
        if (opts.traderIds && opts.traderIds.length > 0) {
            var tid = e.trader_id || e.investor_id;
            if (!_inArray(tid, opts.traderIds)) return false;
        }
        return true;
    };

    // Add ledger entries (apply same investor/trader filters as transactions).
    //
    // SIGN CONVENTION — investor receivable view:
    //   The ledger represents the investor's account FROM THE FIRM'S POINT OF
    //   VIEW. A positive balance means the investor owes the firm money.
    //
    //   OPENING_BALANCE   : sign as stored (positive = investor owes at start)
    //   CASH_PAID         : +ve (firm pays out → investor's debt grows)
    //   CASH_RECEIVED     : -ve (investor pays back → debt shrinks)
    //   INTEREST_BOOKED   : +ve (firm charges interest → debt grows)
    //   ADJUSTMENT        : sign as stored
    (ledgerEntries || []).forEach(function(e) {
        if (!_entryMatchesFilters(e)) return;
        var signedAmt = parseFloat(e.amount) || 0;
        if (e.entry_type === 'CASH_PAID' || e.entry_type === 'INTEREST_BOOKED') {
            signedAmt = Math.abs(signedAmt);
        } else if (e.entry_type === 'CASH_RECEIVED') {
            signedAmt = -Math.abs(signedAmt);
        }
        // else OPENING_BALANCE, RECONCILIATION, ADJUSTMENT: use sign as-is

        combined.push({
            _rowType: 'ledger',
            _source: e,
            date: e.entry_date,
            // RECONCILIATION anchors at the END of its day — sub-key '3' sorts it
            // AFTER that date's trades (|1|) and synthetic F&O-P&L rows (|2|). The
            // snapshot balance is captured as the end-of-day running balance, so it
            // must be compared/rebased at end-of-day. Sorting it at '0' (start of
            // day, like OPENING_BALANCE) made (a) lgCheckReconDrift compare an
            // end-of-day snapshot against a start-of-day recompute → false "balance
            // mismatch" banner equal to the day's F&O P&L, and (b) the balance loop
            // re-apply that day's F&O P&L on top of the snapshot → post-recon
            // balances double-counted low. OPENING_BALANCE stays '0' (true
            // start-of-day anchor). See LESSONS §E.17 recon end-of-day fix (2026-08-13).
            sortKey: e.entry_date + '|' + (e.entry_type === 'RECONCILIATION' ? '3' : '0') + '|' + (e.created_at || ''),
            entryType: e.entry_type,
            amount: signedAmt,
            investorId: e.investor_id,
            traderId: e.trader_id,
            brokerId: e.broker_id,
            reference: e.reference || '',
            notes: e.notes || ''
        });
    });

    // Add filtered transactions.
    //
    // SIGN CONVENTION (investor receivable view):
    //   BUY / RIGHTS_PAYMENT  : +ve (firm fronts cash → investor owes more)
    //   SELL / DIVIDEND /
    //   OTHER_INCOME /
    //   CAPITAL_REDUCTION     : -ve (cash inflow reduces what investor owes)
    var _debitTypes = { 'BUY': true, 'RIGHTS_PAYMENT': true };
    var _creditTypes = { 'SELL': true, 'DIVIDEND': true, 'OTHER_INCOME': true, 'CAPITAL_REDUCTION': true };

    // Perspective controls how the per-transaction amount is computed.
    // See LEDGER-ENGINE-LOGIC.md (Amount Used). Three views are supported:
    //
    //   'investor' → display_net_amount
    //                The investor's receivable from the trader. When
    //                investor == trader, this equals net_amount (broker
    //                invoice). When investor ≠ trader, this equals
    //                gross ± trader_charges (the agreed fee the trader pays
    //                the investor, NOT the broker/exchange charges).
    //
    //   'trader'   → display_net_amount
    //                The trader's cost basis — same magnitude as investor
    //                perspective because the investor's receivable from the
    //                trader is by definition equal to the trader's cost.
    //                Sign differs by transaction_type (applied below).
    //
    //   'broker'   → net_amount
    //                What the broker invoiced. Uses DB truth directly,
    //                independent of trader_charges.
    //
    // Default: investor.
    var perspective = opts.perspective || 'investor';

    (transactions || []).forEach(function(t) {
        // Apply filters
        if (!_txnMatchesFilters(t)) return;

        // Determine amount per perspective
        var amt;
        if (perspective === 'broker') {
            // Broker perspective: raw DB net_amount (broker invoice)
            amt = parseFloat(t.net_amount) || 0;
        } else {
            // Investor and trader perspectives share display_net_amount
            // (two sides of the same trader↔investor settlement).
            // Fallback to net_amount if sanitize wasn't run yet.
            amt = t.display_net_amount !== undefined
                ? (parseFloat(t.display_net_amount) || 0)
                : (parseFloat(t.net_amount) || 0);
        }

        // Apply sign based on transaction_type (investor-receivable convention)
        if (_debitTypes[t.transaction_type]) {
            amt = Math.abs(amt);
        } else if (_creditTypes[t.transaction_type]) {
            amt = -Math.abs(amt);
        }
        // else: BONUS, SPLIT, RIGHTS_ENTITLEMENT → amt stays 0
        //       HISTORICAL_PL → use sign as stored in amt

        var isNfo = _isNFO(t);
        var isOpt = isNfo && _isOption(t);
        combined.push({
            _rowType: 'trade',
            _source: t,
            date: t.transaction_date,
            // Include transaction_time in the sort key so intraday trades
            // sort chronologically. NULL time → '00:00:00' sorts as earliest.
            sortKey: t.transaction_date + '|1|' + (t.transaction_time || '00:00:00') + '|' + (t.created_at || ''),
            entryType: 'TRADE',
            amount: amt,
            investorId: t.investor_id,
            traderId: t.trader_id,
            brokerId: t.broker_id,
            reference: t.broker_contract_note_no || '',
            notes: (t.short_symbol || t.symbol || '') + ' ' + (t.transaction_type || ''),
            symbol: t.short_symbol || t.symbol || '',
            transactionType: t.transaction_type,
            quantity: t.quantity || 0,
            price: t.price || 0,
            isNFO: isNfo,
            _isOption: isOpt,
            // Options: premium IS cash — BUY = debit (paid), SELL = credit
            // (received). P&L falls out of the net of both premiums naturally.
            // Futures: NOT cash — only margin is blocked; realised P&L posts
            // via synthetic NFO_PNL rows on cover (see FIFO matching below).
            _nfoCashImpact: isOpt ? true : !isNfo,
            // netAmount on the ledger row reflects the perspective-correct absolute value
            // (unsigned) so downstream display (e.g. price-per-unit) stays consistent.
            netAmount: Math.abs(amt),
            grossAmount: parseFloat(t.gross_amount) || 0,
            traderCharges: parseFloat(t.trader_charges) || 0
        });
    });

    // -----------------------------------------------------------------
    // NFO REALISED P&L — FIFO matching within each contract.
    //
    // F&O trades post as informational line items (no cash impact). When
    // a covering trade (SELL against prior BUY, or BUY against prior
    // short SELL) occurs, the realised P&L is computed on a FIFO basis
    // and a synthetic NFO_PNL row is inserted at the cover date. This
    // row DOES hit the running balance.
    //
    // Sign convention (investor-receivable):
    //   investor / trader perspective:
    //     profit → credit (reduces balance — investor owes less)
    //     loss   → debit  (increases balance — investor owes more)
    //   broker perspective (broker is a vendor):
    //     profit → debit  (increases balance — firm owes broker more)
    //     loss   → credit (reduces balance — firm owes broker less)
    // -----------------------------------------------------------------
    // Only futures need P&L rows — option premiums are already cash items
    // (both legs hit the balance), so their net IS the realised P&L.
    var nfoRows = combined.filter(function(r) { return r.isNFO && !r._isOption && r._rowType === 'trade'; });
    if (nfoRows.length > 0) {
        // Group by bare symbol (strip exchange prefix for consistent keying)
        var nfoBySymbol = {};
        nfoRows.forEach(function(r) {
            var bare = (r._source.symbol || r.symbol || '').replace(/^[A-Z]+:/, '');
            if (!nfoBySymbol[bare]) nfoBySymbol[bare] = [];
            nfoBySymbol[bare].push(r);
        });

        var nfoPnlRows = [];
        // Realised F&O P&L via the SHARED, authoritative matcher wmsFnoRealised
        // (wms-cost-engine.js) — the SAME engine the Accounting module uses, so the
        // two can no longer drift. This block previously carried its own inline
        // symmetric long/short FIFO; it was lifted verbatim into wmsFnoRealised and
        // this call proven byte-identical across every statement view (before/after
        // capture, 0 diff, 2026-08-15). The symmetric FIFO (covers opposite-side lots
        // first, opens the uncovered remainder) still handles shorts (SELL to open).
        // Sign for the running balance is unchanged: profit → credit (−amount),
        // loss → debit (+amount); the broker counterparty display-flip stays in the
        // display layer (lgD), never here (see WMS-CONTEXT PRIORITY Issue 1).
        var _fnoRowById = {}, _fnoInput = [], _fnoId = 0;
        Object.keys(nfoBySymbol).forEach(function(sym) {
            nfoBySymbol[sym].forEach(function(row) {
                var id = 'r' + (_fnoId++);
                _fnoRowById[id] = { row: row, sym: sym };
                _fnoInput.push({ key: sym, type: row.transactionType, qty: row.quantity,
                    net: row.netAmount, id: id, sort: row.sortKey });
            });
        });
        wmsFnoRealised(_fnoInput).forEach(function(res) {
            var realisedPnl = wmsRoundMoney(res.realisedPnl);
            if (realisedPnl === 0) return; // nothing closed / no P&L to post
            var ref = _fnoRowById[res.id], row = ref.row, sym = ref.sym;
            nfoPnlRows.push({
                _rowType: 'nfo_pnl',
                _source: row._source,
                _nfoCashImpact: true,
                date: row.date,
                sortKey: row.sortKey.replace('|1|', '|2|'),
                entryType: 'NFO_PNL',
                amount: -realisedPnl,
                investorId: row.investorId,
                traderId: row.traderId,
                brokerId: row.brokerId,
                reference: '',
                notes: sym + ' F&O P&L',
                symbol: sym,
                transactionType: 'NFO_PNL',
                quantity: res.matchedQty, // qty actually closed
                price: 0,
                isNFO: true,
                netAmount: Math.abs(realisedPnl),
                grossAmount: 0,
                traderCharges: 0,
                _realisedPnl: realisedPnl // unsigned: +ve = profit, -ve = loss
            });
        });

        // Merge P&L rows into combined
        for (var pi = 0; pi < nfoPnlRows.length; pi++) {
            combined.push(nfoPnlRows[pi]);
        }
    }

    // Sort by date, then ledger before trade on same date, then created_at.
    // NFO_PNL rows sort after their covering SELL (sortKey uses |2| vs |1|).
    combined.sort(function(a, b) { return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0; });

    // Compute running balance.
    // OPENING_BALANCE and RECONCILIATION entries both RESET the running
    // balance to their stored amount — OPENING_BALANCE is the period-start
    // anchor, RECONCILIATION is an audit snapshot the user confirmed at a
    // later date ("at this date, the balance was verified to be X"). Both
    // discard earlier drift and rebase subsequent rows onto the snapshot
    // value. This is what makes reconciliation meaningful: if the user
    // edits a pre-recon transaction later, the RECONCILIATION row's amount
    // still anchors the balance at its date, preserving the user's audit.
    //
    // NFO trade rows (_nfoCashImpact === false) appear in the ledger but
    // do NOT change the running balance — they are informational line items.
    // Only NFO_PNL rows (realised P&L on cover) hit the balance.
    var bal = 0;
    combined.forEach(function(row) {
        if (row._rowType === 'ledger' &&
            (row.entryType === 'OPENING_BALANCE' || row.entryType === 'RECONCILIATION')) {
            bal = row.amount;
        } else if (row._nfoCashImpact !== false) {
            bal += row.amount;
        }
        // else: NFO trade row — balance unchanged
        row._runningBalance = wmsRoundMoney(bal);
    });

    return combined;
}

/**
 * Get closing balance on a specific date.
 * Returns the _runningBalance of the last ledger row on or before that date.
 * If no rows found on/before the date, returns 0.
 *
 * @param {Array}  ledger   - sorted output of wmsBuildLedger (with _runningBalance)
 * @param {string} dateStr  - YYYY-MM-DD
 * @returns {number} closing balance on that date
 */
function wmsCalcClosingBalance(ledger, dateStr) {
    var closingBal = 0;
    for (var i = 0; i < ledger.length; i++) {
        if (ledger[i].date <= dateStr) {
            closingBal = ledger[i]._runningBalance;
        } else {
            break;
        }
    }
    return closingBal;
}

/**
 * Calculate interest using weekly_friday frequency.
 * For each Friday in range: get closing balance, calculate interest, post on Saturday.
 *
 * @param {Array}  ledger      - sorted output of wmsBuildLedger
 * @param {object} terms       - {rate, frequency, compound}
 * @param {string} fromStr     - YYYY-MM-DD
 * @param {string} toStr       - YYYY-MM-DD
 * @returns {Array} of {period, closingBalance, days, rate, interest, postDate}
 */
function wmsCalcInterestWeeklyFriday(ledger, terms, fromStr, toStr, marginEvents) {
    if (!terms || !terms.rate) return [];
    var rate = terms.rate;
    var results = [];

    // Find all Fridays in the range
    var from = new Date(fromStr);
    var to = new Date(toStr);
    var cur = new Date(from);

    // Walk to first Friday >= from
    var dayOfWeek = cur.getDay(); // 0=Sun, 5=Fri
    var daysToFri = (5 - dayOfWeek + 7) % 7;
    if (daysToFri === 0 && cur.getTime() === from.getTime()) {
        // Already on Friday
    } else if (daysToFri === 0) {
        daysToFri = 7;
    }
    cur.setDate(cur.getDate() + daysToFri);

    // Process each Friday
    while (cur <= to) {
        var fridayStr = cur.toISOString().slice(0, 10);
        var closingBal = wmsCalcClosingBalance(ledger, fridayStr);
        // Include any outstanding F&O margin at Friday EOD in the interest base
        var marginAtFri = marginEvents ? wmsGetMarginRunningAt(marginEvents, fridayStr) : 0;
        var base = closingBal + marginAtFri;
        // Weekly: rate × (1/52), floored at zero
        var interest = wmsRoundMoney(Math.max(0, base) * (rate / 100) * (1 / 52));

        // Post date is Saturday (Friday + 1)
        var postDate = new Date(cur);
        postDate.setDate(postDate.getDate() + 1);
        var postDateStr = postDate.toISOString().slice(0, 10);

        // Period label: previous Saturday to this Friday (weekly window)
        var prevSat = new Date(cur);
        prevSat.setDate(prevSat.getDate() - 6);
        var periodLabel = prevSat.toLocaleDateString('en-IN', {day:'2-digit',month:'short'}) + ' to ' +
                         cur.toLocaleDateString('en-IN', {day:'2-digit',month:'short'});

        results.push({
            period: periodLabel,
            closingBalance: closingBal,
            marginBalance: marginAtFri,
            baseBalance: base,
            days: 7,
            rate: rate,
            interest: interest,
            postDate: postDateStr,
            fridayDate: fridayStr
        });

        // Move to next Friday
        cur.setDate(cur.getDate() + 7);
    }

    return results;
}

/**
 * Alternative interest engine — simple daily accrual, posted weekly on Saturday.
 *
 * Drop-in alternative to wmsCalcInterestWeeklyFriday. Same signature, same
 * return shape. The only difference is HOW the week's interest is calculated:
 *
 *   Weekly method: base_fri × rate/100 × (1/52)
 *   Daily method:  Σ (base_d × rate/100 × (1/365))  for d in Sat..Fri window
 *
 * Weekly method uses ONLY Friday EOD — it over-charges when balances rose
 * late in the week and under-charges when they dropped mid-week.
 * Daily method reflects actual day-by-day exposure, so it is mechanically
 * fairer when intra-week movements are material (mid-week F&O covers,
 * large cash inflows on a Tuesday, etc.).
 *
 * Both methods post the accumulated week's interest on Saturday (Friday + 1).
 * Posting cadence and downstream ledger behaviour are identical — the only
 * change is the arithmetic inside the single weekly entry.
 *
 * NOT wired into any UI yet. Keep as dormant reference implementation until
 * the Statements module exposes a user-selectable interest method. See
 * WMS-CONTEXT.md TODO ("Daily-accrual interest option for Statements") and
 * WMS-LESSONS.md E.15.6a.
 *
 * @param {Array}  ledger       - sorted output of wmsBuildLedger
 * @param {object} terms        - {rate, frequency, compound}
 * @param {string} fromStr      - YYYY-MM-DD (inclusive)
 * @param {string} toStr        - YYYY-MM-DD (inclusive)
 * @param {Array}  marginEvents - optional; output of wmsCalcMarginFIFO
 * @returns {Array} of {period, closingBalance, marginBalance, baseBalance,
 *                     avgBase, days, rate, interest, postDate, fridayDate, method}
 */
function wmsCalcInterestDailyFriday(ledger, terms, fromStr, toStr, marginEvents) {
    if (!terms || !terms.rate) return [];
    var rate = terms.rate;
    var results = [];

    var from = new Date(fromStr);
    var to = new Date(toStr);
    var cur = new Date(from);

    // Walk to first Friday >= fromStr (identical to weekly engine)
    var dayOfWeek = cur.getDay(); // 0=Sun, 5=Fri
    var daysToFri = (5 - dayOfWeek + 7) % 7;
    if (daysToFri === 0 && cur.getTime() === from.getTime()) {
        // Already on Friday
    } else if (daysToFri === 0) {
        daysToFri = 7;
    }
    cur.setDate(cur.getDate() + daysToFri);

    while (cur <= to) {
        var fridayStr = cur.toISOString().slice(0, 10);

        // Walk the 7-day Sat..Fri window ending on this Friday
        var weekInterest = 0;
        var sumBase = 0;
        for (var i = 6; i >= 0; i--) {
            var d = new Date(cur);
            d.setDate(d.getDate() - i);
            var dStr = d.toISOString().slice(0, 10);
            var closingBal_d = wmsCalcClosingBalance(ledger, dStr);
            var marginAt_d = marginEvents ? wmsGetMarginRunningAt(marginEvents, dStr) : 0;
            var base_d = Math.max(0, closingBal_d + marginAt_d);
            sumBase += base_d;
            weekInterest += base_d * (rate / 100) * (1 / 365);
        }
        weekInterest = wmsRoundMoney(weekInterest);

        // For display consistency with the weekly engine, report Friday's EOD
        // values alongside the daily-sum interest amount.
        var closingBal = wmsCalcClosingBalance(ledger, fridayStr);
        var marginAtFri = marginEvents ? wmsGetMarginRunningAt(marginEvents, fridayStr) : 0;
        var base = closingBal + marginAtFri;

        var postDate = new Date(cur);
        postDate.setDate(postDate.getDate() + 1);
        var postDateStr = postDate.toISOString().slice(0, 10);

        var prevSat = new Date(cur);
        prevSat.setDate(prevSat.getDate() - 6);
        var periodLabel = prevSat.toLocaleDateString('en-IN', {day:'2-digit',month:'short'}) + ' to ' +
                         cur.toLocaleDateString('en-IN', {day:'2-digit',month:'short'});

        results.push({
            period: periodLabel,
            closingBalance: closingBal,              // Fri EOD (for display parity)
            marginBalance: marginAtFri,              // Fri EOD margin
            baseBalance: base,                       // Fri EOD base
            avgBase: wmsRoundMoney(sumBase / 7),     // time-weighted avg across 7 days
            days: 7,
            rate: rate,
            interest: weekInterest,                  // 7-day daily-sum result
            postDate: postDateStr,
            fridayDate: fridayStr,
            method: 'daily_sum_friday_post'
        });

        cur.setDate(cur.getDate() + 7);
    }

    return results;
}

/**
 * Daily-accrual interest, posted monthly, optionally compounded.
 *
 * Walks each day in the range, computing interest on (debit_balance + margin)
 * at that day's EOD. Accumulates per-month and emits one period row per
 * completed-or-in-progress month with the total monthly accrual.
 *
 * Compounding: when `terms.compound === true`, the accumulator within the
 * month is added to each subsequent day's base so the interest itself earns
 * interest until month-end posting. After the month-end post, the accumulator
 * resets — the posted INTEREST_BOOKED entry now lives in the ledger and
 * affects the running balance for the next month's daily accruals (so the
 * effect of last month's interest still compounds into the next month via
 * the cash-balance channel).
 *
 * Daily base formula matches wmsCalcInterestWeeklyFriday's intent:
 *     debit_balance = max(0, cash_running_balance_at_EOD_d)
 *     base_d        = debit_balance + margin_d
 *   The clamp at 0 means a credit position (firm owes counterparty) earns
 *   no interest — per E.15.6, only the investor's debit (firm owes us)
 *   triggers interest. Margin is always positive (collateral magnitude).
 *
 * Each result row carries a `trace` array for the detail modal — one entry
 * per day with {date, debitBal, margin, base, dailyInterest, accruedSoFar}.
 *
 * @param {Array}  ledger        - sorted output of wmsBuildLedger
 * @param {object} terms         - {rate, frequency, compound}
 * @param {string} fromStr       - YYYY-MM-DD (inclusive). Daily loop starts here.
 * @param {string} toStr         - YYYY-MM-DD (inclusive). Loop clips to this.
 * @param {Array}  marginEvents  - optional; output of wmsCalcMarginFIFO
 * @returns {Array} of {period, closingBalance, marginBalance, baseBalance,
 *                     days, rate, interest, postDate, frequency, compound, trace}
 */
function wmsCalcInterestDailyMonthlyCompound(ledger, terms, fromStr, toStr, marginEvents) {
    if (!terms || !terms.rate) return [];
    var rate = terms.rate;
    var compound = terms.compound === true;
    var dailyRate = (rate / 100) / 365;   // calendar-day basis
    var results = [];

    // Helpers — work in UTC to avoid DST drift on date arithmetic.
    function toIso(d) { return d.toISOString().slice(0, 10); }
    function addDaysUtc(d, n) {
        var nd = new Date(d.getTime());
        nd.setUTCDate(nd.getUTCDate() + n);
        return nd;
    }
    function monthEndUtc(year, month0) {
        // Last day of month0 (0..11). Day 0 of next month = last day of this month.
        return new Date(Date.UTC(year, month0 + 1, 0));
    }

    // Walk MONTH-BY-MONTH from the month containing fromStr through the month
    // containing toStr. Each month's daily loop is clipped to [fromStr, toStr].
    var fromDate = new Date(fromStr + 'T00:00:00Z');
    var toDate   = new Date(toStr   + 'T00:00:00Z');
    if (fromDate > toDate) return [];

    var mYear  = fromDate.getUTCFullYear();
    var mMonth = fromDate.getUTCMonth();

    var lastMonthYM = toDate.getUTCFullYear() * 12 + toDate.getUTCMonth();
    while ((mYear * 12 + mMonth) <= lastMonthYM) {
        var monthFirst = new Date(Date.UTC(mYear, mMonth, 1));
        var monthLast  = monthEndUtc(mYear, mMonth);

        // Clip the daily loop to the requested window.
        var loopStart = monthFirst < fromDate ? fromDate : monthFirst;
        var loopEnd   = monthLast  > toDate   ? toDate   : monthLast;

        var monthAccrued = 0;
        var trace = [];

        var cursor = new Date(loopStart.getTime());
        while (cursor <= loopEnd) {
            var dStr = toIso(cursor);
            var cashBal_d = wmsCalcClosingBalance(ledger, dStr);
            var debitBal_d = Math.max(0, cashBal_d);
            var margin_d   = marginEvents ? wmsGetMarginRunningAt(marginEvents, dStr) : 0;
            // Daily interest is SIMPLE — base = debit + margin only. No
            // intra-month accrual added to the base. The `compound` flag
            // on the terms governs cross-MONTH behaviour: once a month's
            // interest is posted as INTEREST_BOOKED, that entry joins the
            // ledger and naturally inflates next month's running balance
            // (the running cash balance IS the compounding channel). If
            // the user doesn't post a month's interest, it doesn't compound
            // — which matches the explicit "post to compound" workflow.
            // Earlier implementation added monthAccrued to base_d, which
            // was DAILY compounding within the month — wrong per owner spec
            // 2026-05-27 ("daily is simple interest").
            var base_d = debitBal_d + margin_d;
            // Round each day's interest to 2dp before accumulating so the
            // trace's per-day column sums EXACTLY to the posted monthly total.
            var daily_d = wmsRoundMoney(base_d * dailyRate);
            monthAccrued += daily_d;
            trace.push({
                date: dStr,
                debitBal: wmsRoundMoney(debitBal_d),
                margin: wmsRoundMoney(margin_d),
                base: wmsRoundMoney(base_d),
                dailyInterest: daily_d,
                accruedSoFar: wmsRoundMoney(monthAccrued)
            });
            cursor = addDaysUtc(cursor, 1);
        }

        var roundedInterest = wmsRoundMoney(monthAccrued);
        if (roundedInterest > 0) {
            // Closing-balance + margin at the LAST day of the loop window
            // (which is month-end for completed months, today for in-progress).
            var lastDayStr = toIso(loopEnd);
            var closingBal = wmsCalcClosingBalance(ledger, lastDayStr);
            var marginAtEnd = marginEvents ? wmsGetMarginRunningAt(marginEvents, lastDayStr) : 0;
            var debitAtEnd = Math.max(0, closingBal);
            // Use the actual posting date — month-end for completed months,
            // today's date for the in-progress month (so the pending row
            // shows up as commitable RIGHT NOW with accrual-to-date).
            var postDateStr = toIso(loopEnd);

            var monthLabel = monthFirst.toLocaleDateString('en-IN', {month:'short', year:'numeric'}); // "Apr 2026"
            var periodLabel = toLocaleShort(loopStart) + ' to ' + toLocaleShort(loopEnd);

            results.push({
                period: periodLabel,
                monthLabel: monthLabel,
                closingBalance: closingBal,           // signed cash at last day
                marginBalance: marginAtEnd,
                baseBalance: debitAtEnd + marginAtEnd, // unclamped-signed display base
                days: trace.length,
                rate: rate,
                interest: roundedInterest,
                postDate: postDateStr,
                frequency: 'daily_monthly_compound',
                compound: compound,
                trace: trace
            });
        }

        // Advance to next month.
        if (mMonth === 11) { mMonth = 0; mYear++; } else { mMonth++; }
    }

    return results;
}

function toLocaleShort(d) {
    return d.toLocaleDateString('en-IN', {day:'2-digit', month:'short'});
}

/**
 * Get running F&O margin as of a given date (inclusive).
 * Walks through margin events (output of wmsCalcMarginFIFO) in date order
 * and returns the last runningMargin value at/before dateStr.
 *
 * @param {Array} events - output of wmsCalcMarginFIFO
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {number} running margin blocked as of dateStr
 */
function wmsGetMarginRunningAt(events, dateStr) {
    if (!events || events.length === 0) return 0;
    var running = 0;
    for (var i = 0; i < events.length; i++) {
        if (events[i].date <= dateStr) {
            running = events[i].runningMargin;
        } else {
            break;
        }
    }
    return running;
}

/**
 * Calculate interest using daily_monthly_compound frequency.
 * For each day, compute daily interest; aggregate by month; post on 1st of next month.
 *
 * @param {Array}  ledger      - sorted output of wmsBuildLedger
 * @param {object} terms       - {rate, frequency, compound}
 * @param {string} fromStr     - YYYY-MM-DD
 * @param {string} toStr       - YYYY-MM-DD
 * @returns {Array} of {period, totalDailyInterest, avgBalance, days, rate, interest, postDate}
 */
function wmsCalcInterestDailyMonthly(ledger, terms, fromStr, toStr) {
    if (!terms || !terms.rate) return [];
    var rate = terms.rate;
    var results = [];

    var from = new Date(fromStr);
    var to = new Date(toStr);

    // Group days by month
    var cur = new Date(from.getFullYear(), from.getMonth(), 1);
    while (cur <= to) {
        var monthStart = cur < from ? new Date(from) : new Date(cur);
        var monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
        if (monthEnd > to) monthEnd = new Date(to);

        // Calculate daily interest for each day in this month
        var totalInterest = 0;
        var sumBalances = 0;
        var dayCount = 0;

        var day = new Date(monthStart);
        while (day <= monthEnd) {
            var dayStr = day.toISOString().slice(0, 10);
            var dayClosingBal = wmsCalcClosingBalance(ledger, dayStr);
            var dailyInt = wmsRoundMoney(Math.max(0, dayClosingBal) * (rate / 100) * (1 / 365));
            totalInterest = wmsRoundMoney(totalInterest + dailyInt);
            sumBalances += dayClosingBal;
            dayCount++;
            day.setDate(day.getDate() + 1);
        }

        var avgBal = dayCount > 0 ? wmsRoundMoney(sumBalances / dayCount) : 0;
        var postDate = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
        var postDateStr = postDate.toISOString().slice(0, 10);

        var periodLabel = monthStart.toLocaleDateString('en-IN', {month:'short', year:'numeric'});

        results.push({
            period: periodLabel,
            totalDailyInterest: totalInterest,
            avgBalance: avgBal,
            days: dayCount,
            rate: rate,
            interest: totalInterest,
            postDate: postDateStr
        });

        cur.setMonth(cur.getMonth() + 1);
    }

    return results;
}

/**
 * Calculate F&O margin using FIFO matching of open/close positions.
 * For each NFO transaction, track open positions by contract (symbol + expiry).
 * When a closing trade is detected (opposite direction), FIFO-match to oldest open position.
 *
 * @param {Array} transactions - sorted by date, NFO transactions only
 * @param {object} [opts]      - optional overrides
 * @param {string} [opts.marginRateInvestorId] - if set, every trade's margin rate
 *                  resolves from `wmsGetMarginRate(opts.marginRateInvestorId, t.broker_id)`
 *                  INSTEAD of the per-trade trader_id/investor_id lookup. This is what
 *                  broker views want: ALL trades on stmt_TG should use the (T0, TG) IBA
 *                  rate uniformly, not pick up the per-trader IBA (T2 has 33.33% vs
 *                  T0's 25% — mixing them on the broker view is wrong because the
 *                  broker statement is the firm's view of the broker invoice, and the
 *                  firm-level margin rate with that broker is the single applicable
 *                  rate). When unset, the legacy per-trade trader_id-first lookup is
 *                  used (matches how trader views like stmt_T2 work today).
 * @returns {Array} of {date, symbol, marginAdj, runningMargin}
 *          marginAdj = positive when margin blocked, negative when released
 *          runningMargin = cumulative margin after this adjustment
 */
function wmsCalcMarginFIFO(transactions, opts) {
    opts = opts || {};
    var rateOverrideInv = opts.marginRateInvestorId || null;
    var results = [];
    var positions = {}; // {contractKey} -> [{date, qty, price, marginRate, amount}]
    var runningMargin = 0;

    (transactions || []).forEach(function(t) {
        // Skip if not a derivative (F&O). Includes MCX commodity F&O (§E.15).
        if (!wmsIsDerivativeTxn(t)) return;

        // Strip exchange prefix (NSE:, BSE:, etc.) so trades from different
        // import sources (Fyers tradebook with prefix, CN/Excel without) match
        // the same contract bucket. Mirrors A.2.13 / E.15.5b for the ledger
        // futures FIFO engine.
        var cleanSym = (t.symbol || t.short_symbol || '').replace(/^[A-Z]+:/, '');
        var contractKey = cleanSym + '|' + (t.expiry || '');
        var qty = parseFloat(t.quantity) || 0;
        var isShort = qty < 0; // negative qty = short position

        // Detect option contracts (CE/PE suffix) — use cleaned symbol so the
        // regex works regardless of import source.
        var sym = cleanSym;
        var isOption = /(?:CE|PE)$/i.test(sym);

        // Option BUY that opens a new long position: no margin needed (buyer pays
        // premium upfront, no collateral). But we MUST still register the position
        // in the FIFO tracker so that a subsequent SELL is recognised as closing
        // (not as a fresh short that blocks margin).
        // If this BUY is closing an existing short option position, it flows
        // through to the normal closing logic to release margin.
        if (isOption && !isShort) {
            if (!positions[contractKey]) positions[contractKey] = [];
            var existingPos = positions[contractKey];
            var existingPosQty = 0;
            for (var ei = 0; ei < existingPos.length; ei++) existingPosQty += existingPos[ei].qty;
            if (existingPosQty >= 0) {
                // No short position — this is opening/adding to a long. Register
                // the lot with zero margin so SELLs can close it via FIFO.
                positions[contractKey].push({
                    date: t.transaction_date,
                    qty: qty,
                    price: parseFloat(t.price) || 0,
                    marginRate: 0,
                    marginAmount: 0
                });
                return; // No margin event emitted
            }
            // else: there IS a short position → fall through to closing logic
        }

        // Margin is computed against the trader's cost basis — use display_net_amount,
        // which collapses to net_amount when investor == trader.
        var amt = t.display_net_amount !== undefined
            ? (parseFloat(t.display_net_amount) || 0)
            : (parseFloat(t.net_amount) || 0);

        // Get margin rate.
        // (a) If caller provided `opts.marginRateInvestorId` (broker views do),
        //     use that fixed investor with the trade's broker_id for ALL trades.
        //     This makes broker statements apply the FILTER's IBA rate uniformly
        //     instead of mixing per-trader rates (e.g. T2's 33.33% with T0's 25%).
        // (b) Otherwise (trader/investor views): legacy lookup — trader_id first,
        //     falling back to investor_id. Matches trader-view expectations.
        var marginRate = 0;
        if (rateOverrideInv) {
            marginRate = wmsGetMarginRate(rateOverrideInv, t.broker_id);
        } else {
            if (t.trader_id && t.trader_id !== t.investor_id) {
                marginRate = wmsGetMarginRate(t.trader_id, t.broker_id);
            }
            if (!marginRate) {
                marginRate = wmsGetMarginRate(t.investor_id, t.broker_id);
            }
        }
        if (!marginRate || marginRate === 0) return; // No margin for this investor-broker combo

        // Margin amount:
        //   Futures: margin% × |display_net_amount| (contract value basis)
        //   Option SELL (writing): margin% × qty × strike_price
        //     Strike comes from securities_nfo cache; falls back to trade price if unavailable.
        var marginAmt;
        if (isOption) {
            // Option SELL — margin on notional (qty × strike)
            var strikePrice = 0;
            var nfoRec = t.security_id ? (wmsRefData.securitiesNfoMap || {})[t.security_id] : null;
            if (nfoRec && nfoRec.strike_price) {
                strikePrice = parseFloat(nfoRec.strike_price) || 0;
            }
            if (!strikePrice) {
                // Fallback: parse strike from symbol (e.g., MANAPPURAM26MAR255CE → 255)
                var m = sym.match(/(\d+(?:\.\d+)?)\s*(?:CE|PE)$/i);
                if (m) strikePrice = parseFloat(m[1]) || 0;
            }
            var notional = Math.abs(qty) * strikePrice;
            marginAmt = wmsCalcMarginBlocked(notional, marginRate);
        } else {
            // Futures — existing logic: margin% × |display_net_amount|
            marginAmt = wmsCalcMarginBlocked(Math.abs(amt), marginRate);
        }

        if (!positions[contractKey]) {
            positions[contractKey] = [];
        }

        // Check if this is a closing trade (opposite direction to existing positions)
        var existingQty = 0;
        for (var i = 0; i < positions[contractKey].length; i++) {
            existingQty += positions[contractKey][i].qty;
        }

        var isClosing = (existingQty > 0 && qty < 0) || (existingQty < 0 && qty > 0);

        if (isClosing) {
            // FIFO square-off: release margin from oldest position(s)
            var qtyToClose = Math.abs(qty);
            var totalMarginReleased = 0;

            while (qtyToClose > 0 && positions[contractKey].length > 0) {
                var oldestPos = positions[contractKey][0];
                var oldestAbsQty = Math.abs(oldestPos.qty);
                var closeQty = Math.min(qtyToClose, oldestAbsQty);

                if (closeQty >= oldestAbsQty) {
                    // Fully closed lot: release its entire remaining margin
                    totalMarginReleased += oldestPos.marginAmount;
                    positions[contractKey].shift();
                } else {
                    // Partial close: release the pro-rata slice of this lot's
                    // margin, then retain the remainder on the shrunken lot.
                    var releasedSlice = wmsRoundMoney(
                        oldestPos.marginAmount * (closeQty / oldestAbsQty)
                    );
                    totalMarginReleased += releasedSlice;
                    oldestPos.qty -= (qty < 0 ? closeQty : -closeQty);
                    oldestPos.marginAmount = wmsRoundMoney(oldestPos.marginAmount - releasedSlice);
                }
                qtyToClose -= closeQty;
            }

            // Release margin (negative adjustment)
            runningMargin = wmsRoundMoney(runningMargin - totalMarginReleased);
            results.push({
                date: t.transaction_date,
                symbol: contractKey.split('|')[0],
                marginAdj: -totalMarginReleased,
                runningMargin: runningMargin
            });
        } else {
            // Opening new position: block margin
            positions[contractKey].push({
                date: t.transaction_date,
                qty: qty,
                price: parseFloat(t.price) || 0,
                marginRate: marginRate,
                marginAmount: marginAmt
            });
            runningMargin = wmsRoundMoney(runningMargin + marginAmt);
            results.push({
                date: t.transaction_date,
                symbol: contractKey.split('|')[0],
                marginAdj: marginAmt,
                runningMargin: runningMargin
            });
        }
    });

    return results;
}

/**
 * Get financial year boundaries for an investor on a given date.
 * FY runs from (financial_year_start month, day 1) to (month-1 next year, last day)
 *
 * @param {string} investorId
 * @param {string} forDate    - YYYY-MM-DD (optional; defaults to today)
 * @returns {object} {fyStart, fyEnd, fyLabel}
 *                   fyStart: YYYY-MM-DD (1st of FY start month)
 *                   fyEnd: YYYY-MM-DD (last day of previous month, next year)
 *                   fyLabel: FY YYYY-YY (e.g., "FY 2025-26")
 */
function wmsGetFyBounds(investorId, forDate) {
    var inv = wmsRefData.investorObjMap[investorId];
    var fyStartMonth = (inv && inv.financial_year_start) ? inv.financial_year_start : 4; // Default April
    fyStartMonth = Math.max(1, Math.min(12, fyStartMonth)); // Clamp to 1-12

    var refDate = forDate ? new Date(forDate) : new Date();
    var refYear = refDate.getFullYear();
    var refMonth = refDate.getMonth() + 1; // 1-12

    // Determine which FY the refDate falls into
    var fyYear;
    if (refMonth >= fyStartMonth) {
        fyYear = refYear;
    } else {
        fyYear = refYear - 1;
    }

    var fyStart = new Date(fyYear, fyStartMonth - 1, 1);
    var fyEnd = new Date(fyYear + 1, fyStartMonth - 1, 0); // Last day of previous month in next year

    var fyStartStr = fyStart.toISOString().slice(0, 10);
    var fyEndStr = fyEnd.toISOString().slice(0, 10);
    var fyLabel = 'FY ' + fyYear + '-' + String(fyYear + 1).slice(-2);

    return {
        fyStart: fyStartStr,
        fyEnd: fyEndStr,
        fyLabel: fyLabel
    };
}

// ============================================================================
// VIEW MANAGER — Shared view tabs, More dropdown, save/update/delete/default.
// Replaces ~1500 lines of near-identical code across Portfolio, F&O, Statements.
// Each module creates one instance via wmsViewManager(cfg).
// See WMS-LESSONS.md Section D.10 for UI rules.
// Rule A.1.2: all declarations use var.
// ============================================================================

/**
 * Factory: creates a view manager instance for one module.
 *
 * @param {Object} cfg
 * @param {string}   cfg.module          — DB module value ('trading_portfolio', 'trading_fno', 'ledger')
 * @param {string}   cfg.label           — Display name for console log ('Portfolio', 'F&O', 'Statements')
 * @param {string}   [cfg.moduleFilter]  — Custom PostgREST filter (default: 'module=eq.' + module)
 * @param {Object}   cfg.ids             — DOM element IDs: { viewTabs, moreList, moreDropdown, updateBtn }
 * @param {Function} cfg.getPills        — () => [{pill, type}] — current pill controller refs
 * @param {Function} cfg.getFilters      — () => {investorIds, ...} — snapshot of current filters
 * @param {Function} cfg.applyFilters    — (filtersObj) — restore filter state from a view, sync pills
 * @param {Function} cfg.onRefresh       — () — module's render/refresh after view applied
 * @param {Function} [cfg.onLoadComplete]    — (defaultView|null) — after views loaded from DB
 * @param {Function} [cfg.onDefaultChanged]  — (newDefaultView) — after default view changed
 * @param {Function} [cfg.onUpdateComplete]  — (view) — after view updated
 * @param {Function} [cfg.onSaveComplete]    — () — after save to hide prompt/reset UI
 * @param {boolean}  [cfg.autoDefaultFirst]  — first saved view auto-becomes default (default: false)
 * @returns {Object} vm — { views, activeViewId, loadViews, applyView, ... }
 */
function wmsViewManager(cfg) {
    // --- Public state (read/write by module code) ---
    var vm = {};
    vm.views = [];
    vm.activeViewId = null;

    // --- Internal state ---
    var _renamingTab = false;
    var _moduleFilter = cfg.moduleFilter || ('module=eq.' + cfg.module);

    // --- Header helpers ---
    function _hdrs() { return wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}); }
    function _hdrsMin() { return wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'}); }

    // ----------------------------------------------------------------
    // LOAD VIEWS
    // ----------------------------------------------------------------
    vm.loadViews = async function loadViews() {
        try {
            var resp = await fetch(
                SUPABASE_URL + '/rest/v1/portfolio_views?' + _moduleFilter +
                '&select=id,name,filters,sort_order,is_default,show_in_tabs&order=sort_order.asc,created_at.asc',
                { headers: wmsHeaders() }
            );
            var data = resp.ok ? await resp.json() : [];
            vm.views.length = 0;
            Array.prototype.push.apply(vm.views, data);
        } catch (err) {
            console.warn(cfg.label + ': Failed to load views:', err.message);
            vm.views.length = 0;
        }

        vm.renderViewTabs();
        vm.renderMoreDropdown();
        vm.updateViewButtons();

        var defaultView = vm.views.find(function(v) { return v.is_default; });

        // Module-specific post-load hook (banner refresh, etc.)
        if (cfg.onLoadComplete) cfg.onLoadComplete(defaultView || null);

        // Auto-apply default view on first load
        if (!vm.activeViewId) {
            if (defaultView) {
                vm.applyView(defaultView.id);
            } else if (cfg.onRefresh) {
                cfg.onRefresh();
            }
        }
    };

    // ----------------------------------------------------------------
    // RENDER VIEW TABS
    // ----------------------------------------------------------------
    vm.renderViewTabs = function renderViewTabs() {
        var container = document.getElementById(cfg.ids.viewTabs);
        if (!container) return;

        var defaultView = vm.views.find(function(v) { return v.is_default; });
        var tabViews = vm.views.filter(function(v) {
            return v.show_in_tabs !== false && !v.is_default;
        });

        var html = '';

        // Default view tab — locked left, no close button, star prefix
        if (defaultView) {
            var isActive = defaultView.id === vm.activeViewId;
            html += '<button class="tr-view-tab' + (isActive ? ' active' : '') +
                '" data-view-id="' + defaultView.id + '">' +
                '<span class="tr-tab-star">\u2605</span> ' + wmsEsc(defaultView.name) +
                '</button>';
        }

        // Other pinned tabs — with close button
        tabViews.forEach(function(v) {
            var isActive = v.id === vm.activeViewId;
            html += '<button class="tr-view-tab' + (isActive ? ' active' : '') +
                '" data-view-id="' + v.id + '">' + wmsEsc(v.name) +
                ' <span class="tr-tab-close" data-close-id="' + v.id +
                '" title="Remove from tabs">\u2715</span></button>';
        });

        container.innerHTML = html;

        // Attach click / dblclick handlers (A.1.1 delay pattern)
        container.querySelectorAll('.tr-view-tab').forEach(function(tab) {
            var clickTimer = null;

            tab.addEventListener('click', function(e) {
                if (e.target.classList.contains('tr-tab-close')) {
                    e.stopPropagation();
                    vm.closeViewTab(e.target.dataset.closeId);
                    return;
                }
                if (clickTimer) clearTimeout(clickTimer);
                clickTimer = setTimeout(function() {
                    clickTimer = null;
                    if (_renamingTab) return;  // B4: guard against apply during rename
                    vm.applyView(tab.dataset.viewId);
                }, 250);
            });

            // Double-click to inline rename
            tab.addEventListener('dblclick', function(e) {
                e.preventDefault();
                e.stopPropagation();
                if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
                _renamingTab = true;

                var viewId = tab.dataset.viewId;
                var view = vm.views.find(function(v) { return v.id === viewId; });
                if (!view) { _renamingTab = false; return; }

                vm.activeViewId = viewId;

                // Replace tab content with inline input
                var input = document.createElement('input');
                input.type = 'text';
                input.value = view.name;
                input.className = 'wms-input-compact';
                input.style.width = '100px';
                tab.innerHTML = '';
                tab.appendChild(input);
                input.focus();
                input.select();

                // Isolate input events from parent button
                ['click', 'mousedown', 'mouseup', 'dblclick', 'keydown', 'keyup', 'keypress'].forEach(function(evt) {
                    input.addEventListener(evt, function(ie) { ie.stopPropagation(); });
                });

                var finished = false;
                function finishRename() {
                    if (finished) return;
                    finished = true;
                    _renamingTab = false;
                    var newName = input.value.trim();
                    if (newName && newName !== view.name) {
                        // B2: duplicate name check on rename
                        var duplicate = vm.views.some(function(v) {
                            return v.id !== viewId && v.name.toLowerCase() === newName.toLowerCase();
                        });
                        if (duplicate) {
                            showAlert('A view named "' + newName + '" already exists', 'error', 3000);
                        } else {
                            view.name = newName;
                            fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + viewId, {
                                method: 'PATCH', headers: _hdrsMin(),
                                body: JSON.stringify({ name: newName })
                            }).catch(function(err) { console.warn('Failed to rename view:', err.message); });
                        }
                    }
                    vm.renderViewTabs();
                    vm.renderMoreDropdown();
                }

                input.addEventListener('blur', finishRename);
                input.addEventListener('keydown', function(ke) {
                    ke.stopPropagation();
                    if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
                    if (ke.key === 'Escape') { ke.preventDefault(); input.value = view.name; input.blur(); }
                });
            });
        });
    };

    // ----------------------------------------------------------------
    // RENDER MORE DROPDOWN
    // ----------------------------------------------------------------
    vm.renderMoreDropdown = function renderMoreDropdown() {
        var list = document.getElementById(cfg.ids.moreList);
        if (!list) return;

        if (vm.views.length === 0) {
            list.innerHTML = '<div class="tr-more-empty">No saved views</div>';
            return;
        }

        list.innerHTML = vm.views.map(function(v, idx) {
            var isActive = v.id === vm.activeViewId;
            var isDefault = v.is_default;
            var inTabs = v.show_in_tabs !== false;
            return '<div class="tr-more-item' + (isActive ? ' active' : '') +
                '" draggable="true" data-view-id="' + v.id + '" data-view-idx="' + idx + '">' +
                '<span class="tr-more-drag-handle" title="Drag to reorder">\u2630</span>' +
                (isActive ? '<span style="color:#667eea;font-size:11px;">\u2713</span> ' :
                    '<span style="width:16px;display:inline-block;"></span> ') +
                '<span class="tr-more-name">' + wmsEsc(v.name) + '</span>' +
                (isDefault ? '<span class="tr-more-badge">\u2605 Default</span>' : '') +
                '<span class="tr-more-actions">' +
                    (!isDefault ? '<button class="tr-more-action-btn" data-action="default" data-id="' +
                        v.id + '" title="Set as default">\u2605</button>' : '') +
                    (inTabs && !isDefault ? '<button class="tr-more-action-btn" data-action="hide-tab" data-id="' +
                        v.id + '" title="Remove from tabs">\u229F</button>' : '') +
                    (!inTabs ? '<button class="tr-more-action-btn" data-action="show-tab" data-id="' +
                        v.id + '" title="Show in tabs">\u229E</button>' : '') +
                    '<button class="tr-more-action-btn danger" data-action="delete" data-id="' +
                        v.id + '" title="Delete view">\u2715</button>' +
                '</span></div>';
        }).join('');

        // Click to apply
        list.querySelectorAll('.tr-more-item').forEach(function(item) {
            item.addEventListener('click', function(e) {
                if (e.target.closest('.tr-more-action-btn') || e.target.closest('.tr-more-drag-handle')) return;
                vm.applyView(item.dataset.viewId);
                var dd = document.getElementById(cfg.ids.moreDropdown);
                if (dd) dd.style.display = 'none';
            });
        });

        // Action buttons
        list.querySelectorAll('.tr-more-action-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var action = btn.dataset.action;
                var id = btn.dataset.id;
                if (action === 'default') vm.setDefaultView(id);
                else if (action === 'hide-tab') vm.closeViewTab(id);
                else if (action === 'show-tab') vm.showViewTab(id);
                else if (action === 'delete') vm.deleteView(id);
            });
        });

        // Drag-to-reorder
        _attachDragHandlers(list);
    };

    // ----------------------------------------------------------------
    // UPDATE VIEW BUTTONS (enable/disable Update button)
    // ----------------------------------------------------------------
    vm.updateViewButtons = function updateViewButtons() {
        var updateBtn = document.getElementById(cfg.ids.updateBtn);
        if (updateBtn) {
            updateBtn.disabled = !vm.activeViewId;
        }
    };

    // ----------------------------------------------------------------
    // APPLY VIEW
    // ----------------------------------------------------------------
    vm.applyView = function applyView(viewId) {
        var view = vm.views.find(function(v) { return v.id === viewId; });
        if (!view) return;

        // B5/D.10.7: auto-add to tabs if not showing
        if (view.show_in_tabs === false || view.show_in_tabs === null) {
            view.show_in_tabs = true;
            fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + viewId, {
                method: 'PATCH', headers: _hdrsMin(),
                body: JSON.stringify({ show_in_tabs: true })
            }).catch(function(err) { console.warn('Failed to show tab:', err.message); });
        }

        vm.activeViewId = viewId;

        // Delegate filter restoration to module
        var f = view.filters || {};
        cfg.applyFilters(f);

        vm.renderViewTabs();
        vm.renderMoreDropdown();
        vm.updateViewButtons();
        cfg.onRefresh();
    };

    // ----------------------------------------------------------------
    // SAVE CURRENT VIEW
    // ----------------------------------------------------------------
    vm.saveCurrentView = async function saveCurrentView(name) {
        // Returns the new view object on success, null on failure/cancel.
        // Used by lgEnsureViewSaved (the pre-ledger-POST gate) to await and
        // pick up the new view_id — see LESSONS §E.17.8.

        // B9: duplicate name check
        var exists = vm.views.some(function(v) { return v.name.toLowerCase() === name.toLowerCase(); });
        if (exists) {
            showAlert('A view named "' + name + '" already exists', 'error', 3000);
            return null;
        }

        var filters = cfg.getFilters();
        var sortOrder = vm.views.length;
        var isFirst = cfg.autoDefaultFirst && vm.views.length === 0;

        var saved = null;
        try {
            var resp = await fetch(SUPABASE_URL + '/rest/v1/portfolio_views', {
                method: 'POST', headers: _hdrs(),
                body: JSON.stringify({
                    name: name,
                    filters: filters,
                    sort_order: sortOrder,
                    is_default: isFirst,
                    show_in_tabs: true,
                    module: cfg.module
                })
            });
            if (resp.ok) {
                var rows = await resp.json();
                var newView = Array.isArray(rows) ? rows[0] : rows;
                if (newView) {
                    vm.views.push(newView);
                    // B10: full applyView for consistency
                    vm.applyView(newView.id);
                    showAlert('View "' + name + '" saved', 'success', 2000);
                    saved = newView;
                }
            } else {
                showAlert('Failed to save view', 'error', 3000);
            }
        } catch (err) {
            showAlert('Failed to save view: ' + err.message, 'error', 3000);
        }

        // Module handles prompt hide
        if (cfg.onSaveComplete) cfg.onSaveComplete();
        return saved;
    };

    // ----------------------------------------------------------------
    // CREATE BLANK VIEW
    // ----------------------------------------------------------------
    vm.createBlankView = async function createBlankView() {
        var sortOrder = vm.views.length;
        var name = 'New View';

        try {
            var resp = await fetch(SUPABASE_URL + '/rest/v1/portfolio_views', {
                method: 'POST', headers: _hdrs(),
                body: JSON.stringify({
                    name: name,
                    filters: {},
                    sort_order: sortOrder,
                    is_default: false,
                    show_in_tabs: true,
                    module: cfg.module
                })
            });
            if (resp.ok) {
                var rows = await resp.json();
                var newView = Array.isArray(rows) ? rows[0] : rows;
                if (newView) {
                    vm.views.push(newView);
                    vm.applyView(newView.id);
                    showAlert('New view created \u2014 double-click tab to rename', 'success', 3000);
                }
            } else {
                showAlert('Failed to create view', 'error', 3000);
            }
        } catch (err) {
            showAlert('Failed to create view: ' + err.message, 'error', 3000);
        }
    };

    // ----------------------------------------------------------------
    // UPDATE CURRENT VIEW
    // ----------------------------------------------------------------
    vm.updateCurrentView = async function updateCurrentView() {
        // Returns true on success, false otherwise. Callers can await the
        // result — lgEnsureViewSaved uses this to proceed after an in-gate
        // "Update View" selection.
        if (!vm.activeViewId) return false;

        // Filter-lock guard: if the active view has ledger_entries pointing at
        // it, we refuse to mutate `filters`. The caller is expected to have
        // disabled the Update-View button in this state, but a second guard
        // here prevents programmatic bypass.
        if (cfg.isViewLocked && cfg.isViewLocked(vm.activeViewId)) {
            showAlert('This view is locked (has ledger entries). Create a new view instead.', 'warning', 4000);
            return false;
        }

        var filters = cfg.getFilters();

        try {
            var resp = await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + vm.activeViewId, {
                method: 'PATCH', headers: _hdrsMin(),
                body: JSON.stringify({ filters: filters })
            });
            if (resp.ok) {
                var v = vm.views.find(function(v) { return v.id === vm.activeViewId; });
                if (v) v.filters = filters;
                showAlert('View updated', 'success', 2000);
                // Module-specific post-update hook (banner refresh, etc.)
                if (cfg.onUpdateComplete && v) cfg.onUpdateComplete(v);
                return true;
            } else {
                showAlert('Failed to update view', 'error', 3000);
                return false;
            }
        } catch (err) {
            showAlert('Failed to update view: ' + err.message, 'error', 3000);
            return false;
        }
    };

    // ----------------------------------------------------------------
    // DELETE VIEW (B6: confirm dialog)
    // ----------------------------------------------------------------
    vm.deleteView = async function deleteView(viewId) {
        // Module-level pre-delete hook — Statements uses this to warn about
        // ledger_entries that'd be orphaned. Returning false from the hook
        // aborts the delete.
        if (cfg.beforeDelete) {
            var proceed = await cfg.beforeDelete(viewId);
            if (!proceed) return;
        } else if (!confirm('Delete this saved view?')) {
            return;
        }

        try {
            var resp = await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + viewId, {
                method: 'DELETE',
                headers: wmsHeaders({'Prefer': 'return=minimal'})
            });
            if (resp.ok) {
                // Remove from array in-place
                for (var i = vm.views.length - 1; i >= 0; i--) {
                    if (vm.views[i].id === viewId) { vm.views.splice(i, 1); break; }
                }

                // B7: fall back to default when deleting active view
                if (vm.activeViewId === viewId) {
                    var defaultView = vm.views.find(function(v) { return v.is_default; });
                    if (defaultView) {
                        vm.applyView(defaultView.id);
                        showAlert('View deleted', 'success', 2000);
                        return;
                    } else {
                        vm.activeViewId = null;
                    }
                }

                vm.renderViewTabs();
                vm.renderMoreDropdown();
                vm.updateViewButtons();
                showAlert('View deleted', 'success', 2000);
            }
        } catch (err) {
            showAlert('Failed to delete view: ' + err.message, 'error', 3000);
        }
    };

    // ----------------------------------------------------------------
    // SET DEFAULT VIEW (B12: also sets show_in_tabs)
    // ----------------------------------------------------------------
    vm.setDefaultView = async function setDefaultView(viewId) {
        var oldDefault = vm.views.find(function(v) { return v.is_default; });
        if (oldDefault && oldDefault.id !== viewId) {
            try {
                await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + oldDefault.id, {
                    method: 'PATCH', headers: _hdrsMin(),
                    body: JSON.stringify({ is_default: false })
                });
                oldDefault.is_default = false;
            } catch (err) {
                console.warn('Failed to unset old default:', err.message);
            }
        }

        try {
            await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + viewId, {
                method: 'PATCH', headers: _hdrsMin(),
                body: JSON.stringify({ is_default: true, show_in_tabs: true })
            });
            var v = vm.views.find(function(v) { return v.id === viewId; });
            if (v) { v.is_default = true; v.show_in_tabs = true; }
        } catch (err) {
            console.warn('Failed to set default:', err.message);
        }

        // Module-specific hook (banner refresh, etc.)
        var newDefault = vm.views.find(function(v) { return v.id === viewId; });
        if (cfg.onDefaultChanged && newDefault) cfg.onDefaultChanged(newDefault);

        vm.renderViewTabs();
        vm.renderMoreDropdown();
        showAlert('Default view updated', 'success', 2000);
    };

    // ----------------------------------------------------------------
    // CLOSE VIEW TAB
    // ----------------------------------------------------------------
    vm.closeViewTab = async function closeViewTab(viewId) {
        try {
            await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + viewId, {
                method: 'PATCH', headers: _hdrsMin(),
                body: JSON.stringify({ show_in_tabs: false })
            });
        } catch (err) {
            console.warn('Failed to close tab:', err.message);
        }

        var v = vm.views.find(function(v) { return v.id === viewId; });
        if (v) v.show_in_tabs = false;

        if (vm.activeViewId === viewId) {
            var defaultView = vm.views.find(function(v) { return v.is_default; });
            if (defaultView) {
                vm.applyView(defaultView.id);
                return; // applyView already re-renders
            } else {
                vm.activeViewId = null;
            }
        }

        vm.renderViewTabs();
        vm.renderMoreDropdown();
    };

    // ----------------------------------------------------------------
    // SHOW VIEW TAB
    // ----------------------------------------------------------------
    vm.showViewTab = async function showViewTab(viewId) {
        try {
            await fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + viewId, {
                method: 'PATCH', headers: _hdrsMin(),
                body: JSON.stringify({ show_in_tabs: true })
            });
        } catch (err) {
            console.warn('Failed to show tab:', err.message);
        }

        var v = vm.views.find(function(v) { return v.id === viewId; });
        if (v) v.show_in_tabs = true;

        vm.renderViewTabs();
        vm.renderMoreDropdown();
    };

    // ----------------------------------------------------------------
    // DRAG-TO-REORDER (internal helper)
    // ----------------------------------------------------------------
    function _attachDragHandlers(listEl) {
        var dragIdx = -1;

        listEl.querySelectorAll('.tr-more-item').forEach(function(item) {
            // Only drag from handle
            item.addEventListener('mousedown', function(e) {
                item.setAttribute('draggable', e.target.closest('.tr-more-drag-handle') ? 'true' : 'false');
            });

            item.addEventListener('dragstart', function(e) {
                if (!e.target.closest || e.target.closest('.tr-more-action-btn')) {
                    e.preventDefault();
                    return;
                }
                dragIdx = parseInt(item.dataset.viewIdx);
                item.classList.add('tr-more-dragging');
                e.dataTransfer.effectAllowed = 'move';
            });

            item.addEventListener('dragover', function(e) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                listEl.querySelectorAll('.tr-more-item').forEach(function(el) {
                    el.classList.remove('tr-more-drag-over-top', 'tr-more-drag-over-bottom');
                });
                var rect = item.getBoundingClientRect();
                var mid = rect.top + rect.height / 2;
                if (e.clientY < mid) {
                    item.classList.add('tr-more-drag-over-top');
                } else {
                    item.classList.add('tr-more-drag-over-bottom');
                }
            });

            item.addEventListener('dragleave', function() {
                item.classList.remove('tr-more-drag-over-top', 'tr-more-drag-over-bottom');
            });

            item.addEventListener('drop', function(e) {
                e.preventDefault();
                var targetIdx = parseInt(item.dataset.viewIdx);
                var rect = item.getBoundingClientRect();
                var mid = rect.top + rect.height / 2;
                var insertIdx = e.clientY < mid ? targetIdx : targetIdx + 1;
                if (dragIdx < 0 || dragIdx === insertIdx || dragIdx + 1 === insertIdx) {
                    dragIdx = -1;
                    return;
                }

                var moved = vm.views.splice(dragIdx, 1)[0];
                var newIdx = insertIdx > dragIdx ? insertIdx - 1 : insertIdx;
                vm.views.splice(newIdx, 0, moved);

                // Persist sort_order
                var headers = _hdrsMin();
                vm.views.forEach(function(v, i) {
                    if (v.sort_order !== i) {
                        v.sort_order = i;
                        fetch(SUPABASE_URL + '/rest/v1/portfolio_views?id=eq.' + v.id, {
                            method: 'PATCH', headers: headers,
                            body: JSON.stringify({ sort_order: i })
                        }).catch(function(err) { console.warn('Reorder PATCH error:', err.message); });
                    }
                });

                dragIdx = -1;
                vm.renderViewTabs();
                vm.renderMoreDropdown();
            });

            item.addEventListener('dragend', function() {
                item.classList.remove('tr-more-dragging');
                listEl.querySelectorAll('.tr-more-item').forEach(function(el) {
                    el.classList.remove('tr-more-drag-over-top', 'tr-more-drag-over-bottom');
                });
                dragIdx = -1;
            });
        });
    }

    // ----------------------------------------------------------------
    // PUBLIC API
    // ----------------------------------------------------------------
    vm.loadViews = vm.loadViews;
    vm.renderViewTabs = vm.renderViewTabs;
    vm.renderMoreDropdown = vm.renderMoreDropdown;
    vm.updateViewButtons = vm.updateViewButtons;
    vm.applyView = vm.applyView;
    vm.saveCurrentView = vm.saveCurrentView;
    vm.createBlankView = vm.createBlankView;
    vm.updateCurrentView = vm.updateCurrentView;
    vm.deleteView = vm.deleteView;
    vm.setDefaultView = vm.setDefaultView;
    vm.closeViewTab = vm.closeViewTab;
    vm.showViewTab = vm.showViewTab;

    return vm;
}
