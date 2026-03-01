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

// ============================================================================
// MONEY ROUNDING
// Round to 2 decimal places. Used across charge calculations, DB inserts, etc.
// ============================================================================

function wmsRoundMoney(v) {
    return Math.round((v || 0) * 100) / 100;
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
