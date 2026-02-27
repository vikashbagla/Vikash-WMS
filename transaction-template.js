// ============================================================================
// WMS Transaction Import Template Generator
// Generates a downloadable .xlsx template with Instructions + Transactions sheets
// ============================================================================

function downloadTransactionTemplate() {
    var wb = XLSX.utils.book_new();

    // ── Sheet 1: Instructions ──────────────────────────────────────────
    var instrData = [
        ['WMS Transaction Import Template — Instructions'],
        [],
        ['COLUMN', 'REQUIRED', 'DESCRIPTION', 'VALID VALUES / FORMAT'],
        ['investor_name', 'YES', 'Name of the investor (beneficiary). Must match an investor name in Master Data.', 'Exact match against investors table (name field)'],
        ['trader', 'No', 'The person executing the trade. If blank, defaults to the investor. Must match an investor name if provided.', 'Exact match against investors table (name field)'],
        ['broker', 'No', 'Broker used for the trade. Matched against broker name, short_name, or broker_code.', 'e.g. Fyers, Zerodha, ICICI Direct'],
        ['transaction_date', 'YES', 'Date of the trade or corporate action.', 'DD-MM-YYYY or YYYY-MM-DD'],
        ['symbol', 'YES', 'Symbol of the security. Matched against symbol, nse_symbol, or bse_symbol in the Securities DB.', 'e.g. RELIANCE, TCS, INFY, HDFCBANK'],
        ['transaction_type', 'YES', 'Type of transaction.', 'BUY, SELL, DIVIDEND, INTEREST, BONUS, SPLIT, OTHER_INCOME, CAPITAL_REDUCTION'],
        ['quantity', 'YES', 'Number of shares/units. Positive for BUY/BONUS, negative for SELL. Must not be zero.', 'Integer (e.g. 100, -50)'],
        ['price', 'YES', 'Price per share/unit.', 'Number (e.g. 1250.50)'],
        ['gross_amount', 'Auto', 'Auto-calculated as ABS(quantity) × price. You can override if needed.', 'Formula — do not edit unless needed'],
        ['brokerage', 'No', 'Brokerage charges. Default 0 if blank.', 'Number (e.g. 20.00)'],
        ['stt', 'No', 'Securities Transaction Tax. Default 0 if blank.', 'Number (e.g. 12.50)'],
        ['charges', 'No', 'Other charges (exchange, SEBI, stamp duty, etc.). Default 0 if blank.', 'Number (e.g. 5.75)'],
        ['trader_charges', 'No', 'Charges from the trader perspective (if trader ≠ investor). Default 0 if blank.', 'Number (e.g. 25.00)'],
        ['net_amount', 'Auto', 'Auto-calculated: For BUY = gross_amount + brokerage + stt + charges. For SELL = gross_amount − (brokerage + stt + charges). Override if needed.', 'Formula — do not edit unless needed'],
        ['tags', 'No', 'Tag for categorising. If left blank, saved as "blank" in the database.', 'Text (e.g. IPO, SIP, Tax-harvest)'],
        [],
        ['NOTES'],
        ['1. The "1. Transactions" sheet is where you enter your data. Row 2 has a sample — replace it with your actual transactions.'],
        ['2. gross_amount and net_amount columns have formulas. They auto-calculate for rows 2–1000.'],
        ['3. If you need more than 999 rows, copy the formulas down from the last row.'],
        ['4. Symbol matching: The app tries to match your symbol against symbol, nse_symbol, and bse_symbol fields in the Securities DB.'],
        ['5. Investor and Trader must match existing names in the investors table exactly (case-sensitive).'],
        ['6. Broker is matched flexibly against name, short_name, or broker_code.'],
        ['7. For DIVIDEND, INTEREST, OTHER_INCOME, CAPITAL_REDUCTION: these reduce cost basis but do not affect quantity in portfolio calculations.'],
        ['8. BONUS and SPLIT increase quantity without adding cost.'],
    ];

    var instrSheet = XLSX.utils.aoa_to_sheet(instrData);

    // Column widths for instructions
    instrSheet['!cols'] = [
        { wch: 20 },  // Column
        { wch: 10 },  // Required
        { wch: 70 },  // Description
        { wch: 55 },  // Valid values
    ];

    // Merge title row
    instrSheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];

    XLSX.utils.book_append_sheet(wb, instrSheet, 'Instructions');

    // ── Sheet 2: 1. Transactions (data entry sheet) ────────────────────
    var headers = [
        'investor_name', 'trader', 'broker', 'transaction_date', 'symbol',
        'transaction_type', 'quantity', 'price', 'gross_amount',
        'brokerage', 'stt', 'charges', 'trader_charges', 'net_amount', 'tags'
    ];

    // Sample row to show format
    var sampleRow = [
        'Vikash Bagla', '', 'Fyers', '2026-01-15', 'RELIANCE',
        'BUY', 10, 1250.50, null, // gross_amount will be formula
        20, 12.50, 5.75, 0, null, // net_amount will be formula
        ''
    ];

    var txnData = [headers, sampleRow];
    var txnSheet = XLSX.utils.aoa_to_sheet(txnData);

    // Column widths
    txnSheet['!cols'] = [
        { wch: 18 },  // investor_name
        { wch: 18 },  // trader
        { wch: 14 },  // broker
        { wch: 16 },  // transaction_date
        { wch: 14 },  // symbol
        { wch: 18 },  // transaction_type
        { wch: 10 },  // quantity
        { wch: 12 },  // price
        { wch: 14 },  // gross_amount
        { wch: 12 },  // brokerage
        { wch: 10 },  // stt
        { wch: 12 },  // charges
        { wch: 14 },  // trader_charges
        { wch: 14 },  // net_amount
        { wch: 14 },  // tags
    ];

    // Add gross_amount and net_amount formulas for rows 2–1000
    // gross_amount = ABS(quantity) * price → col I (index 8), quantity=col G, price=col H
    // net_amount: if transaction_type is SELL → gross - (brokerage+stt+charges), else gross + (brokerage+stt+charges)
    // transaction_type=col F, gross=col I, brokerage=col J, stt=col K, charges=col L
    for (var r = 2; r <= 1000; r++) {
        var grossCell = XLSX.utils.encode_cell({ r: r - 1, c: 8 });  // col I
        var netCell = XLSX.utils.encode_cell({ r: r - 1, c: 13 });   // col N

        // gross_amount = ABS(G) * H, but only if quantity exists
        txnSheet[grossCell] = { t: 'n', f: 'IF(G' + r + '="","",ABS(G' + r + ')*H' + r + ')' };

        // net_amount: SELL → gross - charges, else → gross + charges
        txnSheet[netCell] = {
            t: 'n',
            f: 'IF(I' + r + '="","",IF(F' + r + '="SELL",I' + r + '-(J' + r + '+K' + r + '+L' + r + '),I' + r + '+(J' + r + '+K' + r + '+L' + r + ')))'
        };
    }

    // Update sheet range to include formula rows
    txnSheet['!ref'] = 'A1:O1000';

    XLSX.utils.book_append_sheet(wb, txnSheet, '1. Transactions');

    // ── Download ───────────────────────────────────────────────────────
    XLSX.writeFile(wb, 'WMS_Transaction_Import_Template.xlsx');
}
