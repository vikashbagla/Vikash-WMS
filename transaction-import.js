// ============================================================================
// WMS Transaction Import - Excel + Contract Note Import
// ============================================================================

// MUST be first: set up globals for CN parser plugins BEFORE anything else
window.CN_PARSERS = window.CN_PARSERS || {};
window.CN_UTILS = window.CN_UTILS || {};

// Use var for module-level state (project convention — avoids redeclaration errors on reload)
var parsedTransactions = [];
var investorCache = {};        // { lowerName/lowerShortName → uuid }
var brokerCache = {};          // { lowerName/lowerBrokerCode → uuid }
var investorObjMap = {};       // { uuid → { id, name, short_name, stt_accounting_method, financial_year_start } }
var brokerObjMap = {};         // { uuid → { id, name, broker_code } }
var ibaRatesMap = {};          // { "investorId|brokerId" → brokerage_rates JSONB }
var regulatoryCharges = [];    // Array of regulatory_charges_config rows (active rates)

// Excel import state
var excelConfirmedRows = [];   // Ready to import (symbol resolved, charges calculated)
var excelFlaggedRows = [];     // Need user review (symbol ambiguous, multiple matches)
var excelErrorRows = [];       // Skipped (validation failures)

// CN import state
var cnAccounts = [];           // {id, investor_id, broker_id, investor_short_name, broker_code, broker_name, cn_password, cn_parser_template}
var cnParsedRows = [];         // After parsing + grouping
var cnNewRows = [];            // Will be inserted
var cnUpdateRows = [];         // Will update existing
var cnErrorRows = [];          // Could not match security
var cnSelectedAccount = null;  // Currently selected account object
var cnTradeDate = null;        // Trade date from parsed CN (YYYY-MM-DD)
var cnCnNumber = null;         // Contract note number from parsed CN
var existingTags = [];         // Distinct tags from transactions table for pill suggestions

// ============================================================================
// Initialization
// ============================================================================

var _tiInitDone = false;  // Guard against multiple init calls (tab re-navigation)
var _refDataReady = false; // True once loadReferenceData() has completed at least once

function initTransactionImport() {
    if (_tiInitDone) {
        // Already initialized — just reload reference data (don't re-register listeners)
        loadReferenceData();
        loadCnAccounts();
        return;
    }
    _tiInitDone = true;

    // Excel upload handlers
    var uploadArea = document.getElementById('uploadArea');
    var fileInput = document.getElementById('fileInput');
    uploadArea.addEventListener('click', function() { fileInput.click(); });
    fileInput.addEventListener('change', handleFileSelect);
    var excelChooseBtn = document.getElementById('excelChooseFileBtn');
    if (excelChooseBtn) excelChooseBtn.addEventListener('click', function() { fileInput.click(); });
    uploadArea.addEventListener('dragover', function(e) { e.preventDefault(); uploadArea.classList.add('dragover'); });
    uploadArea.addEventListener('dragleave', function() { uploadArea.classList.remove('dragover'); });
    uploadArea.addEventListener('drop', function(e) { e.preventDefault(); uploadArea.classList.remove('dragover'); if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]); });

    // CN account selector
    var cnAccountSelect = document.getElementById('cnAccountSelect');
    cnAccountSelect.addEventListener('change', onCnAccountSelect);

    // CN upload handlers
    var cnUploadArea = document.getElementById('cnUploadArea');
    var cnFileInput = document.getElementById('cnFileInput');
    cnUploadArea.addEventListener('click', function() { if (!cnUploadArea.classList.contains('disabled')) cnFileInput.click(); });
    cnFileInput.addEventListener('change', handleCnFileSelect);
    cnUploadArea.addEventListener('dragover', function(e) { e.preventDefault(); if (!cnUploadArea.classList.contains('disabled')) cnUploadArea.classList.add('dragover'); });
    cnUploadArea.addEventListener('dragleave', function() { cnUploadArea.classList.remove('dragover'); });
    cnUploadArea.addEventListener('drop', function(e) { e.preventDefault(); cnUploadArea.classList.remove('dragover'); if (!cnUploadArea.classList.contains('disabled') && e.dataTransfer.files.length > 0) { cnFileInput.files = e.dataTransfer.files; handleCnFileSelect({ target: cnFileInput }); } });

    // CN Choose File button
    var cnChooseFileBtn = document.getElementById('cnChooseFileBtn');
    if (cnChooseFileBtn) cnChooseFileBtn.addEventListener('click', function() { cnFileInput.click(); });

    // Excel preview modal — ESC key and overlay click to close
    var excelOverlay = document.getElementById('excelPreviewOverlay');
    if (excelOverlay) {
        excelOverlay.addEventListener('click', function(e) {
            if (e.target === excelOverlay) window.cancelImport();
        });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                // Close charges popover first if open, then main modal
                var cpOverlay = document.getElementById('chargesPopoverOverlay');
                if (cpOverlay && cpOverlay.classList.contains('active')) {
                    window.closeChargesPopover();
                } else if (excelOverlay.classList.contains('active')) {
                    window.cancelImport();
                }
            }
        });
    }

    loadReferenceData();
    loadCnAccounts();
    loadExistingTags();
}

document.addEventListener('DOMContentLoaded', initTransactionImport);

// No mode switching needed — both boxes are always visible on the page

// ============================================================================
// Reference Data
// ============================================================================

async function loadReferenceData() {
    try {
        // Load investors — cache by name AND short_name (case-insensitive) per rule F.1.2
        var resp = await fetch(SUPABASE_URL + '/rest/v1/investors?select=id,name,short_name,stt_accounting_method,financial_year_start&is_active=eq.true', { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY } });
        var investors = await resp.json();
        investorCache = {};
        investorObjMap = {};
        investors.forEach(function(inv) {
            investorObjMap[inv.id] = inv;
            if (inv.name) investorCache[inv.name.toLowerCase()] = inv.id;
            if (inv.short_name) investorCache[inv.short_name.toLowerCase()] = inv.id;
        });

        // Load brokers — cache by name AND broker_code (case-insensitive) per rule F.1.4
        resp = await fetch(SUPABASE_URL + '/rest/v1/brokers?select=id,name,broker_code&is_active=eq.true', { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY } });
        var brokers = await resp.json();
        brokerCache = {};
        brokerObjMap = {};
        brokers.forEach(function(brk) {
            brokerObjMap[brk.id] = brk;
            if (brk.name) brokerCache[brk.name.toLowerCase()] = brk.id;
            if (brk.broker_code) brokerCache[brk.broker_code.toLowerCase()] = brk.id;
        });

        // Load investor_broker_accounts with brokerage_rates + charges_inclusive for charge auto-calc (rule F.2.6)
        resp = await fetch(SUPABASE_URL + '/rest/v1/investor_broker_accounts?select=investor_id,broker_id,brokerage_rates,charges_inclusive&is_active=eq.true', { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY } });
        var ibAccounts = await resp.json();
        ibaRatesMap = {};
        ibAccounts.forEach(function(iba) {
            if (iba.brokerage_rates) {
                ibaRatesMap[iba.investor_id + '|' + iba.broker_id] = {
                    rates: iba.brokerage_rates,
                    charges_inclusive: !!iba.charges_inclusive
                };
            }
        });

        // Load regulatory_charges_config — active rates (effective_to IS NULL) for STT/other charge calc
        resp = await fetch(SUPABASE_URL + '/rest/v1/regulatory_charges_config?effective_to=is.null&select=*', { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY } });
        regulatoryCharges = await resp.json();

        _refDataReady = true;
        console.log('Reference data loaded: ' + investors.length + ' investors, ' + brokers.length + ' brokers, ' + ibAccounts.length + ' IBA rates, ' + regulatoryCharges.length + ' regulatory configs');
    } catch (e) {
        console.error('Error loading reference data:', e);
    }
}

async function loadCnAccounts() {
    try {
        // Load investor_broker_accounts joined with investor short_name and broker cn_parser_template
        var resp = await fetch(SUPABASE_URL + '/rest/v1/investor_broker_accounts?select=id,investor_id,broker_id,cn_password,investors(short_name),brokers(name,broker_code,cn_parser_template)&is_active=eq.true', {
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
        });
        var accounts = await resp.json();
        cnAccounts = [];
        var select = document.getElementById('cnAccountSelect');
        select.innerHTML = '<option value="">-- Select Account --</option>';

        accounts.forEach(function(acc) {
            // Only show accounts where broker has a parser template
            if (!acc.brokers || !acc.brokers.cn_parser_template) return;

            // Skip accounts with missing investor or broker data
            var investorName = acc.investors ? acc.investors.short_name : null;
            var brokerCode = acc.brokers ? acc.brokers.broker_code : null;
            var brokerName = acc.brokers ? acc.brokers.name : null;
            if (!investorName || (!brokerCode && !brokerName)) return;

            var obj = {
                id: String(acc.id),  // Ensure string for comparison with select.value
                investor_id: acc.investor_id,
                broker_id: acc.broker_id,
                investor_short_name: investorName,
                broker_code: brokerCode || '?',
                broker_name: brokerName || '?',
                cn_password: acc.cn_password || null,
                cn_parser_template: acc.brokers.cn_parser_template
            };
            cnAccounts.push(obj);

            // Display: "Veins @ Fyers" (title-case the broker_code)
            var displayCode = obj.broker_code !== '?' ? obj.broker_code : obj.broker_name;
            var brokerDisplay = displayCode.charAt(0).toUpperCase() + displayCode.slice(1).toLowerCase();
            var opt = document.createElement('option');
            opt.value = obj.id;
            opt.textContent = obj.investor_short_name + ' @ ' + brokerDisplay;
            select.appendChild(opt);
        });

        if (cnAccounts.length === 0) {
            document.getElementById('cnAccountStatus').textContent = 'No broker accounts with CN parser support found. Add a broker with cn_parser_template in Master Data.';
            document.getElementById('cnAccountStatus').className = 'cn-status error';
        }
    } catch (e) {
        console.error('Error loading CN accounts:', e);
        document.getElementById('cnAccountStatus').textContent = 'Error loading accounts: ' + e.message;
        document.getElementById('cnAccountStatus').className = 'cn-status error';
    }
}


// Load distinct tags from the transactions table for pill suggestions
async function loadExistingTags() {
    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions?select=tags&tags=not.is.null&limit=5000', {
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
        });
        if (!resp.ok) return;
        var rows = await resp.json();
        var tagSet = {};
        rows.forEach(function(r) {
            if (Array.isArray(r.tags)) {
                r.tags.forEach(function(t) {
                    var trimmed = t.trim().toLowerCase();
                    if (trimmed && trimmed !== 'blank') tagSet[trimmed] = true;
                });
            }
        });
        existingTags = Object.keys(tagSet).sort();
        console.log('Loaded ' + existingTags.length + ' existing tag(s): ' + existingTags.join(', '));
    } catch (e) {
        console.error('Error loading existing tags:', e);
    }
}

// ============================================================================
// Excel Import Helpers (Phase 1)
// ============================================================================

// Case-insensitive investor lookup by name or short_name (rule F.1.2)
// Falls back to "starts with" match if exact match fails (e.g. "Arti" → "Arti Jain")
function matchInvestor(input) {
    if (!input) return null;
    var key = String(input).trim().toLowerCase();
    if (!key) return null;
    var id = investorCache[key];
    if (id) return { id: id, name: investorObjMap[id] ? investorObjMap[id].name : input };

    // Fallback: find cache keys that start with the input (single match only)
    var partialMatches = [];
    var cacheKeys = Object.keys(investorCache);
    for (var i = 0; i < cacheKeys.length; i++) {
        if (cacheKeys[i].indexOf(key) === 0) {
            var mid = investorCache[cacheKeys[i]];
            if (partialMatches.indexOf(mid) < 0) partialMatches.push(mid);
        }
    }
    if (partialMatches.length === 1) {
        id = partialMatches[0];
        return { id: id, name: investorObjMap[id] ? investorObjMap[id].name : input };
    }
    return null;
}

// Case-insensitive broker lookup by name or broker_code (rule F.1.4)
function matchBroker(input) {
    if (!input) return null;
    var key = String(input).trim().toLowerCase();
    if (!key) return null;
    var id = brokerCache[key];
    if (!id) return null;
    return { id: id, name: brokerObjMap[id] ? brokerObjMap[id].name : input };
}

// Parse date from various formats → YYYY-MM-DD (rule F.1.5)
// Helper: format a Date object as YYYY-MM-DD using LOCAL timezone (avoids UTC off-by-1)
function dateToLocalISO(d) {
    var yyyy = d.getFullYear();
    var mm = ('0' + (d.getMonth() + 1)).slice(-2);
    var dd = ('0' + d.getDate()).slice(-2);
    return yyyy + '-' + mm + '-' + dd;
}

function excelDateToISO(dateValue) {
    if (!dateValue && dateValue !== 0) return { error: 'Date is required' };

    // Already a Date object (SheetJS with cellDates:true)
    if (dateValue instanceof Date) {
        if (isNaN(dateValue.getTime())) return { error: 'Invalid date object' };
        return { date: dateToLocalISO(dateValue) };
    }

    // Excel serial number (numeric)
    if (typeof dateValue === 'number') {
        var excelEpoch = new Date(1899, 11, 30);
        var d = new Date(excelEpoch.getTime() + dateValue * 86400000);
        if (isNaN(d.getTime())) return { error: 'Invalid Excel serial date: ' + dateValue };
        return { date: dateToLocalISO(d) };
    }

    // String formats
    if (typeof dateValue === 'string') {
        var trimmed = dateValue.trim();

        // DD-MM-YYYY or DD/MM/YYYY
        var ddmmyyyy = trimmed.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
        if (ddmmyyyy) {
            var day = parseInt(ddmmyyyy[1]);
            var month = parseInt(ddmmyyyy[2]);
            var year = parseInt(ddmmyyyy[3]);
            var constructed = new Date(year, month - 1, day);
            if (isNaN(constructed.getTime())) return { error: 'Invalid date: ' + trimmed };
            return { date: dateToLocalISO(constructed) };
        }

        // YYYY-MM-DD (ISO)
        if (trimmed.match(/^\d{4}-\d{1,2}-\d{1,2}/)) {
            return { date: trimmed.split('T')[0] };
        }

        // Try as numeric string (Excel serial)
        var days = parseFloat(trimmed);
        if (!isNaN(days) && days > 1000) {
            var d2 = new Date(new Date(1899, 11, 30).getTime() + days * 86400000);
            if (!isNaN(d2.getTime())) return { date: dateToLocalISO(d2) };
        }

        return { error: 'Unrecognized date format: ' + trimmed };
    }

    return { error: 'Invalid date type: ' + typeof dateValue };
}

// Parse NFO symbol format: UNDERLYING{YY}{MON}{STRIKE}{CE|PE} or UNDERLYING{YY}{MON}FUT
// e.g. MANAPPURAM26MAR305PE → { underlying: 'MANAPPURAM', expiryStr: '26MAR', strikePrice: 305, optionType: 'PE' }
// e.g. NIFTY26FEBFUT → { underlying: 'NIFTY', expiryStr: '26FEB', strikePrice: null, optionType: null }
var NFO_MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
function parseNfoSymbol(sym) {
    if (!sym) return null;
    sym = sym.toUpperCase();

    // Try options pattern: {UNDERLYING}{YY}{MON}{STRIKE}{CE|PE}
    var optMatch = sym.match(/^(.+?)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d+(?:\.\d+)?)(CE|PE)$/);
    if (optMatch) {
        var monIdx = NFO_MONTHS.indexOf(optMatch[3]);
        var yr = 2000 + parseInt(optMatch[2]);
        return {
            underlying: optMatch[1],
            expiryStr: optMatch[2] + optMatch[3],
            expiryDate: yr + '-' + String(monIdx + 1).padStart(2, '0') + '-28',  // approximate last Thursday
            strikePrice: parseFloat(optMatch[4]),
            optionType: optMatch[5]
        };
    }

    // Try futures pattern: {UNDERLYING}{YY}{MON}FUT
    var futMatch = sym.match(/^(.+?)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)FUT$/);
    if (futMatch) {
        var monIdx2 = NFO_MONTHS.indexOf(futMatch[3]);
        var yr2 = 2000 + parseInt(futMatch[2]);
        return {
            underlying: futMatch[1],
            expiryStr: futMatch[2] + futMatch[3],
            expiryDate: yr2 + '-' + String(monIdx2 + 1).padStart(2, '0') + '-28',
            strikePrice: null,
            optionType: null
        };
    }

    return null;  // Not an NFO symbol
}

// Income type check (rule F.4.1)
var INCOME_TYPES = ['DIVIDEND', 'INTEREST', 'OTHER_INCOME', 'CAPITAL_REDUCTION'];
function isIncomeType(txnType) {
    return INCOME_TYPES.indexOf(txnType) >= 0;
}

// Get brokerage rate for investor-broker combo (delivery assumed per rule F.2.6)
function getBrokerageForRow(investorId, brokerId, grossAmount, securityType, assetClass, price, quantity, lots) {
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

    // flat rate (options) — flat × |lots|, capped at max (max 0 = no cap)
    if (segment.flat !== undefined) {
        var absLots = Math.abs(lots || 0) || 1;  // fallback to 1 lot if not available
        var flatCalc = segment.flat * absLots;
        var flatMax = segment.max || 0;
        if (flatMax > 0 && flatCalc > flatMax) flatCalc = flatMax;
        return Math.round(flatCalc * 100) / 100;
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
        calc = Math.round(grossAmount * pct * 100) / 100;
    }
    if (max > 0 && calc > max) calc = max;
    return Math.round(calc * 100) / 100;
}

// Check if an IBA has charges_inclusive flag set
function isChargesInclusive(investorId, brokerId) {
    var ibaEntry = ibaRatesMap[investorId + '|' + brokerId];
    return ibaEntry ? ibaEntry.charges_inclusive : false;
}

// Get regulatory charge rate from config (rule F.2.3, F.3.2)
function getRegChargeRate(chargeType, txnCategory, txnType, exchange) {
    for (var i = 0; i < regulatoryCharges.length; i++) {
        var rc = regulatoryCharges[i];
        if (rc.charge_type === chargeType &&
            rc.transaction_category === txnCategory &&
            rc.transaction_type === txnType &&
            rc.exchange === (exchange || 'NSE')) {
            return rc.rate_percentage || 0;
        }
    }
    return 0;
}

// Auto-calculate charges for a row (rules F.2.1–F.2.7, F.3.2, F.4.2)
function autoCalcCharges(row) {
    var gross = row.gross_amount || 0;
    var txnCat = 'EQUITY_DELIVERY';
    if (row.security_type === 'NFO') {
        // Determine futures vs options from symbol pattern (CE/PE suffix = options)
        var symUp = (row.symbol || '').toUpperCase();
        if (symUp.match(/(CE|PE)$/) || (row.asset_class && row.asset_class === 'OPTIONS')) {
            txnCat = 'EQUITY_OPTIONS';
        } else {
            txnCat = 'EQUITY_FUTURES';
        }
    }
    var exchange = (row.exchange === 'NFO' || !row.exchange) ? 'NSE' : row.exchange;

    // Income types: all charges → tds, zero out charge fields (rule F.4.2)
    if (isIncomeType(row.transaction_type)) {
        var incomeTds = (row.total_charges || 0) + (row.trader_charges || 0);
        // If both were provided, sum them; if only one, use that
        if (row.tds && row.tds > 0) incomeTds = row.tds; // explicit tds takes priority
        row.tds = roundMoney(incomeTds);
        row.brokerage = 0;
        row.stt = 0;
        row.gst = 0;
        row.other_charges = 0;
        row.total_charges = row.tds;
        row.trader_charges = 0;
        row.net_amount = Math.round((gross - row.tds) * 100) / 100;
        return;
    }

    // Check charges_inclusive flag
    var inclusive = isChargesInclusive(row.investor_id, row.broker_id);

    // 1. Brokerage (rule F.2.6)
    if (row.brokerage === null || row.brokerage === undefined || row.brokerage === 0) {
        row.brokerage = getBrokerageForRow(row.investor_id, row.broker_id, gross, row.security_type, row.asset_class, row.price, row.quantity, row.lots);
    }

    if (inclusive) {
        // charges_inclusive: brokerage IS all-inclusive (covers STT, exchange, GST, everything)
        row.stt = 0;
        row.other_charges = 0;
        row.gst = 0;
        // Only set total_charges if user didn't provide one
        if (row.total_charges === null || row.total_charges === undefined) {
            row.total_charges = row.brokerage;
        }
    } else {
        // 2. STT (rule F.2.3)
        // Equity delivery: rounded UP to nearest whole number
        // F&O: rounded to 2 decimal places (not rounded up)
        var sttRate = getRegChargeRate('STT', txnCat, row.transaction_type, exchange);
        if (row.stt === null || row.stt === undefined || row.stt === 0) {
            if (sttRate > 0) {
                var sttRaw = gross * (sttRate / 100);
                if (txnCat === 'EQUITY_DELIVERY') {
                    row.stt = Math.ceil(sttRaw);  // Round UP to whole number for equity delivery
                } else {
                    row.stt = Math.round(sttRaw * 100) / 100;  // 2 decimal places for F&O
                }
            } else {
                row.stt = 0;
            }
        }

        // 3. Individual regulatory charges (exchange, SEBI, stamp duty, IPFT)
        var exchRate = getRegChargeRate('EXCHANGE_CHARGES', txnCat, row.transaction_type, exchange);
        var sebiRate = getRegChargeRate('SEBI_CHARGES', txnCat, row.transaction_type, exchange);
        var stampRate = getRegChargeRate('STAMP_DUTY', txnCat, row.transaction_type, exchange);
        var ipftRate = getRegChargeRate('IPFT', txnCat, row.transaction_type, exchange);

        // Store individual sub-components for the breakdown popover
        if (!row._exchange_charges && row._exchange_charges !== 0) {
            row._exchange_charges = Math.round(gross * (exchRate / 100) * 100) / 100;
        }
        if (!row._sebi_charges && row._sebi_charges !== 0) {
            row._sebi_charges = Math.round(gross * (sebiRate / 100) * 100) / 100;
        }
        if (!row._stamp_duty && row._stamp_duty !== 0) {
            row._stamp_duty = Math.round(gross * (stampRate / 100) * 100) / 100;
        }
        if (!row._ipft && row._ipft !== 0) {
            row._ipft = Math.round(gross * (ipftRate / 100) * 100) / 100;
        }

        if (row.other_charges === null || row.other_charges === undefined || row.other_charges === 0) {
            row.other_charges = Math.round((row._exchange_charges + row._sebi_charges + row._stamp_duty + (row._ipft || 0)) * 100) / 100;
        }

        // 4. GST — 18% on (brokerage + exchange charges + SEBI charges) (per Fyers/broker standard)
        if (row.gst === null || row.gst === undefined || row.gst === 0) {
            row.gst = Math.round((row.brokerage + row._exchange_charges + row._sebi_charges) * 0.18 * 100) / 100;
        }

        // 5. total_charges = brokerage + stt + other_charges + gst (rule F.2.4)
        if (row.total_charges === null || row.total_charges === undefined || row.total_charges === 0) {
            row.total_charges = Math.round((row.brokerage + row.stt + row.other_charges + row.gst) * 100) / 100;
        }
    }

    // 6. net_amount: preserve user-entered value if provided (irrespective of other fields), otherwise calculate (rule F.2.2)
    if (row._netOverride) {
        // Already marked as user-entered — keep it
    } else if (row.transaction_type === 'BUY') {
        row.net_amount = Math.round((gross + row.total_charges) * 100) / 100;
    } else {
        row.net_amount = Math.round((gross - row.total_charges) * 100) / 100;
    }

    // 7. trader_charges (rule F.2.5)
    // When investor = trader, trader_charges = 0 (no separate trader charges)
    if (row.trader_charges === null || row.trader_charges === undefined) {
        if (!row.trader_id || row.trader_id === row.investor_id) {
            row.trader_charges = 0;
        } else {
            // Different trader — calculate from trader's broker rates
            row.trader_charges = getBrokerageForRow(row.trader_id, row.broker_id, gross, row.security_type, row.asset_class, row.price, row.quantity, row.lots);
        }
    }

    // 8. Store rate basis info for breakdown popover display
    row._chargesBasis = {};
    var ibaEntry = ibaRatesMap[(row.investor_id || '') + '|' + (row.broker_id || '')];
    if (ibaEntry) {
        var rates = ibaEntry.rates || {};
        var segment = null;
        if (row.security_type === 'NFO') {
            if (row.asset_class === 'OPTIONS' && rates.derivatives && rates.derivatives.options) {
                segment = rates.derivatives.options;
            } else {
                segment = rates.derivatives ? rates.derivatives.futures : null;
            }
        } else {
            segment = rates.equity ? rates.equity.delivery : null;
        }
        if (segment) {
            if (segment.flat !== undefined) {
                var basisStr = 'Flat ₹' + segment.flat + '/lot × ' + Math.abs(row.lots || 1) + ' lots';
                if (segment.max > 0) basisStr += ' (max ₹' + segment.max + ')';
                row._chargesBasis.brokerage = basisStr;
            } else {
                var pctDisplay = ((segment.pct || 0) * 100).toFixed(2) + '%';
                row._chargesBasis.brokerage = pctDisplay + ' of price';
                if (segment.max > 0) row._chargesBasis.brokerage += ' (max ₹' + segment.max + ')';
                if (inclusive) row._chargesBasis.brokerage += ' [inclusive]';
            }
        }
    }
    if (!inclusive) {
        var sttRoundLabel = (txnCat === 'EQUITY_DELIVERY') ? ' (rounded up)' : '';
        row._chargesBasis.stt = (typeof sttRate !== 'undefined' && sttRate > 0) ? sttRate + '% of gross' + sttRoundLabel : 'N/A';
        row._chargesBasis._exchange_charges = (typeof exchRate !== 'undefined' && exchRate > 0) ? exchRate + '% of gross' : 'N/A';
        row._chargesBasis._sebi_charges = (typeof sebiRate !== 'undefined' && sebiRate > 0) ? sebiRate + '% of gross' : 'N/A';
        row._chargesBasis._stamp_duty = (typeof stampRate !== 'undefined' && stampRate > 0) ? stampRate + '% of gross' : 'N/A';
        row._chargesBasis._ipft = (typeof ipftRate !== 'undefined' && ipftRate > 0) ? ipftRate + '% of gross (IPFT)' : 'N/A';
        row._chargesBasis.gst = '18% on (brokerage + exchange + SEBI)';
    } else {
        row._chargesBasis.stt = 'Included in brokerage';
        row._chargesBasis._exchange_charges = 'Included in brokerage';
        row._chargesBasis._sebi_charges = 'Included in brokerage';
        row._chargesBasis._stamp_duty = 'Included in brokerage';
        row._chargesBasis._ipft = 'Included in brokerage';
        row._chargesBasis.gst = 'Included in brokerage';
    }
}

// ============================================================================
// CN Account Selection
// ============================================================================

function onCnAccountSelect() {
    var select = document.getElementById('cnAccountSelect');
    var accountId = select.value;
    var statusEl = document.getElementById('cnAccountStatus');
    var pwField = document.getElementById('cnPasswordField');
    var cnUploadArea = document.getElementById('cnUploadArea');
    var cnChooseBtn = document.getElementById('cnChooseFileBtn');

    console.log('onCnAccountSelect called, accountId:', accountId, 'cnAccounts:', cnAccounts.length);

    if (!accountId) {
        cnSelectedAccount = null;
        pwField.style.display = 'none';
        cnUploadArea.classList.add('disabled');
        if (cnChooseBtn) cnChooseBtn.disabled = true;
        statusEl.textContent = '';
        return;
    }

    // Use loose equality (==) to handle number vs string mismatch
    cnSelectedAccount = cnAccounts.find(function(a) { return String(a.id) == String(accountId); });
    if (!cnSelectedAccount) {
        console.error('Account not found! accountId:', accountId, 'available ids:', cnAccounts.map(function(a) { return a.id; }));
        statusEl.textContent = 'Error: Account not found. Please reload the page.';
        statusEl.className = 'cn-status error';
        return;
    }

    console.log('Selected account:', cnSelectedAccount.investor_short_name, '@', cnSelectedAccount.broker_code);

    // Check if password exists
    if (cnSelectedAccount.cn_password) {
        pwField.style.display = 'none';
        statusEl.textContent = 'Password saved. Ready to upload.';
        statusEl.className = 'cn-status success';
    } else {
        pwField.style.display = '';
        document.getElementById('cnPassword').value = '';
        statusEl.textContent = 'Enter the contract note password. It will be saved for future use.';
        statusEl.className = 'cn-status';
    }

    // Enable upload area and button
    cnUploadArea.classList.remove('disabled');
    if (cnChooseBtn) cnChooseBtn.disabled = false;

    // Reset preview
    document.getElementById('cnPreviewSection').classList.remove('active');
}

// ============================================================================
// CN File Handling
// ============================================================================

function handleCnFileSelect(event) {
    var file = event.target.files[0];
    if (!file) return;
    if (!file.name.match(/\.pdf$/i)) {
        tiAlert('error', 'Please upload a PDF file.');
        return;
    }
    if (!cnSelectedAccount) {
        tiAlert('error', 'Please select an account first.');
        return;
    }

    // Get password
    var password = cnSelectedAccount.cn_password || document.getElementById('cnPassword').value.trim();
    if (!password) {
        tiAlert('error', 'Please enter the contract note password.');
        return;
    }

    parseCnPdf(file, password);
}

async function parseCnPdf(file, password) {
    var statusEl = document.getElementById('cnParseStatus');
    statusEl.textContent = 'Reading PDF...';
    statusEl.className = 'cn-status';
    tiLoading(true, 'Parsing contract note...');

    try {
        var arrayBuffer = await file.arrayBuffer();

        // Load PDF with pdf.js
        var loadingTask = pdfjsLib.getDocument({ data: arrayBuffer, password: password });
        var pdf;
        try {
            pdf = await loadingTask.promise;
        } catch (pdfErr) {
            if (pdfErr.name === 'PasswordException') {
                tiLoading(false);
                statusEl.textContent = 'Incorrect password. Please check and try again.';
                statusEl.className = 'cn-status error';
                // Clear saved password if it was wrong
                if (cnSelectedAccount.cn_password) {
                    cnSelectedAccount.cn_password = null;
                    document.getElementById('cnPasswordField').style.display = '';
                    document.getElementById('cnAccountStatus').textContent = 'Saved password was incorrect. Please enter the correct password.';
                    document.getElementById('cnAccountStatus').className = 'cn-status error';
                }
                return;
            }
            throw pdfErr;
        }

        // Save password if not already saved
        if (!cnSelectedAccount.cn_password && password) {
            await saveCnPassword(cnSelectedAccount.id, password);
            cnSelectedAccount.cn_password = password;
            document.getElementById('cnPasswordField').style.display = 'none';
            document.getElementById('cnAccountStatus').textContent = 'Password saved. Ready to upload.';
            document.getElementById('cnAccountStatus').className = 'cn-status success';
        }

        statusEl.textContent = 'Extracting text from ' + pdf.numPages + ' pages...';

        // Extract text from all pages
        var pages = [];
        for (var i = 1; i <= pdf.numPages; i++) {
            var page = await pdf.getPage(i);
            var textContent = await page.getTextContent();
            var items = textContent.items.map(function(item) {
                return { text: item.str, x: item.transform[4], y: item.transform[5], width: item.width, height: item.height };
            });
            pages.push(items);
        }

        statusEl.textContent = 'Loading parser...';

        // Dynamically load the broker-specific parser if not already loaded
        var template = cnSelectedAccount.cn_parser_template;
        await loadCnParser(template);
        var parser = window.CN_PARSERS[template];
        if (!parser) {
            throw new Error('No parser found for template: ' + template);
        }

        statusEl.textContent = 'Parsing trades...';
        window._debugCnPages = pages;  // DEBUG: capture raw PDF pages for troubleshooting
        var parseResult = parser(pages, pdf.numPages);
        window._debugParseResult = parseResult;  // DEBUG: capture parser output
        console.log('CN Parser: ' + parseResult.trades.length + ' trades found: ' + parseResult.trades.map(function(t) { return t.underlying + '(' + t.buySell + ')'; }).join(', '));
        // parseResult = { tradeDate, cnNumber, trades: [{segment, description, buySell, qty, price, amount}], charges: {equity:{brokerage,stt,gst,...}, nfo:{...}} }

        // Store trade date and CN number for buildTransactionRecord
        cnTradeDate = parseResult.tradeDate;
        cnCnNumber = parseResult.cnNumber;

        statusEl.textContent = 'Matching securities...';

        // Group trades by symbol+type, match to securities (server-side), allocate charges
        var processed = await processAndGroupTrades(parseResult);

        statusEl.textContent = 'Checking for duplicates...';
        await checkDuplicates(processed, parseResult.tradeDate);

        // Show preview
        displayCnPreview(parseResult);
        tiLoading(false);
        statusEl.textContent = 'Parsed ' + (cnNewRows.length + cnUpdateRows.length) + ' trade(s), ' + cnErrorRows.length + ' error(s).';
        statusEl.className = cnErrorRows.length > 0 ? 'cn-status' : 'cn-status success';

    } catch (e) {
        console.error('CN Parse error:', e);
        tiLoading(false);
        statusEl.textContent = 'Error: ' + e.message;
        statusEl.className = 'cn-status error';
        tiAlert('error', 'Failed to parse contract note: ' + e.message);
    }
}

async function saveCnPassword(accountId, password) {
    try {
        await fetch(SUPABASE_URL + '/rest/v1/investor_broker_accounts?id=eq.' + accountId, {
            method: 'PATCH',
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ cn_password: password })
        });
    } catch (e) {
        console.error('Failed to save CN password:', e);
    }
}

// ============================================================================
// CN PARSER PLUGIN ARCHITECTURE
// ============================================================================
// Each broker parser lives in its own file: cn-parser-<template>.js
// Parser files register themselves into CN_PARSERS on load.
// Shared utilities are in CN_UTILS (available to all parsers).
//
// To add a new broker:
//   1. Create cn-parser-<template>.js following the contract in cn-parser-fyers.js
//   2. Set cn_parser_template = '<template>' on the broker row in the brokers table
//   3. No changes needed to this file!
// ============================================================================

// CN_PARSERS and CN_UTILS are initialized at the top of this file (lines 5-6)
// and attached to window so parser plugin scripts can access them.
var cnLoadedParsers = {};  // Track which parser scripts have been loaded

// Populate the shared utility functions for broker parsers
window.CN_UTILS = {
    // Group PDF text items into logical lines by Y coordinate (3px tolerance)
    buildLines: function(items) {
        var lineMap = {};
        items.forEach(function(item) {
            var yKey = Math.round(item.y / 3) * 3;
            if (!lineMap[yKey]) lineMap[yKey] = [];
            lineMap[yKey].push(item);
        });

        var lines = [];
        Object.keys(lineMap).sort(function(a, b) { return b - a; }).forEach(function(yKey) {
            var lineItems = lineMap[yKey].sort(function(a, b) { return a.x - b.x; });
            var text = lineItems.map(function(i) { return i.text; }).join(' ').trim();
            if (text.length > 0) {
                lines.push({ text: text, items: lineItems, y: parseFloat(yKey) });
            }
        });
        return lines;
    },

    // Extract numeric values (with commas) from text, ignoring DR/CR suffixes
    extractNumbers: function(text) {
        var matches = text.match(/[\d,]+\.\d{2}/g);
        if (!matches) return [];
        return matches.map(function(m) { return parseFloat(m.replace(/,/g, '')); });
    }
};

// Dynamically load a broker parser script (once per template)
function loadCnParser(template) {
    if (cnLoadedParsers[template]) return cnLoadedParsers[template];
    cnLoadedParsers[template] = new Promise(function(resolve, reject) {
        var script = document.createElement('script');
        script.src = 'cn-parser-' + template + '.js?t=' + Date.now();
        script.onload = function() {
            if (window.CN_PARSERS[template]) {
                console.log('CN parser loaded: ' + template);
                resolve();
            } else {
                reject(new Error('Parser file loaded but CN_PARSERS.' + template + ' not registered.'));
            }
        };
        script.onerror = function() {
            reject(new Error('Failed to load parser file: cn-parser-' + template + '.js'));
        };
        document.head.appendChild(script);
    });
    return cnLoadedParsers[template];
}

// ============================================================================
// Process & Group Trades
// ============================================================================

async function processAndGroupTrades(parseResult) {
    var trades = parseResult.trades;
    var charges = parseResult.charges;

    // EQUITY ONLY — skip NFO trades (NFO import will be done separately)
    var equityTrades = trades.filter(function(t) { return t.segment === 'EQUITY'; });
    var nfoSkipped = trades.length - equityTrades.length;
    if (nfoSkipped > 0) console.log('Skipped ' + nfoSkipped + ' NFO trade(s) — only equity is imported.');

    // Group equity trades by underlying + buySell
    var groups = {};
    equityTrades.forEach(function(t) {
        var key = t.underlying + '|' + t.buySell;
        if (!groups[key]) {
            groups[key] = { trades: [], totalQty: 0, totalAmount: 0, underlying: t.underlying,
                buySell: t.buySell, description: t.description };
        }
        groups[key].trades.push(t);
        groups[key].totalQty += t.qty;
        groups[key].totalAmount += t.amount;
    });

    // Match all securities in ONE batch query
    cnParsedRows = [];
    cnErrorRows = [];

    var keys = Object.keys(groups);

    // Collect all unique symbols from the CN
    var uniqueSymbols = [];
    keys.forEach(function(k) {
        var sym = groups[k].underlying.toUpperCase().trim();
        if (uniqueSymbols.indexOf(sym) === -1) uniqueSymbols.push(sym);
    });

    // Single batch query to Supabase for all symbols at once
    var secMap = await batchMatchSecurities(uniqueSymbols);

    for (var k = 0; k < keys.length; k++) {
        var g = groups[keys[k]];
        var avgPrice = g.totalAmount / g.totalQty;
        var sym = g.underlying.toUpperCase().trim();

        var secMatch = secMap[sym] || null;
        if (!secMatch) {
            cnErrorRows.push({
                description: g.description,
                error: 'Security not found in database: ' + g.underlying
            });
            continue;
        }

        var row = {
            security_id: secMatch.id,
            security_type: 'EQUITY',
            symbol: secMatch.symbol,
            short_symbol: g.underlying,
            company_name: secMatch.company_name || g.underlying,
            exchange: 'NSE',
            transaction_type: g.buySell,
            quantity: g.buySell === 'SELL' ? -g.totalQty : g.totalQty,
            lots: 0,
            price: Math.round(avgPrice * 100) / 100,
            gross_amount: Math.round(g.totalAmount * 100) / 100,
            brokerage: 0,
            stt: 0,
            other_charges: 0,
            gst: 0,
            total_charges: 0,
            net_amount: 0,
            // Preserve DB security classification for smart charge allocation
            _db_security_type: secMatch.security_type || 'EQUITY',
            _db_asset_class: secMatch.asset_class || ''
        };

        cnParsedRows.push(row);
    }

    // Allocate equity charges proportionally by gross_amount
    // Pass CN-level STT total for verification
    allocateCharges(cnParsedRows, charges.equity);

    return cnParsedRows;
}

// Batch query Supabase for all symbols in one call
// Returns a map: { SYMBOL_UPPER: { id, symbol, short_symbol, company_name, security_type, asset_class, exchange }, ... }
async function batchMatchSecurities(symbols) {
    var secMap = {};
    if (!symbols || symbols.length === 0) return secMap;

    // Build OR filter: symbol.in.(SYM1,SYM2),nse_symbol.in.(SYM1,SYM2),bse_symbol.in.(SYM1,SYM2)
    var symList = symbols.map(function(s) { return encodeURIComponent(s); }).join(',');
    var orFilter = 'or=(symbol.in.(' + symList + '),nse_symbol.in.(' + symList + '),bse_symbol.in.(' + symList + '))';
    var url = SUPABASE_URL + '/rest/v1/securities_db?select=id,symbol,nse_symbol,bse_symbol,company_name,security_type,asset_class,lot_size&' + orFilter;

    console.log('Batch security lookup for ' + symbols.length + ' symbol(s): ' + symbols.join(', '));
    var resp = await fetch(url, {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
    });
    if (!resp.ok) {
        console.error('Batch security lookup failed: HTTP ' + resp.status);
        return secMap;
    }
    var rows = await resp.json();
    console.log('Batch query returned ' + rows.length + ' match(es)');

    // Build lookup map — match each queried symbol to its result (full security object)
    rows.forEach(function(m) {
        var matchInfo = {
            id: m.id,
            symbol: m.nse_symbol || m.bse_symbol || m.symbol,
            short_symbol: m.nse_symbol || m.bse_symbol || m.symbol,
            company_name: m.company_name,
            security_type: m.security_type || 'EQUITY',
            asset_class: m.asset_class,
            exchange: m.nse_symbol ? 'NSE' : (m.bse_symbol ? 'BSE' : 'NSE'),
            lot_size: m.lot_size || 1
        };
        // Map by all possible symbol fields so lookup works regardless of which column matched
        if (m.symbol) secMap[m.symbol.toUpperCase()] = matchInfo;
        if (m.nse_symbol) secMap[m.nse_symbol.toUpperCase()] = matchInfo;
        if (m.bse_symbol) secMap[m.bse_symbol.toUpperCase()] = matchInfo;
    });

    // Log matches and misses
    symbols.forEach(function(sym) {
        if (secMap[sym]) {
            console.log('Matched: ' + sym + ' → ' + secMap[sym].symbol + ' (' + secMap[sym].company_name + ')');
        } else {
            console.warn('NOT FOUND in securities_db: ' + sym);
        }
    });

    return secMap;
}

// Multi-stage symbol matching for a single row (rule F.1.6)
// Returns: { status: 'confirmed'|'flagged'|'error', match: {security object}, matches: [], error: '' }
async function matchSymbolMultiStage(symbol, securityType, batchMap) {
    var symUpper = symbol.toUpperCase();

    // Stage 1: If security_type is NFO, search securities_nfo
    if (securityType === 'NFO') {
        try {
            var nfoResp = await fetch(SUPABASE_URL + '/rest/v1/securities_nfo?symbol=ilike.*' + encodeURIComponent(symUpper) + '*&select=id,symbol,instrument_name,underlying_symbol,exchange,instrument_type,lot_size,expiry_date,strike_price,option_type&limit=5', {
                headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
            });
            var nfoRows = await nfoResp.json();
            if (nfoRows.length === 1) {
                var nfo = nfoRows[0];
                return { status: 'confirmed', match: {
                    id: nfo.id, symbol: nfo.symbol, short_symbol: nfo.underlying_symbol || nfo.symbol,
                    company_name: nfo.instrument_name || nfo.symbol, security_type: 'NFO',
                    asset_class: nfo.instrument_type || null, exchange: nfo.exchange || 'NSE', lot_size: nfo.lot_size || 1
                }, matches: nfoRows };
            } else if (nfoRows.length > 1) {
                return { status: 'flagged', match: null, matches: nfoRows.map(function(n) {
                    return { id: n.id, symbol: n.symbol, short_symbol: n.underlying_symbol, company_name: n.instrument_name, security_type: 'NFO', exchange: n.exchange };
                }) };
            }
            // If no match found, try parsing the NFO symbol format
            if (nfoRows.length === 0) {
                var parsed = parseNfoSymbol(symUpper);
                if (parsed) {
                    // Look up underlying futures contract for lot_size
                    var lotSize = 1;
                    try {
                        var futResp = await fetch(SUPABASE_URL + '/rest/v1/securities_nfo?underlying_symbol=eq.' + encodeURIComponent(parsed.underlying) + '&instrument_type=eq.FUTURES&select=lot_size&limit=1', {
                            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
                        });
                        var futRows = await futResp.json();
                        if (futRows.length > 0 && futRows[0].lot_size) lotSize = futRows[0].lot_size;
                    } catch (e2) { console.warn('Lot size lookup failed for ' + parsed.underlying, e2); }

                    var instrType = parsed.optionType ? 'OPTIONS' : 'FUTURES';
                    var instrName = parsed.underlying + ' ' + parsed.expiryStr + (parsed.strikePrice ? ' ' + parsed.strikePrice + ' ' + parsed.optionType : ' FUT');

                    // Auto-insert into securities_nfo so future imports find it (schema rule: add on encounter)
                    var newNfoId = null;
                    try {
                        var nfoRecord = {
                            symbol: symUpper,
                            instrument_name: instrName,
                            exchange: 'NSE',
                            instrument_type: instrType,
                            underlying_symbol: parsed.underlying,
                            expiry_date: parsed.expiryDate,
                            strike_price: parsed.strikePrice || null,
                            option_type: parsed.optionType || null,
                            lot_size: lotSize,
                            is_active: true
                        };
                        var insertResp = await fetch(SUPABASE_URL + '/rest/v1/securities_nfo', {
                            method: 'POST',
                            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
                            body: JSON.stringify(nfoRecord)
                        });
                        if (insertResp.ok) {
                            var inserted = await insertResp.json();
                            if (inserted && inserted.length > 0) {
                                newNfoId = inserted[0].id;
                                console.log('Auto-inserted NFO security: ' + symUpper + ' → ' + newNfoId);
                            }
                        } else {
                            var errBody = await insertResp.json();
                            console.warn('Failed to auto-insert NFO ' + symUpper + ':', errBody.message || errBody.details);
                        }
                    } catch (e3) { console.warn('NFO auto-insert failed for ' + symUpper, e3); }

                    return { status: 'confirmed', match: {
                        id: newNfoId, symbol: symUpper, short_symbol: parsed.underlying,
                        company_name: instrName, security_type: 'NFO',
                        asset_class: instrType, exchange: 'NSE', lot_size: lotSize,
                        strike_price: parsed.strikePrice, option_type: parsed.optionType,
                        expiry_date: parsed.expiryDate
                    }, matches: [] };
                }
            }
            // Fall through to securities_db if no NFO match
        } catch (e) {
            console.error('NFO lookup error:', e);
        }
    }

    // Stage 2: Exact match from batch map (already queried in bulk)
    if (batchMap[symUpper]) {
        var match = batchMap[symUpper];
        // If security_type filter provided, check it matches
        if (securityType && securityType !== 'NFO' && match.security_type !== securityType) {
            // Type mismatch — also search by company_name to offer alternatives
            var altMatches = [match];
            try {
                var altFilter = 'or=(symbol.ilike.*' + encodeURIComponent(symUpper) + '*,nse_symbol.ilike.*' + encodeURIComponent(symUpper) + '*,bse_symbol.ilike.*' + encodeURIComponent(symUpper) + '*,company_name.ilike.*' + encodeURIComponent(symUpper) + '*)';
                var altResp = await fetch(SUPABASE_URL + '/rest/v1/securities_db?select=id,symbol,nse_symbol,bse_symbol,company_name,security_type,asset_class,lot_size&' + altFilter + '&limit=10', {
                    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
                });
                var altRows = await altResp.json();
                if (altRows.length > 0) {
                    altMatches = altRows.map(function(r) {
                        return { id: r.id, symbol: r.nse_symbol || r.bse_symbol || r.symbol, short_symbol: r.nse_symbol || r.bse_symbol || r.symbol, company_name: r.company_name, security_type: r.security_type, asset_class: r.asset_class, exchange: r.nse_symbol ? 'NSE' : 'BSE' };
                    });
                    // Ensure the original exact match is included
                    var hasExact = altMatches.some(function(m) { return m.id === match.id; });
                    if (!hasExact) altMatches.unshift(match);
                }
            } catch (e) { console.warn('Alt match lookup failed:', e); }
            return { status: 'flagged', match: match, matches: altMatches, error: 'Symbol found but security_type mismatch: expected ' + securityType + ', got ' + match.security_type };
        }
        return { status: 'confirmed', match: match, matches: [match] };
    }

    // Stage 3: Contains match on company_name (rule F.1.6 step 2)
    try {
        var companyFilter = 'company_name=ilike.*' + encodeURIComponent(symUpper) + '*';
        if (securityType && securityType !== 'NFO') {
            companyFilter += '&security_type=eq.' + encodeURIComponent(securityType);
        }
        var compResp = await fetch(SUPABASE_URL + '/rest/v1/securities_db?select=id,symbol,nse_symbol,bse_symbol,company_name,security_type,asset_class,lot_size&' + companyFilter + '&limit=10', {
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
        });
        var compRows = await compResp.json();

        if (compRows.length === 1) {
            var cm = compRows[0];
            return { status: 'confirmed', match: {
                id: cm.id, symbol: cm.nse_symbol || cm.bse_symbol || cm.symbol,
                short_symbol: cm.nse_symbol || cm.bse_symbol || cm.symbol,
                company_name: cm.company_name, security_type: cm.security_type || 'EQUITY',
                asset_class: cm.asset_class, exchange: cm.nse_symbol ? 'NSE' : 'BSE',
                lot_size: cm.lot_size || 1
            }, matches: compRows };
        } else if (compRows.length > 1) {
            return { status: 'flagged', match: null, matches: compRows.map(function(r) {
                return { id: r.id, symbol: r.nse_symbol || r.bse_symbol || r.symbol, short_symbol: r.nse_symbol || r.bse_symbol || r.symbol, company_name: r.company_name, security_type: r.security_type, exchange: r.nse_symbol ? 'NSE' : 'BSE' };
            }) };
        }
    } catch (e) {
        console.error('Company name lookup error:', e);
    }

    return { status: 'error', match: null, matches: [], error: 'Symbol "' + symbol + '" not found in securities_db' + (securityType ? ' (type: ' + securityType + ')' : '') };
}

// Determine if a security attracts STT (Securities Transaction Tax).
// ONLY plain EQUITY stocks attract STT in the equity delivery segment.
// All non-equity instruments (ETFs, MFs, debt funds, SGBs, REITs, InvITs, NCDs, etc.)
// do NOT attract STT or stamp duty.
function isSTTEligible(row) {
    var secType = (row._db_security_type || '').toUpperCase();

    // Only EQUITY stocks attract STT
    if (secType === 'EQUITY') return true;

    // Everything else (ETF, MF, REIT, INVIT, SGB, GOVT_BOND, NCD, LIQUID, DEBT, etc.) is exempt
    return false;
}

function allocateCharges(rows, segCharges) {
    // Smart charge allocation:
    // - Brokerage → equal per-trade if broker uses flat rate (IBA max), else proportional
    // - Exchange charges, SEBI, IPFT, GST → allocated to ALL trades proportionally
    // - STT, stamp duty → allocated ONLY to non-debt trades (debt instruments are exempt)

    var totalGross = 0;
    var sttEligibleGross = 0;

    rows.forEach(function(r) {
        var absGross = Math.abs(r.gross_amount);
        totalGross += absGross;
        r._sttEligible = isSTTEligible(r);
        if (r._sttEligible) {
            sttEligibleGross += absGross;
        }
    });

    if (totalGross === 0) return;

    // Detect flat-rate brokerage from IBA rates (e.g. Fyers ₹20/trade → max:20)
    // If broker has a 'max' cap in brokerage_rates, split brokerage equally per trade
    var useFlatBrokerage = false;
    if (cnSelectedAccount) {
        var ibaKey = cnSelectedAccount.investor_id + '|' + cnSelectedAccount.broker_id;
        var ibaData = ibaRatesMap[ibaKey];
        if (ibaData && ibaData.rates && ibaData.rates.equity && ibaData.rates.equity.delivery) {
            var deliveryRates = ibaData.rates.equity.delivery;
            // If max is set and the total brokerage equals max * numTrades, it's flat-rate
            if (deliveryRates.max && deliveryRates.max > 0) {
                useFlatBrokerage = true;
                console.log('Flat-rate brokerage detected: ₹' + deliveryRates.max + '/trade, splitting equally among ' + rows.length + ' trades');
            }
        }
    }

    // Store CN totals for verification display
    var _cnSttTotal = segCharges.stt;
    var _cnStampTotal = segCharges.stampDuty;

    rows.forEach(function(r) {
        var proportion = Math.abs(r.gross_amount) / totalGross;

        // Brokerage: equal split for flat-rate brokers, proportional otherwise
        if (useFlatBrokerage) {
            r.brokerage = Math.round(segCharges.brokerage / rows.length * 100) / 100;
        } else {
            r.brokerage = Math.round(segCharges.brokerage * proportion * 100) / 100;
        }

        // STT: only STT-eligible trades (EQUITY only, proportional within eligible trades)
        if (r._sttEligible && sttEligibleGross > 0) {
            var sttProportion = Math.abs(r.gross_amount) / sttEligibleGross;
            r.stt = Math.round(segCharges.stt * sttProportion * 100) / 100;
        } else {
            r.stt = 0;
        }

        // Exchange charges, SEBI, IPFT: all trades get proportional share
        var exchShare = Math.round(segCharges.exchangeCharges * proportion * 100) / 100;
        var sebiShare = Math.round(segCharges.sebiCharges * proportion * 100) / 100;
        var ipftShare = Math.round(segCharges.ipft * proportion * 100) / 100;

        // Stamp duty: only STT-eligible trades (same exemption as STT)
        var stampShare = 0;
        if (r._sttEligible && sttEligibleGross > 0) {
            var stampProportion = Math.abs(r.gross_amount) / sttEligibleGross;
            stampShare = Math.round(segCharges.stampDuty * stampProportion * 100) / 100;
        }

        r.other_charges = Math.round((exchShare + sebiShare + stampShare + ipftShare) * 100) / 100;

        // GST: 18% on (brokerage + exchange + SEBI) — all trades
        r.gst = Math.round(segCharges.gst * proportion * 100) / 100;

        r.total_charges = Math.round((r.brokerage + r.stt + r.gst + r.other_charges) * 100) / 100;

        // net_amount = gross_amount + total_charges (charges always add for buys, subtract from sells)
        if (r.transaction_type === 'BUY') {
            r.net_amount = Math.round((r.gross_amount + r.total_charges) * 100) / 100;
        } else {
            r.net_amount = Math.round((r.gross_amount - r.total_charges) * 100) / 100;
        }
    });

    // STT verification: sum allocated STT vs CN total
    var allocatedStt = 0;
    rows.forEach(function(r) { allocatedStt += r.stt; });
    allocatedStt = Math.round(allocatedStt * 100) / 100;
    var sttDiff = Math.abs(allocatedStt - _cnSttTotal);

    // Store verification result on the module-level for display
    window._cnChargeVerification = {
        cnStt: _cnSttTotal,
        allocatedStt: allocatedStt,
        sttMatch: sttDiff < 0.02,  // Allow 2 paise rounding tolerance
        sttDiff: sttDiff,
        cnStamp: _cnStampTotal,
        sttExemptSymbols: rows.filter(function(r) { return !r._sttEligible; }).map(function(r) { return r.short_symbol + ' (' + (r._db_security_type || '?') + ')'; }),
        sttEligibleSymbols: rows.filter(function(r) { return r._sttEligible; }).map(function(r) { return r.short_symbol; })
    };

    if (!window._cnChargeVerification.sttMatch) {
        console.warn('STT MISMATCH: CN total=' + _cnSttTotal + ', allocated=' + allocatedStt + ', diff=' + sttDiff);
        console.warn('STT exempt: ' + window._cnChargeVerification.sttExemptSymbols.join(', '));
        console.warn('STT eligible: ' + window._cnChargeVerification.sttEligibleSymbols.join(', '));
    } else {
        console.log('STT verification passed: CN=' + _cnSttTotal + ', allocated=' + allocatedStt);
    }

    // ========================================================================
    // CN Total Reconciliation:
    // Compare total CN charges vs total allocated charges. If there's a gap
    // (e.g. stamp duty exempted from non-equity instruments), distribute the
    // unallocated amount proportionally by gross_amount into other_charges
    // so the import net amount matches the CN exactly.
    // ========================================================================
    var cnTotalCharges = Math.round(((segCharges.brokerage || 0) + (segCharges.stt || 0) +
        (segCharges.gst || 0) + (segCharges.exchangeCharges || 0) + (segCharges.sebiCharges || 0) +
        (segCharges.stampDuty || 0) + (segCharges.ipft || 0)) * 100) / 100;

    var allocatedTotalCharges = 0;
    rows.forEach(function(r) { allocatedTotalCharges += r.total_charges; });
    allocatedTotalCharges = Math.round(allocatedTotalCharges * 100) / 100;

    var chargeGap = Math.round((cnTotalCharges - allocatedTotalCharges) * 100) / 100;

    if (Math.abs(chargeGap) > 0.01) {
        console.log('CN charge reconciliation: CN total=' + cnTotalCharges + ', allocated=' + allocatedTotalCharges + ', gap=' + chargeGap + ' — distributing to other_charges');

        // Distribute gap proportionally by gross_amount
        var distributed = 0;
        rows.forEach(function(r, idx) {
            var proportion = Math.abs(r.gross_amount) / totalGross;
            var share;
            if (idx === rows.length - 1) {
                // Last row gets remainder to avoid rounding drift
                share = Math.round((chargeGap - distributed) * 100) / 100;
            } else {
                share = Math.round(chargeGap * proportion * 100) / 100;
            }
            r.other_charges = Math.round((r.other_charges + share) * 100) / 100;
            r.total_charges = Math.round((r.brokerage + r.stt + r.gst + r.other_charges) * 100) / 100;
            if (r.transaction_type === 'BUY') {
                r.net_amount = Math.round((r.gross_amount + r.total_charges) * 100) / 100;
            } else {
                r.net_amount = Math.round((r.gross_amount - r.total_charges) * 100) / 100;
            }
            distributed += share;
        });

        // Store reconciliation info for display
        window._cnChargeVerification.reconciled = true;
        window._cnChargeVerification.chargeGap = chargeGap;
        window._cnChargeVerification.cnTotalCharges = cnTotalCharges;
    } else {
        window._cnChargeVerification.reconciled = false;
        window._cnChargeVerification.chargeGap = 0;
    }
}

// ============================================================================
// Duplicate Detection
// ============================================================================

async function checkDuplicates(rows, tradeDate) {
    if (rows.length === 0) { cnNewRows = []; cnUpdateRows = []; return; }

    // Query existing transactions for this investor + broker + date
    var investorId = cnSelectedAccount.investor_id;
    var brokerId = cnSelectedAccount.broker_id;

    var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions?investor_id=eq.' + investorId + '&broker_id=eq.' + brokerId + '&transaction_date=eq.' + tradeDate + '&select=id,symbol,transaction_type,quantity,price,gross_amount,tags', {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
    });
    var existing = await resp.json();

    cnNewRows = [];
    cnUpdateRows = [];

    rows.forEach(function(r) {
        // Match: same symbol + same transaction_type
        var match = existing.find(function(e) {
            return e.symbol === r.symbol && e.transaction_type === r.transaction_type;
        });

        if (match) {
            r._existingId = match.id;
            r._action = 'UPDATE';
            r.tags = match.tags || [];  // Load existing tags for editing
            cnUpdateRows.push(r);
        } else {
            r.tags = [];  // Empty tags for new rows
            r._action = 'NEW';
            cnNewRows.push(r);
        }
    });
}

// ============================================================================
// CN Preview Display
// ============================================================================

function displayCnPreview(parseResult) {
    // Stats
    document.getElementById('cnStatTotal').textContent = cnNewRows.length + cnUpdateRows.length;
    document.getElementById('cnStatNew').textContent = cnNewRows.length;
    document.getElementById('cnStatUpdate').textContent = cnUpdateRows.length;
    document.getElementById('cnStatError').textContent = cnErrorRows.length;

    // STT / Charge verification alert
    var alertDiv = document.getElementById('cnChargeAlert');
    if (alertDiv && window._cnChargeVerification) {
        var v = window._cnChargeVerification;
        if (v.sttExemptSymbols.length > 0 || !v.sttMatch) {
            alertDiv.style.display = 'block';
            var html = '';

            // Info about STT-exempt symbols
            if (v.sttExemptSymbols.length > 0) {
                html += '<div style="margin-bottom:6px;"><strong>STT-Exempt Instruments:</strong> ' +
                    v.sttExemptSymbols.join(', ') + ' — STT and stamp duty not allocated to these symbols.</div>';
            }

            if (!v.sttMatch) {
                // Mismatch warning
                alertDiv.style.background = '#FEF3C7';
                alertDiv.style.border = '1px solid #F59E0B';
                alertDiv.style.color = '#92400E';
                html += '<div><strong>⚠ STT Mismatch:</strong> CN total STT = ₹' + v.cnStt.toFixed(2) +
                    ', Allocated STT = ₹' + v.allocatedStt.toFixed(2) +
                    ' (diff: ₹' + v.sttDiff.toFixed(2) + '). ' +
                    'This may indicate some symbols are classified incorrectly. ' +
                    '<strong>You can edit charge amounts directly in the table below.</strong></div>';
            } else {
                // All good info
                alertDiv.style.background = '#ECFDF5';
                alertDiv.style.border = '1px solid #10B981';
                alertDiv.style.color = '#065F46';
                html += '<div><strong>✓ STT Verified:</strong> CN STT ₹' + v.cnStt.toFixed(2) +
                    ' matches allocated ₹' + v.allocatedStt.toFixed(2) + '.</div>';
            }

            // Reconciliation info: unallocated charges distributed to match CN total
            if (v.reconciled) {
                html += '<div style="margin-top:4px;"><strong>✓ Reconciled:</strong> ₹' + v.chargeGap.toFixed(2) +
                    ' unallocated charges (exempt stamp duty) distributed proportionally to other_charges so import total matches CN.</div>';
            }

            alertDiv.innerHTML = html;
        } else {
            alertDiv.style.display = 'none';
        }
    }

    // Sort: BUY first, then SELL
    function sortBuyFirst(arr) {
        return arr.slice().sort(function(a, b) {
            if (a.transaction_type === b.transaction_type) return 0;
            return a.transaction_type === 'BUY' ? -1 : 1;
        });
    }
    var sortedNew = sortBuyFirst(cnNewRows);
    var sortedUpdate = sortBuyFirst(cnUpdateRows);

    // New rows table
    var newTbody = document.getElementById('cnNewTableBody');
    newTbody.innerHTML = '';
    if (sortedNew.length > 0) {
        document.getElementById('cnNewSection').style.display = '';
        sortedNew.forEach(function(r, i) { newTbody.appendChild(createCnPreviewRow(r, i + 1)); });
        newTbody.appendChild(createCnTotalsRow(sortedNew, 'NEW'));
    } else {
        document.getElementById('cnNewSection').style.display = 'none';
    }

    // Update rows table
    var updateTbody = document.getElementById('cnUpdateTableBody');
    updateTbody.innerHTML = '';
    if (sortedUpdate.length > 0) {
        document.getElementById('cnUpdateSection').style.display = '';
        sortedUpdate.forEach(function(r, i) { updateTbody.appendChild(createCnPreviewRow(r, i + 1)); });
        updateTbody.appendChild(createCnTotalsRow(sortedUpdate, 'UPDATE'));
    } else {
        document.getElementById('cnUpdateSection').style.display = 'none';
    }

    // Error rows
    var errorTbody = document.getElementById('cnErrorTableBody');
    errorTbody.innerHTML = '';
    if (cnErrorRows.length > 0) {
        document.getElementById('cnErrorSection').style.display = '';
        cnErrorRows.forEach(function(e, i) {
            var tr = document.createElement('tr');
            tr.innerHTML = '<td>' + (i+1) + '</td><td>' + e.description + '</td><td style="color:#e53e3e;">' + e.error + '</td>';
            errorTbody.appendChild(tr);
        });
    } else {
        document.getElementById('cnErrorSection').style.display = 'none';
    }

    // Show preview section and ensure import button is enabled
    document.getElementById('cnImportBtn').disabled = false;
    document.getElementById('cnPreviewSection').classList.add('active');

    // Wire up editable charge inputs after DOM is rendered
    setTimeout(function() { initCnChargeEditing(); }, 50);
}

function cnChargeInputHtml(row, field, rowKey) {
    // Editable charge input cell — inline number input that updates the row object
    var val = row[field] || 0;
    var inputId = 'cnChg_' + rowKey + '_' + field;
    return '<input type="number" step="0.01" id="' + inputId + '" value="' + val.toFixed(2) + '" ' +
        'style="width:70px;text-align:right;padding:2px 4px;border:1px solid #e2e8f0;border-radius:3px;font-size:11px;background:#fff;" ' +
        'data-row-key="' + rowKey + '" data-field="' + field + '" class="cn-charge-input">';
}

function createCnPreviewRow(r, idx) {
    var tr = document.createElement('tr');
    var typeClass = r.transaction_type === 'BUY' ? 'type-buy' : 'type-sell';
    var tagsValue = Array.isArray(r.tags) ? r.tags.filter(function(t) { return t !== 'blank'; }).join(', ') : (r.tags || '');
    var tagInputId = 'cnTag_' + r._action + '_' + (idx - 1);
    var rowKey = r._action + '_' + (idx - 1);
    var netAmtId = 'cnNet_' + rowKey;
    var sttExemptBadge = (r._sttEligible === false) ? ' <span style="font-size:9px;color:#9333ea;font-weight:600;" title="STT exempt (non-equity)">●</span>' : '';

    tr.innerHTML = '<td>' + idx + '</td>' +
        '<td class="' + typeClass + '">' + r.transaction_type + '</td>' +
        '<td title="' + r.symbol + (r._db_security_type ? ' (' + r._db_security_type + ')' : '') + '">' + r.short_symbol + sttExemptBadge + '</td>' +
        '<td style="text-align:right;">' + formatCnQty(r.quantity) + '</td>' +
        '<td style="text-align:right;">' + formatCnAmount(r.price) + '</td>' +
        '<td style="text-align:right;">' + formatCnAmount(r.gross_amount) + '</td>' +
        '<td style="text-align:right;">' + cnChargeInputHtml(r, 'brokerage', rowKey) + '</td>' +
        '<td style="text-align:right;">' + cnChargeInputHtml(r, 'stt', rowKey) + '</td>' +
        '<td style="text-align:right;">' + cnChargeInputHtml(r, 'other_charges', rowKey) + '</td>' +
        '<td style="text-align:right;">' + cnChargeInputHtml(r, 'gst', rowKey) + '</td>' +
        '<td style="text-align:right;font-weight:600;" id="' + netAmtId + '" class="' + (r.transaction_type === 'SELL' ? 'negative' : '') + '">' +
            formatCnAmount(r.transaction_type === 'SELL' ? -Math.abs(r.net_amount) : Math.abs(r.net_amount)) + '</td>' +
        '<td style="min-width:140px;position:relative;">' +
            '<div class="cn-tag-selected" id="' + tagInputId + '_pills" style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:3px;"></div>' +
            '<input type="text" id="' + tagInputId + '" value="" autocomplete="off" placeholder="type to search tags..." style="width:100%;padding:3px 6px;border:1px solid #cbd5e0;border-radius:4px;font-size:11px;">' +
            '<div class="cn-tag-dropdown" id="' + tagInputId + '_dd" style="display:none;position:absolute;z-index:100;left:0;right:0;max-height:120px;overflow-y:auto;background:#fff;border:1px solid #cbd5e0;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.12);margin-top:2px;"></div>' +
        '</td>';

    // Wire up tag autocomplete after DOM render
    setTimeout(function() { initTagAutocomplete(tagInputId, tagsValue); }, 0);

    return tr;
}

// Wire up charge input change handlers (called once after all preview rows rendered)
function initCnChargeEditing() {
    var inputs = document.querySelectorAll('.cn-charge-input');
    inputs.forEach(function(input) {
        input.addEventListener('change', function() {
            var rowKey = input.dataset.rowKey;
            var field = input.dataset.field;
            var newVal = parseFloat(input.value) || 0;

            // Find the row object
            var parts = rowKey.split('_');
            var action = parts[0];
            var idx = parseInt(parts[1]);
            var row = null;
            if (action === 'NEW') row = cnNewRows[idx];
            else if (action === 'UPDATE') row = cnUpdateRows[idx];
            if (!row) return;

            // Update the field
            row[field] = Math.round(newVal * 100) / 100;

            // Recalculate total_charges and net_amount
            row.total_charges = Math.round((row.brokerage + row.stt + row.gst + row.other_charges) * 100) / 100;
            if (row.transaction_type === 'BUY') {
                row.net_amount = Math.round((row.gross_amount + row.total_charges) * 100) / 100;
            } else {
                row.net_amount = Math.round((row.gross_amount - row.total_charges) * 100) / 100;
            }

            // Update net amount display
            var netEl = document.getElementById('cnNet_' + rowKey);
            if (netEl) {
                var displayNet = row.transaction_type === 'SELL' ? -Math.abs(row.net_amount) : Math.abs(row.net_amount);
                netEl.textContent = formatCnAmount(displayNet);
            }

            // Rebuild totals row for this section (NEW or UPDATE)
            var sectionRows = (action === 'NEW') ? cnNewRows : cnUpdateRows;
            var totalsId = 'cnTotals_' + action;
            var oldTotals = document.getElementById(totalsId);
            if (oldTotals) {
                var newTotals = createCnTotalsRow(sectionRows, action);
                oldTotals.parentNode.replaceChild(newTotals, oldTotals);
            }

            // Highlight edited input
            input.style.borderColor = '#667eea';
            input.style.background = '#f0f0ff';
        });
    });
}

function initTagAutocomplete(inputId, initialValue) {
    var input = document.getElementById(inputId);
    var pillsDiv = document.getElementById(inputId + '_pills');
    var dropdown = document.getElementById(inputId + '_dd');
    if (!input || !pillsDiv || !dropdown) return;

    // Track selected tags — preserve case as entered (no toLowerCase)
    var selected = initialValue ? initialValue.split(/[,;]/).map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0 && t !== 'blank'; }) : [];

    // Render selected pills
    function renderPills() {
        pillsDiv.innerHTML = '';
        selected.forEach(function(tag) {
            var pill = document.createElement('span');
            pill.style.cssText = 'display:inline-flex;align-items:center;gap:3px;padding:1px 8px;font-size:10px;background:#bee3f8;color:#2b6cb0;border-radius:10px;cursor:pointer;white-space:nowrap;';
            pill.textContent = tag;
            var x = document.createElement('span');
            x.textContent = '\u00d7';
            x.style.cssText = 'font-size:12px;font-weight:700;margin-left:2px;';
            pill.appendChild(x);
            pill.addEventListener('click', function() {
                selected = selected.filter(function(s) { return s !== tag; });
                syncInput();
                renderPills();
            });
            pillsDiv.appendChild(pill);
        });
    }

    // Sync hidden value for import reading
    function syncInput() {
        input.dataset.tags = selected.join(', ');
    }

    // Add tags from text (supports comma/semicolon separated)
    function addTagsFromText(text) {
        var newTags = text.split(/[,;]/).map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; });
        var added = false;
        newTags.forEach(function(tag) {
            if (selected.indexOf(tag) === -1) {
                selected.push(tag);
                added = true;
                // Add to global tag list if new
                if (existingTags.indexOf(tag) === -1 && existingTags.indexOf(tag.toLowerCase()) === -1) {
                    existingTags.push(tag);
                    existingTags.sort();
                }
            }
        });
        if (added) {
            syncInput();
            renderPills();
        }
        input.value = '';
        dropdown.style.display = 'none';
    }

    // Show dropdown with matching tags as pills
    function showDropdown(filter) {
        dropdown.innerHTML = '';
        var filterLower = filter.toLowerCase();
        var matches = existingTags.filter(function(tag) {
            return selected.indexOf(tag) === -1 && tag.toLowerCase().indexOf(filterLower) !== -1;
        });
        if (matches.length === 0) { dropdown.style.display = 'none'; return; }
        dropdown.style.cssText += 'display:flex;flex-wrap:wrap;gap:3px;padding:4px 6px;';
        matches.forEach(function(tag) {
            var pill = document.createElement('span');
            pill.style.cssText = 'display:inline-block;padding:2px 8px;font-size:10px;background:#e2e8f0;color:#4a5568;border-radius:10px;cursor:pointer;white-space:nowrap;';
            pill.textContent = tag;
            pill.addEventListener('mouseenter', function() { pill.style.background = '#cbd5e0'; });
            pill.addEventListener('mouseleave', function() { pill.style.background = '#e2e8f0'; });
            pill.addEventListener('mousedown', function(e) {
                e.preventDefault();
                addTagsFromText(tag);
            });
            dropdown.appendChild(pill);
        });
        dropdown.style.display = 'flex';
    }

    // Events
    input.addEventListener('input', function() {
        // Auto-add if user types a comma or semicolon
        var val = input.value;
        if (val.indexOf(',') !== -1 || val.indexOf(';') !== -1) {
            addTagsFromText(val);
            return;
        }
        showDropdown(val);
    });
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            var val = input.value.trim();
            if (val.length > 0) {
                addTagsFromText(val);
            }
        }
    });
    input.addEventListener('focus', function() { if (input.value.length > 0) showDropdown(input.value); });
    input.addEventListener('blur', function() { setTimeout(function() { dropdown.style.display = 'none'; }, 150); });

    // Init
    renderPills();
    syncInput();
}

function createCnTotalsRow(rows, sectionId) {
    var totQty = 0, totGross = 0, totBrokerage = 0, totStt = 0, totOther = 0, totGst = 0, totNet = 0;
    rows.forEach(function(r) {
        totQty += Math.abs(r.quantity);
        totGross += Math.abs(r.gross_amount);
        totBrokerage += r.brokerage;
        totStt += r.stt;
        totOther += r.other_charges;
        totGst += r.gst;
        // Sells are negative (receivable), buys are positive (payable)
        if (r.transaction_type === 'SELL') {
            totNet -= Math.abs(r.net_amount);
        } else {
            totNet += Math.abs(r.net_amount);
        }
    });
    var tr = document.createElement('tr');
    tr.id = 'cnTotals_' + (sectionId || 'all');
    tr.style.fontWeight = '700';
    tr.style.borderTop = '2px solid #4a5568';
    tr.style.background = '#f7fafc';
    var netLabel = totNet >= 0 ? 'Net Payable' : 'Net Receivable';
    tr.innerHTML = '<td></td>' +
        '<td></td>' +
        '<td style="text-align:right;">Total</td>' +
        '<td style="text-align:right;">' + formatCnQty(totQty) + '</td>' +
        '<td></td>' +
        '<td style="text-align:right;">' + formatCnAmount(totGross) + '</td>' +
        '<td style="text-align:right;">' + formatCnAmount(totBrokerage) + '</td>' +
        '<td style="text-align:right;">' + formatCnAmount(totStt) + '</td>' +
        '<td style="text-align:right;">' + formatCnAmount(totOther) + '</td>' +
        '<td style="text-align:right;">' + formatCnAmount(totGst) + '</td>' +
        '<td style="text-align:right;font-weight:700;" class="' + getAmountClass(totNet) + '" title="' + netLabel + '">' + formatCnAmount(totNet) + '</td>' +
        '<td></td>';
    return tr;
}

// Format date as dd-MMM-yy (rule D.x — settled date format)
function formatExcelDate(dateStr) {
    if (!dateStr) return '-';
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr;
    var dd = ('0' + d.getDate()).slice(-2);
    var mmm = months[d.getMonth()];
    var yy = String(d.getFullYear()).slice(-2);
    return dd + '-' + mmm + '-' + yy;
}

function formatCnAmount(val) {
    if (val === null || val === undefined) return '-';
    var unit = getDisplayUnit();
    var config = getUnitConfig(unit);
    if (val < 0) {
        return '(' + formatWithCommas(Math.abs(val), config.comma) + ')';
    }
    return formatWithCommas(Math.abs(val), config.comma);
}

function formatCnQty(val) {
    if (val === null || val === undefined || isNaN(val)) return '0';
    var unit = getDisplayUnit();
    var config = getUnitConfig(unit);
    var absVal = Math.round(Math.abs(val));
    if (config.comma === 'indian') {
        return absVal.toLocaleString('en-IN');
    }
    return absVal.toLocaleString('en-US');
}

// ============================================================================
// CN Import to Database
// ============================================================================

// Retry wrapper for fetch — handles transient "Failed to fetch" network errors
async function fetchWithRetry(url, options, maxRetries) {
    maxRetries = maxRetries || 3;
    for (var attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            var resp = await fetch(url, options);
            return resp;
        } catch (e) {
            if (attempt < maxRetries && /failed to fetch|network|timeout/i.test(e.message)) {
                console.warn('Fetch attempt ' + attempt + ' failed (' + e.message + '), retrying in ' + (attempt * 500) + 'ms...');
                await new Promise(function(resolve) { setTimeout(resolve, attempt * 500); });
            } else {
                throw e;  // Final attempt or non-transient error
            }
        }
    }
}

window.importCnToDatabase = async function() {
    var totalRows = cnNewRows.length + cnUpdateRows.length;
    if (totalRows === 0) {
        tiAlert('error', 'No transactions to import.');
        return;
    }

    if (!confirm('Import ' + cnNewRows.length + ' new + ' + cnUpdateRows.length + ' updates = ' + totalRows + ' transactions?')) return;

    // Read tags from autocomplete pill selections (data-tags attr), blank → ['blank']
    cnNewRows.forEach(function(r, i) {
        var input = document.getElementById('cnTag_NEW_' + i);
        if (input) {
            var val = (input.dataset.tags || '').trim();
            var parsed = val ? val.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; }) : [];
            r.tags = parsed.length > 0 ? parsed : ['blank'];
        }
    });
    cnUpdateRows.forEach(function(r, i) {
        var input = document.getElementById('cnTag_UPDATE_' + i);
        if (input) {
            var val = (input.dataset.tags || '').trim();
            var parsed = val ? val.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; }) : [];
            r.tags = parsed.length > 0 ? parsed : ['blank'];
        }
    });

    tiLoading(true, 'Importing transactions...');
    document.getElementById('cnImportBtn').disabled = true;

    var insertErrors = [];
    var updateErrors = [];
    var insertCount = 0;
    var updateCount = 0;

    try {
        // INSERT new rows
        for (var i = 0; i < cnNewRows.length; i++) {
            var r = cnNewRows[i];
            var data = buildTransactionRecord(r);
            try {
                var resp = await fetchWithRetry(SUPABASE_URL + '/rest/v1/transactions', {
                    method: 'POST',
                    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
                    body: JSON.stringify(data)
                }, 3);
                var result = await resp.json();
                if (!resp.ok) {
                    insertErrors.push(r.short_symbol + ' (' + r.transaction_type + '): ' + (result.message || result.details || 'HTTP ' + resp.status));
                } else {
                    insertCount++;
                }
            } catch (e) {
                insertErrors.push(r.short_symbol + ': ' + e.message + ' (after 3 retries)');
            }
        }

        // UPDATE existing rows
        for (var j = 0; j < cnUpdateRows.length; j++) {
            var ur = cnUpdateRows[j];
            var udata = buildTransactionRecord(ur);
            delete udata.created_at; // Don't update created_at
            try {
                var uresp = await fetchWithRetry(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + ur._existingId, {
                    method: 'PATCH',
                    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
                    body: JSON.stringify(udata)
                }, 3);
                var uresult = await uresp.json();
                if (!uresp.ok) {
                    updateErrors.push(ur.short_symbol + ' (' + ur.transaction_type + '): ' + (uresult.message || uresult.details || 'HTTP ' + uresp.status));
                } else {
                    updateCount++;
                }
            } catch (e) {
                updateErrors.push(ur.short_symbol + ': ' + e.message + ' (after 3 retries)');
            }
        }

        tiLoading(false);

        // Show results
        var allErrors = insertErrors.concat(updateErrors);
        if (allErrors.length > 0) {
            tiAlert('warning', 'Imported ' + insertCount + ' new, updated ' + updateCount + '.\n\nErrors (' + allErrors.length + '):\n' + allErrors.join('\n'));
            document.getElementById('cnImportBtn').disabled = false;
        } else {
            tiAlert('success', 'Successfully imported ' + insertCount + ' new and updated ' + updateCount + ' transactions!');
            // Hide preview and reset for next import
            document.getElementById('cnImportBtn').disabled = false;
            document.getElementById('cnPreviewSection').classList.remove('active');
            cnParsedRows = [];
            cnNewRows = [];
            cnUpdateRows = [];
            cnErrorRows = [];
            // Reset upload area for next CN
            var cnUploadArea = document.getElementById('cnUploadArea');
            if (cnUploadArea) {
                var label = cnUploadArea.querySelector('.upload-label');
                if (label) label.textContent = 'Drag & drop Contract Note PDF here';
                var fileInfo = cnUploadArea.querySelector('.file-info');
                if (fileInfo) fileInfo.textContent = '';
            }
            var cnFileInput = document.getElementById('cnFileInput');
            if (cnFileInput) cnFileInput.value = '';
        }

    } catch (e) {
        console.error('Import error:', e);
        tiLoading(false);
        tiAlert('error', 'Import failed: ' + e.message);
        document.getElementById('cnImportBtn').disabled = false;
    }
};

function roundMoney(v) { return Math.round((v || 0) * 100) / 100; }

function buildTransactionRecord(row) {
    return {
        investor_id: cnSelectedAccount.investor_id,
        broker_id: cnSelectedAccount.broker_id,
        security_id: row.security_id,  // From processAndGroupTrades() security matching
        security_type: row.security_type,
        symbol: row.symbol,
        short_symbol: row.short_symbol,
        company_name: row.company_name,
        exchange: row.exchange,
        product: null,
        transaction_type: row.transaction_type,
        transaction_date: cnTradeDate,
        quantity: row.quantity,
        lots: row.lots,
        price: roundMoney(row.price),
        gross_amount: roundMoney(row.gross_amount),
        brokerage: roundMoney(row.brokerage),
        stt: roundMoney(row.stt),
        other_charges: roundMoney(row.other_charges),
        gst: roundMoney(row.gst),
        tds: null,
        total_charges: roundMoney(row.total_charges),
        net_amount: roundMoney(row.net_amount),
        margin_blocked: 0,
        broker_contract_note_no: cnCnNumber,
        broker_trade_id: null,
        tags: (row.tags && row.tags.length > 0) ? row.tags : ['blank'],
        notes: 'Imported from CN #' + cnCnNumber,
        ignore_for_avg_cost: false,
        dont_display: false
    };
}

window.cancelCnImport = function() {
    if (confirm('Cancel import and start over?')) {
        document.getElementById('cnPreviewSection').classList.remove('active');
        document.getElementById('cnParseStatus').textContent = '';
        document.getElementById('cnFileInput').value = '';
        cnParsedRows = []; cnNewRows = []; cnUpdateRows = []; cnErrorRows = [];
        cnTradeDate = null; cnCnNumber = null;
    }
};


// ============================================================================
// EXCEL IMPORT (existing functionality - preserved)
// ============================================================================

function handleFileSelect(event) {
    var file = event.target.files[0];
    if (file) handleFile(file);
    // Reset so re-selecting the same file triggers change event
    event.target.value = '';
}

function handleFile(file) {
    var validTypes = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'];
    if (!validTypes.includes(file.type) && !file.name.match(/\.(xlsx|xls)$/i)) {
        tiAlert('error', 'Please upload an Excel file (.xlsx or .xls)');
        return;
    }
    tiLoading(true, 'Reading Excel file...');
    var reader = new FileReader();
    reader.onload = async function(e) {
        try {
            // Ensure reference data is loaded before processing (prevents race condition)
            if (!_refDataReady) {
                tiLoading(true, 'Loading reference data...');
                await loadReferenceData();
            }

            var data = new Uint8Array(e.target.result);
            var workbook = XLSX.read(data, { type: 'array', cellDates: true });
            var sheetName = '1. Transactions';
            var worksheet = workbook.Sheets[sheetName];
            if (!worksheet) throw new Error('Sheet "1. Transactions" not found. Make sure you\'re using the WMS template.');
            var jsonData = XLSX.utils.sheet_to_json(worksheet, { range: 0, raw: true, defval: null });
            // Filter out header/instruction rows and blank rows
            var filteredData = jsonData.filter(function(row) {
                var inv = row['investor_name'];
                if (!inv) return false;
                var invStr = String(inv);
                if (invStr.includes('Required') || invStr.includes('=') || invStr.includes('investor_name') || invStr.length > 100) return false;
                return true;
            });
            if (filteredData.length === 0) throw new Error('No data rows found in the "1. Transactions" sheet.');
            await processTransactions(filteredData, worksheet);
            tiLoading(false);
        } catch (error) {
            tiAlert('error', 'Error reading Excel file: ' + error.message);
            tiLoading(false);
        }
    };
    reader.onerror = function() { tiAlert('error', 'Error reading file'); tiLoading(false); };
    reader.readAsArrayBuffer(file);
}

// ============================================================================
// Excel Import: 3-Stage Processing Pipeline (rules F.1–F.5)
// Stage A: Parse & Validate → Stage B: Symbol Match + Charge Calc → Stage C: Duplicate Detection
// ============================================================================

async function processTransactions(rawData, worksheet) {
    parsedTransactions = [];
    excelConfirmedRows = [];
    excelFlaggedRows = [];
    excelErrorRows = [];

    // ── Stage A: Parse & Validate ──────────────────────────────────────
    tiLoading(true, 'Validating rows...');
    var validRows = [];

    rawData.forEach(function(row, index) {
        var rowNum = index + 2; // Row 1 = headers, data starts at row 2
        var errors = [];

        // Read all 17 template columns (rule F.1.1)
        var investor_name = row['investor_name'] ? String(row['investor_name']).trim() : null;
        var trader_name = row['trader'] ? String(row['trader']).trim() : null;
        var broker_name = row['broker'] ? String(row['broker']).trim() : null;
        var transaction_date_raw = row['transaction_date'];
        var symbol_raw = row['symbol'] ? String(row['symbol']).trim() : null;
        var security_type_raw = row['security_type'] ? String(row['security_type']).trim().toUpperCase() : null;
        var transaction_type_raw = row['transaction_type'] ? String(row['transaction_type']).trim().toUpperCase().replace(/\s+/g, '_') : null;
        var quantity_raw = row['quantity'] !== null && row['quantity'] !== undefined ? parseInt(row['quantity']) : null;
        var price_raw = row['price'] !== null && row['price'] !== undefined ? parseFloat(row['price']) : null;
        var gross_amount_raw = row['gross_amount'] !== null && row['gross_amount'] !== undefined ? parseFloat(row['gross_amount']) : null;
        var brokerage_raw = row['brokerage'] !== null && row['brokerage'] !== undefined ? parseFloat(row['brokerage']) : null;
        var stt_raw = row['stt'] !== null && row['stt'] !== undefined ? parseFloat(row['stt']) : null;
        var total_charges_raw = row['total_charges'] !== null && row['total_charges'] !== undefined ? parseFloat(row['total_charges']) : null;
        var trader_charges_raw = row['trader_charges'] !== null && row['trader_charges'] !== undefined ? parseFloat(row['trader_charges']) : null;
        var net_amount_raw = row['net_amount'] !== null && row['net_amount'] !== undefined ? parseFloat(row['net_amount']) : null;
        // Check if formula cells have formulas (template-calculated) vs user-entered literal
        var netAmountIsFormula = false;
        if (worksheet && net_amount_raw !== null) {
            var netCellAddr = XLSX.utils.encode_cell({ r: rowNum - 1, c: 14 }); // col O = net_amount
            var netCellObj = worksheet[netCellAddr];
            if (netCellObj && netCellObj.f) netAmountIsFormula = true;
        }
        // Same for gross_amount (col J)
        var grossAmountIsFormula = false;
        if (worksheet && gross_amount_raw !== null) {
            var grossCellAddr = XLSX.utils.encode_cell({ r: rowNum - 1, c: 9 }); // col J = gross_amount
            var grossCellObj = worksheet[grossCellAddr];
            if (grossCellObj && grossCellObj.f) grossAmountIsFormula = true;
        }
        var tags_raw = row['tags'] ? String(row['tags']).trim() : null;
        var notes_raw = row['notes'] ? String(row['notes']).trim() : null;

        // Required field validation
        if (!investor_name) errors.push('investor_name is required');
        if (!symbol_raw) errors.push('symbol is required');

        // Investor matching (rule F.1.2)
        var investorMatch = matchInvestor(investor_name);
        if (investor_name && !investorMatch) errors.push('Investor "' + investor_name + '" not found');

        // Trader matching (rule F.1.3) — defaults to investor if blank
        var traderMatch = null;
        if (trader_name) {
            traderMatch = matchInvestor(trader_name);
            if (!traderMatch) errors.push('Trader "' + trader_name + '" not found');
        }

        // Broker matching (rule F.1.4)
        var brokerMatch = null;
        if (broker_name) {
            brokerMatch = matchBroker(broker_name);
            if (!brokerMatch) errors.push('Broker "' + broker_name + '" not found');
        }

        // Date parsing (rule F.1.5)
        var dateResult = excelDateToISO(transaction_date_raw);
        if (dateResult.error) errors.push(dateResult.error);

        // Transaction type derivation (rule F.1.8)
        var transaction_type = transaction_type_raw;
        if (!transaction_type) {
            if (quantity_raw !== null && quantity_raw !== 0) {
                transaction_type = quantity_raw > 0 ? 'BUY' : 'SELL';
            } else {
                errors.push('transaction_type is required when quantity is blank');
            }
        }

        // Quantity validation — income types can have blank quantity (rule F.4.3)
        var isIncome = transaction_type ? isIncomeType(transaction_type) : false;
        if (!isIncome && (quantity_raw === null || quantity_raw === 0)) {
            errors.push('quantity is required for ' + (transaction_type || 'BUY/SELL') + ' transactions');
        }

        // Price validation
        if (!isIncome && (price_raw === null || price_raw === 0) && (gross_amount_raw === null || gross_amount_raw === 0)) {
            errors.push('price is required');
        }

        // If errors, add to error list and skip
        if (errors.length > 0) {
            excelErrorRows.push({ rowNum: rowNum, errors: errors, raw: row });
            return;
        }

        // Quantity sign enforcement (rule F.2.7)
        var quantity = quantity_raw || 0;
        if (transaction_type === 'BUY') quantity = Math.abs(quantity);
        else if (transaction_type === 'SELL') quantity = -Math.abs(quantity);
        else if (isIncome) quantity = Math.abs(quantity) || 1;  // Income types: default to 1 if blank (DB constraint: qty != 0)

        // Gross amount (rule F.2.1)
        var gross_amount = gross_amount_raw;
        if ((gross_amount === null || isNaN(gross_amount)) && quantity !== 0 && price_raw) {
            gross_amount = Math.round(Math.abs(quantity) * price_raw * 100) / 100;
        }

        // Tags normalization (rule A.2.1)
        var tags = ['blank'];
        if (tags_raw) {
            var tagList = tags_raw.split(/[,;]/).map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; });
            if (tagList.length > 0) tags = tagList;
        }

        // Build validated row
        validRows.push({
            rowNum: rowNum,
            investor_id: investorMatch.id,
            investor_name: investorMatch.name,
            trader_id: traderMatch ? traderMatch.id : investorMatch.id,
            trader_name: traderMatch ? traderMatch.name : investorMatch.name,
            broker_id: brokerMatch ? brokerMatch.id : null,
            broker_name: brokerMatch ? brokerMatch.name : null,
            symbol: symbol_raw,
            security_type: security_type_raw,   // May be null — will be derived from match
            transaction_type: transaction_type,
            transaction_date: dateResult.date,
            quantity: quantity,
            price: price_raw || 0,
            gross_amount: gross_amount || 0,
            brokerage: brokerage_raw,           // null = auto-calc later
            stt: stt_raw,                       // null = auto-calc later
            total_charges: total_charges_raw,   // null = auto-calc later
            trader_charges: trader_charges_raw,  // null = auto-calc later
            net_amount: net_amount_raw,         // null = auto-calc later
            tags: tags,
            notes: notes_raw,
            // Placeholders — populated in Stage B
            security_id: null,
            short_symbol: null,
            company_name: null,
            exchange: null,
            asset_class: null,
            lots: null,
            other_charges: null,
            gst: null,
            tds: null,
            matchStatus: null,
            matchOptions: null,
            _totalOverride: (total_charges_raw !== null && total_charges_raw !== undefined),
            _netOverride: (net_amount_raw !== null && net_amount_raw !== undefined && !netAmountIsFormula),
            _exchange_charges: null,
            _sebi_charges: null,
            _stamp_duty: null,
            _ipft: null,
            _chargesBasis: {}
        });
    });

    console.log('Stage A complete: ' + validRows.length + ' valid, ' + excelErrorRows.length + ' errors');

    if (validRows.length === 0) {
        var errSummary = excelErrorRows.slice(0, 10).map(function(e) { return 'Row ' + e.rowNum + ': ' + e.errors.join('; '); }).join('\n');
        tiAlert('error', 'No valid rows found.\n\n' + errSummary);
        return;
    }

    // ── Stage B: Symbol Matching + Charge Calculation ────────────────
    tiLoading(true, 'Matching symbols (' + validRows.length + ' rows)...');

    // Collect unique symbols for batch query (non-NFO rows)
    var uniqueSymbols = [];
    validRows.forEach(function(r) {
        var sym = r.symbol.toUpperCase();
        if (r.security_type !== 'NFO' && uniqueSymbols.indexOf(sym) < 0) {
            uniqueSymbols.push(sym);
        }
    });

    // Batch query securities_db for all non-NFO symbols
    var batchMap = await batchMatchSecurities(uniqueSymbols);

    // Match each row individually (handles NFO, company_name fallback, multi-match)
    for (var i = 0; i < validRows.length; i++) {
        var vr = validRows[i];
        var matchResult = await matchSymbolMultiStage(vr.symbol, vr.security_type, batchMap);

        vr.matchStatus = matchResult.status;
        vr.matchOptions = matchResult.matches || [];
        vr.matchError = matchResult.error || null;

        if (matchResult.status === 'confirmed' && matchResult.match) {
            vr.security_id = matchResult.match.id;
            vr.short_symbol = matchResult.match.short_symbol;
            vr.company_name = matchResult.match.company_name;
            vr.exchange = matchResult.match.exchange;
            vr.asset_class = matchResult.match.asset_class;
            if (!vr.security_type) vr.security_type = matchResult.match.security_type;

            // Lots for NFO (chk_lots_rules: NFO lots must not be 0, non-NFO lots must be 0)
            if (vr.security_type === 'NFO' && matchResult.match.lot_size) {
                vr.lots = Math.round(Math.abs(vr.quantity) / matchResult.match.lot_size * 100) / 100;
                if (vr.transaction_type === 'SELL') vr.lots = -Math.abs(vr.lots);
            } else if (vr.security_type === 'NFO') {
                vr.lots = vr.transaction_type === 'SELL' ? -1 : 1;
            } else {
                vr.lots = 0;
            }
        } else if (matchResult.status === 'flagged') {
            // Use first match as tentative
            if (matchResult.matches.length > 0) {
                var first = matchResult.matches[0];
                vr.security_id = first.id;
                vr.short_symbol = first.short_symbol || first.symbol;
                vr.company_name = first.company_name;
                vr.exchange = first.exchange;
                if (!vr.security_type) vr.security_type = first.security_type;
                // NFO: lots must not be 0 (chk_lots_rules), calculate from lot_size or default ±1
                if ((vr.security_type === 'NFO') && first.lot_size) {
                    vr.lots = Math.round(Math.abs(vr.quantity) / first.lot_size * 100) / 100;
                    if (vr.transaction_type === 'SELL') vr.lots = -Math.abs(vr.lots);
                } else if (vr.security_type === 'NFO') {
                    vr.lots = vr.transaction_type === 'SELL' ? -1 : 1;
                } else {
                    vr.lots = 0;
                }
            } else {
                // Flagged with zero matches → treat as error (security_id would be null)
                vr.matchStatus = 'error';
                vr.matchError = 'Symbol flagged but no candidate matches found';
            }
        }

        // Auto-calculate charges (rule F.2)
        if (vr.matchStatus !== 'error') {
            autoCalcCharges(vr);
        }
    }

    // Classify rows
    excelConfirmedRows = [];
    excelFlaggedRows = [];
    validRows.forEach(function(r) {
        if (r.matchStatus === 'confirmed') {
            excelConfirmedRows.push(r);
        } else if (r.matchStatus === 'flagged') {
            excelFlaggedRows.push(r);
        } else {
            excelErrorRows.push({ rowNum: r.rowNum, errors: ['Symbol not found: ' + r.symbol], raw: r });
        }
    });

    console.log('Stage B complete: ' + excelConfirmedRows.length + ' confirmed, ' + excelFlaggedRows.length + ' flagged, ' + excelErrorRows.length + ' errors');

    // ── Stage C: Duplicate Detection ─────────────────────────────────
    tiLoading(true, 'Checking for duplicates...');

    var allGoodRows = excelConfirmedRows.concat(excelFlaggedRows);

    // Group rows by investor_id + broker_id + transaction_date
    var groupMap = {};
    allGoodRows.forEach(function(r) {
        var key = (r.investor_id || '') + '|' + (r.broker_id || '') + '|' + r.transaction_date;
        if (!groupMap[key]) groupMap[key] = [];
        groupMap[key].push(r);
    });

    // For each group, query existing transactions
    var groupKeys = Object.keys(groupMap);
    for (var g = 0; g < groupKeys.length; g++) {
        var gk = groupKeys[g];
        var parts = gk.split('|');
        var gInvestorId = parts[0];
        var gBrokerId = parts[1];
        var gDate = parts[2];

        var dupFilter = 'investor_id=eq.' + gInvestorId + '&transaction_date=eq.' + gDate;
        if (gBrokerId) dupFilter += '&broker_id=eq.' + gBrokerId;
        else dupFilter += '&broker_id=is.null';

        try {
            var dupResp = await fetch(SUPABASE_URL + '/rest/v1/transactions?select=id,symbol,transaction_type,quantity,price&' + dupFilter, {
                headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
            });
            var existingTxns = await dupResp.json();

            groupMap[gk].forEach(function(r) {
                r.isUpdate = false;
                r._existingId = null;
                for (var e = 0; e < existingTxns.length; e++) {
                    var ex = existingTxns[e];
                    if (ex.symbol === r.symbol && ex.transaction_type === r.transaction_type) {
                        r.isUpdate = true;
                        r._existingId = ex.id;
                        break;
                    }
                }
            });
        } catch (e) {
            console.error('Duplicate check error for group ' + gk + ':', e);
        }
    }

    console.log('Stage C complete. Ready for preview.');

    // Store all parsed transactions for reference
    parsedTransactions = allGoodRows;

    // Show preview
    displayExcelPreview();
}

// ============================================================================
// Excel Preview Modal
// ============================================================================

function displayExcelPreview() {
    var allRows = excelConfirmedRows.concat(excelFlaggedRows);
    var buyCount = allRows.filter(function(t) { return t.transaction_type === 'BUY'; }).length;
    var sellCount = allRows.filter(function(t) { return t.transaction_type === 'SELL'; }).length;
    var otherCount = allRows.length - buyCount - sellCount;
    var newCount = allRows.filter(function(t) { return !t.isUpdate; }).length;
    var updateCount = allRows.filter(function(t) { return t.isUpdate; }).length;

    // Update stats
    document.getElementById('statTotal').textContent = allRows.length;
    document.getElementById('statBuy').textContent = buyCount;
    document.getElementById('statSell').textContent = sellCount;
    document.getElementById('statOther').textContent = otherCount;
    document.getElementById('statNew').textContent = newCount;
    document.getElementById('statUpdate').textContent = updateCount;

    // Render preview table
    var tbody = document.getElementById('previewTableBody');
    tbody.innerHTML = '';

    // Build "Inv > Brk" display using short_name and broker_code
    function buildInvLabel(r) {
        var invDisplay = r.investor_id && investorObjMap[r.investor_id]
            ? (investorObjMap[r.investor_id].short_name || investorObjMap[r.investor_id].name)
            : r.investor_name;
        var brkDisplay = r.broker_id && brokerObjMap[r.broker_id]
            ? (brokerObjMap[r.broker_id].broker_code || brokerObjMap[r.broker_id].name)
            : r.broker_name;
        // Include trader only if different from investor
        var trdDisplay = '';
        if (r.trader_id && r.trader_id !== r.investor_id) {
            trdDisplay = investorObjMap[r.trader_id]
                ? (investorObjMap[r.trader_id].short_name || investorObjMap[r.trader_id].name)
                : r.trader_name;
        }
        var parts = [invDisplay];
        if (trdDisplay) parts.push(trdDisplay);
        if (brkDisplay) parts.push(brkDisplay);
        return parts.join(' > ');
    }

    allRows.forEach(function(t, index) {
        var row = document.createElement('tr');
        var typeClass = t.transaction_type === 'BUY' ? 'type-buy' : t.transaction_type === 'SELL' ? 'type-sell' : 'type-other';

        // Status badge
        var statusBadge = '';
        if (t.matchStatus === 'flagged') {
            var matchInfo = (t.matchOptions || []).length + ' possible matches';
            statusBadge = '<span class="review-badge" data-row="' + index + '" style="background:#feebc8;color:#744210;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;cursor:pointer;" title="Click to resolve: ' + matchInfo + '">REVIEW</span> ';
        }
        var dupBadge = t.isUpdate ? '<span style="background:#feebc8;color:#744210;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;margin-left:4px;">UPD</span>' : '<span style="background:#c6f6d5;color:#22543d;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;margin-left:4px;">NEW</span>';

        // Type abbreviation with tooltip
        var typeAbbr = t.transaction_type;
        var typeShort = typeAbbr.length > 4 ? typeAbbr.substring(0, 4) : typeAbbr;

        // Symbol display — truncate and use tooltip for full name
        var symbolDisplay = t.short_symbol || t.symbol;
        var symbolTitle = t.symbol + (t.company_name ? ' — ' + t.company_name : '') + (t.exchange ? ' (' + t.exchange + ')' : '');

        // Double-click-to-edit charge display cells
        var chargesDisplay = '<span class="charge-display" data-row="' + index + '" data-field="total_charges" title="Double-click for breakdown">' + formatCnAmount(t.total_charges || 0) + '</span>';
        var traderChargesDisplay = '<span class="charge-display" data-row="' + index + '" data-field="trader_charges" title="Double-click for breakdown">' + formatCnAmount(t.trader_charges || 0) + '</span>';

        // Tooltip info for each cell
        var invLabel = buildInvLabel(t);
        var invTooltip = 'Investor: ' + (t.investor_name || t.investor_id || '') + '\nBroker: ' + (t.broker_name || t.broker_id || '') + (t.trader_id && t.trader_id !== t.investor_id ? '\nTrader: ' + (t.trader_name || t.trader_id) : '');
        var dateTooltip = t.transaction_date || '';

        // Tags display — autocomplete pill input (same as CN import)
        var tagsArr = Array.isArray(t.tags) ? t.tags.filter(function(tg) { return tg && tg !== 'blank'; }) : (t.tags ? [t.tags] : []);
        var excelTagId = 'excelTag_' + index;
        var tagsHtml = '<div class="cn-tag-selected" id="' + excelTagId + '_pills" style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:3px;"></div>' +
            '<input type="text" id="' + excelTagId + '" value="" autocomplete="off" placeholder="tags..." ' +
            'style="width:100%;padding:3px 6px;border:1px solid #cbd5e0;border-radius:4px;font-size:11px;" ' +
            'data-row="' + index + '">' +
            '<div class="cn-tag-dropdown" id="' + excelTagId + '_dd" style="display:none;position:absolute;z-index:100;left:0;right:0;max-height:120px;overflow-y:auto;background:#fff;border:1px solid #cbd5e0;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.12);margin-top:2px;"></div>';

        row.dataset.rowIdx = index;
        row.innerHTML = '<td style="text-align:center;"><input type="checkbox" class="excel-row-cb" data-row="' + index + '" checked></td>' +
            '<td>' + (index + 1) + '</td>' +
            '<td style="font-size:10px;white-space:nowrap;" title="' + invTooltip.replace(/"/g, '&quot;') + '">' + invLabel + '</td>' +
            '<td style="min-width:140px;" title="' + symbolTitle.replace(/"/g, '&quot;') + '">' + statusBadge + symbolDisplay + dupBadge + (t.company_name ? '<br><span style="font-size:10px;color:#718096;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;max-width:110px;">' + t.company_name + '</span>' : '') + '</td>' +
            '<td class="' + typeClass + '" style="font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:36px;" title="' + typeAbbr + '">' + typeShort + '</td>' +
            '<td style="font-size:11px;white-space:nowrap;" title="' + dateTooltip + '">' + formatExcelDate(t.transaction_date) + '</td>' +
            '<td style="text-align:right;" title="Qty: ' + t.quantity + '">' + formatCnQty(t.quantity) + '</td>' +
            '<td style="text-align:right;" title="Price: ' + t.price + '">' + formatCnAmount(t.price) + '</td>' +
            '<td style="text-align:right;" title="Gross: ' + t.gross_amount + '">' + formatCnAmount(t.gross_amount) + '</td>' +
            '<td style="text-align:right;">' + chargesDisplay + '</td>' +
            '<td style="text-align:right;">' + traderChargesDisplay + '</td>' +
            '<td style="text-align:right;' + (t._netOverride ? 'color:#b7791f;font-style:italic;' : '') + '" id="excelNet_' + index + '" class="net-amount-cell" data-row="' + index + '" title="Net: ' + t.net_amount + (t._netOverride ? ' (user entered — dblclick to edit)' : ' (dblclick to edit)') + '">' + formatCnAmount(t.net_amount) + '</td>' +
            '<td style="font-size:10px;width:160px;max-width:160px;position:relative;">' + tagsHtml + '</td>';

        if (t.matchStatus === 'flagged') {
            row.style.backgroundColor = '#fffff0';
        }

        tbody.appendChild(row);
    });

    // Attach double-click handlers for charge cells
    attachChargeEditHandlers();

    // Attach row checkbox handlers (include/exclude)
    attachRowCheckboxHandlers();

    // Attach sort handlers on sortable columns
    attachSortHandlers();

    // Attach REVIEW badge click handlers
    attachReviewHandlers();

    // Attach net_amount double-click edit handlers
    attachNetAmountEditHandlers();
    attachTagHandlers();

    // Wire up tag autocomplete for each Excel row (same widget as CN import)
    allRows.forEach(function(t, index) {
        var tagsValue = Array.isArray(t.tags) ? t.tags.filter(function(tg) { return tg && tg !== 'blank'; }).join(', ') : (t.tags || '');
        initTagAutocomplete('excelTag_' + index, tagsValue);
    });

    // Show error summary if any
    if (excelErrorRows.length > 0) {
        var errHtml = excelErrorRows.slice(0, 10).map(function(e) { return 'Row ' + e.rowNum + ': ' + e.errors.join('; '); }).join('\n');
        tiAlert('warning', allRows.length + ' transactions ready. ' + excelErrorRows.length + ' rows skipped:\n\n' + errHtml);
    } else {
        tiAlert('info', allRows.length + ' transactions ready (' + newCount + ' new, ' + updateCount + ' updates). Review and click Import.');
    }

    // Open modal overlay
    document.getElementById('excelPreviewOverlay').classList.add('active');
}

// ============================================================================
// TABLE SORTING
// ============================================================================
var _sortField = null;
var _sortAsc = true;

var _sortHandlersAttached = false;
function attachSortHandlers() {
    if (_sortHandlersAttached) {
        // Just update sort indicators on re-render
        var ths = document.querySelectorAll('.sortable-th');
        ths.forEach(function(h) {
            var baseText = h.textContent.replace(/ [▲▼]/, '');
            h.textContent = baseText;
            if (h.dataset.sort === _sortField) h.textContent += _sortAsc ? ' ▲' : ' ▼';
        });
        return;
    }
    _sortHandlersAttached = true;
    // Use event delegation on the table header row
    var thead = document.querySelector('#excelPreviewOverlay thead');
    if (!thead) return;
    thead.addEventListener('click', function(e) {
        var th = e.target.closest('.sortable-th');
        if (!th) return;
        var field = th.dataset.sort;
        if (_sortField === field) {
            _sortAsc = !_sortAsc;
        } else {
            _sortField = field;
            _sortAsc = true;
        }
        sortAndRerenderTable();
    });
}

function sortAndRerenderTable() {
    if (!_sortField) return;
    var allRows = excelConfirmedRows.concat(excelFlaggedRows);
    allRows.sort(function(a, b) {
        var va = a[_sortField] || '';
        var vb = b[_sortField] || '';
        if (typeof va === 'string') va = va.toLowerCase();
        if (typeof vb === 'string') vb = vb.toLowerCase();
        if (va < vb) return _sortAsc ? -1 : 1;
        if (va > vb) return _sortAsc ? 1 : -1;
        return 0;
    });
    // Re-split back into confirmed and flagged preserving sort order
    excelConfirmedRows = allRows.filter(function(r) { return r.matchStatus === 'confirmed'; });
    excelFlaggedRows = allRows.filter(function(r) { return r.matchStatus === 'flagged'; });
    // Re-render the preview (this will call showExcelPreview internals)
    displayExcelPreview();
}

// ============================================================================
// REVIEW BADGE — RESOLVE FLAGGED ROWS
// ============================================================================
function attachReviewHandlers() {
    var badges = document.querySelectorAll('.review-badge');
    badges.forEach(function(badge) {
        badge.addEventListener('click', function(e) {
            e.stopPropagation();
            var rowIdx = parseInt(badge.dataset.row);
            openReviewPopover(rowIdx);
        });
    });
}

function openReviewPopover(rowIdx) {
    var allRows = excelConfirmedRows.concat(excelFlaggedRows);
    var row = allRows[rowIdx];
    if (!row || !row.matchOptions || row.matchOptions.length === 0) {
        tiAlert('info', 'No alternative matches available for this row.');
        return;
    }

    // Build popover content
    var title = 'Resolve Symbol — Row ' + (rowIdx + 1) + ': ' + row.symbol;
    var reasonText = row.matchOptions.length === 1
        ? 'Symbol found but may need review. Confirm or select the correct security:'
        : 'Multiple matches found. Select the correct security:';
    if (row.matchError) reasonText = row.matchError + '. Select the correct security:';
    var bodyHtml = '<div style="font-size:11px;color:#718096;margin-bottom:8px;">' + reasonText + '</div>';

    row.matchOptions.forEach(function(opt, i) {
        var selected = (row.security_id === opt.id) ? ' style="background:#edf2f7;border:2px solid #667eea;"' : ' style="border:2px solid transparent;"';
        bodyHtml += '<div class="review-option" data-option-idx="' + i + '"' + selected + '>' +
            '<div style="font-weight:600;font-size:12px;">' + (opt.short_symbol || opt.symbol) + '</div>' +
            '<div style="font-size:10px;color:#718096;">' + (opt.company_name || '') + '</div>' +
            '<div style="font-size:9px;color:#a0aec0;">' + (opt.exchange || '') + ' | ' + (opt.security_type || '') + (opt.asset_class ? ' | ' + opt.asset_class : '') + '</div>' +
            '</div>';
    });

    // Reuse the charges popover overlay for this
    document.getElementById('cpTitle').textContent = title;
    document.getElementById('cpBody').innerHTML = bodyHtml;
    document.getElementById('cpTotal').parentElement.style.display = 'none';  // Hide total row
    document.querySelector('.cp-hint').textContent = 'Click a security to select it';

    // Attach click handlers on options
    document.querySelectorAll('.review-option').forEach(function(optEl) {
        optEl.addEventListener('click', function() {
            var optIdx = parseInt(optEl.dataset.optionIdx);
            var match = row.matchOptions[optIdx];
            row.security_id = match.id;
            row.short_symbol = match.short_symbol || match.symbol;
            row.company_name = match.company_name;
            row.exchange = match.exchange;
            if (match.security_type) row.security_type = match.security_type;
            row.matchStatus = 'confirmed';

            // Move from flagged to confirmed
            var flagIdx = excelFlaggedRows.indexOf(row);
            if (flagIdx >= 0) excelFlaggedRows.splice(flagIdx, 1);
            if (excelConfirmedRows.indexOf(row) < 0) excelConfirmedRows.push(row);

            window.closeChargesPopover();
            document.getElementById('cpTotal').parentElement.style.display = '';  // Restore total row
            displayExcelPreview();  // Re-render
            tiAlert('success', 'Symbol resolved: ' + row.symbol + ' → ' + (match.short_symbol || match.symbol));
        });
    });

    var overlay = document.getElementById('chargesPopoverOverlay');
    overlay.classList.add('active');
    overlay.onclick = function(e) {
        if (e.target === overlay) {
            window.closeChargesPopover();
            document.getElementById('cpTotal').parentElement.style.display = '';
        }
    };
}

// NET AMOUNT — double-click to edit inline
function attachNetAmountEditHandlers() {
    var cells = document.querySelectorAll('#previewTableBody .net-amount-cell');
    cells.forEach(function(cell) {
        cell.addEventListener('dblclick', function() {
            var rowIdx = parseInt(cell.dataset.row);
            var allRows = excelConfirmedRows.concat(excelFlaggedRows);
            var row = allRows[rowIdx];
            if (!row) return;
            var currentVal = row.net_amount || 0;
            cell.innerHTML = '<input type="number" step="0.01" value="' + currentVal + '" style="width:75px;font-size:11px;text-align:right;border:1px solid #667eea;border-radius:3px;padding:1px 3px;">';
            var inp = cell.querySelector('input');
            inp.focus();
            inp.select();
            function commit() {
                var newVal = parseFloat(inp.value);
                if (!isNaN(newVal)) {
                    row.net_amount = Math.round(newVal * 100) / 100;
                    row._netOverride = true;
                }
                cell.innerHTML = formatCnAmount(row.net_amount);
                cell.style.color = row._netOverride ? '#b7791f' : '';
                cell.style.fontStyle = row._netOverride ? 'italic' : '';
                cell.title = 'Net: ' + row.net_amount + (row._netOverride ? ' (user entered)' : '');
            }
            inp.addEventListener('blur', commit);
            inp.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                if (e.key === 'Escape') { cell.innerHTML = formatCnAmount(row.net_amount); }
            });
        });
    });
}

// TAG EDITING — add/remove tags on rows
function attachTagHandlers() {
    // Remove tag on click
    document.querySelectorAll('#previewTableBody .tag-badge').forEach(function(badge) {
        badge.addEventListener('click', function() {
            var rowIdx = parseInt(badge.dataset.row);
            var tag = badge.dataset.tag;
            var allRows = excelConfirmedRows.concat(excelFlaggedRows);
            var row = allRows[rowIdx];
            if (!row) return;
            if (Array.isArray(row.tags)) {
                row.tags = row.tags.filter(function(t) { return t !== tag; });
            }
            displayExcelPreview();
        });
    });
    // Add tag on '+' click
    document.querySelectorAll('#previewTableBody .tag-add-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var rowIdx = parseInt(btn.dataset.row);
            var allRows = excelConfirmedRows.concat(excelFlaggedRows);
            var row = allRows[rowIdx];
            if (!row) return;
            var parentTd = btn.closest('td');
            // Replace '+' with input
            var inp = document.createElement('input');
            inp.type = 'text';
            inp.placeholder = 'Tag...';
            inp.style.cssText = 'width:60px;font-size:10px;border:1px solid #667eea;border-radius:3px;padding:1px 3px;';
            btn.replaceWith(inp);
            inp.focus();
            function commitTag() {
                var val = inp.value.trim();
                if (val) {
                    if (!Array.isArray(row.tags)) row.tags = [];
                    row.tags = row.tags.filter(function(t) { return t !== 'blank'; });
                    if (row.tags.indexOf(val) === -1) row.tags.push(val);
                }
                displayExcelPreview();
            }
            inp.addEventListener('blur', commitTag);
            inp.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') { e.preventDefault(); commitTag(); }
                if (e.key === 'Escape') { displayExcelPreview(); }
            });
        });
    });
}

// Attach dblclick handlers to all .charge-display cells → opens breakdown popover
function attachChargeEditHandlers() {
    var cells = document.querySelectorAll('#previewTableBody .charge-display');
    cells.forEach(function(cell) {
        cell.addEventListener('dblclick', function() {
            var rowIdx = parseInt(cell.dataset.row);
            var field = cell.dataset.field;
            openChargesPopover(rowIdx, field);
        });
    });
}

// ============================================================================
// CHARGES BREAKDOWN POPOVER
// ============================================================================
var _cpCurrentRowIdx = null;
var _cpCurrentField = null; // 'total_charges' or 'trader_charges'

function openChargesPopover(rowIdx, field) {
    _cpCurrentRowIdx = rowIdx;
    _cpCurrentField = field;
    var allRows = excelConfirmedRows.concat(excelFlaggedRows);
    var row = allRows[rowIdx];
    if (!row) return;

    var isTrader = (field === 'trader_charges');
    var title = isTrader ? 'Trader Charges' : 'Charges';
    document.getElementById('cpTitle').textContent = title + ' — Row ' + (rowIdx + 1) + ' ' + (row.symbol || '');

    // Build breakdown rows — all individual line items with basis
    var basis = row._chargesBasis || {};
    var chargeFields = [
        { key: 'brokerage', label: 'Brokerage', basis: basis.brokerage || '' },
        { key: 'stt', label: 'STT', basis: basis.stt || '' },
        { key: '_exchange_charges', label: 'Exchange Charges', basis: basis._exchange_charges || '' },
        { key: '_sebi_charges', label: 'SEBI Charges', basis: basis._sebi_charges || '' },
        { key: '_stamp_duty', label: 'Stamp Duty', basis: basis._stamp_duty || '' },
        { key: '_ipft', label: 'NSE IPFT', basis: basis._ipft || '' },
        { key: 'gst', label: 'GST', basis: basis.gst || '' }
    ];

    var bodyHtml = '';
    chargeFields.forEach(function(cf) {
        var val = row[cf.key] || 0;
        var basisHtml = cf.basis ? '<span class="cp-basis">' + cf.basis + '</span>' : '';
        bodyHtml += '<div class="cp-row">' +
            '<span class="cp-label">' + cf.label + basisHtml + '</span>' +
            '<span class="cp-value" data-cp-field="' + cf.key + '" title="Double-click to edit">' + formatCnAmount(val) + '</span>' +
            '</div>';
    });
    document.getElementById('cpBody').innerHTML = bodyHtml;

    // Update total (also editable now)
    updateCpTotal(row);

    // Attach dblclick to each value
    document.querySelectorAll('#cpBody .cp-value').forEach(function(valEl) {
        valEl.addEventListener('dblclick', function() {
            startCpInlineEdit(valEl, rowIdx);
        });
    });

    // Make total editable too
    var cpTotalEl = document.getElementById('cpTotal');
    cpTotalEl.style.cursor = 'pointer';
    cpTotalEl.title = 'Double-click to override total';
    cpTotalEl.onclick = null;
    cpTotalEl.addEventListener('dblclick', function() {
        startCpTotalEdit(cpTotalEl, rowIdx);
    });

    // Close on overlay click
    var overlay = document.getElementById('chargesPopoverOverlay');
    overlay.classList.add('active');
    overlay.onclick = function(e) {
        if (e.target === overlay) closeChargesPopover();
    };
}

function updateCpTotal(row) {
    // If user has overridden total_charges, show that value with an (override) label
    var calcTotal = Math.round(((row.brokerage || 0) + (row.stt || 0) + (row.other_charges || 0) + (row.gst || 0)) * 100) / 100;
    var displayTotal = row.total_charges || calcTotal;
    var totalEl = document.getElementById('cpTotal');
    totalEl.textContent = formatCnAmount(displayTotal);
    if (row._totalOverride) {
        totalEl.title = 'User override (calc: ' + formatCnAmount(calcTotal) + ')';
        totalEl.style.color = '#d69e2e';
    } else {
        totalEl.title = 'Double-click to override total';
        totalEl.style.color = '';
    }
}

function startCpInlineEdit(span, rowIdx) {
    if (span.querySelector('input')) return;
    var field = span.dataset.cpField;
    var allRows = excelConfirmedRows.concat(excelFlaggedRows);
    var row = allRows[rowIdx];
    var currentVal = row ? (row[field] || 0) : 0;

    var input = document.createElement('input');
    input.type = 'number';
    input.step = '0.01';
    input.value = currentVal;
    input.className = 'charge-edit-input';
    input.style.width = '90px';

    span.innerHTML = '';
    span.appendChild(input);
    input.focus();
    input.select();

    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            commitCpEdit(span, input, rowIdx, field);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            span.textContent = formatCnAmount(currentVal);
        }
    });

    input.addEventListener('blur', function() {
        setTimeout(function() {
            if (span.querySelector('input')) {
                commitCpEdit(span, input, rowIdx, field);
            }
        }, 100);
    });
}

function commitCpEdit(span, input, rowIdx, field) {
    var newVal = parseFloat(input.value) || 0;
    var allRows = excelConfirmedRows.concat(excelFlaggedRows);
    var row = allRows[rowIdx];
    if (!row) return;

    row[field] = newVal;
    span.textContent = formatCnAmount(newVal);

    // If editing sub-components of other_charges, recalculate other_charges
    if (field === '_exchange_charges' || field === '_sebi_charges' || field === '_stamp_duty') {
        row.other_charges = Math.round(((row._exchange_charges || 0) + (row._sebi_charges || 0) + (row._stamp_duty || 0)) * 100) / 100;
    }

    // Recalculate total_charges from individual charge components (unless user override)
    if (!row._totalOverride) {
        row.total_charges = Math.round(((row.brokerage || 0) + (row.stt || 0) + (row.other_charges || 0) + (row.gst || 0)) * 100) / 100;
    }
    updateCpTotal(row);

    // Update the main table cells
    var chargesSpan = document.querySelector('.charge-display[data-row="' + rowIdx + '"][data-field="total_charges"]');
    if (chargesSpan) chargesSpan.textContent = formatCnAmount(row.total_charges);

    // Recalc net_amount
    recalcExcelRow(rowIdx);
}

// Allow user to override total_charges directly
function startCpTotalEdit(totalEl, rowIdx) {
    if (totalEl.querySelector('input')) return;
    var allRows = excelConfirmedRows.concat(excelFlaggedRows);
    var row = allRows[rowIdx];
    var currentVal = row ? (row.total_charges || 0) : 0;

    var input = document.createElement('input');
    input.type = 'number';
    input.step = '0.01';
    input.value = currentVal;
    input.className = 'charge-edit-input';
    input.style.width = '100px';
    input.style.fontWeight = '600';

    totalEl.innerHTML = '';
    totalEl.appendChild(input);
    input.focus();
    input.select();

    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            commitCpTotalEdit(totalEl, input, rowIdx);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            totalEl.textContent = formatCnAmount(currentVal);
        }
    });

    input.addEventListener('blur', function() {
        setTimeout(function() {
            if (totalEl.querySelector('input')) {
                commitCpTotalEdit(totalEl, input, rowIdx);
            }
        }, 100);
    });
}

function commitCpTotalEdit(totalEl, input, rowIdx) {
    var newVal = parseFloat(input.value) || 0;
    var allRows = excelConfirmedRows.concat(excelFlaggedRows);
    var row = allRows[rowIdx];
    if (!row) return;

    row.total_charges = newVal;
    row._totalOverride = true;  // Mark as user override
    totalEl.textContent = formatCnAmount(newVal);
    totalEl.style.color = '#d69e2e';
    totalEl.title = 'User override';

    // Update the main table cells
    var chargesSpan = document.querySelector('.charge-display[data-row="' + rowIdx + '"][data-field="total_charges"]');
    if (chargesSpan) chargesSpan.textContent = formatCnAmount(row.total_charges);

    // Recalc net_amount
    recalcExcelRow(rowIdx);
}

window.closeChargesPopover = function() {
    document.getElementById('chargesPopoverOverlay').classList.remove('active');
    _cpCurrentRowIdx = null;
    _cpCurrentField = null;
};

// Row checkboxes — include/exclude from import
function attachRowCheckboxHandlers() {
    // Per-row checkboxes
    var cbs = document.querySelectorAll('#previewTableBody .excel-row-cb');
    cbs.forEach(function(cb) {
        cb.addEventListener('change', function() {
            var tr = cb.closest('tr');
            if (cb.checked) {
                tr.classList.remove('excel-row-excluded');
            } else {
                tr.classList.add('excel-row-excluded');
            }
            updateSelectAllState();
            updateImportBtnCount();
        });
    });

    // Select-all checkbox
    var selectAll = document.getElementById('excelSelectAll');
    if (selectAll) {
        selectAll.checked = true;
        selectAll.addEventListener('change', function() {
            var checked = selectAll.checked;
            cbs.forEach(function(cb) {
                cb.checked = checked;
                var tr = cb.closest('tr');
                if (checked) tr.classList.remove('excel-row-excluded');
                else tr.classList.add('excel-row-excluded');
            });
            updateImportBtnCount();
        });
    }
    updateImportBtnCount();
}

function updateSelectAllState() {
    var cbs = document.querySelectorAll('#previewTableBody .excel-row-cb');
    var allChecked = true;
    cbs.forEach(function(cb) { if (!cb.checked) allChecked = false; });
    var selectAll = document.getElementById('excelSelectAll');
    if (selectAll) selectAll.checked = allChecked;
}

function updateImportBtnCount() {
    var cbs = document.querySelectorAll('#previewTableBody .excel-row-cb:checked');
    var btn = document.getElementById('importBtn');
    if (btn) btn.textContent = 'Import ' + cbs.length + ' to Database';
}

// Recalculate net_amount when user edits charges (now reads from data object, not DOM inputs)
function recalcExcelRow(index) {
    var allRows = excelConfirmedRows.concat(excelFlaggedRows);
    var row = allRows[index];
    if (!row) return;

    // Recalculate net_amount (rule F.2.2)
    if (row.transaction_type === 'BUY') {
        row.net_amount = Math.round((row.gross_amount + row.total_charges) * 100) / 100;
    } else if (row.transaction_type === 'SELL') {
        row.net_amount = Math.round((row.gross_amount - row.total_charges) * 100) / 100;
    } else if (isIncomeType(row.transaction_type)) {
        row.net_amount = Math.round((row.gross_amount - row.total_charges) * 100) / 100;
    }

    // Update net display
    var netCell = document.getElementById('excelNet_' + index);
    if (netCell) netCell.textContent = formatCnAmount(row.net_amount);
}

// Build Supabase-ready transaction record from Excel row (rules F.3.1–F.3.5)
function buildExcelTransactionRecord(row) {
    var rec = {
        investor_id: row.investor_id,
        trader_id: row.trader_id || row.investor_id,
        broker_id: row.broker_id || null,
        security_id: row.security_id,
        security_type: row.security_type || 'EQUITY',
        symbol: row.symbol,
        short_symbol: row.short_symbol || row.symbol,
        company_name: row.company_name || row.symbol,
        exchange: row.exchange || 'NSE',
        product: null,
        transaction_type: row.transaction_type,
        transaction_date: row.transaction_date,
        quantity: row.quantity,
        lots: row.lots || 0,
        price: roundMoney(row.price),
        gross_amount: roundMoney(row.gross_amount),
        brokerage: roundMoney(row.brokerage || 0),
        stt: roundMoney(row.stt || 0),
        other_charges: roundMoney(row.other_charges || 0),
        gst: roundMoney(row.gst || 0),
        tds: row.tds ? roundMoney(row.tds) : null,
        total_charges: roundMoney(row.total_charges || 0),
        trader_charges: roundMoney(row.trader_charges || 0),
        net_amount: roundMoney(row.net_amount || 0),
        margin_blocked: 0,
        broker_contract_note_no: null,
        broker_trade_id: null,
        tags: row.tags && row.tags.length > 0 ? row.tags : ['blank'],
        notes: row.notes || null,
        is_locked: false,
        ignore_for_avg_cost: false,
        dont_display: false
    };
    return rec;
}

// Import confirmed + flagged rows to database (rule C.2.2: batch ≤10, retry)
var _importInProgress = false;
async function importExcelToDatabase() {
    if (_importInProgress) { tiAlert('warning', 'Import already in progress...'); return; }

    var allRows = excelConfirmedRows.concat(excelFlaggedRows);
    if (allRows.length === 0) { tiAlert('error', 'No transactions to import'); return; }

    // Filter to only checked (included) rows
    var checkedCbs = document.querySelectorAll('#previewTableBody .excel-row-cb:checked');
    var includedIndices = {};
    checkedCbs.forEach(function(cb) { includedIndices[cb.dataset.row] = true; });
    allRows = allRows.filter(function(r, idx) { return includedIndices[idx]; });
    if (allRows.length === 0) { tiAlert('error', 'No rows selected for import'); return; }

    // Safety: skip rows with null security_id or zero quantity (DB constraints)
    var skippedRows = allRows.filter(function(r) { return !r.security_id || r.quantity === 0; });
    if (skippedRows.length > 0) {
        var skipSymbols = skippedRows.map(function(r) { return r.symbol + ((!r.security_id) ? ' [no security match]' : ' [qty=0]'); });
        console.warn('Skipping ' + skippedRows.length + ' rows with invalid data: ' + skipSymbols.join(', '));
    }
    allRows = allRows.filter(function(r) { return r.security_id && r.quantity !== 0; });
    if (allRows.length === 0) { tiAlert('error', 'No valid rows to import (all skipped due to missing security_id or zero quantity)'); return; }

    // Values are already in data objects (edited via dblclick inline edit) — recalc net unless user-entered
    allRows.forEach(function(r) {
        if (r._netOverride) return; // User entered net_amount — preserve it
        if (r.transaction_type === 'BUY') r.net_amount = Math.round((r.gross_amount + r.total_charges) * 100) / 100;
        else if (r.transaction_type === 'SELL') r.net_amount = Math.round((r.gross_amount - r.total_charges) * 100) / 100;
        else if (isIncomeType(r.transaction_type)) r.net_amount = Math.round((r.gross_amount - r.total_charges) * 100) / 100;
    });

    // Read tags from autocomplete pill inputs (data-tags attr), blank → ['blank']
    allRows.forEach(function(r, idx) {
        var input = document.getElementById('excelTag_' + idx);
        if (input && input.dataset.tags !== undefined) {
            var val = (input.dataset.tags || '').trim();
            var parsed = val ? val.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; }) : [];
            r.tags = parsed.length > 0 ? parsed : ['blank'];
        }
    });

    var newRows = allRows.filter(function(r) { return !r.isUpdate; });
    var updateRows = allRows.filter(function(r) { return r.isUpdate; });

    if (!confirm('Import ' + newRows.length + ' new + ' + updateRows.length + ' updates to database?')) return;

    _importInProgress = true;
    tiLoading(true, 'Importing transactions...');
    document.getElementById('importBtn').disabled = true;
    document.getElementById('importBtn').textContent = 'Importing...';

    var insertCount = 0, updateCount = 0;
    var importErrors = [];

    try {
        // INSERT new rows in batches of 10 (rule C.2.2)
        var insertRecords = newRows.map(buildExcelTransactionRecord);
        // Debug: log batch 0 details for chk_lots_rules diagnosis
        console.log('DEBUG batch 0 records:', JSON.stringify(insertRecords.slice(0, 10).map(function(r) { return { symbol: r.symbol, security_type: r.security_type, lots: r.lots, quantity: r.quantity, transaction_type: r.transaction_type }; })));
        for (var i = 0; i < insertRecords.length; i += 10) {
            var batch = insertRecords.slice(i, i + 10);
            try {
                var resp = await fetchWithRetry(SUPABASE_URL + '/rest/v1/transactions', {
                    method: 'POST',
                    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
                    body: JSON.stringify(batch)
                }, 3);
                if (!resp.ok) {
                    var errBody = await resp.json();
                    importErrors.push('Insert batch ' + Math.floor(i / 10) + ': ' + (errBody.message || errBody.details || 'HTTP ' + resp.status));
                } else {
                    insertCount += batch.length;
                }
            } catch (e) {
                importErrors.push('Insert batch ' + Math.floor(i / 10) + ': ' + e.message + ' (after 3 retries)');
            }
        }

        // UPDATE existing rows via PATCH (rule A.2.2: use .update().eq(), not upsert)
        for (var j = 0; j < updateRows.length; j++) {
            var ur = updateRows[j];
            var rec = buildExcelTransactionRecord(ur);
            try {
                var uresp = await fetchWithRetry(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + ur._existingId, {
                    method: 'PATCH',
                    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
                    body: JSON.stringify(rec)
                }, 3);
                if (!uresp.ok) {
                    var uErrBody = await uresp.json();
                    importErrors.push('Update ' + ur.symbol + ': ' + (uErrBody.message || 'HTTP ' + uresp.status));
                } else {
                    updateCount++;
                }
            } catch (e) {
                importErrors.push('Update ' + ur.symbol + ': ' + e.message + ' (after 3 retries)');
            }
            // Rate limit pause every 10 updates
            if (j > 0 && j % 10 === 0) await new Promise(function(r) { setTimeout(r, 200); });
        }

        tiLoading(false);

        // Always close modal and reset after import attempt
        document.getElementById('excelPreviewOverlay').classList.remove('active');
        parsedTransactions = [];
        excelConfirmedRows = [];
        excelFlaggedRows = [];
        excelErrorRows = [];
        _sortHandlersAttached = false;
        document.getElementById('fileInput').value = '';

        if (importErrors.length > 0) {
            tiAlert('warning', 'Imported ' + insertCount + ' new + ' + updateCount + ' updated.\n\n' + importErrors.length + ' errors:\n' + importErrors.slice(0, 10).join('\n'));
        } else {
            tiAlert('success', 'Successfully imported ' + insertCount + ' new + ' + updateCount + ' updated transactions!');
        }
    } catch (error) {
        tiLoading(false);
        tiAlert('error', 'Import failed: ' + error.message);
    }
    _importInProgress = false;
    document.getElementById('importBtn').disabled = false;
    document.getElementById('importBtn').textContent = 'Import to Database';
}

window.importToDatabase = function() { importExcelToDatabase(); };
window.recalcExcelRow = recalcExcelRow;
window.cancelImport = function() {
    parsedTransactions = [];
    excelConfirmedRows = [];
    excelFlaggedRows = [];
    excelErrorRows = [];
    document.getElementById('excelPreviewOverlay').classList.remove('active');
    document.getElementById('fileInput').value = '';
    tiAlert('info', 'Import cancelled.');
};

// ============================================================================
// UI Helpers
// ============================================================================

// Named tiAlert/tiLoading to avoid conflict with const showAlert/showLoading in utils.js
function tiAlert(type, message) {
    var container = document.getElementById('alertContainer');
    var alertClass = type === 'success' ? 'alert-success' : type === 'error' ? 'alert-error' : type === 'info' ? 'alert-info' : 'alert-warning';
    var el = document.createElement('div');
    el.className = 'alert ' + alertClass;
    el.textContent = message;
    container.innerHTML = '';
    container.appendChild(el);
    if (type === 'success') { setTimeout(function() { el.style.opacity = '0'; setTimeout(function() { el.remove(); }, 300); }, 5000); }
}

function tiLoading(show, text) {
    var loader = document.getElementById('loadingIndicator');
    loader.classList.toggle('hidden', !show);
    if (text) document.getElementById('loadingText').textContent = text;
}

// Expose globals for onclick handlers in HTML
// (importToDatabase, recalcExcelRow, cancelImport already set above)
// (importCnToDatabase, cancelCnImport already set via window.xxx = async function() above)
