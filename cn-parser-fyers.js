// ============================================================================
// FYERS CONTRACT NOTE PARSER
// Broker-specific parser plugin for Fyers Securities
// Registers itself into the global CN_PARSERS object
// ============================================================================
//
// PARSER CONTRACT:
// Each broker parser must register as: CN_PARSERS.<template_name> = function(pages, numPages) { ... }
//
// Input:
//   pages   — Array of page items. Each page is an array of {text, x, y, width, height}
//             Items are raw pdf.js text items (NOT sorted — parser must sort as needed)
//   numPages — Total number of pages in the PDF
//
// Output (must return):
//   {
//     tradeDate:  'YYYY-MM-DD',
//     cnNumber:   'string',
//     trades:     [{segment, description, buySell, qty, price, amount, orderNo, tradeNo, tradeTime,
//                   underlying, instrumentType, expiry, strikePrice, optionType}],
//     charges:    {
//       equity: {brokerage, stt, gst, exchangeCharges, sebiCharges, stampDuty, ipft},
//       nfo:    {brokerage, stt, gst, exchangeCharges, sebiCharges, stampDuty, ipft}
//     }
//   }
//
// Shared utility available: CN_UTILS.buildLines(items) — groups items into lines by Y coordinate
// ============================================================================

// Safety: ensure globals exist even if this script loads before transaction-import.js
if (typeof window.CN_PARSERS === 'undefined') window.CN_PARSERS = {};
if (typeof window.CN_UTILS === 'undefined') window.CN_UTILS = {};

CN_PARSERS.fyers = function(pages, numPages) {
    // Fyers CN structure:
    // Pages 1-2: Summary (we ignore BF/CF, only use B/S from summary for cross-check)
    // Page 2: Obligation Details (charges breakdown)
    // Pages 4+: Trade Annexure (individual trades)

    var allText = [];
    pages.forEach(function(pageItems) {
        // Sort by Y desc (top to bottom), then X asc (left to right)
        var sorted = pageItems.slice().sort(function(a, b) {
            var yDiff = b.y - a.y;
            if (Math.abs(yDiff) > 3) return yDiff;
            return a.x - b.x;
        });
        allText.push(sorted);
    });

    // Extract trade date and CN number from first page.
    // NOTE: some Fyers PDFs (e.g. REVISED/SUPPLEMENTARY notes) extract text as
    // one character per item, so a naive .join(' ') produces "1 5 / 0 4 / 2 0 26"
    // and the date regex fails. CN_UTILS.buildLines is gap-aware and groups
    // adjacent character items into proper words based on x-coordinate width.
    var tradeDate = null;
    var cnNumber = null;

    var firstPageLines = CN_UTILS.buildLines(allText[0]);
    var firstPageText = firstPageLines.map(function(l) { return l.text; }).join('\n');

    // Validate this is a Fyers contract note
    if (!/fyers/i.test(firstPageText)) {
        throw new Error('This does not appear to be a Fyers contract note. Please check you selected the correct broker account.');
    }

    var dateMatch = firstPageText.match(/Trade\s*Date\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i);
    if (dateMatch) {
        var parts = dateMatch[1].split('/');
        tradeDate = parts[2] + '-' + parts[1] + '-' + parts[0]; // YYYY-MM-DD
    }

    var cnMatch = firstPageText.match(/CONTRACT\s*NOTE\s*NO\s*:?\s*(\d+)/i);
    if (cnMatch) cnNumber = cnMatch[1];

    if (!tradeDate) throw new Error('Could not extract Trade Date. Is this a valid Fyers contract note?');
    if (!cnNumber) throw new Error('Could not extract Contract Note Number. Is this a valid Fyers contract note?');

    // Parse Trade Annexure pages (pages with "Trade Annexure" or individual trade rows)
    var trades = [];
    var currentSegment = null; // 'EQUITY' or 'NFO'

    for (var p = 0; p < allText.length; p++) {
        var pageText = allText[p];
        // Build lines from items grouped by Y coordinate
        var lines = CN_UTILS.buildLines(pageText);

        for (var li = 0; li < lines.length; li++) {
            var lineText = lines[li].text;

            // Detect segment headers
            if (lineText.match(/NCL-NSE-Equity/i) || lineText.match(/NCL-BSE-Equity/i)) {
                currentSegment = 'EQUITY';
                continue;
            }
            if (lineText.match(/^NSEFO$/i) || lineText.match(/^BSEFO$/i) || lineText.match(/^MCXFO$/i) || lineText.match(/^NSEFO$/)) {
                currentSegment = 'NFO';
                continue;
            }

            // Skip non-trade lines (but NOT lines starting with a long order number — those are trade rows)
            if (!currentSegment) continue;
            if (lineText.match(/^Order Number/i) || lineText.match(/^Trade Annexure/i) || lineText.match(/^Notes:/i) || lineText.match(/^Page \d/i)) continue;
            if (lineText.match(/^\*\s*Remark/)) continue;
            if (!lineText.match(/^\d{10,}/) && lineText.match(/REVISED|CONTRACT NOTE|FYERS SECURITIES|Registered Office|SEBI Reg|Compliance|UCC|Name of|Address|\bState\b|Mobile|\bPAN\b|Client GSTIN|Invoice|Equity ICCL|Settlement/i)) continue;

            // Parse trade row: OrderNo, OrderTime, TradeNo, TradeTime, Security, B/S, Qty, Price, [ForeignPrice], NetRate, NetAmount, [Remark]
            var tradeMatch = parseFyersTradeRow(lines[li].items, currentSegment);
            if (tradeMatch) {
                // If the description came back empty/short, the PDF likely wrapped the
                // security description onto adjacent Y-lines (common for long names like
                // "JAYNECOIND-JAYASWAL NECO INDUSTRIES LTD."). Recover by scanning lines
                // within ±15 pixels of the trade row's Y for items in the description
                // column (between the end of TradeTime and the start of B/S).
                if (!tradeMatch.underlying || tradeMatch.description.length < 3) {
                    var wrapped = _fyersRecoverWrappedDescription(lines, li);
                    if (wrapped) {
                        tradeMatch.description = wrapped;
                        var info = parseFyersSecurityDescription(wrapped, currentSegment);
                        tradeMatch.underlying = info.underlying;
                        tradeMatch.instrumentType = info.instrumentType;
                        tradeMatch.expiry = info.expiry;
                        tradeMatch.strikePrice = info.strikePrice;
                        tradeMatch.optionType = info.optionType;
                    }
                }
                trades.push(tradeMatch);
            }
        }
    }

    if (trades.length === 0) throw new Error('No trades found in the Trade Annexure. Is this a valid Fyers contract note?');

    // Parse Obligation Details for charges
    var charges = parseFyersObligationDetails(allText);

    return { tradeDate: tradeDate, cnNumber: cnNumber, trades: trades, charges: charges };
};

// ============================================================================
// Fyers-specific helper functions (private to this parser)
// ============================================================================

function parseFyersTradeRow(items, segment) {
    // Trade row items sorted by X position.
    // Expected columns: OrderNo(long number), OrderTime(HH:MM:SS), TradeNo, TradeTime, SecurityDesc, B/S, Qty, Price, [ForeignPrice], NetRate, NetAmount, [Remark]
    var texts = items.map(function(i) { return i.text.trim(); }).filter(function(t) { return t.length > 0; });

    // Must start with a long order number (at least 10 digits)
    if (!texts[0] || !texts[0].match(/^\d{10,}$/)) return null;

    // Find B or S marker
    var bsIdx = -1;
    for (var i = 0; i < texts.length; i++) {
        if (texts[i] === 'B' || texts[i] === 'S') { bsIdx = i; break; }
    }
    if (bsIdx < 0) return null;

    // Security description is everything between TradeTime and B/S
    // TradeTime is at index 3 (OrderNo, OrderTime, TradeNo, TradeTime, ...desc..., B/S, Qty, ...)
    var descParts = texts.slice(4, bsIdx);
    var description = descParts.join(' ');

    var buySell = texts[bsIdx] === 'B' ? 'BUY' : 'SELL';
    var qty = parseInt(texts[bsIdx + 1]) || 0;
    var price = parseFloat(texts[bsIdx + 2]) || 0;

    // Net Amount is typically the last numeric value
    var netAmount = 0;
    for (var j = texts.length - 1; j > bsIdx; j--) {
        var val = parseFloat(texts[j]);
        if (!isNaN(val) && Math.abs(val) > 1) { netAmount = Math.abs(val); break; }
    }

    if (qty === 0 || price === 0) return null;

    // Extract underlying symbol from description
    var symbolInfo = parseFyersSecurityDescription(description, segment);

    return {
        segment: segment,
        description: description,
        buySell: buySell,
        qty: Math.abs(qty),
        price: price,
        amount: netAmount || (Math.abs(qty) * price),
        orderNo: texts[0],
        tradeNo: texts[2],
        tradeTime: texts[3],
        underlying: symbolInfo.underlying,
        instrumentType: symbolInfo.instrumentType,
        expiry: symbolInfo.expiry,
        strikePrice: symbolInfo.strikePrice,
        optionType: symbolInfo.optionType
    };
}

// Some Fyers CNs wrap a long security description onto two or three visual
// lines (different Y) while the actual trade row (order no, qty, price, etc.)
// sits on one Y in the middle. Recover the full description by gathering items
// from lines within ±15 pixels of the trade row that fall inside the
// description column — the X range between the end of TradeTime and the start
// of the B/S marker on the trade row.
function _fyersRecoverWrappedDescription(lines, tradeLineIdx) {
    var tradeLine = lines[tradeLineIdx];
    if (!tradeLine || !tradeLine.items) return null;
    var items = tradeLine.items.slice().sort(function(a, b) { return a.x - b.x; });
    // Find TradeTime index (4th non-empty text item — after OrderNo, OrderTime, TradeNo)
    var nonEmpty = items.filter(function(it) { return it.text.trim().length > 0; });
    if (nonEmpty.length < 5) return null;
    var tradeTimeItem = nonEmpty[3];
    var descColLeft = tradeTimeItem.x + (tradeTimeItem.width || 0) + 2;
    // Find the B/S marker (first standalone 'B' or 'S' after tradeTime)
    var bsItem = null;
    for (var i = 4; i < nonEmpty.length; i++) {
        var t = nonEmpty[i].text.trim();
        if (t === 'B' || t === 'S') { bsItem = nonEmpty[i]; break; }
    }
    if (!bsItem) return null;
    var descColRight = bsItem.x - 2;
    var tradeY = tradeLine.y;

    // Scan lines within ±15 pixels of tradeY, collect items in the desc column
    var collected = [];
    for (var j = 0; j < lines.length; j++) {
        var ln = lines[j];
        if (Math.abs(ln.y - tradeY) > 15) continue;
        ln.items.forEach(function(it) {
            if (!it.text || !it.text.trim()) return;
            if (it.x >= descColLeft && it.x <= descColRight) collected.push(it);
        });
    }
    if (collected.length === 0) return null;

    // Sort by Y desc (top-to-bottom visually), then X asc within the same Y band
    collected.sort(function(a, b) {
        var dy = b.y - a.y;
        if (Math.abs(dy) > 3) return dy;
        return a.x - b.x;
    });

    // Re-assemble using gap-aware join (same logic as CN_UTILS.buildLines)
    var text = '';
    var lastY = null, lastEnd = null;
    for (var k = 0; k < collected.length; k++) {
        var it = collected[k];
        if (lastY !== null && Math.abs(it.y - lastY) > 3) {
            text += ' '; // line wrap → single space
            lastEnd = null;
        } else if (lastEnd !== null) {
            if ((it.x - lastEnd) > 2) text += ' ';
        }
        text += it.text;
        lastY = it.y;
        lastEnd = it.x + (it.width || 0);
    }
    return text.trim();
}

function parseFyersSecurityDescription(desc, segment) {
    // Equity: "PVP-PVP VENTURES LIMITED" → underlying=PVP
    // FUTSTK: "FUTSTK 360ONE 24Feb2026" → underlying=360ONE, type=FUTURES
    // OPTIDX: "OPTIDX NIFTY 03Feb2026 25300 PE" → underlying=NIFTY, type=OPTIONS, strike=25300, option=PE

    var result = { underlying: '', instrumentType: '', expiry: null, strikePrice: null, optionType: null };

    if (segment === 'EQUITY') {
        // "PVP-PVP VENTURES LIMITED" → symbol is before the dash
        var dashIdx = desc.indexOf('-');
        result.underlying = dashIdx > 0 ? desc.substring(0, dashIdx).trim() : desc.trim();
        result.instrumentType = 'EQUITY';
        return result;
    }

    // F&O formats
    var parts = desc.split(/\s+/);
    if (parts.length < 3) { result.underlying = desc; return result; }

    var instrPrefix = parts[0]; // FUTSTK, FUTIDX, OPTSTK, OPTIDX, OPTCUR, FUTCUR, etc.
    result.underlying = parts[1];

    // Parse instrument type
    if (instrPrefix.startsWith('FUT')) {
        result.instrumentType = 'FUTURES';
        // Expiry: "24Feb2026"
        if (parts[2]) result.expiry = parseFyersExpiry(parts[2]);
    } else if (instrPrefix.startsWith('OPT')) {
        result.instrumentType = 'OPTIONS';
        if (parts[2]) result.expiry = parseFyersExpiry(parts[2]);
        if (parts[3]) result.strikePrice = parseFloat(parts[3]) || null;
        if (parts[4]) result.optionType = parts[4]; // CE or PE
    }

    return result;
}

function parseFyersExpiry(str) {
    // "24Feb2026" → "2026-02-24"
    var m = str.match(/(\d{1,2})(\w{3})(\d{4})/);
    if (!m) return null;
    var months = { Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06', Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12' };
    var mon = months[m[2]];
    if (!mon) return null;
    return m[3] + '-' + mon + '-' + ('0' + m[1]).slice(-2);
}

function parseFyersObligationDetails(allText) {
    // Look for "Obligation Details" section on page 2 (or wherever it appears)
    // Extract: Brokerage, IGST, Stamp Duty, STT, exchange charges, SEBI charges
    // per segment (NCLCM = equity, NCLFO = F&O)

    var charges = {
        equity: { brokerage: 0, stt: 0, gst: 0, exchangeCharges: 0, sebiCharges: 0, stampDuty: 0, ipft: 0 },
        nfo: { brokerage: 0, stt: 0, gst: 0, exchangeCharges: 0, sebiCharges: 0, stampDuty: 0, ipft: 0 }
    };

    for (var p = 0; p < allText.length; p++) {
        var lines = CN_UTILS.buildLines(allText[p]);
        var inObligationSection = false;

        for (var li = 0; li < lines.length; li++) {
            var lineText = lines[li].text;

            if (lineText.match(/Obligation\s*Details/i)) { inObligationSection = true; continue; }
            if (!inObligationSection) continue;
            if (lineText.match(/Net Amount Receivable/i)) { inObligationSection = false; continue; }

            // Parse charge rows: "Description NCLCM_value NCLFO_value ... Total"
            var nums = CN_UTILS.extractNumbers(lineText);

            if (lineText.match(/Brokerage/i) && !lineText.match(/GST on brokerage/i)) {
                if (nums.length >= 2) { charges.equity.brokerage = nums[0]; charges.nfo.brokerage = nums[1]; }
            } else if (lineText.match(/Stamp\s*Duty/i)) {
                if (nums.length >= 2) { charges.equity.stampDuty = nums[0]; charges.nfo.stampDuty = nums[1]; }
            } else if (lineText.match(/Securities\s*Trans/i) || lineText.match(/^STT/i)) {
                if (nums.length >= 2) { charges.equity.stt = nums[0]; charges.nfo.stt = nums[1]; }
            } else if (lineText.match(/IGST|CGST|SGST/i)) {
                if (nums.length >= 2) { charges.equity.gst = nums[0]; charges.nfo.gst = nums[1]; }
            } else if (lineText.match(/Toc.*Exchange/i) || lineText.match(/Transaction.*Exchange/i)) {
                if (nums.length >= 2) { charges.equity.exchangeCharges = nums[0]; charges.nfo.exchangeCharges = nums[1]; }
            } else if (lineText.match(/Sebitoc|SEBI/i)) {
                if (nums.length >= 2) { charges.equity.sebiCharges = nums[0]; charges.nfo.sebiCharges = nums[1]; }
            } else if (lineText.match(/Ipft/i)) {
                if (nums.length >= 2) { charges.equity.ipft = nums[0]; charges.nfo.ipft = nums[1]; }
            } else if (lineText.match(/Cmcharges/i)) {
                if (nums.length >= 2) { charges.equity.exchangeCharges += nums[0]; charges.nfo.exchangeCharges += nums[1]; }
            }
        }
    }

    return charges;
}
