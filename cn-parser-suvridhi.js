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

            // Look for ISIN anywhere in the line
            var isinMatch = lineText.match(/(INE[A-Z0-9]{9})/);
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
    // Text after ISIN, e.g.: "SURYAROSNI Delivery 2,500 262.4139 0.3900 262.0239 6,55,059.75 -2,500 6,55,059.75"
    // Purely text-based parsing (no item positions needed).

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

    // Extract all numbers from the line
    var allNums = [];
    var numMatches = lineText.match(/-?[\d,]+\.?\d*/g);
    if (numMatches) {
        numMatches.forEach(function(m) {
            var cleaned = m.replace(/,/g, '');
            var val = parseFloat(cleaned);
            if (!isNaN(val) && cleaned !== '' && cleaned !== '-') allNums.push(val);
        });
    }

    if (allNums.length < 2) return null;

    // Determine buy vs sell from the data pattern:
    //
    // BUY-only row:  BuyQty, BuyWAP, BuyBrokPerShare, BuyWAPAfter, BuyTotal, <empty sell>, NetQty(+), NetObligation
    // SELL-only row: <empty buy>, SellQty, SellWAP, SellBrokPerShare, SellWAPAfter, SellTotal, NetQty(-), NetObligation
    // Both (intraday): BuyQty, BuyWAP, ..., BuyTotal, SellQty, SellWAP, ..., SellTotal, NetQty, NetObligation
    //
    // Key insight: if there's a negative integer, it's the net qty indicating net sell.

    var netQty = 0;
    var hasNegativeQty = false;

    // Find negative integer (net qty for sells)
    for (var i = 0; i < allNums.length; i++) {
        if (allNums[i] < 0 && Number.isInteger(allNums[i])) {
            netQty = allNums[i];
            hasNegativeQty = true;
            break;
        }
    }

    // If no negative qty found, look for positive integers
    if (!hasNegativeQty) {
        for (var j = 0; j < allNums.length; j++) {
            if (Number.isInteger(allNums[j]) && allNums[j] > 0 && allNums[j] < 1000000) {
                netQty = allNums[j];
                break;
            }
        }
    }

    var buySell, qty, price, amount;

    if (hasNegativeQty) {
        // SELL trade — net qty is negative
        buySell = 'SELL';
        qty = Math.abs(netQty);

        // For sell-only: numbers are SellQty, WAP, BrokPerShare, WAPAfterBrok, TotalSellValue, NetQty(-), NetObligation
        // The WAP is the first decimal number
        // The TotalSellValue / NetObligation is the largest number
        var decimals = allNums.filter(function(v) { return !Number.isInteger(v) && v > 0; });
        price = decimals.length > 0 ? decimals[0] : 0;  // WAP (across exchanges)

        // Net obligation is the last large number
        var largeNums = allNums.filter(function(v) { return Math.abs(v) >= 1000; });
        amount = largeNums.length > 0 ? Math.abs(largeNums[largeNums.length - 1]) : qty * price;
    } else {
        // BUY trade — net qty is positive
        buySell = 'BUY';
        qty = Math.abs(netQty);

        var decimals2 = allNums.filter(function(v) { return !Number.isInteger(v) && v > 0; });
        price = decimals2.length > 0 ? decimals2[0] : 0;

        var largeNums2 = allNums.filter(function(v) { return Math.abs(v) >= 1000; });
        amount = largeNums2.length > 0 ? Math.abs(largeNums2[largeNums2.length - 1]) : qty * price;
    }

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
