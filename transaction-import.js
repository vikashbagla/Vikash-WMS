// ============================================================================
// WMS Transaction Import - Excel + Contract Note Import
// ============================================================================

// MUST be first: set up globals for CN parser plugins BEFORE anything else
window.CN_PARSERS = window.CN_PARSERS || {};
window.CN_UTILS = window.CN_UTILS || {};

// Use var for module-level state (project convention — avoids redeclaration errors on reload)
var parsedTransactions = [];
var investorCache = {};
var brokerCache = {};
var cnAccounts = [];           // {id, investor_id, broker_id, investor_short_name, broker_code, broker_name, cn_password, cn_parser_template}
var cnParsedRows = [];         // After parsing + grouping
var cnNewRows = [];            // Will be inserted
var cnUpdateRows = [];         // Will update existing
var cnErrorRows = [];          // Could not match security
var cnSelectedAccount = null;  // Currently selected account object
var cnTradeDate = null;        // Trade date from parsed CN (YYYY-MM-DD)
var cnCnNumber = null;         // Contract note number from parsed CN

// ============================================================================
// Initialization
// ============================================================================

function initTransactionImport() {
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
}

document.addEventListener('DOMContentLoaded', initTransactionImport);

// No mode switching needed — both boxes are always visible on the page

// ============================================================================
// Reference Data
// ============================================================================

async function loadReferenceData() {
    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/investors?select=id,name,short_name', { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY } });
        var investors = await resp.json();
        investors.forEach(function(inv) { investorCache[inv.name] = inv.id; });

        resp = await fetch(SUPABASE_URL + '/rest/v1/brokers?select=id,name,broker_code', { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY } });
        var brokers = await resp.json();
        brokers.forEach(function(brk) { brokerCache[brk.name] = brk.id; });
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
// Returns a map: { SYMBOL: { id, symbol, company_name }, ... }
async function batchMatchSecurities(symbols) {
    var secMap = {};
    if (!symbols || symbols.length === 0) return secMap;

    // Build OR filter: symbol.in.(SYM1,SYM2),nse_symbol.in.(SYM1,SYM2),bse_symbol.in.(SYM1,SYM2)
    var symList = symbols.map(function(s) { return encodeURIComponent(s); }).join(',');
    var orFilter = 'or=(symbol.in.(' + symList + '),nse_symbol.in.(' + symList + '),bse_symbol.in.(' + symList + '))';
    var url = SUPABASE_URL + '/rest/v1/securities_db?select=id,symbol,nse_symbol,bse_symbol,company_name&' + orFilter;

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

    // Build lookup map — match each queried symbol to its result
    rows.forEach(function(m) {
        var matchInfo = { id: m.id, symbol: m.nse_symbol || m.symbol, company_name: m.company_name };
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

    // New rows table
    var newTbody = document.getElementById('cnNewTableBody');
    newTbody.innerHTML = '';
    if (cnNewRows.length > 0) {
        document.getElementById('cnNewSection').style.display = '';
        cnNewRows.forEach(function(r, i) { newTbody.appendChild(createCnPreviewRow(r, i + 1)); });
        newTbody.appendChild(createCnTotalsRow(cnNewRows));
    } else {
        document.getElementById('cnNewSection').style.display = 'none';
    }

    // Update rows table
    var updateTbody = document.getElementById('cnUpdateTableBody');
    updateTbody.innerHTML = '';
    if (cnUpdateRows.length > 0) {
        document.getElementById('cnUpdateSection').style.display = '';
        cnUpdateRows.forEach(function(r, i) { updateTbody.appendChild(createCnPreviewRow(r, i + 1)); });
        updateTbody.appendChild(createCnTotalsRow(cnUpdateRows));
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

    // Show preview section
    document.getElementById('cnPreviewSection').classList.add('active');
}

function createCnPreviewRow(r, idx) {
    var tr = document.createElement('tr');
    var typeClass = r.transaction_type === 'BUY' ? 'type-buy' : 'type-sell';
    var tagsValue = Array.isArray(r.tags) ? r.tags.join(', ') : (r.tags || '');
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
        '<td style="text-align:right;font-weight:600;">' + formatCnAmount(r.net_amount) + '</td>' +
        '<td><input type="text" id="' + tagInputId + '" value="' + tagsValue + '" placeholder="e.g. intraday, hedge" style="width:100%;min-width:80px;padding:3px 6px;border:1px solid #cbd5e0;border-radius:4px;font-size:11px;"></td>';
    return tr;
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
        totNet += Math.abs(r.net_amount);
    });
    var tr = document.createElement('tr');
    tr.style.fontWeight = '700';
    tr.style.borderTop = '2px solid #4a5568';
    tr.style.background = '#f7fafc';
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
        '<td style="text-align:right;">' + formatCnAmount(totNet) + '</td>' +
        '<td></td>';
    return tr;
}

function formatCnAmount(val) {
    if (val === null || val === undefined) return '-';
    var unit = getDisplayUnit();
    var config = getUnitConfig(unit);
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

    // Read tags from input fields before importing
    cnNewRows.forEach(function(r, i) {
        var input = document.getElementById('cnTag_NEW_' + i);
        if (input) {
            var val = input.value.trim();
            r.tags = val ? val.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; }) : null;
        }
    });
    cnUpdateRows.forEach(function(r, i) {
        var input = document.getElementById('cnTag_UPDATE_' + i);
        if (input) {
            var val = input.value.trim();
            r.tags = val ? val.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; }) : null;
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
        } else {
            tiAlert('success', 'Successfully imported ' + insertCount + ' new and updated ' + updateCount + ' transactions!');
        }

        document.getElementById('cnImportBtn').disabled = false;

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
        tags: row.tags || null,
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
    tiLoading(true);
    var reader = new FileReader();
    reader.onload = function(e) {
        try {
            var data = new Uint8Array(e.target.result);
            var workbook = XLSX.read(data, { type: 'array', cellDates: true });
            var sheetName = '1. Transactions';
            var worksheet = workbook.Sheets[sheetName];
            if (!worksheet) throw new Error('Sheet "' + sheetName + '" not found in Excel file');
            var jsonData = XLSX.utils.sheet_to_json(worksheet, { range: 0, raw: true, defval: null });
            var filteredData = jsonData.filter(function(row) {
                var inv = row['investor_name*'];
                if (!inv) return false;
                var invStr = String(inv);
                if (invStr.includes('Required') || invStr.includes('=') || invStr.includes('transaction_type') || invStr.length > 50) return false;
                return true;
            });
            if (filteredData.length === 0) throw new Error('No data found in Excel file.');
            processTransactions(filteredData);
            tiLoading(false);
        } catch (error) {
            tiAlert('error', 'Error reading Excel file: ' + error.message);
            tiLoading(false);
        }
    };
    reader.onerror = function() { tiAlert('error', 'Error reading file'); tiLoading(false); };
    reader.readAsArrayBuffer(file);
}

function processTransactions(rawData) {
    parsedTransactions = [];
    var errors = [];
    rawData.forEach(function(row, index) {
        try {
            var rowNum = index + 3;
            var investor_name = row['investor_name*'] ? String(row['investor_name*']).trim() : null;
            var broker_name = row['broker_name'] ? String(row['broker_name']).trim() : null;
            var security_type = row['security_type*'] ? String(row['security_type*']).trim() : null;
            var symbol = row['symbol*'] ? String(row['symbol*']).trim() : null;
            var short_symbol = row['short_symbol*'] ? String(row['short_symbol*']).trim() : null;
            var company_name = row['company_name*'] ? String(row['company_name*']).trim() : null;
            var transaction_type_raw = row['transaction_type*'] ? String(row['transaction_type*']).trim() : '';
            var transaction_date = row['transaction_date*'];
            var quantity_raw = row['quantity*'] ? parseInt(row['quantity*']) : 0;
            var lots_raw = row['lots'] ? parseFloat(row['lots']) : null;
            if (quantity_raw === 0 || !row['quantity*']) return;
            var price = parseFloat(row['price*']) || 0;
            var gross_amount = parseFloat(row['gross_amount*']) || 0;
            var brokerage = parseFloat(row['brokerage']) || 0;
            var stt = parseFloat(row['stt']) || 0;
            var other_charges = parseFloat(row['other_charges']) || 0;
            var gst = parseFloat(row['gst']) || 0;
            var tds = parseFloat(row['tds']) || 0;
            var total_charges = parseFloat(row['total_charges']) || 0;
            var net_amount = parseFloat(row['net_amount*']) || 0;
            var margin_blocked = parseFloat(row['margin_blocked']) || 0;
            var product = row['product'] ? String(row['product']).trim() : null;
            var broker_contract_note_no = row['broker_contract_note_no'] ? String(row['broker_contract_note_no']).trim() : null;
            var broker_trade_id = row['broker_trade_id'] ? String(row['broker_trade_id']).trim() : null;
            var tags = row['tags'] ? String(row['tags']).trim() : null;
            var notes = row['notes'] ? String(row['notes']).trim() : null;
            var ignore_for_avg_cost = row['ignore_for_avg_cost'] ? (String(row['ignore_for_avg_cost']).toUpperCase() === 'TRUE') : false;
            var dont_display = row['dont_display'] ? (String(row['dont_display']).toUpperCase() === 'TRUE') : false;

            if (!investor_name) { errors.push('Row ' + rowNum + ': investor_name is required'); return; }
            if (!security_type) { errors.push('Row ' + rowNum + ': security_type is required'); return; }
            if (!symbol) { errors.push('Row ' + rowNum + ': symbol is required'); return; }

            var transaction_type;
            if (transaction_type_raw && transaction_type_raw !== '') { transaction_type = transaction_type_raw.toUpperCase(); }
            else { transaction_type = quantity_raw > 0 ? 'BUY' : 'SELL'; }

            var lots;
            if (security_type === 'EQUITY') { lots = 0; }
            else if (security_type === 'NFO') {
                if (lots_raw === null || lots_raw === 0) { lots = 0; }
                else if (transaction_type === 'SELL') { lots = -1 * Math.abs(lots_raw); }
                else { lots = Math.abs(lots_raw); }
            } else { lots = 0; }

            var parsedDate;
            if (!transaction_date) { errors.push('Row ' + rowNum + ': transaction_date is required'); return; }
            if (transaction_date instanceof Date) { parsedDate = transaction_date.toISOString().split('T')[0]; }
            else if (typeof transaction_date === 'number') { var excelEpoch = new Date(1899, 11, 30); var date = new Date(excelEpoch.getTime() + transaction_date * 86400000); parsedDate = date.toISOString().split('T')[0]; }
            else if (typeof transaction_date === 'string') {
                if (transaction_date.includes('-')) { parsedDate = transaction_date.split('T')[0]; }
                else { var days = parseFloat(transaction_date); if (!isNaN(days)) { var d2 = new Date(new Date(1899, 11, 30).getTime() + days * 86400000); parsedDate = d2.toISOString().split('T')[0]; } else { errors.push('Row ' + rowNum + ': Invalid date format'); return; } }
            } else { errors.push('Row ' + rowNum + ': Invalid date type'); return; }

            var investor_id = investorCache[investor_name];
            if (!investor_id) { errors.push('Row ' + rowNum + ': Investor "' + investor_name + '" not found'); return; }
            var broker_id = null;
            if (broker_name) { broker_id = brokerCache[broker_name]; if (!broker_id) { errors.push('Row ' + rowNum + ': Broker "' + broker_name + '" not found'); return; } }

            parsedTransactions.push({
                rowNum: rowNum, investor_id: investor_id, investor_name: investor_name, broker_id: broker_id, broker_name: broker_name,
                security_id: '00000000-0000-0000-0000-000000000000', security_type: security_type, symbol: symbol, short_symbol: short_symbol,
                company_name: company_name, exchange: security_type === 'EQUITY' ? 'NSE' : 'NFO', product: product, transaction_type: transaction_type,
                transaction_date: parsedDate, quantity: quantity_raw, lots: lots, price: price, gross_amount: gross_amount, brokerage: brokerage,
                stt: stt, other_charges: other_charges, gst: gst, tds: tds, total_charges: total_charges, net_amount: net_amount,
                margin_blocked: margin_blocked, broker_contract_note_no: broker_contract_note_no, broker_trade_id: broker_trade_id,
                tags: tags ? [tags] : null, notes: notes, ignore_for_avg_cost: ignore_for_avg_cost, dont_display: dont_display
            });
        } catch (error) { errors.push('Row ' + (index + 3) + ': ' + error.message); }
    });

    if (errors.length > 0) {
        var errorSummary = errors.slice(0, 10).map(function(err, i) { return (i+1) + '. ' + err; }).join('\n');
        tiAlert('warning', 'Parsed ' + parsedTransactions.length + ' transactions.\n\n' + errors.length + ' rows skipped:\n\n' + errorSummary);
    } else {
        tiAlert('success', 'Successfully parsed ' + parsedTransactions.length + ' transactions!');
    }
    if (parsedTransactions.length > 0) displayPreview();
}

function displayPreview() {
    var buyCount = parsedTransactions.filter(function(t) { return t.transaction_type === 'BUY'; }).length;
    var sellCount = parsedTransactions.filter(function(t) { return t.transaction_type === 'SELL'; }).length;
    document.getElementById('statTotal').textContent = parsedTransactions.length;
    document.getElementById('statBuy').textContent = buyCount;
    document.getElementById('statSell').textContent = sellCount;
    document.getElementById('statOther').textContent = parsedTransactions.length - buyCount - sellCount;

    var tbody = document.getElementById('previewTableBody');
    tbody.innerHTML = '';
    parsedTransactions.forEach(function(t, index) {
        var row = document.createElement('tr');
        var typeClass = t.transaction_type === 'BUY' ? 'type-buy' : t.transaction_type === 'SELL' ? 'type-sell' : 'type-other';
        row.innerHTML = '<td>' + (index+1) + '</td><td>' + t.investor_name + '</td><td class="' + typeClass + '">' + t.transaction_type + '</td><td>' + t.symbol + '</td><td>' + t.transaction_date + '</td><td>' + formatCnQty(t.quantity) + '</td><td>' + t.lots + '</td><td>' + formatCnAmount(t.price) + '</td><td>' + formatCnAmount(t.net_amount) + '</td>';
        tbody.appendChild(row);
    });

    document.getElementById('previewSection').classList.add('active');
}

async function importToDatabase() {
    if (parsedTransactions.length === 0) { tiAlert('error', 'No transactions to import'); return; }
    if (!confirm('Import ' + parsedTransactions.length + ' transactions to database?')) return;
    tiLoading(true);
    document.getElementById('importBtn').disabled = true;
    try {
        var dataToInsert = parsedTransactions.map(function(t) { var copy = Object.assign({}, t); delete copy.rowNum; delete copy.investor_name; delete copy.broker_name; return copy; });
        var batchSize = 100;
        var inserted = 0;
        for (var i = 0; i < dataToInsert.length; i += batchSize) {
            var batch = dataToInsert.slice(i, i + batchSize);
            var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions', {
                method: 'POST',
                headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
                body: JSON.stringify(batch)
            });
            if (!resp.ok) { var err = await resp.json(); throw new Error(err.message || err.details || 'HTTP ' + resp.status); }
            inserted += batch.length;
        }
        tiAlert('success', 'Successfully imported ' + inserted + ' transactions!');
        tiLoading(false);
        setTimeout(function() { window.location.reload(); }, 2000);
    } catch (error) {
        tiAlert('error', 'Import failed: ' + error.message);
        tiLoading(false);
        document.getElementById('importBtn').disabled = false;
    }
}

window.cancelImport = function() {
    if (confirm('Cancel import and start over?')) window.location.reload();
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
window.importCnToDatabase = window.importCnToDatabase || function(){};
window.cancelCnImport = window.cancelCnImport || function(){};
window.importToDatabase = importToDatabase;
window.cancelImport = window.cancelImport || function(){};
