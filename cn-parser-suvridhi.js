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

    // Use CN_UTILS.buildLines (x-coordinate gap-aware) to build first-page text
    // so the Trade Date / CN Number regexes match even when the PDF extracts
    // text one character per item (happens on some revised / supplementary
    // notes). Naive .join(' ') would insert spaces between every character.
    var firstPageText = CN_UTILS.buildLines(allText[0])
        .map(function(l) { return l.text; })
        .join('\n');

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
    // ========================================================================
    // COORDINATE-BASED CHARGES PARSER — 2026-04-24 rewrite.
    //
    // Instead of regexing numbers out of the joined line text and guessing
    // column alignment from the count, we:
    //
    //   1. Find the charges data row (line starting "NCL" with ≥ 8 numbers).
    //   2. Cluster its items by x-position into numeric TOKENS. Handles both
    //      word-spaced PDFs (one item = one number) and character-spaced PDFs
    //      (one number = 6-10 adjacent single-char items, e.g. K120/644).
    //   3. Find column HEADER labels by scanning lines above the data row
    //      for the Suvridhi charge names (Brokerage, Securities Transaction
    //      Tax, Transaction Charges, SEBI, Stamp Duty, IPFT, Taxable Value,
    //      CGST/SGST or IGST, Net Amount).
    //   4. Map each numeric token to the nearest header label by x-alignment.
    //
    // Benefits vs the old token-count heuristic:
    //   • No assumption about column count — if Suvridhi adds a column
    //     (e.g. Clearing Charges), each value still maps by its header, and
    //     the new column shows up as "unknown" in the log instead of silently
    //     shifting everything.
    //   • No "nums[0] > nums[1] * 2" trickery — the header's x defines the
    //     column, period. Balanced BUY+SELL CNs (K120) and unbalanced CNs
    //     use identical code paths.
    //   • Sanity check: TaxableValue must equal Brokerage+TxnCh+SEBI+IPFT.
    //     If off by > ₹1 we log a loud warning (the canonical signal of a
    //     column-alignment bug — all our historical parser failures failed
    //     this test).
    // ========================================================================

    var charges = {
        equity: { brokerage: 0, stt: 0, gst: 0, exchangeCharges: 0, sebiCharges: 0, stampDuty: 0, ipft: 0 },
        nfo:    { brokerage: 0, stt: 0, gst: 0, exchangeCharges: 0, sebiCharges: 0, stampDuty: 0, ipft: 0 }
    };

    for (var p = 0; p < allText.length; p++) {
        var lines = CN_UTILS.buildLines(allText[p]);

        // Locate the charges data row — first line starting "NCL" with ≥ 8
        // 2-decimal numbers (the header line "NCL-Equities" has 0 numbers).
        var dataIdx = -1;
        for (var li = 0; li < lines.length; li++) {
            if (!/^NCL/i.test(lines[li].text)) continue;
            if (CN_UTILS.extractNumbers(lines[li].text).length >= 8) { dataIdx = li; break; }
        }
        if (dataIdx < 0) continue;

        var dataLine = lines[dataIdx];

        // Cluster data-row items by x-gap into numeric tokens. Char-spaced
        // PDFs emit single chars ("2", ",", "4", "7", "3", ".", "0", "0"),
        // word-spaced PDFs emit "-2,473.00" as one item — either way we end
        // up with a single token per column value.
        var dataTokens = _svClusterNumericTokens(dataLine.items);
        if (dataTokens.length < 8) {
            console.warn('Suvridhi charges: data row had only ' + dataTokens.length + ' numeric tokens, expected ≥ 8 — skipping.');
            continue;
        }

        // Find header column anchors by scanning lines ABOVE the data row
        // within a reasonable y-band (Suvridhi's header block spans ~30-50
        // vertical units above the data row across its 2-4 wrapped lines).
        var headerAnchors = _svFindChargesHeaderAnchors(lines, dataLine.y, dataLine.y + 50);

        // Map each numeric token to a named column by x-proximity to header
        // anchors. Returns {brokerage, stt, txnCh, sebi, stamp, ipft,
        // taxable, cgst, sgst, igst, payInOut, netAmount} (any can be null).
        var mapped = _svMapTokensToColumns(dataTokens, headerAnchors);

        charges.equity.brokerage       = Math.abs(mapped.brokerage || 0);
        charges.equity.stt             = Math.abs(mapped.stt || 0);
        charges.equity.exchangeCharges = Math.abs(mapped.txnCh || 0);
        charges.equity.sebiCharges     = Math.abs(mapped.sebi || 0);
        charges.equity.stampDuty       = Math.abs(mapped.stamp || 0);
        charges.equity.ipft            = Math.abs(mapped.ipft || 0);
        if (mapped.cgst != null && mapped.sgst != null) {
            charges.equity.gst = Math.abs(mapped.cgst) + Math.abs(mapped.sgst);
        } else if (mapped.igst != null) {
            charges.equity.gst = Math.abs(mapped.igst);
        } else if (mapped.cgst != null) {
            // IGST column was matched as CGST — happens when only one GST
            // column exists.  Use it directly.
            charges.equity.gst = Math.abs(mapped.cgst);
        } else {
            charges.equity.gst = 0;
        }

        // Sanity check — the canonical column-alignment tripwire.
        var taxableExpected = charges.equity.brokerage + charges.equity.exchangeCharges +
                              charges.equity.sebiCharges + charges.equity.ipft;
        var taxableRead = mapped.taxable != null ? Math.abs(mapped.taxable) : null;
        if (taxableRead != null && Math.abs(taxableRead - taxableExpected) > 1.00) {
            console.warn('Suvridhi charges: Taxable Value mismatch — ' +
                'read ' + taxableRead.toFixed(2) + ' vs ' +
                'expected (Brok+TxnCh+SEBI+IPFT) ' + taxableExpected.toFixed(2) +
                '. Likely column misalignment — please verify.');
        }

        console.log('Suvridhi equity charges (coordinate-based):', JSON.stringify(charges.equity));
        break;
    }

    return charges;
}

// ----------------------------------------------------------------------------
// Helpers for the coordinate-based charges parser.
// ----------------------------------------------------------------------------

// Cluster a line's items by x-gap into TOKENS, then filter to numeric tokens
// and return [{text, value, x, endX}, ...]. Adjacent items with gap ≤ 2 are
// concatenated. Handles both char-spaced and word-spaced PDFs.
function _svClusterNumericTokens(items) {
    if (!items || items.length === 0) return [];
    var sorted = items.slice().sort(function(a, b) { return a.x - b.x; });
    var clusters = [];
    var cur = null;
    for (var i = 0; i < sorted.length; i++) {
        var it = sorted[i];
        if (!it.text || !it.text.trim()) continue;
        if (cur && (it.x - cur.endX) <= 2) {
            cur.text += it.text;
            cur.endX = it.x + (it.width || 0);
        } else {
            if (cur) clusters.push(cur);
            cur = { text: it.text, x: it.x, endX: it.x + (it.width || 0) };
        }
    }
    if (cur) clusters.push(cur);

    // Retain only tokens that parse cleanly as a number matching "[digits,].dd".
    // This excludes: "NCL-Equities", "[2026075M]", wrapped label text.
    var numeric = [];
    for (var j = 0; j < clusters.length; j++) {
        var t = clusters[j].text.replace(/\s+/g, '');
        // Accept optional leading minus, digits + optional commas, . and 2 decimals.
        if (/^-?[\d,]+\.\d{2}$/.test(t)) {
            var val = parseFloat(t.replace(/,/g, ''));
            if (!isNaN(val)) {
                numeric.push({
                    text: t, value: val,
                    x: clusters[j].x, endX: clusters[j].endX
                });
            }
        }
    }
    return numeric;
}

// Find x-position of a label SUBSTRING in any header line above the data row.
// Uses char-level positioning so it works for both word-spaced PDFs ("Brokerage"
// as one item) AND character-spaced PDFs where "PayIn/PayOutBrokerage" gets
// extracted as 21 adjacent single-character items.
//
// Returns the x-coordinate of the label's first character, or null if not found.
function _svFindLabelX(lines, label, yMin, yMax) {
    for (var li = 0; li < lines.length; li++) {
        var ln = lines[li];
        if (ln.y <= yMin || ln.y >= yMax) continue;
        // Build a char-level array: [{ch, x}, ...] from sorted items.
        var sorted = ln.items.slice().sort(function(a, b) { return a.x - b.x; });
        var chars = [];
        var lastEnd = null;
        for (var i = 0; i < sorted.length; i++) {
            var it = sorted[i];
            if (!it.text) continue;
            if (lastEnd !== null && (it.x - lastEnd) > 2) {
                // Inject a space — matches buildLines' word-split behaviour.
                chars.push({ ch: ' ', x: it.x });
            }
            var txt = it.text;
            var wCh = (it.width || 0) / Math.max(1, txt.length);
            for (var c = 0; c < txt.length; c++) {
                chars.push({ ch: txt[c], x: it.x + c * wCh });
            }
            lastEnd = it.x + (it.width || 0);
        }
        var joined = chars.map(function(c) { return c.ch; }).join('');
        var idx = joined.indexOf(label);
        if (idx >= 0) return chars[idx].x;
    }
    return null;
}

// Find header column anchors by substring-searching for each charge label in
// any header line above the data row. Substring search is intentionally
// permissive: it works whether the label appears as a standalone item
// ("Brokerage") or fused into a superword ("PayIn/PayOutBrokerage") from tight
// char spacing. Returns {columnName: x_left_edge}.
//
// The tricky column is TxnCh — its label "Transaction" is ambiguous because
// "Securities Transaction Tax" (STT column header) also contains it. We
// resolve by anchoring STT via the uniquely-identifying word "Securities"
// and synthesising TxnCh as the midpoint between STT and SEBI — Suvridhi's
// TxnCh column always sits there.
function _svFindChargesHeaderAnchors(lines, dataY, topY) {
    var anchors = {};
    var assign = function(name, label) {
        var x = _svFindLabelX(lines, label, dataY, topY);
        if (x != null) anchors[name] = { x: x, label: label };
    };
    assign('payInOut',  'Pay');         // first "Pay" → PayIn/Out
    assign('brokerage', 'Brokerage');
    assign('stt',       'Securities');  // STT column — unambiguous anchor
    assign('sebi',      'SEBI');
    assign('stamp',     'Stamp');
    assign('ipft',      'IPFT');
    assign('taxable',   'Taxable');
    assign('cgst',      'CGST');
    assign('sgst',      'SGST');
    assign('igst',      'IGST');
    // "Net Amount" — label collapses to "NetAmount" in tight-spacing PDFs, to
    // "Net A mount" in V106 (the only split). Try "Net" as common prefix.
    assign('netAmount', 'Net');

    // Synthesise TxnCh as midpoint between STT and SEBI. In every Suvridhi
    // CN the TxnCh column sits in that gap. Guard: only when the gap is wide
    // enough to contain a column (distance > 40 x-units).
    if (anchors.stt && anchors.sebi && (anchors.sebi.x - anchors.stt.x) > 40) {
        anchors.txnCh = {
            x: (anchors.stt.x + anchors.sebi.x) / 2,
            label: '(synthesised TxnCh = midpoint(STT, SEBI))'
        };
    }
    return anchors;
}

// Map each numeric data token to the column whose x-range contains it.
// Ranges are computed from sorted anchor x-edges: each anchor [anchor_i.x,
// anchor_{i+1}.x) is that column's range. The LAST anchor extends to +∞.
// Uses the token's LEFT EDGE (not center) because Suvridhi right-aligns
// numeric values within each column — the left edge is the reliable
// reference point.
function _svMapTokensToColumns(tokens, anchors) {
    var anchorList = [];
    for (var name in anchors) {
        if (Object.prototype.hasOwnProperty.call(anchors, name)) {
            anchorList.push({ name: name, x: anchors[name].x });
        }
    }
    anchorList.sort(function(a, b) { return a.x - b.x; });
    if (anchorList.length === 0) return {};

    // Compute ranges: [anchor_i.x, anchor_{i+1}.x). Last anchor → [x, ∞).
    var ranges = [];
    for (var i = 0; i < anchorList.length; i++) {
        ranges.push({
            name: anchorList[i].name,
            xMin: anchorList[i].x,
            xMax: (i + 1 < anchorList.length) ? anchorList[i + 1].x : Infinity
        });
    }

    var out = {};
    for (var t = 0; t < tokens.length; t++) {
        var tk = tokens[t];
        for (var r = 0; r < ranges.length; r++) {
            if (tk.x >= ranges[r].xMin && tk.x < ranges[r].xMax) {
                // First-wins so summary-row tokens (e.g. "Total (Net)" line)
                // don't overwrite data-row tokens. Tokens are ordered left-to-right
                // within a single row so duplicates within a row are unlikely.
                if (out[ranges[r].name] == null) out[ranges[r].name] = tk.value;
                break;
            }
        }
    }
    return out;
}
