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
// CONSTANTS
// ============================================================================

var WMS_MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
var WMS_WEEKLY_EXPIRY_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];
var WMS_INCOME_TYPES = ['DIVIDEND', 'INTEREST', 'OTHER_INCOME', 'CAPITAL_REDUCTION'];

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
    securitiesNfoReady: false
};

/**
 * Load all reference data from Supabase. Called once at app startup.
 * Feature modules should check wmsRefData.ready before using data.
 * After master data edits (investors, brokers, IBA, reg charges), call this again.
 */
async function wmsLoadRefData() {
    var headers = { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY };
    try {
        var resp;

        // 1. Investors
        resp = await fetch(SUPABASE_URL + '/rest/v1/investors?select=id,name,short_name,stt_accounting_method,financial_year_start&is_active=eq.true', { headers: headers });
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

        // 3. IBA rates (investor_broker_accounts with brokerage_rates + charges_inclusive)
        resp = await fetch(SUPABASE_URL + '/rest/v1/investor_broker_accounts?select=investor_id,broker_id,brokerage_rates,charges_inclusive&is_active=eq.true', { headers: headers });
        var ibAccounts = await resp.json();
        wmsRefData.ibaRatesMap = {};
        ibAccounts.forEach(function(iba) {
            if (iba.brokerage_rates) {
                wmsRefData.ibaRatesMap[iba.investor_id + '|' + iba.broker_id] = {
                    rates: iba.brokerage_rates,
                    charges_inclusive: !!iba.charges_inclusive
                };
            }
        });

        // 4. Regulatory charges (active only — effective_to IS NULL)
        resp = await fetch(SUPABASE_URL + '/rest/v1/regulatory_charges_config?effective_to=is.null&select=*', { headers: headers });
        wmsRefData.regCharges = await resp.json();

        // 5. Existing tags (for autocomplete across modules)
        resp = await fetch(SUPABASE_URL + '/rest/v1/transactions?select=tags&tags=not.is.null&limit=5000', { headers: headers });
        var tagRows = await resp.json();
        var tagSet = {};
        tagRows.forEach(function(r) {
            if (Array.isArray(r.tags)) {
                r.tags.forEach(function(t) {
                    var trimmed = t.trim().toLowerCase();
                    if (trimmed && trimmed !== 'blank') tagSet[trimmed] = true;
                });
            }
        });
        wmsRefData.tags = Object.keys(tagSet).sort();

        wmsRefData.ready = true;
        console.log('WMS ref data loaded: ' + investors.length + ' investors, ' + brokers.length + ' brokers, ' +
            ibAccounts.length + ' IBA, ' + wmsRefData.regCharges.length + ' reg charges, ' + wmsRefData.tags.length + ' tags');
    } catch (e) {
        console.error('WMS ref data load error:', e);
    }
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
async function wmsFetchAllRows(table, select, orderCol) {
    orderCol = orderCol || 'symbol';
    var BATCH = 1000;
    var all = [], from = 0;
    while (true) {
        var result = await window.supabaseClient
            .from(table)
            .select(select)
            .order(orderCol, { ascending: true })
            .range(from, from + BATCH - 1);
        if (result.error) throw result.error;
        all = all.concat(result.data || []);
        if (!result.data || result.data.length < BATCH) break;
        from += BATCH;
    }
    return all;
}

/**
 * Load all CM (Cash Market) securities into wmsRefData.securitiesCm.
 * Called at app startup (background) and after CM Sync.
 * Retries up to 3 times with 3s/6s/12s backoff on network failure.
 */
async function wmsLoadSecuritiesCm(retryCount) {
    retryCount = retryCount || 0;
    try {
        var rows = await wmsFetchAllRows('securities_db',
            'id,symbol,company_name,isin,nse_symbol,bse_symbol,security_type,asset_class,sector,size,is_active,lot_size,broker_tokens',
            'isin');
        wmsRefData.securitiesCm = rows;
        wmsRefData.securitiesCmMap = {};
        rows.forEach(function(r) { wmsRefData.securitiesCmMap[r.id] = r; });
        wmsRefData.securitiesCmReady = true;
        console.log('Securities CM loaded: ' + rows.length + ' rows');
    } catch (e) {
        console.error('Securities CM load error (attempt ' + (retryCount + 1) + '):', e);
        if (retryCount < 3) {
            var delay = 3000 * Math.pow(2, retryCount); // 3s, 6s, 12s
            console.log('Retrying CM load in ' + (delay / 1000) + 's...');
            await new Promise(function(resolve) { setTimeout(resolve, delay); });
            return wmsLoadSecuritiesCm(retryCount + 1);
        }
    }
}

/**
 * Load all F&O (Futures & Options) securities into wmsRefData.securitiesNfo.
 * Called at app startup (background) and after F&O Sync.
 * Retries up to 3 times with 3s/6s/12s backoff on network failure.
 */
async function wmsLoadSecuritiesNfo(retryCount) {
    retryCount = retryCount || 0;
    try {
        var rows = await wmsFetchAllRows('securities_nfo',
            'id,symbol,instrument_name,exchange,instrument_type,underlying_symbol,expiry_date,strike_price,option_type,lot_size,is_active,broker_tokens',
            'expiry_date');
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

    // Search NFO securities (active only)
    var nfoMatches = [];
    if (wmsRefData.securitiesNfoReady) {
        var nfoAll = wmsRefData.securitiesNfo;
        for (var j = 0; j < nfoAll.length; j++) {
            var nfo = nfoAll[j];
            if (nfo.is_active === false) continue;
            if (wmsMultiTokenMatch(tokens,
                    nfo.symbol, nfo.underlying_symbol, nfo.instrument_name,
                    nfo.exchange, nfo.expiry_date,
                    nfo.strike_price ? String(nfo.strike_price) : '',
                    nfo.option_type)) {
                nfoMatches.push(nfo);
                if (nfoMatches.length >= 15) break;
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
// INCOME TYPE CHECK (Rule G.3.1)
// ============================================================================

function wmsIsIncomeType(txnType) {
    return WMS_INCOME_TYPES.indexOf(txnType) >= 0;
}

// ============================================================================
// STT ELIGIBILITY CHECK (Rule G.8.5)
// Only plain EQUITY stocks attract STT. All non-equity instruments (ETFs, MFs,
// debt, SGBs, REITs, InvITs, NCDs, etc.) are exempt from STT and stamp duty.
// ============================================================================

function wmsIsSTTEligible(securityType) {
    return (securityType || '').toUpperCase() === 'EQUITY';
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
 * Get brokerage for a transaction from IBA rates (Rule G.2.2).
 * @param {Object} ibaRatesMap  The IBA rates map
 * @param {string} investorId
 * @param {string} brokerId
 * @param {number} grossAmount  Absolute gross amount (qty × price)
 * @param {string} securityType  'EQUITY', 'ETF', 'NFO', etc.
 * @param {string} assetClass   'OPTIONS', 'FUTURES', etc. (for NFO)
 * @param {number} price        Per-unit price
 * @param {number} quantity     Signed quantity
 * @param {number} lots         Number of lots (for options flat rate)
 * @returns {number} Brokerage amount rounded to 2 decimal places
 */
function wmsGetBrokerage(ibaRatesMap, investorId, brokerId, grossAmount, securityType, assetClass, price, quantity, lots) {
    if (!brokerId) return 0;
    var ibaEntry = ibaRatesMap[investorId + '|' + brokerId];
    if (!ibaEntry) return 0;
    var rates = ibaEntry.rates;

    // Navigate the rates JSONB: equity.delivery for EQUITY/ETF, derivatives.futures/options for NFO
    var segment = null;
    if (securityType === 'NFO') {
        if (assetClass === 'OPTIONS' && rates.derivatives && rates.derivatives.options) {
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
    if (ibaEntry.charges_inclusive && price && quantity) {
        var perShare = Math.ceil(price * pct * 100) / 100;  // ROUNDUP to 2 decimal places
        calc = perShare * Math.abs(quantity);
    } else {
        calc = wmsRoundMoney(grossAmount * pct);
    }
    if (max > 0 && calc > max) calc = max;
    return wmsRoundMoney(calc);
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
    for (var i = 0; i < regCharges.length; i++) {
        var rc = regCharges[i];
        if (rc.charge_type === chargeType &&
            rc.transaction_category === txnCategory &&
            rc.transaction_type === txnType &&
            rc.exchange === exch) {
            return rc.rate_percentage || 0;
        }
    }
    // Fallback: BSE/MCX missing STT/SEBI/stamp → try NSE (national charges)
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

    // Step 2: Brokerage (Rule G.2.2)
    var shouldCalcBrokerage = preserve
        ? (row.brokerage === null || row.brokerage === undefined || row.brokerage === 0)
        : true;
    if (shouldCalcBrokerage) {
        row.brokerage = wmsGetBrokerage(ibaRatesMap, investorId, brokerId, gross,
            row.security_type, row.asset_class, row.price, row.quantity, row.lots);
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
            if (!wmsIsSTTEligible(secTypeForStt) && row.security_type !== 'NFO') {
                // Non-equity cash market instruments (ETF, MF, debt, SGB) — no STT
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
            if (!wmsIsSTTEligible(secTypeForStamp) && row.security_type !== 'NFO') {
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
        if (txnType === 'BUY') {
            row.net_amount = wmsRoundMoney(gross + row.total_charges);
        } else {
            row.net_amount = wmsRoundMoney(gross - row.total_charges);
        }
    }

    // Step 9: Trader charges (Rule G.2.9)
    var shouldCalcTrader = preserve
        ? (row.trader_charges === null || row.trader_charges === undefined)
        : true;
    if (shouldCalcTrader) {
        var traderId = row.trader_id || investorId;
        if (traderId !== investorId) {
            row.trader_charges = wmsGetBrokerage(ibaRatesMap, traderId, brokerId, gross,
                row.security_type, row.asset_class, row.price, row.quantity, row.lots);
        } else {
            row.trader_charges = 0;
        }
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
        if (!underlying && /^[A-Z&]+$/.test(p)) { underlying = p; }
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
// wmsPillFilter — Pill-based multi-select filter (Trading Portfolio / Transactions)
//
// Renders items as clickable pills inside a dropdown container.
// Click toggles selection. Search input filters visible pills.
// ESC closes dropdown and clears search. Click-outside closes.
//
// Usage:
//   var pf = wmsPillFilter(inputEl, ddEl, tagsEl, {
//       items: [{id: 'uuid', label: 'Vikash'}],
//       selectedIds: someArray,    // mutated in place
//       onChange: function() { renderTable(); },
//       pillClass: 'wms-pill'     // default
//   });
//   pf.setItems(newItems);  pf.syncStates();  pf.clearAll();
// ============================================================================

function wmsPillFilter(inputEl, ddEl, tagsEl, opts) {
    opts = opts || {};
    var items = opts.items || [];
    var selectedIds = opts.selectedIds || [];
    var onChange = opts.onChange || function() {};
    var pillClass = opts.pillClass || 'wms-pill';

    function render() {
        ddEl.innerHTML = items.map(function(item) {
            var isOn = selectedIds.indexOf(item.id) >= 0;
            return '<span class="' + pillClass + (isOn ? ' on' : '') + '" data-wms-id="' + wmsEsc(String(item.id)) + '">' +
                wmsEsc(item.label) + '</span>';
        }).join('');
        attachPillClicks();
    }

    function attachPillClicks() {
        ddEl.querySelectorAll('.' + pillClass).forEach(function(pill) {
            pill.addEventListener('click', function(e) {
                e.stopPropagation();
                var id = pill.getAttribute('data-wms-id');
                var idx = selectedIds.indexOf(id);
                if (idx >= 0) selectedIds.splice(idx, 1);
                else selectedIds.push(id);
                pill.classList.toggle('on', selectedIds.indexOf(id) >= 0);
                renderSelectedTags();
                onChange();
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
        var query = inputEl.value.toLowerCase();
        ddEl.querySelectorAll('.' + pillClass).forEach(function(pill) {
            pill.style.display = pill.textContent.toLowerCase().indexOf(query) >= 0 ? '' : 'none';
        });
    });

    // ESC closes dropdown + clears search
    inputEl.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            inputEl.value = '';
            ddEl.classList.remove('show');
            // Reset visibility of all pills
            ddEl.querySelectorAll('.' + pillClass).forEach(function(pill) {
                pill.style.display = '';
            });
            inputEl.blur();
        }
    });

    // Click-outside close
    var outsideHandler = function(e) {
        if (!e.target.closest('.filter-search-container') ||
            (!inputEl.contains(e.target) && !ddEl.contains(e.target) && !(tagsEl && tagsEl.contains(e.target)))) {
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

function wmsModal(overlayEl, opts) {
    opts = opts || {};
    var onClose = opts.onClose || function() {};

    function escHandler(e) {
        if (e.key === 'Escape' && overlayEl.classList.contains('show')) {
            e.preventDefault();
            controller.close();
        }
    }

    function clickOutsideHandler(e) {
        // Click on overlay background (not on dialog content)
        if (e.target === overlayEl) {
            controller.close();
        }
    }

    var controller = {
        open: function() {
            overlayEl.classList.add('show');
            document.addEventListener('keydown', escHandler);
            overlayEl.addEventListener('click', clickOutsideHandler);
        },
        close: function() {
            overlayEl.classList.remove('show');
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
