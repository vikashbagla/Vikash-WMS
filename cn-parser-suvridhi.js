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

    // Price = WAP before brokerage (first decimal number with fractional part in the line)
    // The Suvridhi CN line has: Qty, WAP, BrokPerShare, WAPAfterBrok, TotalAfterBrok, NetQty, NetObligation
    // We need WAP (before brokerage) because charges are applied separately by allocateCharges().
    var price = 0;
    for (var d = 0; d < allNums.length - 2; d++) {  // -2 to skip NetQty and NetObligation
        var v = allNums[d];
        if (v > 0 && v !== qty && (v % 1 !== 0 || v < 100)) {
            // First positive number that's not the quantity and has decimals (or is small enough to be a price)
            price = v;
            break;
        }
    }
    // Fallback: find any decimal > 0 before the last 2 numbers
    if (price === 0) {
        for (var d2 = 0; d2 < allNums.length - 2; d2++) {
            if (allNums[d2] > 0 && allNums[d2] % 1 !== 0) {
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
    // Numbers (via CN_UTILS.extractNumbers):
    //   [0] = settlement number (2026012) — skip
    //   [1] = PayIn/PayOut obligation (655059.75)
    //   [2] = Brokerage (975.00)
    //   [3] = STT (-656.00)
    //   [4] = Transaction Charges (-19.48)
    //   [5] = SEBI Turnover Fees (-0.66)
    //   [6] = Stamp Duty (0.00)
    //   [7] = IPFT Charges (0.00)
    //   [8] = Taxable Value (995.14) — skip
    //   [9] = GST (-179.13)
    //   [10] = Net Amount (654204.48) — skip

    for (var p = 0; p < allText.length; p++) {
        var lines = CN_UTILS.buildLines(allText[p]);

        for (var li = 0; li < lines.length; li++) {
            var lineText = lines[li].text;

            // Find the NCL-Equities charges data row
            if (!lineText.match(/^NCL-Equit/i)) continue;

            var nums = CN_UTILS.extractNumbers(lineText);
            // Must have enough numbers to be the charges row (not just the segment header)
            if (nums.length < 8) continue;

            console.log('Suvridhi charges: ' + nums.length + ' numbers: ' + JSON.stringify(nums));

            // Determine offset: first number might be settlement number (large integer like 2026012)
            var offset = 0;
            if (nums[0] > 100000 && Number.isInteger(nums[0])) {
                offset = 1;  // Skip settlement number
            }

            // After offset: PayInOut, Brokerage, STT, TxnCharges, SEBI, StampDuty, IPFT, TaxableValue, GST, NetAmount
            var idx = offset;
            // Skip PayIn/PayOut obligation (large amount)
            if (idx < nums.length && Math.abs(nums[idx]) > 10000) idx++;

            if (idx + 7 <= nums.length) {
                charges.equity.brokerage      = Math.abs(nums[idx]);
                charges.equity.stt            = Math.abs(nums[idx + 1]);
                charges.equity.exchangeCharges = Math.abs(nums[idx + 2]);
                charges.equity.sebiCharges    = Math.abs(nums[idx + 3]);
                charges.equity.stampDuty      = Math.abs(nums[idx + 4]);
                charges.equity.ipft           = Math.abs(nums[idx + 5]);
                // nums[idx+6] = taxable value (skip)
                if (idx + 8 <= nums.length) {
                    charges.equity.gst = Math.abs(nums[idx + 7]);
                }
            }

            console.log('Suvridhi equity charges:', JSON.stringify(charges.equity));
            break;
        }
    }

    return charges;
}
