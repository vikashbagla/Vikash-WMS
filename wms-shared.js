// ============================================================================
// WMS SHARED MODULE — Canonical implementations used across the entire app.
// Any function here MUST NOT be duplicated elsewhere.
// See WMS-CODE-CONSOLIDATION.md for the full audit and rules.
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
    ready: false         // True after initial load completes
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
