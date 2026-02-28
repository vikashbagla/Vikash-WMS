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
        ['investor_name', 'YES',
            'Name or short name of the investor (beneficiary). Not case-sensitive.',
            'Matched against name or short_name in investors table'],
        ['trader', 'No',
            'Person executing the trade. If blank, defaults to the investor. Not case-sensitive.',
            'Matched against name or short_name in investors table'],
        ['broker', 'No',
            'Broker used for the trade. If blank, broker_id = NULL and brokerage defaults to 0. Not case-sensitive.',
            'Matched against name or broker_code in brokers table'],
        ['transaction_date', 'YES',
            'Date of the trade or corporate action.',
            'DD-MM-YYYY, YYYY-MM-DD, or Excel date serial number'],
        ['symbol', 'YES',
            'Symbol of the security. Matched against symbol, nse_symbol, bse_symbol, or company name. For F&O, enter the full contract symbol.',
            'e.g. RELIANCE, TCS, NIFTY25FEBFUT, NIFTY2502726000CE'],
        ['security_type', 'No',
            'Type of security. If provided, restricts symbol search to the matching table for faster matching. If blank, auto-detected from symbol match.',
            'EQUITY, ETF, MF, NFO (blank = auto-detect)'],
        ['transaction_type', 'YES*',
            'Type of transaction. If blank, derived from quantity sign (+ve = BUY, -ve = SELL).',
            'BUY, SELL, DIVIDEND, INTEREST, OTHER_INCOME, CAPITAL_REDUCTION'],
        ['quantity', 'YES*',
            'Number of shares/units. Sign is auto-enforced: BUY = positive, SELL = negative. For income types (DIVIDEND etc.), can be left blank if gross_amount is provided directly.',
            'Integer (e.g. 100, -50)'],
        ['price', 'YES*',
            'Price per share/unit. For DIVIDEND/INTEREST: dividend per share.',
            'Number (e.g. 1250.50)'],
        ['gross_amount', 'Auto',
            'Auto-calculated as ABS(quantity) x price. You can override if needed. For income types with blank quantity, enter the total amount directly.',
            'Formula (auto-calc) or number'],
        ['brokerage', 'No',
            'Brokerage charges. If blank and broker is provided, auto-calculated from investor-broker brokerage rates (delivery assumed). If blank and no broker, defaults to 0.',
            'Number (e.g. 20.00)'],
        ['stt', 'No',
            'Securities Transaction Tax. If blank, auto-calculated from regulatory charges config (equity delivery assumed). Rounded UP to nearest whole number. Only applicable to EQUITY or equity-class ETFs.',
            'Number (e.g. 13)'],
        ['total_charges', 'No',
            'Total of all charges (brokerage + STT + other charges + GST). If blank, auto-calculated at import time. For income types (DIVIDEND etc.), any value here maps to TDS in the database.',
            'Number (e.g. 38.25)'],
        ['trader_charges', 'No',
            'Charges from the trader\'s perspective. If trader = investor, auto-copied from total_charges. If trader differs, auto-calculated from trader-broker brokerage rates.',
            'Number (e.g. 25.00)'],
        ['net_amount', 'Auto',
            'Auto-calculated: BUY = gross_amount + total_charges, SELL = gross_amount - total_charges. You can override if needed.',
            'Formula (auto-calc) or number'],
        ['tags', 'No',
            'Tag for categorising transactions. If blank, saved as "blank" in the database.',
            'Text (e.g. IPO, SIP, Tax-harvest)'],
        ['notes', 'No',
            'Free text notes. Optional.',
            'Text'],
        [],
        ['NOTES'],
        ['1. The "1. Transactions" sheet is where you enter your data. Row 2 has a sample — replace it with your actual transactions.'],
        ['2. gross_amount and net_amount columns have formulas that auto-calculate for rows 2-1000.'],
        ['3. If you need more than 999 rows, copy the formulas down from the last row.'],
        ['4. All matching (investor, trader, broker, symbol) is case-insensitive.'],
        ['5. Symbol matching order: exact match on symbol/nse_symbol/bse_symbol, then contains match on company_name. If multiple matches found, the row is flagged for your review.'],
        ['6. If security_type is provided (EQUITY/ETF/MF/NFO), symbol search is restricted to the matching table — this speeds up large imports.'],
        ['7. DIVIDEND, INTEREST, OTHER_INCOME, CAPITAL_REDUCTION: charges entered go to TDS field. Gross = net (no trading charges). Quantity is always positive or blank.'],
        ['8. All amounts are rounded to 2 decimal places, except STT which is rounded UP to the nearest whole number.'],
        ['9. Before committing to the database, a preview modal will show all rows for review. Rows with issues are highlighted for inline editing.'],
    ];

    var instrSheet = XLSX.utils.aoa_to_sheet(instrData);

    instrSheet['!cols'] = [
        { wch: 20 },  // Column
        { wch: 10 },  // Required
        { wch: 75 },  // Description
        { wch: 55 },  // Valid values
    ];

    instrSheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];

    XLSX.utils.book_append_sheet(wb, instrSheet, 'Instructions');

    // ── Sheet 2: 1. Transactions (data entry sheet) ────────────────────
    //   A            B       C       D                 E       F              G                H        I      J
    //   investor_name trader  broker  transaction_date  symbol  security_type  transaction_type quantity  price  gross_amount
    //   K          L    M              N               O           P     Q
    //   brokerage  stt  total_charges  trader_charges  net_amount  tags  notes

    var headers = [
        'investor_name', 'trader', 'broker', 'transaction_date', 'symbol',
        'security_type', 'transaction_type', 'quantity', 'price', 'gross_amount',
        'brokerage', 'stt', 'total_charges', 'trader_charges', 'net_amount',
        'tags', 'notes'
    ];

    // Sample row
    var sampleRow = [
        'Vikash Bagla', '', 'Fyers', '2026-01-15', 'RELIANCE',
        'EQUITY', 'BUY', 10, 1250.50, null,  // gross_amount = formula
        20, 13, 38.25, 0, null,               // net_amount = formula
        '', ''
    ];

    var txnData = [headers, sampleRow];
    var txnSheet = XLSX.utils.aoa_to_sheet(txnData);

    txnSheet['!cols'] = [
        { wch: 18 },  // A: investor_name
        { wch: 16 },  // B: trader
        { wch: 12 },  // C: broker
        { wch: 16 },  // D: transaction_date
        { wch: 14 },  // E: symbol
        { wch: 14 },  // F: security_type
        { wch: 18 },  // G: transaction_type
        { wch: 10 },  // H: quantity
        { wch: 12 },  // I: price
        { wch: 14 },  // J: gross_amount
        { wch: 12 },  // K: brokerage
        { wch: 8 },   // L: stt
        { wch: 14 },  // M: total_charges
        { wch: 14 },  // N: trader_charges
        { wch: 14 },  // O: net_amount
        { wch: 14 },  // P: tags
        { wch: 20 },  // Q: notes
    ];

    // Add formulas for rows 2–1000
    // gross_amount = ABS(H) * I  → col J (index 9), quantity=col H, price=col I
    // net_amount: SELL → gross - total_charges, else → gross + total_charges
    //   transaction_type=col G, gross=col J, total_charges=col M → col O (index 14)
    for (var r = 2; r <= 1000; r++) {
        var grossCell = XLSX.utils.encode_cell({ r: r - 1, c: 9 });   // col J
        var netCell   = XLSX.utils.encode_cell({ r: r - 1, c: 14 });  // col O

        // gross_amount = ABS(quantity) * price, blank if no quantity
        txnSheet[grossCell] = {
            t: 'n',
            f: 'IF(H' + r + '="","",ABS(H' + r + ')*I' + r + ')'
        };

        // net_amount: BUY → gross + total_charges, SELL → gross - total_charges
        txnSheet[netCell] = {
            t: 'n',
            f: 'IF(J' + r + '="","",IF(G' + r + '="SELL",J' + r + '-M' + r + ',J' + r + '+M' + r + '))'
        };
    }

    txnSheet['!ref'] = 'A1:Q1000';

    XLSX.utils.book_append_sheet(wb, txnSheet, '1. Transactions');

    // ── Download ───────────────────────────────────────────────────────
    XLSX.writeFile(wb, 'WMS_Transaction_Import_Template.xlsx');
}
