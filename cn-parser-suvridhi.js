// ============================================================================
// SUVRIDHI CAPITAL MARKETS CONTRACT NOTE PARSER
// Broker-specific parser plugin for Suvridhi Capital Markets Pvt. Ltd.
// Registers itself into the global CN_PARSERS object
// ============================================================================
//
// SUVRIDHI CN FORMAT:
// - Typically single page, clean table layout
// - Trade Date: DD/MM/YY (2-digit year)
// - Contract Note No: numeric
// - Segment: NCL-Equities
// - Trade rows span 2 lines:
//     Line 1: ISIN (e.g. INE335A01020)
//     Line 2: Symbol, TradeStatus, BUY cols (Qty, WAP, Brokerage, WAPAfter, Total),
//             SALE cols (Qty, WAP, Brokerage, WAPAfter, Total), NetQty, NetObligation
// - Charges summary row: NCL-Equities [SettlementNo] PayInOut Brokerage STT TxnCharges SEBI StampDuty IPFT TaxableValue GST NetAmount
// ============================================================================

// Safety: ensure globals exist even if this script loads before transaction-import.js
if (typeof window.CN_PARSERS === 'undefined') window.CN_PARSERS = {};
if (typeof window.CN_UTILS === 'undefined') window.CN_UTILS = {};

CN_PARSERS.suvridhi = function(pages, numPages) {
    // Collect all page items sorted
    var allText = [];
    pages.forEach(function(pageItems) {
        var sorted = pageItems.slice().sort(function(a, b) {
            var yDiff = b.y - a.y;
            if (Math.abs(yDiff) > 3) return yDiff;
            return a.x - b.x;
        });
        allText.push(sorted);
    });

    var firstPageText = allText[0].map(function(i) { return i.text; }).join(' ');

    // Validate this is a Suvridhi contract note
    if (!/suvridhi/i.test(firstPageText)) {
        throw new Error('This does not appear to be a Suvridhi contract note. Please check you selected the correct broker account.');
    }

    // ========================================================================
    // Extract Trade Date — Format: "Trade Date DD/MM/YY" (2-digit year)
    // ========================================================================
    var tradeDate = null;
    var dateMatch = firstPageText.match(/Trade\s*Date\s*(\d{2}\/\d{2}\/\d{2,4})/i);
    if (dateMatch) {
        var parts = dateMatch[1].split('/');
        var year = parts[2];
        if (year.length === 2) year = '20' + year;
        tradeDate = year + '-' + parts[1] + '-' + parts[0];
    }
    if (!tradeDate) throw new Error('Could not extract Trade Date. Is this a valid Suvridhi contract note?');

    // ========================================================================
    // Extract Contract Note Number
    // ========================================================================
    var cnNumber = null;
    var cnMatch = firstPageText.match(/Contract\s*Note\s*No\.?\s*(\d+)/i);
    if (cnMatch) cnNumber = cnMatch[1];
    if (!cnNumber) throw new Error('Could not extract Contract Note Number. Is this a valid Suvridhi contract note?');

    // ========================================================================
    // Parse Trades
    // ========================================================================
    // Suvridhi trade rows contain ISIN + trade data.
    // Due to pdf.js Y-coordinate grouping (3px tolerance), ISIN and trade data
    // may appear on the SAME line or on separate lines.
    // Pattern A (same line): "INE335A01020 SURYAROSNI Delivery 2,500 262.4139 ..."
    // Pattern B (two lines): Line1="INE335A01020", Line2="SURYAROSNI Delivery ..."
    var trades = [];

    for (var p = 0; p < allText.length; p++) {
        var lines = CN_UTILS.buildLines(allText[p]);

        for (var li = 0; li < lines.length; li++) {
            var lineText = lines[li].text;

            // Look for ISIN anywhere in the line (INE for equities, INF for mutual funds/ETFs)
            var isinMatch = lineText.match(/(IN[EF][A-Z0-9]{9})/);
            if (!isinMatch) continue;

            var isin = isinMatch[1];

            // Check if trade data is on the SAME line (Pattern A)
            // If line has ISIN + symbol + numbers, it's all on one line
            var afterIsin = lineText.substring(lineText.indexOf(isin) + isin.length).trim();

            if (afterIsin.length > 10 && afterIsin.match(/[A-Z]/) && afterIsin.match(/\d/)) {
                // Pattern A: ISIN + trade data on same line — use text-based parsing
                var trade = parseSuvridhiTradeData(afterIsin, isin);
                if (trade) trades.push(trade);
            } else {
                // Pattern B: ISIN on this line, trade data on next line
                if (li + 1 >= lines.length) continue;
                var dataLine = lines[li + 1];
                var dataText = dataLine.text;

                if (dataText.match(/^INE/) || dataText.match(/Gross Obligation/i)) continue;

                var trade2 = parseSuvridhiTradeData(dataText, isin);
                if (trade2) {
                    trades.push(trade2);
                    li++; // Skip the data line since we consumed it
                }
            }
        }
    }

    if (trades.length === 0) throw new Error('No trades found. Is this a valid Suvridhi contract note?');

    // ========================================================================
    // Parse Charges
    // ========================================================================
    var charges = parseSuvridhiCharges(allText);

    console.log('Suvridhi parser: ' + trades.length + ' trade(s), date=' + tradeDate + ', CN#' + cnNumber);
    return { tradeDate: tradeDate, cnNumber: cnNumber, trades: trades, charges: charges };
};

// ============================================================================
// Suvridhi-specific helper functions
// ============================================================================

function parseSuvridhiTradeData(lineText, isin) {
    // Suvridhi equity summary row format:
    //   Symbol Delivery [BUY: Qty WAP BrokPerShare WAPAfter Total] [SELL: Qty WAP BrokPerShare WAPAfter Total] NetQty NetObligation
    //
    // BUY-only:  "AFCOM Delivery 1,200 904.7900 1.3600 906.1500 1,087,380.00 1,200 -1,087,380.00"
    //   Numbers: [1200, 904.79, 1.36, 906.15, 1087380.00, 1200, -1087380.00]
    //   NetQty = second-to-last number (1200, positive = BUY)
    //
    // SELL-only: "MON100 Delivery 2,610 229.0000 229.0000 597,690.00 -2,610 597,690.00"
    //   Numbers: [2610, 229.00, 229.00, 597690.00, -2610, 597690.00]
    //   NetQty = second-to-last number (-2610, negative = SELL)
    //
    // FIX for G.8.3 bug: Old logic searched for first negative integer and picked up
    // the negative Net Obligation (e.g. -1087380) which parses as integer when .00.
    // New logic: NetQty is ALWAYS the second-to-last number, NetObligation is last.

    if (!lineText || lineText.trim().length < 5) return null;

    // Extract symbol: first word that is alphabetic (not a number, not "Delivery")
    var words = lineText.trim().split(/\s+/);
    var symbol = '';
    for (var w = 0; w < words.length; w++) {
        if (words[w].match(/^[A-Z]/i) && !words[w].match(/^Delivery$/i)) {
            symbol = words[w];
            break;
        }
    }
    if (!symbol) return null;

    // Extract all numbers from the line (preserving order)
    var allNums = [];
    var numMatches = lineText.match(/-?[\d,]+\.?\d*/g);
    if (numMatches) {
        numMatches.forEach(function(m) {
            var cleaned = m.replace(/,/g, '');
            var val = parseFloat(cleaned);
            if (!isNaN(val) && cleaned !== '' && cleaned !== '-') allNums.push(val);
        });
    }

    if (allNums.length < 3) return null;

    // NetQty = second-to-last number, NetObligation = last number
    // NetQty sign determines BUY (+) or SELL (-)
    var netQtyVal = allNums[allNums.length - 2];
    // var netObligation = allNums[allNums.length - 1]; // not used currently

    var buySell, qty;

    if (netQtyVal < 0) {
        buySell = 'SELL';
        qty = Math.abs(netQtyVal);
    } else {
        buySell = 'BUY';
        qty = Math.abs(netQtyVal);
    }

    // Sanity check: netQty should be a reasonable quantity (integer-like, < 10 million)
    if (qty === 0 || qty > 10000000) {
        console.warn('Suvridhi parser: netQty looks wrong (' + netQtyVal + '), falling back to first integer. Line: ' + lineText);
        // Fallback: use the first positive integer as qty, assume BUY
        qty = 0;
        buySell = 'BUY';
        for (var j = 0; j < allNums.length; j++) {
            var absVal = Math.abs(allNums[j]);
            if (absVal > 0 && absVal < 1000000 && absVal === Math.floor(absVal)) {
                qty = absVal;
                break;
            }
        }
    }

    // Price = WAP before brokerage
    // Suvridhi CN line order: Qty, WAP, BrokPerShare, WAPAfterBrok, TotalAfterBrok, NetQty, NetObligation
    // WAP is always the number immediately AFTER the first occurrence of qty.
    // We need WAP (before brokerage) because charges are applied separately by allocateCharges().
    var price = 0;
    for (var d = 0; d < allNums.length - 2; d++) {
        if (Math.abs(allNums[d]) === qty && d + 1 < allNums.length - 2) {
            price = Math.abs(allNums[d + 1]);
            break;
        }
    }
    // Fallback: first positive number that's not the quantity and has decimals
    if (price === 0) {
        for (var d2 = 0; d2 < allNums.length - 2; d2++) {
            if (allNums[d2] > 0 && allNums[d2] !== qty && allNums[d2] % 1 !== 0) {
                price = allNums[d2];
                break;
            }
        }
    }

    // IMPORTANT: amount = qty × WAP (pre-brokerage gross amount)
    // The CN's "Net Obligation" / "Total Value" is AFTER brokerage deduction per share,
    // but allocateCharges() will apply brokerage from the charges section separately.
    // Using the CN's post-brokerage amount would double-count brokerage.
    var amount = qty * price;

    if (qty === 0 || price === 0) {
        console.warn('Suvridhi parser: skipping trade row with qty=' + qty + ' price=' + price + ' line: ' + lineText);
        return null;
    }

    console.log('Suvridhi trade: ' + buySell + ' ' + qty + ' ' + symbol + ' @ ' + price + ' = ' + amount);

    return {
        segment: 'EQUITY',
        description: symbol,
        buySell: buySell,
        qty: qty,
        price: price,
        amount: amount,
        orderNo: '',
        tradeNo: '',
        tradeTime: '',
        underlying: symbol.toUpperCase().trim(),
        instrumentType: 'EQUITY',
        expiry: null,
        strikePrice: null,
        optionType: null
    };
}

function parseSuvridhiCharges(allText) {
    var charges = {
        equity: { brokerage: 0, stt: 0, gst: 0, exchangeCharges: 0, sebiCharges: 0, stampDuty: 0, ipft: 0 },
        nfo: { brokerage: 0, stt: 0, gst: 0, exchangeCharges: 0, sebiCharges: 0, stampDuty: 0, ipft: 0 }
    };

    // Suvridhi charges are in a summary table row:
    // "NCL-Equities [2026012 M] 6,55,059.75 975.00 -656.00 -19.48 -0.66 0.00 0.00 995.14 -179.13 6,54,204.48"
    //
    // extractNumbers only matches numbers with exactly 2 decimal places ([\d,]+\.\d{2}),
    // so settlement number (no decimal, e.g. "2026012 M") is never extracted.
    // First number is always PayIn/PayOut obligation.
    //
    // After skipping PayIn/PayOut:
    //   [idx+0] = Brokerage
    //   [idx+1] = STT
    //   [idx+2] = Transaction Charges
    //   [idx+3] = SEBI Turnover Fees
    //   [idx+4] = Stamp Duty
    //   [idx+5] = IPFT Charges
    //   [idx+6] = Taxable Value (skip)
    //   [idx+7] = GST (single IGST column) -OR- CGST (if CGST+SGST format)
    //   [idx+8] = SGST (only if CGST+SGST format)
    //   [last]  = Net Amount (skip)

    for (var p = 0; p < allText.length; p++) {
        var lines = CN_UTILS.buildLines(allText[p]);

        for (var li = 0; li < lines.length; li++) {
            var lineText = lines[li].text;

            // Find the NCL-Equities charges data row
            // In character-spaced PDFs, "NCL-" and "Equities" may be on separate lines,
            // so match just "NCL" prefix (the header-only "NCL-Equities" line has < 8 numbers)
            if (!lineText.match(/^NCL/i)) continue;

            var nums = CN_UTILS.extractNumbers(lineText);
            // Must have enough numbers to be the charges row (not just the segment header)
            if (nums.length < 8) continue;

            console.log('Suvridhi charges: ' + nums.length + ' numbers: ' + JSON.stringify(nums));

            // First number is always PayIn/PayOut (settlement number has no decimals → not extracted)
            // Skip it if it's a large amount; for small CNs it could be < 10000, so also check
            // if skipping it leaves enough numbers for the charges
            var idx = 0;
            if (nums.length >= 9 && Math.abs(nums[0]) > Math.abs(nums[1]) * 2) {
                idx = 1;  // Skip PayIn/PayOut obligation
            }

            if (idx + 7 <= nums.length) {
                charges.equity.brokerage      = Math.abs(nums[idx]);
                charges.equity.stt            = Math.abs(nums[idx + 1]);
                charges.equity.exchangeCharges = Math.abs(nums[idx + 2]);
                charges.equity.sebiCharges    = Math.abs(nums[idx + 3]);
                charges.equity.stampDuty      = Math.abs(nums[idx + 4]);
                charges.equity.ipft           = Math.abs(nums[idx + 5]);
                // nums[idx+6] = taxable value (skip)

                // Detect CGST+SGST (2 columns) vs single IGST column:
                // CGST+SGST: remaining after idx has 10 values (brok..ipft + taxable + cgst + sgst + net)
                // IGST:      remaining after idx has 9 values  (brok..ipft + taxable + igst + net)
                var remaining = nums.length - idx;
                if (remaining >= 10 && idx + 9 <= nums.length) {
                    // CGST + SGST format — sum both
                    charges.equity.gst = Math.abs(nums[idx + 7]) + Math.abs(nums[idx + 8]);
                } else if (idx + 8 <= nums.length) {
                    // Single IGST column
                    charges.equity.gst = Math.abs(nums[idx + 7]);
                }
            }

            console.log('Suvridhi equity charges:', JSON.stringify(charges.equity));
            break;
        }
    }

    return charges;
}
