// ============================================================================
// WMS Transaction Import - JavaScript (FIXED)
// ============================================================================

// Supabase Configuration
// SUPABASE_URL defined in app.html
// SUPABASE_ANON_KEY defined in app.html

// Initialize Supabase client
const { createClient } = supabase;
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Global variables
let parsedTransactions = [];
let investorCache = {};
let brokerCache = {};

// ============================================================================
// Initialization
// ============================================================================

document.addEventListener('DOMContentLoaded', function() {
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');

    // Click to upload
    uploadArea.addEventListener('click', () => fileInput.click());

    // File selected
    fileInput.addEventListener('change', handleFileSelect);

    // Drag and drop
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', () => {
        uploadArea.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('dragover');
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            handleFile(files[0]);
        }
    });

    // Load investor and broker data
    loadReferenceData();
});

// ============================================================================
// Reference Data Loading
// ============================================================================

async function loadReferenceData() {
    try {
        // Load investors
        const { data: investors, error: invError } = await supabaseClient
            .from('investors')
            .select('id, name');
        
        if (invError) throw invError;
        
        investors.forEach(inv => {
            investorCache[inv.name] = inv.id;
        });

        // Load brokers
        const { data: brokers, error: brkError } = await supabaseClient
            .from('brokers')
            .select('id, name');
        
        if (brkError) throw brkError;
        
        brokers.forEach(brk => {
            brokerCache[brk.name] = brk.id;
        });

        console.log('✅ Reference data loaded:', {
            investors: Object.keys(investorCache).length,
            brokers: Object.keys(brokerCache).length
        });

    } catch (error) {
        console.error('Error loading reference data:', error);
        showAlert('error', 'Failed to load reference data: ' + error.message);
    }
}

// ============================================================================
// File Handling
// ============================================================================

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
        handleFile(file);
    }
}

function handleFile(file) {
    // Validate file type
    const validTypes = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'];
    if (!validTypes.includes(file.type) && !file.name.match(/\.(xlsx|xls)$/i)) {
        showAlert('error', 'Please upload an Excel file (.xlsx or .xls)');
        return;
    }

    showLoading(true);

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array', cellDates: true });
            
            // Read the "1. Transactions" sheet
            const sheetName = '1. Transactions';
            const worksheet = workbook.Sheets[sheetName];
            
            if (!worksheet) {
                throw new Error(`Sheet "${sheetName}" not found in Excel file`);
            }

            // Convert to JSON - start from row 0 to get headers with asterisks
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { 
                range: 0, // Start from beginning to get headers
                raw: true, // READ RAW VALUES (important for numbers!)
                defval: null
            });

            // Filter out instruction row (row 2 has long instruction text)
            const filteredData = jsonData.filter(row => {
                const inv = row['investor_name*'];
                if (!inv) return false; // Skip empty rows
                const invStr = String(inv);
                // Skip if it contains instruction keywords or is too long
                if (invStr.includes('Required') || invStr.includes('=') || invStr.includes('transaction_type') || invStr.length > 50) {
                    return false;
                }
                return true; // Keep data rows
            });

            console.log('📊 Parsed Excel data:', filteredData.length, 'rows');
            console.log('Sample row:', filteredData[0]);
            
            if (filteredData.length === 0) {
                throw new Error('No data found in Excel file. Make sure data starts from row 3.');
            }

            processTransactions(filteredData);
            showLoading(false);

        } catch (error) {
            console.error('Error reading Excel:', error);
            showAlert('error', 'Error reading Excel file: ' + error.message);
            showLoading(false);
        }
    };

    reader.onerror = function() {
        showAlert('error', 'Error reading file');
        showLoading(false);
    };

    reader.readAsArrayBuffer(file);
}

// ============================================================================
// Transaction Processing
// ============================================================================

function processTransactions(rawData) {
    parsedTransactions = [];
    let errors = [];

    rawData.forEach((row, index) => {
        try {
            const rowNum = index + 3; // Actual Excel row number (1=header, 2=instructions, 3+=data)

            // Extract data from row (Excel headers have asterisks for required fields)
            const investor_name = row['investor_name*'] ? String(row['investor_name*']).trim() : null;
            const broker_name = row['broker_name'] ? String(row['broker_name']).trim() : null;
            const security_type = row['security_type*'] ? String(row['security_type*']).trim() : null;
            const symbol = row['symbol*'] ? String(row['symbol*']).trim() : null;
            const short_symbol = row['short_symbol*'] ? String(row['short_symbol*']).trim() : null;
            const company_name = row['company_name*'] ? String(row['company_name*']).trim() : null;
            const transaction_type_raw = row['transaction_type*'] ? String(row['transaction_type*']).trim() : '';
            const transaction_date = row['transaction_date*'];
            const quantity_raw = row['quantity*'] ? parseInt(row['quantity*']) : 0;
            const lots_raw = row['lots'] ? parseFloat(row['lots']) : null;

            // Skip rows with zero or blank quantity (likely empty rows)
            if (quantity_raw === 0 || !row['quantity*']) {
                console.log(`Skipping row ${rowNum}: quantity is zero or blank`);
                return; // Skip this row silently
            }
            const price = parseFloat(row['price*']) || 0;
            const gross_amount = parseFloat(row['gross_amount*']) || 0;
            const brokerage = parseFloat(row['brokerage']) || 0;
            const stt = parseFloat(row['stt']) || 0;
            const other_charges = parseFloat(row['other_charges']) || 0;
            const gst = parseFloat(row['gst']) || 0;
            const tds = parseFloat(row['tds']) || 0;
            const total_charges = parseFloat(row['total_charges']) || 0;
            const net_amount = parseFloat(row['net_amount*']) || 0;
            const margin_blocked = parseFloat(row['margin_blocked']) || 0;
            const product = row['product'] ? String(row['product']).trim() : null;
            const broker_contract_note_no = row['broker_contract_note_no'] ? String(row['broker_contract_note_no']).trim() : null;
            const broker_trade_id = row['broker_trade_id'] ? String(row['broker_trade_id']).trim() : null;
            const tags = row['tags'] ? String(row['tags']).trim() : null;
            const notes = row['notes'] ? String(row['notes']).trim() : null;
            const ignore_for_avg_cost = row['ignore_for_avg_cost'] ? (String(row['ignore_for_avg_cost']).toUpperCase() === 'TRUE') : false;
            const dont_display = row['dont_display'] ? (String(row['dont_display']).toUpperCase() === 'TRUE') : false;

            // Validation
            if (!investor_name) {
                errors.push(`Row ${rowNum}: investor_name is required`);
                return;
            }
            if (!security_type) {
                errors.push(`Row ${rowNum}: security_type is required`);
                return;
            }
            if (!symbol) {
                errors.push(`Row ${rowNum}: symbol is required`);
                return;
            }

            // AUTO-DETECT transaction type from quantity
            let transaction_type;
            if (transaction_type_raw && transaction_type_raw !== '') {
                // User provided type (DIVIDEND, BONUS, etc.)
                transaction_type = transaction_type_raw.toUpperCase();
            } else {
                // Auto-detect BUY/SELL
                transaction_type = quantity_raw > 0 ? 'BUY' : 'SELL';
            }

            // Calculate lots (handle EQUITY and NFO differently)
            let lots;
            if (security_type === 'EQUITY') {
                lots = 0;
            } else if (security_type === 'NFO') {
                if (lots_raw === null || lots_raw === 0) {
                    lots = 0;
                } else if (transaction_type === 'SELL') {
                    // Make lots negative for SELL
                    lots = -1 * Math.abs(lots_raw);
                } else {
                    lots = Math.abs(lots_raw);
                }
            } else {
                lots = 0;
            }

            // Parse date (raw values give us Excel serial dates or actual dates)
            let parsedDate;
            if (!transaction_date) {
                errors.push(`Row ${rowNum}: transaction_date is required`);
                return;
            }
            
            if (transaction_date instanceof Date) {
                parsedDate = transaction_date.toISOString().split('T')[0];
            } else if (typeof transaction_date === 'number') {
                // Excel serial date (days since 1899-12-30)
                const excelEpoch = new Date(1899, 11, 30);
                const date = new Date(excelEpoch.getTime() + transaction_date * 24 * 60 * 60 * 1000);
                parsedDate = date.toISOString().split('T')[0];
            } else if (typeof transaction_date === 'string') {
                // Already formatted or needs parsing
                if (transaction_date.includes('-')) {
                    parsedDate = transaction_date.split('T')[0];
                } else {
                    // Try parsing as Excel serial string
                    const excelEpoch = new Date(1899, 11, 30);
                    const days = parseFloat(transaction_date);
                    if (!isNaN(days)) {
                        const date = new Date(excelEpoch.getTime() + days * 24 * 60 * 60 * 1000);
                        parsedDate = date.toISOString().split('T')[0];
                    } else {
                        errors.push(`Row ${rowNum}: Invalid date format`);
                        return;
                    }
                }
            } else {
                errors.push(`Row ${rowNum}: Invalid date type`);
                return;
            }

            // Lookup investor_id
            const investor_id = investorCache[investor_name];
            if (!investor_id) {
                errors.push(`Row ${rowNum}: Investor "${investor_name}" not found in database`);
                return;
            }

            // Lookup broker_id (can be null)
            let broker_id = null;
            if (broker_name) {
                broker_id = brokerCache[broker_name];
                if (!broker_id) {
                    errors.push(`Row ${rowNum}: Broker "${broker_name}" not found in database`);
                    return;
                }
            }

            // Create transaction object
            const transaction = {
                rowNum,
                investor_id,
                investor_name,
                broker_id,
                broker_name,
                security_id: '00000000-0000-0000-0000-000000000000', // Placeholder
                security_type,
                symbol,
                short_symbol,
                company_name,
                exchange: security_type === 'EQUITY' ? 'NSE' : 'NFO',
                product,
                transaction_type,
                transaction_date: parsedDate,
                quantity: quantity_raw,
                lots,
                price,
                gross_amount,
                brokerage,
                stt,
                other_charges,
                gst,
                tds,
                total_charges,
                net_amount,
                margin_blocked,
                broker_contract_note_no,
                broker_trade_id,
                tags: tags ? [tags] : null,
                notes,
                ignore_for_avg_cost,
                dont_display
            };

            parsedTransactions.push(transaction);

        } catch (error) {
            errors.push(`Row ${index + 3}: ${error.message}`);
        }
    });

    // Show results
    if (errors.length > 0) {
        const errorSummary = errors.slice(0, 10).map((err, i) => `${i + 1}. ${err}`).join('\n');
        const errorMsg = `⚠️ Parsed ${parsedTransactions.length} transactions successfully.\n\n${errors.length} rows skipped due to errors:\n\n${errorSummary}${errors.length > 10 ? `\n\n...and ${errors.length - 10} more errors` : ''}`;
        showAlert('warning', errorMsg);
        console.error('All errors:', errors);
    } else {
        showAlert('success', `✅ Successfully parsed ${parsedTransactions.length} transactions!`);
    }

    if (parsedTransactions.length > 0) {
        displayPreview();
    }
}

// ============================================================================
// Display Preview
// ============================================================================

function displayPreview() {
    // Calculate stats
    const buyCount = parsedTransactions.filter(t => t.transaction_type === 'BUY').length;
    const sellCount = parsedTransactions.filter(t => t.transaction_type === 'SELL').length;
    const otherCount = parsedTransactions.length - buyCount - sellCount;

    document.getElementById('statTotal').textContent = parsedTransactions.length;
    document.getElementById('statBuy').textContent = buyCount;
    document.getElementById('statSell').textContent = sellCount;
    document.getElementById('statOther').textContent = otherCount;

    // Build table
    const tbody = document.getElementById('previewTableBody');
    tbody.innerHTML = '';

    parsedTransactions.forEach((t, index) => {
        const row = document.createElement('tr');
        
        const typeClass = t.transaction_type === 'BUY' ? 'type-buy' : 
                         t.transaction_type === 'SELL' ? 'type-sell' : 'type-other';
        
        row.innerHTML = `
            <td>${index + 1}</td>
            <td>${t.investor_name}</td>
            <td class="${typeClass}">${t.transaction_type}</td>
            <td>${t.symbol}</td>
            <td>${t.transaction_date}</td>
            <td>${t.quantity.toLocaleString()}</td>
            <td>${t.lots}</td>
            <td>₹${t.price.toLocaleString()}</td>
            <td>₹${t.net_amount.toLocaleString()}</td>
        `;
        
        tbody.appendChild(row);
    });

    // Show preview section
    document.getElementById('uploadSection').style.display = 'none';
    document.getElementById('previewSection').classList.add('active');
}

// ============================================================================
// Import to Database
// ============================================================================

async function importToDatabase() {
    if (parsedTransactions.length === 0) {
        showAlert('error', 'No transactions to import');
        return;
    }

    if (!confirm(`Import ${parsedTransactions.length} transactions to database?`)) {
        return;
    }

    showLoading(true);
    document.getElementById('importBtn').disabled = true;

    try {
        // Prepare data for Supabase (remove display-only fields)
        const dataToInsert = parsedTransactions.map(t => {
            const { rowNum, investor_name, broker_name, ...rest } = t;
            return rest;
        });

        // Insert in batches of 100
        const batchSize = 100;
        let inserted = 0;

        for (let i = 0; i < dataToInsert.length; i += batchSize) {
            const batch = dataToInsert.slice(i, i + batchSize);
            
            const { data, error } = await supabaseClient
                .from('transactions')
                .insert(batch);

            if (error) throw error;
            
            inserted += batch.length;
            console.log(`✅ Inserted ${inserted}/${dataToInsert.length} transactions`);
        }

        showAlert('success', `🎉 Successfully imported ${inserted} transactions!`);
        showLoading(false);

        // Refresh after 2 seconds
        setTimeout(() => {
            window.location.reload();
        }, 2000);

    } catch (error) {
        console.error('Error importing:', error);
        showAlert('error', 'Import failed: ' + error.message);
        showLoading(false);
        document.getElementById('importBtn').disabled = false;
    }
}

// ============================================================================
// UI Helpers
// ============================================================================

function cancelImport() {
    if (confirm('Cancel import and start over?')) {
        window.location.reload();
    }
}

function showAlert(type, message) {
    const container = document.getElementById('alertContainer');
    const alertClass = type === 'success' ? 'alert-success' : 
                      type === 'error' ? 'alert-error' : 'alert-warning';
    
    const alert = document.createElement('div');
    alert.className = `alert ${alertClass}`;
    alert.textContent = message;
    
    container.innerHTML = '';
    container.appendChild(alert);

    // Only auto-hide success messages (keep warnings and errors)
    if (type === 'success') {
        setTimeout(() => {
            alert.style.opacity = '0';
            setTimeout(() => alert.remove(), 300);
        }, 5000);
    }
    // Warnings and errors stay visible until user dismisses or uploads new file
}

function showLoading(show) {
    const loader = document.getElementById('loadingIndicator');
    loader.classList.toggle('hidden', !show);
}
