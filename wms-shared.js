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

        // Build indexed map for O(1) regulatory rate lookups: "chargeType|txnCategory|txnType|exchange" → rate
        wmsRefData.regChargesIndex = {};
        wmsRefData.regCharges.forEach(function(rc) {
            var key = rc.charge_type + '|' + rc.transaction_category + '|' + rc.transaction_type + '|' + rc.exchange;
            wmsRefData.regChargesIndex[key] = rc.rate_percentage || 0;
        });

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
            'id,symbol,company_name,isin,nse_symbol,bse_symbol,security_type,asset_class,sector,size,is_active,lot_size,broker_tokens,merged_into_id,merged_at',
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
// TRANSACTION SANITIZATION (Rule E.14)
// ============================================================================
// When investor ≠ trader, the investor's account is used by the trader
// (the trader is the beneficiary). The trader's actual cost is
// gross_amount ± trader_charges — NOT the market-facing net_amount stored
// in the DB (which reflects the investor's brokerage charges).
//
// This function adjusts net_amount in-place so all downstream consumers
// (avg cost, matching trades, summary cards, display) automatically use the
// trader-perspective amount.
//
// For non-BUY/SELL types (DIVIDEND, INTEREST, etc.), net_amount is unchanged.
// Original net_amount is preserved as _origNetAmount for future use (e.g. Portfolio).
//
// Call once after loading transactions from DB — before any calculations or display.
// ============================================================================

function wmsSanitizeTransactions(transactions) {
    for (var i = 0; i < transactions.length; i++) {
        var txn = transactions[i];
        var investorId = txn.investor_id || '';
        var traderId = txn.trader_id || investorId;

        // Preserve original DB net_amount
        txn._origNetAmount = txn.net_amount;

        if (traderId && traderId !== investorId) {
            var txnType = txn.transaction_type || '';

            if (txnType === 'BUY' || txnType === 'SELL') {
                // Trader's cost = gross ± trader_charges
                var gross = Math.abs(txn.gross_amount || 0);
                var traderCh = Math.abs(txn.trader_charges || 0);
                if (txnType === 'BUY') {
                    txn.net_amount = wmsRoundMoney(gross + traderCh);
                } else {
                    txn.net_amount = wmsRoundMoney(gross - traderCh);
                }
            }
            // All other types (DIVIDEND, INTEREST, etc.): net_amount unchanged
        }
    }
    return transactions;
}

// ============================================================================
// AVERAGE COST CALCULATION (Spec A1)
// Single source of truth — used by portfolio.js, trading.js, and any future module.
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

    // Step 0: identify option contracts, compute net qty AND net cost
    var optionData = {};  // fullSymbol → { netQty, netCost }

    for (i = 0; i < transactions.length; i++) {
        txn = transactions[i];
        sym = txn.symbol || '';
        shortSym = txn.short_symbol || txn.shortSymbol || txn.symbol || '';
        if (!wmsIsOptionContract(sym, shortSym)) continue;
        if (txn.ignore_for_avg_cost) continue;
        txnType = txn.transaction_type || txn.type || '';
        isIncome = WMS_INCOME_TYPES.indexOf(txnType) >= 0;
        if (isIncome) continue;

        if (!optionData[sym]) optionData[sym] = { netQty: 0, netCost: 0 };
        var netAmt = txn.net_amount !== undefined ? txn.net_amount : (txn.netAmount || 0);
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
        sym = txn.symbol || '';

        // Skip all option transactions — handled via includeSymbols above
        if (ignoreSymbols[sym] || includeSymbols[sym] !== undefined) continue;

        txnType = txn.transaction_type || txn.type || '';
        isIncome = WMS_INCOME_TYPES.indexOf(txnType) >= 0;
        // Support both snake_case (trading.js) and camelCase (portfolio.js)
        var netAmt = txn.net_amount !== undefined ? txn.net_amount : (txn.netAmount || 0);

        if (isIncome) {
            if (!txn.ignore_for_avg_cost) {
                totalCost -= Math.abs(netAmt);
            }
        } else if (txnType === 'RIGHTS_PAYMENT') {
            // Rights payment: adds cost only, does NOT change quantity
            // (the quantity was already added by RIGHTS_ENTITLEMENT)
            if (!txn.ignore_for_avg_cost) {
                totalCost += netAmt;
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
// FIFO COST CALCULATION (Spec A2)
// Matches sells against buys in chronological order (FIFO). Partially matched
// buys retain remaining qty at original per-unit cost. Average cost is then
// sum(remaining cost) / sum(remaining qty) — only considering unsquared buys.
// Income transactions are ignored (they don't participate in FIFO matching).
// ============================================================================

function wmsCalcFifoCost(transactions) {
    var buys = [];
    var totalSellQty = 0;

    for (var i = 0; i < transactions.length; i++) {
        var txn = transactions[i];
        if (WMS_INCOME_TYPES.indexOf(txn.transaction_type) >= 0) continue;

        if (txn.transaction_type === 'BUY') {
            buys.push({
                date: txn.transaction_date,
                qty: Math.abs(txn.quantity),
                netAmount: txn.net_amount || 0,
                remaining: Math.abs(txn.quantity)
            });
        } else {
            totalSellQty += Math.abs(txn.quantity);
        }
    }

    // Sort buys chronologically (FIFO = earliest first)
    buys.sort(function(a, b) { return (a.date || '').localeCompare(b.date || ''); });

    // Consume sells against earliest buys
    var sellRemaining = totalSellQty;
    for (var j = 0; j < buys.length && sellRemaining > 0; j++) {
        var matchQty = Math.min(sellRemaining, buys[j].remaining);
        buys[j].remaining -= matchQty;
        sellRemaining -= matchQty;
    }

    // Sum cost of unsquared (remaining) buy portions
    var remainingCost = 0;
    var remainingQty = 0;
    for (var k = 0; k < buys.length; k++) {
        if (buys[k].remaining <= 0) continue;
        var ppu = buys[k].qty > 0 ? buys[k].netAmount / buys[k].qty : 0;
        remainingCost += buys[k].remaining * ppu;
        remainingQty += buys[k].remaining;
    }

    var fifoCost = remainingQty > 0 ? remainingCost / remainingQty : 0;

    return {
        avgCost: wmsRoundMoney(fifoCost),
        netQuantity: remainingQty,
        totalCost: wmsRoundMoney(remainingCost)
    };
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
//   Stage 1: Fyers batch with NSE:SYMBOL-EQ
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
 *   Stage 1: Fyers batch with NSE:SYMBOL-EQ
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

    // ── Stage 1: Fyers batch with NSE:SYMBOL-EQ ──
    var respondedSymbols = {};
    if (window.fyersToken && window.fyersCall) {
        var fyersKeys = toFetch.map(function(it) { return 'NSE:' + it.shortSymbol + '-EQ'; });
        // Deduplicate
        fyersKeys = fyersKeys.filter(function(s, i) { return fyersKeys.indexOf(s) === i; });

        // Batch into chunks of 50
        for (var i = 0; i < fyersKeys.length; i += 50) {
            var chunk = fyersKeys.slice(i, i + 50);
            try {
                var data = await window.fyersCall({ action: 'quotes', symbols: chunk });
                if (data && data.d && data.d.length > 0) {
                    data.d.forEach(function(item) {
                        if (item.v && item.v.symbol) {
                            respondedSymbols[item.v.symbol] = true;
                            // Extract shortSymbol from Fyers key (NSE:SYMBOL-EQ → SYMBOL)
                            var parts = item.v.symbol.match(/^[A-Z]+:(.+)-[A-Z]+$/);
                            var ss = parts ? parts[1] : null;
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
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
                    },
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
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
    }).then(function(resp) { return resp.json(); }).then(function(rows) {
        if (!rows || rows.length === 0) return;
        var bt = rows[0].broker_tokens || {};
        if (!bt.fyers) bt.fyers = {};
        if (fyersSymbol.indexOf('NSE:') === 0) bt.fyers.nse_symbol = fyersSymbol;
        else if (fyersSymbol.indexOf('BSE:') === 0) bt.fyers.bse_symbol = fyersSymbol;
        return fetch(SUPABASE_URL + '/rest/v1/securities_db?id=eq.' + securityId, {
            method: 'PATCH',
            headers: {
                'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                'Content-Type': 'application/json', 'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ broker_tokens: bt })
        });
    }).catch(function(err) { console.warn('wmsUpdateBrokerToken:', err.message); });
}

// ============================================================================
// SHARED AUTO-REFRESH (Rule D.12.11)
// Centralised market-hours check and per-tab auto-refresh timer management.
// Any tab can register with wmsStartAutoRefresh(id, opts) and prices will
// be re-fetched at the given interval while the market is open.
// ============================================================================

var wmsAutoRefreshTimers = {};  // id → intervalId

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
 * wmsStartAutoRefresh — start periodic price refresh for a tab.
 * @param {string} id        — unique identifier (e.g. 'portfolio', 'fno', 'watchlist')
 * @param {Object} opts
 *   @param {number}   [opts.interval=10000] — ms between refreshes
 *   @param {Function} opts.fetchFn          — async fn(forceRefresh) to fetch prices
 *   @param {Function} [opts.renderFn]       — called after fetch to re-render
 *   @param {Function} [opts.isActiveFn]     — return false to skip this cycle
 *   @param {Function} [opts.onMarketClose]  — called when market is detected closed
 */
function wmsStartAutoRefresh(id, opts) {
    wmsStopAutoRefresh(id);
    var interval = opts.interval || 10000;
    wmsAutoRefreshTimers[id] = setInterval(async function() {
        if (document.hidden) return;
        if (!wmsIsMarketHours()) {
            wmsStopAutoRefresh(id);
            if (opts.onMarketClose) opts.onMarketClose();
            return;
        }
        if (opts.isActiveFn && !opts.isActiveFn()) return;
        await opts.fetchFn(true);
        if (opts.renderFn) opts.renderFn();
    }, interval);
}

/**
 * wmsStopAutoRefresh — stop the timer for a given tab.
 */
function wmsStopAutoRefresh(id) {
    if (wmsAutoRefreshTimers[id]) {
        clearInterval(wmsAutoRefreshTimers[id]);
        delete wmsAutoRefreshTimers[id];
    }
}

// Pause all auto-refresh when tab is hidden, resume when visible
document.addEventListener('visibilitychange', function() {
    // Note: each tab's fetchFn already checks document.hidden,
    // but we also let individual modules hook into this via their own listeners.
});

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
    var shouldCalcTrader = row._trdChgOverride ? false : (preserve
        ? (row.trader_charges === null || row.trader_charges === undefined)
        : true);
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
        resetSearch();
        ddEl.classList.remove('show');
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
                resetSearch();
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
        resetSearch();
        ddEl.classList.remove('show');
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
                resetSearch();
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
    // Non-NFO → Equity
    if (txn.security_type !== 'NFO') return 'Equity';
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

    // Fallback: parse from symbol string
    var suffix = txn.symbol || '';
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
    calBtn.title = 'Pick from calendar';
    calBtn.textContent = '\uD83D\uDCC5'; // 📅
    var calInput = document.createElement('input');
    calInput.type = 'date';
    calInput.className = 'wms-di-cal-hidden';

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
 * wmsDateFilter(containerEl, opts)
 * Date range filter with 3 controls:
 *   1) Period dropdown — Last 7 days, 30 days, 90 days, ALL
 *   2) FY dropdown — populated from transaction dates; label "FY26 (Mar26)"
 *   3) Custom button — opens popover with two wmsDateInput widgets
 *
 * Selecting any one deselects the others (mutually exclusive).
 *
 * @param {HTMLElement} containerEl
 * @param {Object} opts
 *   - default: 'last7'|'last30'|'last90'|'all'|'currentFY' (default: 'all')
 *   - onChange: function(from, to)
 *   - fyStartMonth: 1-12 (default: 4)
 *   - transactions: Array — transaction records with transaction_date field
 * @returns controller: getRange(), setPreset(), getPreset(), destroy()
 * ──────────────────────────────────────────────────────────────────────────── */
var wmsDateFilter = function(containerEl, opts) {
    opts = opts || {};
    var defaultPreset = opts.default || 'all';
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

    var getPresetRange = function(preset) {
        var today = new Date();
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
        '<option value="last7">Last 7 days</option>' +
        '<option value="last30">Last 30 days</option>' +
        '<option value="last90">Last 90 days</option>' +
        '<option value="all" selected>All</option>';

    periodSelect.addEventListener('change', function() {
        currentPreset = periodSelect.value;
        fySelect.value = 'fy_all';
        customBtn.classList.remove('active');
        closePopover();
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

    // ────── Apply default preset ──────
    if (defaultPreset === 'last7' || defaultPreset === 'last30' || defaultPreset === 'last90' || defaultPreset === 'all') {
        periodSelect.value = defaultPreset;
        currentPreset = defaultPreset;
    } else if (defaultPreset === 'currentFY' && fyList.length > 0) {
        fySelect.value = fyList[0].value;
        currentPreset = fyList[0].value;
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
            if (preset === 'last7' || preset === 'last30' || preset === 'last90' || preset === 'all') {
                periodSelect.value = preset;
                fySelect.value = 'fy_all';
                customBtn.classList.remove('active');
            } else if (preset.indexOf('fy_') === 0) {
                fySelect.value = preset;
                periodSelect.value = 'all';
                customBtn.classList.remove('active');
            }
            closePopover();
            fireChange();
        },
        getPreset: function() { return currentPreset; },
        destroy: function() { closePopover(); containerEl.innerHTML = ''; }
    };
};
