// ============================================================================
// WMS Transaction Import - Excel + Contract Note Import
// ============================================================================

// MUST be first: set up globals for CN parser plugins BEFORE anything else
window.CN_PARSERS = window.CN_PARSERS || {};
window.CN_UTILS = window.CN_UTILS || {};

// Use var for module-level state (project convention — avoids redeclaration errors on reload)
var parsedTransactions = [];
// Reference data — local aliases synced from wmsRefData (loaded once at app startup in wms-shared.js)
var investorCache = {};        // Synced from wmsRefData.investorCache
var brokerCache = {};          // Synced from wmsRefData.brokerCache
var investorObjMap = {};       // Synced from wmsRefData.investorObjMap
var brokerObjMap = {};         // Synced from wmsRefData.brokerObjMap
var ibaRatesMap = {};          // Synced from wmsRefData.ibaRatesMap
var regulatoryCharges = [];    // Synced from wmsRefData.regCharges

// Shared import preview state (used by both Excel and Fyers via one modal)
var _currentImportSource = 'EXCEL';  // 'EXCEL' | 'FYERS' — tracks which source opened the modal
var excelConfirmedRows = [];   // Ready to import (symbol resolved, charges calculated)
var excelFlaggedRows = [];     // Need user review (symbol ambiguous, not found, errors)
var excelErrorRows = [];       // Rejected in Stage A (missing required fields — cannot show in preview)
var excelActiveFilter = 'all'; // 'all','confirmed','review','confirmed_new','confirmed_update','review_validation','review_symbol'

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

function setImportSource(source) {
    _currentImportSource = source;
    var titles = { 'EXCEL': '📊 Excel Import Preview', 'FYERS': '🔗 Fyers Tradebook Preview' };
    var el = document.getElementById('importPreviewTitle');
    if (el) el.textContent = titles[source] || titles['EXCEL'];
}

// ============================================================================
// Initialization
// ============================================================================

var _tiInitDone = false;  // Guard against multiple init calls (tab re-navigation)
var _refDataReady = false; // True once loadReferenceData() has completed at least once

function initTransactionImport() {
    if (_tiInitDone) {
        // Already initialized — just reload reference data (don't re-register listeners)
        loadReferenceData().then(function() { fyInit(); });
        loadCnAccounts();
        tiLoadImportLog();
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

    loadReferenceData().then(function() {
        // After ref data is synced, init Fyers (needs investors/brokers)
        fyInit();
    });
    loadCnAccounts();
    loadExistingTags();
    tiLoadImportLog();
}

document.addEventListener('DOMContentLoaded', initTransactionImport);

// No mode switching needed — both boxes are always visible on the page

// ============================================================================
// Reference Data
// ============================================================================

async function loadReferenceData() {
    try {
        // Ensure shared ref data is loaded (loaded once at app startup in wms-shared.js)
        if (!wmsRefData.ready) {
            await wmsLoadRefData();
        }
        // Sync local aliases from shared ref data
        investorCache = wmsRefData.investorCache;
        investorObjMap = wmsRefData.investorObjMap;
        brokerCache = wmsRefData.brokerCache;
        brokerObjMap = wmsRefData.brokerObjMap;
        ibaRatesMap = wmsRefData.ibaRatesMap;
        regulatoryCharges = wmsRefData.regCharges;

        _refDataReady = true;
        console.log('Import ref data synced from wmsRefData: ' + wmsRefData.investors.length + ' investors, ' +
            wmsRefData.brokers.length + ' brokers, ' + Object.keys(ibaRatesMap).length + ' IBA, ' +
            regulatoryCharges.length + ' reg charges');
    } catch (e) {
        console.error('Error loading reference data:', e);
    }
}

async function loadCnAccounts() {
    try {
        // Load investor_broker_accounts joined with investor short_name and broker cn_parser_template
        var resp = await fetch(SUPABASE_URL + '/rest/v1/investor_broker_accounts?select=id,investor_id,broker_id,cn_password,investors(short_name),brokers(name,broker_code,cn_parser_template)&is_active=eq.true', {
            headers: wmsHeaders()
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
            headers: wmsHeaders()
        });
        if (!resp.ok) return;
        var rows = await resp.json();
        var tagSet = {};
        rows.forEach(function(r) {
            if (Array.isArray(r.tags)) {
                r.tags.forEach(function(t) {
                    var trimmed = t.trim().toLowerCase();
                    if (trimmed) tagSet[trimmed] = true;
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

// Compute the last Tuesday of a month (NSE's monthly F&O expiry convention for
// this book — verified against Fyers data 2026-04-23).
// Returns YYYY-MM-DD. This is an APPROXIMATION used ONLY when a contract isn't
// already in securities_nfo; NFO Sync overwrites with the authoritative Fyers
// date (which handles holiday-driven shifts the approximation can't).
function _parseNfoLastTuesday(year, monthIdx) {
    var d = new Date(year, monthIdx + 1, 0);            // last day of month
    while (d.getDay() !== 2) d.setDate(d.getDate() - 1); // 2 = Tuesday
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
}

function parseNfoSymbol(sym) {
    if (!sym) return null;
    sym = sym.toUpperCase();
    // Strip any existing exchange prefix for consistent regex matching.
    // We'll add NSE: back when constructing the canonical output symbol so
    // new records match Fyers' naming convention (rule A.2.13).
    var bareSym = sym.replace(/^[A-Z]+:/, '');

    // Try options pattern: {UNDERLYING}{YY}{MON}{STRIKE}{CE|PE}
    var optMatch = bareSym.match(/^(.+?)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d+(?:\.\d+)?)(CE|PE)$/);
    if (optMatch) {
        var monIdx = NFO_MONTHS.indexOf(optMatch[3]);
        var yr = 2000 + parseInt(optMatch[2]);
        return {
            underlying: optMatch[1],
            expiryStr: optMatch[2] + optMatch[3],
            expiryDate: _parseNfoLastTuesday(yr, monIdx),
            strikePrice: parseFloat(optMatch[4]),
            optionType: optMatch[5],
            fullSymbol: 'NSE:' + bareSym
        };
    }

    // Try futures pattern: {UNDERLYING}{YY}{MON}FUT
    var futMatch = bareSym.match(/^(.+?)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)FUT$/);
    if (futMatch) {
        var monIdx2 = NFO_MONTHS.indexOf(futMatch[3]);
        var yr2 = 2000 + parseInt(futMatch[2]);
        return {
            underlying: futMatch[1],
            expiryStr: futMatch[2] + futMatch[3],
            expiryDate: _parseNfoLastTuesday(yr2, monIdx2),
            strikePrice: null,
            optionType: null,
            fullSymbol: 'NSE:' + bareSym
        };
    }

    return null;  // Not an NFO symbol
}

// Income type check (rule F.4.1)
// INCOME_TYPES and isIncomeType now in wms-shared.js as WMS_INCOME_TYPES and wmsIsIncomeType
var INCOME_TYPES = WMS_INCOME_TYPES;  // Alias for backward compatibility
function isIncomeType(txnType) { return wmsIsIncomeType(txnType); }

// Charge calculation helpers — thin wrappers calling wms-shared.js canonical functions
function getBrokerageForRow(investorId, brokerId, grossAmount, securityType, assetClass, price, quantity, lots) {
    return wmsGetBrokerage(ibaRatesMap, investorId, brokerId, grossAmount, securityType, assetClass, price, quantity, lots);
}
function isChargesInclusive(investorId, brokerId) {
    return wmsIsChargesInclusive(ibaRatesMap, investorId, brokerId);
}
function getRegChargeRate(chargeType, txnCategory, txnType, exchange) {
    return wmsGetRegRate(regulatoryCharges, chargeType, txnCategory, txnType, exchange);
}

// Auto-calculate charges — delegates to wmsAutoCalcCharges with preserveExisting=true (Excel import mode)
function autoCalcCharges(row) {
    wmsAutoCalcCharges(row, {
        ibaRatesMap: ibaRatesMap,
        regCharges: regulatoryCharges,
        investorId: row.investor_id,
        brokerId: row.broker_id,
        preserveExisting: true,  // Excel import: preserve user-entered values
        debug: false
    });
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

        // Auto-populate tags on NEW rows from prior transactions (same logic
        // as Add Transaction modal — wmsFindMatchingTags by investor + trader
        // + bare symbol). Silent on failure.
        await _autoPopulateTagsForNewRows(cnNewRows, cnSelectedAccount && cnSelectedAccount.investor_id);

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
            headers: wmsHeaders({'Content-Type': 'application/json'}),
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
    // Handles character-spaced PDFs where each glyph is a separate text item:
    // Uses x-coordinate gaps to decide where word breaks are instead of always
    // joining with spaces. Characters within a word/number have tiny gaps (<2px),
    // while actual word breaks have larger gaps (4px+).
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

            // Smart join: use x-coordinate gap to decide spaces vs concatenation
            var text = '';
            var lastEnd = null;
            for (var i = 0; i < lineItems.length; i++) {
                var item = lineItems[i];
                if (item.text.trim() === '') continue; // Skip space-only items
                if (lastEnd !== null) {
                    var gap = item.x - lastEnd;
                    if (gap > 2) text += ' ';
                }
                text += item.text;
                lastEnd = item.x + (item.width || 0);
            }
            text = text.trim();

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
    },

    // ========================================================================
    // STRUCTURAL PARSING PRIMITIVES
    // ========================================================================
    // Broker-agnostic geometric helpers for parsing tabular CN layouts. Used
    // by cn-parser-fyers.js; cn-parser-suvridhi.js and future parsers can reuse
    // the same primitives with their own column coordinates / regex patterns.
    // Separating column-layout semantics (broker-specific) from item-collection
    // geometry (universal) lets each parser stay small while still being robust
    // to layout quirks: wrapped descriptions, tight row spacing, char-by-char
    // PDF extraction, revised / supplementary notes.

    // Scan `lines` and return every line whose text matches `rowIdRegex`,
    // annotated with its y-coordinate and index. Sorted by visual reading
    // order (Y descending, i.e. top of page to bottom).
    findTradeRows: function(lines, rowIdRegex) {
        var rows = [];
        for (var i = 0; i < lines.length; i++) {
            if (rowIdRegex.test(lines[i].text)) {
                rows.push({ idx: i, y: lines[i].y, line: lines[i] });
            }
        }
        return rows.sort(function(a, b) { return b.y - a.y; });
    },

    // For a trade row at currentY, compute the Y-range (yLow, yHigh) within
    // which items "belong" to this row's wrapped content. Bounded to HALFWAY
    // to each neighbour so scans can never bleed into an adjacent row.
    // Falls back to currentY ± defaultHalfWin when no neighbour exists on
    // that side (e.g. first or last trade row on the page).
    rowYBand: function(currentY, prevY, nextY, defaultHalfWin) {
        if (defaultHalfWin == null) defaultHalfWin = 15;
        var yHigh = (prevY != null) ? (prevY + currentY) / 2 : currentY + defaultHalfWin;
        var yLow  = (nextY != null) ? (nextY + currentY) / 2 : currentY - defaultHalfWin;
        return { yLow: yLow, yHigh: yHigh };
    },

    // Collect every text item from `lines` that falls inside the geometric
    // box (xLeft ≤ item.x ≤ xRight) AND (yLow < line.y < yHigh). Items are
    // returned sorted by Y descending (top-to-bottom), then X ascending
    // within the same y-band (3px tolerance).
    collectItemsInBox: function(lines, xLeft, xRight, yLow, yHigh) {
        var out = [];
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i];
            if (ln.y <= yLow || ln.y >= yHigh) continue;
            for (var j = 0; j < ln.items.length; j++) {
                var it = ln.items[j];
                if (!it.text || !it.text.trim()) continue;
                if (it.x >= xLeft && it.x <= xRight) out.push(it);
            }
        }
        out.sort(function(a, b) {
            var dy = b.y - a.y;
            if (Math.abs(dy) > 3) return dy;
            return a.x - b.x;
        });
        return out;
    },

    // Given an array of text items already in visual reading order, re-assemble
    // them into a single string using gap-aware joining:
    //   • items on different Y-bands (|dy| > 3) are joined with a single space
    //   • items on the same Y-band are joined with a space only if x-gap > 2px
    //   • items touching or overlapping are concatenated directly
    // This matches the smart-join logic in buildLines but operates on any
    // item collection (not just one line).
    joinItemsGapAware: function(items) {
        var text = '';
        var lastY = null, lastEnd = null;
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (lastY !== null && Math.abs(it.y - lastY) > 3) {
                text += ' ';
                lastEnd = null;
            } else if (lastEnd !== null && (it.x - lastEnd) > 2) {
                text += ' ';
            }
            text += it.text;
            lastY = it.y;
            lastEnd = it.x + (it.width || 0);
        }
        return text.trim();
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

    // Match all securities from local wmsRefData.securitiesCm
    cnParsedRows = [];
    cnErrorRows = [];

    var keys = Object.keys(groups);

    // Collect all unique symbols from the CN
    var uniqueSymbols = [];
    keys.forEach(function(k) {
        var sym = groups[k].underlying.toUpperCase().trim();
        if (uniqueSymbols.indexOf(sym) === -1) uniqueSymbols.push(sym);
    });

    // Local batch lookup from in-memory securitiesCm (zero API calls)
    var secMap = batchMatchSecurities(uniqueSymbols);

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
            price: roundMoney(avgPrice),
            gross_amount: roundMoney(g.totalAmount),
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

// Local batch lookup from wmsRefData.securitiesCm (loaded at app startup — zero API calls)
// Returns a map: { SYMBOL_UPPER: { id, symbol, short_symbol, company_name, security_type, asset_class, exchange, lot_size }, ... }
function batchMatchSecurities(symbols) {
    var secMap = {};
    if (!symbols || symbols.length === 0) return secMap;
    if (!wmsRefData.securitiesCmReady) {
        console.error('batchMatchSecurities: securitiesCm not loaded yet');
        return secMap;
    }

    console.log('Local batch security lookup for ' + symbols.length + ' symbol(s): ' + symbols.join(', '));

    // Build lookup maps from in-memory securitiesCm (symbol, nse_symbol, bse_symbol → row)
    var cmRows = wmsRefData.securitiesCm;
    var symLookup = {};  // UPPER_SYMBOL → cmRow
    cmRows.forEach(function(m) {
        if (m.symbol) symLookup[m.symbol.toUpperCase()] = m;
        if (m.nse_symbol) symLookup[m.nse_symbol.toUpperCase()] = m;
        if (m.bse_symbol) symLookup[m.bse_symbol.toUpperCase()] = m;
    });

    symbols.forEach(function(sym) {
        var m = symLookup[sym];
        if (m) {
            var matchInfo = {
                id: m.id,
                symbol: m.nse_symbol || m.bse_symbol || m.symbol,
                short_symbol: m.nse_symbol || m.bse_symbol || m.symbol,
                company_name: m.company_name,
                security_type: m.security_type || 'EQUITY',
                asset_class: m.asset_class || null,
                exchange: m.nse_symbol ? 'NSE' : (m.bse_symbol ? 'BSE' : 'NSE'),
                lot_size: m.lot_size || 1
            };
            // Map by all symbol variants so downstream lookups work
            secMap[sym] = matchInfo;
            if (m.symbol) secMap[m.symbol.toUpperCase()] = matchInfo;
            if (m.nse_symbol) secMap[m.nse_symbol.toUpperCase()] = matchInfo;
            if (m.bse_symbol) secMap[m.bse_symbol.toUpperCase()] = matchInfo;
            console.log('Matched: ' + sym + ' → ' + matchInfo.symbol + ' (' + matchInfo.company_name + ')');
        } else {
            console.warn('NOT FOUND in securities_db (local): ' + sym);
        }
    });

    return secMap;
}

// Normalize company name for fuzzy matching:
// - lowercase, strip suffixes (Ltd/Limited/Pvt/Private/Inc/Corp/NV), normalize &↔and, collapse whitespace
function _importNormCompanyName(name) {
    return name.toLowerCase()
        .replace(/\b(limited|ltd|pvt|private|inc|incorporated|corp|corporation|n\.?v\.?|plc)\b\.?/gi, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Tokenize into significant words (3+ chars) for token matching
function _importTokenize(normalizedStr) {
    return normalizedStr.split(' ').filter(function(w) { return w.length >= 3; });
}

// Multi-stage symbol matching for a single row (rule F.1.6)
// Fully local: searches wmsRefData.securitiesNfo + securitiesCm in memory (zero API calls).
// NFO auto-insert is deferred to import time — new NFO symbols get _pendingNfoInsert flag.
// Returns: { status: 'confirmed'|'flagged'|'error', match: {security object}, matches: [], error: '' }
function matchSymbolMultiStage(symbol, securityType, batchMap) {
    var symUpper = symbol.toUpperCase();

    // Stage 1: If security_type is NFO, search local wmsRefData.securitiesNfo
    if (securityType === 'NFO' && wmsRefData.securitiesNfoReady) {
        var nfoArr = wmsRefData.securitiesNfo;
        // ilike contains match on symbol (case-insensitive)
        var nfoMatches = nfoArr.filter(function(n) {
            return n.symbol && n.symbol.toUpperCase().indexOf(symUpper) >= 0;
        });

        if (nfoMatches.length === 1) {
            var nfo = nfoMatches[0];
            var nfoBare = (nfo.symbol || '').replace(/^[A-Z]+:/, '');
            return { status: 'confirmed', match: {
                id: nfo.id, symbol: nfoBare, short_symbol: nfo.underlying_symbol || nfoBare,
                company_name: nfo.instrument_name || nfoBare, security_type: 'NFO',
                asset_class: nfo.instrument_type || null, exchange: nfo.exchange || 'NSE', lot_size: nfo.lot_size || 1
            }, matches: nfoMatches };
        } else if (nfoMatches.length > 1) {
            return { status: 'flagged', match: null, matches: nfoMatches.map(function(n) {
                return { id: n.id, symbol: (n.symbol || '').replace(/^[A-Z]+:/, ''), short_symbol: n.underlying_symbol, company_name: n.instrument_name, security_type: 'NFO', exchange: n.exchange };
            }) };
        }

        // No NFO match — try parsing the NFO symbol format and build a pending record
        if (nfoMatches.length === 0) {
            var parsed = parseNfoSymbol(symUpper);
            if (parsed) {
                // Look up lot_size from in-memory NFO data (find a futures contract for the same underlying)
                var lotSize = 1;
                for (var fi = 0; fi < nfoArr.length; fi++) {
                    if (nfoArr[fi].underlying_symbol === parsed.underlying &&
                        nfoArr[fi].instrument_type === 'FUTURES' &&
                        nfoArr[fi].lot_size && nfoArr[fi].lot_size > 0) {
                        lotSize = nfoArr[fi].lot_size;
                        break;
                    }
                }

                var instrType = parsed.optionType ? 'OPTIONS' : 'FUTURES';
                var instrName = parsed.underlying + ' ' + parsed.expiryStr + (parsed.strikePrice ? ' ' + parsed.strikePrice + ' ' + parsed.optionType : ' FUT');

                // Defer insert to import time — mark with _pendingNfoInsert.
                // Use parsed.fullSymbol (always NSE:-prefixed) so new records match
                // Fyers' naming convention and can be updated by NFO Sync.
                return { status: 'confirmed', match: {
                    id: null, symbol: parsed.fullSymbol, short_symbol: parsed.underlying,
                    company_name: instrName, security_type: 'NFO',
                    asset_class: instrType, exchange: 'NSE', lot_size: lotSize,
                    strike_price: parsed.strikePrice, option_type: parsed.optionType,
                    expiry_date: parsed.expiryDate,
                    _pendingNfoInsert: true,
                    _nfoRecord: {
                        symbol: parsed.fullSymbol,
                        instrument_name: instrName,
                        exchange: 'NSE',
                        instrument_type: instrType,
                        underlying_symbol: parsed.underlying,
                        expiry_date: parsed.expiryDate,
                        strike_price: parsed.strikePrice || null,
                        option_type: parsed.optionType || null,
                        lot_size: lotSize,
                        is_active: true
                    }
                }, matches: [] };
            }
        }
        // Fall through to securities_db if no NFO match and can't parse
    }

    // Stage 2: Exact match from batch map (local — already built from wmsRefData.securitiesCm)
    if (batchMap[symUpper]) {
        var match = batchMap[symUpper];
        // If security_type filter provided, check it matches
        if (securityType && securityType !== 'NFO' && match.security_type !== securityType) {
            // Type mismatch — search local securitiesCm for alternatives
            var altMatches = [match];
            var cmRows = wmsRefData.securitiesCm;
            var symLower = symUpper.toLowerCase();
            var alts = cmRows.filter(function(r) {
                var s = (r.symbol || '').toLowerCase();
                var ns = (r.nse_symbol || '').toLowerCase();
                var bs = (r.bse_symbol || '').toLowerCase();
                var cn = (r.company_name || '').toLowerCase();
                return s.indexOf(symLower) >= 0 || ns.indexOf(symLower) >= 0 ||
                       bs.indexOf(symLower) >= 0 || cn.indexOf(symLower) >= 0;
            }).slice(0, 10);
            if (alts.length > 0) {
                altMatches = alts.map(function(r) {
                    return { id: r.id, symbol: r.nse_symbol || r.bse_symbol || r.symbol, short_symbol: r.nse_symbol || r.bse_symbol || r.symbol, company_name: r.company_name, security_type: r.security_type, asset_class: r.asset_class, exchange: r.nse_symbol ? 'NSE' : 'BSE' };
                });
                var hasExact = altMatches.some(function(m) { return m.id === match.id; });
                if (!hasExact) altMatches.unshift(match);
            }
            return { status: 'flagged', match: match, matches: altMatches, error: 'Symbol found but security_type mismatch: expected ' + securityType + ', got ' + match.security_type };
        }
        return { status: 'confirmed', match: match, matches: [match] };
    }

    // Stage 3: Fuzzy company_name matching from local securitiesCm (rule F.1.6 step 2)
    // Supports: bidirectional contains, &/and normalization, suffix stripping (Ltd/Limited/Pvt etc.)
    if (wmsRefData.securitiesCmReady) {
        var cmAll = wmsRefData.securitiesCm;
        var searchNorm = _importNormCompanyName(symbol);

        // 3a: Bidirectional contains — input in DB name OR DB name in input (after normalization)
        var compMatches = cmAll.filter(function(r) {
            if (securityType && securityType !== 'NFO' && r.security_type !== securityType) return false;
            if (!r.company_name) return false;
            var dbNorm = _importNormCompanyName(r.company_name);
            return dbNorm.indexOf(searchNorm) >= 0 || searchNorm.indexOf(dbNorm) >= 0;
        });

        // 3b: If no matches, try token matching — all significant words from input must appear in DB name
        if (compMatches.length === 0) {
            var searchTokens = _importTokenize(searchNorm);
            if (searchTokens.length >= 2) {
                compMatches = cmAll.filter(function(r) {
                    if (securityType && securityType !== 'NFO' && r.security_type !== securityType) return false;
                    if (!r.company_name) return false;
                    var dbNorm = _importNormCompanyName(r.company_name);
                    return searchTokens.every(function(tok) { return dbNorm.indexOf(tok) >= 0; });
                });
            }
        }

        // 3c: If still no matches, try prefix word matching — handles truncated DB names
        // e.g. "Garuda Construction and Engineering" vs DB "GARUDA CONSTRUCT N ENG L"
        // Each DB word (3+ chars) must be a prefix of some input word, or vice versa
        // Always flags for user confirmation (never auto-confirms — too fuzzy)
        if (compMatches.length === 0) {
            var searchTokens3c = _importTokenize(searchNorm);
            if (searchTokens3c.length >= 2) {
                compMatches = cmAll.filter(function(r) {
                    if (securityType && securityType !== 'NFO' && r.security_type !== securityType) return false;
                    if (!r.company_name) return false;
                    var dbTokens = _importTokenize(_importNormCompanyName(r.company_name));
                    if (dbTokens.length === 0) return false;
                    // Every DB token must prefix-match at least one input token (or vice versa)
                    var dbMatch = dbTokens.every(function(dt) {
                        return searchTokens3c.some(function(st) {
                            return st.indexOf(dt) === 0 || dt.indexOf(st) === 0;
                        });
                    });
                    // And at least half the input tokens must prefix-match a DB token (prevents overly broad matches)
                    if (!dbMatch) return false;
                    var inputMatchCount = searchTokens3c.filter(function(st) {
                        return dbTokens.some(function(dt) {
                            return st.indexOf(dt) === 0 || dt.indexOf(st) === 0;
                        });
                    }).length;
                    return inputMatchCount >= Math.ceil(searchTokens3c.length / 2);
                });
            }
            // 3c always flags — prefix matching is fuzzy, user must confirm
            if (compMatches.length > 0) {
                var prefixCandidates = compMatches.slice(0, 10).map(function(r) {
                    return { id: r.id, symbol: r.nse_symbol || r.bse_symbol || r.symbol, short_symbol: r.nse_symbol || r.bse_symbol || r.symbol, company_name: r.company_name, security_type: r.security_type, exchange: r.nse_symbol ? 'NSE' : 'BSE' };
                });
                return { status: 'flagged', match: prefixCandidates[0], matches: prefixCandidates, error: 'Fuzzy match on "' + symbol + '" — please confirm' };
            }
        }

        compMatches = compMatches.slice(0, 10);

        if (compMatches.length === 1) {
            var cm = compMatches[0];
            return { status: 'confirmed', match: {
                id: cm.id, symbol: cm.nse_symbol || cm.bse_symbol || cm.symbol,
                short_symbol: cm.nse_symbol || cm.bse_symbol || cm.symbol,
                company_name: cm.company_name, security_type: cm.security_type || 'EQUITY',
                asset_class: cm.asset_class, exchange: cm.nse_symbol ? 'NSE' : 'BSE',
                lot_size: cm.lot_size || 1
            }, matches: compMatches };
        } else if (compMatches.length > 1) {
            return { status: 'flagged', match: null, matches: compMatches.map(function(r) {
                return { id: r.id, symbol: r.nse_symbol || r.bse_symbol || r.symbol, short_symbol: r.nse_symbol || r.bse_symbol || r.symbol, company_name: r.company_name, security_type: r.security_type, exchange: r.nse_symbol ? 'NSE' : 'BSE' };
            }) };
        }
    }

    return { status: 'error', match: null, matches: [], error: 'Symbol "' + symbol + '" not found in securities_db' + (securityType ? ' (type: ' + securityType + ')' : '') };
}

// STT eligibility — thin wrapper calling wms-shared.js canonical function
function isSTTEligible(row) {
    return wmsIsSTTEligible(row._db_security_type || row.security_type);
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
            r.brokerage = roundMoney(segCharges.brokerage / rows.length);
        } else {
            r.brokerage = roundMoney(segCharges.brokerage * proportion);
        }

        // STT: only STT-eligible trades (EQUITY only, proportional within eligible trades)
        if (r._sttEligible && sttEligibleGross > 0) {
            var sttProportion = Math.abs(r.gross_amount) / sttEligibleGross;
            r.stt = roundMoney(segCharges.stt * sttProportion);
        } else {
            r.stt = 0;
        }

        // Exchange charges, SEBI, IPFT: all trades get proportional share
        var exchShare = roundMoney(segCharges.exchangeCharges * proportion);
        var sebiShare = roundMoney(segCharges.sebiCharges * proportion);
        var ipftShare = roundMoney(segCharges.ipft * proportion);

        // Stamp duty: only STT-eligible trades (same exemption as STT)
        var stampShare = 0;
        if (r._sttEligible && sttEligibleGross > 0) {
            var stampProportion = Math.abs(r.gross_amount) / sttEligibleGross;
            stampShare = roundMoney(segCharges.stampDuty * stampProportion);
        }

        r.other_charges = roundMoney(exchShare + sebiShare + stampShare + ipftShare);

        // GST: 18% on (brokerage + exchange + SEBI) — all trades
        r.gst = roundMoney(segCharges.gst * proportion);

        r.total_charges = roundMoney(r.brokerage + r.stt + r.gst + r.other_charges);

        // net_amount = gross_amount + total_charges (charges always add for buys/outflows, subtract from sells)
        if (wmsIsBuyLikeType(r.transaction_type)) {
            r.net_amount = roundMoney(r.gross_amount + r.total_charges);
        } else {
            r.net_amount = roundMoney(r.gross_amount - r.total_charges);
        }
    });

    // STT verification: sum allocated STT vs CN total
    var allocatedStt = 0;
    rows.forEach(function(r) { allocatedStt += r.stt; });
    allocatedStt = roundMoney(allocatedStt);
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
    var cnTotalCharges = roundMoney((segCharges.brokerage || 0) + (segCharges.stt || 0) +
        (segCharges.gst || 0) + (segCharges.exchangeCharges || 0) + (segCharges.sebiCharges || 0) +
        (segCharges.stampDuty || 0) + (segCharges.ipft || 0));

    var allocatedTotalCharges = 0;
    rows.forEach(function(r) { allocatedTotalCharges += r.total_charges; });
    allocatedTotalCharges = roundMoney(allocatedTotalCharges);

    var chargeGap = roundMoney(cnTotalCharges - allocatedTotalCharges);

    if (Math.abs(chargeGap) > 0.01) {
        console.log('CN charge reconciliation: CN total=' + cnTotalCharges + ', allocated=' + allocatedTotalCharges + ', gap=' + chargeGap + ' — distributing to other_charges');

        // Distribute gap proportionally by gross_amount
        var distributed = 0;
        rows.forEach(function(r, idx) {
            var proportion = Math.abs(r.gross_amount) / totalGross;
            var share;
            if (idx === rows.length - 1) {
                // Last row gets remainder to avoid rounding drift
                share = roundMoney(chargeGap - distributed);
            } else {
                share = roundMoney(chargeGap * proportion);
            }
            r.other_charges = roundMoney(r.other_charges + share);
            r.total_charges = roundMoney(r.brokerage + r.stt + r.gst + r.other_charges);
            if (wmsIsBuyLikeType(r.transaction_type)) {
                r.net_amount = roundMoney(r.gross_amount + r.total_charges);
            } else {
                r.net_amount = roundMoney(r.gross_amount - r.total_charges);
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
// Tag Inheritance for NEW Rows — same behaviour as the Add Transaction modal
// ============================================================================
// For each NEW row (no existing DB match), look up prior transactions for the
// same investor + trader + bare-symbol combo and inherit their tags. Matching
// logic is shared with Add Transaction via `wmsFindMatchingTags()` in
// wms-shared.js so both entry paths behave identically.
//
// Data source:
//   • Prefer `trTransactions` (in-memory cache loaded by the Trading module) —
//     zero round-trips, same behaviour as Add Transaction.
//   • Fall back to a one-shot DB fetch scoped to this investor + NEW-row
//     securities when trTransactions isn't loaded yet (common when the user
//     opens Import Transactions without visiting Trading first).
//
// Safe to call from both CN import and Fyers import. Errors swallowed silently
// so a network hiccup can't block the preview.
async function _autoPopulateTagsForNewRows(newRows, investorId) {
    if (!newRows || newRows.length === 0 || !investorId) return;

    var txns = (typeof trTransactions !== 'undefined' && Array.isArray(trTransactions) && trTransactions.length > 0)
        ? trTransactions
        : null;

    // If the Trading module's transaction cache isn't populated, pull the
    // minimum needed — transactions for this investor touching the securities
    // in the NEW rows — so we can inherit tags the same way.
    if (!txns) {
        var secIds = [];
        newRows.forEach(function(r) {
            if (r.security_id && secIds.indexOf(r.security_id) === -1) secIds.push(r.security_id);
        });
        if (secIds.length === 0) return;
        try {
            var url = SUPABASE_URL + '/rest/v1/transactions?' +
                'investor_id=eq.' + encodeURIComponent(investorId) +
                '&security_id=in.(' + secIds.map(encodeURIComponent).join(',') + ')' +
                '&select=investor_id,trader_id,symbol,tags';
            var resp = await fetch(url, { headers: wmsHeaders() });
            if (!resp.ok) return;
            txns = await resp.json();
        } catch (e) {
            console.warn('Tag auto-populate fallback fetch failed (non-blocking):', e.message);
            return;
        }
    }

    newRows.forEach(function(r) {
        var hasReal = r.tags && r.tags.filter(function(t) { return t && t !== 'blank'; }).length > 0;
        if (hasReal) return;
        var traderId = r.trader_id || investorId;
        var tags = wmsFindMatchingTags(txns, investorId, traderId, r.symbol);
        if (tags.length > 0) {
            r.tags = tags.slice();
            r._tagsInheritedFrom = 'prior_txn_same_symbol';
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
        headers: wmsHeaders()
    });
    var existing = await resp.json();

    cnNewRows = [];
    cnUpdateRows = [];

    rows.forEach(function(r) {
        // Match: same symbol + same transaction_type (strip exchange prefix for consistent comparison)
        var rBare = (r.symbol || '').replace(/^[A-Z]+:/, '');
        var match = existing.find(function(e) {
            return (e.symbol || '').replace(/^[A-Z]+:/, '') === rBare && e.transaction_type === r.transaction_type;
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

    // Info banner — Date, CN Number, Investor, Broker
    var bannerDate = document.getElementById('cnBannerDate');
    var bannerCnNo = document.getElementById('cnBannerCnNo');
    var bannerInv = document.getElementById('cnBannerInvestor');
    var bannerBrk = document.getElementById('cnBannerBroker');
    if (bannerDate) bannerDate.textContent = cnTradeDate ? formatDate(cnTradeDate) : '—';
    if (bannerCnNo) bannerCnNo.textContent = cnCnNumber || '—';
    if (bannerInv && cnSelectedAccount) bannerInv.textContent = cnSelectedAccount.investor_short_name || '—';
    if (bannerBrk && cnSelectedAccount) bannerBrk.textContent = cnSelectedAccount.broker_name || cnSelectedAccount.broker_code || '—';

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

    // Unified CN preview table — single header, section dividers inside tbody.
    //   * Only one section (New OR Update only): data rows + one Total row. No
    //     section divider needed since the user already knows from stats cards.
    //   * Both sections: [NEW divider] → new rows → [NEW subtotal] →
    //     [UPDATE divider] → update rows → [UPDATE subtotal] → [GRAND TOTAL]
    var body = document.getElementById('cnPreviewBody');
    body.innerHTML = '';
    var bothSectionsExist = sortedNew.length > 0 && sortedUpdate.length > 0;

    if (sortedNew.length === 0 && sortedUpdate.length === 0) {
        document.getElementById('cnPreviewMain').style.display = 'none';
    } else {
        document.getElementById('cnPreviewMain').style.display = '';

        if (sortedNew.length > 0) {
            if (bothSectionsExist) {
                body.appendChild(createCnSectionDivider('new', 'New Transactions — will be inserted'));
            }
            sortedNew.forEach(function(r, i) { body.appendChild(createCnPreviewRow(r, i + 1)); });
            if (bothSectionsExist) {
                body.appendChild(createCnSubtotalRow(sortedNew, 'Subtotal — New'));
            } else {
                // Only New section: its Total IS the grand total — use the
                // standard per-section total style.
                body.appendChild(createCnTotalsRow(sortedNew, 'NEW'));
            }
        }

        if (sortedUpdate.length > 0) {
            if (bothSectionsExist) {
                body.appendChild(createCnSectionDivider('update', 'Existing Transactions — will be updated'));
            }
            sortedUpdate.forEach(function(r, i) { body.appendChild(createCnPreviewRow(r, i + 1)); });
            if (bothSectionsExist) {
                body.appendChild(createCnSubtotalRow(sortedUpdate, 'Subtotal — Update'));
            } else {
                body.appendChild(createCnTotalsRow(sortedUpdate, 'UPDATE'));
            }
        }

        if (bothSectionsExist) {
            body.appendChild(createCnGrandTotalRow(sortedNew.concat(sortedUpdate)));
        }
    }

    // Error rows
    var errorTbody = document.getElementById('cnErrorTableBody');
    errorTbody.innerHTML = '';
    if (cnErrorRows.length > 0) {
        document.getElementById('cnErrorSection').style.display = '';
        cnErrorRows.forEach(function(e, i) {
            var tr = document.createElement('tr');
            tr.innerHTML = '<td>' + (i+1) + '</td><td>' + e.description + '</td><td style="color:#dc2626;">' + e.error + '</td>';
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
    // Editable charge input cell — text input with comma formatting (matches app styles)
    var val = row[field] || 0;
    var inputId = 'cnChg_' + rowKey + '_' + field;
    var displayVal = cnFmtChargeVal(val);
    return '<input type="text" inputmode="decimal" id="' + inputId + '" value="' + displayVal + '" ' +
        'style="width:78px;text-align:right;padding:2px 4px;border:1px solid #e2e8f0;border-radius:3px;font-size:11px;background:#fff;" ' +
        'data-row-key="' + rowKey + '" data-field="' + field + '" class="cn-charge-input">';
}

function cnFmtChargeVal(val) {
    if (val === null || val === undefined || isNaN(val)) return '0.00';
    var abs = Math.abs(val);
    var formatted = abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return val < 0 ? '-' + formatted : formatted;
}

function createCnPreviewRow(r, idx) {
    var tr = document.createElement('tr');
    var typeClass = r.transaction_type === 'BUY' ? 'type-buy' : 'type-sell';
    var tagsValue = Array.isArray(r.tags) ? r.tags.filter(function(t) { return !!t; }).join(', ') : (r.tags || '');
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
        '<td style="width:140px;max-width:140px;position:relative;">' +
            '<div class="cn-tag-selected" id="' + tagInputId + '_pills" style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:3px;max-width:140px;"></div>' +
            '<input type="text" id="' + tagInputId + '" value="" autocomplete="off" placeholder="tags..." style="width:100%;max-width:140px;padding:3px 6px;border:1px solid #cbd5e0;border-radius:4px;font-size:11px;box-sizing:border-box;">' +
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
        // Focus: show raw number for editing
        input.addEventListener('focus', function() {
            var raw = parseFloat(input.value.replace(/,/g, '')) || 0;
            input.value = raw === 0 ? '' : raw.toFixed(2);
        });
        // Blur: reformat with commas
        input.addEventListener('blur', function() {
            var raw = parseFloat(input.value.replace(/,/g, '')) || 0;
            input.value = cnFmtChargeVal(raw);
        });
        input.addEventListener('change', function() {
            var rowKey = input.dataset.rowKey;
            var field = input.dataset.field;
            var newVal = parseFloat(input.value.replace(/,/g, '')) || 0;

            // Find the row object
            var parts = rowKey.split('_');
            var action = parts[0];
            var idx = parseInt(parts[1]);
            var row = null;
            if (action === 'NEW') row = cnNewRows[idx];
            else if (action === 'UPDATE') row = cnUpdateRows[idx];
            if (!row) return;

            // Update the field
            row[field] = roundMoney(newVal);

            // Recalculate total_charges and net_amount
            row.total_charges = roundMoney(row.brokerage + row.stt + row.gst + row.other_charges);
            if (wmsIsBuyLikeType(row.transaction_type)) {
                row.net_amount = roundMoney(row.gross_amount + row.total_charges);
            } else {
                row.net_amount = roundMoney(row.gross_amount - row.total_charges);
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
    var selected = initialValue ? initialValue.split(/[,;]/).map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; }) : [];

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

// Grand total across New + Update — combined totals for matching against the
// contract note. Styled via .cn-grand-total-row class (dark background, white
// text, prominent top border) so it visually dominates the preview table.
function createCnGrandTotalRow(rows) {
    var tr = createCnTotalsRow(rows, 'GRAND');
    // Swap the base styling applied by createCnTotalsRow with the class-based
    // grand-total styling defined in transaction-import.html.
    tr.removeAttribute('style');
    tr.className = 'cn-grand-total-row';
    var cells = tr.querySelectorAll('td');
    if (cells && cells[2]) {
        cells[2].textContent = 'Grand Total';
        cells[2].className = 'cn-grand-label';
    }
    // Strip red/green amount class so white foreground stays visible
    if (cells && cells[10]) cells[10].className = '';
    return tr;
}

// Section divider row — full-width banner separating New and Update sections
// inside the unified preview table. Only shown when both sections have data.
function createCnSectionDivider(kind, label) {
    var tr = document.createElement('tr');
    tr.className = 'cn-section-divider ' + (kind === 'update' ? 'update-section' : 'new-section');
    var td = document.createElement('td');
    td.colSpan = 12;
    td.textContent = label;
    tr.appendChild(td);
    return tr;
}

// Subtotal row for a section — lighter styling than grand total, used only
// when both sections (New + Update) are present so users can see per-section
// figures alongside the combined grand total.
function createCnSubtotalRow(rows, label) {
    var tr = createCnTotalsRow(rows, 'SUBTOTAL');
    tr.removeAttribute('style');
    tr.className = 'cn-subtotal-row';
    var cells = tr.querySelectorAll('td');
    if (cells && cells[2]) {
        cells[2].textContent = label;
        cells[2].className = 'cn-subtotal-label';
    }
    return tr;
}

// Format date as dd-MMM-yy (rule D.x — settled date format)
function formatExcelDate(dateStr) { return formatDate(dateStr); }

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
            var cnCtx = { source: 'CN', investorId: cnSelectedAccount.investor_id, brokerId: cnSelectedAccount.broker_id, tradeDate: cnTradeDate, cnNumber: cnCnNumber };
            var data = buildTransactionRecord(r, cnCtx);
            try {
                var resp = await fetchWithRetry(SUPABASE_URL + '/rest/v1/transactions', {
                    method: 'POST',
                    headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
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
            var cnCtxU = { source: 'CN', investorId: cnSelectedAccount.investor_id, brokerId: cnSelectedAccount.broker_id, tradeDate: cnTradeDate, cnNumber: cnCnNumber };
            var udata = buildTransactionRecord(ur, cnCtxU);
            delete udata.created_at; // Don't update created_at
            try {
                var uresp = await fetchWithRetry(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + ur._existingId, {
                    method: 'PATCH',
                    headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
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

        // Write import log
        await tiWriteImportLog('CN', {
            transaction_date: cnTradeDate,
            investor_id: cnSelectedAccount ? cnSelectedAccount.investor_id : null,
            broker_id: cnSelectedAccount ? cnSelectedAccount.broker_id : null,
            total_rows: totalRows,
            new_rows: insertCount,
            updated_rows: updateCount,
            error_rows: insertErrors.length + updateErrors.length + cnErrorRows.length,
            status: (insertErrors.length + updateErrors.length) > 0 ? 'PARTIAL' : 'SUCCESS',
            details: {
                cn_number: cnCnNumber,
                symbols: cnParsedRows.map(function(r) { return r.short_symbol; }),
                errors: insertErrors.concat(updateErrors),
                skipped: cnErrorRows.map(function(e) { return e.description; })
            }
        });

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

        // Reload import log display
        tiLoadImportLog();

    } catch (e) {
        console.error('Import error:', e);
        tiLoading(false);
        tiAlert('error', 'Import failed: ' + e.message);
        document.getElementById('cnImportBtn').disabled = false;
    }
};

function roundMoney(v) { return wmsRoundMoney(v); }

// ============================================================================
// Unified buildTransactionRecord — single shared builder for CN, Excel, Fyers
// ctx = { source: 'CN'|'EXCEL'|'FYERS', investorId, brokerId, tradeDate, cnNumber }
// If ctx is omitted or fields are missing, falls back to row values (Excel path).
// ============================================================================
function buildTransactionRecord(row, ctx) {
    ctx = ctx || {};
    var investorId = ctx.investorId || row.investor_id;
    var brokerId   = ctx.brokerId !== undefined ? ctx.brokerId : (row.broker_id || null);
    var tradeDate  = ctx.tradeDate || row.transaction_date;

    // Notes: source-specific default, else row value
    var notes;
    if (ctx.source === 'CN')         notes = 'Imported from CN #' + (ctx.cnNumber || '');
    else if (ctx.source === 'FYERS') notes = 'Imported from Fyers Tradebook';
    else                             notes = row.notes || null;

    // broker_contract_note_no — only CN has it
    var cnNo = (ctx.source === 'CN') ? (ctx.cnNumber || null) : null;

    // broker_trade_id — only Fyers has order numbers
    var tradeId = null;
    if (ctx.source === 'FYERS' && row._orderNumbers) {
        tradeId = row._orderNumbers.join(',');
    }

    // Transaction time: Fyers trades carry the exact fill time on the row
    // (row.transaction_time). CN parsers will populate it later; Excel imports
    // leave it null. Undefined → null (so JSON payload serialises cleanly).
    var txnTime = (row.transaction_time !== undefined && row.transaction_time !== null)
        ? row.transaction_time : null;

    return {
        investor_id: investorId,
        broker_id: brokerId,
        trader_id: row.trader_id || investorId,
        security_id: row.security_id,
        security_type: row.security_type || 'EQUITY',
        symbol: row.symbol,
        short_symbol: row.short_symbol || row.symbol,
        company_name: row.company_name || row.symbol,
        exchange: row.exchange || 'NSE',
        product: null,
        transaction_type: row.transaction_type,
        transaction_date: tradeDate,
        transaction_time: txnTime,
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
        broker_contract_note_no: cnNo,
        broker_trade_id: tradeId,
        tags: (row.tags && row.tags.length > 0) ? row.tags : ['blank'],
        notes: notes,
        is_locked: false,
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
        // Normalize aliases from external tools (MProfit, etc.) to WMS-standard types
        var TYPE_ALIASES = {
            'DIVIDEND_PAYOUT': 'DIVIDEND', 'DIVIDEND_INCOME': 'DIVIDEND', 'DIV': 'DIVIDEND',
            'PURCHASE': 'BUY', 'SALE': 'SELL',
            'CAP_REDUCTION': 'CAPITAL_REDUCTION', 'CAPITAL_REPAYMENT': 'CAPITAL_REDUCTION',
            'STOCK_SPLIT': 'SPLIT', 'STOCK_BONUS': 'BONUS'
        };
        if (transaction_type_raw && TYPE_ALIASES[transaction_type_raw]) {
            transaction_type_raw = TYPE_ALIASES[transaction_type_raw];
        }
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

        // Quantity validation — mandatory for ALL types including income
        var isIncome = transaction_type ? isIncomeType(transaction_type) : false;
        if (quantity_raw === null || quantity_raw === 0) {
            errors.push('quantity is required for ' + (transaction_type || 'all') + ' transactions');
        }

        // Price validation — income types: price can be derived from amount/qty
        if (!isIncome && (price_raw === null || price_raw === 0) && (gross_amount_raw === null || gross_amount_raw === 0)) {
            errors.push('price is required');
        }
        if (isIncome && (price_raw === null || price_raw === 0) && (gross_amount_raw === null || gross_amount_raw === 0)) {
            errors.push('price or amount is required for income transactions');
        }

        // If errors, build a partial review row (visible in preview, not importable)
        if (errors.length > 0) {
            excelErrorRows.push({ rowNum: rowNum, errors: errors, raw: row });
            validRows.push({
                rowNum: rowNum,
                investor_id: investorMatch ? investorMatch.id : null,
                investor_name: investorMatch ? investorMatch.name : (investor_name || ''),
                trader_id: null, trader_name: trader_name || '',
                broker_id: brokerMatch ? brokerMatch.id : null,
                broker_name: brokerMatch ? brokerMatch.name : (broker_name || ''),
                symbol: symbol_raw || '—',
                security_type: security_type_raw,
                transaction_type: transaction_type || '—',
                transaction_date: dateResult ? dateResult.date : '',
                quantity: quantity_raw || 0,
                price: price_raw || 0,
                gross_amount: gross_amount_raw || 0,
                brokerage: 0, stt: 0, total_charges: 0, trader_charges: 0,
                net_amount: 0, tags: ['blank'], notes: notes_raw,
                security_id: null, short_symbol: null, company_name: null,
                exchange: null, asset_class: null, lots: 0,
                other_charges: 0, gst: 0, tds: 0,
                matchStatus: 'error',
                matchError: errors.join('; '),
                matchOptions: null,
                _totalOverride: false, _netOverride: false,
                _exchange_charges: 0, _sebi_charges: 0, _stamp_duty: 0, _ipft: 0,
                _chargesBasis: {},
                _stageAError: true
            });
            return;
        }

        // Quantity sign enforcement (rule F.2.7)
        var quantity = quantity_raw || 0;
        if (transaction_type === 'BUY') quantity = Math.abs(quantity);
        else if (transaction_type === 'SELL') quantity = -Math.abs(quantity);
        else if (isIncome) quantity = Math.abs(quantity);  // Income types: always positive, user must provide qty

        // Price derivation: if price is blank but amount and qty exist, calculate price = amount / qty
        var price = price_raw || 0;
        if ((!price_raw || price_raw === 0) && gross_amount_raw && quantity !== 0) {
            price = roundMoney(gross_amount_raw / Math.abs(quantity));
        }

        // Gross amount (rule F.2.1)
        var gross_amount = gross_amount_raw;
        if ((gross_amount === null || isNaN(gross_amount)) && quantity !== 0 && price) {
            gross_amount = roundMoney(Math.abs(quantity) * price);
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
            price: price,
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

    var nonErrorCount = validRows.filter(function(r) { return !r._stageAError; }).length;
    console.log('Stage A complete: ' + nonErrorCount + ' valid, ' + excelErrorRows.length + ' errors (all shown in preview)');

    if (validRows.length === 0) {
        tiAlert('error', 'No rows found in the file.');
        return;
    }

    // ── Stage B: Symbol Matching + Charge Calculation ────────────────
    // Fully local: uses wmsRefData.securitiesCm/securitiesNfo (loaded at app startup)
    tiLoading(true, 'Matching symbols (' + validRows.length + ' rows)...');

    // Ensure securities master data is loaded
    if (!wmsRefData.securitiesCmReady) {
        tiLoading(true, 'Loading securities data...');
        await wmsLoadSecuritiesCm(0, {all: true});
    }
    if (!wmsRefData.securitiesNfoReady) {
        await wmsLoadSecuritiesNfo();
    }

    // Collect unique symbols for local batch lookup (non-NFO rows, skip Stage A errors)
    var uniqueSymbols = [];
    validRows.forEach(function(r) {
        if (r._stageAError) return;
        var sym = r.symbol.toUpperCase();
        if (r.security_type !== 'NFO' && uniqueSymbols.indexOf(sym) < 0) {
            uniqueSymbols.push(sym);
        }
    });

    // Local batch lookup from in-memory securitiesCm (zero API calls)
    var batchMap = batchMatchSecurities(uniqueSymbols);

    // Match each row (all local — no await needed)
    for (var i = 0; i < validRows.length; i++) {
        var vr = validRows[i];

        // Skip Stage A error rows — already marked, no symbol matching needed
        if (vr._stageAError) continue;

        var matchResult = matchSymbolMultiStage(vr.symbol, vr.security_type, batchMap);

        vr.matchStatus = matchResult.status;
        vr.matchOptions = matchResult.matches || [];
        vr.matchError = matchResult.error || null;

        if (matchResult.status === 'confirmed' && matchResult.match) {
            vr.security_id = matchResult.match.id;
            vr.symbol = matchResult.match.short_symbol || matchResult.match.symbol;
            vr.short_symbol = matchResult.match.short_symbol;
            vr.company_name = matchResult.match.company_name;
            vr.exchange = matchResult.match.exchange;
            vr.asset_class = matchResult.match.asset_class;
            if (!vr.security_type) vr.security_type = matchResult.match.security_type;
            // Carry pending NFO insert data for deferred insert at import time
            if (matchResult.match._pendingNfoInsert) {
                vr._pendingNfoInsert = true;
                vr._nfoRecord = matchResult.match._nfoRecord;
            }

            // Lots: NFO & EQUITY_SME must have non-zero lots; others must be 0
            var needsLots = (vr.security_type === 'NFO' || vr.security_type === 'EQUITY_SME');
            if (needsLots && matchResult.match.lot_size && matchResult.match.lot_size > 1) {
                vr.lots = roundMoney(Math.abs(vr.quantity) / matchResult.match.lot_size);
                if (vr.transaction_type === 'SELL') vr.lots = -Math.abs(vr.lots);
            } else if (needsLots) {
                vr.lots = vr.transaction_type === 'SELL' ? -1 : 1;
            } else {
                vr.lots = 0;
            }
        } else if (matchResult.status === 'flagged') {
            // Use first match as tentative
            if (matchResult.matches.length > 0) {
                var first = matchResult.matches[0];
                vr.security_id = first.id;
                vr.symbol = first.short_symbol || first.symbol;
                vr.short_symbol = first.short_symbol || first.symbol;
                vr.company_name = first.company_name;
                vr.exchange = first.exchange;
                if (!vr.security_type) vr.security_type = first.security_type;
                // NFO & EQUITY_SME: lots must not be 0, calculate from lot_size or default ±1
                var flagNeedsLots = (vr.security_type === 'NFO' || vr.security_type === 'EQUITY_SME');
                if (flagNeedsLots && first.lot_size && first.lot_size > 1) {
                    vr.lots = roundMoney(Math.abs(vr.quantity) / first.lot_size);
                    if (vr.transaction_type === 'SELL') vr.lots = -Math.abs(vr.lots);
                } else if (flagNeedsLots) {
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

    // Classify rows — errors and flagged both become 'review' (visible in preview, not importable)
    excelConfirmedRows = [];
    excelFlaggedRows = [];
    validRows.forEach(function(r) {
        if (r.matchStatus === 'confirmed') {
            excelConfirmedRows.push(r);
        } else {
            // Both 'flagged' (multiple matches) and 'error' (symbol not found) → review
            r.matchStatus = 'review';
            if (!r.matchError) r.matchError = 'Symbol not found: ' + r.symbol;
            excelFlaggedRows.push(r);
        }
    });

    console.log('Stage B complete: ' + excelConfirmedRows.length + ' confirmed, ' + excelFlaggedRows.length + ' flagged, ' + excelErrorRows.length + ' errors');

    // ── Stage C: Duplicate Detection (single batched query) ─────────
    tiLoading(true, 'Checking for duplicates...');

    var allGoodRows = excelConfirmedRows.concat(excelFlaggedRows);

    // Initialize all rows as new
    allGoodRows.forEach(function(r) { r.isUpdate = false; r._existingId = null; });

    // Collect unique dates and investor_ids for a single OR query
    var uniqueDates = [];
    var uniqueInvestorIds = [];
    allGoodRows.forEach(function(r) {
        if (r.transaction_date && uniqueDates.indexOf(r.transaction_date) < 0) uniqueDates.push(r.transaction_date);
        if (r.investor_id && uniqueInvestorIds.indexOf(r.investor_id) < 0) uniqueInvestorIds.push(r.investor_id);
    });

    if (uniqueDates.length > 0 && uniqueInvestorIds.length > 0) {
        try {
            // Single query: fetch all existing transactions for these investor+date combos
            var dupUrl = SUPABASE_URL + '/rest/v1/transactions?select=id,investor_id,broker_id,symbol,transaction_type,transaction_date,quantity,price' +
                '&investor_id=in.(' + uniqueInvestorIds.join(',') + ')' +
                '&transaction_date=in.(' + uniqueDates.join(',') + ')';
            var dupResp = await fetch(dupUrl, {
                headers: wmsHeaders()
            });
            var existingTxns = await dupResp.json();

            // Build lookup: "investor_id|broker_id|date|symbol|type" → existing txn
            var existMap = {};
            existingTxns.forEach(function(ex) {
                var eKey = (ex.investor_id || '') + '|' + (ex.broker_id || '') + '|' + ex.transaction_date + '|' + ex.symbol + '|' + ex.transaction_type;
                existMap[eKey] = ex;
            });

            // Match import rows against existing
            allGoodRows.forEach(function(r) {
                var rKey = (r.investor_id || '') + '|' + (r.broker_id || '') + '|' + r.transaction_date + '|' + r.symbol + '|' + r.transaction_type;
                var existing = existMap[rKey];
                if (existing) {
                    r.isUpdate = true;
                    r._existingId = existing.id;
                }
            });

            console.log('Duplicate check: ' + existingTxns.length + ' existing txns found in 1 query');
        } catch (e) {
            console.error('Duplicate check error:', e);
        }
    }

    console.log('Stage C complete. Ready for preview.');

    // Store all parsed transactions for reference
    parsedTransactions = allGoodRows;

    // Show preview (set source before display so title/routing are correct)
    setImportSource('EXCEL');
    displayExcelPreview();
}

// ============================================================================
// Excel Preview Modal
// ============================================================================

function displayExcelPreview() {
    var allRows = excelConfirmedRows.concat(excelFlaggedRows);
    var confirmedCount = excelConfirmedRows.length;
    var reviewCount = excelFlaggedRows.length;

    // Update sticky summary bar
    document.getElementById('statTotal').textContent = allRows.length;
    document.getElementById('statConfirmed').textContent = confirmedCount;
    document.getElementById('statReview').textContent = reviewCount;

    // Sub-labels: clickable sub-filters for new/update and validation/symbol
    var newCount = excelConfirmedRows.filter(function(r) { return !r.isUpdate; }).length;
    var updCount = excelConfirmedRows.filter(function(r) { return r.isUpdate; }).length;
    var confirmedSub = document.getElementById('statConfirmedSub');
    if (confirmedSub) {
        var cParts = [];
        if (newCount > 0) cParts.push('<span class="esc-sub-link' + (excelActiveFilter === 'confirmed_new' ? ' esc-sub-active' : '') + '" onclick="event.stopPropagation();excelFilterRows(\'confirmed_new\')">' + newCount + ' new</span>');
        if (updCount > 0) cParts.push('<span class="esc-sub-link' + (excelActiveFilter === 'confirmed_update' ? ' esc-sub-active' : '') + '" onclick="event.stopPropagation();excelFilterRows(\'confirmed_update\')">' + updCount + ' update</span>');
        confirmedSub.innerHTML = cParts.join(' · ');
    }
    var stageACount = excelFlaggedRows.filter(function(r) { return r._stageAError; }).length;
    var symbolCount = reviewCount - stageACount;
    var reviewSub = document.getElementById('statReviewSub');
    if (reviewSub) {
        var rParts = [];
        if (stageACount > 0) rParts.push('<span class="esc-sub-link' + (excelActiveFilter === 'review_validation' ? ' esc-sub-active' : '') + '" onclick="event.stopPropagation();excelFilterRows(\'review_validation\')">' + stageACount + ' validation</span>');
        if (symbolCount > 0) rParts.push('<span class="esc-sub-link' + (excelActiveFilter === 'review_symbol' ? ' esc-sub-active' : '') + '" onclick="event.stopPropagation();excelFilterRows(\'review_symbol\')">' + symbolCount + ' symbol</span>');
        reviewSub.innerHTML = rParts.join(' · ');
    }

    // Highlight active filter card (sub-filters highlight their parent card)
    var parentFilter = excelActiveFilter.split('_')[0]; // 'confirmed_new' → 'confirmed'
    document.querySelectorAll('.excel-summary-card').forEach(function(card) {
        card.classList.toggle('active', card.dataset.filter === excelActiveFilter || card.dataset.filter === parentFilter);
    });

    // Apply filter (including sub-filters)
    var displayRows = allRows;
    if (excelActiveFilter === 'confirmed') {
        displayRows = excelConfirmedRows.slice();
    } else if (excelActiveFilter === 'confirmed_new') {
        displayRows = excelConfirmedRows.filter(function(r) { return !r.isUpdate; });
    } else if (excelActiveFilter === 'confirmed_update') {
        displayRows = excelConfirmedRows.filter(function(r) { return r.isUpdate; });
    } else if (excelActiveFilter === 'review') {
        displayRows = excelFlaggedRows.slice();
    } else if (excelActiveFilter === 'review_validation') {
        displayRows = excelFlaggedRows.filter(function(r) { return r._stageAError; });
    } else if (excelActiveFilter === 'review_symbol') {
        displayRows = excelFlaggedRows.filter(function(r) { return !r._stageAError; });
    }

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

    displayRows.forEach(function(t) {
        // Use allRows index for data integrity (charge edits, tag reads, etc.)
        var index = allRows.indexOf(t);
        var isReview = (t.matchStatus === 'review');
        var row = document.createElement('tr');
        var typeClass = t.transaction_type === 'BUY' ? 'type-buy' : t.transaction_type === 'SELL' ? 'type-sell' : 'type-other';

        // Status badge — show REVIEW for all review rows (both flagged and error)
        var statusBadge = '';
        if (isReview) {
            var reviewTitle = t.matchError || 'Needs review';
            var hasOptions = (t.matchOptions || []).length > 0;
            statusBadge = '<span class="review-badge" data-row="' + index + '" title="' + reviewTitle.replace(/"/g, '&quot;') + (hasOptions ? ' — click to resolve' : '') + '">REVIEW</span> ';
        }
        var dupBadge = '';
        if (!isReview) {
            dupBadge = t.isUpdate ? '<span style="background:#feebc8;color:#744210;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;margin-left:4px;">UPD</span>' : '<span style="background:#c6f6d5;color:#22543d;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;margin-left:4px;">NEW</span>';
        }

        // Type abbreviation with tooltip
        var typeAbbr = t.transaction_type;
        var typeShort = typeAbbr.length > 4 ? typeAbbr.substring(0, 4) : typeAbbr;

        // Symbol display — truncate and use tooltip for full name
        var symbolDisplay = t.short_symbol || t.symbol;
        var symbolTitle = t.symbol + (t.company_name ? ' — ' + t.company_name : '') + (t.exchange ? ' (' + t.exchange + ')' : '');
        if (isReview && t.matchError) symbolTitle += '\n⚠ ' + t.matchError;

        // Double-click-to-edit charge display cells
        var chargesDisplay = '<span class="charge-display" data-row="' + index + '" data-field="total_charges" title="Double-click for breakdown">' + formatCnAmount(t.total_charges || 0) + '</span>';
        var traderChargesDisplay = '<span class="charge-display" data-row="' + index + '" data-field="trader_charges" title="Double-click for breakdown">' + formatCnAmount(t.trader_charges || 0) + '</span>';

        // Tooltip info for each cell
        var invLabel = buildInvLabel(t);
        var invTooltip = 'Investor: ' + (t.investor_name || t.investor_id || '') + '\nBroker: ' + (t.broker_name || t.broker_id || '') + (t.trader_id && t.trader_id !== t.investor_id ? '\nTrader: ' + (t.trader_name || t.trader_id) : '');
        var dateTooltip = t.transaction_date || '';

        // Tags display — autocomplete pill input (same as CN import)
        var tagsArr = Array.isArray(t.tags) ? t.tags.filter(function(tg) { return !!tg; }) : (t.tags ? [t.tags] : []);
        var excelTagId = 'excelTag_' + index;
        var tagsHtml = '<div class="cn-tag-selected" id="' + excelTagId + '_pills" style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:3px;"></div>' +
            '<input type="text" id="' + excelTagId + '" value="" autocomplete="off" placeholder="tags..." ' +
            'style="width:100%;padding:3px 6px;border:1px solid #cbd5e0;border-radius:4px;font-size:11px;" ' +
            'data-row="' + index + '">' +
            '<div class="cn-tag-dropdown" id="' + excelTagId + '_dd" style="display:none;position:absolute;z-index:100;left:0;right:0;max-height:120px;overflow-y:auto;background:#fff;border:1px solid #cbd5e0;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.12);margin-top:2px;"></div>';

        row.dataset.rowIdx = index;
        // Review rows: no checkbox (not importable). Confirmed: checked unless it's an update.
        var checkboxHtml = '';
        if (isReview) {
            checkboxHtml = '<td style="text-align:center;"><span style="font-size:10px;color:#d97706;" title="Resolve to import">⚠</span></td>';
        } else {
            var isChecked = t.isUpdate ? '' : ' checked';
            checkboxHtml = '<td style="text-align:center;"><input type="checkbox" class="excel-row-cb" data-row="' + index + '"' + isChecked + '></td>';
        }
        row.innerHTML = checkboxHtml +
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

        if (isReview) {
            row.classList.add('excel-review-row');
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

    // Lazy-init tag autocomplete — only initialize when input is focused (saves ~1-2s for 40+ rows)
    displayRows.forEach(function(t) {
        var index = allRows.indexOf(t);
        var input = document.getElementById('excelTag_' + index);
        if (!input) return;
        var tagsValue = Array.isArray(t.tags) ? t.tags.filter(function(tg) { return !!tg; }).join(', ') : (t.tags || '');
        // Store initial value; init on first focus
        input.dataset.initialTags = tagsValue;
        input.dataset.tagInited = 'false';
        input.addEventListener('focus', function() {
            if (this.dataset.tagInited === 'false') {
                this.dataset.tagInited = 'true';
                initTagAutocomplete(this.id, this.dataset.initialTags);
            }
        });
        // Always store in data-tags so import can read them even if never focused
        input.dataset.tags = tagsValue || '';
        // Pre-render pills for rows that already have tags (visual only, no dropdown wiring)
        if (tagsValue) {
            var pillsDiv = document.getElementById('excelTag_' + index + '_pills');
            if (pillsDiv) {
                tagsValue.split(',').forEach(function(tag) {
                    tag = tag.trim();
                    if (!tag) return;
                    var pill = document.createElement('span');
                    pill.className = 'cn-tag-pill';
                    pill.textContent = tag;
                    pill.style.cssText = 'background:#edf2f7;color:#2d3748;padding:1px 6px;border-radius:3px;font-size:10px;display:inline-block;';
                    pillsDiv.appendChild(pill);
                });
            }
        }
    });

    // Show summary alert
    var summaryParts = [confirmedCount + ' confirmed'];
    if (updCount > 0) summaryParts.push(updCount + ' updates');
    if (reviewCount > 0) summaryParts.push(reviewCount + ' need review');
    tiAlert(reviewCount > 0 ? 'warning' : 'info', summaryParts.join(', ') + (reviewCount > 0 ? '. Review rows must be resolved before import.' : '.'));

    // Update select-all and import button count (updates are unchecked by default)
    updateSelectAllState();
    updateImportBtnCount();

    // Open modal overlay
    document.getElementById('excelPreviewOverlay').classList.add('active');
}

// Summary bar filter — click cards or sub-labels to filter the table
// Clicking an active filter toggles it off (back to parent or 'all')
function excelFilterRows(filter) {
    if (excelActiveFilter === filter) {
        // Toggle off: sub-filter → parent, parent → all
        var parent = filter.split('_')[0];
        excelActiveFilter = (parent === filter) ? 'all' : parent;
    } else {
        excelActiveFilter = filter;
    }
    displayExcelPreview();
}
window.excelFilterRows = excelFilterRows;

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
    excelFlaggedRows = allRows.filter(function(r) { return r.matchStatus === 'review'; });
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
        var msg = row && row.matchError ? row.matchError : 'No alternative matches available for this row.';
        tiAlert('warning', msg);
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
            row.symbol = match.short_symbol || match.symbol;
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
            cell.innerHTML = '<input type="text" inputmode="decimal" value="' + cnFmtChargeVal(currentVal) + '" style="width:80px;font-size:11px;text-align:right;border:1px solid #667eea;border-radius:3px;padding:1px 3px;">';
            var inp = cell.querySelector('input');
            inp.focus();
            inp.select();
            function commit() {
                var newVal = parseFloat(inp.value.replace(/,/g, ''));
                if (!isNaN(newVal)) {
                    row.net_amount = roundMoney(newVal);
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
                    row.tags = row.tags.filter(function(t) { return !!t; });
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
    var calcTotal = roundMoney((row.brokerage || 0) + (row.stt || 0) + (row.other_charges || 0) + (row.gst || 0));
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
        row.other_charges = roundMoney((row._exchange_charges || 0) + (row._sebi_charges || 0) + (row._stamp_duty || 0));
    }

    // Recalculate total_charges from individual charge components (unless user override)
    if (!row._totalOverride) {
        row.total_charges = roundMoney((row.brokerage || 0) + (row.stt || 0) + (row.other_charges || 0) + (row.gst || 0));
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
    // Only count confirmed rows that are checked (review rows have no checkboxes)
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
    if (wmsIsBuyLikeType(row.transaction_type)) {
        row.net_amount = roundMoney(row.gross_amount + row.total_charges);
    } else if (row.transaction_type === 'SELL') {
        row.net_amount = roundMoney(row.gross_amount - row.total_charges);
    } else if (isIncomeType(row.transaction_type)) {
        row.net_amount = roundMoney(row.gross_amount - row.total_charges);
    }

    // Update net display
    var netCell = document.getElementById('excelNet_' + index);
    if (netCell) netCell.textContent = formatCnAmount(row.net_amount);
}

// Build Supabase-ready transaction record from Excel row (rules F.3.1–F.3.5)
// Delegates to unified buildTransactionRecord(); row already has investor_id, broker_id, etc.
function buildExcelTransactionRecord(row) {
    return buildTransactionRecord(row, { source: 'EXCEL' });
}

// Import confirmed rows to database — Excel-specific prep, then shared performImport()
async function importExcelToDatabase() {
    // Only consider confirmed rows (review rows are never imported)
    var allRows = excelConfirmedRows.slice();
    if (allRows.length === 0) { tiAlert('error', 'No confirmed transactions to import'); return; }

    // Build index map: allRows index → row (for checkbox data-row matching)
    var fullList = excelConfirmedRows.concat(excelFlaggedRows);

    // Filter to only checked (included) rows using checkbox data-row attribute
    var checkedCbs = document.querySelectorAll('#previewTableBody .excel-row-cb:checked');
    var includedIndices = {};
    checkedCbs.forEach(function(cb) { includedIndices[cb.dataset.row] = true; });
    allRows = allRows.filter(function(r) {
        var idx = fullList.indexOf(r);
        return includedIndices[idx];
    });
    if (allRows.length === 0) { tiAlert('error', 'No rows selected for import'); return; }

    // Safety: skip rows with null security_id or zero quantity (DB constraints)
    var skippedRows = allRows.filter(function(r) { return !r.security_id || r.quantity === 0; });
    if (skippedRows.length > 0) {
        var skipSymbols = skippedRows.map(function(r) { return r.symbol + ((!r.security_id) ? ' [no security match]' : ' [qty=0]'); });
        console.warn('Skipping ' + skippedRows.length + ' rows with invalid data: ' + skipSymbols.join(', '));
    }
    allRows = allRows.filter(function(r) { return r.security_id && r.quantity !== 0; });
    if (allRows.length === 0) { tiAlert('error', 'No valid rows to import (all skipped due to missing security_id or zero quantity)'); return; }

    // Recalc net unless user-entered (dblclick inline edit)
    allRows.forEach(function(r) {
        if (r._netOverride) return;
        if (wmsIsBuyLikeType(r.transaction_type)) r.net_amount = roundMoney(r.gross_amount + r.total_charges);
        else if (r.transaction_type === 'SELL') r.net_amount = roundMoney(r.gross_amount - r.total_charges);
        else if (isIncomeType(r.transaction_type)) r.net_amount = roundMoney(r.gross_amount - r.total_charges);
    });

    // Read tags from autocomplete pill inputs (fullList index, not filtered index)
    allRows.forEach(function(r) {
        var tagIdx = fullList.indexOf(r);
        var input = document.getElementById('excelTag_' + tagIdx);
        if (input && input.dataset.tags !== undefined) {
            var val = (input.dataset.tags || '').trim();
            var parsed = val ? val.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; }) : [];
            r.tags = parsed.length > 0 ? parsed : ['blank'];
        }
    });

    var newRows = allRows.filter(function(r) { return !r.isUpdate; });
    var updateRows = allRows.filter(function(r) { return r.isUpdate; });

    await performImport({
        source: 'EXCEL',
        newRows: newRows,
        updateRows: updateRows,
        errorRows: skippedRows,
        buildRecord: buildExcelTransactionRecord,
        overlayId: 'excelPreviewOverlay',
        importBtnId: 'importBtn',
        onReset: function() {
            parsedTransactions = [];
            excelConfirmedRows = [];
            excelFlaggedRows = [];
            excelErrorRows = [];
            _sortHandlersAttached = false;
            document.getElementById('fileInput').value = '';
        }
    });
}

window.importToDatabase = function() {
    if (_currentImportSource === 'FYERS') {
        fyImportToDatabase();
    } else {
        importExcelToDatabase();
    }
};
window.recalcExcelRow = recalcExcelRow;
window.cancelImport = function() {
    document.getElementById('excelPreviewOverlay').classList.remove('active');
    // Source-specific state reset
    if (_currentImportSource === 'FYERS') {
        fyParsedRows = []; fyNewRows = []; fyUpdateRows = []; fyErrorRows = [];
        fyTradeDate = null;
        var fyStatus = document.getElementById('fyFetchStatus');
        if (fyStatus) fyStatus.textContent = '';
    } else {
        parsedTransactions = [];
        var fileInput = document.getElementById('fileInput');
        if (fileInput) fileInput.value = '';
    }
    // Shared state reset
    excelConfirmedRows = []; excelFlaggedRows = []; excelErrorRows = [];
    _sortHandlersAttached = false;
    tiAlert('info', 'Import cancelled.');
};
window.cancelFyImport = window.cancelImport;  // alias for any remaining references

// ============================================================================
// UI Helpers
// ============================================================================

// Named tiAlert/tiLoading to avoid conflict with const showAlert/showLoading in utils.js
function tiAlert(type, message) {
    var container = document.getElementById('alertContainer');
    var alertClass = type === 'success' ? 'alert-success' : type === 'error' ? 'alert-error' : type === 'info' ? 'alert-info' : 'alert-warning';
    // Ensure alert appears above modals (excel preview overlay is z-index:1100)
    container.style.position = 'fixed';
    container.style.top = '70px';
    container.style.left = '50%';
    container.style.transform = 'translateX(-50%)';
    container.style.zIndex = '1200';
    container.style.width = 'auto';
    container.style.maxWidth = '600px';
    var el = document.createElement('div');
    el.className = 'alert ' + alertClass;
    el.textContent = message;
    container.innerHTML = '';
    container.appendChild(el);
    setTimeout(function() { el.style.opacity = '0'; setTimeout(function() { el.remove(); }, 300); }, 5000);
}

function tiLoading(show, text) {
    var loader = document.getElementById('loadingIndicator');
    loader.classList.toggle('hidden', !show);
    if (text) document.getElementById('loadingText').textContent = text;
}

// Expose globals for onclick handlers in HTML
// (importToDatabase, recalcExcelRow, cancelImport already set above)
// (importCnToDatabase, cancelCnImport already set via window.xxx = async function() above)


// ============================================================================
// SHARED IMPORT ENGINE — used by Excel, Fyers (and future sources)
// ============================================================================
// cfg: { source, newRows, updateRows, errorRows, buildRecord, overlayId,
//        importBtnId, investorId, brokerId, tradeDate, onReset }

var _importInProgress = false;

async function performImport(cfg) {
    if (_importInProgress) { tiAlert('warning', 'Import already in progress...'); return; }

    var totalRows = cfg.newRows.length + cfg.updateRows.length;
    if (totalRows === 0) { tiAlert('error', 'No transactions to import.'); return; }

    if (!confirm('Import ' + cfg.newRows.length + ' new + ' + cfg.updateRows.length + ' updates = ' + totalRows + ' transactions from ' + cfg.source + '?')) return;

    _importInProgress = true;
    tiLoading(true, 'Importing ' + cfg.source + ' transactions...');
    var btn = document.getElementById(cfg.importBtnId);
    if (btn) { btn.disabled = true; btn.textContent = 'Importing...'; }

    var insertCount = 0, updateCount = 0;
    var importErrors = [];
    var allRows = cfg.newRows.concat(cfg.updateRows);

    try {
        // ── Step 0: Insert pending NFO securities ──
        var pendingNfoRows = allRows.filter(function(r) { return r._pendingNfoInsert && r._nfoRecord; });
        if (pendingNfoRows.length > 0) {
            tiLoading(true, 'Registering ' + pendingNfoRows.length + ' new NFO securities...');
            var nfoBySymbol = {};
            pendingNfoRows.forEach(function(r) {
                if (!nfoBySymbol[r._nfoRecord.symbol]) {
                    nfoBySymbol[r._nfoRecord.symbol] = { record: r._nfoRecord, rows: [r] };
                } else {
                    nfoBySymbol[r._nfoRecord.symbol].rows.push(r);
                }
            });
            var nfoBatch = Object.keys(nfoBySymbol).map(function(sym) { return nfoBySymbol[sym].record; });
            try {
                var nfoResp = await fetch(SUPABASE_URL + '/rest/v1/securities_nfo', {
                    method: 'POST',
                    headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
                    body: JSON.stringify(nfoBatch)
                });
                if (nfoResp.ok) {
                    var insertedNfos = await nfoResp.json();
                    insertedNfos.forEach(function(ins) {
                        var entry = nfoBySymbol[ins.symbol];
                        if (entry) {
                            entry.rows.forEach(function(r) { r.security_id = ins.id; });
                            console.log('NFO inserted: ' + ins.symbol + ' → ' + ins.id);
                            var exchPrefix = (ins.exchange || 'NSE').toUpperCase();
                            var fSym = ins.symbol.indexOf(':') >= 0 ? ins.symbol : exchPrefix + ':' + ins.symbol;
                            if (typeof wmsUpdateNfoBrokerToken === 'function') {
                                wmsUpdateNfoBrokerToken(ins.id, fSym);
                            }
                        }
                    });
                    if (typeof wmsLoadSecuritiesNfo === 'function') await wmsLoadSecuritiesNfo();
                } else {
                    var nfoErr = await nfoResp.json();
                    importErrors.push('NFO batch insert: ' + (nfoErr.message || nfoErr.details || 'HTTP ' + nfoResp.status));
                    console.error('NFO batch insert failed:', nfoErr);
                }
            } catch (nfoE) {
                importErrors.push('NFO batch insert: ' + nfoE.message);
                console.error('NFO batch insert error:', nfoE);
            }

            // Remove rows where NFO insert failed (security_id still null)
            var nfoFailedRows = allRows.filter(function(r) { return r._pendingNfoInsert && !r.security_id; });
            if (nfoFailedRows.length > 0) {
                console.warn('Skipping ' + nfoFailedRows.length + ' rows: NFO security insert failed');
                importErrors.push(nfoFailedRows.length + ' NFO rows skipped (security insert failed): ' + nfoFailedRows.map(function(r) { return r.symbol; }).join(', '));
                cfg.newRows = cfg.newRows.filter(function(r) { return !r._pendingNfoInsert || r.security_id; });
                cfg.updateRows = cfg.updateRows.filter(function(r) { return !r._pendingNfoInsert || r.security_id; });
            }
            tiLoading(true, 'Importing ' + cfg.source + ' transactions...');
        }

        // ── INSERT new rows in batches of 10 (rule C.2.2) ──
        var insertRecords = cfg.newRows.map(cfg.buildRecord);
        for (var i = 0; i < insertRecords.length; i += 10) {
            var batch = insertRecords.slice(i, i + 10);
            try {
                var resp = await fetchWithRetry(SUPABASE_URL + '/rest/v1/transactions', {
                    method: 'POST',
                    headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'}),
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

        // ── UPDATE existing rows via PATCH (rule A.2.2) ──
        for (var j = 0; j < cfg.updateRows.length; j++) {
            var ur = cfg.updateRows[j];
            var rec = cfg.buildRecord(ur);
            delete rec.created_at;
            try {
                var uresp = await fetchWithRetry(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + ur._existingId, {
                    method: 'PATCH',
                    headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'}),
                    body: JSON.stringify(rec)
                }, 3);
                if (!uresp.ok) {
                    var uErrBody = await uresp.json();
                    importErrors.push('Update ' + (ur.short_symbol || ur.symbol) + ': ' + (uErrBody.message || 'HTTP ' + uresp.status));
                } else {
                    updateCount++;
                }
            } catch (e) {
                importErrors.push('Update ' + (ur.short_symbol || ur.symbol) + ': ' + e.message + ' (after 3 retries)');
            }
            // Rate limit pause every 10 updates
            if (j > 0 && j % 10 === 0) await new Promise(function(r) { setTimeout(r, 200); });
        }

        // ── Write import log ──
        var errorRowCount = (cfg.errorRows ? cfg.errorRows.length : 0);
        await tiWriteImportLog(cfg.source, {
            transaction_date: cfg.tradeDate || (allRows.length > 0 ? allRows[0].transaction_date : null),
            investor_id: cfg.investorId || (allRows.length > 0 ? allRows[0].investor_id : null),
            broker_id: cfg.brokerId || (allRows.length > 0 ? allRows[0].broker_id : null),
            total_rows: totalRows,
            new_rows: insertCount,
            updated_rows: updateCount,
            error_rows: importErrors.length + errorRowCount,
            status: importErrors.length > 0 ? 'PARTIAL' : 'SUCCESS',
            details: {
                symbols: allRows.map(function(r) { return r.short_symbol || r.symbol; }).filter(function(v, i, a) { return a.indexOf(v) === i; }),
                errors: importErrors,
                skipped: cfg.errorRows ? cfg.errorRows.map(function(e) { return e.description || e.symbol || ''; }) : []
            }
        });

        tiLoading(false);

        // Close modal & reset source-specific state
        document.getElementById(cfg.overlayId).classList.remove('active');
        if (typeof cfg.onReset === 'function') cfg.onReset();

        if (importErrors.length > 0) {
            tiAlert('warning', 'Imported ' + insertCount + ' new + ' + updateCount + ' updated.\n\n' + importErrors.length + ' errors:\n' + importErrors.slice(0, 10).join('\n'));
        } else {
            tiAlert('success', 'Successfully imported ' + insertCount + ' new + ' + updateCount + ' updated transactions!');
        }

        tiLoadImportLog();

    } catch (error) {
        tiLoading(false);
        tiAlert('error', 'Import failed: ' + error.message);
    }
    _importInProgress = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Import to Database'; }
}


// ============================================================================
// FYERS TRADEBOOK IMPORT
// ============================================================================

// Fyers import state (var per Rule A.1.2)
var fyParsedRows = [];      // After grouping trades
var fyNewRows = [];          // Will be inserted
var fyUpdateRows = [];       // Will update existing
var fyErrorRows = [];        // Could not match security
var fyTradeDate = null;      // Today's date (YYYY-MM-DD)
var fyInvestorId = null;     // "Veins" investor ID
var fyBrokerId = null;       // Fyers broker ID
var fyInvestorName = '';     // Display name
var fyBrokerName = '';       // Display name

// ============================================================================
// Fyers Init — detect investor/broker, check token status
// ============================================================================

function fyInit() {
    // Populate investor dropdown
    var select = document.getElementById('fyInvestorSelect');
    if (select) {
        select.innerHTML = '<option value="">-- Select Investor --</option>';
        wmsRefData.investors.forEach(function(inv) {
            var opt = document.createElement('option');
            opt.value = inv.id;
            opt.textContent = inv.short_name || inv.name;
            select.appendChild(opt);
        });

        // Default to Veins if exists
        var veins = wmsRefData.investors.find(function(i) { return i.short_name === 'Veins'; });
        if (veins) {
            select.value = veins.id;
            fyInvestorId = veins.id;
            fyInvestorName = veins.short_name;
        }

        // Listen for changes
        select.addEventListener('change', function() {
            var selectedId = select.value;
            if (selectedId) {
                var inv = wmsRefData.investors.find(function(i) { return i.id === selectedId; });
                fyInvestorId = selectedId;
                fyInvestorName = inv ? (inv.short_name || inv.name) : '';
            } else {
                fyInvestorId = null;
                fyInvestorName = '';
            }
            fyUpdateStatus();
        });
    }

    // Look up Fyers broker (check code and name)
    var brk = wmsRefData.brokers.find(function(b) {
        return (b.broker_code && b.broker_code.toUpperCase() === 'FYERS') ||
               (b.name && b.name.toLowerCase().indexOf('fyers') >= 0);
    });
    if (brk) {
        fyBrokerId = brk.id;
        fyBrokerName = brk.name || brk.broker_code;
    }

    // Update connection status
    fyUpdateStatus();

    // If broker not found, show error
    if (!fyBrokerId) {
        var infoEl = document.getElementById('fyInfo');
        if (infoEl) {
            infoEl.textContent = 'Broker "Fyers" not found in database. Fyers import disabled.';
            infoEl.style.color = '#dc2626';
        }
    }
}

function fyUpdateStatus() {
    var statusEl = document.getElementById('fyStatus');
    var dotEl = document.getElementById('fyStatusDot');
    var textEl = document.getElementById('fyStatusText');
    var fetchBtn = document.getElementById('fyFetchBtn');
    var infoEl = document.getElementById('fyInfo');
    if (!statusEl) return;

    // Check Fyers token — localStorage (manual OAuth) OR window.fyersToken (DB auto-login)
    var token = null;
    try {
        var stored = localStorage.getItem('fyers_token');
        if (stored) {
            var parsed = JSON.parse(stored);
            // Token is valid only for today
            var today = new Date().toISOString().split('T')[0];
            if (parsed.date === today && parsed.token) {
                token = parsed.token;
            }
        }
    } catch (e) { /* ignore parse errors */ }
    // Also check window.fyersToken set by app.html checkFyersAuth() (covers DB auto-login)
    if (!token && window.fyersToken) {
        token = window.fyersToken;
    }

    if (token && fyInvestorId && fyBrokerId) {
        statusEl.className = 'fy-status connected';
        dotEl.textContent = '🟢';
        textEl.textContent = 'Connected';
        fetchBtn.disabled = false;
        infoEl.textContent = 'Fetch today\'s executed trades from Fyers. Charges will be auto-calculated.';
        infoEl.style.color = '#718096';
    } else {
        statusEl.className = 'fy-status disconnected';
        dotEl.textContent = '🔴';
        textEl.textContent = 'Not Connected';
        fetchBtn.disabled = true;
        if (fyInvestorId && fyBrokerId) {
            infoEl.textContent = 'Connect Fyers in the Settings tab to enable import.';
            infoEl.style.color = '#718096';
        }
    }
}

// ============================================================================
// Fetch Trades from Fyers API
// ============================================================================

window.fyFetchTrades = async function() {
    var fetchBtn = document.getElementById('fyFetchBtn');
    var statusEl = document.getElementById('fyFetchStatus');

    // Validate prerequisites
    if (!fyInvestorId || !fyBrokerId) {
        tiAlert('error', 'Fyers investor/broker not configured. Check Settings.');
        return;
    }

    // Check token — localStorage (manual OAuth) OR window.fyersToken (DB auto-login)
    var token = null;
    try {
        var stored = localStorage.getItem('fyers_token');
        if (stored) {
            var parsed = JSON.parse(stored);
            var today = new Date().toISOString().split('T')[0];
            if (parsed.date === today && parsed.token) {
                token = parsed.token;
            }
        }
    } catch (e) { /* */ }
    if (!token && window.fyersToken) {
        token = window.fyersToken;
    }

    if (!token) {
        tiAlert('error', 'Fyers token expired or not available. Please reconnect in Settings.');
        fyUpdateStatus();
        return;
    }

    fetchBtn.disabled = true;
    statusEl.textContent = 'Fetching trades...';
    statusEl.className = 'cn-status';
    tiLoading(true, 'Fetching Fyers tradebook...');

    try {
        // Call Edge Function via window.fyersCall (defined in app.html)
        if (typeof window.fyersCall !== 'function') {
            throw new Error('window.fyersCall not available. Reload the app.');
        }

        var response = await window.fyersCall({ action: 'tradebook', accessToken: token });

        if (!response || response.error) {
            var errMsg = response ? response.error : 'No response from Fyers API';
            if (response && response.tokenExpired) {
                errMsg = 'Fyers token expired. Please reconnect in Settings.';
                fyUpdateStatus();
            }
            throw new Error(errMsg);
        }

        // Fyers tradebook response: { s: 'ok', tradeBook: [...] }
        if (response.s !== 'ok' || !response.tradeBook) {
            throw new Error('Fyers API returned unexpected response: ' + (response.message || JSON.stringify(response).substring(0, 200)));
        }

        var tradeBook = response.tradeBook;
        if (!tradeBook || tradeBook.length === 0) {
            statusEl.textContent = 'No trades found for today.';
            statusEl.className = 'cn-status';
            tiLoading(false);
            fetchBtn.disabled = false;
            tiAlert('info', 'No executed trades found in Fyers for today.');
            return;
        }

        statusEl.textContent = 'Processing ' + tradeBook.length + ' trade(s)...';

        // Process, group, calculate charges, check duplicates
        await fyProcessTrades(tradeBook);

        // Auto-populate tags on NEW rows from prior transactions (same logic
        // as Add Transaction modal — wmsFindMatchingTags by investor + trader
        // + bare symbol).
        await _autoPopulateTagsForNewRows(fyNewRows, fyInvestorId);

        tiLoading(false);
        fetchBtn.disabled = false;
        statusEl.textContent = '';

        // Display preview
        fyDisplayPreview();

    } catch (e) {
        console.error('Fyers fetch error:', e);
        tiLoading(false);
        fetchBtn.disabled = false;
        statusEl.textContent = 'Error: ' + e.message;
        statusEl.className = 'cn-status error';
        tiAlert('error', 'Fyers import failed: ' + e.message);
    }
};

// ============================================================================
// Process & Group Fyers Trades
// ============================================================================

async function fyProcessTrades(tradeBook) {
    // Set trade date to today
    fyTradeDate = new Date().toISOString().split('T')[0];

    // Filter: segment 10 (CM/Equity) and segment 11 (F&O) — skip commodity (segment 20)
    var validTrades = tradeBook.filter(function(t) {
        return t.segment === 10 || t.segment === 11;
    });
    var skipped = tradeBook.length - validTrades.length;
    if (skipped > 0) console.log('Fyers: Skipped ' + skipped + ' trade(s) with unsupported segment');

    // Parse symbol: strip exchange prefix (e.g., "NSE:RELIANCE-EQ" → "RELIANCE")
    // side: 1 = BUY, -1 = SELL
    //
    // Group by (symbol, side, orderNumber). Fyers tradebook returns one entry
    // per FILL, and a single order can produce multiple fills — those SHOULD
    // aggregate into one WMS row (same weighted-avg price, summed qty). But
    // different orders (even same symbol + side on the same day) are distinct
    // logical trades and MUST stay as separate rows — otherwise they collide
    // with each other and with any prior rows from split/edit operations.
    // Extract "HH:MM:SS" from a Fyers tradebook entry. Fyers v3 typically
    // exposes orderDateTime as "YYYY-MM-DD HH:MM:SS" in IST; we also try
    // tradeDateTime / orderTime as fallbacks. Returns null if no field
    // yields a parseable time — the DB will store NULL and the sort helper
    // treats that as 00:00:00.
    function _fyExtractTradeTime(t) {
        var src = t.orderDateTime || t.tradeDateTime || t.orderTime || t.tradedTime || '';
        if (!src) return null;
        var s = String(src);
        // Prefer the HH:MM:SS pattern anywhere in the string.
        var m = s.match(/(\d{2}):(\d{2}):(\d{2})/);
        if (m) return m[1] + ':' + m[2] + ':' + m[3];
        return null;
    }

    var groups = {};
    validTrades.forEach(function(t) {
        var rawSymbol = t.symbol || '';
        // Strip exchange prefix: "NSE:RELIANCE-EQ" → "RELIANCE-EQ", "NSE:SHRIRAMFIN26APRFUT" → "SHRIRAMFIN26APRFUT"
        var symPart = rawSymbol.indexOf(':') >= 0 ? rawSymbol.split(':')[1] : rawSymbol;
        // For equity (segment 10): strip -EQ suffix → "RELIANCE"
        // For F&O (segment 11): keep full symbol → "SHRIRAMFIN26APRFUT"
        var cleanSymbol = t.segment === 10 ? symPart.replace(/-EQ$/i, '').trim().toUpperCase() : symPart.trim().toUpperCase();
        var side = t.side === 1 ? 'BUY' : 'SELL';
        var orderKey = t.orderNumber || ('NOORD-' + (t.tradeNumber || t.id || Math.random()));
        var key = cleanSymbol + '|' + side + '|' + orderKey;

        if (!groups[key]) {
            groups[key] = {
                symbol: cleanSymbol,
                rawSymbol: rawSymbol,
                side: side,
                segment: t.segment,
                totalQty: 0,
                totalValue: 0,
                orderNumbers: [],
                trades: [],
                // Earliest trade time across all fills of this order — the
                // "when this order first started executing" timestamp.
                earliestTime: null
            };
        }
        groups[key].totalQty += t.tradedQty || 0;
        groups[key].totalValue += (t.tradedQty || 0) * (t.tradePrice || 0);
        if (t.orderNumber && groups[key].orderNumbers.indexOf(t.orderNumber) === -1) {
            groups[key].orderNumbers.push(t.orderNumber);
        }
        groups[key].trades.push(t);
        var tt = _fyExtractTradeTime(t);
        if (tt && (!groups[key].earliestTime || tt < groups[key].earliestTime)) {
            groups[key].earliestTime = tt;
        }
    });

    // Match securities from local wmsRefData
    fyParsedRows = [];
    fyErrorRows = [];

    var keys = Object.keys(groups);

    // Separate equity and NFO symbols for different lookup paths
    var equitySymbols = [];
    var nfoGroups = [];
    keys.forEach(function(k) {
        var g = groups[k];
        if (g.segment === 10) {
            if (equitySymbols.indexOf(g.symbol) === -1) equitySymbols.push(g.symbol);
        } else {
            nfoGroups.push(g);
        }
    });

    // Equity: local batch lookup from in-memory securitiesCm (zero API calls)
    var secMap = batchMatchSecurities(equitySymbols);

    // NFO: use matchSymbolMultiStage for each unique symbol (searches securitiesNfo with auto-insert)
    var nfoSecMap = {};
    nfoGroups.forEach(function(g) {
        if (nfoSecMap[g.symbol]) return; // already matched
        var result = matchSymbolMultiStage(g.symbol, 'NFO', secMap);
        if (result.status === 'confirmed' && result.match) {
            nfoSecMap[g.symbol] = result.match;
        } else if (result.status === 'flagged' && result.matches && result.matches.length > 0) {
            // Ambiguous — take first match
            nfoSecMap[g.symbol] = result.matches[0];
            console.warn('Fyers NFO: ambiguous match for ' + g.symbol + ', using first: ' + result.matches[0].symbol);
        }
        // else: not found — will become error row
    });

    for (var k = 0; k < keys.length; k++) {
        var g = groups[keys[k]];
        var avgPrice = g.totalQty > 0 ? g.totalValue / g.totalQty : 0;
        var grossAmount = g.totalValue;

        // Look up in appropriate map based on segment
        var secMatch = g.segment === 10 ? (secMap[g.symbol] || null) : (nfoSecMap[g.symbol] || null);
        if (!secMatch) {
            fyErrorRows.push({
                description: g.rawSymbol + ' (' + g.side + ', qty: ' + g.totalQty + ')',
                error: 'Security not found in database: ' + g.symbol
            });
            continue;
        }

        var isNfo = g.segment === 11;
        var secType = isNfo ? 'NFO' : (secMatch.security_type || 'EQUITY');
        var lotSize = secMatch.lot_size || 1;

        var row = {
            security_id: secMatch.id,
            security_type: secType,
            symbol: (secMatch.symbol || '').replace(/^[A-Z]+:/, ''),
            short_symbol: secMatch.short_symbol || g.symbol,
            company_name: secMatch.company_name || g.symbol,
            exchange: secMatch.exchange || 'NSE',
            transaction_type: g.side,
            quantity: g.side === 'SELL' ? -g.totalQty : g.totalQty,
            lots: isNfo && lotSize > 0 ? Math.round(g.totalQty / lotSize) : 0,
            price: roundMoney(avgPrice),
            gross_amount: roundMoney(grossAmount),
            brokerage: 0,
            stt: 0,
            other_charges: 0,
            gst: 0,
            total_charges: 0,
            net_amount: 0,
            // Fyers trade time (earliest fill time across the order's trades).
            // Null when none of the common Fyers time fields are present.
            transaction_time: g.earliestTime,
            _db_security_type: secType,
            _db_asset_class: secMatch.asset_class || (isNfo ? 'FUTURES' : ''),
            _orderNumbers: g.orderNumbers,   // For broker_trade_id
            _tradeCount: g.trades.length,     // For info display
            _pendingNfoInsert: secMatch._pendingNfoInsert || false,
            _nfoRecord: secMatch._nfoRecord || null
        };

        // Auto-calculate charges (no charge data from Fyers API — calculate fresh)
        wmsAutoCalcCharges(row, {
            ibaRatesMap: ibaRatesMap,
            regCharges: regulatoryCharges,
            investorId: fyInvestorId,
            brokerId: fyBrokerId,
            preserveExisting: false,  // Calculate everything fresh
            debug: false
        });

        fyParsedRows.push(row);
    }

    console.log('Fyers: ' + fyParsedRows.length + ' grouped rows, ' + fyErrorRows.length + ' errors');

    // Check duplicates against existing transactions
    await fyCheckDuplicates(fyParsedRows);
}

// ============================================================================
// Duplicate Check
// ============================================================================

async function fyCheckDuplicates(rows) {
    if (rows.length === 0) { fyNewRows = []; fyUpdateRows = []; return; }

    // Query existing transactions for this investor + broker + date.
    // Include broker_trade_id so we can match by Fyers order number overlap
    // rather than just (symbol, type) — the latter collides after split/edit
    // operations that produce multiple existing rows for the same contract.
    var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions?investor_id=eq.' + fyInvestorId + '&broker_id=eq.' + fyBrokerId + '&transaction_date=eq.' + fyTradeDate + '&select=id,symbol,transaction_type,quantity,price,gross_amount,tags,broker_trade_id', {
        headers: wmsHeaders()
    });
    var existing = await resp.json();

    fyNewRows = [];
    fyUpdateRows = [];

    rows.forEach(function(r) {
        // Order-ID matching rule:
        //   • Group the incoming row's Fyers orderNumber(s) into a Set.
        //   • A candidate existing row matches only if it has the SAME symbol,
        //     SAME transaction_type, AND at least one of its stored
        //     broker_trade_id order numbers appears in the incoming Set.
        //   • Rows with broker_trade_id = null (manual entries, split-off
        //     children, CN-imported rows) never match any Fyers import —
        //     they're immune. This is the correct behaviour: the Fyers
        //     tradebook should only update its own prior imports, not touch
        //     rows it didn't create.
        //   • Different orders (even same symbol + type on the same day) will
        //     miss all existing rows and classify as NEW.
        var rBare = (r.symbol || '').replace(/^[A-Z]+:/, '');
        var incomingOrders = new Set(r._orderNumbers || []);

        var match = existing.find(function(e) {
            if ((e.symbol || '').replace(/^[A-Z]+:/, '') !== rBare) return false;
            if (e.transaction_type !== r.transaction_type) return false;
            var existingOrders = (e.broker_trade_id || '').split(',')
                .map(function(s) { return s.trim(); })
                .filter(Boolean);
            if (existingOrders.length === 0) return false;
            return existingOrders.some(function(o) { return incomingOrders.has(o); });
        });

        if (match) {
            r._existingId = match.id;
            r._action = 'UPDATE';
            r.tags = match.tags || [];  // Preserve existing tags
            fyUpdateRows.push(r);
        } else {
            r.tags = [];  // Empty tags for new rows
            r._action = 'NEW';
            fyNewRows.push(r);
        }
    });

    // Add Excel-compatible fields so Fyers rows work in the shared preview modal
    var allFyRows = fyNewRows.concat(fyUpdateRows);
    allFyRows.forEach(function(r) {
        r.investor_id = fyInvestorId;
        r.investor_name = fyInvestorName;
        r.trader_id = fyInvestorId;       // Rule A.2.2: trader defaults to investor
        r.trader_name = fyInvestorName;
        r.broker_id = fyBrokerId;
        r.broker_name = fyBrokerName;
        r.transaction_date = fyTradeDate;
        r.isUpdate = (r._action === 'UPDATE');
        r.matchStatus = 'confirmed';
        r.trader_charges = 0;
        r.tds = null;
        r._netOverride = false;
    });

    // Map error rows to review-compatible format for shared display
    fyErrorRows.forEach(function(err) {
        err.matchStatus = 'review';
        err._stageAError = false;   // symbol issue, not validation error
        err.matchError = err.error;
        err.investor_id = fyInvestorId;
        err.investor_name = fyInvestorName;
        err.trader_id = fyInvestorId;
        err.trader_name = fyInvestorName;
        err.broker_id = fyBrokerId;
        err.broker_name = fyBrokerName;
        err.transaction_date = fyTradeDate;
        err.symbol = err.description;
        err.short_symbol = err.description;
        err.transaction_type = '';
        err.quantity = 0;
        err.price = 0;
        err.gross_amount = 0;
        err.total_charges = 0;
        err.trader_charges = 0;
        err.net_amount = 0;
        err.tags = ['blank'];
        err.isUpdate = false;
    });

    console.log('Fyers duplicates: ' + fyNewRows.length + ' new, ' + fyUpdateRows.length + ' updates');
}

// Build Transaction Record — Fyers wrapper around unified buildTransactionRecord()
function fyBuildTransactionRecord(row) {
    return buildTransactionRecord(row, { source: 'FYERS', investorId: fyInvestorId, brokerId: fyBrokerId, tradeDate: fyTradeDate });
}

// ============================================================================
// Display Fyers Preview — loads data into shared modal, calls shared display
// ============================================================================

function fyDisplayPreview() {
    setImportSource('FYERS');
    // Load Fyers data into the shared state arrays used by displayExcelPreview()
    excelConfirmedRows = fyNewRows.concat(fyUpdateRows);
    excelFlaggedRows = fyErrorRows.slice();
    excelErrorRows = [];
    excelActiveFilter = 'all';
    // Use the shared preview modal (same as Excel)
    displayExcelPreview();
}

// ============================================================================
// Import Fyers Trades to Database — Fyers-specific prep, then shared performImport()
// ============================================================================

window.fyImportToDatabase = async function() {
    // Read tags from shared modal (excelTag_ IDs, allRows index = confirmed concat flagged)
    var allRows = excelConfirmedRows.concat(excelFlaggedRows);
    fyNewRows.forEach(function(r) {
        var idx = allRows.indexOf(r);
        var input = document.getElementById('excelTag_' + idx);
        if (input && input.dataset.tags !== undefined) {
            var val = (input.dataset.tags || '').trim();
            var parsed = val ? val.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; }) : [];
            r.tags = parsed.length > 0 ? parsed : ['blank'];
        }
    });
    fyUpdateRows.forEach(function(r) {
        var idx = allRows.indexOf(r);
        var input = document.getElementById('excelTag_' + idx);
        if (input && input.dataset.tags !== undefined) {
            var val = (input.dataset.tags || '').trim();
            var parsed = val ? val.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; }) : [];
            r.tags = parsed.length > 0 ? parsed : ['blank'];
        }
    });

    await performImport({
        source: 'FYERS',
        newRows: fyNewRows,
        updateRows: fyUpdateRows,
        errorRows: fyErrorRows,
        buildRecord: fyBuildTransactionRecord,
        overlayId: 'excelPreviewOverlay',
        importBtnId: 'importBtn',
        investorId: fyInvestorId,
        brokerId: fyBrokerId,
        tradeDate: fyTradeDate,
        onReset: function() {
            fyParsedRows = []; fyNewRows = []; fyUpdateRows = []; fyErrorRows = [];
            fyTradeDate = null;
            var fyStatus = document.getElementById('fyFetchStatus');
            if (fyStatus) fyStatus.textContent = '';
            excelConfirmedRows = []; excelFlaggedRows = []; excelErrorRows = [];
            _sortHandlersAttached = false;
        }
    });
};


// ============================================================================
// IMPORT LOG — Unified across all import types
// ============================================================================

async function tiLoadImportLog() {
    var tbody = document.getElementById('importLogBody');
    if (!tbody) return;

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/import_log?order=created_at.desc&limit=20&select=*,investors(short_name),brokers(name)', {
            headers: wmsHeaders()
        });

        if (!resp.ok) {
            // Table might not exist yet — show graceful message
            tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#a0aec0;padding:16px;">Import log not available. Run the migration to create the import_log table.</td></tr>';
            return;
        }

        var logs = await resp.json();

        if (!logs || logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#a0aec0;padding:16px;">No imports recorded yet.</td></tr>';
            return;
        }

        tbody.innerHTML = '';
        logs.forEach(function(log) {
            var tr = document.createElement('tr');
            var typeClass = 'il-type il-type-' + (log.import_type || '').toLowerCase();
            var statusClass = 'il-status-' + (log.status || 'success').toLowerCase();
            var importDate = log.created_at ? new Date(log.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
            var tradeDate = log.transaction_date ? formatDate(log.transaction_date) : '—';
            var invName = log.investors ? log.investors.short_name : '—';
            var brkName = log.brokers ? log.brokers.name : '—';

            tr.innerHTML = '<td>' + importDate + '</td>' +
                '<td><span class="' + typeClass + '">' + (log.import_type || '?') + '</span></td>' +
                '<td>' + wmsEsc(invName) + '</td>' +
                '<td>' + wmsEsc(brkName) + '</td>' +
                '<td>' + tradeDate + '</td>' +
                '<td style="text-align:right;color:#059669;font-weight:600;">' + (log.new_rows || 0) + '</td>' +
                '<td style="text-align:right;color:#ed8936;font-weight:600;">' + (log.updated_rows || 0) + '</td>' +
                '<td style="text-align:right;color:#dc2626;font-weight:600;">' + (log.error_rows || 0) + '</td>' +
                '<td class="' + statusClass + '">' + (log.status || '—') + '</td>';
            tbody.appendChild(tr);
        });

    } catch (e) {
        console.error('Error loading import log:', e);
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#a0aec0;padding:16px;">Error loading import log.</td></tr>';
    }
}

async function tiWriteImportLog(importType, data) {
    try {
        var logRecord = {
            import_type: importType,
            transaction_date: data.transaction_date || null,
            investor_id: data.investor_id || null,
            broker_id: data.broker_id || null,
            total_rows: data.total_rows || 0,
            new_rows: data.new_rows || 0,
            updated_rows: data.updated_rows || 0,
            error_rows: data.error_rows || 0,
            status: data.status || 'SUCCESS',
            details: data.details || null
        };

        await fetch(SUPABASE_URL + '/rest/v1/import_log', {
            method: 'POST',
            headers: wmsHeaders({'Content-Type': 'application/json'}),
            body: JSON.stringify(logRecord)
        });
    } catch (e) {
        console.error('Error writing import log:', e);
        // Non-fatal — don't block the import
    }
}
