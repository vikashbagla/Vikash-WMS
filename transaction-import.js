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

        // Load investor_broker_accounts with brokerage_rates for charge auto-calc (rule F.2.6)
        resp = await fetch(SUPABASE_URL + '/rest/v1/investor_broker_accounts?select=investor_id,broker_id,brokerage_rates&is_active=eq.true', { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY } });
        var ibAccounts = await resp.json();
        ibaRatesMap = {};
        ibAccounts.forEach(function(iba) {
            if (iba.brokerage_rates) {
                ibaRatesMap[iba.investor_id + '|' + iba.broker_id] = iba.brokerage_rates;
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
function matchInvestor(input) {
    if (!input) return null;
    var key = String(input).trim().toLowerCase();
    if (!key) return null;
    var id = investorCache[key];
    if (!id) return null;
    return { id: id, name: investorObjMap[id] ? investorObjMap[id].name : input };
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
function excelDateToISO(dateValue) {
    if (!dateValue && dateValue !== 0) return { error: 'Date is required' };

    // Already a Date object (SheetJS with cellDates:true)
    if (dateValue instanceof Date) {
        if (isNaN(dateValue.getTime())) return { error: 'Invalid date object' };
        return { date: dateValue.toISOString().split('T')[0] };
    }

    // Excel serial number (numeric)
    if (typeof dateValue === 'number') {
        var excelEpoch = new Date(1899, 11, 30);
        var d = new Date(excelEpoch.getTime() + dateValue * 86400000);
        if (isNaN(d.getTime())) return { error: 'Invalid Excel serial date: ' + dateValue };
        return { date: d.toISOString().split('T')[0] };
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
            return { date: constructed.toISOString().split('T')[0] };
        }

        // YYYY-MM-DD (ISO)
        if (trimmed.match(/^\d{4}-\d{1,2}-\d{1,2}/)) {
            return { date: trimmed.split('T')[0] };
        }

        // Try as numeric string (Excel serial)
        var days = parseFloat(trimmed);
        if (!isNaN(days) && days > 1000) {
            var d2 = new Date(new Date(1899, 11, 30).getTime() + days * 86400000);
            if (!isNaN(d2.getTime())) return { date: d2.toISOString().split('T')[0] };
        }

        return { error: 'Unrecognized date format: ' + trimmed };
    }

    return { error: 'Invalid date type: ' + typeof dateValue };
}

// Income type check (rule F.4.1)
var INCOME_TYPES = ['DIVIDEND', 'INTEREST', 'OTHER_INCOME', 'CAPITAL_REDUCTION'];
function isIncomeType(txnType) {
    return INCOME_TYPES.indexOf(txnType) >= 0;
}

// Get brokerage rate for investor-broker combo (delivery assumed per rule F.2.6)
function getBrokerageForRow(investorId, brokerId, grossAmount, securityType) {
    if (!brokerId) return 0;
    var rates = ibaRatesMap[investorId + '|' + brokerId];
    if (!rates) return 0;

    // Navigate the rates JSONB: equity.delivery for EQUITY/ETF, derivatives.futures for NFO
    var segment = null;
    if (securityType === 'NFO') {
        segment = rates.derivatives ? rates.derivatives.futures : null;
    } else {
        segment = rates.equity ? rates.equity.delivery : null;
    }
    if (!segment) return 0;

    // flat rate (options) vs pct+max (delivery/futures)
    if (segment.flat !== undefined) return segment.flat;
    var pct = segment.pct || 0;
    var max = segment.max || 0;
    var calc = Math.round(grossAmount * (pct / 100) * 100) / 100;
    if (max > 0 && calc > max) calc = max;
    return calc;
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
    var txnCat = row.security_type === 'NFO' ? 'FUTURES' : 'EQUITY_DELIVERY';
    var exchange = row.exchange || 'NSE';

    // Income types: total_charges → tds, everything else = 0 (rule F.4.2)
    if (isIncomeType(row.transaction_type)) {
        row.tds = row.total_charges || 0;
        row.brokerage = 0;
        row.stt = 0;
        row.gst = 0;
        row.other_charges = 0;
        row.total_charges = row.tds;
        row.net_amount = Math.round((gross - row.tds) * 100) / 100;
        // trader_charges for income = total_charges
        if (row.trader_charges === null || row.trader_charges === undefined) {
            row.trader_charges = row.total_charges;
        }
        return;
    }

    // 1. Brokerage (rule F.2.6)
    if (row.brokerage === null || row.brokerage === undefined || row.brokerage === 0) {
        row.brokerage = getBrokerageForRow(row.investor_id, row.broker_id, gross, row.security_type);
    }

    // 2. STT — rounded UP to nearest whole number (rule F.2.3)
    if (row.stt === null || row.stt === undefined || row.stt === 0) {
        var sttRate = getRegChargeRate('STT', txnCat, row.transaction_type, exchange);
        if (sttRate > 0) {
            row.stt = Math.ceil(gross * (sttRate / 100));
        } else {
            row.stt = 0;
        }
    }

    // 3. Other charges = exchange + SEBI + stamp duty + IPFT (rule F.3.2)
    if (row.other_charges === null || row.other_charges === undefined || row.other_charges === 0) {
        var exchRate = getRegChargeRate('EXCHANGE_CHARGES', txnCat, row.transaction_type, exchange);
        var sebiRate = getRegChargeRate('SEBI_CHARGES', txnCat, row.transaction_type, exchange);
        var stampRate = getRegChargeRate('STAMP_DUTY', txnCat, row.transaction_type, exchange);
        row.other_charges = Math.round(gross * ((exchRate + sebiRate + stampRate) / 100) * 100) / 100;
    }

    // 4. GST — 18% on (brokerage + exchange charges) (rule F.3.2)
    if (row.gst === null || row.gst === undefined || row.gst === 0) {
        var exchCharges = Math.round(gross * (getRegChargeRate('EXCHANGE_CHARGES', txnCat, row.transaction_type, exchange) / 100) * 100) / 100;
        row.gst = Math.round((row.brokerage + exchCharges) * 0.18 * 100) / 100;
    }

    // 5. total_charges = brokerage + stt + other_charges + gst (rule F.2.4)
    if (row.total_charges === null || row.total_charges === undefined || row.total_charges === 0) {
        row.total_charges = Math.round((row.brokerage + row.stt + row.other_charges + row.gst) * 100) / 100;
    }

    // 6. net_amount: BUY → gross + total_charges, SELL → gross - total_charges (rule F.2.2)
    if (row.net_amount === null || row.net_amount === undefined || row.net_amount === 0) {
        if (row.transaction_type === 'BUY') {
            row.net_amount = Math.round((gross + row.total_charges) * 100) / 100;
        } else {
            row.net_amount = Math.round((gross - row.total_charges) * 100) / 100;
        }
    }

    // 7. trader_charges (rule F.2.5)
    if (row.trader_charges === null || row.trader_charges === undefined) {
        if (!row.trader_id || row.trader_id === row.investor_id) {
            row.trader_charges = row.total_charges;
        } else {
            // Different trader — calculate from trader's broker rates
            row.trader_charges = getBrokerageForRow(row.trader_id, row.broker_id, gross, row.security_type);
        }
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
        var parseResult = parser(pages, pdf.numPages);
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
            net_amount: 0
        };

        cnParsedRows.push(row);
    }

    // Allocate equity charges proportionally by gross_amount
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
                    asset_class: null, exchange: nfo.exchange || 'NFO', lot_size: nfo.lot_size || 1
                }, matches: nfoRows };
            } else if (nfoRows.length > 1) {
                return { status: 'flagged', match: null, matches: nfoRows.map(function(n) {
                    return { id: n.id, symbol: n.symbol, short_symbol: n.underlying_symbol, company_name: n.instrument_name, security_type: 'NFO', exchange: n.exchange };
                }) };
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
            // Type mismatch — flag for review
            return { status: 'flagged', match: match, matches: [match], error: 'Symbol found but security_type mismatch: expected ' + securityType + ', got ' + match.security_type };
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

function allocateCharges(rows, segCharges) {
    // Proportionally allocate charges by gross_amount
    var total = 0;
    rows.forEach(function(r) { total += Math.abs(r.gross_amount); });
    if (total === 0) return;

    rows.forEach(function(r) {
        var proportion = Math.abs(r.gross_amount) / total;

        r.brokerage = Math.round(segCharges.brokerage * proportion * 100) / 100;
        r.stt = Math.round(segCharges.stt * proportion * 100) / 100;
        r.gst = Math.round(segCharges.gst * proportion * 100) / 100;
        // other_charges = exchange + SEBI + stamp + IPFT
        r.other_charges = Math.round((segCharges.exchangeCharges + segCharges.sebiCharges + segCharges.stampDuty + segCharges.ipft) * proportion * 100) / 100;
        r.total_charges = Math.round((r.brokerage + r.stt + r.gst + r.other_charges) * 100) / 100;

        // net_amount = gross_amount + total_charges (charges always add for buys, subtract from sells)
        if (r.transaction_type === 'BUY') {
            r.net_amount = Math.round((r.gross_amount + r.total_charges) * 100) / 100;
        } else {
            r.net_amount = Math.round((r.gross_amount - r.total_charges) * 100) / 100;
        }
    });
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
        newTbody.appendChild(createCnTotalsRow(sortedNew));
    } else {
        document.getElementById('cnNewSection').style.display = 'none';
    }

    // Update rows table
    var updateTbody = document.getElementById('cnUpdateTableBody');
    updateTbody.innerHTML = '';
    if (sortedUpdate.length > 0) {
        document.getElementById('cnUpdateSection').style.display = '';
        sortedUpdate.forEach(function(r, i) { updateTbody.appendChild(createCnPreviewRow(r, i + 1)); });
        updateTbody.appendChild(createCnTotalsRow(sortedUpdate));
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
}

function createCnPreviewRow(r, idx) {
    var tr = document.createElement('tr');
    var typeClass = r.transaction_type === 'BUY' ? 'type-buy' : 'type-sell';
    var tagsValue = Array.isArray(r.tags) ? r.tags.filter(function(t) { return t !== 'blank'; }).join(', ') : (r.tags || '');
    var tagInputId = 'cnTag_' + r._action + '_' + (idx - 1);
    tr.innerHTML = '<td>' + idx + '</td>' +
        '<td class="' + typeClass + '">' + r.transaction_type + '</td>' +
        '<td title="' + r.symbol + '">' + r.short_symbol + '</td>' +
        '<td style="text-align:right;">' + formatCnQty(r.quantity) + '</td>' +
        '<td style="text-align:right;">' + formatCnAmount(r.price) + '</td>' +
        '<td style="text-align:right;">' + formatCnAmount(r.gross_amount) + '</td>' +
        '<td style="text-align:right;">' + formatCnAmount(r.brokerage) + '</td>' +
        '<td style="text-align:right;">' + formatCnAmount(r.stt) + '</td>' +
        '<td style="text-align:right;">' + formatCnAmount(r.other_charges) + '</td>' +
        '<td style="text-align:right;">' + formatCnAmount(r.gst) + '</td>' +
        '<td style="text-align:right;font-weight:600;" class="' + (r.transaction_type === 'SELL' ? 'negative' : '') + '">' + formatCnAmount(r.transaction_type === 'SELL' ? -Math.abs(r.net_amount) : Math.abs(r.net_amount)) + '</td>' +
        '<td style="min-width:140px;position:relative;">' +
            '<div class="cn-tag-selected" id="' + tagInputId + '_pills" style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:3px;"></div>' +
            '<input type="text" id="' + tagInputId + '" value="" autocomplete="off" placeholder="type to search tags..." style="width:100%;padding:3px 6px;border:1px solid #cbd5e0;border-radius:4px;font-size:11px;">' +
            '<div class="cn-tag-dropdown" id="' + tagInputId + '_dd" style="display:none;position:absolute;z-index:100;left:0;right:0;max-height:120px;overflow-y:auto;background:#fff;border:1px solid #cbd5e0;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.12);margin-top:2px;"></div>' +
        '</td>';

    // Wire up tag autocomplete after DOM render
    setTimeout(function() { initTagAutocomplete(tagInputId, tagsValue); }, 0);

    return tr;
}

function initTagAutocomplete(inputId, initialValue) {
    var input = document.getElementById(inputId);
    var pillsDiv = document.getElementById(inputId + '_pills');
    var dropdown = document.getElementById(inputId + '_dd');
    if (!input || !pillsDiv || !dropdown) return;

    // Track selected tags
    var selected = initialValue ? initialValue.split(',').map(function(t) { return t.trim().toLowerCase(); }).filter(function(t) { return t.length > 0 && t !== 'blank'; }) : [];

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

    // Show dropdown with matching tags as pills
    function showDropdown(filter) {
        dropdown.innerHTML = '';
        var matches = existingTags.filter(function(tag) {
            return selected.indexOf(tag) === -1 && tag.indexOf(filter.toLowerCase()) !== -1;
        });
        if (matches.length === 0 && filter.length > 0) {
            // Offer to create a new tag
            var item = document.createElement('span');
            item.style.cssText = 'display:inline-block;padding:2px 8px;font-size:10px;cursor:pointer;color:#718096;font-style:italic;border:1px dashed #cbd5e0;border-radius:10px;margin:2px;';
            item.textContent = '+ ' + filter.trim();
            item.addEventListener('mousedown', function(e) {
                e.preventDefault();
                var newTag = filter.trim().toLowerCase();
                if (newTag && selected.indexOf(newTag) === -1) {
                    selected.push(newTag);
                    if (existingTags.indexOf(newTag) === -1) existingTags.push(newTag);
                    existingTags.sort();
                    syncInput();
                    renderPills();
                    input.value = '';
                    dropdown.style.display = 'none';
                }
            });
            dropdown.appendChild(item);
            dropdown.style.display = 'block';
            return;
        }
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
                selected.push(tag);
                syncInput();
                renderPills();
                input.value = '';
                dropdown.style.display = 'none';
            });
            dropdown.appendChild(pill);
        });
        dropdown.style.display = 'flex';
    }

    // Events
    input.addEventListener('input', function() { showDropdown(input.value); });
    input.addEventListener('focus', function() { if (input.value.length > 0) showDropdown(input.value); });
    input.addEventListener('blur', function() { setTimeout(function() { dropdown.style.display = 'none'; }, 150); });

    // Init
    renderPills();
    syncInput();
}

function createCnTotalsRow(rows) {
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
                var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions', {
                    method: 'POST',
                    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
                    body: JSON.stringify(data)
                });
                var result = await resp.json();
                if (!resp.ok) {
                    insertErrors.push(r.short_symbol + ' (' + r.transaction_type + '): ' + (result.message || result.details || 'HTTP ' + resp.status));
                } else {
                    insertCount++;
                }
            } catch (e) {
                insertErrors.push(r.short_symbol + ': ' + e.message);
            }
        }

        // UPDATE existing rows
        for (var j = 0; j < cnUpdateRows.length; j++) {
            var ur = cnUpdateRows[j];
            var udata = buildTransactionRecord(ur);
            delete udata.created_at; // Don't update created_at
            try {
                var uresp = await fetch(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + ur._existingId, {
                    method: 'PATCH',
                    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
                    body: JSON.stringify(udata)
                });
                var uresult = await uresp.json();
                if (!uresp.ok) {
                    updateErrors.push(ur.short_symbol + ' (' + ur.transaction_type + '): ' + (uresult.message || uresult.details || 'HTTP ' + uresp.status));
                } else {
                    updateCount++;
                }
            } catch (e) {
                updateErrors.push(ur.short_symbol + ': ' + e.message);
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

function buildTransactionRecord(row) {
    return {
        investor_id: cnSelectedAccount.investor_id,
        broker_id: cnSelectedAccount.broker_id,
        security_id: '00000000-0000-0000-0000-000000000000',  // Placeholder UUID (securities_db/nfo use SERIAL IDs)
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
        price: row.price,
        gross_amount: row.gross_amount,
        brokerage: row.brokerage,
        stt: row.stt,
        other_charges: row.other_charges,
        gst: row.gst,
        tds: null,
        total_charges: row.total_charges,
        net_amount: row.net_amount,
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
            await processTransactions(filteredData);
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

async function processTransactions(rawData) {
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
        var transaction_type_raw = row['transaction_type'] ? String(row['transaction_type']).trim().toUpperCase() : null;
        var quantity_raw = row['quantity'] !== null && row['quantity'] !== undefined ? parseInt(row['quantity']) : null;
        var price_raw = row['price'] !== null && row['price'] !== undefined ? parseFloat(row['price']) : null;
        var gross_amount_raw = row['gross_amount'] !== null && row['gross_amount'] !== undefined ? parseFloat(row['gross_amount']) : null;
        var brokerage_raw = row['brokerage'] !== null && row['brokerage'] !== undefined ? parseFloat(row['brokerage']) : null;
        var stt_raw = row['stt'] !== null && row['stt'] !== undefined ? parseFloat(row['stt']) : null;
        var total_charges_raw = row['total_charges'] !== null && row['total_charges'] !== undefined ? parseFloat(row['total_charges']) : null;
        var trader_charges_raw = row['trader_charges'] !== null && row['trader_charges'] !== undefined ? parseFloat(row['trader_charges']) : null;
        var net_amount_raw = row['net_amount'] !== null && row['net_amount'] !== undefined ? parseFloat(row['net_amount']) : null;
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
        else if (isIncome) quantity = Math.abs(quantity);

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
            matchOptions: null
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

        if (matchResult.status === 'confirmed' && matchResult.match) {
            vr.security_id = matchResult.match.id;
            vr.short_symbol = matchResult.match.short_symbol;
            vr.company_name = matchResult.match.company_name;
            vr.exchange = matchResult.match.exchange;
            vr.asset_class = matchResult.match.asset_class;
            if (!vr.security_type) vr.security_type = matchResult.match.security_type;

            // Lots for NFO
            if (vr.security_type === 'NFO' && matchResult.match.lot_size) {
                vr.lots = Math.round(Math.abs(vr.quantity) / matchResult.match.lot_size * 100) / 100;
                if (vr.transaction_type === 'SELL') vr.lots = -Math.abs(vr.lots);
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
                vr.lots = 0;
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

    // Build "Inv > Trd > Brk" display (per pattern C.3.1)
    function buildInvLabel(r) {
        var parts = [r.investor_name];
        if (r.trader_name && r.trader_name !== r.investor_name) parts.push(r.trader_name);
        if (r.broker_name) parts.push(r.broker_name);
        return parts.join(' > ');
    }

    allRows.forEach(function(t, index) {
        var row = document.createElement('tr');
        var typeClass = t.transaction_type === 'BUY' ? 'type-buy' : t.transaction_type === 'SELL' ? 'type-sell' : 'type-other';

        // Status badge
        var statusBadge = '';
        if (t.matchStatus === 'flagged') {
            statusBadge = '<span style="background:#feebc8;color:#744210;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;">REVIEW</span> ';
        }
        var dupBadge = t.isUpdate ? '<span style="background:#feebc8;color:#744210;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;margin-left:4px;">UPDATE</span>' : '<span style="background:#c6f6d5;color:#22543d;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;margin-left:4px;">NEW</span>';

        // Editable charges cells
        var chargesHtml = '<input type="number" step="0.01" value="' + (t.total_charges || 0) + '" data-row="' + index + '" data-field="total_charges" onchange="recalcExcelRow(' + index + ')" style="width:70px;padding:2px 4px;font-size:11px;border:1px solid #e2e8f0;border-radius:3px;text-align:right;">';
        var traderChargesHtml = '<input type="number" step="0.01" value="' + (t.trader_charges || 0) + '" data-row="' + index + '" data-field="trader_charges" style="width:70px;padding:2px 4px;font-size:11px;border:1px solid #e2e8f0;border-radius:3px;text-align:right;">';

        row.innerHTML = '<td>' + (index + 1) + '</td>' +
            '<td style="font-size:11px;">' + buildInvLabel(t) + '</td>' +
            '<td class="' + typeClass + '">' + t.transaction_type + '</td>' +
            '<td>' + statusBadge + t.symbol + (t.company_name ? '<br><span style="font-size:10px;color:#718096;">' + t.company_name + '</span>' : '') + dupBadge + '</td>' +
            '<td>' + t.transaction_date + '</td>' +
            '<td style="text-align:right;">' + formatCnQty(t.quantity) + '</td>' +
            '<td style="text-align:right;">' + formatCnAmount(t.price) + '</td>' +
            '<td style="text-align:right;">' + formatCnAmount(t.gross_amount) + '</td>' +
            '<td style="text-align:right;">' + chargesHtml + '</td>' +
            '<td style="text-align:right;">' + traderChargesHtml + '</td>' +
            '<td style="text-align:right;" id="excelNet_' + index + '">' + formatCnAmount(t.net_amount) + '</td>';

        if (t.matchStatus === 'flagged') {
            row.style.backgroundColor = '#fffff0';
        }

        tbody.appendChild(row);
    });

    // Show error summary if any
    if (excelErrorRows.length > 0) {
        var errHtml = excelErrorRows.slice(0, 10).map(function(e) { return 'Row ' + e.rowNum + ': ' + e.errors.join('; '); }).join('\n');
        tiAlert('warning', allRows.length + ' transactions ready. ' + excelErrorRows.length + ' rows skipped:\n\n' + errHtml);
    } else {
        tiAlert('info', allRows.length + ' transactions ready (' + newCount + ' new, ' + updateCount + ' updates). Review and click Import.');
    }

    document.getElementById('previewSection').classList.add('active');
}

// Recalculate net_amount when user edits charges inline
function recalcExcelRow(index) {
    var allRows = excelConfirmedRows.concat(excelFlaggedRows);
    var row = allRows[index];
    if (!row) return;

    // Read edited total_charges from DOM
    var chargesInput = document.querySelector('input[data-row="' + index + '"][data-field="total_charges"]');
    if (chargesInput) {
        row.total_charges = parseFloat(chargesInput.value) || 0;
    }

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
        price: row.price,
        gross_amount: row.gross_amount,
        brokerage: row.brokerage || 0,
        stt: row.stt || 0,
        other_charges: row.other_charges || 0,
        gst: row.gst || 0,
        tds: row.tds || null,
        total_charges: row.total_charges || 0,
        trader_charges: row.trader_charges || 0,
        net_amount: row.net_amount || 0,
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
async function importExcelToDatabase() {
    var allRows = excelConfirmedRows.concat(excelFlaggedRows);
    if (allRows.length === 0) { tiAlert('error', 'No transactions to import'); return; }

    // Collect latest edited values from DOM
    allRows.forEach(function(r, idx) {
        var chargesInput = document.querySelector('input[data-row="' + idx + '"][data-field="total_charges"]');
        if (chargesInput) r.total_charges = parseFloat(chargesInput.value) || 0;
        var trChargesInput = document.querySelector('input[data-row="' + idx + '"][data-field="trader_charges"]');
        if (trChargesInput) r.trader_charges = parseFloat(trChargesInput.value) || 0;
        // Recalc net
        if (r.transaction_type === 'BUY') r.net_amount = Math.round((r.gross_amount + r.total_charges) * 100) / 100;
        else if (r.transaction_type === 'SELL') r.net_amount = Math.round((r.gross_amount - r.total_charges) * 100) / 100;
        else if (isIncomeType(r.transaction_type)) r.net_amount = Math.round((r.gross_amount - r.total_charges) * 100) / 100;
    });

    var newRows = allRows.filter(function(r) { return !r.isUpdate; });
    var updateRows = allRows.filter(function(r) { return r.isUpdate; });

    if (!confirm('Import ' + newRows.length + ' new + ' + updateRows.length + ' updates to database?')) return;

    tiLoading(true, 'Importing transactions...');
    document.getElementById('importBtn').disabled = true;

    var insertCount = 0, updateCount = 0;
    var importErrors = [];

    try {
        // INSERT new rows in batches of 10 (rule C.2.2)
        var insertRecords = newRows.map(buildExcelTransactionRecord);
        for (var i = 0; i < insertRecords.length; i += 10) {
            var batch = insertRecords.slice(i, i + 10);
            try {
                var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions', {
                    method: 'POST',
                    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
                    body: JSON.stringify(batch)
                });
                if (!resp.ok) {
                    var errBody = await resp.json();
                    importErrors.push('Insert batch ' + Math.floor(i / 10) + ': ' + (errBody.message || errBody.details || 'HTTP ' + resp.status));
                } else {
                    insertCount += batch.length;
                }
            } catch (e) {
                importErrors.push('Insert batch ' + Math.floor(i / 10) + ': ' + e.message);
            }
        }

        // UPDATE existing rows via PATCH (rule A.2.2: use .update().eq(), not upsert)
        for (var j = 0; j < updateRows.length; j++) {
            var ur = updateRows[j];
            var rec = buildExcelTransactionRecord(ur);
            try {
                var uresp = await fetch(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + ur._existingId, {
                    method: 'PATCH',
                    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
                    body: JSON.stringify(rec)
                });
                if (!uresp.ok) {
                    var uErrBody = await uresp.json();
                    importErrors.push('Update ' + ur.symbol + ': ' + (uErrBody.message || 'HTTP ' + uresp.status));
                } else {
                    updateCount++;
                }
            } catch (e) {
                importErrors.push('Update ' + ur.symbol + ': ' + e.message);
            }
            // Rate limit pause every 10 updates
            if (j > 0 && j % 10 === 0) await new Promise(function(r) { setTimeout(r, 200); });
        }

        tiLoading(false);
        if (importErrors.length > 0) {
            tiAlert('warning', 'Inserted ' + insertCount + ' new, updated ' + updateCount + '.\n\nErrors:\n' + importErrors.slice(0, 10).join('\n'));
        } else {
            tiAlert('success', 'Successfully imported ' + insertCount + ' new + ' + updateCount + ' updated transactions!');
            // Reset state
            document.getElementById('previewSection').classList.remove('active');
            parsedTransactions = [];
            excelConfirmedRows = [];
            excelFlaggedRows = [];
            excelErrorRows = [];
            document.getElementById('fileInput').value = '';
        }
    } catch (error) {
        tiLoading(false);
        tiAlert('error', 'Import failed: ' + error.message);
    }
    document.getElementById('importBtn').disabled = false;
}

window.importToDatabase = function() { importExcelToDatabase(); };
window.recalcExcelRow = recalcExcelRow;
window.cancelImport = function() {
    parsedTransactions = [];
    excelConfirmedRows = [];
    excelFlaggedRows = [];
    excelErrorRows = [];
    document.getElementById('previewSection').classList.remove('active');
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
