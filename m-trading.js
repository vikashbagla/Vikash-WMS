// ============================================================================
// m-trading.js — PHONE LAYER for Trading (Portfolio + F&O phone lists)
// ----------------------------------------------------------------------------
// Loaded ONLY on phones (app.html: smallest screen side <= 480px); desktop never
// downloads it. Rules (UI-STANDARDS §D.13.2, Phone Layer Plan v1):
//   • Phone code lives here (and in m-styles.css), never in desktop files.
//   • NO money maths here — every number comes from the shared helpers that the
//     desktop uses (trHoldingVM, trInvestorBreakdown, trFnoCalcPositions output).
//   • Desktop files hand data over with ONE guarded line each:
//       trading.js     trRenderPortfolio → trRenderPortfolioMobile(...)
//       trading-fno.js trFnoRender       → trFnoRenderMobile(positions)
//       app.html       boot              → wmsPhoneLanding()
// Moved verbatim from trading.js / trading-fno.js on 2026-11-03 (no logic change).
// ============================================================================

// ---- Phone state (moved from trading.js / trading-fno.js) ----

var trMobileBreakupKey = null;     // phone: holding key currently drilled into investor breakup (null = normal list)
var trMobileBreakupInv = null;     // phone: investorId expanded within the breakup view
var trFnoMobileContractKey = null; // phone: 'symbol|idx' of the contract row whose detail is expanded

// ---- Phone landing (moved from app.html boot, D.13.5) ----
// Phone (≤480px) is review-first: open Trading → Portfolio when granted.
// Returns true when it handled the landing; app.html falls back to the last module otherwise.
function wmsPhoneLanding() {
    if (!(window.matchMedia('(max-width:480px)').matches && wmsHasModule('trading'))) return false;
    Promise.resolve(loadModule('trading')).then(function() {
        if (typeof trSwitchTab === 'function') trSwitchTab('tr-portfolio');
        document.querySelectorAll('#wmsBottomNav .bnav-item').forEach(function(b) { b.classList.remove('active'); });
        var pBtn = document.querySelector('#wmsBottomNav .bnav-item[data-subtab="tr-portfolio"]');
        if (pBtn) pBtn.classList.add('active');
    });
    return true;
}


// Phone helper: format a per-share PRICE with a ₹ prefix (to distinguish prices
// from rupee amounts in the compact lists). Returns '-' untouched for zero/null.
// Never used on desktop — desktop keeps plain formatPrice.
function trFmtRupee(v) {
    var s = formatPrice(v, false);
    return s === '-' ? s : '₹' + s;
}

// ============================================================================
// PHONE COMPACT-ROW LIST (≤480px) — reuses trHoldingVM for all derived numbers
// ============================================================================
function trRenderPortfolioMobile(holdings, totalInvested, totalValue, totalPL, totalPLPct, totalDayPL, totalDayPLPct) {
    var box = document.getElementById('tr-portfolio-cards');
    if (!box) return;
    trWireSortButton();
    trWireMoreRepos();

    // ---- Investor breakup drill-in (one holding → per-investor compact rows) ----
    if (trMobileBreakupKey) {
        var bh = holdings.filter(function(x) { return x.key === trMobileBreakupKey; })[0];
        if (bh) { trRenderPortfolioBreakup(box, bh, totalInvested, totalValue); return; }
        trMobileBreakupKey = null;  // holding gone (filter changed) → fall back to list
    }

    var dayValHtml = (totalDayPL !== null)
        ? '<div class="trm-s-val ' + getAmountClass(totalDayPL) + '">' + formatAmount(totalDayPL) + '</div>'
        : '<div class="trm-s-val">-</div>';

    var summary =
        '<div class="trm-summary">' +
            '<div class="trm-s-block"><div class="trm-s-label">Invested</div><div class="trm-s-val">' + formatAmount(totalInvested) + '</div></div>' +
            '<div class="trm-s-block"><div class="trm-s-label">Value</div><div class="trm-s-val">' + formatAmount(totalValue) + '</div></div>' +
            '<div class="trm-s-block"><div class="trm-s-label">Day P&L</div>' + dayValHtml + '</div>' +
            '<div class="trm-s-block"><div class="trm-s-label">Total P&L</div><div class="trm-s-val ' + getAmountClass(totalPL) + '">' + formatAmount(totalPL) + '</div></div>' +
        '</div>';

    var rows = holdings.map(function(h) {
        var vm = trHoldingVM(h, totalInvested, totalValue);
        var isOpen = trExpandedKey === h.key;
        var name = wmsEsc(h.companyName || h.shortSymbol);
        var qtyStr = h.quantity < 0 ? '(' + formatQuantity(Math.abs(h.quantity)) + ')' : formatQuantity(h.quantity);
        var dayPctHtml = vm.dayChp !== null
            ? ' <span class="' + getAmountClass(vm.dayChp) + '">' + formatPercent(vm.dayChp) + '</span>'
            : '';

        var m = trSortMetric(vm);
        var leftHtml = qtyStr + ' <span class="trm-at">@</span> ' + trFmtRupee(h.avgCost);
        var midHtml = trFmtRupee(vm.price) + dayPctHtml;
        var row = trBuildMobileRow(h.key, name, m.topHtml, leftHtml, midHtml, m.botHtml, isOpen);

        var detail = '';
        if (isOpen) {
            var tagsHtml = (h.tags && h.tags.length > 0)
                ? '<div class="trm-tags">' + h.tags.map(function(t) { return '<span class="tag-pill">' + wmsEsc(t) + '</span>'; }).join('') + '</div>'
                : '';
            // Offer the investor drill-in only when the holding spans >1 investor
            var invCount = trInvestorBreakdown(h, vm.price, vm.md).length;
            var breakupLink = invCount > 1
                ? '<div class="trm-breakup-link" data-bkey="' + h.key + '">By investor (' + invCount + ') <span class="trm-chev">&rsaquo;</span></div>'
                : '';
            var hInvs = {}, hBrks = {};
            (h._txns || []).forEach(function(t) { hInvs[trInvName(t.investor_id)] = 1; var bc = trBrkCode(t.broker_id); if (bc) hBrks[bc] = 1; });
            var hInvStr = Object.keys(hInvs).join(', ') || '-';
            var hBrkStr = Object.keys(hBrks).join(', ') || '-';
            var cmpDay = trFmtRupee(vm.price) + dayPctHtml;
            var totPlV = '<span class="' + getAmountClass(vm.pl) + '">' + formatAmount(vm.pl) + ' ' + formatPercent(vm.plPct) + '</span>';
            var dayPlV = (vm.dayPL !== null)
                ? '<span class="' + getAmountClass(vm.dayPL) + '">' + formatAmount(vm.dayPL) + ' ' + formatPercent(vm.dayChp) + '</span>'
                : '-';
            // Left column reads top-to-bottom: Qty&Avg, Invested, Investor, Broker
            // Right column: CMP&day%, Current value, Total P&L, Day's P&L (grid is row-major)
            detail =
                '<div class="trm-detail">' +
                    '<div class="trm-detail-grid">' +
                        trDi('Qty &amp; Avg', qtyStr + ' @ ' + trFmtRupee(h.avgCost)) +
                        trDi('CMP &amp; day%', cmpDay) +
                        trDi('Invested', formatAmount(vm.invested) + ' &middot; <span class="trm-muted-pct">' + vm.invPct.toFixed(1) + '%</span>') +
                        trDi('Cur. value', formatAmount(vm.currentValue) + ' &middot; <span class="trm-muted-pct">' + vm.valPct.toFixed(1) + '%</span>') +
                        trDi('Investor', wmsEsc(hInvStr)) +
                        trDi('Total P&L', totPlV) +
                        trDi('Broker', wmsEsc(hBrkStr)) +
                        trDi("Day's P&L", dayPlV) +
                    '</div>' + tagsHtml + breakupLink +
                '</div>';
        }
        return row + detail;
    }).join('');

    box.innerHTML = summary + rows;
    trWireMobileRows(box);

    box.querySelectorAll('.trm-breakup-link[data-bkey]').forEach(function(el) {
        el.addEventListener('click', function(e) {
            e.stopPropagation();
            trMobileBreakupKey = el.dataset.bkey;
            trMobileBreakupInv = null;
            trRenderPortfolio();
        });
    });
}

// Phone-only: the view-tabs-bar dropdowns (▾More, ⇅Sort) are clipped by the
// overflow:hidden tab/container ancestors when the tab is short. On ≤480 re-anchor
// the OPEN dropdown to the viewport (position:fixed) so it escapes all clipping.
// No-op on desktop (>480) — desktop keeps the absolute-positioned dropdown.
function trReposDropdownMobile(dd, btn) {
    if (!dd || !btn || window.innerWidth > 480) return;
    if (dd.style.display !== 'block') return;
    var r = btn.getBoundingClientRect();
    dd.style.position = 'fixed';
    dd.style.top = (r.bottom + 4) + 'px';
    dd.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
    dd.style.left = 'auto';
    dd.style.zIndex = '2000';
}

// Re-anchor the ▾More dropdowns (Portfolio + F&O) after the view manager toggles
// them. Wired once per DOM lifetime via dataset guard.
function trWireMoreRepos() {
    // F&O handles its own More toggle+repos in trFnoWireMore(); only Portfolio here.
    [['tr-more-btn', 'tr-more-dropdown']].forEach(function(pair) {
        var btn = document.getElementById(pair[0]);
        if (!btn || btn.dataset.reposWired) return;
        btn.dataset.reposWired = '1';
        btn.addEventListener('click', function() {
            var dd = document.getElementById(pair[1]);
            setTimeout(function() { trReposDropdownMobile(dd, btn); }, 0);
        });
    });
}

// Phone-only sort control (next to ▾ More). Wires once per DOM lifetime via a
// data attribute (resets when the lazy-loaded trading.html DOM is recreated).
// Drives the shared trSortColumn/trSortDirection — the mobile list is built from
// the already-sorted `holdings`, so just re-rendering applies the new order.
function trWireSortButton() {
    var btn = document.getElementById('tr-sort-btn');
    var dd = document.getElementById('tr-sort-dropdown');
    if (!btn || !dd || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var willOpen = dd.style.display === 'none';
        var more = document.getElementById('tr-more-dropdown'); if (more) more.style.display = 'none';
        dd.style.display = willOpen ? 'block' : 'none';
        if (willOpen) { trSortDropdownMark(); trReposDropdownMobile(dd, btn); }
    });
    dd.querySelectorAll('[data-sort]').forEach(function(item) {
        item.addEventListener('click', function(e) {
            e.stopPropagation();
            var col = item.dataset.sort;
            if (trSortColumn === col) {
                trSortDirection = (trSortDirection === 'asc') ? 'desc' : 'asc';
            } else {
                trSortColumn = col;
                trSortDirection = (col === 'company') ? 'asc' : 'desc';  // names A→Z, numbers/date high→low
            }
            trSortByPct = false;
            dd.style.display = 'none';
            trRenderPortfolio();
        });
    });
    if (!window._trSortDocWired) {
        window._trSortDocWired = true;
        document.addEventListener('click', function() {
            var d = document.getElementById('tr-sort-dropdown'); if (d) d.style.display = 'none';
        });
    }
}

// Mark the active sort option + show its direction arrow when the menu opens
function trSortDropdownMark() {
    var dd = document.getElementById('tr-sort-dropdown'); if (!dd) return;
    dd.querySelectorAll('[data-sort]').forEach(function(item) {
        var active = item.dataset.sort === trSortColumn;
        item.classList.toggle('active', active);
        var arrow = item.querySelector('.tr-sort-arrow');
        if (arrow) arrow.textContent = active ? (trSortDirection === 'asc' ? '▲' : '▼') : '';
    });
}

// Shared 3-zone compact-row markup (holdings list AND breakup list):
// line 1 = name + right-top amount; line 2 = Qty@Avg (left) · CMP day% (middle) · metric% (right).
// All four content slots are ready HTML so callers control formatting/colour.
function trBuildMobileRow(key, name, rightTopHtml, leftHtml, midHtml, rightBotHtml, isOpen) {
    return '<div class="trm-row' + (isOpen ? ' trm-open' : '') + '" data-key="' + key + '">' +
            '<div class="trm-l1">' +
                '<span class="trm-sym">' + name + '</span>' +
                '<span class="trm-r1">' + rightTopHtml + '</span>' +
            '</div>' +
            '<div class="trm-l2 trm-l2-3">' +
                '<span class="trm-zl">' + leftHtml + '</span>' +
                '<span class="trm-zm">' + midHtml + '</span>' +
                '<span class="trm-zr">' + rightBotHtml + '</span>' +
            '</div>' +
        '</div>';
}

// Right-column metric for the compact row, driven by the active sort:
// Date/Symbol → Total P&L; Day's P&L → Day's P&L; Investment → Invested;
// Current value → Current value. Returns ready top (amount) + bottom (%) HTML.
function trSortMetric(vm) {
    var amt, amtCls, pctHtml;
    switch (trSortColumn) {
        case 'daypl':
            amt = vm.dayPL; amtCls = getAmountClass(vm.dayPL);
            pctHtml = (vm.dayChp != null) ? '<span class="' + getAmountClass(vm.dayChp) + '">' + formatPercent(vm.dayChp) + '</span>' : '-';
            break;
        case 'invested':
            amt = vm.invested; amtCls = '';
            pctHtml = '<span class="trm-muted-pct">' + vm.invPct.toFixed(1) + '%</span>';
            break;
        case 'value':
            amt = vm.currentValue; amtCls = '';
            pctHtml = '<span class="trm-muted-pct">' + vm.valPct.toFixed(1) + '%</span>';
            break;
        default: // 'date' / 'company' → Total P&L
            amt = vm.pl; amtCls = getAmountClass(vm.pl);
            pctHtml = '<span class="' + getAmountClass(vm.plPct) + '">' + formatPercent(vm.plPct) + '</span>';
    }
    return { topHtml: '<span class="trm-pl-main ' + amtCls + '">' + formatAmount(amt) + '</span>', botHtml: pctHtml };
}

// One detail-box item (label + value on the SAME row, compact)
function trDi(k, v) {
    return '<div class="trm-d-item"><span class="trm-d-k">' + k + '</span><span class="trm-d-v">' + v + '</span></div>';
}

function trWireMobileRows(box) {
    box.querySelectorAll('.trm-row[data-key]').forEach(function(el) {
        el.addEventListener('click', function() {
            var key = el.dataset.key;
            trExpandedKey = (trExpandedKey === key) ? null : key;
            trRenderPortfolio();
        });
    });
}

// Per-investor breakup screen for one holding — same compact rows + tap-to-expand
function trRenderPortfolioBreakup(box, h, totalInvested, totalValue) {
    var vm = trHoldingVM(h, totalInvested, totalValue);
    var invs = trInvestorBreakdown(h, vm.price, vm.md);
    var name = wmsEsc(h.companyName || h.shortSymbol);

    var header =
        '<div class="trm-breakup-hd">' +
            '<button class="trm-back" id="trmBreakupBack">&lsaquo; Back</button>' +
            '<div class="trm-breakup-title">' + name + '</div>' +
            '<div class="trm-breakup-tot ' + getAmountClass(vm.pl) + '">' + formatAmount(vm.pl) + '</div>' +
        '</div>';

    var rows = invs.map(function(g) {
        var isOpen = trMobileBreakupInv === g.investorId;
        var qtyStr = g.quantity < 0 ? '(' + formatQuantity(Math.abs(g.quantity)) + ')' : formatQuantity(g.quantity);
        var dayPctHtml = g.dayChp !== null
            ? ' <span class="' + getAmountClass(g.dayChp) + '">' + formatPercent(g.dayChp) + '</span>'
            : '';
        var bRightTop = '<span class="trm-pl-main ' + getAmountClass(g.pl) + '">' + formatAmount(g.pl) + '</span>';
        var bLeft = qtyStr + ' <span class="trm-at">@</span> ' + trFmtRupee(g.avgCost);
        var bMid = trFmtRupee(vm.price) + dayPctHtml;
        var bRightBot = '<span class="' + getAmountClass(g.plPct) + '">' + formatPercent(g.plPct) + '</span>';
        var row = trBuildMobileRow('inv:' + g.investorId, wmsEsc(g.name), bRightTop, bLeft, bMid, bRightBot, isOpen);

        var detail = '';
        if (isOpen) {
            var pctOfStock = (h.totalCost && h.totalCost !== 0) ? (g.invested / Math.abs(h.totalCost)) * 100 : 0;
            var tagsHtml = (g.tags && g.tags.length > 0)
                ? '<div class="trm-tags">' + g.tags.map(function(t) { return '<span class="tag-pill">' + wmsEsc(t) + '</span>'; }).join('') + '</div>'
                : '';
            var gBrks = {};
            (g.txns || []).forEach(function(t) { var bc = trBrkCode(t.broker_id); if (bc) gBrks[bc] = 1; });
            var gBrkStr = Object.keys(gBrks).join(', ') || '-';
            var bCmpDay = trFmtRupee(vm.price) + dayPctHtml;
            var bTotPlV = '<span class="' + getAmountClass(g.pl) + '">' + formatAmount(g.pl) + ' ' + formatPercent(g.plPct) + '</span>';
            var bDayPlV = (g.dayPL !== null)
                ? '<span class="' + getAmountClass(g.dayPL) + '">' + formatAmount(g.dayPL) + ' ' + formatPercent(g.dayChp) + '</span>'
                : '-';
            detail =
                '<div class="trm-detail">' +
                    '<div class="trm-detail-grid">' +
                        trDi('Qty &amp; Avg', qtyStr + ' @ ' + trFmtRupee(g.avgCost)) +
                        trDi('CMP &amp; day%', bCmpDay) +
                        trDi('Invested', formatAmount(g.invested)) +
                        trDi('Cur. value', formatAmount(g.value)) +
                        trDi('% of stock', pctOfStock.toFixed(1) + '%') +
                        trDi('Total P&L', bTotPlV) +
                        trDi('Broker', wmsEsc(gBrkStr)) +
                        trDi("Day's P&L", bDayPlV) +
                    '</div>' + tagsHtml +
                '</div>';
        }
        return row + detail;
    }).join('');

    box.innerHTML = header + rows;

    var back = document.getElementById('trmBreakupBack');
    if (back) back.addEventListener('click', function() { trMobileBreakupKey = null; trRenderPortfolio(); });

    box.querySelectorAll('.trm-row[data-key]').forEach(function(el) {
        el.addEventListener('click', function() {
            var invId = el.dataset.key.replace(/^inv:/, '');
            trMobileBreakupInv = (trMobileBreakupInv === invId) ? null : invId;
            trRenderPortfolio();
        });
    });
}


// ---- F&O phone list (moved from trading-fno.js) ----
// ============================================================================
// PHONE COMPACT LIST (≤480px) — grouped by symbol → contract rows → tap-to-expand
// Reuses the SAME positions objects the desktop table renders from. Symbol-level
// expand reuses trFnoExpandedSymbols (so Collapse/Expand-all drives it too);
// contract-detail expand uses trFnoMobileContractKey.
// ============================================================================
// Distinct investor + broker names for a contract group (resolved from the
// leg transactions via shared trInvName / trBrkCode).
function trFnoCgParties(cg) {
    var ids = {};
    (cg.rows || []).forEach(function(r) { if (r.buyTxnId) ids[r.buyTxnId] = 1; if (r.sellTxnId) ids[r.sellTxnId] = 1; });
    var invs = {}, brks = {};
    Object.keys(ids).forEach(function(id) {
        var t = (typeof trTransactions !== 'undefined') ? trTransactions.find(function(x) { return x.id === id; }) : null;
        if (t) { invs[trInvName(t.investor_id)] = 1; var bc = trBrkCode(t.broker_id); if (bc) brks[bc] = 1; }
    });
    return { inv: Object.keys(invs).join(', ') || '-', brk: Object.keys(brks).join(', ') || '-' };
}

// Signed qty display — short positions show as negative (in parentheses).
function trFnoQty(q) {
    return q < 0 ? '(' + formatQuantity(Math.abs(q)) + ')' : formatQuantity(q);
}

// CMP (₹) only for a contract group (from the open leg).
function trFnoCgCmp(cg) {
    var o = (cg.rows || []).filter(function(r) { return r.type === 'open' && r.cmp > 0; })[0];
    return o ? trFmtRupee(o.cmp) : '-';
}

// CMP (₹) + day% for a contract group (CMP from open leg, day% from live cache).
function trFnoCgCmpDay(cg) {
    var openRow = (cg.rows || []).filter(function(r) { return r.type === 'open' && r.cmp > 0; })[0];
    if (!openRow) return '-';
    var chp = null;
    if (cg.fullSymbol) { var fc = wmsLivePrices[cg.fullSymbol.replace(/^[A-Z]+:/, '')]; if (fc && fc.chp !== undefined && fc.chp !== null) chp = fc.chp; }
    return trFmtRupee(openRow.cmp) + (chp != null ? ' <span class="' + getAmountClass(chp) + '">' + formatPercent(chp) + '</span>' : '');
}


function trFnoRenderMobile(positions) {
    var box = document.getElementById('tr-fno-cards');
    if (!box) return;
    trFnoWireMore();
    if (!positions || positions.length === 0) {
        box.innerHTML = '<div class="trm-empty">No F&O positions found</div>';
        return;
    }

    // Same ordering as grouped table: symbols with any open position first, then alpha
    var ordered = positions.slice().sort(function(a, b) {
        var ao = (a.contractGroups || []).some(function(cg) { return cg.openQty > 0; }) ? 0 : 1;
        var bo = (b.contractGroups || []).some(function(cg) { return cg.openQty > 0; }) ? 0 : 1;
        if (ao !== bo) return ao - bo;
        return (a.underlying || '').localeCompare(b.underlying || '');
    });

    var totExp = 0, totDay = 0, totReal = 0, totUnreal = 0;
    ordered.forEach(function(p) { totExp += p.totalOpenCost; totDay += p.totalDayPnl || 0; totReal += p.totalRealisedPnl; totUnreal += p.totalUnrealisedPnl; });
    var totNet = totReal + totUnreal;

    // Single clean row that is BOTH the page totals AND the column headers
    var totRow =
        '<div class="trm-fno-tot fc3">' +
            '<div class="fc-a"><span class="trm-tot-k">Exposure</span> <span class="trm-tot-v">' + formatAmount(totExp) + '</span></div>' +
            '<div class="fc-b"><div class="trm-tot-k">Day\'s P&L</div><div class="trm-tot-v ' + getAmountClass(totDay) + '">' + formatAmount(totDay) + '</div></div>' +
            '<div class="fc-c"><div class="trm-tot-k">Total P&L</div><div class="trm-tot-v ' + getAmountClass(totNet) + '">' + formatAmount(totNet) + '</div></div>' +
        '</div>';

    var body = ordered.map(function(p) {
        var symOpen = !!trFnoExpandedSymbols[p.underlying];
        var net = p.totalRealisedPnl + p.totalUnrealisedPnl;

        // 3-zone line 2 (mirrors Portfolio): Qty@Avg (left) · CMP day% (middle) ·
        // net P&L% of exposure (right). Values from the representative open
        // contract (prefer the open futures leg). Ticker/expiry → expanded detail.
        var exposure = p.totalOpenCost;
        var repCg = (p.contractGroups || []).filter(function(cg) { return cg.isFuture && cg.openQty; })[0]
                 || (p.contractGroups || []).filter(function(cg) { return cg.openQty; })[0];
        // Symbol-level Qty/Avg = TOTAL across all open contracts (the per-contract
        // breakup is shown when expanded). CMP from the representative contract.
        // Symbol Qty/Avg = FUTURES ONLY (options do not change a future's qty or
        // avg — see trFnoCalcPositions "options distort qty"). Short = negative.
        // CMP from the representative (futures-preferred) contract. Options-only
        // symbols fall back to their representative option contract.
        var aL2;
        if (p.futOpenQty > 0) {
            var sQ = p.futIsShort ? -p.futOpenQty : p.futOpenQty;
            aL2 = trFnoQty(sQ) + ' <span class="trm-at">@</span> ' + trFmtRupee(p.futAvgCost) + ' &middot; ' + (repCg ? trFnoCgCmpDay(repCg) : '-');
        } else if (repCg) {
            var oQ = repCg.isShort ? -Math.abs(repCg.openQty) : Math.abs(repCg.openQty);
            var oAvg = (repCg.openQty && repCg.openCost) ? trFmtRupee(repCg.openCost / Math.abs(repCg.openQty)) : '-';
            aL2 = trFnoQty(oQ) + ' <span class="trm-at">@</span> ' + oAvg + ' &middot; ' + trFnoCgCmpDay(repCg);
        } else {
            aL2 = '<span style="color:#a0aec0;">Closed</span>';
        }
        var dPnl = p.totalDayPnl || 0;
        var dPctS = (exposure > 0 && dPnl !== 0) ? formatPercent((dPnl / exposure) * 100) : '';
        var nPctS = (exposure > 0 && net !== 0) ? formatPercent((net / exposure) * 100) : '';

        var grp =
            '<div class="trm-grp" data-fno-symbol="' + wmsEsc(p.underlying) + '">' +
                '<div class="fc3">' +
                    '<div class="fc-a">' +
                        '<div class="fc-a-l1"><span class="fc-a-txt">' + wmsEsc(p.companyName || p.underlying) + '</span></div>' +
                        '<div class="fc-a-l2">' + aL2 + '</div>' +
                    '</div>' +
                    '<div class="fc-b"><div class="fc-amt ' + getAmountClass(dPnl) + '">' + formatAmount(dPnl) + '</div><div class="fc-pct ' + getAmountClass(dPnl) + '">' + dPctS + '</div></div>' +
                    '<div class="fc-c"><div class="fc-amt ' + getAmountClass(net) + '">' + formatAmount(net) + '</div><div class="fc-pct ' + getAmountClass(net) + '">' + nPctS + '</div></div>' +
                '</div>' +
            '</div>';

        var contracts = '';
        if (symOpen) {
            contracts = p.contractGroups.map(function(cg, cgIdx) {
                var key = p.underlying + '|' + cgIdx;
                var cOpen = trFnoMobileContractKey === key;
                var cReal = cg.totalPnl || 0, cUnreal = cg.unrealisedPnl || 0, cNet = cReal + cUnreal, cDay = cg.dayPnl || 0, cExp = cg.openCost || 0;
                var shortTag = cg.isShort ? ' <span style="color:#dc2626;font-size:10px;">(S)</span>' : '';
                var avg = (cg.openQty && cExp) ? trFmtRupee(cExp / cg.openQty) : '-';
                var cSignedQty = cg.isShort ? -Math.abs(cg.openQty) : Math.abs(cg.openQty);
                var caL2 = trFnoQty(cSignedQty) + ' <span class="trm-at">@</span> ' + avg + ' &middot; ' + trFnoCgCmpDay(cg);
                var cDPctS = (cExp > 0 && cDay !== 0) ? formatPercent((cDay / cExp) * 100) : '';
                var cNPctS = (cExp > 0 && cNet !== 0) ? formatPercent((cNet / cExp) * 100) : '';

                var row =
                    '<div class="trm-row trm-sub' + (cOpen ? ' trm-open' : '') + '" data-fno-ckey="' + wmsEsc(key) + '">' +
                        '<div class="fc3">' +
                            '<div class="fc-a">' +
                                '<div class="fc-a-l1"><span class="fc-a-txt">' + wmsEsc(cg.contractLabel) + shortTag + '</span></div>' +
                                '<div class="fc-a-l2">' + caL2 + '</div>' +
                            '</div>' +
                            '<div class="fc-b"><div class="fc-amt ' + getAmountClass(cDay) + '">' + formatAmount(cDay) + '</div><div class="fc-pct ' + getAmountClass(cDay) + '">' + cDPctS + '</div></div>' +
                            '<div class="fc-c"><div class="fc-amt ' + getAmountClass(cNet) + '">' + formatAmount(cNet) + '</div><div class="fc-pct ' + getAmountClass(cNet) + '">' + cNPctS + '</div></div>' +
                        '</div>' +
                    '</div>';

                var detail = '';
                if (cOpen) {
                    var openRow = (cg.rows || []).filter(function(r) { return r.type === 'open' && r.cmp > 0; })[0];
                    var cmpStr = openRow ? trFmtRupee(openRow.cmp) : '-';
                    var parties = trFnoCgParties(cg);
                    detail =
                        '<div class="trm-detail"><div class="trm-detail-grid">' +
                            '<div class="trm-d-item"><span class="trm-d-k">Symbol</span><span class="trm-d-v">' + wmsEsc(p.underlying) + '</span></div>' +
                            '<div class="trm-d-item"><span class="trm-d-k">Expiry</span><span class="trm-d-v">' + wmsEsc(cg.groupLabel || '-') + '</span></div>' +
                            '<div class="trm-d-item"><span class="trm-d-k">Open qty</span><span class="trm-d-v">' + formatQuantity(cg.openQty) + '</span></div>' +
                            '<div class="trm-d-item"><span class="trm-d-k">Avg</span><span class="trm-d-v">' + avg + '</span></div>' +
                            '<div class="trm-d-item"><span class="trm-d-k">CMP</span><span class="trm-d-v">' + cmpStr + '</span></div>' +
                            '<div class="trm-d-item"><span class="trm-d-k">Day P&L</span><span class="trm-d-v ' + getAmountClass(cDay) + '">' + formatAmount(cDay) + '</span></div>' +
                            '<div class="trm-d-item"><span class="trm-d-k">Exposure</span><span class="trm-d-v">' + formatAmount(cExp) + '</span></div>' +
                            '<div class="trm-d-item"><span class="trm-d-k">Realised</span><span class="trm-d-v ' + getAmountClass(cReal) + '">' + formatAmount(cReal) + '</span></div>' +
                            '<div class="trm-d-item"><span class="trm-d-k">Unrealised</span><span class="trm-d-v ' + getAmountClass(cUnreal) + '">' + formatAmount(cUnreal) + '</span></div>' +
                            '<div class="trm-d-item"><span class="trm-d-k">Net</span><span class="trm-d-v ' + getAmountClass(cNet) + '">' + formatAmount(cNet) + '</span></div>' +
                            '<div class="trm-d-item trm-d-wide"><span class="trm-d-k">Investor</span><span class="trm-d-v">' + wmsEsc(parties.inv) + '</span></div>' +
                            '<div class="trm-d-item trm-d-wide"><span class="trm-d-k">Broker</span><span class="trm-d-v">' + wmsEsc(parties.brk) + '</span></div>' +
                        '</div></div>';
                }
                return row + detail;
            }).join('');
        }
        return grp + contracts;
    }).join('');

    box.innerHTML = totRow + body;

    box.querySelectorAll('.trm-grp[data-fno-symbol]').forEach(function(el) {
        el.addEventListener('click', function() {
            var sym = el.dataset.fnoSymbol;
            if (trFnoExpandedSymbols[sym]) delete trFnoExpandedSymbols[sym]; else trFnoExpandedSymbols[sym] = true;
            trFnoRender();
        });
    });
    box.querySelectorAll('.trm-row[data-fno-ckey]').forEach(function(el) {
        el.addEventListener('click', function(e) {
            e.stopPropagation();
            var key = el.dataset.fnoCkey;
            trFnoMobileContractKey = (trFnoMobileContractKey === key) ? null : key;
            trFnoRender();
        });
    });
}
