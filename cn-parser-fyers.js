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

    var _columnMapLogged = false; // log once per parse session to aid debugging
    for (var p = 0; p < allText.length; p++) {
        var pageText = allText[p];
        // Build lines from items grouped by Y coordinate
        var lines = CN_UTILS.buildLines(pageText);

        // Phase 2: calibrate column X-ranges from the first trade row on this
        // page. Dormant — Phase 3 will use the map in parseFyersTradeRow.
        // Logged once per parse session for verification / debugging.
        var columnMap = _fyersBuildColumnMap(lines);
        if (columnMap && !_columnMapLogged) {
            try {
                console.log('[Fyers parser] column map (page ' + (p + 1) + '):',
                    JSON.stringify(columnMap));
            } catch (_) { /* console may not be available in some contexts */ }
            _columnMapLogged = true;
        }

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

// Phase 2 — Column boundary calibration (added for structural parser refactor).
//
// The Trade Annexure in a Fyers CN is a fixed-column table. Every trade row has
// items at the same X positions regardless of that row's specific data. Rather
// than parsing by texts[i] index (which breaks when text items get split or
// merged differently by the PDF renderer), we calibrate column X-ranges from
// the FIRST trade row on a page and then reuse those ranges to interpret every
// subsequent trade row structurally.
//
// How we find the first trade row: same signature already used elsewhere — the
// first line whose text starts with a 10+ digit order number.
//
// Column layout (after the header "Order Number | Order Time | Trade No. |
// Trade Time | Security/Contract Description | Buy/Sell | Quantity | Price |
// Price (foreign) | Net Rate | Net Amount | Remark"):
//   left-aligned cols:  orderNo, orderTime, tradeNo, tradeTime, description, remark
//   right-aligned cols: qty, price, foreignPrice (usually empty), netRate, netAmount
//   single char col:    bs (B or S)
//
// Returns null if no trade row on the page or fewer than 5 non-empty items on
// the first trade row (insufficient data to calibrate). Phase 3 consumers must
// fall back to the legacy position-based logic when null is returned.
function _fyersBuildColumnMap(lines) {
    // Find first trade row
    var tradeLine = null;
    for (var i = 0; i < lines.length; i++) {
        if (/^\d{10,}/.test(lines[i].text)) { tradeLine = lines[i]; break; }
    }
    if (!tradeLine || !tradeLine.items) return null;

    var items = tradeLine.items.slice()
        .filter(function(it) { return it.text && it.text.trim().length > 0; })
        .sort(function(a, b) { return a.x - b.x; });
    if (items.length < 5) return null; // need OrderNo, OrderTime, TradeNo, TradeTime, B/S at minimum

    // Find B/S marker (first standalone 'B' or 'S')
    var bsIdx = -1;
    for (var j = 0; j < items.length; j++) {
        var t = items[j].text.trim();
        if (t === 'B' || t === 'S') { bsIdx = j; break; }
    }
    if (bsIdx < 4) return null; // must have 4 columns before B/S

    var orderNo = items[0];
    var orderTime = items[1];
    var tradeNo = items[2];
    var tradeTime = items[3];
    var bs = items[bsIdx];

    // Items after B/S. These are right-aligned numerics (qty, price, net_rate,
    // net_amount) possibly with a foreign_price in between, and an optional
    // alpha remark at the end. Classify each as numeric or alpha.
    var afterBs = items.slice(bsIdx + 1).map(function(it) {
        var txt = it.text.trim();
        var num = parseFloat(txt);
        return {
            x: it.x,
            width: it.width || 0,
            text: txt,
            isNumeric: !isNaN(num) && /^[\d.,\-]+$/.test(txt)
        };
    });

    // Description column spans from right-edge of TradeTime (+padding) to
    // left-edge of B/S (-padding). Works even when the first trade row's
    // description is wrapped onto adjacent Y-lines (desc column is empty on
    // the trade row itself) because we compute the range structurally.
    var descLeft = tradeTime.x + (tradeTime.width || 0) + 2;
    var descRight = bs.x - 2;

    return {
        tradeRowY: tradeLine.y,
        columns: {
            orderNo:    { left: orderNo.x - 2, right: (orderTime.x - 1) },
            orderTime:  { left: orderTime.x - 2, right: (tradeNo.x - 1) },
            tradeNo:    { left: tradeNo.x - 2, right: (tradeTime.x - 1) },
            tradeTime:  { left: tradeTime.x - 2, right: descLeft - 1 },
            description:{ left: descLeft, right: descRight },
            bs:         { left: bs.x - 3, right: bs.x + (bs.width || 3) + 3 }
        },
        // Right-aligned numeric columns after B/S. Stored as ordered anchors
        // (item center X) so Phase 3 can match by nearest-anchor. Includes
        // foreign_price if present (all numeric), excludes any trailing alpha
        // remark. The LAST numeric is always Net Amount by convention.
        afterBsNumerics: afterBs.filter(function(a) { return a.isNumeric; })
                                 .map(function(a) { return { x: a.x, width: a.width }; }),
        // Optional remark column — the trailing non-numeric after the numerics.
        remarkAnchor: (function() {
            for (var k = afterBs.length - 1; k >= 0; k--) {
                if (!afterBs[k].isNumeric) return { x: afterBs[k].x, width: afterBs[k].width };
                break; // numeric before remark — stop
            }
            return null;
        })()
    };
}

// Some Fyers CNs wrap a long security description onto two or three visual
// lines (different Y) while the actual trade row (order no, qty, price, etc.)
// sits on one Y in the middle. Recover the full description by gathering items
// in the description column (X range bounded by TradeTime end and B/S start)
// within a Y band bounded by the nearest trade-row neighbours above and below.
// This prevents bleeding into an adjacent trade row's wrapped description when
// trade rows are packed tight (e.g. 12 px apart with descriptions wrapping to
// ±6 px from each row).
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

    // Compute neighbour-aware Y window. A trade row is detected by its line
    // text starting with a 10+ digit order number — same signature used by
    // parseFyersTradeRow. Walk all lines, collect trade-row Y coordinates,
    // and bound the scan to HALFWAY to each neighbour (so scans at row N
    // can never bleed into row N±1's description area).
    var tradeYs = [];
    for (var tj = 0; tj < lines.length; tj++) {
        if (/^\d{10,}/.test(lines[tj].text)) tradeYs.push(lines[tj].y);
    }
    var prevY = null; // higher Y (above in reading order)
    var nextY = null; // lower Y (below in reading order)
    tradeYs.forEach(function(y) {
        if (y > tradeY && (prevY === null || y < prevY)) prevY = y;
        if (y < tradeY && (nextY === null || y > nextY)) nextY = y;
    });
    // Default half-window when no neighbour exists (solo trade row)
    var DEFAULT_HALF = 15;
    var upperBound = (prevY !== null) ? (prevY + tradeY) / 2 : tradeY + DEFAULT_HALF;
    var lowerBound = (nextY !== null) ? (nextY + tradeY) / 2 : tradeY - DEFAULT_HALF;

    // Collect items in the desc column whose Y falls strictly between bounds
    // (the midpoint itself is ambiguous — exclude to avoid double-counting).
    var collected = [];
    for (var j = 0; j < lines.length; j++) {
        var ln = lines[j];
        if (ln.y <= lowerBound || ln.y >= upperBound) continue;
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
